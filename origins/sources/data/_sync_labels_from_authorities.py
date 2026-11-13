#!/usr/bin/env python3
"""Rewrite extended topics/entities display strings from authority IDs.

Citation fields `author` / `publication` stay as transcribed bibliography text.
Controlled `topics` / `entities` labels are derived from `topic_ids` / `entity_ids`.
Orphan strings with no matching id are preserved and reported.
"""
from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path

from _authority_lib import labels_for_ids, load_authority_map

ROOT = Path(__file__).resolve().parent
EXT = ROOT / "extended"
ARCHIVE = ROOT / "_archive" / datetime.now(timezone.utc).strftime("%Y-%m-%d")


def orphan_strings(strings: list[str], labels: list[str]) -> list[str]:
    """Keep legacy strings that are not already represented by resolved labels."""
    have = {x.casefold() for x in labels}
    out = []
    for s in strings or []:
        if not s:
            continue
        if s.casefold() in have:
            continue
        out.append(s)
    return out


def main() -> None:
    auth_map = load_authority_map()
    ARCHIVE.mkdir(parents=True, exist_ok=True)
    snapshot = []
    changes = []
    missing_ids = []

    for path in sorted(EXT.glob("chapter-*.json")):
        data = json.loads(path.read_text(encoding="utf-8"))
        dirty = False
        for source in (data.get("sources") or []) + (data.get("notes_sources") or []):
            key = source.get("source_key")
            before = {
                "topics": list(source.get("topics") or []),
                "entities": {
                    "people": list((source.get("entities") or {}).get("people") or []),
                    "orgs": list((source.get("entities") or {}).get("orgs") or []),
                    "places": list((source.get("entities") or {}).get("places") or []),
                },
            }
            snapshot.append({"source_key": key, **before})

            topic_ids = list(source.get("topic_ids") or [])
            topic_labels, miss = labels_for_ids(auth_map, topic_ids)
            for m in miss:
                missing_ids.append({"source_key": key, "id": m, "field": "topic_ids"})
            orphans_t = orphan_strings(before["topics"], topic_labels)
            new_topics = topic_labels + orphans_t

            ent_ids = source.get("entity_ids") or {}
            new_entities = {"people": [], "orgs": [], "places": []}
            for bucket, id_key in (("people", "people"), ("orgs", "orgs"), ("places", "places")):
                ids = list(ent_ids.get(id_key) or [])
                labels, miss = labels_for_ids(auth_map, ids)
                for m in miss:
                    missing_ids.append({"source_key": key, "id": m, "field": f"entity_ids.{bucket}"})
                orphans = orphan_strings(before["entities"].get(bucket) or [], labels)
                new_entities[bucket] = labels + orphans

            after_topics = new_topics
            after_entities = new_entities
            if after_topics != before["topics"] or after_entities != before["entities"]:
                source["topics"] = after_topics
                source["entities"] = after_entities
                dirty = True
                changes.append(
                    {
                        "source_key": key,
                        "before": before,
                        "after": {"topics": after_topics, "entities": after_entities},
                        "orphan_topics": orphans_t,
                    }
                )
        if dirty:
            path.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")

    (ARCHIVE / "topics-entities-snapshot.json").write_text(
        json.dumps({"generated_at": datetime.now(timezone.utc).isoformat(), "sources": snapshot}, indent=2, ensure_ascii=False)
        + "\n",
        encoding="utf-8",
    )
    report = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "sources_changed": len(changes),
        "missing_authority_ids": missing_ids,
        "changes_sample": changes[:30],
    }
    (ARCHIVE / "label-sync-report.json").write_text(
        json.dumps(report, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
    )
    print(f"changed {len(changes)} sources; missing ids {len(missing_ids)}")
    print(f"snapshot -> {ARCHIVE / 'topics-entities-snapshot.json'}")
    print(f"report   -> {ARCHIVE / 'label-sync-report.json'}")


if __name__ == "__main__":
    main()
