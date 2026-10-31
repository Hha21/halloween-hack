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


def aircraft_geometry(
    spec: MissionSpec,
    sizing: ConceptualSizingResult,
) -> ToolResult[AircraftGeometry]:
    """Compute parametric Three.js primitive dimensions (in metres) from conceptual sizing.

    TODO (Tharm): Adjust proportions/offsets as needed for the Three.js aircraft scene in `web/`.
    """
    # Raymer Table 6.3 general aviation fuselage length regression (in SI)
    w0_lb = max(sizing.mtow_kg * 2.20462, 500.0)
    fuselage_length_m = 0.3048 * (4.37 * (w0_lb**0.23))
    fuselage_diameter_m = 1.22

    # Wing vertical offset based on wing_position
    z_map = {"high": 0.52, "mid": 0.0, "low": -0.48}
    wing_z_m = z_map.get(spec.wing_position, 0.52)
    wing_x_le_m = 0.32 * fuselage_length_m

    # Tail sizing using Raymer Table 6.4 tail volume coefficients (C_HT = 0.70, C_VT = 0.04)
    tail_arm_m = 0.52 * fuselage_length_m
    c_ht = 0.70
    c_vt = 0.04

    ht_area_m2 = (c_ht * sizing.wing_area_m2 * sizing.mac_m) / max(tail_arm_m, 1.0)
    ht_ar = 4.0
    ht_span_m = math.sqrt(ht_ar * ht_area_m2)
    ht_root_chord_m = (2.0 * ht_area_m2) / (ht_span_m * 1.65)
    ht_tip_chord_m = 0.65 * ht_root_chord_m

    vt_area_m2 = (c_vt * sizing.wing_area_m2 * sizing.span_m) / max(tail_arm_m, 1.0)
    vt_ar = 1.6
    vt_height_m = math.sqrt(vt_ar * vt_area_m2)
    vt_root_chord_m = (2.0 * vt_area_m2) / (vt_height_m * 1.55)
    vt_tip_chord_m = 0.55 * vt_root_chord_m

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
            "Raymer 6ed, Table 6.3 (Fuselage Length Regression)",
            "Raymer 6ed, Table 6.4 (Tail Volume Coefficients C_HT=0.70, C_VT=0.04)",
            "knowledge/tables/aircraft_typical.yaml#ga_single_engine",
        ],
        assumptions=[
            "Tail moment arm = 52% of fuselage length",
            f"Wing configuration: {spec.wing_position} wing",
        ],
        warnings=[],
        provenance={
            "fuselage": Provenance(
                kind="equation",
                source="Raymer 6ed, Table 6.3 (Fuselage Length Regression)",
            ),
            "wing": Provenance(
                kind="equation",
                source="Raymer 6ed, Ch. 4 (Trapezoidal Planform & Dihedral)",
            ),
            "horizontal_tail": Provenance(
                kind="equation",
                source="Raymer 6ed, Table 6.4 (C_HT = 0.70 Tail Volume)",
            ),
            "vertical_tail": Provenance(
                kind="equation",
                source="Raymer 6ed, Table 6.4 (C_VT = 0.04 Tail Volume)",
            ),
            "propeller": Provenance(
                kind="table",
                source="knowledge/tables/aircraft_typical.yaml#ga_single_engine",
            ),
        },
    )
