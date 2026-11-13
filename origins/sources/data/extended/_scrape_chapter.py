#!/usr/bin/env python3
"""Scrape chapter sources into extended/artifacts with rate limiting.

Reads/writes the catalog of record: extended/chapter-NN.json.
Supports main `sources` and Notes `notes_sources`. Patches `artifact` (and
safe status updates) onto existing records in place — does not rebuild the
chapter file and must not be followed by `_build_extended.py` for Notes work.
"""
from __future__ import annotations
import os
os.environ.setdefault("PYTHONUNBUFFERED", "1")

import argparse
import json
import re
import subprocess
import sys
import time
from pathlib import Path
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parents[1]  # origins/sources/data
EXTENDED = Path(__file__).resolve().parent
ART = EXTENDED / "artifacts"
LOGS = EXTENDED / "logs"
CACHE_PATH = EXTENDED / "url-cache.json"

SKIP_HOSTS = {
    "twitter.com",
    "x.com",
    "mobile.twitter.com",
    "youtube.com",
    "youtu.be",
    "www.youtube.com",
}

CATALOG_STATUSES = {"ok", "paywall", "empty_url"}


def host(url: str) -> str:
    return urlparse(url).netloc.lower().removeprefix("www.")


def is_skip_host(h: str) -> bool:
    """Exact host match only — never use endswith('x.com') (that false-skips vox.com)."""
    if h in SKIP_HOSTS:
        return True
    if h.endswith(".twitter.com") or h.endswith(".x.com"):
        return True
    if h.endswith(".youtube.com"):
        return True
    return False


def is_pdf(url: str) -> bool:
    u = url.lower()
    return u.endswith(".pdf") or "/pdf" in u or "/pdf/" in u


def load_cache() -> dict:
    if CACHE_PATH.exists():
        return json.loads(CACHE_PATH.read_text(encoding="utf-8"))
    return {}


def save_cache(cache: dict) -> None:
    CACHE_PATH.write_text(json.dumps(cache, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


def firecrawl_cmd() -> list[str]:
    """Prefer a local binary; fall back to npx with a short install wait."""
    import shutil

    for name in ("firecrawl", "firecrawl-cli"):
        path = shutil.which(name)
        if path:
            return [path]
    return ["npx", "--yes", "firecrawl-cli"]


def firecrawl_status() -> str:
    try:
        p = subprocess.run(
            firecrawl_cmd() + ["--status"],
            capture_output=True,
            text=True,
            timeout=45,
        )
        return (p.stdout or "") + (p.stderr or "")
    except subprocess.TimeoutExpired:
        return "status_timeout"


def scrape_url(url: str, out: Path) -> tuple[bool, str]:
    cmd = firecrawl_cmd() + ["scrape", url, "-o", str(out)]
    if is_pdf(url):
        cmd.extend(["--max-pages", "10"])
    try:
        p = subprocess.run(cmd, capture_output=True, text=True, timeout=180)
    except subprocess.TimeoutExpired:
        out.unlink(missing_ok=True)
        return False, "scrape_timeout"
    err = ((p.stderr or "") + "\n" + (p.stdout or "")).strip()
    if p.returncode == 0 and out.exists() and out.stat().st_size > 40:
        text = out.read_text(encoding="utf-8", errors="replace")
        if "errors.edgesuite.net" in text or text.startswith("An error occurred"):
            out.unlink(missing_ok=True)
            return False, "blocked_cdn_or_error_page"
        return True, ""
    out.unlink(missing_ok=True)
    if "Rate limit exceeded" in err:
        return False, "rate_limit:" + err[-300:]
    if "do not support this site" in err:
        return False, "blocked_unsupported_site"
    if "404" in err or "Not Found" in err:
        return False, "not_found:" + err[-300:]
    return False, err[-500:] or f"exit_{p.returncode}"


def classify_status(url: str, ok: bool, err: str, size: int) -> str:
    if not url:
        return "empty_url"
    h = host(url)
    if is_skip_host(h):
        return "skipped"
    if not ok:
        if err.startswith("rate_limit"):
            return "error"
        if "blocked" in err:
            return "blocked"
        if "not_found" in err:
            return "not_found"
        return "error"
    return "ok"  # paywall decided later during post-crawl review


def source_key_for(ch: int, section: str, source: dict) -> str:
    key = (source.get("source_key") or "").strip()
    if key:
        return key
    prefix = "n" if section == "notes" else "s"
    return f"ch{int(ch):02d}-{prefix}{int(source.get('id') or 0):02d}"


def iter_section_records(data: dict, section_filter: str):
    if section_filter in ("main", "all"):
        for source in data.get("sources") or []:
            yield "main", source
    if section_filter in ("notes", "all"):
        for source in data.get("notes_sources") or []:
            yield "notes", source


def has_usable_artifact(source: dict) -> bool:
    art = (source.get("artifact") or "").strip()
    if not art:
        return False
    path = EXTENDED / art
    return path.exists() and path.stat().st_size > 40


def append_acquisition_note(source: dict, line: str) -> None:
    line = (line or "").strip()
    if not line:
        return
    prev = (source.get("acquisition_note") or "").strip()
    if line in prev:
        return
    source["acquisition_note"] = f"{prev}; {line}".strip("; ").strip()


def apply_result_to_record(source: dict, entry: dict) -> None:
    """Patch catalog fields without introducing scrape-only statuses."""
    scrape_status = entry.get("status") or "error"
    artifact = entry.get("artifact")

    if scrape_status == "empty_url":
        source["status"] = "empty_url"
        source["artifact"] = None
        return

    if scrape_status in ("ok", "paywall") and artifact:
        source["artifact"] = artifact
        # Do not downgrade an existing paywall label on re-scrape success.
        if source.get("status") != "paywall":
            source["status"] = "ok" if scrape_status == "ok" else "paywall"
        return

    # Skip / fail: keep catalog status in {ok,paywall,empty_url}; record outcome in note.
    if source.get("status") not in CATALOG_STATUSES:
        source["status"] = "ok" if (source.get("url") or "").strip() else "empty_url"
    if not has_usable_artifact(source):
        source["artifact"] = None
    detail = scrape_status
    if entry.get("error"):
        detail = f"{scrape_status}: {entry['error'][:160]}"
    append_acquisition_note(source, f"Scrape {detail}")


def scrape_one(
    ch: int,
    section: str,
    source: dict,
    cache: dict,
    *,
    only_missing: bool,
) -> dict:
    sid = source_key_for(ch, section, source)
    source["source_key"] = sid
    url = (source.get("url") or "").strip()
    out = ART / f"{sid}.md"
    entry = {
        "id": source.get("id"),
        "section": section,
        "source_key": sid,
        "url": url,
        "ok": False,
        "status": "error",
        "bytes": 0,
        "error": None,
        "reused": False,
        "skipped_existing": False,
    }

    if only_missing and has_usable_artifact(source):
        entry["ok"] = True
        entry["status"] = source.get("status") if source.get("status") in ("ok", "paywall") else "ok"
        entry["artifact"] = source.get("artifact")
        entry["skipped_existing"] = True
        path = EXTENDED / source["artifact"]
        entry["bytes"] = path.stat().st_size if path.exists() else 0
        print(f"{sid}: skip_existing_artifact -> {entry['status']}")
        return entry

    if not url:
        entry["status"] = "empty_url"
        print(f"{sid}: empty_url")
        return entry

    h = host(url)
    if is_skip_host(h):
        entry["status"] = "skipped"
        print(f"{sid}: skipped ({h})")
        return entry

    if url in cache and cache[url].get("artifact") and (EXTENDED / cache[url]["artifact"]).exists():
        prior = cache[url]
        entry["ok"] = prior.get("status") in ("ok", "paywall")
        entry["status"] = prior.get("status", "ok")
        entry["reused"] = True
        entry["artifact"] = prior["artifact"]
        src_art = EXTENDED / prior["artifact"]
        want = f"artifacts/{sid}.md"
        if src_art.exists() and prior["artifact"] != want:
            out.write_text(src_art.read_text(encoding="utf-8", errors="replace"), encoding="utf-8")
            entry["artifact"] = want
            entry["bytes"] = out.stat().st_size
        elif src_art.exists():
            entry["artifact"] = prior["artifact"]
            entry["bytes"] = src_art.stat().st_size
        print(f"{sid}: reused -> {entry['status']}")
        return entry

    # rate-limit pacing: ~8/min
    time.sleep(7.5)

    ok, err = scrape_url(url, out)
    if not ok and err.startswith("rate_limit"):
        print(f"{sid}: rate limited, sleeping 65s...")
        time.sleep(65)
        ok, err = scrape_url(url, out)

    entry["ok"] = ok
    entry["error"] = err or None
    if ok:
        entry["bytes"] = out.stat().st_size
        entry["status"] = "ok"
        entry["artifact"] = f"artifacts/{sid}.md"
        cache[url] = {
            "source_key": sid,
            "artifact": entry["artifact"],
            "status": "ok",
        }
    else:
        entry["status"] = classify_status(url, ok, err, 0)
        cache[url] = {
            "source_key": sid,
            "artifact": None,
            "status": entry["status"],
        }
        entry["artifact"] = None

    print(f"{sid}: {entry['status']} ({entry['bytes']} bytes) {err[:80] if err else ''}")
    return entry


def parse_args(argv: list[str]) -> argparse.Namespace:
    p = argparse.ArgumentParser(
        description="Scrape extended chapter sources into artifacts and patch catalog records."
    )
    p.add_argument("chapter", type=int, help="Chapter number (0 = Prologue)")
    p.add_argument(
        "--section",
        choices=("main", "notes", "all"),
        default="main",
        help="Which array to scrape (default: main, preserving prior CLI behavior)",
    )
    p.add_argument(
        "--only-missing",
        action="store_true",
        help="Skip records that already have a usable local artifact file",
    )
    return p.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv or sys.argv[1:])
    ch = args.chapter
    chapter_path = EXTENDED / f"chapter-{ch:02d}.json"
    if not chapter_path.exists():
        print(f"Missing catalog file: {chapter_path}", file=sys.stderr)
        return 2

    data = json.loads(chapter_path.read_text(encoding="utf-8"))
    ART.mkdir(parents=True, exist_ok=True)
    LOGS.mkdir(parents=True, exist_ok=True)
    cache = load_cache()

    before = firecrawl_status()
    m = re.search(r"Credits:\s*([0-9,]+)", before)
    credits_before = m.group(1).replace(",", "") if m else None

    targets = list(iter_section_records(data, args.section))
    if not targets:
        print(f"No targets for chapter {ch} section={args.section}")
        return 0

    results = []
    for section, source in targets:
        entry = scrape_one(
            ch,
            section,
            source,
            cache,
            only_missing=args.only_missing,
        )
        apply_result_to_record(source, entry)
        results.append(entry)
        save_cache(cache)

    chapter_path.write_text(
        json.dumps(data, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )

    after = firecrawl_status()
    m2 = re.search(r"Credits:\s*([0-9,]+)", after)
    credits_after = m2.group(1).replace(",", "") if m2 else None

    log = {
        "chapter": ch,
        "section": args.section,
        "only_missing": args.only_missing,
        "credits_before": int(credits_before) if credits_before else None,
        "credits_after": int(credits_after) if credits_after else None,
        "sources": results,
    }
    (LOGS / f"chapter-{ch:02d}.scrape.log.json").write_text(
        json.dumps(log, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
    )
    save_cache(cache)
    ok_n = sum(1 for r in results if r["status"] in ("ok", "paywall") or r.get("skipped_existing"))
    print(
        f"DONE chapter {ch} section={args.section}: "
        f"{ok_n}/{len(results)} retrieved; credits {credits_before} -> {credits_after}"
    )
    print(f"Patched catalog: {chapter_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
