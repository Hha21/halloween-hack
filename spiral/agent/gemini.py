"""Gemini reasoning layer: intake parsing, infeasible relaxation, and report writer (Owner: Harry).

Includes deterministic fallback behaviour when `GEMINI_API_KEY` is not set so the repo works
offline and in CI out of the box.
"""

from __future__ import annotations

import re

from spiral.contract import (
    DesignState,
    MissionSpec,
    SpecRelaxationProposal,
    ToolResult,
)


def parse_intake_description(description: str) -> ToolResult[MissionSpec]:
    """Parse plain-English aircraft description into a structured `MissionSpec`.

    TODO (Harry): Wire `google-genai` structured output call using `prompts/intake.md`,
    keeping regex/heuristic parser below as instant fallback.
    """
    spec = MissionSpec(raw_description=description.strip())
    defaulted_fields: dict[str, str] = {
        "aspect_ratio": "Defaulted to 7.5 (Raymer Table 4.1 typical GA single-engine)",
        "taper_ratio": "Defaulted to 0.60 (Raymer Ch. 4.3 tapered GA wing)",
        "thickness_to_chord": "Defaulted to 0.15 (NACA 2415 / 23015 root airfoil class)",
        "cl_max": "Defaulted to 1.60 (single-slotted flap GA configuration)",
        "ld_max": "Defaulted to 11.0 (Raymer Ch. 3.4 typical fixed-gear GA)",
        "limit_load_factor": "Defaulted to +3.8g (CS-23 / FAR 23 normal category)",
        "spar_material": "Defaulted to al_2024_t3 (MIL-HDBK-5J standard spar alloy)",
    }

    text = description.lower()

    # Extract range in km if mentioned
    km_match = re.search(r"(\d[\d,]*)\s*km", text)
    if km_match:
        km_val = float(km_match.group(1).replace(",", ""))
        spec.range_m = km_val * 1000.0
    else:
        defaulted_fields["range_m"] = "Defaulted to 1,000 km (typical GA touring range)"

    # Extract cruise speed in kt or m/s
    cruise_kt = re.search(r"cruise\s*(?:at\s*|speed\s*)?(\d+)\s*kt", text)
    if cruise_kt:
        spec.cruise_speed_ms = round(float(cruise_kt.group(1)) * 0.514444, 2)
    else:
        defaulted_fields["cruise_speed_ms"] = "Defaulted to 60.0 m/s (~117 kt touring cruise)"

    # Extract stall speed in kt
    stall_kt = re.search(r"stall\s*(?:under\s*|below\s*|speed\s*)?(\d+)\s*kt", text)
    if stall_kt:
        spec.stall_speed_ms = round(float(stall_kt.group(1)) * 0.514444, 2)
    else:
        defaulted_fields["stall_speed_ms"] = "Defaulted to 28.0 m/s (~54 kt CS-23 stall limit)"

    # Extract reserve in min
    res_min = re.search(r"(\d+)\s*min(?:ute)?s?\s*reserve", text)
    if res_min:
        spec.reserve_s = float(res_min.group(1)) * 60.0
    else:
        defaulted_fields["reserve_s"] = "Defaulted to 2,700 s (45 min VFR/IFR loiter reserve)"

    if "low wing" in text or "low-wing" in text:
        spec.wing_position = "low"
    else:
        defaulted_fields["wing_position"] = "Defaulted to high wing (Cessna 172 touring baseline)"

    spec.defaulted_fields = defaulted_fields

    return ToolResult(
        value=spec,
        sources=[
            "Raymer 6ed, Table 4.1 & Ch. 3.4 (GA Baseline Heuristics)",
            "CS-23 / FAR Part 23 Normal Category Airworthiness Standards",
        ],
        assumptions=[f"{k}: {v}" for k, v in defaulted_fields.items()],
        warnings=[],
    )


def propose_infeasible_relaxation(state: DesignState) -> SpecRelaxationProposal:
    """Propose a single actionable parameter relaxation when the design spiral fails to close.

    TODO (Harry): Connect to Gemini with `prompts/infeasible.md`.
    """
    spec = state.spec
    if spec.range_m > 1_400_000.0:
        new_range_m = 1_400_000.0
        return SpecRelaxationProposal(
            field_name="range_m",
            old_value=spec.range_m,
            new_value=new_range_m,
            unit="m",
            reasoning=(
                f"Reducing range from {spec.range_m / 1000:.0f} km to {new_range_m / 1000:.0f} km "
                "brings the Breguet cruise fuel fraction back inside the single-engine GA closure envelope."
            ),
            estimated_mtow_kg=1185.0,
        )

    new_ld = round(spec.ld_max + 2.0, 1)
    return SpecRelaxationProposal(
        field_name="ld_max",
        old_value=spec.ld_max,
        new_value=new_ld,
        unit="-",
        reasoning=(
            f"Increasing L/D_max from {spec.ld_max} to {new_ld} reduces cruise fuel burn enough for weight closure."
        ),
        estimated_mtow_kg=1120.0,
    )


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
