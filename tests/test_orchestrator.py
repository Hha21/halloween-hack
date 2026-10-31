"""End-to-end orchestrator tests against the frozen contract (Owner: Harry)."""

from __future__ import annotations

import os
import tempfile
import unittest

os.environ["SPIRAL_OFFLINE"] = "1"  # tests never call Gemini

from spiral.agent import (
    generate_report_markdown,
    parse_intake_description,
    run_design_spiral,
    run_spar_detailed_design,
)
from spiral.agent.orchestrator import mtow_class_limit
from spiral.contract import MissionSpec


class TestOrchestrator(unittest.TestCase):
    def test_default_mission_converges_and_runs_detailed_spar(self) -> None:
        intake = parse_intake_description(
            "Four-seat touring aircraft, 1,000 km range with 45 min reserve, cruise 115 kt, stall under 55 kt."
        )
        state = run_design_spiral(intake.value)
        self.assertTrue(state.converged)
        self.assertGreaterEqual(len(state.history), 2)

        with tempfile.TemporaryDirectory() as tmpdir:
            state = run_spar_detailed_design(state, out_dir=tmpdir)
            comp = state.components["main_wing_spar"]
            self.assertEqual(comp.status, "completed")
            self.assertIsNotNone(comp.fea)

        report = generate_report_markdown(state)
        self.assertIn("Converged", report)

    def test_infeasible_mission_proposes_relaxation(self) -> None:
        spec = MissionSpec(range_m=5_500_000.0)
        state = run_design_spiral(spec)
        self.assertFalse(state.converged)
        self.assertIn("limit", state.infeasible_reason or "")
        self.assertGreaterEqual(len(state.history), 2)  # the plot shows it settling above the limit

        proposal = state.proposed_relaxation
        self.assertIsNotNone(proposal)
        self.assertEqual(proposal.field_name, "range_m")
        self.assertLess(proposal.new_value, spec.range_m)

        # The proposal's numbers must be real: the spiral closes there, at the quoted MTOW.
        relaxed = run_design_spiral(MissionSpec(range_m=proposal.new_value))
        limit_kg, _ = mtow_class_limit()
        self.assertTrue(relaxed.converged)
        self.assertAlmostEqual(relaxed.latest_sizing.mtow_kg, proposal.estimated_mtow_kg, places=1)
        self.assertLessEqual(relaxed.latest_sizing.mtow_kg, limit_kg)
        # ...and 10 km further does not.
        self.assertFalse(run_design_spiral(MissionSpec(range_m=proposal.new_value + 10_000.0)).converged)

    def test_relaxation_options_are_real_and_include_keeping_the_range(self) -> None:
        # London to New York: dropping to 1 passenger keeps the range and closes under the class limit.
        from spiral.agent.orchestrator import relaxation_candidates

        spec = MissionSpec(range_m=5_570_000.0)
        options = {c.field_name: c for c in relaxation_candidates(spec)}
        self.assertEqual(set(options), {"range_m", "passenger_count"})
        limit_kg, _ = mtow_class_limit()
        for c in options.values():
            kwargs = {"range_m": c.new_value} if c.field_name == "range_m" else {"range_m": spec.range_m, "passenger_count": int(c.new_value)}
            relaxed = run_design_spiral(MissionSpec(**kwargs), propose_relaxation=False)
            self.assertTrue(relaxed.converged, c.field_name)
            self.assertLessEqual(relaxed.latest_sizing.mtow_kg, limit_kg)
            self.assertAlmostEqual(relaxed.latest_sizing.mtow_kg, c.estimated_mtow_kg, places=1)
        self.assertEqual(options["passenger_count"].new_value, 1.0)
        # Offline, the smallest change is proposed and the other is named as the alternative.
        proposal = run_design_spiral(spec).proposed_relaxation
        self.assertEqual(proposal.field_name, "range_m")
        self.assertIn("Alternative: carry 1 passenger", proposal.reasoning)

    def test_sized_spar_never_has_a_negative_margin(self) -> None:
        # Thin, high-aspect-ratio wing: thick caps on a shallow spar used to give margin -0.10.
        for spec in (MissionSpec(), MissionSpec(range_m=1_200_000.0, aspect_ratio=13.5, spar_material="al_7075_t6")):
            spar = run_design_spiral(spec).latest_spar
            self.assertGreaterEqual(spar.safety_margin, -1e-6)
            for station in spar.stations:
                self.assertLessEqual(station.bending_stress_pa, spar.allowable_yield_stress_pa * (1 + 1e-6))

    def test_closure_has_no_false_failures(self) -> None:
        # 4,000 km used to fail on the solver's starting guess; it closes (Raymer Eq. 3.4).
        state = run_design_spiral(MissionSpec(range_m=4_000_000.0))
        self.assertTrue(state.converged)


if __name__ == "__main__":
    unittest.main()
