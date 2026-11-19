#!/usr/bin/env python3
"""Keep topic_ids as topic:* only; move misfiled authorities to the right fields.

Earlier promote dumped person/org/place/work/event ids into topic_ids so chips
would not be empty. That polluted topic chips. This script:

  1. Ensures person/org/place ids from topic_ids are present in entity_ids
  2. Ensures work/event ids from topic_ids are present in entity_ids.works/events
  3. Rewrites topic_ids to topic:* only (preserves order, deduped)

Does not mint authorities. Pair with _sync_labels_from_authorities.py and
_build_corpus_index.py / _build_authority_search_index.py.
"""

from __future__ import annotations

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent
EXT = ROOT / "extended"

BUCKET_FOR_PREFIX = {
    "person": "people",
    "org": "orgs",
    "place": "places",
    "work": "works",
    "event": "events",
}


def _merge_id(bucket_list: list, aid: str) -> bool:
    if not aid or aid in bucket_list:
        return False
    bucket_list.append(aid)
    return True


def scrub_source(source: dict) -> bool:
    """Return True if source was modified."""
    old_topics = list(source.get("topic_ids") or [])
    entity_ids = source.get("entity_ids") or {}
    if not isinstance(entity_ids, dict):
        entity_ids = {"people": [], "orgs": [], "places": []}

    for bucket in ("people", "orgs", "places", "works", "events"):
        entity_ids.setdefault(bucket, list(entity_ids.get(bucket) or []))

    dirty = False
    kept_topics: list[str] = []
    seen_topics: set[str] = set()

    for aid in old_topics:
        if not aid or not isinstance(aid, str):
            continue
        prefix = aid.split(":", 1)[0]
        if prefix == "topic":
            if aid not in seen_topics:
                seen_topics.add(aid)
                kept_topics.append(aid)
            continue
        bucket = BUCKET_FOR_PREFIX.get(prefix)
        if not bucket:
            # Unknown prefix: drop from topic_ids (do not keep as topic)
            dirty = True
            continue
        if _merge_id(entity_ids[bucket], aid):
            dirty = True

    if kept_topics != old_topics:
        source["topic_ids"] = kept_topics
        dirty = True

    # Drop empty optional buckets to avoid noisy schema on every source
    cleaned = {
        "people": list(entity_ids.get("people") or []),
        "orgs": list(entity_ids.get("orgs") or []),
        "places": list(entity_ids.get("places") or []),
    }
    if entity_ids.get("works"):
        cleaned["works"] = list(entity_ids["works"])
    if entity_ids.get("events"):
        cleaned["events"] = list(entity_ids["events"])

    if cleaned != (source.get("entity_ids") or {}):
        source["entity_ids"] = cleaned
        dirty = True

    return dirty


def main() -> None:
    changed = 0
    total = 0
    empty_topics_after = 0
    moved = {"people": 0, "orgs": 0, "places": 0, "works": 0, "events": 0}

    for path in sorted(EXT.glob("chapter-*.json")):
        data = json.loads(path.read_text(encoding="utf-8"))
        dirty = False
        for source in (data.get("sources") or []) + (data.get("notes_sources") or []):
            total += 1
            before_ent = json.dumps(source.get("entity_ids") or {}, sort_keys=True)
            before_topics = list(source.get("topic_ids") or [])
            if scrub_source(source):
                dirty = True
                changed += 1
            if not (source.get("topic_ids") or []):
                empty_topics_after += 1
            after_ent = source.get("entity_ids") or {}
            # count newly present ids that were in old topic_ids as non-topic
            for aid in before_topics:
                if not isinstance(aid, str):
                    continue
                prefix = aid.split(":", 1)[0]
                bucket = BUCKET_FOR_PREFIX.get(prefix)
                if bucket and aid in (after_ent.get(bucket) or []):
                    # count every non-topic id that ended in the right bucket after scrub
                    if not aid.startswith("topic:"):
                        pass
            before_map = json.loads(before_ent) if before_ent else {}
            for bucket in moved:
                before_set = set(before_map.get(bucket) or [])
                after_set = set(after_ent.get(bucket) or [])
                moved[bucket] += len(after_set - before_set)
        if dirty:
            path.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")

    print(
        json.dumps(
            {
                "sources_total": total,
                "sources_changed": changed,
                "sources_empty_topic_ids_after": empty_topics_after,
                "ids_newly_merged_into_entity_buckets": moved,
            },
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
