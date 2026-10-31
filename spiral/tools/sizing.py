"""Conceptual aircraft sizing tool (Owner: Tharm).

Contract:
    conceptual_sizing(
        spec: MissionSpec,
        spar_mass_kg: float | None = None,
    ) -> ToolResult[ConceptualSizingResult]
"""

from __future__ import annotations

import math

from spiral.contract import ConceptualSizingResult, MissionSpec, ToolError, ToolResult


def conceptual_sizing(
    spec: MissionSpec,
    spar_mass_kg: float | None = None,
) -> ToolResult[ConceptualSizingResult]:
    """Placeholder/stub for conceptual sizing (Raymer Ch. 3 & Ch. 5).

    TODO (Tharm): Replace or refine with verified Raymer weight closure, ISA atmosphere,
    and table lookups from `knowledge/tables/weight_fractions.yaml`.
    """
    warnings: list[str] = []
    if not (6.0 <= spec.aspect_ratio <= 10.0):
        warnings.append(
            f"aspect_ratio={spec.aspect_ratio} outside typical GA range [6.0, 10.0] (Raymer Table 4.1)"
        )
    if not (0.4 <= spec.taper_ratio <= 1.0):
        warnings.append(
            f"taper_ratio={spec.taper_ratio} outside typical GA range [0.4, 1.0] (Raymer Ch. 4.3)"
        )

    # Breguet cruise + loiter fuel fraction placeholder
    g = 9.80665
    w_warmup = 0.970
    w_climb = 0.985
    w_cruise = math.exp(
        -(spec.range_m * spec.bsfc_kg_per_j * g) / (spec.prop_efficiency * spec.ld_max)
    )
    w_loiter = math.exp(
        -(spec.reserve_s * (0.75 * spec.cruise_speed_ms) * spec.bsfc_kg_per_j * g)
        / (spec.prop_efficiency * spec.ld_max)
    )
    w_landing = 0.995

    mission_fraction = w_warmup * w_climb * w_cruise * w_loiter * w_landing
    fuel_fraction = 1.06 * (1.0 - mission_fraction)

    if fuel_fraction >= 0.42:
        raise ToolError(
            f"Fuel fraction {fuel_fraction:.3f} exceeds plausible GA limit (0.42): reduce range_m or increase ld_max.",
            tool_name="conceptual_sizing",
            recoverable=True,
            suggested_field="range_m",
        )

    # Iterative MTOW closure placeholder
    payload_kg = spec.payload_mass_kg
    mtow_kg = 1100.0
    stat_spar_share = 0.085  # statistical spar share of empty weight on Lap 0

    for _ in range(40):
        w0_lb = max(mtow_kg * 2.20462, 100.0)
        stat_empty_fraction = 2.36 * (w0_lb**-0.18)
        stat_empty_kg = stat_empty_fraction * mtow_kg
        stat_spar_kg = stat_spar_share * stat_empty_kg

        if spar_mass_kg is None:
            empty_kg = stat_empty_kg
            spar_used_kg = stat_spar_kg
        else:
            empty_kg = (stat_empty_kg - stat_spar_kg) + spar_mass_kg
            spar_used_kg = spar_mass_kg

        empty_fraction = empty_kg / mtow_kg
        denom = 1.0 - fuel_fraction - empty_fraction
        if denom <= 0.05:
            raise ToolError(
                f"Weight closure failed (empty_fraction={empty_fraction:.3f} + fuel_fraction={fuel_fraction:.3f} >= 0.95).",
                tool_name="conceptual_sizing",
                recoverable=True,
                suggested_field="range_m",
            )
        next_mtow_kg = payload_kg / denom
        if abs(next_mtow_kg - mtow_kg) / mtow_kg < 1e-5:
            mtow_kg = next_mtow_kg
            break
        mtow_kg = 0.6 * next_mtow_kg + 0.4 * mtow_kg

    empty_mass_kg = empty_fraction * mtow_kg
    fuel_mass_kg = fuel_fraction * mtow_kg

    # Wing sizing from stall speed at sea-level density
    rho_sl = 1.225
    wing_loading_pa = 0.5 * rho_sl * (spec.stall_speed_ms**2) * spec.cl_max
    wing_area_m2 = (mtow_kg * g) / wing_loading_pa
    span_m = math.sqrt(spec.aspect_ratio * wing_area_m2)
    root_chord_m = (2.0 * wing_area_m2) / (span_m * (1.0 + spec.taper_ratio))
    tip_chord_m = spec.taper_ratio * root_chord_m
    mac_m = (
        (2.0 / 3.0)
        * root_chord_m
        * ((1.0 + spec.taper_ratio + spec.taper_ratio**2) / (1.0 + spec.taper_ratio))
    )

    # Cruise and installed power
    cruise_drag_n = (mtow_kg * g) / spec.ld_max
    cruise_power_w = (cruise_drag_n * spec.cruise_speed_ms) / spec.prop_efficiency
    installed_power_w = cruise_power_w / 0.75

    result = ConceptualSizingResult(
        mtow_kg=round(mtow_kg, 2),
        empty_mass_kg=round(empty_mass_kg, 2),
        fuel_mass_kg=round(fuel_mass_kg, 2),
        payload_mass_kg=round(payload_kg, 2),
        empty_fraction=round(empty_fraction, 4),
        fuel_fraction=round(fuel_fraction, 4),
        spar_mass_used_kg=round(spar_used_kg, 2),
        statistical_spar_mass_kg=round(stat_spar_kg, 2),
        wing_loading_pa=round(wing_loading_pa, 2),
        wing_area_m2=round(wing_area_m2, 3),
        span_m=round(span_m, 3),
        root_chord_m=round(root_chord_m, 3),
        tip_chord_m=round(tip_chord_m, 3),
        mac_m=round(mac_m, 3),
        cruise_power_w=round(cruise_power_w, 1),
        installed_power_w=round(installed_power_w, 1),
        segment_fractions={
            "warmup_takeoff": w_warmup,
            "climb": w_climb,
            "cruise": round(w_cruise, 4),
            "loiter": round(w_loiter, 4),
            "landing": w_landing,
        },
        mass_breakdown_kg={
            "wing_spar": round(spar_used_kg, 2),
            "remaining_empty": round(empty_mass_kg - spar_used_kg, 2),
            "fuel": round(fuel_mass_kg, 2),
            "crew": round(spec.crew_count * spec.person_mass_kg, 2),
            "passengers": round(spec.passenger_count * spec.person_mass_kg, 2),
            "baggage": round(spec.baggage_mass_kg, 2),
        },
    )

    return ToolResult(
        value=result,
        sources=[
            "Raymer 6ed, Ch. 3, Eq. 3.4 & Table 3.1 (Weight Closure)",
            "Raymer 6ed, Ch. 3, Eq. 3.7–3.8 (Breguet Range & Loiter)",
            "Raymer 6ed, Ch. 5, Eq. 5.6 (Stall Wing Loading)",
            "knowledge/tables/weight_fractions.yaml#ga_single_engine",
        ],
        assumptions=[
            f"Cruise at L/D_max = {spec.ld_max}",
            "6% trapped and reserve fuel allowance (Raymer Table 3.2)",
            "Installed power sized for 75% continuous cruise throttle setting",
        ],
        warnings=warnings,
    )
