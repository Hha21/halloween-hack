"""Unit tests for deterministic engineering & FEA tools (Owner: Tharm)."""

from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from dataclasses import replace

from spiral.agent.orchestrator import (
    _numeric_paths,
    run_component_detailed_design,
    run_design_spiral,
    run_spar_detailed_design,
)
from spiral.contract import DesignState, MissionSpec, Provenance, ToolError
from spiral.tools import (
    aircraft_geometry,
    build_spar_cad,
    conceptual_sizing,
    horizontal_tail_spar,
    lookup,
    run_fea,
    size_main_landing_gear,
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

    def test_extreme_range_raises_tool_error(self) -> None:
        extreme_spec = MissionSpec(range_m=6_000_000.0)
        with self.assertRaises(ToolError):
            conceptual_sizing(extreme_spec)


class TestSecondaryComponents(unittest.TestCase):
    """Horizontal tail spar and main landing gear: cited load cases, own provenance, streaming."""

    @classmethod
    def setUpClass(cls) -> None:
        cls.spec = MissionSpec()
        cls.state = run_design_spiral(cls.spec)

    def assert_tool_cites_every_number(self, res) -> None:
        # The tool itself must cite each numeric field; the orchestrator's unverified fill-in doesn't count.
        missing = [p for p in _numeric_paths(res.value) if p not in res.provenance]
        self.assertEqual(missing, [])

    def test_horizontal_tail_load_case(self) -> None:
        sizing, geom = self.state.latest_sizing, self.state.latest_geometry
        res = horizontal_tail_spar(self.spec, sizing, geom)
        tail = res.value
        self.assert_tool_cites_every_number(res)

        # Eqs. 14.12-14.13 by hand, K_p capped at 0.9 for general aviation
        w_lb = sizing.mtow_kg * 2.20462
        kp = min(max(0.15 + 5400.0 / (w_lb + 3300.0), 0.5), 0.9)
        v_p = self.spec.stall_speed_ms + kp * (self.spec.cruise_speed_ms - self.spec.stall_speed_ms)
        self.assertAlmostEqual(tail.kp, kp, places=3)
        self.assertAlmostEqual(tail.maneuver_speed_ms, v_p, places=2)

        # P = |C_n| q S (p. 347), C_n = -0.55 governs
        self.assertEqual(tail.normal_force_coefficient, -0.55)
        expected = 0.55 * 0.5 * 1.225 * v_p**2 * tail.tail_area_m2
        self.assertAlmostEqual(tail.limit_tail_load_n, expected, delta=0.5)
        self.assertAlmostEqual(tail.ultimate_tail_load_n, 1.5 * tail.limit_tail_load_n, delta=0.5)
        # Each half-span cantilever carries half the tail load
        self.assertAlmostEqual(tail.loads.root_shear_n, tail.ultimate_tail_load_n / 2.0, delta=0.01 * tail.ultimate_tail_load_n)
        self.assertEqual(tail.loads.stations[-1].shear_n, 0.0)
        self.assertGreaterEqual(tail.spar.safety_margin, 0.0)
        self.assertTrue(any("Table 4.3" in w for w in res.warnings) or 0.3 <= geom.horizontal_tail["tip_chord_m"] / geom.horizontal_tail["root_chord_m"] <= 0.6)

    def test_landing_gear_hand_worked_case(self) -> None:
        sizing = replace(self.state.latest_sizing, mtow_kg=1000.0)
        res = size_main_landing_gear(sizing)
        gear = res.value
        self.assert_tool_cites_every_number(res)
        # W = 2,204.62 lb, V = 10 ft/s, eta = 0.65, N_gear = 3
        stroke_in = 12.0 * 10.0**2 / (2.0 * 32.2 * 0.65 * 3.0)  # Eq. 11.12: 9.556 in
        self.assertAlmostEqual(gear.stroke_required_m, stroke_in * 0.0254, places=4)
        self.assertAlmostEqual(gear.stroke_m, (stroke_in + 1.0) * 0.0254, places=4)  # + 1 in, above 8 in minimum
        self.assertAlmostEqual(gear.oleo_length_m, 2.5 * gear.stroke_m, places=3)
        oleo_load_lb = 1000.0 * 2.20462 * 0.92 / 2.0  # Eq. 11.1 / 2 oleos
        self.assertAlmostEqual(gear.oleo_diameter_m, 0.04 * oleo_load_lb**0.5 * 0.0254, places=4)  # Eq. 11.13
        self.assertAlmostEqual(gear.landing_load_per_strut_n, 1000.0 * 9.80665 * 3.0 / 2.0, delta=0.1)  # Eq. 11.14

    def test_component_streams_and_artifacts(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            state = run_design_spiral(self.spec)
            state = run_spar_detailed_design(state, out_dir=tmp)
            for cid, steps in (("horizontal_tail", ["loads", "cad", "fea"]), ("main_landing_gear", ["sizing"])):
                events: list[tuple[str, object]] = []
                state = run_component_detailed_design(state, cid, out_dir=tmp, on_event=lambda t, p: events.append((t, p)))
                self.assertEqual([p.step for t, p in events if t == "component_step"], [s for s in steps for _ in (0, 1)])
                self.assertEqual(events[-1][0], "component_done")
                self.assertEqual(state.components[cid].status, "completed")
            tail = state.components["horizontal_tail"]
            self.assertIn("components.horizontal_tail.horizontal_tail.maneuver_speed_ms", state.provenance)
            self.assertIn("components.main_landing_gear.landing_gear.stroke_m", state.provenance)
            # The tail writes its own files; the wing spar's downloads survive
            self.assertEqual(Path(tail.cad.step_path).name, "tail_spar.step")
            self.assertTrue((Path(tmp) / "spar.step").exists())
            self.assertTrue((Path(tmp) / "tail_spar_stress_mesh.json").exists())
            again = DesignState.from_dict(json.loads(json.dumps(state.to_dict())))
            self.assertEqual(again.components["main_landing_gear"].landing_gear.stroke_m, state.components["main_landing_gear"].landing_gear.stroke_m)

    def test_uncited_components_stay_coming_soon(self) -> None:
        for cid in ("engine_mount", "fuselage_frames"):
            comp = self.state.components[cid]
            self.assertFalse(comp.available)
            self.assertTrue(comp.unavailable_reason)
            with self.assertRaises(ToolError):
                run_component_detailed_design(self.state, cid)


if __name__ == "__main__":
    unittest.main()
