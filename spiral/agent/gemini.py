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


def _describe_option(c: SpecRelaxationProposal) -> str:
    """One clause describing a computed option, e.g. 'range 5,570 -> 4,670 km (2,719 kg)'."""
    mtow = f"{c.estimated_mtow_kg:,.0f} kg" if c.estimated_mtow_kg else "inside the limit"
    if c.field_name == "range_m":
        return f"cut the range from {c.old_value / 1000:,.0f} km to {c.new_value / 1000:,.0f} km (closes at {mtow})"
    if c.field_name == "passenger_count":
        n = int(c.new_value)
        return f"carry {n} passenger{'s' if n != 1 else ''} instead of {int(c.old_value)} (closes at {mtow})"
    return f"change {c.field_name} from {c.old_value:g} to {c.new_value:g} {c.unit} (closes at {mtow})"


def _option_cost(state: DesignState, c: SpecRelaxationProposal) -> float:
    """How much of the mission an option gives up, as a fraction (used when Gemini can't choose)."""
    if c.field_name == "range_m":
        return 1.0 - c.new_value / c.old_value
    if c.field_name == "passenger_count":
        spec = state.spec
        return (c.old_value - c.new_value) * spec.person_mass_kg / max(spec.payload_mass_kg, 1.0)
    return 1.0


def propose_infeasible_relaxation(
    state: DesignState, candidates: list[SpecRelaxationProposal] | SpecRelaxationProposal | None
) -> SpecRelaxationProposal | None:
    """Choose and explain one of the relaxations Python has verified to close the spiral.

    `candidates` were computed by the orchestrator by re-running the spiral (e.g. the longest range
    that closes, and the most passengers that close). Gemini (prompts/infeasible.md) reads the
    user's description and picks the option that best keeps what they asked for, then explains it;
    its text is used only if every number in it passes the number check. Offline, or if Gemini
    fails, the option that gives up the smallest share of the mission is chosen.
    """
    if isinstance(candidates, SpecRelaxationProposal):
        candidates = [candidates]
    options = [c for c in (candidates or []) if c is not None]
    if not options:
        return None

    chosen = min(options, key=lambda c: _option_cost(state, c))
    others = [c for c in options if c is not chosen]
    chosen.reasoning = (
        f"{state.infeasible_reason} Keeping everything else in the spec, the smallest change that closes is to "
        f"{_describe_option(chosen)}."
        + (f" Alternative: {'; or '.join(_describe_option(o) for o in others)}." if others else "")
        + " Every number comes from re-running the full spiral."
    )
    if gemini_unavailable_reason() is None:
        try:
            pick = _gemini_choose_relaxation(state, options)
            if pick is not None:
                index, text = pick
                options[index].reasoning = text
                chosen = options[index]
        except Exception:  # noqa: BLE001 - keep the deterministic choice and explanation
            pass
    return chosen


def _relaxation_digest(state: DesignState, options: list[SpecRelaxationProposal]) -> dict[str, Any]:
    limit = _class_limit()
    digest: dict[str, Any] = {
        "users_description": state.spec.raw_description or "",
        "why_it_failed": state.infeasible_reason or "",
        "mtow_per_lap_kg": [round(h.mtow_kg) for h in state.history],
        "spar_mass_per_lap_kg": [round(h.spar_mass_kg, 1) for h in state.history],
    }
    if limit:
        digest["class_limit_kg"] = round(float(limit.get("max_kg", 0.0)))
    if state.latest_sizing is not None:
        digest["fuel_fraction_pct"] = round(100.0 * state.latest_sizing.fuel_fraction, 1)
    verified = []
    for i, c in enumerate(options):
        item: dict[str, Any] = {"option": i, "field": c.field_name, "mtow_after_change_kg": round(c.estimated_mtow_kg or 0.0)}
        if c.field_name == "range_m":
            item.update(from_km=round(c.old_value / 1000.0), to_km=round(c.new_value / 1000.0),
                        reduction_pct=round(100.0 * (1.0 - c.new_value / c.old_value), 1))
        else:
            item.update(passengers_before=int(c.old_value), passengers_after=int(c.new_value))
        verified.append(item)
    digest["verified_options"] = verified
    return digest


def _gemini_choose_relaxation(state: DesignState, options: list[SpecRelaxationProposal]) -> tuple[int, str] | None:
    digest = _relaxation_digest(state, options)
    allowed = _allowed_numbers(digest)
    system_prompt = (PROMPTS_DIR / "infeasible.md").read_text(encoding="utf-8")
    schema = {
        "type": "object",
        "properties": {
            "choice": {"type": "integer", "description": "The `option` number you recommend."},
            "reasoning": {"type": "string"},
        },
        "required": ["choice", "reasoning"],
    }
    base = "Digest (JSON):\n" + json.dumps(digest, indent=1)
    user_text = base
    for _attempt in range(2):
        data = _generate_json(system_prompt, user_text, schema)
        choice = data.get("choice")
        text = str(data.get("reasoning") or "").strip()[:1100]
        problems = _number_problems(text, allowed) if text else ["empty answer"]
        if not isinstance(choice, int) or not 0 <= choice < len(options):
            problems.append(f"choice {choice!r} is not one of the option numbers")
        if not problems:
            return choice, text
        user_text = (base + "\n\nYour previous answer was rejected: " + "; ".join(problems)
                     + ". Choose a valid option and use only numbers from the digest.")
    return None


# ---------------------------------------------------------------------------
# Report: Python writes every factual section; Gemini writes only the narrative
# ---------------------------------------------------------------------------
#
# The digest below is all Gemini sees, and `report_number_problems` checks that every number in
# its paragraphs can be traced to the digest. The digest holds each number rounded exactly the way
# the report prints it, so "1,247.6 kg" in a table and in a paragraph are the same value.

REPORT_FIELDS: dict[str, str] = {
    "executive_summary": "2-4 sentences: what was designed, whether the spiral closed, and the headline results.",
    "design_drivers": "2-4 sentences: which requirements and assumptions drove the mass, wing and spar results.",
    "trade_offs": "2-4 sentences: the main trade-offs and margins visible in the results (spar margin, "
    "beam theory vs FEA if present, fuel vs payload).",
    "infeasibility": "Only if status is 'infeasible': 2-4 sentences on why the spiral failed to close and what "
    "the proposed relaxation changes. Empty string otherwise.",
}
REPORT_WARNING_PREFIX = "Report narrative not used: "
_MAX_PARAGRAPH_CHARS = 1500

_MASS_LABELS = {
    "wing_spar": "Wing spar (both wings)",
    "remaining_empty": "Rest of empty mass",
    "fuel": "Fuel",
    "crew": "Crew",
    "passengers": "Passengers",
    "baggage": "Baggage",
}


def _num(x: float, decimals: int) -> str:
    return f"{x:,.{decimals}f}"


def _rnd(x: float, decimals: int) -> float:
    """The value exactly as `_num` prints it, so digest and report agree digit for digit."""
    return float(f"{x:.{decimals}f}")


def _status_line(state: DesignState) -> str:
    laps = len(state.history)
    if state.converged:
        return f"**Status:** Converged after **{laps}** spiral laps."
    if state.infeasible_reason:
        return f"**Status:** Infeasible: the spiral did not produce a valid design after **{laps}** laps."
    return f"**Status:** Not converged after **{laps}** spiral laps."


def _class_limit() -> dict[str, Any] | None:
    try:
        row = lookup("aircraft_typical", "ga_single_engine").value["mtow_class_limit"]
        return {"mtow_limit_kg": _rnd(float(row["max_kg"]), 0), "source": str(row["source"])}
    except (ToolError, KeyError, TypeError, ValueError):
        return None


def _proposal_values(p: SpecRelaxationProposal) -> tuple[str, float, float, int]:
    """(display unit, old, new, decimals) for a relaxation; ranges are shown in km."""
    if p.unit == "m" and max(abs(p.old_value), abs(p.new_value)) >= 10_000.0:
        return "km", p.old_value / 1000.0, p.new_value / 1000.0, 0
    return ("" if p.unit == "-" else p.unit), p.old_value, p.new_value, 3


def _report_digest(state: DesignState) -> dict[str, Any]:
    """Compact JSON digest of the state for Gemini: the key numbers, rounded as the report shows them.

    Key suffixes carry the unit (`_kg`, `_km`, `_mm`, `_mpa`, `_kw`, `_pct`, `_frac`); the number
    check uses them to allow the matching unit conversions.
    """
    spec = state.spec
    digest: dict[str, Any] = {
        "aircraft_name": spec.name,
        "status": "converged" if state.converged else ("infeasible" if state.infeasible_reason else "not_converged"),
        "laps_run": len(state.history),
        "description": spec.raw_description[:600],
        "mission": {
            "range_km": _rnd(spec.range_m / 1000.0, 0),
            "cruise_speed_ms": _rnd(spec.cruise_speed_ms, 1),
            "cruise_altitude_m": _rnd(spec.cruise_altitude_m, 0),
            "stall_speed_ms": _rnd(spec.stall_speed_ms, 1),
            "reserve_min": _rnd(spec.reserve_s / 60.0, 0),
            "crew": spec.crew_count,
            "passengers": spec.passenger_count,
            "seats": spec.crew_count + spec.passenger_count,
            "person_mass_kg": _rnd(spec.person_mass_kg, 1),
            "baggage_mass_kg": _rnd(spec.baggage_mass_kg, 1),
            "payload_kg": _rnd(spec.payload_mass_kg, 1),
            "aspect_ratio": spec.aspect_ratio,
            "taper_ratio": spec.taper_ratio,
            "thickness_to_chord": spec.thickness_to_chord,
            "cl_max": spec.cl_max,
            "ld_max": spec.ld_max,
            "prop_efficiency": spec.prop_efficiency,
            "bsfc_kg_per_j": float(f"{spec.bsfc_kg_per_j:.2e}"),
            "limit_load_factor_g": spec.limit_load_factor,
            "ultimate_factor": spec.ultimate_factor,
            "ultimate_load_factor_g": _rnd(spec.n_ult, 2),
            "spar_material": spec.spar_material,
            "wing_position": spec.wing_position,
        },
        "defaulted_fields": dict(spec.defaulted_fields),
    }

    if state.history:
        first, last = state.history[0], state.history[-1]
        digest["convergence"] = [
            {
                "lap": h.lap,
                "mtow_kg": _rnd(h.mtow_kg, 1),
                "mtow_change_pct": _rnd(h.mtow_change_pct, 2),
                "empty_mass_kg": _rnd(h.empty_mass_kg, 1),
                "fuel_mass_kg": _rnd(h.fuel_mass_kg, 1),
                "spar_mass_kg": _rnd(h.spar_mass_kg, 1),
                "wing_area_m2": _rnd(h.wing_area_m2, 2),
                "span_m": _rnd(h.span_m, 2),
                "peak_bending_stress_mpa": _rnd(h.max_bending_stress_pa / 1e6, 1),
                "tip_deflection_mm": _rnd(h.tip_deflection_m * 1000.0, 1),
            }
            for h in state.history
        ]
        if first.mtow_kg:
            digest["mtow_change_first_to_last_lap_pct"] = _rnd((last.mtow_kg - first.mtow_kg) / first.mtow_kg * 100.0, 2)

    s = state.latest_sizing
    if s:
        digest["sizing"] = {
            "mtow_kg": _rnd(s.mtow_kg, 1),
            "empty_mass_kg": _rnd(s.empty_mass_kg, 1),
            "empty_frac": _rnd(s.empty_fraction, 3),
            "fuel_mass_kg": _rnd(s.fuel_mass_kg, 1),
            "fuel_frac": _rnd(s.fuel_fraction, 3),
            "payload_mass_kg": _rnd(s.payload_mass_kg, 1),
            "spar_mass_used_in_sizing_kg": _rnd(s.spar_mass_used_kg, 1),
            "statistical_spar_mass_kg": _rnd(s.statistical_spar_mass_kg, 1),
            "wing_loading_pa": _rnd(s.wing_loading_pa, 0),
            "wing_area_m2": _rnd(s.wing_area_m2, 2),
            "span_m": _rnd(s.span_m, 2),
            "root_chord_m": _rnd(s.root_chord_m, 2),
            "tip_chord_m": _rnd(s.tip_chord_m, 2),
            "mac_m": _rnd(s.mac_m, 2),
            "cruise_power_kw": _rnd(s.cruise_power_w / 1000.0, 1),
            "installed_power_kw": _rnd(s.installed_power_w / 1000.0, 1),
            "mission_segment_mass_frac": {k: _rnd(v, 4) for k, v in s.segment_fractions.items()},
        }
        if s.mtow_kg:
            digest["mass_breakdown"] = [
                {"item": k, "mass_kg": _rnd(v, 1), "share_of_mtow_pct": _rnd(v / s.mtow_kg * 100.0, 1)}
                for k, v in s.mass_breakdown_kg.items()
            ]

    p = state.latest_spar
    if p:
        digest["spar_beam_theory"] = {
            "material": p.material_key,
            "mass_both_wings_kg": _rnd(p.mass_both_wings_kg, 1),
            "mass_one_wing_kg": _rnd(p.semi_span_mass_kg, 1),
            "root_depth_mm": _rnd(p.root_depth_m * 1000.0, 1),
            "tip_depth_mm": _rnd(p.tip_depth_m * 1000.0, 1),
            "root_cap_width_mm": _rnd(p.root_cap_width_m * 1000.0, 1),
            "root_cap_thickness_mm": _rnd(p.root_cap_thickness_m * 1000.0, 2),
            "root_web_thickness_mm": _rnd(p.root_web_thickness_m * 1000.0, 2),
            "peak_bending_stress_mpa": _rnd(p.max_bending_stress_pa / 1e6, 1),
            "peak_shear_stress_mpa": _rnd(p.max_shear_stress_pa / 1e6, 1),
            "allowable_stress_mpa": _rnd(p.allowable_yield_stress_pa / 1e6, 1),
            "safety_margin": _rnd(p.safety_margin, 2),
            "tip_deflection_mm": _rnd(p.tip_deflection_m * 1000.0, 1),
        }
        if s and s.mtow_kg:
            digest["spar_beam_theory"]["share_of_mtow_pct"] = _rnd(p.mass_both_wings_kg / s.mtow_kg * 100.0, 1)

    comp = state.components.get("main_wing_spar")
    fea = comp.fea if comp else None
    if fea:
        digest["fea"] = {
            "solver": fea.solver_name,
            "fea_peak_von_mises_mpa": _rnd(fea.fea_max_von_mises_pa / 1e6, 1),
            "beam_peak_stress_mpa": _rnd(fea.beam_max_stress_pa / 1e6, 1),
            "stress_agreement_pct": _rnd(fea.stress_agreement_pct, 1),
            "fea_tip_deflection_mm": _rnd(fea.fea_tip_deflection_m * 1000.0, 1),
            "beam_tip_deflection_mm": _rnd(fea.beam_tip_deflection_m * 1000.0, 1),
            "deflection_agreement_pct": _rnd(fea.deflection_agreement_pct, 1),
            "fea_safety_margin": _rnd(fea.safety_margin_fea, 2),
        }

    if state.infeasible_reason:
        infeasible: dict[str, Any] = {"reason": state.infeasible_reason}
        limit = _class_limit()
        if limit and s:
            infeasible["class_limit"] = limit
            infeasible["mtow_above_limit_kg"] = _rnd(s.mtow_kg - limit["mtow_limit_kg"], 0)
            infeasible["mtow_above_limit_pct"] = _rnd((s.mtow_kg / limit["mtow_limit_kg"] - 1.0) * 100.0, 1)
        rel = state.proposed_relaxation
        if rel:
            unit, old, new, dec = _proposal_values(rel)
            suffix = f"_{unit}" if unit else ""
            proposal: dict[str, Any] = {
                "field": rel.field_name,
                f"old_value{suffix}": _rnd(old, dec),
                f"new_value{suffix}": _rnd(new, dec),
                "reasoning": rel.reasoning,
            }
            if old:
                proposal["change_pct"] = _rnd((new - old) / old * 100.0, 1)
            if rel.estimated_mtow_kg is not None:
                proposal["mtow_at_new_value_kg"] = _rnd(rel.estimated_mtow_kg, 1)
            infeasible["proposed_relaxation"] = proposal
        digest["infeasible"] = infeasible

    digest["sources"] = list(state.sources)
    digest["assumptions"] = list(state.assumptions)
    digest["warnings"] = [w for w in state.warnings if not w.startswith(REPORT_WARNING_PREFIX)]
    return digest


def _report_sections(state: DesignState) -> tuple[list[str], list[str]]:
    """(factual body, trailing sources/assumptions/warnings), every number formatted from the state."""
    spec = state.spec
    body: list[str] = []

    payload = (
        f"{spec.crew_count} crew + {spec.passenger_count} passengers at {_num(spec.person_mass_kg, 1)} kg, "
        f"{_num(spec.baggage_mass_kg, 1)} kg baggage ({_num(spec.payload_mass_kg, 1)} kg payload)"
    )
    body += [
        "## Mission & configuration",
        f"- **Range:** {_num(spec.range_m / 1000.0, 0)} km with {_num(spec.reserve_s / 60.0, 0)} min reserve",
        f"- **Cruise:** {_num(spec.cruise_speed_ms, 1)} m/s at {_num(spec.cruise_altitude_m, 0)} m",
        f"- **Stall speed:** {_num(spec.stall_speed_ms, 1)} m/s",
        f"- **Payload:** {payload}",
        f"- **Wing:** {spec.wing_position} wing, aspect ratio {spec.aspect_ratio:g}, taper ratio {spec.taper_ratio:g}, "
        f"t/c {spec.thickness_to_chord:g}, CL_max {spec.cl_max:g}, L/D_max {spec.ld_max:g}",
        f"- **Propulsion:** propeller efficiency {spec.prop_efficiency:g}, BSFC {spec.bsfc_kg_per_j:.2e} kg/J",
        f"- **Structure:** +{spec.limit_load_factor:g} g limit x {spec.ultimate_factor:g} = "
        f"{_num(spec.n_ult, 2)} g ultimate, spar material `{spec.spar_material}`",
        "",
    ]

    if state.history:
        body += [
            "## Convergence history",
            "| Lap | MTOW (kg) | ΔMTOW (%) | Empty (kg) | Fuel (kg) | Spar (kg) | Wing area (m²) | Span (m) "
            "| Peak bending stress (MPa) | Tip deflection (mm) |",
            "|---|---|---|---|---|---|---|---|---|---|",
        ]
        for i, h in enumerate(state.history):
            change = "n/a" if i == 0 else f"{h.mtow_change_pct:+.2f}"
            body.append(
                f"| {h.lap} | {_num(h.mtow_kg, 1)} | {change} | {_num(h.empty_mass_kg, 1)} | {_num(h.fuel_mass_kg, 1)} "
                f"| {_num(h.spar_mass_kg, 1)} | {_num(h.wing_area_m2, 2)} | {_num(h.span_m, 2)} "
                f"| {_num(h.max_bending_stress_pa / 1e6, 1)} | {_num(h.tip_deflection_m * 1000.0, 1)} |"
            )
        body.append("")

    s = state.latest_sizing
    if s:
        title = "## Mass breakdown" if state.converged else "## Mass breakdown (last lap, not a valid design)"
        body += [
            title,
            f"- **MTOW:** {_num(s.mtow_kg, 1)} kg",
            f"- **Empty mass:** {_num(s.empty_mass_kg, 1)} kg (empty fraction {s.empty_fraction:.3f})",
            f"- **Fuel mass:** {_num(s.fuel_mass_kg, 1)} kg (fuel fraction {s.fuel_fraction:.3f})",
            f"- **Payload:** {_num(s.payload_mass_kg, 1)} kg",
            f"- **Spar mass used in sizing:** {_num(s.spar_mass_used_kg, 1)} kg "
            f"(statistical estimate {_num(s.statistical_spar_mass_kg, 1)} kg)",
            "",
        ]
        if s.mass_breakdown_kg and s.mtow_kg:
            body += ["| Item | Mass (kg) | Share of MTOW (%) |", "|---|---|---|"]
            for k, v in s.mass_breakdown_kg.items():
                body.append(f"| {_MASS_LABELS.get(k, k)} | {_num(v, 1)} | {_num(v / s.mtow_kg * 100.0, 1)} |")
            body.append("")
        body += [
            "## Wing & power",
            f"- **Wing area / span:** {_num(s.wing_area_m2, 2)} m² / {_num(s.span_m, 2)} m "
            f"(wing loading {_num(s.wing_loading_pa, 0)} Pa)",
            f"- **Root / tip chord / MAC:** {_num(s.root_chord_m, 2)} m / {_num(s.tip_chord_m, 2)} m / {_num(s.mac_m, 2)} m",
            f"- **Cruise / installed power:** {_num(s.cruise_power_w / 1000.0, 1)} kW / "
            f"{_num(s.installed_power_w / 1000.0, 1)} kW",
            "",
        ]

    p = state.latest_spar
    if p:
        body += [
            "## Main wing spar (beam theory)",
            f"- **Material:** `{p.material_key}`",
            f"- **Spar mass:** {_num(p.mass_both_wings_kg, 1)} kg both wings ({_num(p.semi_span_mass_kg, 1)} kg per wing)",
            f"- **Root / tip depth:** {_num(p.root_depth_m * 1000.0, 1)} mm / {_num(p.tip_depth_m * 1000.0, 1)} mm",
            f"- **Root cap:** {_num(p.root_cap_width_m * 1000.0, 1)} mm wide x {_num(p.root_cap_thickness_m * 1000.0, 2)} mm "
            f"thick; web {_num(p.root_web_thickness_m * 1000.0, 2)} mm",
            f"- **Peak bending stress:** {_num(p.max_bending_stress_pa / 1e6, 1)} MPa against "
            f"{_num(p.allowable_yield_stress_pa / 1e6, 1)} MPa allowable (margin {p.safety_margin:+.2f})",
            f"- **Peak shear stress:** {_num(p.max_shear_stress_pa / 1e6, 1)} MPa",
            f"- **Tip deflection at {_num(spec.n_ult, 2)} g ultimate:** {_num(p.tip_deflection_m * 1000.0, 1)} mm",
            "",
        ]

    comp = state.components.get("main_wing_spar")
    fea = comp.fea if comp else None
    if fea:
        body += [
            "## FEA vs beam theory",
            f"Solver: {fea.solver_name}",
            "",
            "| Quantity | FEA | Beam theory | Agreement (%) |",
            "|---|---|---|---|",
            f"| Peak stress (MPa) | {_num(fea.fea_max_von_mises_pa / 1e6, 1)} | {_num(fea.beam_max_stress_pa / 1e6, 1)} "
            f"| {_num(fea.stress_agreement_pct, 1)} |",
            f"| Tip deflection (mm) | {_num(fea.fea_tip_deflection_m * 1000.0, 1)} "
            f"| {_num(fea.beam_tip_deflection_m * 1000.0, 1)} | {_num(fea.deflection_agreement_pct, 1)} |",
            "",
            f"FEA safety margin: {fea.safety_margin_fea:+.2f}",
            "",
        ]

    if state.infeasible_reason:
        body += ["## Why the design does not close", state.infeasible_reason, ""]
        rel = state.proposed_relaxation
        if rel:
            unit, old, new, dec = _proposal_values(rel)
            u = f" {unit}" if unit else ""
            line = f"- **Change `{rel.field_name}`:** {_num(old, dec)}{u} -> {_num(new, dec)}{u}"
            if rel.estimated_mtow_kg is not None:
                line += f", where the spiral converges at MTOW {_num(rel.estimated_mtow_kg, 1)} kg"
            body += ["## Proposed relaxation", line]
            if rel.reasoning:
                body.append(f"- **Reasoning:** {rel.reasoning}")
            body.append("")

    tail = [
        "## Sources",
        *([f"- {src}" for src in state.sources] or ["- None recorded"]),
        "",
        "## Assumptions",
        *([f"- {a}" for a in state.assumptions] or ["- None recorded"]),
        "",
        "## Warnings",
        *([f"- {w}" for w in state.warnings] or ["- None"]),
    ]
    return body, tail


def _deterministic_report(state: DesignState, note: str | None = None) -> str:
    """The report with no Gemini text: every section computed from the state."""
    body, tail = _report_sections(state)
    head = [f"# Spiral Design Report: {state.spec.name}", "", _status_line(state), ""]
    if note:
        head += [f"_{note}_", ""]
    return "\n".join(head + body + tail)


def _narrative_report(state: DesignState, narrative: dict[str, str], source: str) -> str:
    body, tail = _report_sections(state)
    lines = [
        f"# Spiral Design Report: {state.spec.name}",
        "",
        _status_line(state),
        "",
        "## Summary",
        narrative["executive_summary"],
        "",
        f"_Narrative paragraphs written by {source} from the computed results below; every number in them "
        "was checked against the design state._",
        "",
        *body,
    ]
    discussion = [
        ("What drove the design", narrative.get("design_drivers", "")),
        ("Trade-offs", narrative.get("trade_offs", "")),
        ("Why it does not close, and what the proposal changes", narrative.get("infeasibility", "")),
    ]
    if any(text for _, text in discussion):
        lines.append("## Discussion")
        for heading, text in discussion:
            if text:
                lines += [f"### {heading}", text, ""]
    return "\n".join(lines + tail)


# --- "No new numbers" check -------------------------------------------------

# Units as written in text -> (dimension, scale to the dimension's base unit). Metric prefixes
# convert within a dimension (kg <-> t, m <-> km/mm, Pa <-> MPa, W <-> kW, fraction <-> %).
# Imperial units are their own dimension, so they only match numbers quoted in that unit
# (e.g. the user's "115 kt"); Gemini converting m/s to kt would be a new number.
_UNIT_DIMS: dict[str, tuple[str, float]] = {
    "%": ("fraction", 0.01), "percent": ("fraction", 0.01), "per cent": ("fraction", 0.01),
    "kg": ("mass", 1.0), "t": ("mass", 1e3), "tonne": ("mass", 1e3), "tonnes": ("mass", 1e3),
    "mm": ("length", 1e-3), "cm": ("length", 1e-2), "m": ("length", 1.0), "km": ("length", 1e3),
    "m/s": ("speed", 1.0), "m²": ("area", 1.0), "m^2": ("area", 1.0), "m2": ("area", 1.0),
    "pa": ("stress", 1.0), "kpa": ("stress", 1e3), "mpa": ("stress", 1e6), "gpa": ("stress", 1e9),
    "w": ("power", 1.0), "kw": ("power", 1e3),
    "g": ("load", 1.0),
    "s": ("time", 1.0), "min": ("time", 60.0), "minute": ("time", 60.0), "minutes": ("time", 60.0),
    "h": ("time", 3600.0), "hour": ("time", 3600.0), "hours": ("time", 3600.0),
    "lb": ("lb", 1.0), "lbs": ("lb", 1.0), "kt": ("kt", 1.0), "kts": ("kt", 1.0), "knot": ("kt", 1.0),
    "knots": ("kt", 1.0), "nm": ("nmi", 1.0), "nmi": ("nmi", 1.0), "mi": ("mi", 1.0), "mile": ("mi", 1.0),
    "miles": ("mi", 1.0), "hp": ("hp", 1.0),
}
_UNIT_AFTER = re.compile(
    r"\s?(%|percent\b|per\s?cent\b|m/s\b|m²|m\^2|m2\b|mm\b|minutes?\b|min\b|miles?\b|mi\b|kg(?![/\w])|km(?![/\w])"
    r"|kts?\b|knots?\b|kpa\b|kw\b|mpa\b|gpa\b|pa\b|tonnes?\b|t(?![/\w])|lbs?\b|cm\b|nmi\b|nm\b|hp\b|hours?\b|h\b"
    r"|w\b|g(?![/\w])|s\b|m(?![/\w²^]))",
    re.IGNORECASE,
)
# Digest key suffix -> (dimension, scale): "mtow_kg" is a mass in kg, "tip_deflection_mm" a length in mm.
_KEY_DIMS: dict[str, tuple[str, float]] = {
    "kg": ("mass", 1.0), "km": ("length", 1e3), "m": ("length", 1.0), "mm": ("length", 1e-3),
    "m2": ("area", 1.0), "ms": ("speed", 1.0), "mpa": ("stress", 1e6), "pa": ("stress", 1.0),
    "kw": ("power", 1e3), "pct": ("fraction", 0.01), "frac": ("fraction", 1.0), "min": ("time", 60.0),
    "g": ("load", 1.0),
}

_NUMBER = re.compile(r"(?<![A-Za-z0-9_.^])(\d{1,3}(?:,\d{3})+|\d+)(\.\d+)?(?:[eE]([-+]?\d+))?")
_REF = r"\d+(?:[.\-–]\w+)*(?:\([a-z]\))?"
_CITATION = re.compile(
    r"(?:\b(?:tables?|tab\.|eqs?\.?|equations?|ch\.|chap\.|chapters?|figs?\.?|figures?|sec\.|sections?|pp?\."
    r"|pages?|part|appendix|vol\.|volume|tm|tr|ac|cs|far|naca|mmpds|mil-hdbk-?|ref\.)|§)"
    rf"\s*[-–]?\s*{_REF}(?:\s*(?:&|and|,|to|–|-)\s*{_REF})*",
    re.IGNORECASE,
)
_EDITION = re.compile(r"\b\d+(?:st|nd|rd|th)?\s*(?:ed\b\.?|edn\b\.?|edition)", re.IGNORECASE)
_SCALE_WORD = re.compile(r"\b(?:hundred|thousand|million|billion|dozen)s?\b", re.IGNORECASE)
_SMALL_INT_MAX = 10  # bare integers up to this, with no unit, are counts ("3 laps", "lap 2", "2 wings")

# One allowed number: (value as written, dimension or None if unknown, scale to the dimension's base).
_Allowed = tuple[float, "str | None", float]


def _strip_citations(text: str) -> str:
    return _EDITION.sub(" ", _CITATION.sub(" ", text))


def _numbers_with_units(text: str) -> list[tuple[re.Match[str], float, tuple[str, float] | None]]:
    """(match, value, (dimension, scale) of the unit written after it, if any) for each number."""
    out = []
    for m in _NUMBER.finditer(text):
        int_part, frac_part, exp_part = m.group(1), m.group(2) or "", m.group(3)
        value = float(int_part.replace(",", "") + frac_part + (f"e{exp_part}" if exp_part else ""))
        u = _UNIT_AFTER.match(text, m.end())
        unit = _UNIT_DIMS.get(re.sub(r"\s+", " ", u.group(1).lower())) if u else None
        out.append((m, value, unit))
    return out


def _allowed_numbers(digest: Any, key: str = "") -> list[_Allowed]:
    """Every number in the digest with its dimension: numeric values typed by their key's unit
    suffix, plus numbers quoted inside its strings (typed by the unit written after them)."""
    out: list[_Allowed] = []
    if isinstance(digest, dict):
        for k, value in digest.items():
            out += _allowed_numbers(value, str(k).rsplit("_", 1)[-1].lower())
    elif isinstance(digest, list):
        for item in digest:
            out += _allowed_numbers(item, key)
    elif isinstance(digest, bool):
        pass
    elif isinstance(digest, (int, float)):
        value = abs(float(digest))
        dim, scale = _KEY_DIMS.get(key, ("fraction", 1.0) if value <= 1.0 else (None, 1.0))
        out.append((value, dim, scale))
    elif isinstance(digest, str):
        for _, value, unit in _numbers_with_units(_strip_citations(digest)):
            out.append((value, *unit) if unit else (value, None, 1.0))
    return out


def _number_problems(text: str, allowed: list[_Allowed]) -> list[str]:
    stripped = _strip_citations(text)
    problems: list[str] = []
    for m in _SCALE_WORD.finditer(stripped):
        problems.append(f"spelled-out number '{m.group(0)}' (write numbers as digits from the digest)")
    for m, value, unit in _numbers_with_units(stripped):
        int_part, frac_part, exp_part = m.group(1), m.group(2) or "", m.group(3)
        digits = int_part.replace(",", "")
        if not frac_part and not exp_part and "," not in int_part and value <= _SMALL_INT_MAX and unit is None:
            continue
        decimals = len(frac_part) - 1 if frac_part else 0
        step = 10.0 ** ((int(exp_part) if exp_part else 0) - decimals)
        if not frac_part and not exp_part:
            # "1,250" may be 1,247.6 rounded to tens, but keep at least two significant figures.
            trailing = len(digits) - len(digits.rstrip("0"))
            step = max(1.0, min(10.0**trailing, 10.0 ** max(len(digits) - 2, 0)))
        tol = 0.5 * step * (1 + 1e-9) + 1e-12 * value

        def close(candidate: float) -> bool:
            return abs(candidate - value) <= tol

        if unit is not None:  # "1,500 kg": compare only with masses, converted to the unit written
            dim, scale = unit
            ok = any(d == dim and close(a * s / scale) for a, d, s in allowed)
        else:  # no unit: compare with the value as the digest writes it (fractions also as %)
            ok = any(close(a) or (d == "fraction" and close(a * s * 100.0)) for a, d, s in allowed)
        if ok:
            continue
        start, end = max(0, m.start() - 30), min(len(stripped), m.end() + 30)
        context = " ".join(stripped[start:end].split())
        problems.append(f"{m.group(0)} (in '...{context}...')")
    return list(dict.fromkeys(problems))


def report_number_problems(text: str, state: DesignState) -> list[str]:
    """Numbers in `text` that can't be traced to the report digest of `state`.

    A number passes if it equals a digest value (or a number quoted in a digest string) rounded to
    the precision written. A number written with a unit is only compared with values of the same
    dimension, converted by metric prefix (kg->t, m->km/mm, Pa->MPa, W->kW, fraction->%), so
    "1,500 kg" can't pass because some length happens to be 1,500 mm. Numbers inside citations
    ("Table 3.1", "Eq. 3.4", "p. 13", "2nd ed.") and bare integers up to 10 with no unit
    ("3 laps") are skipped; spelled-out scale words ("thousand") are flagged. Returns one entry
    per offending number, with context; empty means the text is clean.
    """
    return _number_problems(text, _allowed_numbers(_report_digest(state)))


# --- Gemini narrative ---------------------------------------------------------


def report_schema() -> dict[str, Any]:
    return {
        "type": "object",
        "properties": {key: {"type": "string", "description": desc} for key, desc in REPORT_FIELDS.items()},
        "required": list(REPORT_FIELDS),
    }


def _clean_narrative(data: dict[str, Any], state: DesignState) -> dict[str, str]:
    narrative: dict[str, str] = {}
    for key in REPORT_FIELDS:
        text = str(data.get(key) or "").strip()
        text = re.sub(r"(?m)^\s*#+\s*", "", text)  # no headings inside paragraphs
        narrative[key] = text[:_MAX_PARAGRAPH_CHARS]
    if not state.infeasible_reason:
        narrative["infeasibility"] = ""
    return narrative


def _gemini_narrative(state: DesignState) -> tuple[dict[str, str] | None, str]:
    """(narrative, "") if Gemini wrote clean paragraphs within two tries, else (None, why not)."""
    digest = _report_digest(state)
    allowed = _allowed_numbers(digest)
    system_prompt = (PROMPTS_DIR / "report.md").read_text(encoding="utf-8")
    base_text = "Design digest (JSON):\n" + json.dumps(digest, ensure_ascii=False, indent=1)

    user_text = base_text
    problems: list[str] = []
    for _attempt in range(2):
        narrative = _clean_narrative(_generate_json(system_prompt, user_text, report_schema()), state)
        if not narrative["executive_summary"]:
            problems = ["empty executive_summary"]
        else:
            problems = _number_problems("\n\n".join(narrative.values()), allowed)
        if not problems:
            return narrative, ""
        user_text = (
            base_text
            + "\n\nYour previous answer was rejected because these numbers are not in the digest: "
            + "; ".join(problems)
            + ". Rewrite all fields. Use only numbers that appear in the digest, copied as written there "
            "(rounding to fewer decimals is fine). Do no arithmetic; leave a number out rather than estimate it."
        )
    shown = ", ".join(p.split(" (in ")[0] for p in problems[:5])
    return None, f"Gemini's text twice contained numbers not in the design state ({shown})"


def generate_report_markdown(state: DesignState) -> str:
    """Build the report: computed sections from the state plus, when available, Gemini's narrative.

    Python writes every table and figure. Gemini (prompts/report.md) only writes the summary and
    discussion paragraphs from a compact digest, and they are used only if every number in them
    passes `report_number_problems` (one retry naming the rejected numbers). Otherwise, or on any
    Gemini error, the computed report is returned alone with a warning in `state.warnings`.
    Never raises because of Gemini. Sets `state.report_markdown`.
    """
    state.warnings = [w for w in state.warnings if not w.startswith(REPORT_WARNING_PREFIX)]
    reason = gemini_unavailable_reason()
    if reason is not None:
        report = _deterministic_report(state, note=f"No narrative ({reason}): every section is computed from the design state.")
    else:
        try:
            narrative, why_not = _gemini_narrative(state)
        except Exception as exc:  # noqa: BLE001 - the report must never fail because of Gemini
            narrative, why_not = None, f"Gemini call failed ({type(exc).__name__}: {str(exc)[:120]})"
        if narrative is not None:
            report = _narrative_report(state, narrative, source=f"Gemini ({gemini_model()})")
        else:
            state.warnings.append(f"{REPORT_WARNING_PREFIX}{why_not}; showing the computed sections only.")
            report = _deterministic_report(state, note="No narrative: see Warnings. Every section is computed from the design state.")
    state.report_markdown = report
    return report
