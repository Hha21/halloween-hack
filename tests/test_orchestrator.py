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
        self.assertIsNotNone(state.infeasible_reason)
        self.assertIsNotNone(state.proposed_relaxation)


if __name__ == "__main__":
    unittest.main()
