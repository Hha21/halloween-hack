# Spiral: Escaping the Aircraft Design Spiral

Describe the aircraft you need in plain English. An agent turns it into a structured specification, runs conceptual and preliminary design until the weight closes, and carries the main wing spar all the way to 3D CAD and FEA verification — with every number traceable to a source.

See [DESIGN_SPEC.md](DESIGN_SPEC.md) for the full architecture and explicit contract.

## Work Split

| | **Harry (NL → Multi-Agent, RAG & Sizing Parameters)** | **Tharm (Agent Outputs → 3D CAD, FEA & Frontend)** |
|---|---|---|
| **Folders & Files** | `spiral/agent/`, `server/`, `scripts/`, `knowledge/`, `spiral/tools/lookup.py`, `spiral/tools/sizing.py`, `spiral/tools/spar.py`, `tests/test_orchestrator.py` | `web/`, `spiral/tools/cad.py`, `spiral/tools/fea.py`, `spiral/tools/geometry.py`, `artifacts/`, `tests/test_tools.py` |
| **Shared** | `spiral/contract.py` (frozen dataclasses + HTTP/SSE schemas), `fixtures/` (example payloads) | `spiral/contract.py`, `fixtures/` |

## Quickstart

```bash
# 1. Run contract & stub unit tests (zero external dependencies required)
python3 -m unittest discover -s tests -v

# 2. Install server / tool dependencies
pip install -r requirements.txt

# 3. Start the FastAPI server + frontend on http://localhost:8000
uvicorn server.app:app --reload --port 8000

# 4. After changing spiral/contract.py, regenerate the example payloads in fixtures/
python3 scripts/generate_fixtures.py
```
