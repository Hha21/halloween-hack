"""Regenerate fixtures/: one real example of every contract payload (Owner: Harry).

The frontend can be built against these files with no backend running. Run after any change
to spiral/contract.py or the tools:

    python3 scripts/generate_fixtures.py
"""

from __future__ import annotations

import json
import os
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
os.environ.setdefault("SPIRAL_OFFLINE", "1")  # deterministic fixtures; SPIRAL_OFFLINE=0 uses Gemini

from spiral.agent import (  # noqa: E402
    generate_report_markdown,
    parse_intake_description,
    run_design_spiral,
    run_spar_detailed_design,
)
from spiral.contract import IntakeResponse, MissionSpec, ReportResponse, format_sse  # noqa: E402

FIXTURES = ROOT / "fixtures"
EXAMPLE = "Four-seat touring aircraft, 1,000 km range with 45 min reserve, cruise 115 kt, stall under 55 kt."
INFEASIBLE_RANGE_M = 5_570_000.0  # London to New York non-stop (demo twist)


def _write_json(name: str, payload: object) -> None:
    data = payload.to_dict() if hasattr(payload, "to_dict") else payload
    (FIXTURES / name).write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")


def _record_sse(frames: list[str]):
    return lambda event_type, payload: frames.append(format_sse(event_type, payload))


def main() -> None:
    os.chdir(ROOT)  # tools write to the relative "artifacts" dir, as the server does
    FIXTURES.mkdir(exist_ok=True)

    intake = parse_intake_description(EXAMPLE)
    _write_json(
        "intake_response.json",
        IntakeResponse(spec=intake.value, sources=intake.sources, assumptions=intake.assumptions, warnings=intake.warnings),
    )

    frames: list[str] = []
    state = run_design_spiral(intake.value, on_event=_record_sse(frames))
    (FIXTURES / "spiral_stream.sse").write_text("".join(frames), encoding="utf-8")
    _write_json("design_state_converged.json", state)

    frames = []
    state = run_spar_detailed_design(state, out_dir="artifacts", on_event=_record_sse(frames))
    (FIXTURES / "component_spar_stream.sse").write_text("".join(frames), encoding="utf-8")
    _write_json("design_state_detailed.json", state)
    mesh_path = state.components["main_wing_spar"].fea.stress_mesh_path
    if mesh_path:
        shutil.copyfile(mesh_path, FIXTURES / "spar_stress_mesh.json")

    report = generate_report_markdown(state)
    _write_json("report_response.json", ReportResponse(report_markdown=report, state=state))

    frames = []
    run_design_spiral(MissionSpec(range_m=INFEASIBLE_RANGE_M), on_event=_record_sse(frames))
    (FIXTURES / "spiral_stream_infeasible.sse").write_text("".join(frames), encoding="utf-8")

    for f in sorted(FIXTURES.iterdir()):
        print(f"  {f.relative_to(ROOT)}  ({f.stat().st_size // 1024} KB)")


if __name__ == "__main__":
    main()
