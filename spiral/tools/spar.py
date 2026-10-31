"""Main wing spar loads (Schrenk) and preliminary I-beam sizing (Owner: Harry).

Contracts:
    spar_loads(
        mtow_kg: float,
        span_m: float,
        root_chord_m: float,
        tip_chord_m: float,
        n_ult: float,
        n_stations: int = 21,
    ) -> ToolResult[SparLoadsResult]

    size_spar(
        loads: SparLoadsResult,
        thickness_to_chord: float,
        material_key: str = "al_2024_t3",
    ) -> ToolResult[SparSizingResult]
"""

from __future__ import annotations

import math

from spiral.contract import (
    SparLoadsResult,
    SparSizingResult,
    SparStationLoad,
    Provenance,
    SparStationSection,
    ToolResult,
)
from spiral.tools.lookup import equation, lookup


def spar_loads(
    mtow_kg: float,
    span_m: float,
    root_chord_m: float,
    tip_chord_m: float,
    n_ult: float,
    n_stations: int = 21,
) -> ToolResult[SparLoadsResult]:
    """Schrenk spanwise lift at ultimate load, integrated tip to root for shear and bending.

    Schrenk's approximation (Raymer 2ed, Fig. 14.10, p. 343): lift per unit span is the average of
    an elliptical distribution and one proportional to local chord, each carrying half the total.
    """
    g = 9.80665
    semi_span_m = span_m / 2.0
    total_ult_lift_n = mtow_kg * g * n_ult
    wing_area_m2 = 0.5 * (root_chord_m + tip_chord_m) * span_m

    ys = [semi_span_m * i / (n_stations - 1) for i in range(n_stations)]
    stations: list[SparStationLoad] = []

    for y in ys:
        eta = min(y / semi_span_m, 1.0)
        chord_m = root_chord_m + (tip_chord_m - root_chord_m) * eta
        elliptical_l = (2.0 * total_ult_lift_n / (math.pi * semi_span_m)) * math.sqrt(
            max(0.0, 1.0 - eta**2)
        )
        planform_l = (total_ult_lift_n / wing_area_m2) * chord_m
        schrenk_l = 0.5 * (elliptical_l + planform_l)
        stations.append(
            SparStationLoad(
                y_m=round(y, 4),
                chord_m=round(chord_m, 4),
                elliptical_lift_n_per_m=round(elliptical_l, 2),
                planform_lift_n_per_m=round(planform_l, 2),
                schrenk_lift_n_per_m=round(schrenk_l, 2),
                shear_n=0.0,
                moment_nm=0.0,
            )
        )

    # Integrate from tip (index -1) to root (index 0)
    for i in range(n_stations - 2, -1, -1):
        dy = stations[i + 1].y_m - stations[i].y_m
        avg_lift = 0.5 * (
            stations[i].schrenk_lift_n_per_m + stations[i + 1].schrenk_lift_n_per_m
        )
        stations[i].shear_n = round(stations[i + 1].shear_n + avg_lift * dy, 2)
        avg_shear = 0.5 * (stations[i].shear_n + stations[i + 1].shear_n)
        stations[i].moment_nm = round(stations[i + 1].moment_nm + avg_shear * dy, 2)

    result = SparLoadsResult(
        n_ult=round(n_ult, 3),
        semi_span_m=round(semi_span_m, 3),
        root_shear_n=stations[0].shear_n,
        root_moment_nm=stations[0].moment_nm,
        stations=stations,
    )

    return ToolResult(
        value=result,
        sources=[
            "Raymer 2ed, Fig. 14.10 (p. 343): Schrenk's approximation",
            "knowledge/equations.yaml#schrenk_lift_distribution",
        ],
        assumptions=[
            f"Ultimate manoeuvring load factor n_ult = {n_ult:.2f}",
            "Cantilever wing root at y = 0 m; aero lift carried 100% by main spar",
            "No inertia relief from wing structure or fuel (conservative)",
            "Ultimate load = 1.5 x limit load (Raymer 2ed, p. 335)",
        ],
        warnings=[],
        provenance={
            "root_shear_n": Provenance("equation", "Raymer 2ed, Fig. 14.10 (p. 343): Schrenk lift, integrated tip to root", verified=False),
            "root_moment_nm": Provenance("equation", "Raymer 2ed, Fig. 14.10 (p. 343): Schrenk lift, integrated tip to root", verified=False),
        },
    )


# Shear-buckling coefficient for a long, simply supported flat web panel in F = K E (t/b)^2 form.
# Raymer gives K as a chart (Fig. 14.42, p. 386); 4.8 is the classical value (k_s = 5.35 with
# K = k_s pi^2 / (12 (1 - nu^2))), so it stays a flagged assumption.
WEB_SHEAR_BUCKLING_K = 4.8


def size_spar(
    loads: SparLoadsResult,
    thickness_to_chord: float,
    material_key: str = "al_2024_t3",
) -> ToolResult[SparSizingResult]:
    """Preliminary I-section spar sizing at ultimate load, with beam deflection (Raymer 2ed, Ch. 14).

    Caps carry all the bending and the web all the shear (Raymer p. 385). In positive g the top cap
    is in compression and governs a symmetric I-beam, so caps are sized to compression yield F_cy
    (crippling isn't modelled, so F_cy is an upper bound). The tension margin against F_tu is
    reported separately. The web must neither fail in shear (F_su) nor buckle (Eq. 14.37,
    unstiffened panel of height = spar depth). Minimum gauges apply throughout.
    """
    mat_lookup = lookup("materials", material_key)
    mat = mat_lookup.value
    rho = float(mat["density_kg_m3"])
    e_mod = float(mat["youngs_modulus_pa"])
    sigma_allow = float(mat.get("compression_yield_strength_pa", mat["yield_strength_pa"]))
    sigma_tu = float(mat.get("ultimate_strength_pa", sigma_allow))
    tau_allow = float(mat["shear_strength_pa"])
    min_cap_t = float(mat.get("min_cap_thickness_m", 0.002))
    min_web_t = float(mat.get("min_web_thickness_m", 0.0015))

    sections: list[SparStationSection] = []
    curvatures: list[float] = []
    web_buckling_governs = 0

    for st in loads.stations:
        # Spar depth = 85% of local aerofoil thickness; cap width 35% of depth.
        depth_m = max(0.85 * thickness_to_chord * st.chord_m, 0.04)
        cap_width_m = max(0.35 * depth_m, 0.03)

        h_eff = max(depth_m * 0.90, 0.03)
        req_cap_area = abs(st.moment_nm) / (h_eff * sigma_allow)
        cap_t = max(req_cap_area / cap_width_m, min_cap_t)
        cap_area_m2 = cap_width_m * cap_t

        # Web: shear strength  t >= V / (d F_su);  no buckling  V/(d t) <= K E (t/d)^2  ->  t^3 >= V d / (K E)
        t_shear = abs(st.shear_n) / (depth_m * tau_allow)
        t_buckle = (abs(st.shear_n) * depth_m / (WEB_SHEAR_BUCKLING_K * e_mod)) ** (1.0 / 3.0)
        web_t = max(t_shear, t_buckle, min_web_t)
        if t_buckle >= max(t_shear, min_web_t) and st.shear_n > 0:
            web_buckling_governs += 1

        # Second moment of area of the idealised I-beam (Raymer Eq. 14.35: sigma = M z / I)
        h_web = max(depth_m - 2.0 * cap_t, 0.01)
        i_xx = (web_t * h_web**3) / 12.0 + 2.0 * cap_area_m2 * (0.5 * depth_m - 0.5 * cap_t) ** 2

        bending_stress_pa = abs(st.moment_nm) * (0.5 * depth_m) / i_xx
        shear_stress_pa = abs(st.shear_n) / (depth_m * web_t)

        curvatures.append(st.moment_nm / (e_mod * i_xx))
        sections.append(
            SparStationSection(
                y_m=st.y_m,
                depth_m=round(depth_m, 4),
                cap_area_m2=round(cap_area_m2, 6),
                cap_width_m=round(cap_width_m, 4),
                cap_thickness_m=round(cap_t, 5),
                web_thickness_m=round(web_t, 5),
                bending_stress_pa=round(bending_stress_pa, 1),
                shear_stress_pa=round(shear_stress_pa, 1),
                deflection_m=0.0,
            )
        )

    # Double-integrate curvature from the root (clamped: w = dw/dy = 0 at y = 0)
    slopes = [0.0] * len(sections)
    for i in range(1, len(sections)):
        dy = sections[i].y_m - sections[i - 1].y_m
        slopes[i] = slopes[i - 1] + 0.5 * (curvatures[i - 1] + curvatures[i]) * dy
        sections[i].deflection_m = round(sections[i - 1].deflection_m + 0.5 * (slopes[i - 1] + slopes[i]) * dy, 5)

    # Integrate cap + web volume along one semi-span, then double for both wings
    semi_span_volume_m3 = 0.0
    for i in range(1, len(sections)):
        dy = sections[i].y_m - sections[i - 1].y_m
        a0 = 2.0 * sections[i - 1].cap_area_m2 + sections[i - 1].depth_m * sections[i - 1].web_thickness_m
        a1 = 2.0 * sections[i].cap_area_m2 + sections[i].depth_m * sections[i].web_thickness_m
        semi_span_volume_m3 += 0.5 * (a0 + a1) * dy

    semi_span_mass_kg = semi_span_volume_m3 * rho
    mass_both_wings_kg = 2.0 * semi_span_mass_kg

    max_bending_pa = max(s.bending_stress_pa for s in sections)
    max_shear_pa = max(s.shear_stress_pa for s in sections)
    safety_margin = (sigma_allow / max_bending_pa - 1.0) if max_bending_pa > 0 else 1.0
    tension_margin = (sigma_tu / max_bending_pa - 1.0) if max_bending_pa > 0 else 1.0

    root = sections[0]
    tip = sections[-1]

    result = SparSizingResult(
        material_key=material_key,
        mass_both_wings_kg=round(mass_both_wings_kg, 2),
        semi_span_mass_kg=round(semi_span_mass_kg, 2),
        root_depth_m=root.depth_m,
        tip_depth_m=tip.depth_m,
        root_cap_area_m2=root.cap_area_m2,
        root_cap_width_m=root.cap_width_m,
        root_cap_thickness_m=root.cap_thickness_m,
        root_web_thickness_m=root.web_thickness_m,
        max_bending_stress_pa=round(max_bending_pa, 1),
        max_shear_stress_pa=round(max_shear_pa, 1),
        allowable_yield_stress_pa=sigma_allow,
        safety_margin=round(safety_margin, 3),
        tip_deflection_m=tip.deflection_m,
        stations=sections,
    )

    eq_bend = equation("beam_bending_stress")
    eq_shear = equation("beam_shear_stress")
    eq_buckle = equation("web_shear_buckling")
    eq_caps = equation("ibeam_cap_sizing")
    mat_prov = Provenance(
        "table", str(mat.get("source", f"knowledge/tables/materials.yaml#{material_key}")), verified=bool(mat.get("verified", False))
    )

    def prov(row: dict, what: str) -> Provenance:
        return Provenance("equation", f"{row['source']}: {what}", verified=bool(row.get("verified", False)))

    return ToolResult(
        value=result,
        sources=[
            eq_caps["source"],
            eq_bend["source"],
            eq_shear["source"],
            eq_buckle["source"],
            "Raymer 2ed, Ch. 14 (p. 385): caps carry bending, web carries shear",
            *mat_lookup.sources,
        ],
        assumptions=[
            "Spar depth = 85% of local aerofoil thickness; cap width = 35% of depth",
            f"Caps sized at ultimate load to compression yield F_cy = {sigma_allow / 1e6:.0f} MPa (compression cap governs; crippling not modelled)",
            f"Tension cap margin against F_tu = {sigma_tu / 1e6:.0f} MPa: {tension_margin:+.2f}",
            f"Web: no shear failure (F_su = {tau_allow / 1e6:.0f} MPa) and no shear buckling, unstiffened panel, "
            f"K = {WEB_SHEAR_BUCKLING_K} (classical long simply supported panel; Raymer gives K as a chart, Fig. 14.42)",
            f"Minimum gauges: cap >= {min_cap_t * 1e3:.1f} mm, web >= {min_web_t * 1e3:.1f} mm (assumption)",
            "Mass counts caps and web only: no stiffeners, ribs or fittings",
        ],
        warnings=list(mat_lookup.warnings)
        + ([f"Web shear buckling sets the web thickness at {web_buckling_governs} of {len(sections)} stations"]
           if web_buckling_governs else []),
        provenance={
            "mass_both_wings_kg": prov(eq_caps, "cap + web volume x density, both wings"),
            "root_cap_area_m2": prov(eq_caps, "A_cap = M / (h F_cy)"),
            "root_web_thickness_m": prov(eq_buckle, f"max(shear strength, no-buckling with K = {WEB_SHEAR_BUCKLING_K}, min gauge)"),
            "max_bending_stress_pa": prov(eq_bend, "sigma = M z / I"),
            "max_shear_stress_pa": prov(eq_shear, "tau = V / (d t_web)"),
            "allowable_yield_stress_pa": mat_prov,
            "safety_margin": prov(eq_bend, "F_cy / sigma_max - 1"),
            "tip_deflection_m": Provenance("equation", "Euler-Bernoulli: double integration of M/(EI) from a clamped root", verified=False),
        },
    )
