"""Book knowledge extraction pipeline (Owner: Harry).

Splits textbook PDFs in `books/` into page chunks, queries Gemini for equations,
tables, and qualitative heuristics with page citations, and writes draft JSON to
`knowledge/extracted/` (gitignored).
"""

from __future__ import annotations

import json
from pathlib import Path

ROOT_DIR = Path(__file__).resolve().parents[1]
BOOKS_DIR = ROOT_DIR / "books"
EXTRACTED_DIR = ROOT_DIR / "knowledge" / "extracted"


def extract_all_books() -> None:
    """Placeholder for PDF -> Gemini extraction pipeline.

    TODO (Harry): Implement pypdf chunking + Gemini structured extraction.
    """
    EXTRACTED_DIR.mkdir(parents=True, exist_ok=True)
    pdfs = sorted(BOOKS_DIR.glob("*.pdf"))
    if not pdfs:
        print(f"No PDFs found in {BOOKS_DIR}. Drop textbooks there to extract.")
        return

    for pdf_path in pdfs:
        out_file = EXTRACTED_DIR / f"{pdf_path.stem}.json"
        placeholder = {
            "book": pdf_path.name,
            "equations": [],
            "tables": [],
            "heuristics": [],
        }
        out_file.write_text(json.dumps(placeholder, indent=2), encoding="utf-8")
        print(f"Wrote extraction placeholder: {out_file}")


if __name__ == "__main__":
    extract_all_books()
