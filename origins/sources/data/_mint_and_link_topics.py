#!/usr/bin/env python3
"""Mint corpus-extension topic authorities and link them to sources.

Demand signal: historical free-text `topics` on extended chapters (git commit
baseline), plus title/summary/book_role confirmation for multi-word labels.

- Near-dupes → altLabels on existing topics (then link that id)
- Entities / noise → skipped
- Remaining reusable concepts (freq ≥ 2) → new topic:* authorities
- Link only when the source historically carried the phrase, or title/summary/
  book_role clearly contains a label/alias (bounded matching)
"""

from __future__ import annotations

import json
import re
import subprocess
from collections import Counter, defaultdict
from pathlib import Path

from _authority_lib import load_authority_map, pref_label
from _link_authors import rebuild_alias_map, slugify, write_type_split
from _link_authors import norm as auth_norm

ROOT = Path(__file__).resolve().parent
AUTH = ROOT / "authority"
EXT = ROOT / "extended"

BASELINE_COMMIT = "f7c38e6"

# Historical phrases that are orgs/codes/noise — do not mint as topics.
REJECT_PHRASES = {
    "thl",
    "odni",
    "dia",
    "wuhan cdc",
    "preprint",
    "dossier",
    "podcast",
    "finland media",
    "circumstantial evidence",
    "oversight",
    "human cells",
    "who situation report",
    "nih admission",
    "amazon",
    "finland",
    "tedros",
    "personal journal",
    # Too generic / non-subject for controlled topics
    "records",
    "deleted records",
    "early sequence",
}

# Map historical phrase → existing topic id (altLabel / synonym).
EXISTING_TOPIC_ALIASES: dict[str, str] = {
    "gain-of-function pause": "topic:gain-of-function-research",
    "foia emails": "topic:freedom-of-information-requests",
    "nih foia": "topic:freedom-of-information-requests",
    "lab leak dismissal": "topic:lab-leak-hypothesis",
    "lab-leak dismissal": "topic:lab-leak-hypothesis",
    "lab-leak credibility": "topic:lab-leak-hypothesis",
    "information control": "topic:censorship",
    "content moderation": "topic:censorship",
    "secrecy": "topic:censorship",
    "natural origin": "topic:zoonosis",
    "bat origin": "topic:bat-coronaviruses",
    "bat coronavirus emergence": "topic:bat-coronaviruses",
    "wiv biosafety": "topic:biosafety",
    "biosafety debate": "topic:biosafety",
    "biosafety practices": "topic:biosafety",
    "biosafety policy": "topic:biosafety",
    "biosafety infrastructure": "topic:biosafety",
    "h5n1": "topic:h5n1-avian-flu",
}

# Merge several historical phrases into one new topic prefLabel.
MERGE_TO_LABEL: dict[str, str] = {
    "conspiracy theories": "conspiracy theories",
    "conspiracy theory framing": "conspiracy theories",
    "conspiracy framing": "conspiracy theories",
    "disinformation": "disinformation",
    "russian disinformation": "disinformation",
    "intelligence community": "intelligence community",
    "intelligence": "intelligence community",
    "origins debate": "origins debate",
    "lab vs natural": "origins debate",
    "covid origins": "origins debate",
    "origins": "origins debate",
    "conflicts of interest": "conflicts of interest",
    "who conflicts": "conflicts of interest",
    "foia emails": "FOIA",  # redirected to existing above; kept for safety
    "nih foia": "FOIA",
    "early reporting": "early reporting",
    "early cases": "early cases",
    "wuhan pneumonia": "Wuhan pneumonia",
    "nih grant": "NIH grant",
    "r01ai110964": "NIH grant",
    "whistleblowers": "whistleblowers",
    "transparency": "transparency",
    "travel restrictions": "travel restrictions",
    "human-to-human transmission": "human-to-human transmission",
    "open-source investigation": "open-source investigation",
    "potential pandemic pathogens": "potential pandemic pathogens",
    "genome analysis": "genome analysis",
    "phylogenetics": "phylogenetics",
    "transmissibility": "transmissibility",
    "rdrp": "RdRp",
    "state department cables": "State Department cables",
    "china cover-up": "China cover-up",
    "data access": "data access",
    "mojiang miners": "Mojiang miners",
    "sarsr-cov gene pool": "SARSr-CoV gene pool",
}


def norm_phrase(s: str) -> str:
    return auth_norm(s)


def sentence_case(label: str) -> str:
    """Capitalize first letter unless label is mostly an acronym/code."""
    if not label:
        return label
    if label[:1].isupper():
        return label
    # keep short all-token acronyms as-is after first char fix
    return label[:1].upper() + label[1:]


def git_repo_root() -> Path:
    out = subprocess.check_output(["git", "rev-parse", "--show-toplevel"], text=True)
    return Path(out.strip())


def load_historical_topics(commit: str) -> tuple[Counter, dict[str, set[str]], dict[str, list[str]]]:
    """phrase → count; phrase → source_keys; source_key → phrases."""
    repo = git_repo_root()
    listing = subprocess.check_output(
        [
            "git",
            "-C",
            str(repo),
            "ls-tree",
            "-r",
            "--name-only",
            commit,
            "origins/sources/data/extended/",
        ],
        text=True,
    )
    files = [f for f in listing.splitlines() if re.search(r"chapter-\d+\.json$", f)]
    ctr: Counter = Counter()
    by_phrase: dict[str, set[str]] = defaultdict(set)
    by_source: dict[str, list[str]] = defaultdict(list)
    for f in files:
        data = json.loads(
            subprocess.check_output(["git", "-C", str(repo), "show", f"{commit}:{f}"])
        )
        for source in (data.get("sources") or []) + (data.get("notes_sources") or []):
            key = source.get("source_key")
            if not key:
                continue
            for raw in source.get("topics") or []:
                if not raw or not str(raw).strip():
                    continue
                phrase = str(raw).strip()
                ctr[phrase] += 1
                by_phrase[phrase].add(key)
                by_source[key].append(phrase)
    return ctr, by_phrase, by_source


def build_label_index(auth_map: dict) -> dict[str, list[tuple[str, str]]]:
    """norm label → [(type, id), ...]."""
    out: dict[str, list[tuple[str, str]]] = defaultdict(list)
    for aid, node in auth_map.items():
        if not isinstance(node, dict):
            continue
        typ = aid.split(":", 1)[0]
        labs = [node.get("prefLabel"), node.get("indexTerm"), *(node.get("altLabels") or [])]
        for lab in labs:
            if isinstance(lab, str) and lab.strip():
                out[norm_phrase(lab)].append((typ, aid))
    return out


def near_existing_topic(phrase: str, topics: list[tuple[str, str, str]]) -> str | None:
    """Return topic id if phrase is a clear facet/subset of an existing topic."""
    nt = norm_phrase(phrase)
    toks = set(nt.split())
    if not toks:
        return None
    for aid, _lab, ln in topics:
        lt = set(ln.split())
        if not lt:
            continue
        if lt <= toks or (toks <= lt and len(toks) >= 2):
            return aid
        inter = toks & lt
        if len(inter) >= 2 and len(inter) / max(len(toks), len(lt)) >= 0.6:
            return aid
    return None


def text_has_label(haystack: str, label: str) -> bool:
    """Bounded match: avoid short false positives."""
    if not haystack or not label:
        return False
    lab = label.strip()
    if len(lab) < 4:
        return False
    # Multi-word or long labels: case-insensitive substring
    if " " in lab or "-" in lab or len(lab) >= 8:
        return lab.casefold() in haystack.casefold()
    # Short tokens: word boundary
    return re.search(r"\b" + re.escape(lab) + r"\b", haystack, flags=re.I) is not None


def main() -> None:
    auth_map = load_authority_map()
    label_index = build_label_index(auth_map)
    existing_topics = [
        (aid, node.get("prefLabel") or "", norm_phrase(node.get("prefLabel") or ""))
        for aid, node in auth_map.items()
        if str(aid).startswith("topic:") and isinstance(node, dict)
    ]
    topic_by_id = {aid: node for aid, node in auth_map.items() if str(aid).startswith("topic:")}

    phrase_ctr, phrase_sources, source_phrases = load_historical_topics(BASELINE_COMMIT)

    # phrase_norm → target topic id (existing or to-mint key)
    phrase_to_topic: dict[str, str] = {}
    alts_to_add: dict[str, set[str]] = defaultdict(set)  # topic_id → alt strings
    mint_labels: dict[str, dict] = {}  # prefLabel → {alts, phrases, count}

    def register_existing(phrase: str, topic_id: str) -> None:
        phrase_to_topic[norm_phrase(phrase)] = topic_id
        pref = pref_label(auth_map, topic_id) or ""
        if phrase.casefold() != pref.casefold():
            alts_to_add[topic_id].add(phrase)

    # 1) Explicit alias map to existing topics
    for phrase, n in phrase_ctr.items():
        np = norm_phrase(phrase)
        if np in EXISTING_TOPIC_ALIASES:
            register_existing(phrase, EXISTING_TOPIC_ALIASES[np])

    # 2) Exact authority matches
    for phrase, n in phrase_ctr.items():
        np = norm_phrase(phrase)
        if np in phrase_to_topic:
            continue
        hits = label_index.get(np) or []
        topic_hits = [aid for typ, aid in hits if typ == "topic"]
        if topic_hits:
            phrase_to_topic[np] = topic_hits[0]
            continue
        if any(typ != "topic" for typ, _aid in hits):
            # entity/other — skip
            continue
        if np in REJECT_PHRASES or phrase.casefold() in REJECT_PHRASES:
            continue
        if "," in phrase and phrase[0].isupper() and len(phrase.split()) <= 4:
            continue

        # near-dupe of existing topic
        near = near_existing_topic(phrase, existing_topics)
        if near:
            register_existing(phrase, near)
            continue

        # merge into new label bucket
        if np in MERGE_TO_LABEL:
            label = MERGE_TO_LABEL[np]
        elif n >= 2:
            label = phrase  # use phrase as label
        else:
            continue

        # If merge label itself maps to existing alias table after norm
        if norm_phrase(label) in EXISTING_TOPIC_ALIASES:
            register_existing(phrase, EXISTING_TOPIC_ALIASES[norm_phrase(label)])
            continue

        bucket = mint_labels.setdefault(
            label,
            {"alts": set(), "phrases": set(), "count": 0, "sources": set()},
        )
        bucket["phrases"].add(phrase)
        bucket["count"] += n
        bucket["sources"] |= phrase_sources.get(phrase, set())
        if phrase.casefold() != label.casefold():
            bucket["alts"].add(phrase)

    # Drop mint buckets that collide with non-topic authorities by label
    for label in list(mint_labels.keys()):
        hits = label_index.get(norm_phrase(label)) or []
        if any(typ != "topic" for typ, _ in hits):
            del mint_labels[label]
            continue
        if any(typ == "topic" for typ, _ in hits):
            # already a topic — treat as alias
            tid = next(aid for typ, aid in hits if typ == "topic")
            for phrase in mint_labels[label]["phrases"]:
                register_existing(phrase, tid)
            del mint_labels[label]

    # Create topic records
    master = json.loads((AUTH / "authorities.json").read_text(encoding="utf-8"))
    topics_list: list[dict] = master["authorities"]["topic"]
    known_ids = {t["id"] for t in topics_list}
    minted: list[dict] = []

    for label, bucket in sorted(mint_labels.items(), key=lambda kv: (-len(kv[1]["sources"]), kv[0].casefold())):
        pref = sentence_case(label)
        tid = f"topic:{slugify(pref)}"
        if tid in known_ids:
            # collision — attach phrases to existing
            for phrase in bucket["phrases"]:
                register_existing(phrase, tid)
            continue
        # ensure unique
        base = tid
        i = 2
        while tid in known_ids:
            tid = f"{base}-{i}"
            i += 1
        alts = sorted({a for a in bucket["alts"] if a.casefold() != pref.casefold()})
        item = {
            "id": tid,
            "prefLabel": pref,
            "indexTerm": pref,
            "altLabels": alts,
            "related": [],
            "subentries": [],
            "pages": [],
            "source": "corpus-extension",
        }
        topics_list.append(item)
        known_ids.add(tid)
        minted.append(item)
        for phrase in bucket["phrases"]:
            phrase_to_topic[norm_phrase(phrase)] = tid
        topic_by_id[tid] = item
        auth_map[tid] = item

    # Apply altLabels onto existing topics
    by_id = {t["id"]: t for t in topics_list}
    for tid, alts in alts_to_add.items():
        item = by_id.get(tid)
        if not item:
            continue
        have = {a.casefold() for a in (item.get("altLabels") or [])}
        pref_cf = (item.get("prefLabel") or "").casefold()
        for alt in sorted(alts):
            if alt.casefold() == pref_cf or alt.casefold() in have:
                continue
            item.setdefault("altLabels", []).append(alt)
            have.add(alt.casefold())

    # Sort topics by id for stability
    topics_list.sort(key=lambda t: t.get("id") or "")
    master["authorities"]["topic"] = topics_list
    if "meta" in master and isinstance(master["meta"].get("counts"), dict):
        master["meta"]["counts"]["topic"] = len(topics_list)
        note = "Topics minted/linked via _mint_and_link_topics.py from catalog demand + BITS-aware aliases."
        notes = master["meta"].get("notes")
        if isinstance(notes, list) and note not in notes:
            notes.append(note)

    (AUTH / "authorities.json").write_text(
        json.dumps(master, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
    )
    write_type_split(master)
    alias_map = rebuild_alias_map(master)
    (AUTH / "alias-map.json").write_text(
        json.dumps(alias_map, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
    )

    # Rebuild label → topic id including new alts
    topic_alias: dict[str, str] = {}
    for item in topics_list:
        tid = item["id"]
        for lab in [item.get("prefLabel"), item.get("indexTerm"), *(item.get("altLabels") or [])]:
            if isinstance(lab, str) and lab.strip():
                topic_alias[norm_phrase(lab)] = tid
    for np, tid in phrase_to_topic.items():
        topic_alias.setdefault(np, tid)

    minted_ids = {m["id"] for m in minted}

    # Link sources
    linked_new = Counter()  # topic_id → sources newly having it after
    sources_changed = 0
    links_added = 0

    for path in sorted(EXT.glob("chapter-*.json")):
        data = json.loads(path.read_text(encoding="utf-8"))
        dirty = False
        for source in (data.get("sources") or []) + (data.get("notes_sources") or []):
            key = source.get("source_key")
            topic_ids = list(source.get("topic_ids") or [])
            # scrub non-topic ids if any remain
            topic_ids = [x for x in topic_ids if isinstance(x, str) and x.startswith("topic:")]
            before = list(topic_ids)
            seen = set(topic_ids)

            def add(tid: str) -> None:
                nonlocal links_added
                if not tid or not tid.startswith("topic:") or tid in seen:
                    return
                seen.add(tid)
                topic_ids.append(tid)
                links_added += 1

            # Historical phrases on this source
            for phrase in source_phrases.get(key or "", []):
                tid = topic_alias.get(norm_phrase(phrase))
                if tid:
                    add(tid)

            # Title / summary / book_role for minted topics (multi-word / long labels only)
            blob = " ".join(
                [
                    source.get("title") or "",
                    source.get("summary") or "",
                    source.get("book_role") or "",
                ]
            )
            if blob.strip():
                for item in minted:
                    tid = item["id"]
                    labels = [item.get("prefLabel"), *(item.get("altLabels") or [])]
                    safe = []
                    for lab in labels:
                        if not lab:
                            continue
                        # Avoid single short tokens ("RdRp" ok via historical tags only)
                        if " " not in lab and "-" not in lab and len(lab) < 12:
                            continue
                        safe.append(lab)
                    if any(text_has_label(blob, lab) for lab in safe):
                        add(tid)

            if topic_ids != before:
                source["topic_ids"] = topic_ids
                dirty = True
                sources_changed += 1
            for tid in topic_ids:
                if tid in minted_ids:
                    linked_new[tid] += 1

        if dirty:
            path.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")

    report = {
        "baseline_commit": BASELINE_COMMIT,
        "topics_before": 37,
        "topics_after": len(topics_list),
        "minted_count": len(minted),
        "minted": [
            {
                "id": m["id"],
                "prefLabel": m["prefLabel"],
                "altLabels": m.get("altLabels") or [],
                "source_links": linked_new.get(m["id"], 0),
            }
            for m in sorted(minted, key=lambda x: (-linked_new.get(x["id"], 0), x["prefLabel"].casefold()))
        ],
        "sources_changed": sources_changed,
        "topic_id_links_added": links_added,
        "existing_alts_added": {k: sorted(v) for k, v in sorted(alts_to_add.items())},
    }
    out = ROOT / "topic-mint-report.json"
    out.write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(json.dumps({k: report[k] for k in ("topics_before", "topics_after", "minted_count", "sources_changed", "topic_id_links_added")}, indent=2))
    print("minted by frequency:")
    for row in report["minted"]:
        print(f"  {row['source_links']:3}  {row['prefLabel']} ({row['id']})")


if __name__ == "__main__":
    main()
