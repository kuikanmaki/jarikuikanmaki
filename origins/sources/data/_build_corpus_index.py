#!/usr/bin/env python3
"""Build a flat public corpus-index.json for visitor browse (no artifacts)."""

from __future__ import annotations

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent
EXT = ROOT / "extended"
OUT = ROOT / "corpus-index.json"

KIND_LABEL = {
    "html_article": "Article",
    "pdf": "PDF",
    "video": "Video",
    "social_post": "Social",
    "database_record": "Database",
    "gov_doc": "Government",
    "landing": "Web page",
    "book": "Book",
    "email": "Email",
    "preprint": "Preprint",
    "presentation": "Presentation",
    "personal_note": "Note",
    "unknown": "Source",
}


def main() -> None:
    chapters = []
    sources = []

    for path in sorted(EXT.glob("chapter-*.json")):
        data = json.loads(path.read_text())
        chapter = data.get("chapter")
        chapter_title = data.get("chapter_title") or f"Chapter {chapter}"
        printed = data.get("printed_pages") or {}
        chapters.append(
            {
                "number": chapter,
                "title": chapter_title,
                "name": "Prologue" if chapter == 0 else f"Chapter {chapter}",
                "printed_pages": printed,
                "source_count": len(data.get("sources") or []),
            }
        )
        for source in data.get("sources") or []:
            kind = source.get("content_kind") or "unknown"
            entity_ids = source.get("entity_ids") or {}
            authority_ids = list(source.get("topic_ids") or [])
            for bucket in ("people", "orgs", "places"):
                for aid in entity_ids.get(bucket) or []:
                    if aid not in authority_ids:
                        authority_ids.append(aid)

            sources.append(
                {
                    "source_key": source.get("source_key")
                    or f"ch{int(chapter):02d}-s{int(source.get('id') or 0):02d}",
                    "chapter": chapter,
                    "chapter_title": chapter_title,
                    "id": source.get("id"),
                    "author": source.get("author") or "",
                    "title": source.get("title") or "",
                    "publication": source.get("publication") or "",
                    "date": source.get("date") or "",
                    "date_iso": source.get("date_iso") or "",
                    "url": source.get("url") or "",
                    "type": source.get("type") or "",
                    "content_kind": kind,
                    "content_kind_label": KIND_LABEL.get(kind, kind.replace("_", " ")),
                    "language": source.get("language") or "",
                    "status": source.get("status") or "",
                    "summary": source.get("summary") or "",
                    "book_role": source.get("book_role") or "",
                    "topics": source.get("topics") or [],
                    "entities": source.get("entities") or {
                        "people": [],
                        "orgs": [],
                        "places": [],
                    },
                    "authority_ids": authority_ids,
                }
            )

    sources.sort(
        key=lambda row: (
            row.get("date_iso") or "9999",
            row.get("chapter") if row.get("chapter") is not None else 999,
            row.get("id") if row.get("id") is not None else 999,
        )
    )

    payload = {
        "version": 1,
        "generated_from": "extended/chapter-*.json",
        "chapterCount": len(chapters),
        "sourceCount": len(sources),
        "chapters": chapters,
        "sources": sources,
    }
    OUT.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + "\n")
    print(f"Wrote {OUT} ({len(sources)} sources, {len(chapters)} chapters)")


if __name__ == "__main__":
    main()
