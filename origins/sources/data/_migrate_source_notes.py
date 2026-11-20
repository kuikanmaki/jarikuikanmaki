#!/usr/bin/env python3
"""Migrate Chapter Notes 'Note on Source…' blocks onto extended source records.

For each notes/NN.html source-note <h3>:
  - Write note:{title,html,shared_with} onto the matched main bibliography row(s)
  - Strip that block from the chapter notes HTML (leave h2 + chapter sections)

Primary (lowest id) and co-sources get a duplicated note body; shared_with lists
the other source_keys in the group.

Usage:
  python3 _migrate_source_notes.py --dry-run
  python3 _migrate_source_notes.py
  python3 _migrate_source_notes.py --force   # overwrite existing note fields
"""

from __future__ import annotations

import argparse
import json
import re
import shutil
import sys
from datetime import date
from pathlib import Path

from _extract_source_notes_dryrun import (
    DATA,
    EXTENDED,
    H2_TAG,
    NOTES,
    classify_block,
    load_chapter_source_ids,
)

ARCHIVE_ROOT = DATA / "_archive"


def die(msg: str, code: int = 2) -> None:
    print(msg, file=sys.stderr)
    raise SystemExit(code)


def chapter_path(ch: int) -> Path:
    return EXTENDED / f"chapter-{int(ch):02d}.json"


def load_chapter(ch: int) -> dict:
    path = chapter_path(ch)
    if not path.is_file():
        die(f"Missing chapter file: {path}")
    return json.loads(path.read_text(encoding="utf-8"))


def save_chapter(ch: int, data: dict) -> None:
    path = chapter_path(ch)
    path.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


def find_source(data: dict, source_key: str) -> dict | None:
    for section in ("sources", "notes_sources"):
        for src in data.get(section) or []:
            if src.get("source_key") == source_key:
                return src
    return None


def split_notes_document(html: str) -> tuple[str, list[dict], str]:
    """Return (opening_h2, blocks, preamble).

    Split on both <h2> and <h3> so mid-document section titles (e.g. "Notes to
    Final Revelations") are not swallowed into the previous source-note body.

    blocks items: {heading, html, raw, is_source_note, classified?}
    """
    html = html.strip()
    h2_match = H2_TAG.search(html)
    opening_h2 = ""
    rest = html
    if h2_match and h2_match.start() < 80:
        opening_h2 = h2_match.group(0).strip()
        rest = html[h2_match.end() :].lstrip()

    parts = re.split(r"(?=<h[23]\b)", rest, flags=re.I)
    blocks: list[dict] = []
    preamble = ""
    for i, part in enumerate(parts):
        part_st = part.strip()
        if not part_st:
            continue
        m = re.search(r"<h([23])\b[^>]*>(.*?)</h\1>", part_st, flags=re.I | re.S)
        if not m:
            if i == 0 and not blocks:
                preamble = part_st
            continue
        level = m.group(1)
        heading_text = re.sub(r"<[^>]+>", "", m.group(2))
        heading_text = re.sub(r"\s+", " ", heading_text).strip()
        body = part_st[m.end() :].strip()
        # Defense in depth: never keep a following h2/h1 inside a note body.
        body = re.split(r"(?=<h[12]\b)", body, maxsplit=1, flags=re.I)[0].strip()
        if level == "2":
            # Chapter subsection title — keep as-is, not a source note.
            blocks.append(
                {
                    "heading": heading_text,
                    "html": body,
                    "raw": part_st,
                    "is_source_note": False,
                    "classified": None,
                }
            )
            continue
        classified = classify_block(heading_text)
        # Rebuild raw without a leaked trailing h2 (body already trimmed).
        raw_head = part_st[: m.end()].rstrip()
        raw = raw_head + (("\n" + body) if body else "")
        blocks.append(
            {
                "heading": heading_text,
                "html": body,
                "raw": raw,
                "is_source_note": classified is not None,
                "classified": classified,
            }
        )
    return opening_h2, blocks, preamble


def build_note_payload(
    title: str | None,
    body_html: str,
    keys: list[str],
    self_key: str,
) -> dict:
    others = [k for k in keys if k != self_key]
    note: dict = {
        "title": title or "",
        "html": body_html.strip(),
        "shared_with": others,
    }
    return note


def migrate_chapter(
    ch: int,
    *,
    dry_run: bool,
    force: bool,
    archive_dir: Path | None,
) -> dict:
    notes_path = NOTES / f"{ch:02d}.html"
    if not notes_path.is_file():
        return {"chapter": ch, "skipped": True, "reason": "no notes file"}

    html = notes_path.read_text(encoding="utf-8")
    h2, blocks, preamble = split_notes_document(html)
    id_map = load_chapter_source_ids(ch)
    data = load_chapter(ch)

    written: list[dict] = []
    missing: list[dict] = []
    conflicts: list[str] = []
    kept_sections: list[str] = []

    if preamble:
        kept_sections.append(preamble)

    for block in blocks:
        if not block["is_source_note"]:
            kept_sections.append(block["raw"])
            continue

        classified = block["classified"]
        assert classified is not None
        ids = classified["source_ids"]
        keys: list[str] = []
        miss: list[int] = []
        for sid in ids:
            key = id_map.get(sid)
            if key:
                keys.append(key)
            else:
                miss.append(sid)
        if miss or not keys:
            missing.append(
                {
                    "heading": classified["heading"],
                    "missing_ids": miss,
                    "ids": ids,
                }
            )
            # Keep the block in chapter notes if we cannot attach it.
            kept_sections.append(block["raw"])
            continue

        title = classified.get("title")
        body = block["html"]
        for key in keys:
            src = find_source(data, key)
            if src is None:
                missing.append({"heading": classified["heading"], "missing_keys": [key]})
                continue
            existing = src.get("note")
            if existing and not force:
                conflicts.append(key)
                continue
            src["note"] = build_note_payload(title, body, keys, key)
            written.append(
                {
                    "source_key": key,
                    "primary": key == keys[0],
                    "title": title or "",
                    "shared_with": [k for k in keys if k != key],
                    "html_chars": len(body),
                }
            )

    new_html_parts = []
    if h2:
        new_html_parts.append(h2)
    new_html_parts.extend(kept_sections)
    new_html = "\n".join(new_html_parts).strip() + "\n"

    stats = {
        "chapter": ch,
        "source_note_blocks": sum(1 for b in blocks if b["is_source_note"]),
        "kept_chapter_sections": sum(1 for b in blocks if not b["is_source_note"]),
        "records_written": len(written),
        "missing": missing,
        "conflicts": conflicts,
        "dry_run": dry_run,
    }

    if dry_run:
        return stats

    if conflicts and not force:
        die(
            f"ch{ch:02d}: existing note on {', '.join(conflicts)}. "
            "Re-run with --force to overwrite."
        )
    if missing:
        die(
            f"ch{ch:02d}: unresolved source ids — aborting. "
            f"{missing!r}"
        )

    if archive_dir is not None:
        archive_dir.mkdir(parents=True, exist_ok=True)
        shutil.copy2(notes_path, archive_dir / notes_path.name)

    save_chapter(ch, data)
    notes_path.write_text(new_html, encoding="utf-8")
    return stats


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument(
        "--dry-run",
        action="store_true",
        help="Report planned writes; do not modify files",
    )
    p.add_argument(
        "--force",
        action="store_true",
        help="Overwrite sources that already have a note field",
    )
    p.add_argument(
        "--chapter",
        type=int,
        action="append",
        default=[],
        help="Limit to one chapter (repeatable). Default: all notes/*.html",
    )
    return p.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    chapters = args.chapter
    if not chapters:
        chapters = sorted(int(p.stem) for p in NOTES.glob("[0-9][0-9].html"))

    archive_dir = None
    if not args.dry_run:
        archive_dir = ARCHIVE_ROOT / date.today().isoformat() / "notes-pre-source-note-migrate"

    all_stats: list[dict] = []
    total_written = 0
    for ch in chapters:
        stats = migrate_chapter(
            ch,
            dry_run=args.dry_run,
            force=args.force,
            archive_dir=archive_dir,
        )
        all_stats.append(stats)
        if stats.get("skipped"):
            print(f"ch{ch:02d}: skipped ({stats.get('reason')})")
            continue
        total_written += stats["records_written"]
        print(
            f"ch{ch:02d}: blocks={stats['source_note_blocks']} "
            f"wrote={stats['records_written']} "
            f"kept_sections={stats['kept_chapter_sections']}"
            + (" [dry-run]" if args.dry_run else "")
        )
        if stats["missing"]:
            print(f"  MISSING: {stats['missing']}")
        if stats["conflicts"]:
            print(f"  CONFLICTS: {stats['conflicts']}")

    print(
        f"\n{'Dry-run' if args.dry_run else 'Migrated'}: "
        f"{total_written} note field(s) across {len(chapters)} chapter(s)"
    )
    if not args.dry_run and archive_dir is not None:
        print(f"Notes backup: {archive_dir}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
