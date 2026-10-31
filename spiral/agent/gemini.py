"""Gemini reasoning layer: intake parsing, infeasible relaxation, and report writer (Owner: Harry).

Gemini reads and decides; Python computes. On intake Gemini only reports what the description
says (value + unit as written + the words it came from). Python converts units, checks ranges and
fills every unstated field with a cited default.

Falls back to deterministic behaviour when `GEMINI_API_KEY` is not set, when `SPIRAL_OFFLINE=1`,
or when a Gemini call fails, so the repo works offline and in CI.
"""

from __future__ import annotations

import json
import os
import re
from dataclasses import fields as dc_fields
from pathlib import Path
from typing import Any

from spiral.contract import (
    DesignState,
    MissionSpec,
    SpecRelaxationProposal,
    ToolError,
    ToolResult,
)
from spiral.tools.lookup import lookup

ROOT_DIR = Path(__file__).resolve().parents[2]
PROMPTS_DIR = Path(__file__).resolve().parent / "prompts"
DEFAULT_MODEL = "gemini-3.5-flash"
GEMINI_TIMEOUT_MS = 30_000

try:  # optional: the repo must import without the server dependencies
    from dotenv import load_dotenv

    load_dotenv(ROOT_DIR / ".env")  # never overrides variables already set
except ImportError:
    pass


# ---------------------------------------------------------------------------
# Gemini client
# ---------------------------------------------------------------------------


def gemini_model() -> str:
    return os.environ.get("GEMINI_MODEL", "").strip() or DEFAULT_MODEL


def gemini_unavailable_reason() -> str | None:
    """Why Gemini can't be used right now, or None if it can."""
    if os.environ.get("SPIRAL_OFFLINE", "").strip() not in ("", "0"):
        return "SPIRAL_OFFLINE is set"
    key = os.environ.get("GEMINI_API_KEY", "").strip()
    if not key or key.startswith("your_"):
        return "GEMINI_API_KEY is not set"
    try:
        import google.genai  # noqa: F401
    except ImportError:
        return "google-genai is not installed"
    return None


def _generate_json(system_prompt: str, user_text: str, schema: dict[str, Any]) -> dict[str, Any]:
    """One Gemini call with structured JSON output. Raises on any failure."""
    from google import genai
    from google.genai import types

    client = genai.Client(
        api_key=os.environ["GEMINI_API_KEY"].strip(),
        http_options=types.HttpOptions(timeout=GEMINI_TIMEOUT_MS),
    )
    response = client.models.generate_content(
        model=gemini_model(),
        contents=user_text,
        config=types.GenerateContentConfig(
            system_instruction=system_prompt,
            response_mime_type="application/json",
            response_json_schema=schema,
            thinking_config=types.ThinkingConfig(thinking_level="low"),
        ),
    )
    data = json.loads(response.text or "")
    if not isinstance(data, dict):
        raise ValueError("Gemini returned JSON that is not an object")
    return data


# ---------------------------------------------------------------------------
# Intake: what can be stated, in which units, within which sanity bounds
# ---------------------------------------------------------------------------

_MASS = {"kg": 1.0, "lb": 0.45359237}
_DISTANCE = {"km": 1000.0, "m": 1.0, "nmi": 1852.0, "mi": 1609.344}
_HEIGHT = {"m": 1.0, "ft": 0.3048}
_SPEED = {"m/s": 1.0, "kt": 0.514444, "km/h": 1.0 / 3.6, "mph": 0.44704}
_TIME = {"min": 60.0, "h": 3600.0, "s": 1.0}
_PLAIN = {"-": 1.0}
_FRACTION = {"-": 1.0, "%": 0.01}
_LOAD = {"g": 1.0}
_SFC = {"lb/hp/h": 0.45359237 / (745.699872 * 3600.0), "g/kWh": 1.0e-3 / 3.6e6, "kg/J": 1.0}

# schema key -> (MissionSpec field, units -> SI factor, (min, max) in SI, hint for Gemini)
INTAKE_QUANTITIES: dict[str, tuple[str, dict[str, float], tuple[float, float], str]] = {
    "crew_count": ("crew_count", _PLAIN, (1, 2), "Flight crew (pilots)."),
    "passenger_count": (
        "passenger_count",
        _PLAIN,
        (0, 9),
        "Passengers excluding crew. 'N-seat' or 'N-place' means N seats in total including the pilot.",
    ),
    "person_mass": ("person_mass_kg", _MASS, (50.0, 130.0), "Mass per occupant."),
    "baggage_mass": ("baggage_mass_kg", _MASS, (0.0, 500.0), "Total baggage mass."),
    "range": ("range_m", _DISTANCE, (50_000.0, 10_000_000.0), "Design cruise range. 'nm' means nautical miles (nmi)."),
    "cruise_speed": ("cruise_speed_ms", _SPEED, (25.0, 200.0), "Cruise true airspeed."),
    "cruise_altitude": ("cruise_altitude_m", _HEIGHT, (0.0, 9_000.0), "Cruise altitude. FL80 means 8000 ft."),
    "stall_speed": ("stall_speed_ms", _SPEED, (15.0, 50.0), "Maximum allowed stall speed."),
    "reserve": ("reserve_s", _TIME, (0.0, 3 * 3600.0), "Fuel reserve expressed as loiter time."),
    "aspect_ratio": ("aspect_ratio", _PLAIN, (4.0, 14.0), "Wing aspect ratio b^2/S."),
    "taper_ratio": ("taper_ratio", _FRACTION, (0.2, 1.0), "Wing taper ratio c_tip/c_root."),
    "thickness_to_chord": ("thickness_to_chord", _FRACTION, (0.06, 0.25), "Aerofoil max thickness-to-chord."),
    "cl_max": ("cl_max", _PLAIN, (1.0, 3.0), "Maximum lift coefficient."),
    "ld_max": ("ld_max", _PLAIN, (5.0, 20.0), "Maximum lift-to-drag ratio."),
    "prop_efficiency": ("prop_efficiency", _FRACTION, (0.5, 0.92), "Cruise propeller efficiency."),
    "bsfc": ("bsfc_kg_per_j", _SFC, (3.0e-8, 1.5e-7), "Engine brake specific fuel consumption."),
    "limit_load_factor": ("limit_load_factor", _LOAD, (2.0, 9.0), "Positive limit manoeuvre load factor."),
    "ultimate_factor": ("ultimate_factor", _PLAIN, (1.0, 2.0), "Ultimate factor of safety."),
}

# schema key -> (MissionSpec field, allowed values, hint for Gemini)
INTAKE_CHOICES: dict[str, tuple[str, list[str], str]] = {
    "wing_position": ("wing_position", ["high", "mid", "low"], "Wing position on the fuselage."),
    "spar_material": (
        "spar_material",
        ["al_2024_t3", "al_7075_t6"],
        "Main spar alloy: al_2024_t3 (aluminium 2024-T3) or al_7075_t6 (aluminium 7075-T6).",
    ),
}

_INT_FIELDS = {"crew_count", "passenger_count"}

# Reason shown in the UI for every field the description didn't state. Fields with a row in
# knowledge/tables/aircraft_typical.yaml get that row's citation appended, so the citation lives
# in one place.
DEFAULT_REASONS: dict[str, str] = {
    "crew_count": "Assumed 1 pilot (single-pilot GA)",
    "passenger_count": "Assumed 3 passengers (four-seat GA baseline)",
    "person_mass_kg": "Assumed 86 kg per occupant",
    "baggage_mass_kg": "Assumed 50 kg total baggage",
    "range_m": "Assumed 1,000 km (typical GA touring range)",
    "cruise_speed_ms": "Assumed 60 m/s (~117 kt) touring cruise",
    "cruise_altitude_m": "Assumed 2,500 m (~8,200 ft) cruise altitude",
    "stall_speed_ms": "Assumed 28 m/s (~54 kt), inside the 61 kt CS-23 single-engine stall limit",
    "reserve_s": "Assumed 45 min loiter reserve",
    "aspect_ratio": "Assumed 7.6, typical GA single-engine",
    "taper_ratio": "Assumed 0.45, near-elliptical lift for an unswept wing",
    "thickness_to_chord": "Assumed 0.15 root aerofoil thickness",
    "cl_max": "Assumed 1.6 with simple flaps deployed",
    "ld_max": "Assumed 11, typical fixed-gear GA",
    "prop_efficiency": "Assumed 0.80 cruise propeller efficiency",
    "bsfc_kg_per_j": "Assumed 6.8e-8 kg/J (0.40 lb/hp/h) piston cruise SFC",
    "limit_load_factor": "Assumed +3.8 g limit, CS-23 normal category",
    "ultimate_factor": "Assumed 1.5 ultimate factor of safety (CS 23.303)",
    "spar_material": "Assumed aluminium 2024-T3, standard spar alloy",
    "wing_position": "Assumed high wing (Cessna 172-style touring baseline)",
}
_TYPICAL_TABLE_FIELDS = ("aspect_ratio", "taper_ratio", "thickness_to_chord", "ld_max")


def _sig(x: float, digits: int = 6) -> float:
    return float(f"{x:.{digits}g}")


def _default_reasons() -> dict[str, str]:
    reasons = dict(DEFAULT_REASONS)
    try:
        typical = lookup("aircraft_typical", "ga_single_engine").value
    except ToolError:
        return reasons
    for name in _TYPICAL_TABLE_FIELDS:
        row = typical.get(name) or {}
        if row.get("source"):
            reasons[name] = f"{reasons[name]} ({row['source']})"
    return reasons


# Gemini may only *infer* these (e.g. "two-seat" -> 1 crew + 1 passenger, "aerobatic" -> +6 g).
# Any other inferred value is dropped so the cited Python default applies instead.
INFERABLE_FIELDS = {"crew_count", "passenger_count", "limit_load_factor"}


def intake_schema() -> dict[str, Any]:
    """JSON schema Gemini fills: one item per thing the description says, quote first."""
    field_hints = {key: hint for key, (_, _, _, hint) in INTAKE_QUANTITIES.items()}
    field_hints.update({key: hint for key, (_, _, hint) in INTAKE_CHOICES.items()})
    units = sorted({u for (_, table, _, _) in INTAKE_QUANTITIES.values() for u in table})
    choices = sorted({c for (_, options, _) in INTAKE_CHOICES.values() for c in options})
    fields_doc = "; ".join(f"{k}: {h}" for k, h in field_hints.items())

    return {
        "type": "object",
        "properties": {
            "name": {"type": "string", "description": "Short project title, 2-4 words."},
            "items": {
                "type": "array",
                "description": "One item per requirement the description states, in the order they appear.",
                "items": {
                    "type": "object",
                    "properties": {
                        "evidence": {
                            "type": "string",
                            "description": "stated: the user's exact words, copied character for character. "
                            "inferred: a one-sentence engineering reason naming its basis.",
                        },
                        "field": {"type": "string", "enum": list(field_hints), "description": fields_doc},
                        "basis": {"type": "string", "enum": ["stated", "inferred"]},
                        "value": {"type": "number", "description": "The number exactly as written, in `unit`."},
                        "unit": {"type": "string", "enum": units, "description": "Unit as written; '-' if none."},
                        "choice": {"type": "string", "enum": choices, "description": "Only for wing_position and spar_material."},
                    },
                    "required": ["evidence", "field", "basis"],
                },
            },
            "warnings": {
                "type": "array",
                "items": {"type": "string"},
                "description": "Anything outside a single-engine piston GA aircraft, contradictions, or ambiguity.",
            },
        },
        "required": ["name", "items", "warnings"],
    }


def _normalise(text: str) -> str:
    return re.sub(r"[^a-z0-9.]+", " ", text.lower()).strip()


def spec_from_extraction(extraction: dict[str, Any], description: str, source: str) -> ToolResult[MissionSpec]:
    """Turn Gemini's (or the offline parser's) extraction into a `MissionSpec`.

    Python owns every conversion and check. Unstated fields keep the `MissionSpec` default and get
    a reason in `defaulted_fields`; Gemini-inferred values also go in `defaulted_fields`, so the UI
    highlights them for the user to confirm.
    """
    spec = MissionSpec(raw_description=description)
    warnings = [str(w) for w in extraction.get("warnings") or [] if str(w).strip()]
    reasons = _default_reasons()
    defaulted: dict[str, str] = {}
    set_fields: set[str] = set()
    norm_description = _normalise(description)

    for entry in extraction.get("items") or []:
        if not isinstance(entry, dict):
            continue
        key = entry.get("field")
        basis = entry.get("basis", "stated")
        evidence = str(entry.get("evidence", "")).strip()
        if basis == "stated" and _normalise(evidence) not in norm_description:
            basis = "inferred"
            warnings.append(f"{key}: the quoted words '{evidence}' aren't in the description; treated as inferred.")
        if basis != "stated" and key not in INFERABLE_FIELDS:
            continue  # only stated values may override a cited default

        if key in INTAKE_QUANTITIES:
            field_name, units, (lo, hi), _ = INTAKE_QUANTITIES[key]
            unit = entry.get("unit")
            try:
                raw_value = float(entry.get("value"))
            except (TypeError, ValueError):
                warnings.append(f"Ignored {key}: no usable number.")
                continue
            if unit not in units:
                warnings.append(f"Ignored {key} = {raw_value:g}: unit '{unit}' not valid for this field.")
                continue
            value = raw_value * units[unit]
            if not lo <= value <= hi:
                warnings.append(
                    f"Ignored {key} = {raw_value:g} {unit}: outside the plausible range for this aircraft class; using the default."
                )
                continue
            final: Any = int(round(value)) if field_name in _INT_FIELDS else _sig(value)
        elif key in INTAKE_CHOICES:
            field_name, choices, _ = INTAKE_CHOICES[key]
            final = entry.get("choice")
            if final not in choices:
                warnings.append(f"Ignored {key} = '{final}': not one of {choices}.")
                continue
        else:
            continue

        setattr(spec, field_name, final)
        set_fields.add(field_name)
        defaulted.pop(field_name, None)
        if basis != "stated":
            defaulted[field_name] = f"Inferred by {source}: {evidence}" if evidence else f"Inferred by {source}"

    for f in dc_fields(MissionSpec):
        if f.name in reasons and f.name not in set_fields:
            defaulted[f.name] = reasons[f.name]

    name = str(extraction.get("name") or "").strip()
    if name:
        spec.name = name[:60]
    spec.defaulted_fields = defaulted

    return ToolResult(
        value=spec,
        sources=[f"Project description, parsed by {source}"],
        assumptions=[f"{k}: {v}" for k, v in defaulted.items()],
        warnings=warnings,
    )


# ---------------------------------------------------------------------------
# Intake: offline fallback parser (same output shape as Gemini)
# ---------------------------------------------------------------------------

_NUM = r"(\d[\d,]*(?:\.\d+)?)"


def _heuristic_extraction(description: str) -> dict[str, Any]:
    text = description.lower()
    items: list[dict[str, Any]] = []

    def stated(key: str, match: re.Match[str], unit: str | None = None, value: float | None = None) -> None:
        entry: dict[str, Any] = {"field": key, "basis": "stated", "evidence": match.group(0)}
        if unit is None:
            entry["choice"] = value
        else:
            entry["value"] = float(match.group(1).replace(",", "")) if value is None else value
            entry["unit"] = unit
        items.append(entry)

    if m := re.search(_NUM + r"\s*(km|nm|nmi|nautical miles?|mi|miles?)\b(?!\s*/)", text):
        unit = {"km": "km", "mi": "mi", "mile": "mi", "miles": "mi"}.get(m.group(2), "nmi")
        stated("range", m, unit)
    if m := re.search(r"cruis\w*\s*(?:at\s*|speed\s*(?:of\s*)?)?" + _NUM + r"\s*(kts?|knots?|km/h|kph|mph|m/s)", text):
        unit = {"km/h": "km/h", "kph": "km/h", "mph": "mph", "m/s": "m/s"}.get(m.group(2), "kt")
        stated("cruise_speed", m, unit)
    if m := re.search(r"stall\w*\s*(?:speed\s*)?(?:under\s*|below\s*|of\s*|at\s*)?" + _NUM + r"\s*(kts?|knots?|km/h|mph|m/s)", text):
        unit = {"km/h": "km/h", "mph": "mph", "m/s": "m/s"}.get(m.group(2), "kt")
        stated("stall_speed", m, unit)
    if m := re.search(_NUM + r"\s*min(?:ute)?s?\s*(?:of\s*)?reserve", text):
        stated("reserve", m, "min")
    words = {"two": 2, "three": 3, "four": 4, "five": 5, "six": 6, "seven": 7, "eight": 8, "nine": 9}
    if m := re.search(r"\b(\d+|" + "|".join(words) + r")[- ](?:seat|place)", text):
        seats = int(m.group(1)) if m.group(1).isdigit() else words[m.group(1)]
        stated("passenger_count", m, "-", max(seats - 1, 0))
    if m := re.search(r"\b(high|mid|low)[- ]wing", text):
        stated("wing_position", m, None, m.group(1))

    return {"name": "", "items": items, "warnings": []}


def parse_intake_description(description: str) -> ToolResult[MissionSpec]:
    """Parse a plain-English aircraft description into a structured `MissionSpec`.

    Uses Gemini structured output when available, else the offline pattern parser. Either way the
    result goes through `spec_from_extraction`, so defaults and checks are identical.
    """
    description = description.strip()
    reason = gemini_unavailable_reason()
    if reason is None:
        try:
            system_prompt = (PROMPTS_DIR / "intake.md").read_text(encoding="utf-8")
            extraction = _generate_json(system_prompt, description, intake_schema())
            return spec_from_extraction(extraction, description, source=f"Gemini ({gemini_model()})")
        except Exception as exc:  # noqa: BLE001 - any failure falls back to the offline parser
            reason = f"Gemini call failed ({type(exc).__name__}: {str(exc)[:120]})"

    result = spec_from_extraction(_heuristic_extraction(description), description, source="offline parser")
    result.warnings.insert(0, f"{reason}; used the offline parser. Check every field before confirming.")
    return result


def propose_infeasible_relaxation(
    state: DesignState, candidate: SpecRelaxationProposal | None
) -> SpecRelaxationProposal | None:
    """Explain the one relaxation that makes the spiral close.

    The numbers (new value, MTOW at that value) come from `candidate`, which the orchestrator
    computed by re-running the spiral; this only writes the reasoning around them.

    TODO (Harry): have Gemini write `reasoning` (prompts/infeasible.md) from `state.infeasible_reason`,
    `state.history` and the candidate, with the numbers passed in rather than generated.
    """
    if candidate is None:
        return None
    old_km, new_km = candidate.old_value / 1000.0, candidate.new_value / 1000.0
    mtow = f"{candidate.estimated_mtow_kg:,.0f} kg" if candidate.estimated_mtow_kg else "an MTOW inside the limit"
    candidate.reasoning = (
        f"{state.infeasible_reason} Keeping everything else in the spec, the longest range that closes is "
        f"{new_km:,.0f} km (down from {old_km:,.0f} km), where the spiral converges at {mtow}. "
        "Both numbers come from re-running the full spiral at the new range."
    )
    return candidate


def generate_report_markdown(state: DesignState) -> str:
    """Generate a traceable engineering report strictly from numbers in `DesignState`.

    TODO (Harry): Connect to Gemini with `prompts/report.md` while enforcing no hallucinated numbers.
    """
    sizing = state.latest_sizing
    spar = state.latest_spar
    comp = state.components.get("main_wing_spar")
    fea = comp.fea if comp else None

    lines = [
        f"# Spiral Engineering Design Report: {state.spec.name}",
        "",
        f"**Status:** {'Converged' if state.converged else 'Infeasible / In-Progress'} "
        f"after **{len(state.history)}** spiral laps.",
        "",
        "## 1. Mission & Configuration Summary",
        f"- **Range:** {state.spec.range_m / 1000.0:.1f} km",
        f"- **Cruise Speed:** {state.spec.cruise_speed_ms:.1f} m/s",
        f"- **Stall Speed:** {state.spec.stall_speed_ms:.1f} m/s",
        f"- **Wing Position:** {state.spec.wing_position.title()}",
        "",
    ]

    if sizing:
        lines.extend(
            [
                "## 2. Converged Conceptual Sizing",
                f"- **Maximum Take-Off Mass (MTOW):** {sizing.mtow_kg:.2f} kg",
                f"- **Empty Mass:** {sizing.empty_mass_kg:.2f} kg (fraction: {sizing.empty_fraction:.3f})",
                f"- **Fuel Mass:** {sizing.fuel_mass_kg:.2f} kg (fraction: {sizing.fuel_fraction:.3f})",
                f"- **Payload Mass:** {sizing.payload_mass_kg:.2f} kg",
                f"- **Wing Area / Span:** {sizing.wing_area_m2:.2f} m² / {sizing.span_m:.2f} m",
                f"- **Installed Power:** {sizing.installed_power_w / 1000.0:.1f} kW",
                "",
            ]
        )

    if spar:
        lines.extend(
            [
                "## 3. Preliminary Main Wing Spar (Beam Theory)",
                f"- **Material:** `{spar.material_key}`",
                f"- **Total Spar Mass (both wings):** {spar.mass_both_wings_kg:.2f} kg",
                f"- **Peak Bending Stress:** {spar.max_bending_stress_pa / 1e6:.2f} MPa "
                f"(Allowable: {spar.allowable_yield_stress_pa / 1e6:.1f} MPa, Margin: {spar.safety_margin:+.2f})",
                f"- **Tip Deflection at Ultimate Load ({state.spec.n_ult:.2f}g):** {spar.tip_deflection_m * 1000.0:.1f} mm",
                "",
            ]
        )

    if fea:
        lines.extend(
            [
                "## 4. Detailed Design & FEA Verification",
                f"- **Solver:** {fea.solver_name}",
                f"- **FEA Peak von Mises Stress:** {fea.fea_max_von_mises_pa / 1e6:.2f} MPa "
                f"({fea.stress_agreement_pct:.1f}% agreement with beam theory)",
                f"- **FEA Tip Deflection:** {fea.fea_tip_deflection_m * 1000.0:.1f} mm "
                f"({fea.deflection_agreement_pct:.1f}% agreement with beam theory)",
                "",
            ]
        )

    lines.extend(
        [
            "## 5. Sources & Citations",
            *[f"- {src}" for src in state.sources],
            "",
            "## 6. Assumptions & Warnings",
            *[f"- **Assumption:** {a}" for a in state.assumptions],
            *[f"- **Warning:** {w}" for w in state.warnings],
        ]
    )
    report = "\n".join(lines)
    state.report_markdown = report
    return report
