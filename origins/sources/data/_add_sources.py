#!/usr/bin/env python3
"""Mint one or more bibliographic sources into extended/chapter-NN.json.

Can fill an id gap (e.g. ch19-s22), append at end, optionally scrape artifacts,
enrich image_url / local thumbs, link authors/publications, and rebuild indexes.

Input
-----
Pass stubs via --stub JSON (repeatable) or --stubs-file path to a JSON array.

Stub fields (required unless noted):
  chapter          int
  section          "main" | "notes"   (default main)
  id               int                optional; omit to use next free id
  author, title, publication, date, url, type, content_kind, language
  summary, book_role, topics, entities, status, date_iso, acquisition_note
                                  optional

Examples
--------
  # Gap-fill Kopp into ch19-s22, scrape + enrich + rebuild
  python3 _add_sources.py \\
    --stub '{"chapter":19,"id":22,"author":"Kopp, Emily","title":"…","url":"https://…"}' \\
    --scrape --enrich-images --link --rebuild

  # Batch from file
  python3 _add_sources.py --stubs-file new-sources.json --scrape --only-missing --rebuild
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

DATA = Path(__file__).resolve().parent
EXTENDED = DATA / "extended"
KEY_RE = re.compile(r"^ch(\d{2})-([sn])(\d{2})$")


def die(msg: str, code: int = 2) -> None:
    print(msg, file=sys.stderr)
    raise SystemExit(code)


def chapter_path(ch: int) -> Path:
    return EXTENDED / f"chapter-{int(ch):02d}.json"


def array_name(section: str) -> str:
    return "notes_sources" if section == "notes" else "sources"


def prefix_for(section: str) -> str:
    return "n" if section == "notes" else "s"


def source_key(ch: int, section: str, sid: int) -> str:
    return f"ch{int(ch):02d}-{prefix_for(section)}{int(sid):02d}"


def load_chapter(ch: int) -> dict:
    path = chapter_path(ch)
    if not path.is_file():
        die(f"Missing chapter file: {path}")
    return json.loads(path.read_text(encoding="utf-8"))


def save_chapter(ch: int, data: dict) -> None:
    path = chapter_path(ch)
    path.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


def next_id(records: list[dict]) -> int:
    ids = [int(r["id"]) for r in records if isinstance(r.get("id"), int)]
    return (max(ids) + 1) if ids else 1


def urls_in_corpus() -> dict[str, str]:
    """Normalize url → source_key for duplicate detection."""
    out: dict[str, str] = {}
    for path in sorted(EXTENDED.glob("chapter-*.json")):
        data = json.loads(path.read_text(encoding="utf-8"))
        for section in ("sources", "notes_sources"):
            for src in data.get(section) or []:
                url = (src.get("url") or "").strip()
                key = src.get("source_key") or ""
                if url:
                    out[normalize_url(url)] = key
    return out


def normalize_url(url: str) -> str:
    u = url.strip()
    try:
        p = urlparse(u)
        host = (p.netloc or "").lower().removeprefix("www.")
        path = (p.path or "").rstrip("/")
        return f"{host}{path}"
    except Exception:
        return u.lower().rstrip("/")


def parse_stubs(args: argparse.Namespace) -> list[dict]:
    stubs: list[dict] = []
    for raw in args.stub or []:
        try:
            stubs.append(json.loads(raw))
        except json.JSONDecodeError as err:
            die(f"Invalid --stub JSON: {err}")
    if args.stubs_file:
        path = Path(args.stubs_file)
        if not path.is_file():
            die(f"Missing --stubs-file: {path}")
        payload = json.loads(path.read_text(encoding="utf-8"))
        if isinstance(payload, dict) and "stubs" in payload:
            payload = payload["stubs"]
        if not isinstance(payload, list):
            die("--stubs-file must be a JSON array (or {\"stubs\": [...]})")
        stubs.extend(payload)
    if not stubs:
        die("Provide at least one --stub or --stubs-file")
    return stubs


def normalize_stub(raw: dict) -> dict:
    if "chapter" not in raw:
        die(f"Stub missing chapter: {raw!r}")
    ch = int(raw["chapter"])
    section = (raw.get("section") or "main").strip().lower()
    if section not in ("main", "notes"):
        die(f"Invalid section {section!r} (use main|notes)")
    title = (raw.get("title") or "").strip()
    if not title:
        die(f"Stub missing title (chapter {ch})")
    sid = raw.get("id")
    if sid is not None:
        sid = int(sid)
        if sid < 1:
            die(f"Invalid id {sid}")
    url = (raw.get("url") or "").strip()
    status = (raw.get("status") or ("ok" if url else "empty_url")).strip()
    stub = {
        "chapter": ch,
        "section": section,
        "id": sid,
        "type": (raw.get("type") or "News article").strip(),
        "author": (raw.get("author") or "").strip(),
        "title": title,
        "publication": (raw.get("publication") or "").strip(),
        "date": (raw.get("date") or "").strip(),
        "date_iso": (raw.get("date_iso") or "").strip(),
        "url": url,
        "status": status,
        "content_kind": (raw.get("content_kind") or "html_article").strip(),
        "language": (raw.get("language") or "en").strip(),
        "summary": (raw.get("summary") or "").strip(),
        "book_role": (raw.get("book_role") or "").strip(),
        "topics": list(raw.get("topics") or []),
        "entities": dict(raw.get("entities") or {}),
        "topic_ids": list(raw.get("topic_ids") or []),
        "entity_ids": dict(raw.get("entity_ids") or {}),
        "author_ids": list(raw.get("author_ids") or []),
        "publication_ids": list(raw.get("publication_ids") or []),
        "acquisition_note": (raw.get("acquisition_note") or "").strip(),
        "image_url": (raw.get("image_url") or "").strip(),
        "artifact": raw.get("artifact"),
    }
    return stub


def build_record(stub: dict, sid: int) -> dict:
    ch = stub["chapter"]
    section = stub["section"]
    key = source_key(ch, section, sid)
    rec: dict[str, Any] = {
        "id": sid,
        "source_key": key,
        "type": stub["type"],
        "author": stub["author"],
        "title": stub["title"],
        "publication": stub["publication"],
        "date": stub["date"],
        "url": stub["url"],
        "status": stub["status"] if stub["url"] else "empty_url",
        "artifact": stub["artifact"],
        "content_kind": stub["content_kind"],
        "language": stub["language"],
        "summary": stub["summary"],
        "book_role": stub["book_role"],
        "topics": stub["topics"],
        "entities": stub["entities"],
        "topic_ids": stub["topic_ids"],
        "entity_ids": stub["entity_ids"],
        "author_ids": stub["author_ids"],
        "publication_ids": stub["publication_ids"],
        "acquisition_note": stub["acquisition_note"],
    }
    if stub["date_iso"]:
        rec["date_iso"] = stub["date_iso"]
    if stub["image_url"]:
        rec["image_url"] = stub["image_url"]
    return rec


def mint_stub(
    stub: dict,
    *,
    force: bool,
    url_index: dict[str, str],
) -> tuple[int, str, dict]:
    """Insert stub into chapter JSON. Returns (chapter, source_key, record)."""
    ch = stub["chapter"]
    section = stub["section"]
    data = load_chapter(ch)
    arr_name = array_name(section)
    records: list[dict] = list(data.get(arr_name) or [])

    sid = stub["id"] if stub["id"] is not None else next_id(records)
    key = source_key(ch, section, sid)

    existing = next((r for r in records if r.get("id") == sid), None)
    if existing and not force:
        die(f"{key} already exists (id={sid}). Use --force to overwrite.")

    if stub["url"]:
        nu = normalize_url(stub["url"])
        prior = url_index.get(nu)
        if prior and prior != key and not force:
            die(f"URL already used by {prior}: {stub['url']}")

    rec = build_record(stub, sid)
    if existing and force:
        # Preserve enrichment the stub omitted.
        for field in (
            "summary",
            "book_role",
            "topics",
            "entities",
            "topic_ids",
            "entity_ids",
            "author_ids",
            "publication_ids",
            "image_url",
            "artifact",
            "acquisition_note",
            "date_iso",
        ):
            if not rec.get(field) and existing.get(field):
                rec[field] = existing[field]
        records = [rec if r.get("id") == sid else r for r in records]
        action = "updated"
    else:
        records.append(rec)
        action = "inserted"

    records.sort(key=lambda r: int(r.get("id") or 0))
    data[arr_name] = records
    if data.get("chapter") is None:
        data["chapter"] = ch
    save_chapter(ch, data)

    if stub["url"]:
        url_index[normalize_url(stub["url"])] = key

    print(f"{action}: {key}  ({section})  {rec['title'][:70]}")
    return ch, key, rec


def run_cmd(cmd: list[str], *, cwd: Path | None = None) -> None:
    print("+", " ".join(cmd))
    subprocess.run(cmd, check=True, cwd=str(cwd or DATA))


def scrape_keys(by_chapter: dict[int, list[str]], *, only_missing: bool) -> None:
    for ch, keys in sorted(by_chapter.items()):
        cmd = [
            sys.executable,
            str(EXTENDED / "_scrape_chapter.py"),
            str(ch),
            "--section",
            "all",
            "--keys",
            ",".join(keys),
        ]
        if only_missing:
            cmd.append("--only-missing")
        run_cmd(cmd)


def enrich_images(keys: list[str]) -> None:
    # Existing enrichers walk the whole corpus; that is fine for small batches.
    run_cmd([sys.executable, str(DATA / "_enrich_image_urls.py")])
    run_cmd([sys.executable, str(DATA / "_cache_preview_images.py"), "--primary"])


def link_and_sync() -> None:
    run_cmd([sys.executable, str(DATA / "_link_authors.py")])
    run_cmd([sys.executable, str(DATA / "_link_publications.py")])
    run_cmd([sys.executable, str(DATA / "_sync_labels_from_authorities.py")])


def rebuild_indexes() -> None:
    run_cmd([sys.executable, str(DATA / "_build_corpus_index.py")])
    run_cmd([sys.executable, str(DATA / "_verify_corpus_index.py")])
    run_cmd([sys.executable, str(DATA / "_build_authority_search_index.py")])


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument(
        "--stub",
        action="append",
        default=[],
        help="JSON object for one source (repeatable)",
    )
    p.add_argument("--stubs-file", help="JSON array of stubs")
    p.add_argument(
        "--force",
        action="store_true",
        help="Overwrite an existing id/source_key",
    )
    p.add_argument(
        "--scrape",
        action="store_true",
        help="Scrape artifacts for the minted keys only",
    )
    p.add_argument(
        "--only-missing",
        action="store_true",
        help="With --scrape, skip keys that already have an artifact",
    )
    p.add_argument(
        "--enrich-images",
        action="store_true",
        help="Run image_url enrichment + local WebP cache",
    )
    p.add_argument(
        "--link",
        action="store_true",
        help="Run author/publication linkers + label sync",
    )
    p.add_argument(
        "--rebuild",
        action="store_true",
        help="Rebuild corpus-index + authority search index",
    )
    p.add_argument(
        "--dry-run",
        action="store_true",
        help="Validate stubs and print planned keys; write nothing",
    )
    return p.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    stubs = [normalize_stub(s) for s in parse_stubs(args)]
    url_index = urls_in_corpus()

    planned: list[tuple[int, str, dict]] = []
    for stub in stubs:
        ch = stub["chapter"]
        data = load_chapter(ch)
        records = list(data.get(array_name(stub["section"])) or [])
        sid = stub["id"] if stub["id"] is not None else next_id(records)
        key = source_key(ch, stub["section"], sid)
        if args.dry_run:
            exists = any(r.get("id") == sid for r in records)
            print(
                f"dry-run: {key}  section={stub['section']}  "
                f"{'EXISTS' if exists else 'new'}  {stub['title'][:70]}"
            )
            planned.append((ch, key, stub))
            continue
        planned.append(mint_stub(stub, force=args.force, url_index=url_index))

    if args.dry_run:
        print(f"dry-run complete: {len(planned)} stub(s); no files written")
        return 0

    keys = [key for _ch, key, _rec in planned]
    by_chapter: dict[int, list[str]] = {}
    for ch, key, _rec in planned:
        by_chapter.setdefault(ch, []).append(key)

    if args.scrape:
        scrape_keys(by_chapter, only_missing=args.only_missing)
    if args.enrich_images:
        enrich_images(keys)
    if args.link:
        link_and_sync()
    if args.rebuild:
        rebuild_indexes()

    print("\nDone. Minted:")
    for ch, key, rec in planned:
        print(f"  {key}  (ch{ch})  {rec.get('title', '')[:70]}")
    print(
        "Review summary / book_role / topics as needed; "
        "then commit when ready."
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
