"""Report tests: computed sections, the "no new numbers" check and the Gemini retry/fallback (Owner: Harry).

No network: Gemini is replaced by canned answers via `unittest.mock`.
"""

from __future__ import annotations

import copy
import os
import tempfile
import unittest
from unittest import mock

os.environ["SPIRAL_OFFLINE"] = "1"  # tests never call Gemini

from spiral.agent import gemini, run_design_spiral, run_spar_detailed_design  # noqa: E402
from spiral.agent.gemini import (  # noqa: E402
    REPORT_WARNING_PREFIX,
    _deterministic_report,
    generate_report_markdown,
    report_number_problems,
)
from spiral.contract import DesignState, MissionSpec  # noqa: E402

INFEASIBLE_RANGE_M = 5_570_000.0  # London to New York non-stop (demo twist)


def _converged_state() -> DesignState:
    state = run_design_spiral(MissionSpec())
    with tempfile.TemporaryDirectory() as tmpdir:
        return run_spar_detailed_design(state, out_dir=tmpdir)


class ReportTestCase(unittest.TestCase):
    converged: DesignState
    infeasible: DesignState

    @classmethod
    def setUpClass(cls) -> None:
        cls.converged = _converged_state()
        cls.infeasible = run_design_spiral(MissionSpec(range_m=INFEASIBLE_RANGE_M))

    def setUp(self) -> None:
        self.state = copy.deepcopy(self.converged)

    def clean_narrative(self, state: DesignState) -> dict[str, str]:
        s, p = state.latest_sizing, state.latest_spar
        return {
            "executive_summary": (
                f"The spiral converged after {len(state.history)} laps at an MTOW of {s.mtow_kg:,.1f} kg, "
                f"with a {p.mass_both_wings_kg:.1f} kg spar at margin {p.safety_margin:+.2f}."
            ),
            "design_drivers": f"Range of {state.spec.range_m / 1000:,.0f} km sets {s.fuel_mass_kg:.1f} kg of fuel "
            "(Raymer 2ed, Eq. 3.4, p. 12).",
            "trade_offs": f"Peak bending stress is {p.max_bending_stress_pa / 1e6:.1f} MPa.",
            "infeasibility": "",
        }


class TestOfflineReport(ReportTestCase):
    def test_converged_report_has_every_computed_section(self) -> None:
        report = generate_report_markdown(self.state)
        self.assertEqual(self.state.report_markdown, report)
        self.assertIn("Converged after **", report)
        for heading in (
            "## Mission & configuration",
            "## Convergence history",
            "## Mass breakdown",
            "## Main wing spar (beam theory)",
            "## FEA vs beam theory",
            "## Sources",
            "## Assumptions",
            "## Warnings",
        ):
            self.assertIn(heading, report)
        lap_rows = [
            line for line in report.splitlines() if line.startswith("| ") and line.split("|")[1].strip().isdigit()
        ]
        self.assertEqual(len(lap_rows), len(self.state.history))
        self.assertIn(f"{self.state.latest_sizing.mtow_kg:,.1f} kg", report)
        self.assertNotIn("## Summary", report)  # no Gemini narrative offline
        self.assertFalse(any(w.startswith(REPORT_WARNING_PREFIX) for w in self.state.warnings))

    def test_infeasible_report_explains_reason_and_relaxation(self) -> None:
        state = copy.deepcopy(self.infeasible)
        self.assertFalse(state.converged)
        rel = state.proposed_relaxation
        self.assertIsNotNone(rel)
        report = generate_report_markdown(state)
        self.assertIn("Infeasible", report)
        self.assertIn("## Why the design does not close", report)
        self.assertIn(state.infeasible_reason, report)
        self.assertIn("## Proposed relaxation", report)
        self.assertIn(f"{rel.new_value / 1000:,.0f} km", report)
        self.assertNotIn("## FEA vs beam theory", report)


class TestNumberCheck(ReportTestCase):
    def test_deterministic_report_numbers_all_trace_to_state(self) -> None:
        for state in (self.state, copy.deepcopy(self.infeasible)):
            self.assertEqual(report_number_problems(_deterministic_report(state), state), [])

    def test_clean_narrative_and_display_conversions_pass(self) -> None:
        s, p = self.state.latest_sizing, self.state.latest_spar
        fea = self.state.components["main_wing_spar"].fea
        text = " ".join(self.clean_narrative(self.state).values()) + (
            f" That is about {s.mtow_kg / 1000:.1f} t, a {s.span_m:.2f} m span ({round(s.span_m, 2) * 1000:,.0f} mm), "
            f"{s.installed_power_w / 1000:.0f} kW installed, an empty fraction of {s.empty_fraction * 100:.1f}% "
            f"and {p.tip_deflection_m:.2f} m of tip deflection at {self.state.spec.n_ult:.2f} g; FEA agrees to "
            f"{fea.stress_agreement_pct:.1f}% (Raymer 2ed, Table 3.1, p. 13; 2nd ed.; Eqs. 3.6 & 3.10, pp. 17-18)."
        )
        self.assertEqual(report_number_problems(text, self.state), [])

    def test_invented_number_is_caught(self) -> None:
        self.assertNotAlmostEqual(self.state.latest_sizing.mtow_kg, 1500.0, delta=50.0)
        problems = report_number_problems("The aircraft closes at an MTOW of 1,500 kg.", self.state)
        self.assertEqual(len(problems), 1)
        self.assertTrue(problems[0].startswith("1,500"))
        self.assertTrue(report_number_problems("Peak stress is 400 MPa.", self.state))
        self.assertTrue(report_number_problems("About fifteen hundred kilograms.", self.state))

    def test_infeasible_numbers(self) -> None:
        state = copy.deepcopy(self.infeasible)
        rel = state.proposed_relaxation
        ok = (
            f"Cutting range from {rel.old_value / 1000:,.0f} km to {rel.new_value / 1000:,.0f} km closes at "
            f"{rel.estimated_mtow_kg:,.0f} kg, versus {state.latest_sizing.mtow_kg:,.0f} kg now."
        )
        self.assertEqual(report_number_problems(ok, state), [])
        self.assertTrue(report_number_problems("A 3,000 km range would close at 2,100 kg.", state))


class TestGeminiRetryAndFallback(ReportTestCase):
    def run_with(self, answers: list) -> tuple[str, mock.MagicMock]:
        with mock.patch.object(gemini, "gemini_unavailable_reason", return_value=None), mock.patch.object(
            gemini, "_generate_json", side_effect=answers
        ) as fake:
            return generate_report_markdown(self.state), fake

    def bad_narrative(self) -> dict[str, str]:
        bad = self.clean_narrative(self.state)
        bad["executive_summary"] = "The spiral converged at an MTOW of 1,500 kg."
        return bad

    def test_retry_uses_clean_second_answer(self) -> None:
        good = self.clean_narrative(self.state)
        report, fake = self.run_with([self.bad_narrative(), good])
        self.assertEqual(fake.call_count, 2)
        retry_prompt = fake.call_args_list[1].args[1]
        self.assertIn("1,500", retry_prompt)  # Gemini is told which number was rejected
        self.assertIn("## Summary", report)
        self.assertIn(good["executive_summary"], report)
        self.assertIn(good["design_drivers"], report)
        self.assertNotIn("1,500 kg", report)
        self.assertEqual(self.state.report_markdown, report)
        self.assertFalse(any(w.startswith(REPORT_WARNING_PREFIX) for w in self.state.warnings))

    def test_two_bad_answers_fall_back_with_warning(self) -> None:
        report, fake = self.run_with([self.bad_narrative(), self.bad_narrative()])
        self.assertEqual(fake.call_count, 2)
        self.assertNotIn("## Summary", report)
        self.assertNotIn("MTOW of 1,500 kg", report)
        warnings = [w for w in self.state.warnings if w.startswith(REPORT_WARNING_PREFIX)]
        self.assertEqual(len(warnings), 1)
        self.assertIn("1,500", warnings[0])
        self.assertIn(warnings[0], report)  # the reader sees why there is no narrative
        self.assertIn("## Convergence history", report)

    def test_gemini_error_falls_back_and_never_raises(self) -> None:
        report, fake = self.run_with([RuntimeError("quota exceeded")])
        self.assertEqual(fake.call_count, 1)
        self.assertIn("## Mass breakdown", report)
        report_warnings = [w for w in self.state.warnings if w.startswith(REPORT_WARNING_PREFIX)]
        self.assertTrue(any("RuntimeError" in w for w in report_warnings))

    def test_repeat_calls_do_not_pile_up_warnings(self) -> None:
        self.run_with([RuntimeError("one")])
        self.run_with([RuntimeError("two")])
        warnings = [w for w in self.state.warnings if w.startswith(REPORT_WARNING_PREFIX)]
        self.assertEqual(len(warnings), 1)
        self.assertIn("two", warnings[0])


if __name__ == "__main__":
    unittest.main()
