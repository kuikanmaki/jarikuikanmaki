#!/usr/bin/env python3
"""Link unique Chapter+cite source cross-references in notes/*.html.

Looks for patterns like:
  <a href="?chapter=6">Chapter 6</a> <em>Andersen et al. 2020</em>
  <a href="?chapter=10">Chapter 10</a> <em>Devine 2020</em> and <em>Small et al. 2021</em>

Resolves each italic cite against corpus-index.json using (chapter, year,
author surname). Only unique hits become ?source= links. Ambiguous and
unmatched cites are left unchanged. Idempotent.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parent
NOTES_DIR = ROOT / "notes"
CORPUS_PATH = ROOT / "corpus-index.json"

# Chapter permalink + optional "Sources"/"Sources and Notes" + one or more <em> cites.
CITE_CHAIN = re.compile(
    r'(<a href="\?chapter=(\d+)">[^<]*</a>'
    r'(?:\s+Sources(?:\s+and\s+Notes)?)?(?:\s*:)?\s*)'
    r'((?:<em>[^<]+</em>)(?:(?:\s*,\s*|\s+and\s+)<em>[^<]+</em>)*)',
    re.IGNORECASE,
)
EM_CITE = re.compile(r"<em>([^<]+)</em>", re.IGNORECASE)
HAS_YEAR = re.compile(r"(?:19|20)\d{2}")


def author_last_names(author: str) -> list[str]:
    if not author:
        return []
    parts = re.split(r"\s*(?:;|&|\band\b)\s*", author.strip(), flags=re.I)
    out: list[str] = []
    for part in parts:
        part = part.strip()
        if not part:
            continue
        if "," in part:
            last = part.split(",", 1)[0].strip()
        else:
            toks = [t.strip(".,") for t in part.split() if t.strip(".,")]
            last = toks[-1] if toks else ""
        last = re.sub(r"[^A-Za-z\-].*$", "", last)
        if last and last.lower() not in {"et", "al", "jr", "sr"}:
            out.append(last.lower())
    return out


def year_of(row: dict) -> str | None:
    blob = str(row.get("date") or row.get("date_iso") or "")
    m = re.search(r"(?:19|20)\d{2}", blob)
    return m.group(0) if m else None


def build_index(sources: list[dict]) -> dict[tuple[int, str, str], list[dict]]:
    idx: dict[tuple[int, str, str], list[dict]] = defaultdict(list)
    for row in sources:
        year = year_of(row)
        if year is None or row.get("chapter") is None:
            continue
        chapter = int(row["chapter"])
        for last in author_last_names(row.get("author") or ""):
            idx[(chapter, year, last)].append(row)
    return idx


def parse_cite(text: str) -> dict | None:
    text = re.sub(r"\s+", " ", text.strip()).strip(" .,;:")
    text = re.sub(r",?\s*pp?\.\s*.*$", "", text, flags=re.I)
    m = re.search(r"^(.*?)(?:,?\s+)?((?:19|20)\d{2})(?:[a-z])?\s*$", text)
    if not m:
        return None
    name = m.group(1).strip().rstrip(",")
    year = m.group(2)
    name = re.sub(r"\s+et\s+al\.?$", "", name, flags=re.I).strip().rstrip(",")
    tokens: list[str] = []
    for part in re.split(r"\s*(?:&|\band\b)\s*", name, flags=re.I):
        part = part.strip()
        if not part:
            continue
        if "," in part:
            tokens.append(part.split(",", 1)[0].strip())
        else:
            toks = part.split()
            tokens.append(toks[-1])
            if len(toks) > 1:
                tokens.append(toks[0])
            if len(toks) >= 2:
                tokens.append(" ".join(toks[-2:]))
    cleaned: list[str] = []
    for tok in tokens:
        tok = re.sub(r"[^A-Za-z\- ].*$", "", tok).strip().lower()
        if tok and tok not in {"et", "al", "the", "and"}:
            cleaned.append(tok)
    return {"raw": text, "name": name, "year": year, "tokens": cleaned}


def resolve_unique(
    chapter: int,
    cite: str,
    idx: dict[tuple[int, str, str], list[dict]],
    sources: list[dict],
) -> dict | None:
    parsed = parse_cite(cite)
    if not parsed or not parsed["tokens"]:
        return None
    found: dict[str, dict] = {}
    for tok in parsed["tokens"]:
        key_toks = {tok, tok.split()[-1]}
        for key_tok in key_toks:
            for row in idx.get((chapter, parsed["year"], key_tok), []):
                found[row["source_key"]] = row
    if not found:
        # Fallback: chapter+year rows whose author contains a cite token.
        for row in sources:
            if int(row.get("chapter") or -1) != chapter:
                continue
            if year_of(row) != parsed["year"]:
                continue
            author = f" {(row.get('author') or '').lower()} "
            for tok in parsed["tokens"]:
                if " " in tok:
                    if f" {tok} " in author:
                        found[row["source_key"]] = row
                elif re.search(rf"\b{re.escape(tok)}\b", author):
                    found[row["source_key"]] = row
    if len(found) != 1:
        return None
    return next(iter(found.values()))


def source_href(source_key: str) -> str:
    return f"?source={source_key}"


def linkify_em_cite(cite_text: str, source_key: str) -> str:
    return f'<em><a href="{source_href(source_key)}">{cite_text}</a></em>'


def linkify_html(
    html: str,
    idx: dict[tuple[int, str, str], list[dict]],
    sources: list[dict],
) -> tuple[str, dict[str, int]]:
    stats = {"unique": 0, "skipped": 0, "chains": 0}

    def repl_chain(match: re.Match[str]) -> str:
        prefix = match.group(1)
        chapter = int(match.group(2))
        cites_blob = match.group(3)
        stats["chains"] += 1

        def repl_em(em_match: re.Match[str]) -> str:
            cite = em_match.group(1)
            if not HAS_YEAR.search(cite):
                stats["skipped"] += 1
                return em_match.group(0)
            row = resolve_unique(chapter, cite, idx, sources)
            if not row:
                stats["skipped"] += 1
                return em_match.group(0)
            stats["unique"] += 1
            return linkify_em_cite(cite, row["source_key"])

        return prefix + EM_CITE.sub(repl_em, cites_blob)

    return CITE_CHAIN.sub(repl_chain, html), stats


def process_file(
    path: Path,
    idx: dict[tuple[int, str, str], list[dict]],
    sources: list[dict],
    *,
    write: bool,
) -> dict[str, int]:
    original = path.read_text(encoding="utf-8")
    updated, stats = linkify_html(original, idx, sources)
    if write and updated != original:
        path.write_text(updated, encoding="utf-8", newline="\n")
    return stats


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("files", nargs="*", type=Path)
    args = parser.parse_args(argv)

    if not CORPUS_PATH.exists():
        print(f"missing corpus index: {CORPUS_PATH}", file=sys.stderr)
        return 1

    corpus = json.loads(CORPUS_PATH.read_text(encoding="utf-8"))
    sources = corpus.get("sources") or []
    idx = build_index(sources)

    paths = args.files or sorted(NOTES_DIR.glob("*.html"))
    if not paths:
        print("No notes HTML files found", file=sys.stderr)
        return 1

    write = not args.dry_run
    totals = {"unique": 0, "skipped": 0, "chains": 0}
    for path in paths:
        path = path if path.is_absolute() else Path.cwd() / path
        stats = process_file(path, idx, sources, write=write)
        for key in totals:
            totals[key] += stats[key]
        action = "would link" if args.dry_run else "linked"
        print(
            f"{path.name}: {action} {stats['unique']} unique "
            f"(skipped {stats['skipped']} in {stats['chains']} chains)"
        )

    print(
        f"total: linked {totals['unique']} unique "
        f"(skipped {totals['skipped']} in {totals['chains']} chains)"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
