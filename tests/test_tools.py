"""Unit tests for deterministic engineering & FEA tools (Owner: Tharm)."""

from __future__ import annotations

import json
import math
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
        for key in (
            "fuselage.length_m",
            "fuselage.diameter_m",
            "wing.span_m",
            "horizontal_tail.span_m",
            "vertical_tail.height_m",
            "propeller.diameter_m",
        ):
            self.assertIn(key, geom_res.provenance)
            self.assertIsInstance(geom_res.provenance[key], Provenance)

        with tempfile.TemporaryDirectory() as tmpdir:
            cad_res = build_spar_cad(spar, out_dir=tmpdir)
            for key in (
                "step_path",
                "stl_path",
                "volume_single_wing_m3",
                "cad_mass_both_wings_kg",
                "bounding_box_m.x_width_m",
                "bounding_box_m.y_semi_span_m",
                "bounding_box_m.z_depth_m",
            ):
                self.assertIn(key, cad_res.provenance)
                self.assertIsInstance(cad_res.provenance[key], Provenance)

            step_text = Path(cad_res.value.step_path).read_text(encoding="utf-8")
            stl_bytes = Path(cad_res.value.stl_path).read_bytes()
            self.assertIn("ISO-10303-21;", step_text)
            self.assertTrue(
                stl_bytes.startswith(b"solid") or len(stl_bytes) >= 84,
                "STL file must either be valid ASCII starting with 'solid' or binary >= 84 bytes",
            )
            self.assertGreater(len(step_text), 500)
            self.assertGreater(len(stl_bytes), 500)

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
        self.assertIn("latest_geometry.wing.span_m", state.provenance)
        self.assertIn("latest_geometry.fuselage.length_m", state.provenance)
        self.assertTrue(state.provenance["latest_geometry.fuselage.length_m"].verified)

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

    def test_components_fea_all_parts_and_offline_optimiser(self) -> None:
        state = run_design_spiral(MissionSpec())
        events: list[tuple[str, str, str]] = []
        with tempfile.TemporaryDirectory() as tmpdir:
            cad = build_spar_cad(state.latest_spar, out_dir=tmpdir).value
            fea_res = run_fea(
                state.latest_spar, state.latest_loads, cad, out_dir=tmpdir,
                progress=lambda cid, step, status: events.append((cid, step, status)),
            )
            self.assertEqual(fea_res.value.solver_name, "Timoshenko beam FEA (NumPy direct stiffness)")
            mesh = json.loads(Path(str(fea_res.value.stress_mesh_path)).read_text(encoding="utf-8"))

        comps = mesh["components_fea"]
        expected = ["main_wing_spar", "wing_skin_box", "horizontal_tail", "fuselage_frames", "main_landing_gear", "engine_mount"]
        self.assertEqual(sorted(comps), sorted(expected))
        for cid in expected:
            c = comps[cid]
            self.assertNotIn("error", c, cid)
            m = c["baseline"]["metrics"]
            for key in ("peak_vm_pa", "margin", "mass_kg", "max_deflection_m"):
                self.assertTrue(math.isfinite(m[key]), f"{cid}.{key}")
            self.assertGreater(m["mass_kg"], 0.0)
            self.assertTrue(c["baseline"]["members"][0]["stations"], cid)
            # Minimise mass: never heavier unless the baseline is below the target margin, never below +0.10
            opt = c["optimized"]["min_mass"]
            self.assertGreaterEqual(opt["variant"]["metrics"]["margin"], 0.10 - 1e-6, cid)
            if m["margin"] >= 0.10:
                self.assertLessEqual(opt["variant"]["metrics"]["mass_kg"], m["mass_kg"] + 1e-6, cid)

        # Under pytest the optimiser never calls the network
        self.assertEqual(mesh["ai_optimization"]["source"], "deterministic_fallback")
        self.assertIn("pytest", mesh["ai_optimization"]["status"])
        # Progress events: every part solved, the agent skipped offline, then solver verification
        done = [cid for cid, step, status in events if step == "solve" and status == "done"]
        self.assertEqual(sorted(done), sorted(expected))
        self.assertIn(("optimiser", "agent", "skipped"), events)
        self.assertEqual(events[-1], ("optimiser", "verify", "done"))

    def test_extreme_range_raises_tool_error(self) -> None:
        extreme_spec = MissionSpec(range_m=6_000_000.0)
        with self.assertRaises(ToolError):
            conceptual_sizing(extreme_spec)


if __name__ == "__main__":
    unittest.main()
