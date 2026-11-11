#!/usr/bin/env python3
"""Light catalog-card normalization for extended chapter JSONs.

Adds:
  - source_key (ch07-s03)
  - date_iso (YYYY-MM-DD / YYYY-MM / YYYY when parseable)
Fills empty `type` from content_kind.
Normalizes a few content_kind aliases.
"""

from __future__ import annotations

import json
import re
from datetime import datetime
from pathlib import Path

EXT = Path(__file__).resolve().parent / "extended"

KIND_TO_TYPE = {
    "html_article": "Article",
    "pdf": "PDF document",
    "video": "Video",
    "social_post": "Social media post",
    "social": "Social media post",
    "database_record": "Database record",
    "gov_doc": "Government document",
    "landing": "Web page",
    "book": "Book",
    "email": "Email",
    "preprint": "Preprint",
    "presentation": "Presentation",
    "personal_note": "Personal note",
    "unknown": "Source",
}

KIND_ALIASES = {
    "social": "social_post",
}


def parse_date_iso(value: str) -> str | None:
    text = (value or "").strip()
    if not text:
        return None
    if re.fullmatch(r"\d{4}", text):
        return text
    if re.fullmatch(r"\d{4}-\d{2}-\d{2}", text):
        return text
    if re.fullmatch(r"\d{4}-\d{2}", text):
        return text

    # "June 1, 2020" / "June 1 2020"
    for fmt in ("%B %d, %Y", "%B %d %Y", "%b %d, %Y", "%b %d %Y"):
        try:
            return datetime.strptime(text, fmt).date().isoformat()
        except ValueError:
            pass

    # "June 2020"
    for fmt in ("%B %Y", "%b %Y"):
        try:
            dt = datetime.strptime(text, fmt)
            return f"{dt.year:04d}-{dt.month:02d}"
        except ValueError:
            pass

    # Ranges / messy tails: take first month-day-year if present
    m = re.search(
        r"\b("
        r"January|February|March|April|May|June|July|August|September|October|November|December"
        r"|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec"
        r")\s+(\d{1,2}),?\s+(\d{4})\b",
        text,
    )
    if m:
        chunk = f"{m.group(1)} {m.group(2)}, {m.group(3)}"
        for fmt in ("%B %d, %Y", "%b %d, %Y"):
            try:
                return datetime.strptime(chunk, fmt).date().isoformat()
            except ValueError:
                pass

    y = re.fullmatch(r".*?(\d{4}).*", text)
    if y and not re.search(r"\d{5,}", text):
        # last-resort year only when nothing else worked
        return y.group(1)
    return None


def normalize_source(chapter: int, source: dict) -> dict:
    sid = int(source.get("id") or 0)
    source["source_key"] = f"ch{int(chapter):02d}-s{sid:02d}"

    kind = source.get("content_kind") or ""
    if kind in KIND_ALIASES:
        source["content_kind"] = KIND_ALIASES[kind]
        kind = source["content_kind"]

    if not (source.get("type") or "").strip():
        source["type"] = KIND_TO_TYPE.get(kind, "Source")

    iso = parse_date_iso(source.get("date") or "")
    if iso:
        source["date_iso"] = iso
    elif "date_iso" in source:
        del source["date_iso"]

    return source


def main() -> None:
    chapters = sorted(EXT.glob("chapter-*.json"))
    total = 0
    with_iso = 0
    filled_type = 0
    for path in chapters:
        data = json.loads(path.read_text())
        chapter = int(data.get("chapter"))
        for source in data.get("sources") or []:
            before_type = (source.get("type") or "").strip()
            normalize_source(chapter, source)
            total += 1
            if source.get("date_iso"):
                with_iso += 1
            if not before_type and (source.get("type") or "").strip():
                filled_type += 1
        path.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n")
    print(
        f"Normalized {total} sources across {len(chapters)} chapters "
        f"(date_iso={with_iso}, type_filled={filled_type})"
    )


if __name__ == "__main__":
    main()
