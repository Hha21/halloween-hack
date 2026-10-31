"""Record real runs from the live server for the static demo mode (Owner: Harry).

    python scripts/record_demo.py   # server must be running on :8000 (live Gemini)

Writes web/demo/: one intake, spiral stream, detailed-spar stream and report per scenario, a few
"ask the textbook" answers, the CAD/FEA artifacts per scenario, and manifest.json. web/static-demo.js
replays them when there is no backend (GitHub Pages, a plain static server, or ?demo).

Copyright: extracted book content never goes into these committed files. The report's
"Textbook items" section is cut, and ask citations keep only the citation, its status and page.
"""

from __future__ import annotations

import json
import re
import shutil
from pathlib import Path

import httpx

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "web" / "demo"
BASE = "http://localhost:8000"
PROMPTS = {
    "touring": "Four-seat touring aircraft, 1,000 km range with 45 min reserve, cruise 115 kt, stall under 55 kt.",
    "london": "Four-seat tourer, London to New York non-stop, 5,570 km range, 45 min reserve, cruise 115 kt, stall under 55 kt.",
    "high_ar": "High-aspect-ratio aerial survey aircraft, 1,200 km range, AR 13.5 slender wing, 7075-T6 aluminium spar.",
}
QUESTIONS = [
    ("tail volume", "What tail volume coefficients suit a GA single?"),
    ("wing loading", "What wing loading is typical for a general aviation single engine?"),
    ("reserve", "How much reserve fuel should I allow?"),
]

client = httpx.Client(base_url=BASE, timeout=240)


def sse(path: str, body: dict) -> str:
    with client.stream("POST", path, json=body) as r:
        r.raise_for_status()
        return "".join(r.iter_text())


def last_event(text: str) -> tuple[str, dict]:
    frame = text.strip().split("\n\n")[-1]
    ev, data = frame.split("\n", 1)
    return ev.removeprefix("event: "), json.loads(data.removeprefix("data: "))


def relocate_artifacts(text: str, scenario: str) -> str:
    return text.replace('"/artifacts/', f'"./demo/artifacts/{scenario}/')


def strip_book_text(report: dict) -> dict:
    md = report.get("report_markdown", "")
    start = md.find("## Textbook items behind the numbers")
    if start >= 0:
        end = md.find("## Sources", start)
        md = md[:start] + (md[end:] if end >= 0 else "")
    report["report_markdown"] = md
    if isinstance(report.get("state"), dict):
        report["state"]["report_markdown"] = md
    return report


def save(name: str, content: str | dict) -> str:
    path = OUT / name
    path.write_text(content if isinstance(content, str) else json.dumps(content), encoding="utf-8")
    return name


def record(scenario: str, spec: dict, intake: dict | None) -> dict:
    files: dict[str, str] = {}
    if intake is not None:
        files["intake"] = save(f"intake_{scenario}.json", intake)
    stream = sse("/api/spiral/stream", {"spec": spec})
    files["spiral"] = save(f"spiral_{scenario}.sse", stream)
    kind, payload = last_event(stream)
    state = payload["state"]
    files["spiral_sync"] = save(f"state_{scenario}.json", state)
    print(f"  {scenario}: spiral -> {kind}, laps {[round(h['mtow_kg']) for h in state['history']]}")

    spar = sse("/api/components/spar/stream", {"state": state})
    art = OUT / "artifacts" / scenario
    art.mkdir(parents=True, exist_ok=True)
    for f in ("spar.step", "spar.stl", "spar_stress_mesh.json"):
        if (ROOT / "artifacts" / f).exists():
            shutil.copy(ROOT / "artifacts" / f, art / f)
    spar = relocate_artifacts(spar, scenario)
    files["spar"] = save(f"spar_{scenario}.sse", spar)
    _, done = last_event(spar)
    detailed = done["state"]
    files["spar_sync"] = save(f"state_detailed_{scenario}.json", detailed)

    report = client.post("/api/report", json={"state": detailed}).json()
    files["report"] = save(f"report_{scenario}.json", relocate_artifacts(json.dumps(strip_book_text(report)), scenario))
    return {"files": files, "proposal": payload.get("proposed_relaxation")}


def main() -> None:
    if OUT.exists():
        shutil.rmtree(OUT)
    OUT.mkdir(parents=True)
    scenarios: dict[str, dict] = {}

    for scenario, prompt in PROMPTS.items():
        intake = client.post("/api/intake", json={"description": prompt}).json()
        result = record(scenario, intake["spec"], intake)
        scenarios[scenario] = result["files"]
        if scenario == "london" and result["proposal"]:
            p = result["proposal"]
            relaxed = dict(intake["spec"])
            relaxed[p["field_name"]] = p["new_value"]
            relaxed.get("defaulted_fields", {}).pop(p["field_name"], None)
            print(f"  london proposal: {p['field_name']} {p['old_value']} -> {p['new_value']}")
            scenarios["london_relaxed"] = record("london_relaxed", relaxed, None)["files"]

    asks = []
    for i, (match, question) in enumerate(QUESTIONS, 1):
        answer = client.post("/api/ask", json={"question": question}).json()
        keep = ("n", "citation", "status", "kind", "book_page", "name", "title", "quantity")
        answer["citations"] = [{k: c[k] for k in keep if k in c} for c in answer.get("citations", [])]
        asks.append({"match": match, "question": question, "file": save(f"ask_{i}.json", answer)})

    manifest = {
        "recorded_from": "live server + Gemini (gemini-3.5-flash); see scripts/record_demo.py",
        "scenarios": scenarios,
        "ask": asks,
        "rules": {
            "intake": "description contains 'London' or 'New York' -> london; '13.5' or 'survey' -> high_ar; else touring",
            "spiral/spar/report": "range_m >= 5e6 and passenger_count <= 1 -> london_relaxed; range_m >= 5e6 -> london; aspect_ratio >= 13 -> high_ar; else touring",
        },
    }
    save("manifest.json", json.dumps(manifest, indent=1))
    total = sum(f.stat().st_size for f in OUT.rglob("*") if f.is_file())
    print(f"wrote {OUT} ({total / 1e6:.1f} MB)")


if __name__ == "__main__":
    main()
