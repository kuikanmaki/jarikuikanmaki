#!/usr/bin/env python3
"""Verify extended controlled labels match authority prefLabels for linked ids.

Citation strings (author / publication) are not required to equal prefLabel.
Exits 1 on mismatches or unknown authority ids.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

from _authority_lib import load_authority_map, pref_label

ROOT = Path(__file__).resolve().parent
EXT = ROOT / "extended"


def main() -> int:
    auth_map = load_authority_map()
    errors = []
    warnings = []

    for path in sorted(EXT.glob("chapter-*.json")):
        data = json.loads(path.read_text(encoding="utf-8"))
        for source in (data.get("sources") or []) + (data.get("notes_sources") or []):
            key = source.get("source_key")

            topic_ids = list(source.get("topic_ids") or [])
            topics = list(source.get("topics") or [])
            for i, aid in enumerate(topic_ids):
                if aid not in auth_map:
                    errors.append(f"{key}: unknown topic_ids[{i}]={aid}")
                    continue
                expect = pref_label(auth_map, aid)
                if i < len(topics) and topics[i] != expect:
                    errors.append(
                        f"{key}: topics[{i}]={topics[i]!r} != prefLabel {expect!r} for {aid}"
                    )
            # orphan topic strings beyond ids are allowed (corpus extensions pending link)
            if len(topics) > len(topic_ids):
                warnings.append(
                    f"{key}: {len(topics) - len(topic_ids)} topic string(s) without leading topic_ids"
                )

            ent_ids = source.get("entity_ids") or {}
            ents = source.get("entities") or {}
            for bucket in ("people", "orgs", "places"):
                ids = list(ent_ids.get(bucket) or [])
                labels = list(ents.get(bucket) or [])
                for i, aid in enumerate(ids):
                    if aid not in auth_map:
                        errors.append(f"{key}: unknown entity_ids.{bucket}[{i}]={aid}")
                        continue
                    expect = pref_label(auth_map, aid)
                    if i < len(labels) and labels[i] != expect:
                        errors.append(
                            f"{key}: entities.{bucket}[{i}]={labels[i]!r} != prefLabel {expect!r} for {aid}"
                        )

            for field, ids in (
                ("author_ids", source.get("author_ids") or []),
                ("publication_ids", source.get("publication_ids") or []),
            ):
                for aid in ids:
                    if aid not in auth_map:
                        errors.append(f"{key}: unknown {field} id={aid}")

    print(f"authority verify: {len(errors)} error(s), {len(warnings)} warning(s)")
    for e in errors[:50]:
        print(" ERROR", e)
    if len(errors) > 50:
        print(f" ... +{len(errors) - 50} more errors")
    for w in warnings[:20]:
        print(" WARN", w)
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main())
