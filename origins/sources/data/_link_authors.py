#!/usr/bin/env python3
"""Link bibliographic author strings to person/org authorities.

Keeps the display `author` field unchanged. Writes:
  - author_ids: ordered authority ids for resolved contributors
  - merges those ids into entity_ids.people / entity_ids.orgs
  - adds prefLabels into entities.people / entities.orgs when missing

Optionally mints corpus-extension person/org authorities for frequent
unmatched contributors that look like real people or known org bylines.
"""

from __future__ import annotations

import json
import re
import unicodedata
from collections import Counter, defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parent
AUTH = ROOT / "authority"
EXT = ROOT / "extended"

ORG_HINTS = re.compile(
    r"\b("
    r"committee|commission|agency|department|institute|university|ministry|"
    r"office|house|senate|congress|organization|organisation|who|cdc|nih|"
    r"niaid|bbc|reuters|associated press|news|police|bureau|alliance|"
    r"foundation|trust|journal|nature|science|lancet|promed|genbank|"
    r"government|administration|council|laboratory|lab\b|center|centre|"
    r"press\b|symposium"
    r")\b",
    re.I,
)

def looks_like_handle(name: str) -> bool:
    """@user, HumbleScientist, TheSeeker268 — not 'Betsy McKay'."""
    s = (name or "").strip()
    if not s or " " in s or "," in s:
        return s.startswith("@")
    if s.startswith("@"):
        return True
    # CamelCase or letters+digits single token
    return bool(re.fullmatch(r"[A-Za-z]*[a-z][A-Z][A-Za-z0-9]*", s)) or bool(
        re.fullmatch(r"[A-Za-z]+\d+", s)
    )


def is_initial_token(tok: str) -> bool:
    """True for B, L., X.Y., Z.-L. — not for Yu, Ed, Amy."""
    letters = re.findall(r"[A-Za-z]+", tok or "")
    if not letters:
        return False
    return all(len(g) == 1 for g in letters)


def norm(s: str) -> str:
    s = unicodedata.normalize("NFKC", s or "")
    s = s.lower().replace("’", "'").replace("‘", "'")
    s = s.replace("–", "-").replace("—", "-")
    s = re.sub(r"[^a-z0-9+./-]+", " ", s)
    return re.sub(r"\s+", " ", s).strip()


def slugify(s: str) -> str:
    s = unicodedata.normalize("NFKD", s or "")
    s = "".join(ch for ch in s if not unicodedata.combining(ch))
    s = s.lower()
    s = re.sub(r"[^a-z0-9]+", "-", s).strip("-")
    return s or "unknown"


def natural_from_inverted(name: str) -> str | None:
    """'Last, First Middles' -> 'First Middles Last' when clearly inverted."""
    if name.count(",") != 1:
        return None
    last, rest = [x.strip() for x in name.split(",", 1)]
    if not last or not rest:
        return None
    if ORG_HINTS.search(name):
        return None
    # reject committee-like "U.S. Senate …"
    if re.search(r"\b(u\.?s\.?|united states)\b", last, re.I) and " " in rest:
        return None
    if len(rest.split()) > 4:
        return None
    return f"{rest} {last}".strip()


def inverted_from_natural(name: str) -> str | None:
    parts = name.split()
    if len(parts) < 2 or len(parts) > 5:
        return None
    if ORG_HINTS.search(name):
        return None
    if any(ch.isdigit() for ch in name):
        return None
    last = parts[-1]
    first = " ".join(parts[:-1])
    return f"{last}, {first}"


def looks_like_person(name: str) -> bool:
    if not name or len(name) < 3:
        return False
    if ORG_HINTS.search(name):
        return False
    if name.count(",") == 1:
        last, rest = [x.strip() for x in name.split(",", 1)]
        return bool(last and rest) and len(rest.split()) <= 4
    parts = name.replace(".", "").split()
    return 2 <= len(parts) <= 4 and all(p[:1].isalpha() for p in parts)


def _given_tokens(name: str) -> list[str]:
    if name.count(",") == 1:
        _last, rest = [x.strip() for x in name.split(",", 1)]
        return [t for t in re.split(r"\s+", rest) if t]
    parts = name.split()
    return parts[:-1] if len(parts) >= 2 else []


def looks_like_clear_person(name: str) -> bool:
    """Person-like name with a real given name (not handle / initials-only)."""
    if not looks_like_person(name):
        return False
    if looks_like_handle(name):
        return False
    given = _given_tokens(name)
    if not given:
        return False
    # At least one given-name token with 2+ letters (Anthony, Chaolin) — not only B / X.Y.
    return any(not is_initial_token(tok) and len(re.sub(r"[^A-Za-z]", "", tok)) >= 2 for tok in given)


def strip_initial_tokens(name: str) -> str | None:
    """'Anthony S. Fauci' / 'Fauci, Anthony S.' → drop single-letter initials."""
    natural = natural_from_inverted(name) or name
    parts = [p for p in natural.split() if p]
    if len(parts) < 2:
        return None
    kept = []
    for i, p in enumerate(parts):
        # Keep surname (last) always; drop middle/first initial tokens.
        if i == len(parts) - 1:
            kept.append(p)
            continue
        if is_initial_token(p):
            continue
        kept.append(p)
    if len(kept) < 2:
        return None
    return " ".join(kept)


def extract_inverted_pairs(text: str) -> list[str]:
    """'Dong, Ensheng, Du, Hongru' → ['Dong, Ensheng', 'Du, Hongru'] when evenly paired."""
    parts = [p.strip() for p in text.split(",") if p.strip()]
    if len(parts) < 2 or len(parts) % 2 != 0:
        return []
    pairs: list[str] = []
    for i in range(0, len(parts), 2):
        last, first = parts[i], parts[i + 1]
        # Surname should be a single token; given may include initials (Jesse D.).
        if " " in last or not last or not first:
            return []
        pairs.append(f"{last}, {first}")
    return pairs


def parse_author_string(author: str) -> list[str]:
    """Return ordered contributor name strings (bibliographic tokens)."""
    if not (author or "").strip():
        return []
    text = author.strip()
    text = re.sub(r",?\s*et\s+al\.?\s*$", "", text, flags=re.I).strip(" ,;")
    if not text:
        return []

    # "Last, First, with Other Author"
    text = re.sub(r",\s*with\s+", "; ", text, flags=re.I)

    # Semicolon-separated contributor list
    if ";" in text:
        parts = [p.strip(" ,") for p in text.split(";")]
        out = []
        for p in parts:
            p = re.sub(r",?\s*et\s+al\.?\s*$", "", p, flags=re.I).strip(" ,")
            if p:
                out.append(p)
        return out[:12]

    # "Last, First, and First2 Last2" or "Last, First, and Last2, First2"
    m = re.search(r",\s*and\s+", text, flags=re.I)
    if m:
        left = text[: m.start()].strip(" ,")
        right = text[m.end() :].strip(" ,")
        out = []
        if left:
            pairs = extract_inverted_pairs(left)
            if pairs:
                out.extend(pairs)
            else:
                inv = re.match(r"^([^,]+),\s*([^,]+)$", left)
                if inv:
                    out.append(left)
                else:
                    m2 = re.match(r"^([^,]+),\s*([^,]+)", left)
                    if m2:
                        out.append(f"{m2.group(1).strip()}, {m2.group(2).strip()}")
                    else:
                        out.append(left)
        if right:
            right_pairs = extract_inverted_pairs(right)
            if right_pairs:
                out.extend(right_pairs)
            else:
                out.append(right)
        return out[:12]

    # "First Last and First2 Last2"
    m = re.search(r"\s+and\s+", text, flags=re.I)
    if m and text.count(",") == 0:
        left = text[: m.start()].strip()
        right = text[m.end() :].strip()
        return [p for p in (left, right) if p][:12]

    # Single token (person inverted, natural, or org)
    return [text]


class AuthorityResolver:
    def __init__(self, master: dict):
        self.master = master
        self.concepts: dict[str, dict] = {}
        self.alias: dict[str, str] = {}
        for type_name, items in master["authorities"].items():
            for item in items:
                self.concepts[item["id"]] = item
                self._index_item(item)

    def _index_item(self, item: dict) -> None:
        cid = item["id"]
        labels = [item.get("prefLabel"), item.get("indexTerm"), *(item.get("altLabels") or [])]
        for lab in labels:
            n = norm(lab or "")
            if len(n) >= 2:
                self.alias.setdefault(n, cid)
        # inverted / natural bridges for persons and orgs with person-like labels
        pref = item.get("prefLabel") or ""
        index_term = item.get("indexTerm") or ""
        for form in filter(None, [natural_from_inverted(index_term), inverted_from_natural(pref)]):
            n = norm(form)
            if n:
                self.alias.setdefault(n, cid)

    def load_alias_map(self, path: Path) -> None:
        data = json.loads(path.read_text(encoding="utf-8"))
        for key, cid in data.items():
            if isinstance(cid, str) and cid in self.concepts:
                n = norm(key)
                if n:
                    self.alias.setdefault(n, cid)

    def resolve(self, name: str) -> str | None:
        n = norm(name)
        if n in self.alias:
            return self.alias[n]
        natural = natural_from_inverted(name)
        if natural:
            hit = self.alias.get(norm(natural))
            if hit:
                return hit
            # "Tedros Ghebreyesus" vs prefLabel "Tedros Adhanom Ghebreyesus"
            hit = self._unique_person_token_match(natural)
            if hit:
                return hit
            stripped = strip_initial_tokens(natural)
            if stripped and norm(stripped) != norm(natural):
                hit = self.alias.get(norm(stripped))
                if hit:
                    return hit
                hit = self._unique_person_token_match(stripped)
                if hit:
                    return hit
        inverted = inverted_from_natural(name)
        if inverted:
            hit = self.alias.get(norm(inverted))
            if hit:
                return hit
        if looks_like_person(name) and name.count(",") == 0:
            hit = self._unique_person_token_match(name)
            if hit:
                return hit
            stripped = strip_initial_tokens(name)
            if stripped and norm(stripped) != norm(name):
                hit = self.alias.get(norm(stripped))
                if hit:
                    return hit
                hit = self._unique_person_token_match(stripped)
                if hit:
                    return hit
        return None

    def _unique_person_token_match(self, name: str) -> str | None:
        tokens = set(norm(name).split())
        if len(tokens) < 2:
            return None
        hits = []
        for cid, item in self.concepts.items():
            if not cid.startswith("person:"):
                continue
            pref_tokens = set(norm(item.get("prefLabel") or "").split())
            if tokens <= pref_tokens and tokens & pref_tokens:
                hits.append(cid)
        if len(hits) == 1:
            return hits[0]
        return None

    def mint_person(self, display_name: str) -> dict:
        natural = natural_from_inverted(display_name) or display_name
        inverted = inverted_from_natural(natural) or (
            display_name if display_name.count(",") == 1 else inverted_from_natural(display_name)
        )
        cid = f"person:{slugify(natural)}"
        # avoid collisions
        base = cid
        i = 2
        while cid in self.concepts:
            cid = f"{base}-{i}"
            i += 1
        item = {
            "id": cid,
            "prefLabel": natural,
            "indexTerm": inverted or natural,
            "altLabels": [],
            "related": [],
            "subentries": [],
            "pages": [],
            "source": "corpus-extension",
        }
        if inverted and norm(inverted) != norm(natural):
            # keep alt empty; alias index covers both forms
            pass
        self.concepts[cid] = item
        self.master["authorities"].setdefault("person", []).append(item)
        self._index_item(item)
        return item

    def mint_org(self, display_name: str, alt_labels: list[str] | None = None) -> dict:
        cid = f"org:{slugify(display_name)}"
        base = cid
        i = 2
        while cid in self.concepts:
            cid = f"{base}-{i}"
            i += 1
        item = {
            "id": cid,
            "prefLabel": display_name,
            "indexTerm": display_name,
            "altLabels": alt_labels or [],
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
            # person name-order bridges
            if cid.startswith("person:"):
                pref = item.get("prefLabel") or ""
                index_term = item.get("indexTerm") or ""
                for form in filter(None, [natural_from_inverted(index_term), inverted_from_natural(pref)]):
                    n = norm(form)
                    if n and n not in out:
                        out[n] = cid
    return dict(sorted(out.items(), key=lambda kv: kv[0]))


def write_type_split(master: dict) -> None:
    for type_name, items in master["authorities"].items():
        filename = {
            "person": "persons.json",
            "org": "orgs.json",
            "place": "places.json",
            "topic": "topics.json",
            "event": "events.json",
            "work": "works.json",
        }[type_name]
        payload = {"type": type_name, "items": items}
        (AUTH / filename).write_text(
            json.dumps(payload, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
        )


def main() -> None:
    master = json.loads((AUTH / "authorities.json").read_text(encoding="utf-8"))
    resolver = AuthorityResolver(master)
    resolver.load_alias_map(AUTH / "alias-map.json")

    # Seed a few high-value org bylines if missing
    for label, alts in [
        ("BBC News", ["BBC"]),
        ("ProMED", ["ProMED-mail", "Program for Monitoring Emerging Diseases"]),
        (
            "U.S. Senate Homeland Security and Governmental Affairs Committee (HSGAC)",
            [
                "HSGAC",
                "U.S. Senate Homeland Security and Governmental Affairs Committee",
                "Senate Homeland Security and Governmental Affairs Committee",
            ],
        ),
    ]:
        if resolver.resolve(label) is None:
            resolver.mint_org(label, alts)

    # Collect contributor frequency (for minting)
    contrib_freq: Counter[str] = Counter()
    chapter_files = sorted(EXT.glob("chapter-*.json"))
    parsed_by_source: dict[str, list[str]] = {}

    for path in chapter_files:
        data = json.loads(path.read_text(encoding="utf-8"))
        for source in (data.get("sources") or []) + (data.get("notes_sources") or []):
            key = source.get("source_key") or f"ch{data['chapter']:02d}-s{source['id']:02d}"
            names = parse_author_string(source.get("author") or "")
            # If full author string resolves as one org/person, prefer that over aggressive splits
            full = (source.get("author") or "").strip()
            full_clean = re.sub(r",?\s*et\s+al\.?\s*$", "", full, flags=re.I).strip(" ,;")
            if full_clean and resolver.resolve(full_clean) and (
                ORG_HINTS.search(full_clean) or full_clean.count(",") == 0
            ):
                names = [full_clean]
            elif full_clean and resolver.resolve(full_clean) is None and ORG_HINTS.search(full_clean):
                # keep as single org-like byline even if unmatched (for minting consideration)
                if ";" not in full_clean and not re.search(r",\s*and\s+", full_clean, re.I):
                    names = [full_clean]
            parsed_by_source[key] = names
            for name in names:
                contrib_freq[name] += 1

    # Mint unmatched clear person names (including single-occurrence bylines).
    # Skip handles, initials-only tokens, and org-like strings.
    minted_people = []
    for name, count in contrib_freq.most_common():
        if resolver.resolve(name):
            continue
        if not looks_like_clear_person(name):
            continue
        item = resolver.mint_person(name)
        minted_people.append((name, item["id"], count))

    # Mint clear org bylines that appear as the whole author string.
    minted_orgs = []
    for name, count in contrib_freq.most_common():
        if resolver.resolve(name):
            continue
        if not ORG_HINTS.search(name):
            continue
        if re.search(r",\s*and\s+|\sand\s+|;", name, re.I):
            continue
        item = resolver.mint_org(name)
        minted_orgs.append((name, item["id"], count))

    # Apply links on every source
    stats = Counter()
    unresolved_samples: Counter[str] = Counter()

    for path in chapter_files:
        data = json.loads(path.read_text(encoding="utf-8"))
        changed = False
        for source in (data.get("sources") or []) + (data.get("notes_sources") or []):
            key = source.get("source_key") or f"ch{data['chapter']:02d}-s{source['id']:02d}"
            names = parsed_by_source.get(key) or parse_author_string(source.get("author") or "")
            author_ids: list[str] = []
            for name in names:
                cid = resolver.resolve(name)
                if cid and cid not in author_ids:
                    author_ids.append(cid)
                    stats["resolved_tokens"] += 1
                elif name:
                    stats["unresolved_tokens"] += 1
                    unresolved_samples[name] += 1

            old_ids = source.get("author_ids")
            source["author_ids"] = author_ids
            if old_ids != author_ids:
                changed = True
                stats["sources_changed"] += 1

            entities = source.get("entities") or {"people": [], "orgs": [], "places": []}
            entity_ids = source.get("entity_ids") or {"people": [], "orgs": [], "places": []}
            for bucket in ("people", "orgs", "places"):
                entities.setdefault(bucket, [])
                entity_ids.setdefault(bucket, [])

            for cid in author_ids:
                item = resolver.concepts[cid]
                pref = item["prefLabel"]
                if cid.startswith("person:"):
                    if cid not in entity_ids["people"]:
                        entity_ids["people"].append(cid)
                        changed = True
                    if pref not in entities["people"]:
                        entities["people"].append(pref)
                        changed = True
                elif cid.startswith("org:"):
                    if cid not in entity_ids["orgs"]:
                        entity_ids["orgs"].append(cid)
                        changed = True
                    if pref not in entities["orgs"]:
                        entities["orgs"].append(pref)
                        changed = True

            source["entities"] = entities
            source["entity_ids"] = entity_ids
            if author_ids:
                stats["sources_with_author_ids"] += 1
            elif source.get("author"):
                stats["sources_author_unresolved"] += 1
            else:
                stats["sources_no_author"] += 1

        if changed:
            path.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")

    # Persist authorities + alias map
    if "meta" in master:
        note = "Authors linked via _link_authors.py; corpus-extension persons/orgs minted for frequent bylines."
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
    alias_map = rebuild_alias_map(master)
    (AUTH / "alias-map.json").write_text(
        json.dumps(alias_map, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
    )

    report = {
        "stats": dict(stats),
        "minted_people": [
            {"name": n, "id": i, "count": c} for n, i, c in minted_people
        ],
        "minted_orgs": [
            {"name": n, "id": i, "count": c} for n, i, c in minted_orgs
        ],
        "unresolved_top": unresolved_samples.most_common(40),
        "person_authority_count": len(master["authorities"]["person"]),
        "org_authority_count": len(master["authorities"]["org"]),
    }
    (ROOT / "author-link-report.json").write_text(
        json.dumps(report, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
    )
    print(json.dumps(report["stats"], indent=2))
    print("minted_people", len(minted_people))
    for row in minted_people[:20]:
        print(" ", row)
    print("minted_orgs", len(minted_orgs))
    for row in minted_orgs[:20]:
        print(" ", row)
    print("unresolved_top:")
    for name, c in unresolved_samples.most_common(20):
        print(f"  {c:3d}  {name}")


if __name__ == "__main__":
    main()
