#!/usr/bin/env python3
"""Strictly link under-linked org authorities from catalog/artifact mentions.

Fixes Sources search gaps where book-index orgs exist but were never attached to
any source (keyword index omits 0-link authorities).

Rules:
  - Only consider orgs currently linked to fewer than 5 sources (sparse).
  - Prefer catalog fields (title/summary/book_role/publication/entities.orgs).
  - Artifacts may confirm; require a distinctive term (len>=5 or multi-word).
  - Never loose-match noisy labels (Science, Nature, Cell, Medium, Twitter, …).
  - Wikipedia: catalog hits only.
"""

from __future__ import annotations

import json
import re
from collections import Counter
from pathlib import Path

from _authority_lib import load_authority_map, labels_for_ids

ROOT = Path(__file__).resolve().parent
EXT = ROOT / "extended"

NOISY = {
    "org:science",
    "org:nature",
    "org:cell",
    "org:medium",
    "org:twitter",
    "org:twitter-x",
    "org:amazon",
    "org:meta",
    "org:cell-press",
    "org:nature-medicine",
}

EXTRA = {
    "org:department-of-energy-us": ["Department of Energy", "Energy Department", "DOE"],
    "org:director-of-national-intelligence": [
        "DNI",
        "ODNI",
        "Office of the Director of National Intelligence",
    ],
    "org:chinese-communist-party": ["CCP", "Communist Party of China"],
    "org:academy-of-military-medical-sciences": ["AMMS"],
    "org:sequence-read-archive": ["Sequence Read Archive", "NCBI SRA"],
    "org:usamriid": ["USAMRIID"],
    "org:lawrence-livermore-national-laboratory": ["Lawrence Livermore", "LLNL"],
    "org:wuhan-institute-of-biological-products": [
        "Wuhan Institute of Biological Products",
        "WIBP",
    ],
    "org:house-oversight-and-reform-committee": ["House Oversight"],
    "org:china-virome-project": ["China Virome Project"],
    "org:chinese-academy-of-medical-sciences": ["Chinese Academy of Medical Sciences", "CAMS"],
    "org:biological-sciences-experts-group": ["Biological Sciences Experts Group", "BSEG"],
}


def terms_for(aid: str, node: dict) -> list[str]:
    out: list[str] = []
    seen: set[str] = set()
    for t in [
        node.get("prefLabel"),
        node.get("indexTerm"),
        *(node.get("altLabels") or []),
        *EXTRA.get(aid, []),
    ]:
        if not isinstance(t, str) or not t.strip():
            continue
        t = t.strip()
        key = t.casefold()
        if key in seen:
            continue
        seen.add(key)
        out.append(t)
    return out


def hits_in(text: str, terms: list[str]) -> list[str]:
    found: list[str] = []
    if not text:
        return found
    for t in terms:
        if len(t) <= 4 and t.isupper():
            if re.search(r"\b" + re.escape(t) + r"\b", text):
                found.append(t)
        elif len(t) <= 4:
            if re.search(r"\b" + re.escape(t) + r"\b", text, flags=re.I):
                found.append(t)
        elif t.casefold() in text.casefold():
            found.append(t)
    return found


def catalog_blob(source: dict) -> str:
    ents = source.get("entities") or {}
    return "\n".join(
        [
            source.get("title") or "",
            source.get("summary") or "",
            source.get("book_role") or "",
            source.get("publication") or "",
            source.get("author") or "",
            " ".join(ents.get("orgs") or []) if isinstance(ents, dict) else "",
        ]
    )


def artifact_text(source: dict) -> str:
    rel = source.get("artifact")
    if not rel:
        return ""
    path = EXT / rel
    if not path.exists():
        return ""
    try:
        return path.read_text(encoding="utf-8", errors="ignore")[:80000]
    except OSError:
        return ""


def count_org_links(auth_ids: set[str] | None = None) -> Counter:
    ctr: Counter = Counter()
    for path in EXT.glob("chapter-*.json"):
        data = json.loads(path.read_text(encoding="utf-8"))
        for source in (data.get("sources") or []) + (data.get("notes_sources") or []):
            ids = set(source.get("publication_ids") or []) | set(source.get("author_ids") or [])
            ents = source.get("entity_ids") or {}
            if isinstance(ents, dict):
                ids |= set(ents.get("orgs") or [])
            for xid in ids:
                if str(xid).startswith("org:"):
                    if auth_ids is None or xid in auth_ids:
                        ctr[xid] += 1
    return ctr


def main() -> None:
    auth = load_authority_map()
    orgs = {
        aid: node
        for aid, node in auth.items()
        if str(aid).startswith("org:") and isinstance(node, dict)
    }
    before = count_org_links()
    sparse = [aid for aid in orgs if before.get(aid, 0) < 5 and aid not in NOISY]
    terms_by = {aid: terms_for(aid, orgs[aid]) for aid in sparse}

    added: Counter = Counter()
    sources_changed = 0

    for path in sorted(EXT.glob("chapter-*.json")):
        data = json.loads(path.read_text(encoding="utf-8"))
        dirty = False
        for source in (data.get("sources") or []) + (data.get("notes_sources") or []):
            ents = source.get("entity_ids")
            if not isinstance(ents, dict):
                ents = {"people": [], "orgs": [], "places": []}
            org_ids = list(ents.get("orgs") or [])
            have = set(org_ids) | set(source.get("publication_ids") or []) | set(
                source.get("author_ids") or []
            )
            cat = catalog_blob(source)
            art = None
            changed = False
            for aid in sparse:
                if aid in have:
                    continue
                terms = terms_by[aid]
                hit = hits_in(cat, terms)
                via = "catalog" if hit else ""
                if not hit:
                    if art is None:
                        art = artifact_text(source)
                    hit = hits_in(art, terms)
                    if hit:
                        via = "artifact"
                if not hit:
                    continue
                if via == "artifact" and not any((" " in t) or len(t) >= 5 for t in hit):
                    continue
                if aid == "org:wikipedia" and via != "catalog":
                    continue
                org_ids.append(aid)
                have.add(aid)
                added[aid] += 1
                changed = True
            if changed:
                ents["orgs"] = org_ids
                source["entity_ids"] = ents
                labels, _ = labels_for_ids(auth, org_ids)
                display = (
                    source.get("entities")
                    if isinstance(source.get("entities"), dict)
                    else {"people": [], "orgs": [], "places": []}
                )
                prev = list(display.get("orgs") or [])
                prefset = {x.casefold() for x in labels}
                orphans = [p for p in prev if p and p.casefold() not in prefset]
                display["orgs"] = labels + orphans
                source["entities"] = display
                dirty = True
                sources_changed += 1
        if dirty:
            path.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")

    after = count_org_links()
    report = {
        "sources_changed": sources_changed,
        "org_link_adds": int(sum(added.values())),
        "added": [
            {
                "id": aid,
                "label": orgs[aid].get("prefLabel"),
                "added": n,
                "sourceCountAfter": after.get(aid, 0),
            }
            for aid, n in added.most_common()
        ],
        "still_zero": [
            orgs[aid].get("prefLabel")
            for aid in sorted(orgs, key=lambda a: (orgs[a].get("prefLabel") or "").casefold())
            if after.get(aid, 0) == 0
        ],
    }
    (ROOT / "org-mention-link-report.json").write_text(
        json.dumps(report, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
    )
    print(json.dumps({k: report[k] for k in ("sources_changed", "org_link_adds", "still_zero")}, indent=2))


if __name__ == "__main__":
    main()
