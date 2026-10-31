"""Main landing gear oleo strut sizing (Owner: Tharm).

Contract:
    size_main_landing_gear(
        sizing: ConceptualSizingResult,
    ) -> ToolResult[LandingGearResult]

Raymer 2ed, Ch. 11: stroke from the touchdown energy (Eq. 11.12) with the GA gear load factor
(Table 11.5) and oleo efficiency (Table 11.4), then margin, minimum stroke and oleo length (p. 244),
oleo diameter from the static strut load (Eq. 11.13), and landing load per leg (Eq. 11.14).
Raymer's equations are in ft, in and lb; this tool converts at the boundary and returns SI.
"""

from __future__ import annotations

import math

from spiral.contract import ConceptualSizingResult, LandingGearResult, Provenance, ToolResult
from spiral.tools.lookup import equation, lookup

G = 9.80665
FT = 0.3048
INCH = 0.0254
LBF = 4.448222  # N per lbf
PSI = 6894.757  # Pa per psi
KG_TO_LB = 2.20462


def size_main_landing_gear(sizing: ConceptualSizingResult) -> ToolResult[LandingGearResult]:
    table = lookup("component_loads", "ga_single_engine")
    rows = table.value
    sink_row = rows["landing_sink_speed"]
    ngear_row = rows["gear_load_factor"]
    eta_row = rows["shock_absorber_efficiency"]
    stroke_row = rows["stroke_rules"]
    dia_row = rows["oleo_diameter"]
    share_row = rows["main_gear_load_share"]

    landing_mass_kg = sizing.mtow_kg  # landing at MTOW: conservative
    w_lb = landing_mass_kg * KG_TO_LB
    v_ft_s = float(sink_row["ft_per_s"])
    n_gear = float(ngear_row["n_gear"])
    eta = float(eta_row["oleo_fixed_orifice_min"])
    share = 1.0 - float(share_row["nose_share_most_aft_cg"])
    n_struts = int(share_row["main_struts"])

    # Eq. 11.12 with tire deflection neglected (S_T = 0): longer stroke, conservative. g = 32.2 ft/s^2.
    stroke_req_in = 12.0 * v_ft_s**2 / (2.0 * 32.2 * eta * n_gear)
    stroke_in = max(stroke_req_in + float(stroke_row["margin_in"]), float(stroke_row["minimum_in"]))
    oleo_length_in = float(stroke_row["oleo_length_to_stroke"]) * stroke_in

    # Eq. 11.13: oleo load = main static load (Eq. 11.1) / number of main oleos, in lb -> D in in.
    static_per_strut_lb = w_lb * share / n_struts
    oleo_dia_in = float(dia_row["coefficient"]) * math.sqrt(static_per_strut_lb)

    # Eq. 11.14: F_s = W N_gear / 2 (two gear legs). Eq. 11.8: KE = 0.5 (W/g) V^2.
    landing_per_strut_n = landing_mass_kg * G * n_gear / n_struts
    sink_ms = v_ft_s * FT
    ke_j = 0.5 * landing_mass_kg * sink_ms**2

    result = LandingGearResult(
        landing_mass_kg=round(landing_mass_kg, 2),
        sink_speed_ms=round(sink_ms, 4),
        gear_load_factor=n_gear,
        shock_efficiency=eta,
        main_gear_load_share=round(share, 3),
        main_strut_count=n_struts,
        static_load_per_strut_n=round(static_per_strut_lb * LBF, 1),
        landing_load_per_strut_n=round(landing_per_strut_n, 1),
        vertical_kinetic_energy_j=round(ke_j, 1),
        stroke_required_m=round(stroke_req_in * INCH, 4),
        stroke_m=round(stroke_in * INCH, 4),
        oleo_length_m=round(oleo_length_in * INCH, 4),
        oleo_diameter_m=round(oleo_dia_in * INCH, 4),
        oleo_internal_pressure_pa=round(float(dia_row["internal_pressure_psi"]) * PSI, 0),
    )

    def cite(row: dict, kind: str, what: str) -> Provenance:
        return Provenance(kind, f"{row['source']}: {what}", verified=bool(row.get("verified", False)))

    eq_stroke = equation("shock_absorber_stroke")
    eq_dia = equation("oleo_diameter")
    eq_leg = equation("gear_leg_landing_load")
    eq_ke = equation("vertical_kinetic_energy")
    warnings = list(table.warnings)
    if stroke_req_in + float(stroke_row["margin_in"]) < float(stroke_row["minimum_in"]):
        warnings.append(
            f"Eq. 11.12 stroke + margin ({stroke_req_in + float(stroke_row['margin_in']):.1f} in) is below the "
            f"{stroke_row['minimum_in']:g} in minimum, so the minimum sets the stroke ({stroke_row['source']})"
        )

    return ToolResult(
        value=result,
        sources=[
            eq_stroke["source"],
            eq_dia["source"],
            eq_leg["source"],
            eq_ke["source"],
            str(ngear_row["source"]),
            str(eta_row["source"]),
            str(share_row["source"]),
            "knowledge/tables/component_loads.yaml#ga_single_engine",
        ],
        assumptions=[
            "Landing weight = MTOW (conservative; Raymer uses W_landing)",
            "Tire deflection neglected in Eq. 11.12 (S_T = 0): gives a longer, conservative stroke",
            f"Oleo-pneumatic, fixed orifice, efficiency at the low end of Table 11.4 ({eta:g})",
            "Wing lift = weight during stroke; the FAR-23 two-thirds rule is ignored, as Raymer allows for initial sizing (p. 242)",
            f"Main oleos carry {share:.0%} of the weight: nose share {1 - share:.0%} at the most-aft c.g. (p. 233)",
            "Spin-up, spring-back, braking and side loads not analysed",
        ],
        warnings=warnings,
        provenance={
            "landing_mass_kg": Provenance("assumption", "Landing at MTOW from conceptual sizing (conservative)", verified=False),
            "sink_speed_ms": cite(sink_row, "table", "10 ft/s touchdown vertical velocity"),
            "gear_load_factor": cite(ngear_row, "table", "N_gear = 3, general aviation"),
            "shock_efficiency": cite(eta_row, "table", "oleo-pneumatic fixed orifice, low end 0.65"),
            "main_gear_load_share": cite(share_row, "table", "1 - nose share (8% at most-aft c.g.)"),
            "main_strut_count": cite(share_row, "assumption", "two main-wheel oleos"),
            "static_load_per_strut_n": cite(share_row, "equation", "Eq. 11.1 main static load / number of oleos"),
            "landing_load_per_strut_n": cite(eq_leg, "equation", "F_s = W N_gear / 2"),
            "vertical_kinetic_energy_j": cite(eq_ke, "equation", "KE = 0.5 (W/g) V_vertical^2"),
            "stroke_required_m": cite(eq_stroke, "equation", "S = V^2 / (2 g eta N_gear), S_T = 0"),
            "stroke_m": cite(stroke_row, "equation", "Eq. 11.12 stroke + 1 in, at least 8 in"),
            "oleo_length_m": cite(stroke_row, "equation", "oleo length = 2.5 x stroke"),
            "oleo_diameter_m": cite(eq_dia, "equation", "D = 0.04 sqrt(L_oleo), in and lb"),
            "oleo_internal_pressure_pa": cite(dia_row, "table", "typical oleo pressure 1,800 psi"),
        },
    )
