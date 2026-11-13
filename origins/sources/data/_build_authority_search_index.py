#!/usr/bin/env python3
"""Rebuild authority-search-index.json from authorities + extended chapters."""

from __future__ import annotations

import json
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parent
AUTH = ROOT / "authority"
EXT = ROOT / "extended"
OUT = ROOT / "authority-search-index.json"

TYPE_LABEL = {
    "person": "Person",
    "org": "Organization",
    "place": "Place",
    "topic": "Topic",
    "event": "Event",
    "work": "Work",
}


def main() -> None:
    master = json.loads((AUTH / "authorities.json").read_text())
    sources: dict[str, dict] = {}
    by_id: dict[str, list[str]] = defaultdict(list)

    for path in sorted(EXT.glob("chapter-*.json")):
        data = json.loads(path.read_text())
        chapter = data.get("chapter")
        chapter_title = data.get("chapter_title") or f"Chapter {chapter}"
        section_lists = (
            ("main", data.get("sources") or [], "s"),
            ("notes", data.get("notes_sources") or [], "n"),
        )
        for section, rows, key_prefix in section_lists:
            for source in rows:
                ids = set(source.get("topic_ids") or [])
                ids.update(source.get("author_ids") or [])
                ids.update(source.get("publication_ids") or [])
                entities = source.get("entity_ids") or {}
                for bucket in ("people", "orgs", "places"):
                    ids.update(entities.get(bucket) or [])
                if not ids:
                    continue
                key = (
                    source.get("source_key")
                    or f"ch{int(chapter):02d}-{key_prefix}{int(source.get('id')):02d}"
                )
                if key not in sources:
                    sources[key] = {
                        "key": key,
                        "section": section,
                        "chapter": chapter,
                        "chapter_title": chapter_title,
                        "source_id": source.get("id"),
                        "author": source.get("author") or "",
                        "title": source.get("title") or "",
                        "publication": source.get("publication") or "",
                        "date": source.get("date") or "",
                        "date_iso": source.get("date_iso") or "",
                        "url": source.get("url") or "",
                        "summary": (source.get("summary") or "")[:220],
                    }
                for authority_id in ids:
                    if key not in by_id[authority_id]:
                        by_id[authority_id].append(key)

    keywords = []
    keyword_sources = {}
    for type_name, items in master["authorities"].items():
        for item in items:
            authority_id = item["id"]
            keys = by_id.get(authority_id) or []
            if not keys:
                continue
            parts = []
            seen = set()
            for part in [
                item["prefLabel"],
                item.get("indexTerm") or "",
                type_name,
                TYPE_LABEL.get(type_name, type_name),
                *(item.get("altLabels") or []),
            ]:
                text = (part or "").strip()
                if text and text.lower() not in seen:
                    seen.add(text.lower())
                    parts.append(text)
            keywords.append(
                {
                    "id": authority_id,
                    "label": item["prefLabel"],
                    "type": type_name,
                    "typeLabel": TYPE_LABEL.get(type_name, type_name.title()),
                    "searchText": " ".join(parts),
                    "sourceCount": len(keys),
                }
            )
            keyword_sources[authority_id] = keys

    keywords.sort(key=lambda row: (-row["sourceCount"], row["label"].lower()))
    payload = {
        "version": 1,
        "keywordCount": len(keywords),
        "sourceCount": len(sources),
        "keywords": keywords,
        "keywordSources": keyword_sources,
        "sources": sources,
    }
    OUT.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + "\n")
    print(f"Wrote {OUT} ({len(keywords)} keywords, {len(sources)} sources)")


if __name__ == "__main__":
    main()
