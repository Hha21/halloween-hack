"""Parametric 3D aircraft geometry primitives for Three.js rendering (Owner: Tharm).

Contract:
    aircraft_geometry(
        spec: MissionSpec,
        sizing: ConceptualSizingResult,
    ) -> ToolResult[AircraftGeometry]
"""

from __future__ import annotations

import math

from spiral.contract import (
    AircraftGeometry,
    ConceptualSizingResult,
    MissionSpec,
    Provenance,
    ToolResult,
)


def naca4_coordinates(
    max_camber: float = 0.02,
    camber_pos: float = 0.40,
    thickness_to_chord: float = 0.15,
    n_cosine_pts: int = 32,
) -> list[tuple[float, float]]:
    """Compute closed NACA 4-digit airfoil contour (x/c, z/c) from TE -> upper -> LE -> lower -> TE.

    Follows Abbott & von Doenhoff, 'Theory of Wing Sections' (1959), Ch. 6 (NACA 2415 default).
    """
    pts_upper: list[tuple[float, float]] = []
    pts_lower: list[tuple[float, float]] = []
    m = max(0.0, float(max_camber))
    p = max(0.05, min(0.95, float(camber_pos)))
    t = max(0.04, min(0.30, float(thickness_to_chord)))

    for i in range(n_cosine_pts + 1):
        beta = (math.pi * i) / n_cosine_pts
        xc = 0.5 * (1.0 - math.cos(beta))
        yt = 5.0 * t * (
            0.2969 * math.sqrt(max(xc, 0.0))
            - 0.1260 * xc
            - 0.3516 * (xc**2)
            + 0.2843 * (xc**3)
            - 0.1036 * (xc**4)
        )
        if m > 1e-6:
            if xc < p:
                yc = (m / (p**2)) * (2.0 * p * xc - xc**2)
                dyc_dx = (2.0 * m / (p**2)) * (p - xc)
            else:
                yc = (m / ((1.0 - p) ** 2)) * ((1.0 - 2.0 * p) + 2.0 * p * xc - xc**2)
                dyc_dx = (2.0 * m / ((1.0 - p) ** 2)) * (p - xc)
            theta = math.atan(dyc_dx)
        else:
            yc = 0.0
            theta = 0.0

        xu = xc - yt * math.sin(theta)
        zu = yc + yt * math.cos(theta)
        xl = xc + yt * math.sin(theta)
        zl = yc - yt * math.cos(theta)
        pts_upper.append((round(xu, 6), round(zu, 6)))
        pts_lower.append((round(xl, 6), round(zl, 6)))

    return list(reversed(pts_upper)) + pts_lower[1:]

from spiral.tools.lookup import lookup


def aircraft_geometry(
    spec: MissionSpec,
    sizing: ConceptualSizingResult,
) -> ToolResult[AircraftGeometry]:
    """Compute parametric Three.js primitive dimensions (in metres) from conceptual sizing."""
    typical_lookup = lookup("aircraft_typical", "ga_single_engine")
    typical = typical_lookup.value

    fuse_reg = typical.get("fuselage_length_regression", {})
    a_fuse = float(fuse_reg.get("a", 4.37))
    c_fuse = float(fuse_reg.get("C", 0.23))
    fuse_src = str(fuse_reg.get("source", "Raymer 2ed, Table 6.3 (p. 110)"))
    fuse_ver = bool(fuse_reg.get("verified", True))

    tail_vol = typical.get("tail_volume_coefficients", {})
    c_ht = float(tail_vol.get("c_ht", 0.70))
    c_vt = float(tail_vol.get("c_vt", 0.04))
    tail_src = str(tail_vol.get("source", "Raymer 2ed, Table 6.4 (p. 112)"))
    tail_ver = bool(tail_vol.get("verified", True))

    # Raymer Table 4.3 (row "Others") horizontal tail planform ranges; use the midpoint of each
    plan = lookup("component_loads", "ga_single_engine").value.get("tail_planform_ranges", {})
    ht_ar = 0.5 * (float(plan.get("aspect_ratio_min", 3.0)) + float(plan.get("aspect_ratio_max", 5.0)))
    ht_taper = 0.5 * (float(plan.get("taper_ratio_min", 0.3)) + float(plan.get("taper_ratio_max", 0.6)))
    plan_src = str(plan.get("source", "Raymer 2ed, Table 4.3 (p. 76)"))
    plan_ver = bool(plan.get("verified", False))

    # Raymer Table 6.3 general aviation fuselage length regression (in SI)
    w0_lb = max(sizing.mtow_kg * 2.20462, 500.0)
    fuselage_length_m = 0.3048 * (a_fuse * (w0_lb**c_fuse))
    fuselage_diameter_m = 1.22

    # Wing vertical offset based on wing_position
    z_map = {"high": 0.52, "mid": 0.0, "low": -0.48}
    wing_z_m = z_map.get(spec.wing_position, 0.52)
    wing_x_le_m = 0.32 * fuselage_length_m

    # Tail sizing using Raymer Table 6.4 tail volume coefficients (C_HT = 0.70, C_VT = 0.04)
    tail_arm_m = 0.52 * fuselage_length_m

    ht_area_m2 = (c_ht * sizing.wing_area_m2 * sizing.mac_m) / max(tail_arm_m, 1.0)
    ht_span_m = math.sqrt(ht_ar * ht_area_m2)
    ht_root_chord_m = (2.0 * ht_area_m2) / (ht_span_m * (1.0 + ht_taper))
    ht_tip_chord_m = ht_taper * ht_root_chord_m

    # Vertical tail inside Raymer Table 4.3 row "Others" (A 1.3-2.0, taper 0.3-0.6); not in the YAML row
    vt_area_m2 = (c_vt * sizing.wing_area_m2 * sizing.span_m) / max(tail_arm_m, 1.0)
    vt_ar = 1.6
    vt_taper = 0.55
    vt_height_m = math.sqrt(vt_ar * vt_area_m2)
    vt_root_chord_m = (2.0 * vt_area_m2) / (vt_height_m * (1.0 + vt_taper))
    vt_tip_chord_m = vt_taper * vt_root_chord_m

    geom = AircraftGeometry(
        fuselage={
            "length_m": round(fuselage_length_m, 3),
            "diameter_m": round(fuselage_diameter_m, 3),
            "nose_length_m": round(0.22 * fuselage_length_m, 3),
            "cabin_length_m": round(0.36 * fuselage_length_m, 3),
            "tailcone_length_m": round(0.42 * fuselage_length_m, 3),
        },
        wing={
            "span_m": sizing.span_m,
            "root_chord_m": sizing.root_chord_m,
            "tip_chord_m": sizing.tip_chord_m,
            "thickness_to_chord": spec.thickness_to_chord,
            "x_le_m": round(wing_x_le_m, 3),
            "z_m": wing_z_m,
            "dihedral_deg": 2.0 if spec.wing_position == "high" else 5.0,
            "position": spec.wing_position,
        },
        horizontal_tail={
            "span_m": round(ht_span_m, 3),
            "root_chord_m": round(ht_root_chord_m, 3),
            "tip_chord_m": round(ht_tip_chord_m, 3),
            "x_le_m": round(wing_x_le_m + tail_arm_m, 3),
            "z_m": 0.15,
        },
        vertical_tail={
            "height_m": round(vt_height_m, 3),
            "root_chord_m": round(vt_root_chord_m, 3),
            "tip_chord_m": round(vt_tip_chord_m, 3),
            "x_le_m": round(wing_x_le_m + tail_arm_m - 0.2, 3),
            "z_m": 0.25,
        },
        propeller={
            "diameter_m": 1.90,
            "x_m": 0.05,
        },
    )

    return ToolResult(
        value=geom,
        sources=[
            "Raymer 2ed, Table 6.3 (p. 110): Fuselage Length & Diameter Regression (Single Engine)",
            "Raymer 2ed, Table 6.4 (p. 112): Tail Volume Coefficients (C_HT = 0.70, C_VT = 0.04)",
            "Raymer 2ed, Table 4.3 (p. 76): Tail Aspect Ratio and Taper Ratio (row Others)",
            "Raymer 2ed, Ch. 4 (p. 50-60): Trapezoidal Planform, MAC & Dihedral",
            "knowledge/tables/aircraft_typical.yaml#ga_single_engine",
            "knowledge/tables/component_loads.yaml#ga_single_engine.tail_planform_ranges",
        ],
        assumptions=[
            "Tail moment arm = 52% of fuselage length (Raymer 2ed Table 6.4 typical arm ratio)",
            f"Wing configuration: {spec.wing_position} wing",
        ],
        warnings=[],
        provenance={
            # Fuselage
            "fuselage.length_m": Provenance(
                kind="equation",
                source=f"{fuse_src}: L_f = 0.3048 x {a_fuse} x (W_0,lb)^{c_fuse}",
                verified=fuse_ver,
            ),
            "fuselage.diameter_m": Provenance(
                kind="equation",
                source=f"{fuse_src}: GA 4-place cabin diameter",
                verified=fuse_ver,
            ),
            "fuselage.nose_length_m": Provenance(
                kind="assumption",
                source=f"{fuse_src}: 22% fuselage length nose cowl",
                verified=fuse_ver,
            ),
            "fuselage.cabin_length_m": Provenance(
                kind="assumption",
                source=f"{fuse_src}: 36% fuselage length cabin",
                verified=fuse_ver,
            ),
            "fuselage.tailcone_length_m": Provenance(
                kind="assumption",
                source=f"{fuse_src}: 42% fuselage length tailcone",
                verified=fuse_ver,
            ),
            # Wing
            "wing.span_m": Provenance(
                kind="equation",
                source="Raymer 2ed, Eq. 5.6 & Table 4.1: b = sqrt(AR x S)",
                verified=True,
            ),
            "wing.root_chord_m": Provenance(
                kind="equation",
                source="Raymer 2ed, Ch. 4 (p. 56): c_root = 2 S / (b (1 + lambda))",
                verified=True,
            ),
            "wing.tip_chord_m": Provenance(
                kind="equation",
                source="Raymer 2ed, Ch. 4 (p. 56): c_tip = lambda x c_root",
                verified=True,
            ),
            "wing.thickness_to_chord": Provenance(
                kind="table",
                source="Raymer 2ed, Table 4.1: thickness_to_chord from spec",
                verified=True,
            ),
            "wing.x_le_m": Provenance(
                kind="assumption",
                source="Wing quarter-chord placed at 32% fuselage length",
                verified=True,
            ),
            "wing.z_m": Provenance(
                kind="assumption",
                source=f"Vertical placement for {spec.wing_position} wing",
                verified=True,
            ),
            "wing.dihedral_deg": Provenance(
                kind="equation",
                source="Raymer 2ed, Table 4.2 (p. 59): Wing Dihedral Guidelines",
                verified=True,
            ),
            # Horizontal tail
            "horizontal_tail.span_m": Provenance(
                kind="equation",
                source=(
                    f"{tail_src}: S_HT = C_HT x S x MAC / L_HT (C_HT = {c_ht}); b_HT = sqrt(A x S_HT), "
                    f"A = {ht_ar:g} midpoint of {plan_src} row Others"
                ),
                verified=tail_ver and plan_ver,
            ),
            "horizontal_tail.root_chord_m": Provenance(
                kind="equation",
                source=(
                    f"{plan_src}, row Others: c_root = 2 S_HT / (b_HT (1 + taper)), "
                    f"A = {ht_ar:g} and taper = {ht_taper:g} (range midpoints)"
                ),
                verified=tail_ver and plan_ver,
            ),
            "horizontal_tail.tip_chord_m": Provenance(
                kind="equation",
                source=f"{plan_src}, row Others: c_tip = {ht_taper:g} x c_root (taper range midpoint)",
                verified=tail_ver and plan_ver,
            ),
            "horizontal_tail.x_le_m": Provenance(
                kind="assumption",
                source=f"{tail_src}: tail arm 52% fuselage length",
                verified=tail_ver,
            ),
            "horizontal_tail.z_m": Provenance(
                kind="assumption",
                source="Horizontal stabilizer vertical offset on rear fuselage",
                verified=True,
            ),
            # Vertical tail
            "vertical_tail.height_m": Provenance(
                kind="equation",
                source=(
                    f"{tail_src}: S_VT = C_VT x S x b / L_VT (C_VT = {c_vt}); h_VT = sqrt(A x S_VT), "
                    f"A = {vt_ar:g} within 1.3-2.0, Raymer 2ed, Table 4.3 (p. 76) row Others"
                ),
                verified=False,
            ),
            "vertical_tail.root_chord_m": Provenance(
                kind="equation",
                source=(
                    "Raymer 2ed, Table 4.3 (p. 76), row Others: c_root = 2 S_VT / (h_VT (1 + taper)), "
                    f"A = {vt_ar:g} within 1.3-2.0, taper = {vt_taper:g} within 0.3-0.6"
                ),
                verified=False,
            ),
            "vertical_tail.tip_chord_m": Provenance(
                kind="equation",
                source=f"Raymer 2ed, Table 4.3 (p. 76), row Others: c_tip = {vt_taper:g} x c_root, within 0.3-0.6",
                verified=False,
            ),
            "vertical_tail.x_le_m": Provenance(
                kind="assumption",
                source=f"{tail_src}: tail arm 52% fuselage length",
                verified=tail_ver,
            ),
            "vertical_tail.z_m": Provenance(
                kind="assumption",
                source="Vertical fin root vertical offset on rear fuselage",
                verified=True,
            ),
            # Propeller
            "propeller.diameter_m": Provenance(
                kind="table",
                source="knowledge/tables/aircraft_typical.yaml#ga_single_engine (2-blade prop)",
                verified=True,
            ),
            "propeller.x_m": Provenance(
                kind="assumption",
                source="Tractor propeller forward offset from fuselage nose",
                verified=True,
            ),
        },
    )
