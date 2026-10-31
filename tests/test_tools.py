"""Unit tests for deterministic engineering & FEA tools (Owner: Tharm)."""

from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from spiral.agent.orchestrator import run_design_spiral, run_spar_detailed_design
from spiral.contract import MissionSpec, Provenance, ToolError
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
        for key in ("fuselage", "wing", "horizontal_tail", "vertical_tail", "propeller"):
            self.assertIn(key, geom_res.provenance)
            self.assertIsInstance(geom_res.provenance[key], Provenance)

        with tempfile.TemporaryDirectory() as tmpdir:
            cad_res = build_spar_cad(spar, out_dir=tmpdir)
            for key in (
                "step_path",
                "stl_path",
                "volume_single_wing_m3",
                "cad_mass_both_wings_kg",
                "bounding_box_m",
            ):
                self.assertIn(key, cad_res.provenance)
                self.assertIsInstance(cad_res.provenance[key], Provenance)

            step_text = Path(cad_res.value.step_path).read_text(encoding="utf-8")
            stl_text = Path(cad_res.value.stl_path).read_text(encoding="utf-8")
            self.assertIn("ISO-10303-21;", step_text)
            self.assertIn("solid spar_ibeam", stl_text)
            self.assertGreater(len(step_text), 500)
            self.assertGreater(len(stl_text), 500)

            mass_diff_pct = (
                abs(cad_res.value.cad_mass_both_wings_kg - spar.mass_both_wings_kg)
                / spar.mass_both_wings_kg
                * 100.0
            )
            self.assertLess(mass_diff_pct, 2.0)

            fea_res = run_fea(
                spar=spar,
                loads=loads,
                cad=cad_res.value,
                material_key=spec.spar_material,
                out_dir=tmpdir,
            )
            for key in (
                "solver_name",
                "fea_max_von_mises_pa",
                "fea_tip_deflection_m",
                "beam_max_stress_pa",
                "beam_tip_deflection_m",
                "stress_agreement_pct",
                "deflection_agreement_pct",
                "safety_margin_fea",
                "stress_mesh_path",
            ):
                self.assertIn(key, fea_res.provenance)
                self.assertIsInstance(fea_res.provenance[key], Provenance)

            self.assertGreater(fea_res.value.stress_agreement_pct, 85.0)
            self.assertGreater(fea_res.value.deflection_agreement_pct, 90.0)

            self.assertIsNotNone(fea_res.value.stress_mesh_path)
            mesh_payload = json.loads(
                Path(str(fea_res.value.stress_mesh_path)).read_text(encoding="utf-8")
            )
            self.assertIn("stations", mesh_payload)
            self.assertIn("rings_3d", mesh_payload)
            self.assertEqual(len(mesh_payload["stations"]), len(spar.stations))
            self.assertEqual(len(mesh_payload["rings_3d"]), len(spar.stations))
            for ring in mesh_payload["rings_3d"]:
                self.assertEqual(len(ring["vertices_xyz_m"]), 12)
                self.assertEqual(len(ring["vertex_von_mises_pa"]), 12)
                self.assertGreaterEqual(ring["max_von_mises_pa"], 0.0)

    def test_orchestrator_merges_geometry_cad_and_fea_provenance(self) -> None:
        spec = MissionSpec()
        state = run_design_spiral(spec)
        self.assertTrue(state.converged)
        self.assertIn("latest_geometry.wing", state.provenance)
        self.assertIn("latest_geometry.fuselage", state.provenance)

        with tempfile.TemporaryDirectory() as tmpdir:
            state = run_spar_detailed_design(state, out_dir=tmpdir)
            self.assertIn(
                "components.main_wing_spar.cad.cad_mass_both_wings_kg",
                state.provenance,
            )
            self.assertIn(
                "components.main_wing_spar.cad.step_path",
                state.provenance,
            )
            self.assertIn(
                "components.main_wing_spar.fea.fea_max_von_mises_pa",
                state.provenance,
            )
            self.assertIn(
                "components.main_wing_spar.fea.safety_margin_fea",
                state.provenance,
            )

    def test_extreme_range_raises_tool_error(self) -> None:
        extreme_spec = MissionSpec(range_m=6_000_000.0)
        with self.assertRaises(ToolError):
            conceptual_sizing(extreme_spec)


if __name__ == "__main__":
    unittest.main()
