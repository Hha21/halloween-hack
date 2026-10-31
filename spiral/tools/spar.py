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
from spiral.tools.lookup import lookup


def spar_loads(
    mtow_kg: float,
    span_m: float,
    root_chord_m: float,
    tip_chord_m: float,
    n_ult: float,
    n_stations: int = 21,
) -> ToolResult[SparLoadsResult]:
    """Placeholder/stub for Schrenk spanwise lift, shear, and bending moment.

    TODO (Harry): Verify numerical integration and structural relief assumptions if desired.
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
            "Schrenk (1940) NACA TM 948 (Spanwise Lift Distribution)",
            "knowledge/equations.yaml#schrenk_lift_distribution",
        ],
        assumptions=[
            f"Ultimate manoeuvring load factor n_ult = {n_ult:.2f}",
            "Cantilever wing root at y = 0 m; aero lift carried 100% by main spar",
        ],
        warnings=[],
        provenance={
            "root_shear_n": Provenance("equation", "Schrenk (1940) NACA TM 948", verified=False),
            "root_moment_nm": Provenance("equation", "Schrenk (1940) NACA TM 948", verified=False),
        },
    )


def size_spar(
    loads: SparLoadsResult,
    thickness_to_chord: float,
    material_key: str = "al_2024_t3",
) -> ToolResult[SparSizingResult]:
    """Placeholder/stub for preliminary I-section spar sizing and beam deflection.

    TODO (Harry): Refine flange/web geometry rules, buckling checks, and deflection integration.
    """
    mat_lookup = lookup("materials", material_key)
    mat = mat_lookup.value
    rho = float(mat["density_kg_m3"])
    e_mod = float(mat["youngs_modulus_pa"])
    sigma_allow = float(mat["yield_strength_pa"])
    tau_allow = float(mat["shear_strength_pa"])
    min_cap_t = float(mat.get("min_cap_thickness_m", 0.002))
    min_web_t = float(mat.get("min_web_thickness_m", 0.0015))

    sections: list[SparStationSection] = []
    curvatures: list[float] = []

    for st in loads.stations:
        # Spar depth = 85% of local airfoil thickness
        depth_m = max(0.85 * thickness_to_chord * st.chord_m, 0.04)
        cap_width_m = max(0.35 * depth_m, 0.03)

        h_eff = max(depth_m * 0.90, 0.03)
        req_cap_area = abs(st.moment_nm) / (h_eff * sigma_allow) if h_eff > 0 else 0.0
        cap_t = max(req_cap_area / cap_width_m, min_cap_t)
        cap_area_m2 = cap_width_m * cap_t

        req_web_t = abs(st.shear_n) / (depth_m * tau_allow) if depth_m > 0 else 0.0
        web_t = max(req_web_t, min_web_t)

        # Second moment of area I_xx for idealised I-beam
        h_web = max(depth_m - 2.0 * cap_t, 0.01)
        i_xx = (web_t * (h_web**3)) / 12.0 + 2.0 * cap_area_m2 * ((0.5 * depth_m - 0.5 * cap_t) ** 2)

        bending_stress_pa = (abs(st.moment_nm) * (0.5 * depth_m)) / i_xx if i_xx > 0 else 0.0
        shear_stress_pa = abs(st.shear_n) / (depth_m * web_t)

        curvatures.append(st.moment_nm / (e_mod * i_xx) if i_xx > 0 else 0.0)
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

    # Double integrate curvature from root (clamped: dw/dy=0, w=0 at y=0)
    slopes = [0.0] * len(sections)
    for i in range(1, len(sections)):
        dy = sections[i].y_m - sections[i - 1].y_m
        slopes[i] = slopes[i - 1] + 0.5 * (curvatures[i - 1] + curvatures[i]) * dy
        sections[i].deflection_m = round(
            sections[i - 1].deflection_m + 0.5 * (slopes[i - 1] + slopes[i]) * dy,
            5,
        )

    # Integrate mass along one semi-span, then double for both wings
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

    return ToolResult(
        value=result,
        sources=[
            "Megson, Aircraft Structures for Engineering Students, Ch. 9 (I-Beam Sizing)",
            "knowledge/equations.yaml#ibeam_cap_sizing",
            *mat_lookup.sources,
        ],
        assumptions=[
            "Spar depth = 85% of local airfoil thickness",
            f"Minimum gauge constraints: cap >= {min_cap_t*1e3:.1f} mm, web >= {min_web_t*1e3:.1f} mm",
        ],
        warnings=list(mat_lookup.warnings),
        provenance={
            "mass_both_wings_kg": Provenance("equation", "Megson, Ch. 9 (I-Beam Sizing)", verified=False),
            "max_bending_stress_pa": Provenance("equation", "Megson, Ch. 9 (I-Beam Sizing)", verified=False),
            "allowable_yield_stress_pa": Provenance(
                "table", str(mat.get("source", f"knowledge/tables/materials.yaml#{material_key}")),
                verified=bool(mat.get("verified", False)),
            ),
            "safety_margin": Provenance("equation", "Megson, Ch. 9 (I-Beam Sizing)", verified=False),
            "tip_deflection_m": Provenance("equation", "Euler-Bernoulli double integration of M/EI", verified=False),
        },
    )
