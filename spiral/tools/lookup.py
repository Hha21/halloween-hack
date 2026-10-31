"""Knowledge table lookup tool (Owner: Tharm).

Contract:
    lookup(table: str, key: str) -> ToolResult[dict[str, Any]]
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from spiral.contract import ToolError, ToolResult

KNOWLEDGE_TABLES_DIR = Path(__file__).resolve().parents[2] / "knowledge" / "tables"

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
