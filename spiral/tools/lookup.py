"""Knowledge table lookup tool (Owner: Harry).

Contract:
    lookup(table: str, key: str) -> ToolResult[dict[str, Any]]
    search_knowledge(query: str, kinds=None, limit=5, include_disputed=False) -> ToolResult[list[dict]]
"""

from __future__ import annotations

import json
import re
from functools import lru_cache
from pathlib import Path
from typing import Any

from spiral.contract import ToolError, ToolResult

KNOWLEDGE_TABLES_DIR = Path(__file__).resolve().parents[2] / "knowledge" / "tables"
KNOWLEDGE_EXTRACTED_DIR = Path(__file__).resolve().parents[2] / "knowledge" / "extracted"

# Built-in fallback table rows if PyYAML is not yet installed
_FALLBACK_TABLES: dict[str, dict[str, dict[str, Any]]] = {
    "materials": {
        "al_2024_t3": {
            "name": "Aluminium 2024-T3",
            "density_kg_m3": 2780.0,
            "youngs_modulus_pa": 73.1e9,
            "poissons_ratio": 0.33,
            "yield_strength_pa": 345.0e6,
            "ultimate_strength_pa": 483.0e6,
            "shear_strength_pa": 283.0e6,
            "min_cap_thickness_m": 0.0020,
            "min_web_thickness_m": 0.0015,
            "source": "MIL-HDBK-5J / MMPDS-01, Table 3.2.3.0(b)",
            "verified": True,
        },
        "al_7075_t6": {
            "name": "Aluminium 7075-T6",
            "density_kg_m3": 2810.0,
            "youngs_modulus_pa": 71.7e9,
            "poissons_ratio": 0.33,
            "yield_strength_pa": 503.0e6,
            "ultimate_strength_pa": 572.0e6,
            "shear_strength_pa": 331.0e6,
            "min_cap_thickness_m": 0.0020,
            "min_web_thickness_m": 0.0015,
            "source": "MIL-HDBK-5J / MMPDS-01, Table 3.7.4.0(b)",
            "verified": True,
        },
    }
}


def equation(key: str) -> dict[str, Any]:
    """Row `key` of knowledge/equations.yaml (name, latex, source, verified); a stub if missing."""
    try:
        import yaml  # type: ignore

        data = yaml.safe_load((KNOWLEDGE_TABLES_DIR.parent / "equations.yaml").read_text(encoding="utf-8")) or {}
        row = (data.get("equations") or {}).get(key)
    except (ImportError, OSError):
        row = None
    return dict(row) if row else {"name": key, "source": f"knowledge/equations.yaml#{key}", "verified": False}


def lookup(table: str, key: str) -> ToolResult[dict[str, Any]]:
    """Read `knowledge/tables/{table}.yaml` and return `key` with its citation."""
    table_path = KNOWLEDGE_TABLES_DIR / f"{table}.yaml"
    data: dict[str, Any] = {}

    try:
        import yaml  # type: ignore

        if table_path.exists():
            with table_path.open("r", encoding="utf-8") as f:
                data = yaml.safe_load(f) or {}
    except ImportError:
        data = _FALLBACK_TABLES.get(table, {})

    if not data and table in _FALLBACK_TABLES:
        data = _FALLBACK_TABLES[table]

    if key not in data:
        raise ToolError(
            f"Key '{key}' not found in knowledge/tables/{table}.yaml",
            tool_name="lookup",
            recoverable=False,
        )

    row = dict(data[key])
    source = str(row.get("source", f"knowledge/tables/{table}.yaml#{key}"))
    warnings: list[str] = []
    if row.get("verified") is False:
        warnings.append(f"Table entry {table}.yaml#{key} is marked unverified.")

    return ToolResult(
        value=row,
        sources=[source, f"knowledge/tables/{table}.yaml#{key}"],
        assumptions=[],
        warnings=warnings,
    )


# ---------------------------------------------------------------------------
# Retrieval over the extracted textbooks (knowledge/extracted/<book>/knowledge.json, local only)
# ---------------------------------------------------------------------------

_KINDS = ("equations", "tables", "rules_of_thumb", "figures")
_TEXT_FIELDS = ("equation_number", "table_number", "figure_number", "name", "title", "quantity", "value",
                "applies_to", "paraphrase", "applicability", "description", "latex", "notes")


def _tokens(text: str) -> list[str]:
    return re.findall(r"[a-z0-9]+(?:\.[0-9]+)?", text.lower())


@lru_cache(maxsize=1)
def _knowledge_items() -> tuple[dict[str, Any], ...]:
    items: list[dict[str, Any]] = []
    for path in sorted(KNOWLEDGE_EXTRACTED_DIR.glob("*/knowledge.json")):
        kb = json.loads(path.read_text(encoding="utf-8"))
        for kind in _KINDS:
            for item in kb.get(kind, []):
                text = " ".join(str(item.get(f, "")) for f in _TEXT_FIELDS)
                text += " " + " ".join(f"{v.get('symbol', '')} {v.get('meaning', '')}" for v in item.get("variables", []))
                text += " " + " ".join(item.get("columns", [])) + " " + " ".join(" ".join(r) for r in item.get("rows", []))
                items.append({**item, "kind": kind, "book": kb.get("source", path.parent.name), "_tokens": _tokens(text)})
    return tuple(items)


def citation(item: dict[str, Any]) -> str:
    """Human-readable citation for one extracted item, e.g. 'Raymer 2ed, Table 3.1 (p. 13)'."""
    label = {"equations": "Eq.", "tables": "Table", "figures": "Fig."}.get(item.get("kind", ""), "")
    number = item.get("equation_number") or item.get("table_number") or item.get("figure_number") or ""
    what = f"{label} {number}".strip() if number else (item.get("name") or item.get("title") or item.get("quantity") or "")
    return f"{item.get('book', '')}, {what} (p. {item.get('book_page', '?')})"


def search_knowledge(
    query: str,
    kinds: tuple[str, ...] | None = None,
    limit: int = 5,
    include_disputed: bool = False,
) -> ToolResult[list[dict[str, Any]]]:
    """Keyword search over extracted equations, tables, rules of thumb and figures.

    Scores by query-term overlap (exact number matches such as '3.1' count double). Items the critic
    marked disputed or rejected are excluded unless `include_disputed`.
    """
    terms = set(_tokens(query))
    if not terms:
        raise ToolError("Empty knowledge query", tool_name="search_knowledge", recoverable=True)
    items = _knowledge_items()
    if not items:
        raise ToolError(
            "No extracted knowledge found; run scripts/extract_knowledge.py",
            tool_name="search_knowledge",
            recoverable=False,
        )
    scored = []
    for item in items:
        if kinds and item["kind"] not in kinds:
            continue
        if not include_disputed and item.get("status") in ("disputed", "rejected"):
            continue
        toks = item["_tokens"]
        tokset = set(toks)
        score = sum((2.0 if "." in t else 1.0) for t in terms if t in tokset)
        if score:
            scored.append((score / (1.0 + 0.002 * len(toks)), item))
    scored.sort(key=lambda pair: -pair[0])
    hits = [{k: v for k, v in item.items() if k != "_tokens"} for _, item in scored[:limit]]
    return ToolResult(
        value=hits,
        sources=[citation(h) for h in hits],
        warnings=[f"{citation(h)} not yet verified by the critic ({h.get('status')})" for h in hits
                  if h.get("status") not in ("verified", "verified_minor_fix")],
    )

