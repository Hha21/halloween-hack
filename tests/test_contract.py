"""Contract tests: JSON round trips and fixtures still match spiral/contract.py (Shared)."""

from __future__ import annotations

import json
import os
import tempfile
import unittest
from pathlib import Path

os.environ["SPIRAL_OFFLINE"] = "1"  # tests never call Gemini

from spiral.agent import run_design_spiral, run_spar_detailed_design
from spiral.contract import (
    SSE_EVENTS,
    DesignState,
    IntakeResponse,
    MissionSpec,
    ReportResponse,
    format_sse,
)

FIXTURES = Path(__file__).resolve().parents[1] / "fixtures"


def parse_sse(text: str) -> list[tuple[str, dict]]:
    events = []
    for frame in text.strip().split("\n\n"):
        event_line, data_line = frame.split("\n", 1)
        events.append((event_line.removeprefix("event: "), json.loads(data_line.removeprefix("data: "))))
    return events


class TestRoundTrip(unittest.TestCase):
    def test_design_state_survives_json(self) -> None:
        state = run_design_spiral(MissionSpec())
        with tempfile.TemporaryDirectory() as tmpdir:
            state = run_spar_detailed_design(state, out_dir=tmpdir)
        back = DesignState.from_dict(json.loads(json.dumps(state.to_dict())))
        self.assertEqual(back, state)

    def test_sse_frames_parse_into_their_event_types(self) -> None:
        frames: list[str] = []
        run_design_spiral(MissionSpec(), on_event=lambda t, p: frames.append(format_sse(t, p)))
        events = parse_sse("".join(frames))
        self.assertEqual(events[-1][0], "converged")
        for event_type, data in events:
            self.assertEqual(SSE_EVENTS[event_type].from_dict(data).to_dict(), data)


class TestFixtures(unittest.TestCase):
    """If these fail, run `python3 scripts/generate_fixtures.py`."""

    def _load(self, name: str) -> dict:
        return json.loads((FIXTURES / name).read_text(encoding="utf-8"))

    def test_json_fixtures_match_contract(self) -> None:
        for name, cls in [
            ("intake_response.json", IntakeResponse),
            ("design_state_converged.json", DesignState),
            ("design_state_detailed.json", DesignState),
            ("report_response.json", ReportResponse),
        ]:
            with self.subTest(name=name):
                data = self._load(name)
                self.assertEqual(cls.from_dict(data).to_dict(), data)

    def test_sse_fixtures_end_with_terminal_event(self) -> None:
        for name, terminal in [
            ("spiral_stream.sse", "converged"),
            ("spiral_stream_infeasible.sse", "infeasible"),
            ("component_spar_stream.sse", "component_done"),
        ]:
            with self.subTest(name=name):
                events = parse_sse((FIXTURES / name).read_text(encoding="utf-8"))
                self.assertEqual(events[-1][0], terminal)
                for event_type, data in events:
                    self.assertEqual(SSE_EVENTS[event_type].from_dict(data).to_dict(), data)


if __name__ == "__main__":
    unittest.main()
