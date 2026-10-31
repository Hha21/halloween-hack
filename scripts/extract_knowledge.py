"""Textbook knowledge extraction: Gemini extracts, a second model critiques (Owner: Harry).

Three stages, each resumable (finished chunks are skipped on re-run):

    python scripts/extract_knowledge.py extract    # flash model reads page images -> items
    python scripts/extract_knowledge.py critique   # pro model checks every item against the same pages
    python scripts/extract_knowledge.py merge      # one knowledge.json with a status per item
    python scripts/extract_knowledge.py check      # do knowledge/*.yaml citations match the book? (--write sets verified)

Add `--pages 14-17` to limit to a PDF page range. Models: EXTRACT_MODEL / CRITIC_MODEL env vars.

The book is a scan, so Gemini gets the pages themselves (as small PDF chunks), not the OCR text,
which garbles equations. Everything written here goes to knowledge/extracted/<slug>/, which is
gitignored: never commit it. Only curated numbers + citations in knowledge/*.yaml are committed.
"""

from __future__ import annotations

import argparse
import concurrent.futures as cf
import io
import json
import os
import random
import re
import sys
import time
from pathlib import Path
from typing import Any

ROOT_DIR = Path(__file__).resolve().parents[1]
EXTRACTED_DIR = ROOT_DIR / "knowledge" / "extracted"
DEFAULT_PDF = ROOT_DIR / "books" / "Aircraft design : a conceptual approach.pdf"
DEFAULT_SLUG = "raymer_2ed"
DEFAULT_CITATION = "Raymer, Aircraft Design: A Conceptual Approach, 2nd ed. (AIAA, 1992)"
DEFAULT_SHORT = "Raymer 2ed"  # what citations in the UI say
PAGES_PER_CHUNK = 2  # each PDF page is a scanned two-page spread

try:
    from dotenv import load_dotenv

    load_dotenv(ROOT_DIR / ".env")
except ImportError:
    pass

EXTRACT_MODEL = os.environ.get("EXTRACT_MODEL", "gemini-3.5-flash")
CRITIC_MODEL = os.environ.get("CRITIC_MODEL", "gemini-3.1-pro-preview")

# ---------------------------------------------------------------------------
# Schemas
# ---------------------------------------------------------------------------

_S = {"type": "string"}
_I = {"type": "integer"}


def _obj(props: dict[str, Any]) -> dict[str, Any]:
    return {"type": "object", "properties": props, "required": list(props)}


def _arr(item: dict[str, Any]) -> dict[str, Any]:
    return {"type": "array", "items": item}


EXTRACT_SCHEMA = _obj(
    {
        "pages": _arr(_obj({"book_page": _I, "chapter": _S, "section": _S})),
        "equations": _arr(
            _obj(
                {
                    "book_page": _I,
                    "equation_number": {**_S, "description": "As printed, e.g. '3.4'; empty if unnumbered."},
                    "name": {**_S, "description": "Short descriptive name, e.g. 'Breguet range (propeller)'."},
                    "latex": {**_S, "description": "The equation in LaTeX, same symbols as printed."},
                    "variables": _arr(_obj({"symbol": _S, "meaning": _S, "units": _S})),
                    "unit_system": {**_S, "description": "Units the equation assumes, e.g. 'W in lb, V in ft/s'; 'consistent' if any."},
                    "applicability": {**_S, "description": "When to use it, aircraft class, limits."},
                }
            )
        ),
        "tables": _arr(
            _obj(
                {
                    "book_page": _I,
                    "table_number": {**_S, "description": "As printed, e.g. '3.1'."},
                    "title": _S,
                    "columns": _arr(_S),
                    "rows": _arr(_arr(_S)),
                    "notes": _S,
                }
            )
        ),
        "rules_of_thumb": _arr(
            _obj(
                {
                    "book_page": _I,
                    "quantity": {**_S, "description": "What the number is, e.g. 'aspect ratio'."},
                    "value": {**_S, "description": "Number or range as printed, e.g. '6-8'."},
                    "units": _S,
                    "applies_to": {**_S, "description": "Aircraft class or condition."},
                    "paraphrase": {**_S, "description": "One sentence in your own words."},
                }
            )
        ),
        "figures": _arr(
            _obj(
                {
                    "book_page": _I,
                    "figure_number": _S,
                    "description": {**_S, "description": "One line: what it shows; for charts, what is plotted against what."},
                }
            )
        ),
    }
)

KINDS = ("equations", "tables", "rules_of_thumb", "figures")

CRITIC_SCHEMA = _obj(
    {
        "reviews": _arr(
            _obj(
                {
                    "kind": {"type": "string", "enum": list(KINDS)},
                    "index": {**_I, "description": "0-based index of the item within its kind."},
                    "verdict": {"type": "string", "enum": ["correct", "minor_error", "major_error", "not_on_pages"]},
                    "problem": {**_S, "description": "What is wrong; empty if correct."},
                    "correction": {**_S, "description": "Corrected LaTeX / value / rows as JSON text; empty if correct."},
                }
            )
        ),
        "missed": _arr(
            _obj(
                {
                    "kind": {"type": "string", "enum": list(KINDS)},
                    "book_page": _I,
                    "description": {**_S, "description": "Number and what it is, e.g. 'Eq. 3.11, loiter fraction'."},
                }
            )
        ),
    }
)

EXTRACT_PROMPT = """You are building a citation-grade knowledge base from a scanned aircraft design textbook ({citation}).
The attached PDF is PDF pages {first}-{last}. Each PDF page is a scanned two-page spread, so it shows two printed book pages.
Use the page numbers printed on the pages for every `book_page`.

Extract, from these pages only:
- equations: every displayed equation, numbered or not, in LaTeX with the same symbols as printed; its printed number; every variable with meaning and units; the unit system it assumes (many of this book's equations assume imperial units); and when it applies.
- tables: every table, with its number, title, column headers and all rows. Copy numbers exactly as printed.
- rules_of_thumb: every quantitative typical value or design guideline stated in the text, with value, units and what it applies to, paraphrased in one sentence of your own words.
- figures: every figure number with a one-line description.
- pages: for each printed book page, its chapter and section.

Never invent anything that is not on these pages. If a value is unreadable, write "unreadable" rather than guessing.
Paraphrase; do not copy long passages of text. Front matter, blank pages and the index give empty lists."""

CRITIC_PROMPT = """You are a meticulous aerospace engineering reviewer checking an automated extraction from a scanned textbook ({citation}).
The attached PDF is PDF pages {first}-{last} (two printed book pages per PDF page). Below is what another model extracted from them.

Check every item against the pages:
- equations: is the LaTeX mathematically identical to the printed equation (symbols, exponents, constants, signs)? Are equation number, book page, variable meanings, units and unit system right?
- tables: are the numbers, column headers, table number and book page exactly right?
- rules_of_thumb: is the value as printed, and does the paraphrase match what the book says?
- figures: right number and page?

Return exactly one review per extracted item (kind + 0-based index within that kind). Use:
- correct: no errors.
- minor_error: a wrong page, name, variable meaning or formatting; the engineering content is right. Give the correction.
- major_error: a wrong number, exponent, sign, constant or unit system that would change a calculation. Give the correction.
- not_on_pages: the item is not on these pages (hallucinated).
Then list important equations or tables the extraction missed.

Extraction:
{extraction}"""


# ---------------------------------------------------------------------------
# Gemini
# ---------------------------------------------------------------------------


def _client():
    from google import genai
    from google.genai import types

    return genai.Client(
        api_key=os.environ["GEMINI_API_KEY"].strip(),
        http_options=types.HttpOptions(timeout=300_000),
    )


def _call(model: str, pdf_bytes: bytes, prompt: str, schema: dict[str, Any]) -> tuple[dict[str, Any], dict[str, int]]:
    from google.genai import types
    from google.genai.errors import ClientError

    client = _client()
    last: Exception | None = None
    for attempt in range(6):
        try:
            response = client.models.generate_content(
                model=model,
                contents=[types.Part.from_bytes(data=pdf_bytes, mime_type="application/pdf"), prompt],
                config=types.GenerateContentConfig(
                    response_mime_type="application/json",
                    response_json_schema=schema,
                    max_output_tokens=60_000,
                ),
            )
            data = json.loads(response.text or "")
            usage = response.usage_metadata
            return data, {
                "input_tokens": getattr(usage, "prompt_token_count", 0) or 0,
                "output_tokens": (getattr(usage, "candidates_token_count", 0) or 0)
                + (getattr(usage, "thoughts_token_count", 0) or 0),
            }
        except ClientError as exc:  # 4xx: retry only rate limits
            last = exc
            if getattr(exc, "code", None) != 429:
                raise
        except Exception as exc:  # noqa: BLE001 - 5xx, timeouts, truncated JSON: retry
            last = exc
        time.sleep(min(60.0, 2.0**attempt) + random.random())
    raise RuntimeError(f"{model} failed after retries: {last}")


# ---------------------------------------------------------------------------
# Chunks
# ---------------------------------------------------------------------------


def _chunks(pdf: Path, page_range: tuple[int, int] | None) -> list[tuple[int, int, bytes]]:
    """(first, last, pdf_bytes) per chunk, 1-based inclusive PDF page numbers."""
    from pypdf import PdfReader, PdfWriter

    reader = PdfReader(str(pdf))
    n = len(reader.pages)
    lo, hi = page_range or (1, n)
    lo = (lo - 1) // PAGES_PER_CHUNK * PAGES_PER_CHUNK + 1  # snap to the full-book chunk grid
    out = []
    for first in range(lo, min(hi, n) + 1, PAGES_PER_CHUNK):
        last = min(first + PAGES_PER_CHUNK - 1, n)
        writer = PdfWriter()
        for i in range(first - 1, last):
            writer.add_page(reader.pages[i])
        buf = io.BytesIO()
        writer.write(buf)
        out.append((first, last, buf.getvalue()))
    return out


def _chunk_name(first: int, last: int) -> str:
    return f"p{first:04d}-{last:04d}"


def _run_parallel(jobs: list, fn, workers: int, label: str) -> None:
    if not jobs:
        print(f"{label}: nothing to do")
        return
    t0, done, failed, tokens = time.time(), 0, 0, [0, 0]
    with cf.ThreadPoolExecutor(max_workers=workers) as pool:
        futures = {pool.submit(fn, job): job for job in jobs}
        for fut in cf.as_completed(futures):
            first, last = futures[fut][0], futures[fut][1]
            try:
                usage = fut.result()
                done += 1
                tokens[0] += usage["input_tokens"]
                tokens[1] += usage["output_tokens"]
            except Exception as exc:  # noqa: BLE001
                failed += 1
                print(f"  FAILED {_chunk_name(first, last)}: {type(exc).__name__}: {str(exc)[:160]}", flush=True)
            if (done + failed) % 10 == 0 or done + failed == len(jobs):
                print(
                    f"{label}: {done + failed}/{len(jobs)} chunks ({failed} failed), {time.time() - t0:.0f}s, "
                    f"tokens in/out {tokens[0]:,}/{tokens[1]:,}",
                    flush=True,
                )


# ---------------------------------------------------------------------------
# Stages
# ---------------------------------------------------------------------------


def extract(pdf: Path, out: Path, citation: str, page_range, workers: int) -> None:
    out.mkdir(parents=True, exist_ok=True)
    jobs = [c for c in _chunks(pdf, page_range) if not (out / f"{_chunk_name(c[0], c[1])}.extract.json").exists()]

    def work(job):
        first, last, data = job
        prompt = EXTRACT_PROMPT.format(citation=citation, first=first, last=last)
        result, usage = _call(EXTRACT_MODEL, data, prompt, EXTRACT_SCHEMA)
        result["_meta"] = {"pdf_pages": [first, last], "model": EXTRACT_MODEL, **usage}
        (out / f"{_chunk_name(first, last)}.extract.json").write_text(json.dumps(result, indent=1), encoding="utf-8")
        return usage

    print(f"extract with {EXTRACT_MODEL}: {len(jobs)} chunks, {workers} workers", flush=True)
    _run_parallel(jobs, work, workers, "extract")


def critique(pdf: Path, out: Path, citation: str, page_range, workers: int) -> None:
    jobs = []
    for c in _chunks(pdf, page_range):
        name = _chunk_name(c[0], c[1])
        ext = out / f"{name}.extract.json"
        if ext.exists() and not (out / f"{name}.critic.json").exists():
            jobs.append(c)

    def work(job):
        first, last, data = job
        name = _chunk_name(first, last)
        extraction = json.loads((out / f"{name}.extract.json").read_text(encoding="utf-8"))
        extraction.pop("_meta", None)
        if not any(extraction.get(k) for k in KINDS):
            result, usage = {"reviews": [], "missed": []}, {"input_tokens": 0, "output_tokens": 0}
        else:
            prompt = CRITIC_PROMPT.format(
                citation=citation, first=first, last=last, extraction=json.dumps({k: extraction.get(k, []) for k in KINDS}, indent=1)
            )
            result, usage = _call(CRITIC_MODEL, data, prompt, CRITIC_SCHEMA)
        result["_meta"] = {"pdf_pages": [first, last], "model": CRITIC_MODEL, **usage}
        (out / f"{name}.critic.json").write_text(json.dumps(result, indent=1), encoding="utf-8")
        return usage

    print(f"critique with {CRITIC_MODEL}: {len(jobs)} chunks, {workers} workers", flush=True)
    _run_parallel(jobs, work, workers, "critique")


STATUS = {"correct": "verified", "minor_error": "verified_minor_fix", "major_error": "disputed", "not_on_pages": "rejected"}


def merge(out: Path, citation: str, short: str) -> None:
    kb: dict[str, Any] = {"source": short, "source_full": citation, **{k: [] for k in KINDS}, "missed": [], "pages": []}
    counts: dict[str, dict[str, int]] = {k: {} for k in KINDS}
    for ext_path in sorted(out.glob("*.extract.json")):
        name = ext_path.name.removesuffix(".extract.json")
        ext = json.loads(ext_path.read_text(encoding="utf-8"))
        crit_path = out / f"{name}.critic.json"
        crit = json.loads(crit_path.read_text(encoding="utf-8")) if crit_path.exists() else None
        reviews = {(r.get("kind"), r.get("index")): r for r in (crit or {}).get("reviews", [])}
        pdf_pages = ext.get("_meta", {}).get("pdf_pages")
        kb["pages"].extend({**p, "pdf_pages": pdf_pages} for p in ext.get("pages", []))
        for kind in KINDS:
            for i, item in enumerate(ext.get(kind, [])):
                review = reviews.get((kind, i))
                if crit is None:
                    status = "unreviewed"
                elif review is None:
                    status = "unreviewed"
                else:
                    status = STATUS.get(review.get("verdict"), "unreviewed")
                entry = {
                    "id": f"{name}:{kind}:{i}",
                    **item,
                    "pdf_pages": pdf_pages,
                    "status": status,
                }
                if review and review.get("verdict") != "correct":
                    entry["critic"] = {k: review.get(k, "") for k in ("verdict", "problem", "correction")}
                kb[kind].append(entry)
                counts[kind][status] = counts[kind].get(status, 0) + 1
        kb["missed"].extend({**m, "pdf_pages": pdf_pages} for m in (crit or {}).get("missed", []))

    (out / "knowledge.json").write_text(json.dumps(kb, indent=1), encoding="utf-8")
    print(f"wrote {out / 'knowledge.json'}")
    for kind in KINDS:
        total = sum(counts[kind].values())
        print(f"  {kind:15s} {total:5d}  " + "  ".join(f"{s}={n}" for s, n in sorted(counts[kind].items())))
    print(f"  missed (critic) {len(kb['missed']):5d}")


# ---------------------------------------------------------------------------
# Citation check: do the curated YAML rows match what the book (as extracted + critiqued) says?
# ---------------------------------------------------------------------------

KNOWLEDGE_DIR = ROOT_DIR / "knowledge"
_REF = re.compile(r"(Table|Eqs?\.|Fig\.)\s*([\d.]+)")
_PAGE = re.compile(r"\(pp?\.\s*(\d+)")
_NUM = re.compile(r"-?\d*\.?\d+")
_SKIP_KEYS = {"min_valid", "max_valid", "verified"}
_OK = ("verified", "verified_minor_fix")


def _numbers(item: dict[str, Any]) -> set[float]:
    text = json.dumps({k: v for k, v in item.items() if k not in ("critic", "pdf_pages", "id", "status")})
    text = text.replace("\u2212", "-")
    nums = set()
    for m in _NUM.findall(text):
        try:
            nums.add(round(float(m), 6))
        except ValueError:
            pass
    return nums


def _row_values(row: dict[str, Any]) -> list[float]:
    return [float(v) for k, v in row.items() if k not in _SKIP_KEYS and isinstance(v, (int, float)) and not isinstance(v, bool)]


def _candidates(kb: dict[str, Any], source: str) -> list[dict[str, Any]]:
    page_m = _PAGE.search(source)
    page = int(page_m.group(1)) if page_m else None
    ref = _REF.search(source)
    out = []
    for kind in KINDS:
        for item in kb.get(kind, []):
            if ref:
                label, number = ref.group(1), ref.group(2).rstrip(".")
                key = {"Table": "table_number", "Fig.": "figure_number"}.get(label, "equation_number")
                if str(item.get(key, "")).strip() != number:
                    continue
            elif page is None or item.get("book_page") != page:
                continue
            out.append(item)
    return out


def check(out: Path, write: bool) -> None:
    """Report, per curated YAML row citing the book, whether the book backs every number in it."""
    import yaml

    kb = json.loads((out / "knowledge.json").read_text(encoding="utf-8"))
    short = kb.get("source", DEFAULT_SHORT)
    results: dict[Path, dict[str, bool]] = {}
    for path in sorted([*KNOWLEDGE_DIR.glob("tables/*.yaml"), KNOWLEDGE_DIR / "equations.yaml"]):
        rows: list[dict[str, Any]] = []

        def walk(node: Any) -> None:
            if isinstance(node, dict):
                if "source" in node:
                    rows.append(node)
                for v in node.values():
                    walk(v)

        walk(yaml.safe_load(path.read_text(encoding="utf-8")))
        for row in rows:
            source = str(row["source"])
            if short not in source or source.startswith("Derived"):
                continue  # derived results are ours, not printed in the book: never auto-verified
            cands = _candidates(kb, source)
            values = _row_values(row)
            backed = [c for c in cands if c.get("status") in _OK]
            found = {v: any(round(v, 6) in _numbers(c) or round(v * 100, 6) in _numbers(c) for c in backed) for v in values}
            ok = bool(backed) and all(found.values())
            results.setdefault(path, {})[source] = ok
            missing = [f"{v:g}" for v, hit in found.items() if not hit]
            statuses = sorted({c.get("status", "?") for c in cands}) or ["not found"]
            print(f"{'OK  ' if ok else 'FAIL'} {path.relative_to(ROOT_DIR)} :: {source}")
            print(f"       items={len(cands)} status={statuses} values={[f'{v:g}' for v in values]}"
                  + (f" missing={missing}" if missing else ""))

    if write:
        for path, by_source in results.items():
            lines = path.read_text(encoding="utf-8").splitlines(keepends=True)
            pending: bool | None = None
            for i, line in enumerate(lines):
                m = re.search(r'source:\s*"(.*)"', line)
                if m:
                    pending = by_source.get(m.group(1))
                elif pending is not None and re.match(r"\s*verified:", line):
                    indent = line[: len(line) - len(line.lstrip())]
                    lines[i] = f"{indent}verified: {'true' if pending else 'false'}\n"
                    pending = None
            path.write_text("".join(lines), encoding="utf-8")
        print("updated verified flags")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("stage", choices=["extract", "critique", "merge", "check", "all"])
    parser.add_argument("--pdf", type=Path, default=DEFAULT_PDF)
    parser.add_argument("--slug", default=DEFAULT_SLUG)
    parser.add_argument("--citation", default=DEFAULT_CITATION)
    parser.add_argument("--short", default=DEFAULT_SHORT)
    parser.add_argument("--pages", help="PDF page range, e.g. 14-17")
    parser.add_argument("--workers", type=int, default=12)
    parser.add_argument("--write", action="store_true", help="check: set verified flags in the YAML")
    args = parser.parse_args()

    page_range = tuple(int(x) for x in args.pages.split("-")) if args.pages else None
    out = EXTRACTED_DIR / args.slug
    if args.stage in ("extract", "all"):
        extract(args.pdf, out, args.citation, page_range, args.workers)
    if args.stage in ("critique", "all"):
        critique(args.pdf, out, args.citation, page_range, args.workers)
    if args.stage in ("merge", "all"):
        merge(out, args.citation, args.short)
    if args.stage == "check":
        check(out, args.write)


if __name__ == "__main__":
    main()
