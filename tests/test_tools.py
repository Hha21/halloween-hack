"""Unit tests for deterministic engineering & FEA tools (Owner: Tharm)."""

from __future__ import annotations

import tempfile
import unittest

from spiral.contract import MissionSpec, ToolError
from spiral.tools import (
    aircraft_geometry,
    build_spar_cad,
    conceptual_sizing,
    lookup,
    run_fea,
    size_spar,
    spar_loads,
)


class TestEngineeringTools(unittest.TestCase):
    def test_lookup_material(self) -> None:
        res = lookup("materials", "al_2024_t3")
        self.assertGreater(res.value["yield_strength_pa"], 300e6)
        self.assertTrue(len(res.sources) > 0)

    def test_conceptual_sizing_and_spar_pipeline(self) -> None:
        spec = MissionSpec()
        sizing_res = conceptual_sizing(spec)
        sizing = sizing_res.value
        self.assertGreater(sizing.mtow_kg, 800.0)
        self.assertLess(sizing.mtow_kg, 1600.0)

        loads_res = spar_loads(
            mtow_kg=sizing.mtow_kg,
            span_m=sizing.span_m,
            root_chord_m=sizing.root_chord_m,
            tip_chord_m=sizing.tip_chord_m,
            n_ult=spec.n_ult,
        )
        loads = loads_res.value
        self.assertGreater(loads.root_moment_nm, 10_000.0)
        self.assertEqual(loads.stations[-1].shear_n, 0.0)

        spar_res = size_spar(
            loads=loads,
            thickness_to_chord=spec.thickness_to_chord,
            material_key=spec.spar_material,
        )
        spar = spar_res.value
        self.assertGreater(spar.mass_both_wings_kg, 10.0)
        self.assertGreaterEqual(spar.safety_margin, -0.05)

        geom_res = aircraft_geometry(spec, sizing)
        self.assertEqual(geom_res.value.wing["span_m"], sizing.span_m)

        with tempfile.TemporaryDirectory() as tmpdir:
            cad_res = build_spar_cad(spar, out_dir=tmpdir)
            fea_res = run_fea(
                spar=spar,
                loads=loads,
                cad=cad_res.value,
                material_key=spec.spar_material,
                out_dir=tmpdir,
            )
            self.assertGreater(fea_res.value.stress_agreement_pct, 80.0)

    def test_extreme_range_raises_tool_error(self) -> None:
        extreme_spec = MissionSpec(range_m=6_000_000.0)
        with self.assertRaises(ToolError):
            conceptual_sizing(extreme_spec)


if __name__ == "__main__":
    unittest.main()
