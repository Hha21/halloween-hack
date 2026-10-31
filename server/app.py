"""FastAPI server implementing the HTTP & SSE contract (Owner: Harry).

Endpoints (consumed by Tharm's `web/api_client.js`):
- POST /api/intake
- POST /api/spiral/run-sync
- POST /api/spiral/stream
- POST /api/components/spar
- POST /api/report
- GET  /artifacts/{filename}
"""

from __future__ import annotations

import json
from dataclasses import asdict
from pathlib import Path
from typing import Any

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from fastapi.staticfiles import StaticFiles

from spiral.agent import (
    generate_report_markdown,
    parse_intake_description,
    run_design_spiral,
    run_spar_detailed_design,
)
from spiral.contract import (
    AircraftGeometry,
    ConceptualSizingResult,
    DesignState,
    MissionSpec,
    SparLoadsResult,
    SparSizingResult,
)

ROOT_DIR = Path(__file__).resolve().parents[1]
ARTIFACTS_DIR = ROOT_DIR / "artifacts"
WEB_DIR = ROOT_DIR / "web"

ARTIFACTS_DIR.mkdir(parents=True, exist_ok=True)

app = FastAPI(title="Spiral Design API", version="0.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.post("/api/intake")
def api_intake(payload: dict[str, Any]) -> dict[str, Any]:
    description = str(payload.get("description", ""))
    res = parse_intake_description(description)
    return {
        "spec": res.value.to_dict(),
        "sources": res.sources,
        "assumptions": res.assumptions,
        "warnings": res.warnings,
    }


@app.post("/api/spiral/run-sync")
def api_spiral_run_sync(payload: dict[str, Any]) -> dict[str, Any]:
    spec_data = payload.get("spec", payload)
    spec = MissionSpec.from_dict(spec_data)
    state = run_design_spiral(spec)
    return state.to_dict()


@app.post("/api/spiral/stream")
def api_spiral_stream(payload: dict[str, Any]) -> StreamingResponse:
    spec_data = payload.get("spec", payload)
    spec = MissionSpec.from_dict(spec_data)
    events: list[tuple[str, dict[str, Any]]] = []

    def record_event(event_type: str, data: dict[str, Any]) -> None:
        serialised = json.loads(json.dumps(data, default=lambda o: asdict(o)))
        events.append((event_type, serialised))

    run_design_spiral(spec, on_event=record_event)

    def event_generator():
        for ev_type, ev_data in events:
            yield f"event: {ev_type}\ndata: {json.dumps(ev_data)}\n\n"

    return StreamingResponse(event_generator(), media_type="text/event-stream")


@app.post("/api/components/spar")
def api_component_spar(payload: dict[str, Any]) -> dict[str, Any]:
    state_dict = payload.get("state", payload)
    spec = MissionSpec.from_dict(state_dict.get("spec", {}))
    state = DesignState(spec=spec)
    if state_dict.get("latest_sizing"):
        state.latest_sizing = ConceptualSizingResult.from_dict(state_dict["latest_sizing"])
    if state_dict.get("latest_loads"):
        state.latest_loads = SparLoadsResult.from_dict(state_dict["latest_loads"])
    if state_dict.get("latest_spar"):
        state.latest_spar = SparSizingResult.from_dict(state_dict["latest_spar"])
    if state_dict.get("latest_geometry"):
        state.latest_geometry = AircraftGeometry.from_dict(state_dict["latest_geometry"])

    if state.latest_spar is None or state.latest_loads is None:
        state = run_design_spiral(spec)

    state = run_spar_detailed_design(state, out_dir=str(ARTIFACTS_DIR))
    return state.to_dict()


@app.post("/api/report")
def api_report(payload: dict[str, Any]) -> dict[str, Any]:
    state_dict = payload.get("state", payload)
    spec = MissionSpec.from_dict(state_dict.get("spec", {}))
    state = run_design_spiral(spec)
    if state.converged:
        state = run_spar_detailed_design(state, out_dir=str(ARTIFACTS_DIR))
    report_md = generate_report_markdown(state)
    return {"report_markdown": report_md, "state": state.to_dict()}


app.mount("/artifacts", StaticFiles(directory=str(ARTIFACTS_DIR)), name="artifacts")
if WEB_DIR.exists():
    app.mount("/", StaticFiles(directory=str(WEB_DIR), html=True), name="web")
