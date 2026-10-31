"""Design the airframe in Blender with Gemini 4 Argon, verify it, and copy the result into docs/blender/.

    .venv/bin/python scripts/blender_build.py                          # default MissionSpec()
    .venv/bin/python scripts/blender_build.py --range 5570000 --passengers 1   # London relaxed design
"""

from __future__ import annotations

import argparse
import json
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from spiral.agent import run_design_spiral  # noqa: E402
from spiral.agent.blender_agent import build_airframe  # noqa: E402
from spiral.contract import MissionSpec  # noqa: E402


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--range", type=float, help="range in metres (e.g. 5570000 for the London design)")
    ap.add_argument("--passengers", type=int, help="passenger count")
    args = ap.parse_args()

    import dataclasses

    spec = MissionSpec()
    if args.range is not None:
        spec = dataclasses.replace(spec, range_m=args.range)
    if args.passengers is not None:
        spec = dataclasses.replace(spec, passenger_count=args.passengers)
    state = run_design_spiral(spec)
    print(f"spiral: converged={state.converged} span={state.latest_sizing.span_m} m", flush=True)

    result = build_airframe(state, out_dir=str(ROOT / "artifacts"))
    print(json.dumps(result, indent=2))

    if result["status"] == "ok":
        docs = ROOT / "docs" / "blender"
        docs.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(ROOT / "artifacts" / "airframe.png", docs / "airframe.png")
        shutil.copyfile(ROOT / "artifacts" / "airframe.py", docs / "airframe.py")
        print(f"copied to {docs / 'airframe.png'} and {docs / 'airframe.py'}")
        return 0
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
