#!/usr/bin/env python3
"""Dry-run: map Chapter Notes 'Note on Source…' blocks → source_key(s).

Reads notes/NN.html + extended/chapter-NN.json. Writes nothing.

Usage:
  python3 _extract_source_notes_dryrun.py
  python3 _extract_source_notes_dryrun.py --json   # machine-readable summary
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

DATA = Path(__file__).resolve().parent
NOTES = DATA / "notes"
EXTENDED = DATA / "extended"

H3_SPLIT = re.compile(r"(?=<h3\b)", re.I)
H3_TAG = re.compile(r"<h3\b[^>]*>(.*?)</h3>", re.I | re.S)
H2_TAG = re.compile(r"<h2\b[^>]*>.*?</h2>", re.I | re.S)

# Canonical + near-miss headings from the chapter notes corpus.
SOURCE_HEADING = re.compile(
    r"^Notes?\s+(?:on|to)\s+Sources?\s+(.+?)(?:\s*:\s*(.*))?$",
    re.I,
)
REF_CHUNK = re.compile(
    r"^\s*(\d+)\s*(?:–|-|to)\s*(\d+)\s*$|^\s*(\d+)\s*$",
    re.I,
)


def collapse_ws(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip()


def parse_source_ids(refs_blob: str) -> list[int]:
    """Parse '1', '5–6', '4 to 7', '2 and 13', '5 and 8-12'."""
    ids: list[int] = []
    for chunk in re.split(r"\s+and\s+|,\s*", refs_blob, flags=re.I):
        chunk = chunk.strip()
        if not chunk:
            continue
        m = REF_CHUNK.match(chunk)
        if not m:
            continue
        if m.group(1) is not None and m.group(2) is not None:
            a, b = int(m.group(1)), int(m.group(2))
            ids.extend(range(min(a, b), max(a, b) + 1))
        elif m.group(3) is not None:
            ids.append(int(m.group(3)))
    out: list[int] = []
    seen: set[int] = set()
    for i in ids:
        if i not in seen:
            seen.add(i)
            out.append(i)
    return out


def load_chapter_source_ids(chapter: int) -> dict[int, str]:
    """Map main bibliography id → source_key for one chapter."""
    path = EXTENDED / f"chapter-{chapter:02d}.json"
    if not path.is_file():
        return {}
    data = json.loads(path.read_text(encoding="utf-8"))
    mapping: dict[int, str] = {}
    for src in data.get("sources") or []:
        sid = src.get("id")
        key = src.get("source_key")
        if isinstance(sid, int) and key:
            mapping[sid] = key
    return mapping


def strip_heading_html(heading_html: str) -> str:
    text = re.sub(r"<[^>]+>", "", heading_html)
    return collapse_ws(text)


def extract_blocks(html: str) -> list[dict]:
    """Split a notes file into h3 sections (and optional preamble)."""
    html = html.strip()
    parts = H3_SPLIT.split(html)
    blocks: list[dict] = []
    for part in parts:
        part = part.strip()
        if not part:
            continue
        m = H3_TAG.search(part)
        if not m:
            # Preamble / h2-only chunk — not a source note candidate.
            continue
        heading = strip_heading_html(m.group(1))
        body = part[m.end() :].strip()
        # Drop trailing sibling sections accidentally included? split already isolates.
        blocks.append({"heading": heading, "html": body})
    return blocks


def classify_block(heading: str) -> dict | None:
    m = SOURCE_HEADING.match(heading)
    if not m:
        return None
    refs_raw = m.group(1).strip()
    title = (m.group(2) or "").strip() or None
    ids = parse_source_ids(refs_raw)
    return {
        "heading": heading,
        "refs_raw": refs_raw,
        "title": title,
        "source_ids": ids,
    }


def run() -> dict:
    chapters: list[dict] = []
    totals = {
        "source_note_blocks": 0,
        "single": 0,
        "multi": 0,
        "mapped_keys": 0,
        "missing_ids": 0,
        "unparsed_ref_blocks": 0,
        "chapter_section_h3s": 0,
    }

    for path in sorted(NOTES.glob("[0-9][0-9].html")):
        chapter = int(path.stem)
        html = path.read_text(encoding="utf-8")
        id_map = load_chapter_source_ids(chapter)
        source_notes: list[dict] = []
        other_h3: list[str] = []

        for block in extract_blocks(html):
            classified = classify_block(block["heading"])
            if not classified:
                other_h3.append(block["heading"])
                totals["chapter_section_h3s"] += 1
                continue

            ids = classified["source_ids"]
            if not ids:
                totals["unparsed_ref_blocks"] += 1

            keys: list[str] = []
            missing: list[int] = []
            for sid in ids:
                key = id_map.get(sid)
                if key:
                    keys.append(key)
                else:
                    missing.append(sid)

            primary = keys[0] if keys else None
            shared_with = keys[1:] if len(keys) > 1 else []
            row = {
                **classified,
                "html_chars": len(block["html"]),
                "source_keys": keys,
                "primary_key": primary,
                "shared_with": shared_with,
                "missing_ids": missing,
                "multi": len(keys) > 1,
            }
            source_notes.append(row)
            totals["source_note_blocks"] += 1
            if row["multi"]:
                totals["multi"] += 1
            else:
                totals["single"] += 1
            totals["mapped_keys"] += len(keys)
            totals["missing_ids"] += len(missing)

        chapters.append(
            {
                "chapter": chapter,
                "file": path.name,
                "source_notes": source_notes,
                "other_h3": other_h3,
            }
        )

    return {"totals": totals, "chapters": chapters}


def print_report(report: dict) -> None:
    t = report["totals"]
    print("Source-note dry-run (no files written)\n")
    for ch in report["chapters"]:
        notes = ch["source_notes"]
        print(
            f"ch{ch['chapter']:02d} ({ch['file']}): "
            f"{len(notes)} source-note block(s), "
            f"{len(ch['other_h3'])} other <h3>"
        )
        for n in notes:
            ids = ",".join(str(i) for i in n["source_ids"]) or "?"
            keys = ", ".join(n["source_keys"]) or "(none)"
            flags = []
            if n["multi"]:
                flags.append("multi")
            if n["missing_ids"]:
                flags.append(f"MISSING ids={n['missing_ids']}")
            if not n["source_ids"]:
                flags.append("UNPARSED_REFS")
            flag_s = f"  [{', '.join(flags)}]" if flags else ""
            title = f" — {n['title']}" if n["title"] else ""
            print(f"  ids [{ids}] → {keys}{flag_s}")
            print(f"    {n['heading']}")
            if n["primary_key"] and n["shared_with"]:
                print(
                    f"    primary={n['primary_key']}  "
                    f"shared_with={n['shared_with']}"
                )
            print(f"    body_chars={n['html_chars']}{title}")
        for h in ch["other_h3"]:
            print(f"  other: {h}")
        print()

    print("Totals")
    print(f"  source_note_blocks: {t['source_note_blocks']}")
    print(f"  single / multi:     {t['single']} / {t['multi']}")
    print(f"  mapped source_keys: {t['mapped_keys']}")
    print(f"  missing source ids: {t['missing_ids']}")
    print(f"  unparsed ref heads: {t['unparsed_ref_blocks']}")
    print(f"  other chapter h3s:  {t['chapter_section_h3s']}")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--json",
        action="store_true",
        help="Print full report as JSON instead of the text table",
    )
    args = parser.parse_args()
    report = run()
    if args.json:
        json.dump(report, sys.stdout, indent=2, ensure_ascii=False)
        sys.stdout.write("\n")
    else:
        print_report(report)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
