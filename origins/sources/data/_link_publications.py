#!/usr/bin/env python3
"""Link bibliographic publication strings to org authorities.

Keeps the display `publication` field unchanged. Writes:
  - publication_ids: ordered org authority ids for resolved venues/issuers
  - merges those ids into entity_ids.orgs
  - adds prefLabels into entities.orgs when missing

Mints corpus-extension org authorities for frequent unmatched venues.
"""

from __future__ import annotations

import json
import re
import unicodedata
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parent
AUTH = ROOT / "authority"
EXT = ROOT / "extended"

# Manual aliases for common venue strings → existing or preferred labels
MANUAL_ALIASES = {
    "nyt": "New York Times",
    "nytimes": "New York Times",
    "the new york times": "New York Times",
    "new york times": "New York Times",
    "wsj": "Wall Street Journal",
    "the wall street journal": "Wall Street Journal",
    "wapo": "Washington Post",
    "the washington post": "Washington Post",
    "washington post": "Washington Post",
    "the washington times": "Washington Times",
    "ap": "Associated Press",
    "associated press": "Associated Press",
    "bbc": "BBC News",
    "bbc news": "BBC News",
    "the intercept": "The Intercept",
    "usrtk": "U.S. Right to Know",
    "u.s. right to know": "U.S. Right to Know",
    "us right to know": "U.S. Right to Know",
    "twitter (x)": "Twitter",
    "x (twitter)": "Twitter",
    "x": "Twitter",
    "genbank (ncbi)": "GenBank",
    "ncbi genbank": "GenBank",
    "the lancet": "The Lancet",
    "lancet": "The Lancet",
    "pnas": "PNAS",
    "proceedings of the national academy of sciences": "PNAS",
    "u.s. house of representatives": "U.S. House of Representatives",
    "us house of representatives": "U.S. House of Representatives",
    "u.s. senate": "U.S. Senate",
    "us senate": "U.S. Senate",
    "u.s. congress": "U.S. Congress",
    "us congress": "U.S. Congress",
}


def norm(s: str) -> str:
    s = unicodedata.normalize("NFKC", s or "")
    s = s.lower().replace("’", "'").replace("‘", "'")
    s = s.replace("–", "-").replace("—", "-")
    s = re.sub(r"[^a-z0-9+./&-]+", " ", s)
    return re.sub(r"\s+", " ", s).strip()


def slugify(s: str) -> str:
    s = unicodedata.normalize("NFKD", s or "")
    s = "".join(ch for ch in s if not unicodedata.combining(ch))
    s = s.lower()
    s = re.sub(r"[^a-z0-9]+", "-", s).strip("-")
    return s or "unknown"


def parse_publication_string(publication: str) -> list[str]:
    """Split compound venues; keep display tokens trimed."""
    if not (publication or "").strip():
        return []
    text = publication.strip()
    # Split on slashes and " / " style compounds
    parts = re.split(r"\s*/\s*", text)
    out = []
    for part in parts:
        part = part.strip(" ,;")
        if not part:
            continue
        # Drop empty remnants
        out.append(part)
    return out[:8]


class OrgResolver:
    def __init__(self, master: dict):
        self.master = master
        self.concepts: dict[str, dict] = {}
        self.alias: dict[str, str] = {}
        for item in master["authorities"].get("org", []):
            self.concepts[item["id"]] = item
            self._index_item(item)

    def _index_item(self, item: dict) -> None:
        cid = item["id"]
        labels = [item.get("prefLabel"), item.get("indexTerm"), *(item.get("altLabels") or [])]
        for lab in labels:
            n = norm(lab or "")
            if len(n) >= 2:
                self.alias.setdefault(n, cid)

    def load_alias_map(self, path: Path) -> None:
        data = json.loads(path.read_text(encoding="utf-8"))
        for key, cid in data.items():
            if isinstance(cid, str) and cid.startswith("org:") and cid in self.concepts:
                n = norm(key)
                if n:
                    self.alias.setdefault(n, cid)

    def resolve(self, name: str) -> str | None:
        raw = (name or "").strip()
        if not raw:
            return None
        # manual rewrite then resolve
        rewritten = MANUAL_ALIASES.get(norm(raw), raw)
        for candidate in (rewritten, raw):
            n = norm(candidate)
            if n in self.alias:
                return self.alias[n]
            # strip leading The
            if n.startswith("the ") and n[4:] in self.alias:
                return self.alias[n[4:]]
        return None

    def mint_org(self, display_name: str, alt_labels: list[str] | None = None) -> dict:
        label = MANUAL_ALIASES.get(norm(display_name), display_name.strip())
        cid = f"org:{slugify(label)}"
        base = cid
        i = 2
        while cid in self.concepts:
            cid = f"{base}-{i}"
            i += 1
        alts = list(alt_labels or [])
        # keep original string as alt when rewritten
        if norm(display_name) != norm(label) and display_name not in alts:
            alts.append(display_name)
        item = {
            "id": cid,
            "prefLabel": label,
            "indexTerm": label,
            "altLabels": alts,
            "related": [],
            "subentries": [],
            "pages": [],
            "source": "corpus-extension",
        }
        self.concepts[cid] = item
        self.master["authorities"].setdefault("org", []).append(item)
        self._index_item(item)
        return item


def rebuild_alias_map(master: dict) -> dict[str, str]:
    out: dict[str, str] = {}
    for type_name, items in master["authorities"].items():
        for item in items:
            cid = item["id"]
            labels = [item.get("prefLabel"), item.get("indexTerm"), *(item.get("altLabels") or [])]
            for lab in labels:
                n = norm(lab or "")
                if n and n not in out:
                    out[n] = cid
            if cid.startswith("person:"):
                pref = item.get("prefLabel") or ""
                index_term = item.get("indexTerm") or ""
                # light bridges already handled in author linker; keep simple here
                if "," in index_term:
                    last, rest = [x.strip() for x in index_term.split(",", 1)]
                    if last and rest:
                        n = norm(f"{rest} {last}")
                        if n and n not in out:
                            out[n] = cid
                parts = pref.split()
                if 2 <= len(parts) <= 5:
                    n = norm(f"{parts[-1]}, {' '.join(parts[:-1])}")
                    if n and n not in out:
                        out[n] = cid
    # ensure manual publication aliases point at orgs when present
    # (resolved after minting via prefLabel match in linker runtime)
    return dict(sorted(out.items(), key=lambda kv: kv[0]))


def write_type_split(master: dict) -> None:
    mapping = {
        "person": "persons.json",
        "org": "orgs.json",
        "place": "places.json",
        "topic": "topics.json",
        "event": "events.json",
        "work": "works.json",
    }
    for type_name, filename in mapping.items():
        payload = {"type": type_name, "items": master["authorities"].get(type_name, [])}
        (AUTH / filename).write_text(
            json.dumps(payload, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
        )


def main() -> None:
    master = json.loads((AUTH / "authorities.json").read_text(encoding="utf-8"))
    resolver = OrgResolver(master)
    resolver.load_alias_map(AUTH / "alias-map.json")

    chapter_files = sorted(EXT.glob("chapter-*.json"))
    token_freq: Counter[str] = Counter()
    parsed_by_source: dict[str, list[str]] = {}

    for path in chapter_files:
        data = json.loads(path.read_text(encoding="utf-8"))
        for source in (data.get("sources") or []) + (data.get("notes_sources") or []):
            key = source.get("source_key") or f"ch{data['chapter']:02d}-s{source['id']:02d}"
            tokens = parse_publication_string(source.get("publication") or "")
            parsed_by_source[key] = tokens
            for tok in tokens:
                token_freq[tok] += 1

    minted = []
    for name, count in token_freq.most_common():
        if count < 2:
            continue
        if resolver.resolve(name):
            continue
        # mint frequent venues
        item = resolver.mint_org(name)
        minted.append((name, item["id"], count))

    stats = Counter()
    unresolved: Counter[str] = Counter()

    for path in chapter_files:
        data = json.loads(path.read_text(encoding="utf-8"))
        changed = False
        for source in (data.get("sources") or []) + (data.get("notes_sources") or []):
            key = source.get("source_key") or f"ch{data['chapter']:02d}-s{source['id']:02d}"
            tokens = parsed_by_source.get(key) or parse_publication_string(source.get("publication") or "")
            publication_ids: list[str] = []
            for tok in tokens:
                cid = resolver.resolve(tok)
                if cid and cid not in publication_ids:
                    publication_ids.append(cid)
                    stats["resolved_tokens"] += 1
                elif tok:
                    stats["unresolved_tokens"] += 1
                    unresolved[tok] += 1

            if source.get("publication_ids") != publication_ids:
                changed = True
                stats["sources_changed"] += 1
            source["publication_ids"] = publication_ids

            entities = source.get("entities") or {"people": [], "orgs": [], "places": []}
            entity_ids = source.get("entity_ids") or {"people": [], "orgs": [], "places": []}
            for bucket in ("people", "orgs", "places"):
                entities.setdefault(bucket, [])
                entity_ids.setdefault(bucket, [])

            for cid in publication_ids:
                item = resolver.concepts[cid]
                pref = item["prefLabel"]
                if cid not in entity_ids["orgs"]:
                    entity_ids["orgs"].append(cid)
                    changed = True
                if pref not in entities["orgs"]:
                    entities["orgs"].append(pref)
                    changed = True

            source["entities"] = entities
            source["entity_ids"] = entity_ids
            if publication_ids:
                stats["sources_with_publication_ids"] += 1
            elif source.get("publication"):
                stats["sources_publication_unresolved"] += 1
            else:
                stats["sources_no_publication"] += 1

        if changed:
            path.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")

    if "meta" in master:
        note = "Publications linked via _link_publications.py; corpus-extension orgs minted for frequent venues."
        existing = master["meta"].get("notes")
        if isinstance(existing, list):
            if note not in existing:
                existing.append(note)
        elif isinstance(existing, str) and existing.strip():
            master["meta"]["notes"] = existing.strip() + " " + note
        else:
            master["meta"]["notes"] = [note]

    (AUTH / "authorities.json").write_text(
        json.dumps(master, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
    )
    write_type_split(master)

    existing_map = json.loads((AUTH / "alias-map.json").read_text(encoding="utf-8"))
    rebuilt = rebuild_alias_map(master)
    valid_ids = {item["id"] for items in master["authorities"].values() for item in items}
    final_alias = dict(rebuilt)
    for key, cid in existing_map.items():
        if isinstance(cid, str) and cid in valid_ids:
            final_alias.setdefault(key, cid)
    for alias_key, label in MANUAL_ALIASES.items():
        cid = resolver.resolve(label)
        if cid:
            final_alias.setdefault(alias_key, cid)
            final_alias.setdefault(norm(label), cid)

    (AUTH / "alias-map.json").write_text(
        json.dumps(dict(sorted(final_alias.items(), key=lambda kv: kv[0])), indent=2, ensure_ascii=False)
        + "\n",
        encoding="utf-8",
    )

    report = {
        "stats": dict(stats),
        "minted_orgs": [{"name": n, "id": i, "count": c} for n, i, c in minted],
        "unresolved_top": unresolved.most_common(40),
        "org_authority_count": len(master["authorities"]["org"]),
    }
    (ROOT / "publication-link-report.json").write_text(
        json.dumps(report, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
    )
    print(json.dumps(report["stats"], indent=2))
    print("minted_orgs", len(minted))
    for row in minted[:25]:
        print(" ", row)
    print("unresolved_top:")
    for name, c in unresolved.most_common(15):
        print(f"  {c:3d}  {name}")


if __name__ == "__main__":
    main()
