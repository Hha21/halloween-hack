"""FastAPI server implementing the HTTP & SSE contract (Owner: Harry).

Endpoints (consumed by Tharm's `web/api_client.js`; payload types in spiral/contract.py §7):
- POST /api/intake                  IntakeRequest  -> IntakeResponse
- POST /api/spiral/run-sync         SpiralRequest  -> DesignState
- POST /api/spiral/stream           SpiralRequest  -> SSE
- POST /api/components/spar         StateRequest   -> DesignState
- POST /api/components/spar/stream  StateRequest   -> SSE
- POST /api/components/{id}         StateRequest   -> DesignState
- POST /api/components/{id}/stream  StateRequest   -> SSE
- POST /api/report                  StateRequest   -> ReportResponse
- GET  /artifacts/{filename}
"""

from __future__ import annotations

import asyncio
import queue
import threading
from pathlib import Path
from typing import Any, Callable

from fastapi import Body, FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from fastapi.staticfiles import StaticFiles

from spiral.agent import (
    generate_report_markdown,
    parse_intake_description,
    run_component_detailed_design,
    run_design_spiral,
    run_spar_detailed_design,
)
from spiral.contract import (
    DesignState,
    ErrorEvent,
    IntakeResponse,
    MissionSpec,
    ReportResponse,
    ToolError,
    format_sse,
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


def _spec_from(payload: dict[str, Any]) -> MissionSpec:
    return MissionSpec.from_dict(payload.get("spec", payload))


def _state_from(payload: dict[str, Any]) -> DesignState:
    state = DesignState.from_dict(payload.get("state", payload))
    if state.latest_spar is None or state.latest_loads is None:
        state = run_design_spiral(state.spec)
    return state


def _sse(run: Callable[[Callable[[str, Any], None]], Any]) -> StreamingResponse:
    """Run `run(emit)` in a worker thread and stream each emitted event as it happens."""
    frames: queue.Queue[str | None] = queue.Queue()

    def worker() -> None:
        try:
            run(lambda event_type, payload: frames.put(format_sse(event_type, payload)))
        except ToolError as exc:
            frames.put(format_sse("error", ErrorEvent(message=exc.message, tool_error=exc.to_dict())))
        except Exception as exc:  # noqa: BLE001 - surface every failure to the UI
            frames.put(format_sse("error", ErrorEvent(message=str(exc))))
        finally:
            frames.put(None)

    threading.Thread(target=worker, daemon=True).start()

    def stream():
        while (frame := frames.get()) is not None:
            yield frame

    return StreamingResponse(stream(), media_type="text/event-stream")


@app.post("/api/intake")
def api_intake(payload: dict[str, Any]) -> dict[str, Any]:
    res = parse_intake_description(str(payload.get("description", "")))
    return IntakeResponse(
        spec=res.value,
        sources=res.sources,
        assumptions=res.assumptions,
        warnings=res.warnings,
    ).to_dict()


_LAST_STATE: DesignState | None = None  # most recent converged spiral state (default for the airframe agent)


def _remember(state: DesignState) -> DesignState:
    global _LAST_STATE
    if getattr(state, "converged", False):
        _LAST_STATE = state
    return state


@app.post("/api/spiral/run-sync")
def api_spiral_run_sync(payload: dict[str, Any]) -> dict[str, Any]:
    return _remember(run_design_spiral(_spec_from(payload))).to_dict()


@app.post("/api/spiral/stream")
def api_spiral_stream(payload: dict[str, Any]) -> StreamingResponse:
    spec = _spec_from(payload)
    return _sse(lambda emit: _remember(run_design_spiral(spec, on_event=emit)))


@app.post("/api/components/spar")
def api_component_spar(payload: dict[str, Any]) -> dict[str, Any]:
    state = run_spar_detailed_design(_state_from(payload), out_dir=str(ARTIFACTS_DIR))
    return state.to_dict()


@app.post("/api/components/spar/stream")
def api_component_spar_stream(payload: dict[str, Any]) -> StreamingResponse:
    state = _state_from(payload)
    return _sse(lambda emit: run_spar_detailed_design(state, out_dir=str(ARTIFACTS_DIR), on_event=emit))


@app.post("/api/components/airframe")
async def api_component_airframe(payload: dict[str, Any] | None = Body(default=None)) -> dict[str, Any]:
    """Gemini 4 Argon designs the 3D airframe in Blender, verified against the design dimensions."""
    from spiral.agent.blender_agent import build_airframe

    def run() -> dict[str, Any]:
        raw = (payload or {}).get("state")
        if raw:
            state = DesignState.from_dict(raw)
            if state.latest_geometry is None or state.latest_sizing is None:
                state = run_design_spiral(state.spec)
        else:
            state = _LAST_STATE or run_design_spiral(MissionSpec())
        return build_airframe(state, out_dir=str(ARTIFACTS_DIR))

    return await asyncio.to_thread(run)


@app.post("/api/ask")
def api_ask(payload: dict[str, Any]) -> dict[str, Any]:
    """Ask the textbook: {question} -> {answer_markdown, citations, source}. Answers cite critic-checked Raymer items."""
    from spiral.agent.gemini import answer_textbook_question

    return answer_textbook_question(str(payload.get("question", "")))


@app.post("/api/components/{component_id}")
def api_component(component_id: str, payload: dict[str, Any]) -> dict[str, Any]:
    state = run_component_detailed_design(_state_from(payload), component_id, out_dir=str(ARTIFACTS_DIR))
    return state.to_dict()


@app.post("/api/components/{component_id}/stream")
def api_component_stream(component_id: str, payload: dict[str, Any]) -> StreamingResponse:
    state = _state_from(payload)
    return _sse(lambda emit: run_component_detailed_design(state, component_id, out_dir=str(ARTIFACTS_DIR), on_event=emit))


@app.post("/api/report")
def api_report(payload: dict[str, Any]) -> dict[str, Any]:
    state = DesignState.from_dict(payload.get("state", payload))
    report_md = generate_report_markdown(state)
    return ReportResponse(report_markdown=report_md, state=state).to_dict()


app.mount("/artifacts", StaticFiles(directory=str(ARTIFACTS_DIR)), name="artifacts")
if WEB_DIR.exists():
    app.mount("/", StaticFiles(directory=str(WEB_DIR), html=True), name="web")
