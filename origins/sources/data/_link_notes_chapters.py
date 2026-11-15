#!/usr/bin/env python3
"""Link Chapter / Prologue cross-references in notes/*.html to catalog URLs.

Rewrites plain-text mentions such as "Chapter 6", "Chapters 12, 14, and 19",
and "Prologue" into internal links (?chapter=N). Skips text already inside
<a>…</a>. Idempotent: safe to re-run.
"""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
NOTES_DIR = ROOT / "notes"

# Singular Chapter N, plural lists (and / commas), or Prologue.
CHAPTER_REF = re.compile(
    r"\bChapters?\s+\d+(?:\s*,\s*\d+)*(?:\s*,?\s*and\s+\d+)?\b"
    r"|\bPrologue\b",
    re.IGNORECASE,
)
TAG_OR_TEXT = re.compile(r"(<[^>]+>)", re.DOTALL)
OPEN_A = re.compile(r"<a\b", re.IGNORECASE)
CLOSE_A = re.compile(r"</a\b", re.IGNORECASE)


def chapter_href(number: int) -> str:
    return f"?chapter={number}"


def linkify_chapter_phrase(phrase: str) -> str:
    if phrase.lower() == "prologue":
        return f'<a href="{chapter_href(0)}">Prologue</a>'

    nums = re.findall(r"\d+", phrase)
    if not nums:
        return phrase

    # "Chapter 12" → one link wrapping the whole phrase.
    if re.match(r"^Chapter\s+\d+$", phrase, re.IGNORECASE) and len(nums) == 1:
        n = int(nums[0])
        return f'<a href="{chapter_href(n)}">{phrase}</a>'

    # "Chapters 4 and 11" / "Chapters 12, 14, and 19" → link each number.
    def repl_num(m: re.Match[str]) -> str:
        n = int(m.group(0))
        return f'<a href="{chapter_href(n)}">{m.group(0)}</a>'

    return re.sub(r"\d+", repl_num, phrase)


def linkify_text(text: str) -> tuple[str, int]:
    count = 0

    def repl(m: re.Match[str]) -> str:
        nonlocal count
        count += 1
        return linkify_chapter_phrase(m.group(0))

    return CHAPTER_REF.sub(repl, text), count


def linkify_html(html: str) -> tuple[str, int]:
    parts = TAG_OR_TEXT.split(html)
    depth = 0
    out: list[str] = []
    total = 0
    for part in parts:
        if part.startswith("<"):
            if OPEN_A.match(part):
                depth += 1
            elif CLOSE_A.match(part):
                depth = max(0, depth - 1)
            out.append(part)
            continue
        if depth > 0:
            out.append(part)
            continue
        linked, n = linkify_text(part)
        total += n
        out.append(linked)
    return "".join(out), total


def process_file(path: Path, *, write: bool) -> int:
    original = path.read_text(encoding="utf-8")
    updated, count = linkify_html(original)
    if write and updated != original:
        path.write_text(updated, encoding="utf-8", newline="\n")
    return count


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Report link counts without writing files",
    )
    parser.add_argument(
        "files",
        nargs="*",
        type=Path,
        help="Optional notes HTML paths (default: all notes/*.html)",
    )
    args = parser.parse_args(argv)

    paths = args.files or sorted(NOTES_DIR.glob("*.html"))
    if not paths:
        print("No notes HTML files found", file=sys.stderr)
        return 1

    write = not args.dry_run
    grand = 0
    for path in paths:
        path = path if path.is_absolute() else (Path.cwd() / path)
        if not path.exists():
            print(f"missing: {path}", file=sys.stderr)
            return 1
        n = process_file(path, write=write)
        grand += n
        action = "would link" if args.dry_run else "linked"
        print(f"{path.name}: {action} {n} chapter ref(s)")

    print(f"total: {grand}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
