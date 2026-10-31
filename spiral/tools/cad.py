"""Detailed CAD generation for the main wing spar (Owner: Tharm).

Contract:
    build_spar_cad(
        spar: SparSizingResult,
        out_dir: str = "artifacts",
    ) -> ToolResult[SparCadResult]
"""

from __future__ import annotations

from pathlib import Path

from spiral.contract import SparCadResult, SparSizingResult, ToolResult
from spiral.tools.lookup import lookup


def build_spar_cad(
    spar: SparSizingResult,
    out_dir: str = "artifacts",
) -> ToolResult[SparCadResult]:
    """Placeholder/stub for CadQuery tapered I-beam STEP + STL generation.

    TODO (Tharm): Implement CadQuery lofted I-section export (with automatic ASCII STL fallback).
    """
    out_path = Path(out_dir)
    out_path.mkdir(parents=True, exist_ok=True)

    step_file = out_path / "spar.step"
    stl_file = out_path / "spar.stl"

    # Write lightweight placeholder STEP & STL files so artifact links work out of the box
    step_file.write_text(
        "ISO-10303-21;\n/* Placeholder STEP file for Main Wing Spar (Tharm to replace with CadQuery) */\nEND-ISO-10303-21;\n",
        encoding="utf-8",
    )
    stl_file.write_text(
        "solid main_wing_spar\nendsolid main_wing_spar\n",
        encoding="utf-8",
    )

    mat = lookup("materials", spar.material_key).value
    rho = float(mat["density_kg_m3"])
    semi_span_m = spar.stations[-1].y_m if spar.stations else 5.0
    volume_single_wing_m3 = spar.semi_span_mass_kg / rho if rho > 0 else 0.005

    result = SparCadResult(
        step_path=f"{out_dir}/spar.step",
        stl_path=f"{out_dir}/spar.stl",
        volume_single_wing_m3=round(volume_single_wing_m3, 6),
        cad_mass_both_wings_kg=round(spar.mass_both_wings_kg, 2),
        bounding_box_m={
            "x_width_m": spar.root_cap_width_m,
            "y_semi_span_m": round(semi_span_m, 3),
            "z_depth_m": spar.root_depth_m,
        },
    )

    return ToolResult(
        value=result,
        sources=["CadQuery 3D Parametric I-Section Loft Generator (spiral.tools.cad)"],
        assumptions=["Symmetric left/right main wing spars; root clamped face at y = 0 m"],
        warnings=["Using placeholder STEP/STL geometry until CadQuery loft is enabled."],
    )
