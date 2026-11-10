#!/usr/bin/env python3
"""Build lean extended chapter JSON from scrape log + artifacts + notes."""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path
from urllib.parse import urlparse

EXTENDED = Path(__file__).resolve().parent
DATA = EXTENDED.parent
ART = EXTENDED / "artifacts"
LOGS = EXTENDED / "logs"
NOTES = DATA / "notes"

CHAPTER_TITLES = {
    0: "Prologue: Night Train to Wuhan",
    1: "The First Time I Heard of the Virus",
    2: "Bioweapons?",
    3: "Fauci Receives the Email",
    4: "Bats, Yunnan, 2013",
    5: "Pangolins",
    6: "Conspiracy Theories Condemned",
    7: "Everything Is Under Control",
    8: "Aftermath",
    9: "WHO Goes to China",
    10: "The Floodgates Open",
    11: "The Mojiang Connection",
    12: "What Did They Study in Wuhan?",
    13: "Chasing Shadows – Who Are “They”?",
    14: "Blueprint for a Pandemic? DARPA DEFUSE",
    15: "The US Biodefense Complex",
    16: "Covert Operations",
    17: "Enigma",
    18: "Fog of War",
    19: "Revelations",
}

PRINTED_PAGES = {
    0: (1, 13), 1: (14, 26), 2: (27, 37), 3: (38, 47), 4: (48, 57),
    5: (58, 67), 6: (68, 77), 7: (78, 85), 8: (86, 98), 9: (99, 109),
    10: (110, 123), 11: (124, 136), 12: (137, 146), 13: (147, 157),
    14: (158, 168), 15: (169, 182), 16: (183, 197), 17: (198, 213),
    18: (214, 225), 19: (226, 245),
}

PAYWALL_MARKERS = [
    "subscribe to continue",
    "create your free account",
    "already a subscriber",
    "this is a preview of subscription",
    "access via your institution",
    "sign in to continue",
    "for subscribers",
    "wsj.com/market-data",
]


def host(url: str) -> str:
    return urlparse(url).netloc.lower().removeprefix("www.") if url else ""


def content_kind(url: str, typ: str) -> str:
    h = host(url)
    u = (url or "").lower()
    t = (typ or "").lower()
    if "youtube" in h or "youtu.be" in h or "video" in t:
        return "video"
    if "twitter.com" in h or h in {"x.com"} or "twitter" in t or "social" in t:
        return "social"
    if u.endswith(".pdf") or "/pdf" in u or "foia" in t or "deposition" in t:
        if u.endswith(".pdf") or "/pdf" in u:
            return "pdf"
    if "amazon.com" in h:
        return "landing"
    if any(x in h for x in ("who.int", "nih.gov", "congress.gov", "house.gov", "govinfo.gov", "whitehouse.gov", "defense.gov", "cdc.gov")) or "official" in t or "government" in t:
        return "gov_doc"
    if "preprint" in t or "biorxiv" in h or "medrxiv" in h:
        return "preprint"
    if "book" in t:
        return "landing"
    return "html_article"


def language_of(text: str, url: str) -> str:
    # crude CJK detection
    if text and len(re.findall(r"[\u4e00-\u9fff]", text[:2000])) > 40:
        return "zh"
    return "en"


def people_from_author(author: str) -> list[str]:
    if not author:
        return []
    a = author.replace(" et al.", "").replace(" et al", "")
    parts = re.split(r",\s*and\s+|;\s*|\s+and\s+", a)
    out = []
    for p in parts:
        p = p.strip(" ,")
        if not p or p.lower() in {"et al", "et al."}:
            continue
        # "Last, First" keep as-is if comma once
        if p.count(",") == 1 and len(p) < 60:
            last, first = [x.strip() for x in p.split(",", 1)]
            out.append(f"{first} {last}".strip())
        else:
            out.append(p)
    return out[:8]


def topics_from(title: str, typ: str) -> list[str]:
    keys = []
    blob = f"{title} {typ}".lower()
    mapping = [
        ("fauci", "Anthony Fauci"),
        ("gain-of-function", "gain-of-function"),
        ("gain of function", "gain-of-function"),
        ("wuhan", "Wuhan"),
        ("ecohealth", "EcoHealth Alliance"),
        ("baric", "Ralph Baric"),
        ("shi zhengli", "Shi Zhengli"),
        ("bat", "bat coronaviruses"),
        ("pangolin", "pangolins"),
        ("furin", "furin cleavage site"),
        ("defuse", "DARPA DEFUSE"),
        ("mojiang", "Mojiang"),
        ("who", "WHO"),
        ("foia", "FOIA"),
        ("lab leak", "lab leak"),
        ("lab-made", "lab origin"),
        ("bioweapon", "bioweapons"),
        ("huanan", "Huanan Seafood Market"),
    ]
    for needle, label in mapping:
        if needle in blob and label not in keys:
            keys.append(label)
    if not keys and title:
        # fallback: first 4 content words
        words = [w for w in re.findall(r"[A-Za-z0-9\-]+", title) if len(w) > 3][:4]
        keys = words
    return keys[:6]


def clean_text(md: str) -> str:
    md = re.sub(r"!\[[^\]]*\]\([^)]*\)", " ", md)
    md = re.sub(r"\[([^\]]+)\]\([^)]*\)", r"\1", md)
    md = re.sub(r"[#>*`]+", " ", md)
    lines = []
    for ln in md.splitlines():
        s = ln.strip()
        if len(s) < 40:
            continue
        if s.lower().startswith("skip to"):
            continue
        if "wayback machine" in s.lower():
            continue
        lines.append(s)
    return " ".join(lines)


def summarize(title: str, typ: str, publication: str, text: str, status: str) -> str:
    if status in ("empty_url", "skipped", "blocked", "not_found", "error"):
        why = {
            "empty_url": "No public URL in the bibliography.",
            "skipped": "Skipped under scrape policy (social/video).",
            "blocked": "Could not be retrieved (site block or unsupported host).",
            "not_found": "URL returned not found.",
            "error": "Scrape failed.",
        }[status]
        return f"{title} ({publication or typ or 'source'}). {why} Citation retained from the chapter bibliography."
    if status == "paywall":
        return f"{title}. Partial or paywalled retrieval from {publication or 'the publisher'}; full text not available in the corpus artifact."
    body = clean_text(text)[:600]
    if len(body) > 120:
        # take first 2 sentences-ish
        parts = re.split(r"(?<=[.!?])\s+", body)
        snip = " ".join(parts[:2]).strip()
        if len(snip) > 80:
            return snip[:450] + ("…" if len(snip) > 450 else "")
    return f"{title}. Source from {publication or typ}, captured for the chapter research corpus."


def detect_status(base_status: str, text: str, url: str) -> str:
    if base_status != "ok":
        return base_status
    low = (text or "").lower()
    if any(m in low for m in PAYWALL_MARKERS):
        # only if short body
        if len(clean_text(text)) < 800:
            return "paywall"
    h = host(url)
    if h in {"nytimes.com", "ft.com"}:
        return "blocked"
    if h == "wsj.com" and len(clean_text(text)) < 800:
        return "paywall"
    if len((text or "").strip()) < 200:
        return "error"
    return "ok"


def book_role(ch: int, title: str, notes: str) -> str:
    ct = CHAPTER_TITLES.get(ch, f"Chapter {ch}")
    # if notes mention a distinctive phrase from title, bias toward that
    short = title[:80]
    return f"Supports Chapter {ch} (“{ct}”) as bibliographic evidence for: {short}."


def build(ch: int) -> dict:
    src = json.loads((DATA / f"chapter-{ch:02d}.json").read_text(encoding="utf-8"))
    log = json.loads((LOGS / f"chapter-{ch:02d}.scrape.log.json").read_text(encoding="utf-8"))
    by_id = {r["id"]: r for r in log["sources"]}
    notes = ""
    np = NOTES / f"{ch:02d}.html"
    if np.exists():
        notes = np.read_text(encoding="utf-8", errors="replace")

    start, end = PRINTED_PAGES[ch]
    out_sources = []
    for s in src["sources"]:
        r = by_id.get(s["id"], {})
        sid = f"ch{ch:02d}-s{s['id']:02d}"
        url = (s.get("url") or "").strip()
        art_rel = r.get("artifact") or (f"artifacts/{sid}.md" if (ART / f"{sid}.md").exists() else None)
        text = ""
        if art_rel and (EXTENDED / art_rel).exists():
            text = (EXTENDED / art_rel).read_text(encoding="utf-8", errors="replace")
        status = detect_status(r.get("status") or "error", text, url)
        if status in ("blocked", "error", "empty_url", "skipped", "not_found") and not text:
            art_rel = None
        if status in ("blocked", "error") and text and len(text) < 250:
            # drop junk artifacts
            p = EXTENDED / art_rel if art_rel else None
            if p and p.exists() and p.stat().st_size < 250:
                p.unlink(missing_ok=True)
                art_rel = None

        people = people_from_author(s.get("author") or "")
        orgs = []
        if s.get("publication"):
            orgs.append(s["publication"])
        places = []
        blob = f"{s.get('title','')} {clean_text(text)[:500]}"
        for place in ["Wuhan", "Yunnan", "Beijing", "China", "United States", "Mojiang", "Hubei", "Chapel Hill", "Washington"]:
            if place.lower() in blob.lower() and place not in places:
                places.append(place)

        rec = {
            **{k: s.get(k, "") for k in ("id", "type", "author", "title", "publication", "date", "url")},
            "status": status,
            "artifact": art_rel,
            "content_kind": content_kind(url, s.get("type") or ""),
            "language": language_of(text, url),
            "summary": summarize(s.get("title") or "", s.get("type") or "", s.get("publication") or "", text, status),
            "book_role": book_role(ch, s.get("title") or "", notes),
            "topics": topics_from(s.get("title") or "", s.get("type") or ""),
            "entities": {"people": people, "orgs": orgs[:6], "places": places[:6]},
        }
        out_sources.append(rec)

    return {
        "chapter": ch,
        "chapter_title": CHAPTER_TITLES[ch],
        "printed_pages": {"start": start, "end": end},
        "sources": out_sources,
    }


def main() -> int:
    ch = int(sys.argv[1])
    data = build(ch)
    out = EXTENDED / f"chapter-{ch:02d}.json"
    out.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"wrote {out} ({len(data['sources'])} sources)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
