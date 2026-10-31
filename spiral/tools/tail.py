"""Horizontal tail spar: Raymer's tail load case, then the shared I-beam sizing (Owner: Tharm).

Contract:
    horizontal_tail_spar(
        spec: MissionSpec,
        sizing: ConceptualSizingResult,
        geometry: AircraftGeometry,
        n_stations: int = 21,
    ) -> ToolResult[HorizontalTailResult]

Load case (Raymer 2ed, Sec. 14.3): the tail must carry an arbitrary normal-force coefficient at the
manoeuvre speed V_p, C_n = -0.55 downward (governs) and +0.35 upward, with the spanwise load
proportional to chord (p. 347). V_p comes from Eqs. 14.12-14.13 (p. 345). The resulting load is then
sized with spiral.tools.spar.size_spar, the same I-beam method as the main wing spar.
"""

from __future__ import annotations

from spiral.contract import (
    AircraftGeometry,
    ConceptualSizingResult,
    HorizontalTailResult,
    MissionSpec,
    Provenance,
    SparLoadsResult,
    SparStationLoad,
    ToolError,
    ToolResult,
)
from spiral.tools.lookup import equation, lookup
from spiral.tools.spar import size_spar

KG_TO_LB = 2.20462
# Sea-level ISA density: manoeuvre loads are taken at sea level, where a given true airspeed gives the largest q.
RHO_SEA_LEVEL = 1.225


def horizontal_tail_spar(
    spec: MissionSpec,
    sizing: ConceptualSizingResult,
    geometry: AircraftGeometry,
    n_stations: int = 21,
) -> ToolResult[HorizontalTailResult]:
    ht = geometry.horizontal_tail
    try:
        span_m = float(ht["span_m"])
        root_chord_m = float(ht["root_chord_m"])
        tip_chord_m = float(ht["tip_chord_m"])
    except KeyError as exc:
        raise ToolError(
            f"Aircraft geometry has no horizontal tail dimension {exc}.",
            tool_name="horizontal_tail_spar",
            recoverable=False,
        ) from exc

    table = lookup("component_loads", "ga_single_engine")
    rows = table.value
    vp_row = rows["maneuver_speed"]
    cn_row = rows["tail_normal_force_coefficients"]
    tc_row = rows["tail_thickness_ratio"]
    plan_row = rows["tail_planform_ranges"]
    eq_vp = equation("maneuver_speed")
    eq_tail = equation("tail_normal_force_load")
    warnings: list[str] = list(table.warnings)

    # Eqs. 14.12-14.13: velocities in any consistent unit, W in lb
    w_lb = sizing.mtow_kg * KG_TO_LB
    kp_raw = float(vp_row["kp_constant"]) + float(vp_row["kp_numerator_lb"]) / (w_lb + float(vp_row["kp_offset_lb"]))
    kp = min(max(kp_raw, float(vp_row["kp_min"])), float(vp_row["kp_max_general_aviation"]))
    v_s = spec.stall_speed_ms
    v_l = spec.cruise_speed_ms
    v_p = v_s + kp * (v_l - v_s)
    q_p = 0.5 * RHO_SEA_LEVEL * v_p**2

    # Governing case: the larger-magnitude coefficient (downward)
    cn = min(float(cn_row["horizontal_down"]), -abs(float(cn_row["horizontal_up"])))
    area_m2 = 0.5 * (root_chord_m + tip_chord_m) * span_m
    limit_load_n = abs(cn) * q_p * area_m2
    ultimate_load_n = limit_load_n * spec.ultimate_factor

    taper = tip_chord_m / root_chord_m if root_chord_m > 0 else 0.0
    aspect_ratio = span_m**2 / area_m2 if area_m2 > 0 else 0.0
    if not float(plan_row["taper_ratio_min"]) <= taper <= float(plan_row["taper_ratio_max"]):
        warnings.append(
            f"Horizontal tail taper ratio {taper:.2f} is outside {plan_row['taper_ratio_min']}-"
            f"{plan_row['taper_ratio_max']} ({plan_row['source']})"
        )
    if not float(plan_row["aspect_ratio_min"]) <= aspect_ratio <= float(plan_row["aspect_ratio_max"]):
        warnings.append(
            f"Horizontal tail aspect ratio {aspect_ratio:.2f} is outside {plan_row['aspect_ratio_min']}-"
            f"{plan_row['aspect_ratio_max']} ({plan_row['source']})"
        )
    if kp_raw > kp:
        warnings.append(f"K_p = {kp_raw:.2f} from Eq. 14.13 capped at {kp:.2f} for general aviation ({vp_row['source']})")

    # Spanwise load proportional to chord (p. 347), each half a cantilever from the centreline.
    semi_span_m = span_m / 2.0
    w_per_chord = ultimate_load_n / area_m2  # N/m of span per m of chord
    stations: list[SparStationLoad] = []
    for i in range(n_stations):
        y = semi_span_m * i / (n_stations - 1)
        chord_m = root_chord_m + (tip_chord_m - root_chord_m) * (y / semi_span_m)
        w = w_per_chord * chord_m
        stations.append(
            SparStationLoad(
                y_m=round(y, 4),
                chord_m=round(chord_m, 4),
                elliptical_lift_n_per_m=0.0,
                planform_lift_n_per_m=round(w, 2),
                schrenk_lift_n_per_m=round(w, 2),
                shear_n=0.0,
                moment_nm=0.0,
            )
        )
    for i in range(n_stations - 2, -1, -1):
        dy = stations[i + 1].y_m - stations[i].y_m
        avg_w = 0.5 * (stations[i].schrenk_lift_n_per_m + stations[i + 1].schrenk_lift_n_per_m)
        stations[i].shear_n = round(stations[i + 1].shear_n + avg_w * dy, 2)
        avg_v = 0.5 * (stations[i].shear_n + stations[i + 1].shear_n)
        stations[i].moment_nm = round(stations[i + 1].moment_nm + avg_v * dy, 2)

    loads = SparLoadsResult(
        n_ult=round(spec.ultimate_factor, 3),
        semi_span_m=round(semi_span_m, 3),
        root_shear_n=stations[0].shear_n,
        root_moment_nm=stations[0].moment_nm,
        stations=stations,
    )

    # Tail t/c ~ wing t/c (Raymer p. 76); same material as the wing spar.
    spar_res = size_spar(loads, thickness_to_chord=spec.thickness_to_chord, material_key=spec.spar_material)
    warnings += spar_res.warnings

    result = HorizontalTailResult(
        stall_speed_ms=round(v_s, 3),
        level_speed_ms=round(v_l, 3),
        kp=round(kp, 4),
        maneuver_speed_ms=round(v_p, 3),
        air_density_kg_m3=RHO_SEA_LEVEL,
        dynamic_pressure_pa=round(q_p, 1),
        normal_force_coefficient=cn,
        tail_area_m2=round(area_m2, 4),
        tail_span_m=round(span_m, 4),
        root_chord_m=round(root_chord_m, 4),
        tip_chord_m=round(tip_chord_m, 4),
        thickness_to_chord=spec.thickness_to_chord,
        limit_tail_load_n=round(limit_load_n, 1),
        ultimate_tail_load_n=round(ultimate_load_n, 1),
        loads=loads,
        spar=spar_res.value,
    )

    def eq(row: dict, what: str) -> Provenance:
        return Provenance("equation", f"{row['source']}: {what}", verified=bool(row.get("verified", False)))

    def tbl(row: dict, what: str) -> Provenance:
        return Provenance("table", f"{row['source']}: {what}", verified=bool(row.get("verified", False)))

    chord_load = eq(eq_tail, "load proportional to chord")
    provenance: dict[str, Provenance] = {
        "stall_speed_ms": Provenance("user_input", "Mission spec stall speed (V_s in Eq. 14.12)"),
        "level_speed_ms": Provenance(
            "assumption", "V_L taken as the spec cruise speed (Eq. 14.12 asks for the maximum level speed)", verified=False
        ),
        "kp": eq(eq_vp, "K_p = 0.15 + 5400 / (W + 3300), capped at 0.9 for general aviation"),
        "maneuver_speed_ms": eq(eq_vp, "V_p = V_s + K_p (V_L - V_s)"),
        "air_density_kg_m3": Provenance("assumption", "ISA sea-level density, 1.225 kg/m^3", verified=False),
        "dynamic_pressure_pa": Provenance("equation", "q = 0.5 rho V_p^2"),
        "normal_force_coefficient": tbl(cn_row, "horizontal tail C_n = -0.55 down (governs) / +0.35 up"),
        "tail_area_m2": geometry_prov("trapezoid area from the tail span and chords"),
        "tail_span_m": geometry_prov("horizontal tail span"),
        "root_chord_m": geometry_prov("horizontal tail root chord"),
        "tip_chord_m": geometry_prov("horizontal tail tip chord"),
        "thickness_to_chord": tbl(tc_row, "tail t/c taken equal to the wing t/c"),
        "limit_tail_load_n": eq(eq_tail, "P = |C_n| q S_HT"),
        "ultimate_tail_load_n": Provenance(
            "equation", f"Limit tail load x ultimate factor {spec.ultimate_factor:g} (Raymer 2ed, p. 335; factor from the spec)"
        ),
        "loads.n_ult": Provenance("equation", "Ultimate factor applied to the tail limit load (Raymer 2ed, p. 335)"),
        "loads.semi_span_m": geometry_prov("half the tail span"),
        "loads.root_shear_n": eq(eq_tail, "chord-proportional load integrated from the tip"),
        "loads.root_moment_nm": eq(eq_tail, "chord-proportional load integrated from the tip"),
        "loads.stations[].y_m": Provenance("equation", "Uniform spanwise stations, centreline to tip"),
        "loads.stations[].chord_m": Provenance("equation", "Linear taper between tail root and tip chord"),
        "loads.stations[].elliptical_lift_n_per_m": Provenance("equation", "Not used for the tail: zero (load is chord-proportional)"),
        "loads.stations[].planform_lift_n_per_m": chord_load,
        "loads.stations[].schrenk_lift_n_per_m": eq(eq_tail, "chord-proportional load (not Schrenk; the field is shared with the wing)"),
        "loads.stations[].shear_n": eq(eq_tail, "shear integrated from the tip"),
        "loads.stations[].moment_nm": eq(eq_tail, "moment integrated from the tip"),
    }
    for key, prov in spar_res.provenance.items():
        provenance[f"spar.{key}"] = prov
    # size_spar leaves these spar fields without per-value entries
    provenance.setdefault("spar.max_shear_stress_pa", eq(equation("beam_shear_stress"), "tau = V / (d t_web)"))

    return ToolResult(
        value=result,
        sources=[
            eq_vp["source"],
            eq_tail["source"],
            str(tc_row["source"]),
            *spar_res.sources,
            "knowledge/tables/component_loads.yaml#ga_single_engine",
        ],
        assumptions=[
            "V_L in Eq. 14.12 taken as the spec cruise speed; the true maximum level speed is higher, so V_p and the tail load are underestimated",
            "Manoeuvre load evaluated at sea-level density",
            f"Raymer's arbitrary tail C_n load treated as a limit load and multiplied by the ultimate factor {spec.ultimate_factor:g}",
            "Each tail half is a cantilever from the fuselage centreline; the spar carries the whole tail load",
            "Elevator-deflection load split (Fig. 14.14) and tail torsion not modelled",
            "Tail spar uses the wing spar material and the same I-beam proportions (depth 85% of t, cap width 35% of depth)",
        ],
        warnings=warnings,
        provenance=provenance,
    )


def geometry_prov(what: str) -> Provenance:
    """Tail planform numbers come from spiral.tools.geometry (C_HT sizing, Raymer 2ed Table 6.4)."""
    return Provenance("equation", f"Aircraft geometry (spiral.tools.geometry, Raymer 2ed Table 6.4 tail volume): {what}", verified=False)
