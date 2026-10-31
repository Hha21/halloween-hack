"""Conceptual aircraft sizing tool (Owner: Harry).

Contract:
    conceptual_sizing(
        spec: MissionSpec,
        spar_mass_kg: float | None = None,
    ) -> ToolResult[ConceptualSizingResult]

Method (Raymer 2ed, Ch. 3 and 5): weight closure (Eq. 3.4) with the statistical empty-weight
fraction (Table 3.1); fuel fraction from historical segment fractions (Table 3.2), Breguet cruise
and loiter (Eqs. 3.6, 3.8, 3.10) and the 6% reserve/trapped allowance (Eq. 3.11); wing loading from
stall speed (Eq. 5.6); power from the larger of Table 5.2 and the cruise requirement.

Every constant comes from knowledge/tables/weight_fractions.yaml, so each number carries the
citation (and verified flag) of the table row it came from.
"""

from __future__ import annotations

import math
from typing import Any

from spiral.contract import ConceptualSizingResult, MissionSpec, Provenance, ToolError, ToolResult
from spiral.tools.lookup import equation, lookup

G = 9.80665  # m/s^2
RHO_SL = 1.225  # kg/m^3, ISA sea level
LB_PER_KG = 2.20462262
W_PER_HP = 745.699872
CBHP_TO_KG_PER_J = 0.45359237 / (W_PER_HP * 3600.0)  # (lb/hr)/hp -> kg/J
LOITER_SPEED_RATIO = 0.75  # loiter speed / cruise speed (assumption)
CRUISE_THROTTLE = 0.75  # cruise power / installed power (assumption)
FUEL_FRACTION_LIMIT = 0.42  # beyond this the mission is not plausible for a GA single (assumption)


def _prov(kind: str, row: dict[str, Any], what: str = "") -> Provenance:
    source = row.get("source", "knowledge/tables/weight_fractions.yaml")
    return Provenance(kind, f"{source}: {what}" if what else source, verified=bool(row.get("verified", False)))


def _range_warnings(spec: MissionSpec) -> list[str]:
    """Amber flags: spec values outside the historical range the heuristics were fitted on."""
    try:
        typical = lookup("aircraft_typical", "ga_single_engine").value
    except ToolError:
        return []
    warnings = []
    for name, row in typical.items():
        if not isinstance(row, dict) or "min_valid" not in row or not hasattr(spec, name):
            continue
        value = getattr(spec, name)
        if not row["min_valid"] <= value <= row["max_valid"]:
            warnings.append(
                f"{name}={value:g} is outside the typical GA single-engine range "
                f"[{row['min_valid']:g}, {row['max_valid']:g}] ({row.get('source', 'aircraft_typical.yaml')})"
            )
    return warnings


def conceptual_sizing(
    spec: MissionSpec,
    spar_mass_kg: float | None = None,
) -> ToolResult[ConceptualSizingResult]:
    rows = lookup("weight_fractions", "ga_single_engine").value
    ew = rows["empty_weight_regression"]
    seg = rows["segment_weight_fractions"]
    trapped = rows["trapped_reserve_allowance"]
    sfc = rows["propeller_sfc"]
    loiter_ld = rows["loiter_ld_factor"]
    hp_w = rows["hp_to_weight"]
    spar_share = rows["statistical_spar_share_of_empty"]

    warnings = _range_warnings(spec)
    warnings += [f"Table entry not yet verified against the book: {r['source']}" for r in
                 (ew, seg, trapped, sfc, loiter_ld, hp_w) if not r.get("verified")]

    # --- Fuel fraction (Raymer Eqs. 3.6, 3.8, 3.10, 3.11) -------------------------------------
    # Propeller form in SI: thrust SFC C = bsfc * g * V / eta_p, so the cruise exponent
    # R*C/(V*L/D) becomes R*bsfc*g/(eta_p*L/D). Prop aircraft cruise at L/D max and loiter at
    # 0.866 L/D max; loiter SFC and eta_p scale from the cruise values by Table 3.4.
    w_warmup, w_climb, w_landing = seg["warmup_takeoff"], seg["climb"], seg["landing"]
    w_cruise = math.exp(-(spec.range_m * spec.bsfc_kg_per_j * G) / (spec.prop_efficiency * spec.ld_max))

    loiter_bsfc = spec.bsfc_kg_per_j * sfc["loiter_cbhp"] / sfc["cruise_cbhp"]
    loiter_eta = spec.prop_efficiency * sfc["loiter_eta_p"] / sfc["cruise_eta_p"]
    loiter_speed = LOITER_SPEED_RATIO * spec.cruise_speed_ms
    w_loiter = math.exp(
        -(spec.reserve_s * loiter_speed * loiter_bsfc * G) / (loiter_eta * loiter_ld["value"] * spec.ld_max)
    )

    mission_fraction = w_warmup * w_climb * w_cruise * w_loiter * w_landing
    fuel_fraction = trapped["multiplier"] * (1.0 - mission_fraction)

    if fuel_fraction >= FUEL_FRACTION_LIMIT:
        raise ToolError(
            f"Fuel fraction {fuel_fraction:.3f} exceeds plausible GA limit ({FUEL_FRACTION_LIMIT}): "
            "reduce range_m or increase ld_max.",
            tool_name="conceptual_sizing",
            recoverable=True,
            suggested_field="range_m",
        )

    # --- Weight closure (Raymer Eq. 3.4, Table 3.1) -------------------------------------------
    # Solve W0 (1 - Wf/W0) - We(W0) - W_payload = 0 by bisection. With C < 0 the left side rises
    # monotonically in W0, so there is one root if any; no starting guess can make it fail falsely.
    payload_kg = spec.payload_mass_kg

    def empty_and_spar(w0_kg: float) -> tuple[float, float, float]:
        stat_empty_kg = ew["A"] * (w0_kg * LB_PER_KG) ** ew["C"] * w0_kg
        stat_spar = spar_share["fraction"] * stat_empty_kg
        if spar_mass_kg is None:
            return stat_empty_kg, stat_spar, stat_spar
        return stat_empty_kg - stat_spar + spar_mass_kg, stat_spar, spar_mass_kg

    def residual(w0_kg: float) -> float:
        return w0_kg * (1.0 - fuel_fraction) - empty_and_spar(w0_kg)[0] - payload_kg

    lo_kg, hi_kg = payload_kg, 100.0 * payload_kg
    if residual(hi_kg) <= 0.0:
        raise ToolError(
            f"Weight closure failed: no take-off mass below {hi_kg:,.0f} kg carries the payload "
            f"(fuel_fraction={fuel_fraction:.3f}).",
            tool_name="conceptual_sizing",
            recoverable=True,
            suggested_field="range_m",
        )
    for _ in range(100):
        mid_kg = 0.5 * (lo_kg + hi_kg)
        lo_kg, hi_kg = (mid_kg, hi_kg) if residual(mid_kg) < 0.0 else (lo_kg, mid_kg)
    mtow_kg = 0.5 * (lo_kg + hi_kg)
    empty_mass_kg, stat_spar_kg, spar_used_kg = empty_and_spar(mtow_kg)
    empty_fraction = empty_mass_kg / mtow_kg
    fuel_mass_kg = fuel_fraction * mtow_kg

    # --- Wing (Raymer Eq. 5.6, sea-level stall) ------------------------------------------------
    wing_loading_pa = 0.5 * RHO_SL * spec.stall_speed_ms**2 * spec.cl_max
    wing_area_m2 = mtow_kg * G / wing_loading_pa
    span_m = math.sqrt(spec.aspect_ratio * wing_area_m2)
    root_chord_m = 2.0 * wing_area_m2 / (span_m * (1.0 + spec.taper_ratio))
    tip_chord_m = spec.taper_ratio * root_chord_m
    lam = spec.taper_ratio
    mac_m = (2.0 / 3.0) * root_chord_m * (1.0 + lam + lam**2) / (1.0 + lam)

    # --- Power: larger of the statistical value (Table 5.2) and the cruise requirement --------
    # Cruise T/W = 1/(L/D) (Raymer Eq. 5.2) -> shaft power D*V/eta_p, flown at CRUISE_THROTTLE.
    cruise_power_w = (mtow_kg * G / spec.ld_max) * spec.cruise_speed_ms / spec.prop_efficiency
    power_for_cruise_w = cruise_power_w / CRUISE_THROTTLE
    power_statistical_w = hp_w["hp_per_lb"] * mtow_kg * LB_PER_KG * W_PER_HP
    installed_power_w = max(power_for_cruise_w, power_statistical_w)
    if power_for_cruise_w >= power_statistical_w:
        power_prov = Provenance(
            "assumption", f"Cruise power at {CRUISE_THROTTLE:.0%} throttle exceeds the Table 5.2 statistical value", verified=False
        )
    else:
        power_prov = _prov("table", hp_w, f"{hp_w['hp_per_lb']} hp/lb x MTOW")

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

    eq_closure = equation("weight_closure")
    eq_breguet = equation("breguet_range_prop")
    eq_loiter = equation("loiter_endurance_prop")
    eq_stall = equation("stall_wing_loading")
    eq_cruise = equation("cruise_thrust_matching")
    sources = sorted({r["source"] for r in (ew, seg, trapped, sfc, loiter_ld, hp_w, eq_closure, eq_breguet, eq_loiter, eq_stall, eq_cruise)})

    return ToolResult(
        value=result,
        sources=sources,
        assumptions=[
            f"Cruise at L/D max = {spec.ld_max:g}; loiter at {loiter_ld['value']} L/D max ({loiter_ld['source']})",
            f"Loiter speed = {LOITER_SPEED_RATIO:g} x cruise speed",
            f"Spar = {spar_share['fraction']:.1%} of statistical empty weight on lap 0 ({spar_share['source']})",
            f"Cruise flown at {CRUISE_THROTTLE:.0%} of installed power",
            "Stall wing loading at ISA sea-level density (1.225 kg/m^3)",
        ],
        warnings=warnings,
        provenance={
            "mtow_kg": _prov("equation", eq_closure, "weight closure"),
            "empty_mass_kg": _prov("table", ew, "We/W0 = A W0^C"),
            "empty_fraction": _prov("table", ew, "We/W0 = A W0^C"),
            "fuel_mass_kg": _prov("equation", trapped, "Wf/W0 = 1.06 (1 - Wx/W0)"),
            "fuel_fraction": _prov("equation", trapped, "Wf/W0 = 1.06 (1 - Wx/W0)"),
            "statistical_spar_mass_kg": _prov("assumption", spar_share),
            "spar_mass_used_kg": (
                _prov("assumption", spar_share) if spar_mass_kg is None
                else Provenance("equation", "Sized spar mass from the previous lap (spiral feedback)", verified=False)
            ),
            "payload_mass_kg": Provenance("user_input", "Crew + passengers x person mass + baggage (from the spec)"),
            "mass_breakdown_kg.crew": Provenance("user_input", "crew_count x person_mass_kg (from the spec)"),
            "mass_breakdown_kg.passengers": Provenance("user_input", "passenger_count x person_mass_kg (from the spec)"),
            "mass_breakdown_kg.baggage": Provenance("user_input", "baggage_mass_kg (from the spec)"),
            "mass_breakdown_kg.fuel": _prov("equation", trapped, "Wf/W0 = 1.06 (1 - Wx/W0)"),
            "mass_breakdown_kg.wing_spar": (
                _prov("assumption", spar_share) if spar_mass_kg is None
                else Provenance("equation", "Sized spar mass from the previous lap (spiral feedback)", verified=False)
            ),
            "mass_breakdown_kg.remaining_empty": _prov("table", ew, "statistical empty mass less the spar"),
            "segment_fractions.warmup_takeoff": _prov("table", seg),
            "segment_fractions.climb": _prov("table", seg),
            "segment_fractions.landing": _prov("table", seg),
            "segment_fractions.cruise": _prov("equation", eq_breguet, "Breguet range, propeller"),
            "segment_fractions.loiter": _prov("equation", eq_loiter, "loiter endurance at 0.866 L/D max"),
            "wing_loading_pa": _prov("equation", eq_stall, "W/S = 1/2 rho Vs^2 CLmax"),
            "wing_area_m2": _prov("equation", eq_stall, "S = W0 g / (W/S)"),
            "span_m": Provenance("equation", "b = sqrt(A S) (definition of aspect ratio)"),
            "root_chord_m": Provenance("equation", "c_root = 2S / (b (1 + taper)) (trapezoidal wing)"),
            "tip_chord_m": Provenance("equation", "c_tip = taper x c_root (trapezoidal wing)"),
            "mac_m": Provenance("equation", "MAC = 2/3 c_root (1 + l + l^2)/(1 + l) (trapezoidal wing)"),
            "cruise_power_w": _prov("equation", eq_cruise, "P = (W0 g / (L/D)) V / eta_p"),
            "installed_power_w": power_prov,
        },
    )
