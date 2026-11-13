#!/usr/bin/env python3
"""Build a flat public corpus-index.json for visitor browse (no artifacts).

Generated view only — do not hand-edit corpus-index.json. Rebuild from
extended/chapter-*.json after bibliography or authority changes.
"""

from __future__ import annotations

import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path

from _authority_lib import labels_for_ids, load_authority_map

ROOT = Path(__file__).resolve().parent
EXT = ROOT / "extended"
OUT = ROOT / "corpus-index.json"
HASH_OUT = ROOT / "corpus-index.sha256"

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

SECTION_KEY_PREFIX = {
    "main": "s",
    "notes": "n",
}


def _merge_labels(resolved: list[str], existing: list[str]) -> list[str]:
    have = {x.casefold() for x in resolved}
    out = list(resolved)
    for s in existing or []:
        if s and s.casefold() not in have:
            out.append(s)
            have.add(s.casefold())
    return out


def _input_fingerprint() -> str:
    h = hashlib.sha256()
    for path in sorted(EXT.glob("chapter-*.json")):
        h.update(path.name.encode())
        h.update(b"\0")
        h.update(path.read_bytes())
        h.update(b"\0")
    for path in sorted((ROOT / "authority").glob("*.json")):
        if path.name.endswith("-report.json"):
            continue
        h.update(path.name.encode())
        h.update(b"\0")
        h.update(path.read_bytes())
        h.update(b"\0")
    return h.hexdigest()


def _default_source_key(chapter: int, section: str, source_id: int) -> str:
    prefix = SECTION_KEY_PREFIX.get(section, "s")
    return f"ch{int(chapter):02d}-{prefix}{int(source_id or 0):02d}"


def _public_card(source: dict, chapter, chapter_title: str, section: str, auth_map) -> dict:
    kind = source.get("content_kind") or "unknown"
    entity_ids = source.get("entity_ids") or {}
    author_ids = list(source.get("author_ids") or [])
    publication_ids = list(source.get("publication_ids") or [])
    topic_ids = list(source.get("topic_ids") or [])
    authority_ids = list(topic_ids)
    for aid in author_ids + publication_ids:
        if aid not in authority_ids:
            authority_ids.append(aid)
    for bucket in ("people", "orgs", "places"):
        for aid in entity_ids.get(bucket) or []:
            if aid not in authority_ids:
                authority_ids.append(aid)

    topic_labels, _ = labels_for_ids(auth_map, topic_ids)
    topics = _merge_labels(topic_labels, list(source.get("topics") or []))

    entities = {"people": [], "orgs": [], "places": []}
    src_ents = source.get("entities") or {}
    for bucket in ("people", "orgs", "places"):
        resolved, _ = labels_for_ids(auth_map, list(entity_ids.get(bucket) or []))
        entities[bucket] = _merge_labels(resolved, list(src_ents.get(bucket) or []))

    return {
        "source_key": source.get("source_key")
        or _default_source_key(chapter, section, source.get("id") or 0),
        "section": section,
        "chapter": chapter,
        "chapter_title": chapter_title,
        "id": source.get("id"),
        "author": source.get("author") or "",
        "author_ids": author_ids,
        "title": source.get("title") or "",
        "publication": source.get("publication") or "",
        "publication_ids": publication_ids,
        "date": source.get("date") or "",
        "date_iso": source.get("date_iso") or "",
        "url": source.get("url") or "",
        "image_url": source.get("image_url") or "",
        "type": source.get("type") or "",
        "content_kind": kind,
        "content_kind_label": KIND_LABEL.get(kind, kind.replace("_", " ")),
        "language": source.get("language") or "",
        "status": source.get("status") or "",
        "summary": source.get("summary") or "",
        "book_role": source.get("book_role") or "",
        "topics": topics,
        "entities": entities,
        "authority_ids": authority_ids,
    }


def main() -> None:
    chapters = []
    sources = []
    auth_map = load_authority_map()
    input_hash = _input_fingerprint()

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
            sources.append(_public_card(source, chapter, chapter_title, "main", auth_map))
        for source in data.get("notes_sources") or []:
            sources.append(_public_card(source, chapter, chapter_title, "notes", auth_map))

    sources.sort(
        key=lambda row: (
            row.get("date_iso") or "9999",
            row.get("chapter") if row.get("chapter") is not None else 999,
            0 if row.get("section") == "main" else 1,
            row.get("id") if row.get("id") is not None else 999,
        )
    )

    payload = {
        "version": 1,
        "generated_from": "extended/chapter-*.json",
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "input_sha256": input_hash,
        "note": "GENERATED FILE — rebuild with _build_corpus_index.py; do not hand-edit.",
        "chapterCount": len(chapters),
        "sourceCount": len(sources),
        "chapters": chapters,
        "sources": sources,
    }
    body = json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + "\n"
    OUT.write_text(body)
    HASH_OUT.write_text(input_hash + "\t" + OUT.name + "\n")
    print(f"Wrote {OUT} ({len(sources)} sources, {len(chapters)} chapters)")
    print(f"Wrote {HASH_OUT} ({input_hash[:12]}…)")


if __name__ == "__main__":
    main()
