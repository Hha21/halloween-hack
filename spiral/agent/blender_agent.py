"""Airframe CAD agent: Gemini 4 Argon writes a Blender (bpy) script, Blender runs it headless, Python verifies.

Loop (up to MAX_ATTEMPTS): Argon -> script -> `blender -b --factory-startup --python` -> check exit code,
GLB + PNG on disk, and the measured bounding box against the design (span within 3%, length within 10%).
Any failure goes back to Argon as "fix the script". The final good files are copied to
artifacts/airframe.{png,glb,py}.
"""

from __future__ import annotations

import json
import re
import shutil
import subprocess
import time
from pathlib import Path
from typing import Any

from spiral.agent import gemini
from spiral.contract import DesignState

BLENDER = shutil.which("blender") or "/usr/bin/blender"
PROMPT_PATH = Path(__file__).resolve().parent / "prompts" / "blender.md"
MAX_ATTEMPTS = 3
BLENDER_TIMEOUT_S = 90
GEMINI_SCRIPT_TIMEOUT_MS = 180_000  # a full bpy script takes Argon longer than the default 30 s
SPAN_TOL = 0.03
LENGTH_TOL = 0.10

SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {"script": {"type": "string"}, "notes": {"type": "string"}},
    "required": ["script", "notes"],
}

_DIMS_RE = re.compile(r"^SPIRAL_DIMS\s+(\{.*\})\s*$", re.MULTILINE)
_VERIFY_RE = re.compile(r"^SPIRAL_VERIFY\s+(\{.*\})\s*$", re.MULTILINE)

# Appended to every script: Spiral's own measurement, independent of what the model chose to print.
_VERIFY_SNIPPET = '''

# --- appended by Spiral: independent bounding-box measurement -------------------------------------
import bpy as _sp_bpy, json as _sp_json
from mathutils import Vector as _SpV
_sp_bpy.context.view_layer.update()
_sp_pts = [o.matrix_world @ _SpV(c) for o in _sp_bpy.context.scene.objects if o.type == "MESH" for c in o.bound_box]
if _sp_pts:
    _sp_ext = [max(p[i] for p in _sp_pts) - min(p[i] for p in _sp_pts) for i in range(3)]
    print("SPIRAL_VERIFY " + _sp_json.dumps({"length_m": _sp_ext[0], "span_m": _sp_ext[1], "height_m": _sp_ext[2],
                                            "mesh_objects": sum(1 for o in _sp_bpy.context.scene.objects if o.type == "MESH")}))
'''


def _as_dict(obj: Any) -> dict[str, Any]:
    if obj is None:
        return {}
    if isinstance(obj, dict):
        return obj
    if hasattr(obj, "to_dict"):
        return obj.to_dict()
    return dict(vars(obj))


def design_digest(state: DesignState) -> dict[str, Any]:
    """The compact dimensions Argon builds from."""
    geometry = _as_dict(state.latest_geometry)
    sizing = _as_dict(state.latest_sizing)
    return {
        "units": "metres, degrees",
        "axes": "X aft from the nose (nose at x=0), Y spanwise, Z up",
        "sizing": {k: sizing.get(k) for k in ("span_m", "root_chord_m", "tip_chord_m", "wing_area_m2", "mtow_kg")},
        **{k: geometry.get(k) for k in ("fuselage", "wing", "horizontal_tail", "vertical_tail", "propeller")},
    }


def _design_targets(digest: dict[str, Any]) -> tuple[float, float]:
    span = float((digest.get("wing") or {}).get("span_m") or digest["sizing"]["span_m"])
    length = float((digest.get("fuselage") or {}).get("length_m") or 0.0)
    return span, length


def _ask_argon(system_prompt: str, user_text: str) -> dict[str, Any]:
    saved = gemini.GEMINI_TIMEOUT_MS
    gemini.GEMINI_TIMEOUT_MS = max(saved, GEMINI_SCRIPT_TIMEOUT_MS)
    try:
        return gemini._generate_json(system_prompt, user_text, SCHEMA, model=gemini.gemini_lead_model())
    finally:
        gemini.GEMINI_TIMEOUT_MS = saved


def _strip_fences(script: str) -> str:
    text = script.strip()
    if text.startswith("```"):
        text = re.sub(r"^```[a-zA-Z]*\n?", "", text)
        text = re.sub(r"\n?```\s*$", "", text)
    return text


def _tail(text: str, n: int = 2500) -> str:
    return text[-n:] if len(text) > n else text


def _check(design: float, measured: float | None, tol: float) -> dict[str, Any]:
    ok = measured is not None and design > 0 and abs(measured - design) <= tol * design
    return {"design": round(design, 3), "model": None if measured is None else round(measured, 3), "ok": bool(ok)}


def build_airframe(state: DesignState, out_dir: str = "artifacts") -> dict[str, Any]:
    out = Path(out_dir).resolve()
    out.mkdir(parents=True, exist_ok=True)
    for stale in out.glob("airframe_attempt_*"):  # attempts from an earlier build would be misleading
        stale.unlink(missing_ok=True)
    digest = design_digest(state)
    span_design, length_design = _design_targets(digest)
    system_prompt = PROMPT_PATH.read_text(encoding="utf-8")
    first_request = (
        "Design dimensions (JSON):\n"
        + json.dumps(digest, indent=1)
        + "\n\nWrite the complete Blender script for this aircraft. Required: wing tip-to-tip span "
        f"{span_design:.3f} m along Y, overall length about {length_design:.3f} m along X."
    )

    attempts: list[dict[str, Any]] = []
    checks = {"span_m": _check(span_design, None, SPAN_TOL), "length_m": _check(length_design, None, LENGTH_TOL)}
    result: dict[str, Any] = {
        "status": "failed",
        "model": gemini.LAST_MODEL,
        "attempts": attempts,
        "checks": checks,
        "render_url": None,
        "glb_url": None,
        "script_url": None,
    }

    unavailable = gemini.gemini_unavailable_reason()
    if unavailable:
        attempts.append({"n": 1, "ok": False, "issues": [f"Gemini unavailable: {unavailable}"], "seconds": 0.0})
        return result

    user_text = first_request
    for n in range(1, MAX_ATTEMPTS + 1):
        t0 = time.time()
        issues: list[str] = []
        script_path = out / f"airframe_attempt_{n}.py"
        glb = out / f"airframe_attempt_{n}.glb"
        png = out / f"airframe_attempt_{n}.png"
        for p in (glb, png):
            p.unlink(missing_ok=True)

        try:
            reply = _ask_argon(system_prompt, user_text)
            result["model"] = gemini.LAST_MODEL
            script = _strip_fences(str(reply.get("script", "")))
        except Exception as exc:  # noqa: BLE001 - a failed call is one failed attempt
            issues.append(f"Gemini call failed: {type(exc).__name__}: {str(exc)[:300]}")
            attempts.append({"n": n, "ok": False, "issues": issues, "seconds": round(time.time() - t0, 1)})
            continue
        if "import bpy" not in script:
            issues.append("Reply did not contain a bpy script")
            attempts.append({"n": n, "ok": False, "issues": issues, "seconds": round(time.time() - t0, 1)})
            user_text = first_request + "\n\nYour previous reply had no usable script. Return the full script."
            continue

        header = f"OUT_GLB = {str(glb)!r}\nOUT_PNG = {str(png)!r}\n"
        script_path.write_text(header + script + "\n" + _VERIFY_SNIPPET, encoding="utf-8")

        stdout = stderr = ""
        code: int | None = None
        try:
            proc = subprocess.run(
                [BLENDER, "-b", "--factory-startup", "--python-exit-code", "1", "--python", str(script_path)],
                capture_output=True,
                text=True,
                timeout=BLENDER_TIMEOUT_S,
            )
            code, stdout, stderr = proc.returncode, proc.stdout, proc.stderr
        except subprocess.TimeoutExpired as exc:
            issues.append(f"Blender timed out after {BLENDER_TIMEOUT_S} s")
            stdout = exc.stdout.decode() if isinstance(exc.stdout, bytes) else (exc.stdout or "")

        if code not in (0, None):
            issues.append(f"Blender exited with code {code}")
        combined = stdout + "\n" + stderr
        tb = ""
        if "Traceback" in combined:
            tb = combined[combined.rfind("Traceback") :]
        elif code not in (0, None):  # e.g. a SyntaxError prints no "Traceback" line
            m = re.search(r'File ".*?", line \d+|\b\w*Error\b', combined)
            tb = combined[m.start() :] if m else _tail(combined, 800)
        if tb:
            issues.append("Python error: " + _tail(tb, 1500))
        if not glb.exists() or glb.stat().st_size == 0:
            issues.append("GLB was not written to OUT_GLB")
        if not png.exists() or png.stat().st_size == 0:
            issues.append("PNG was not rendered to OUT_PNG")

        dims: dict[str, Any] = {}
        claimed = _DIMS_RE.findall(stdout)
        measured = _VERIFY_RE.findall(stdout)
        try:
            if measured:
                dims = json.loads(measured[-1])  # Spiral's own measurement wins
            elif claimed:
                dims = json.loads(claimed[-1])
        except json.JSONDecodeError:
            dims = {}
        if not claimed:
            issues.append("No SPIRAL_DIMS line printed")
        span_m = dims.get("span_m")
        length_m = dims.get("length_m")
        checks = {
            "span_m": _check(span_design, float(span_m) if span_m is not None else None, SPAN_TOL),
            "length_m": _check(length_design, float(length_m) if length_m is not None else None, LENGTH_TOL),
        }
        result["checks"] = checks
        if dims:
            for key, tol in (("span_m", SPAN_TOL), ("length_m", LENGTH_TOL)):
                c = checks[key]
                if not c["ok"]:
                    issues.append(
                        f"{key}: measured {c['model']} m vs design {c['design']} m (tolerance {tol:.0%})"
                    )
        elif code == 0:
            issues.append("Could not measure the bounding box (no mesh objects?)")

        ok = not issues
        attempts.append({"n": n, "ok": ok, "issues": issues, "seconds": round(time.time() - t0, 1)})
        if ok:
            shutil.copyfile(png, out / "airframe.png")
            shutil.copyfile(glb, out / "airframe.glb")
            shutil.copyfile(script_path, out / "airframe.py")
            result.update(
                status="ok",
                render_url="/artifacts/airframe.png",
                glb_url="/artifacts/airframe.glb",
                script_url="/artifacts/airframe.py",
            )
            return result

        user_text = (
            first_request
            + "\n\nYour previous script (below) FAILED verification. Fix the script and return the full "
            "corrected script.\n\nIssues:\n- "
            + "\n- ".join(issues)
            + f"\n\nMeasured vs design: span {checks['span_m']['model']} vs {span_design:.3f} m; "
            f"length {checks['length_m']['model']} vs {length_design:.3f} m"
            + (f"\n\nBlender output (tail):\n{_tail(stdout + chr(10) + stderr, 2000)}" if code != 0 else "")
            + "\n\nPrevious script:\n"
            + script
        )

    return result
