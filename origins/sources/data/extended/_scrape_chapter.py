#!/usr/bin/env python3
"""Scrape one chapter's sources into extended/artifacts with rate limiting."""
from __future__ import annotations
import os
os.environ.setdefault("PYTHONUNBUFFERED", "1")

import json
import re
import subprocess
import sys
import time
from pathlib import Path
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parents[1]  # origins/sources/data
EXTENDED = Path(__file__).resolve().parent
DATA = ROOT
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


def host(url: str) -> str:
    return urlparse(url).netloc.lower().removeprefix("www.")


def is_skip_host(h: str) -> bool:
    """Exact host match only — never use endswith('x.com') (that false-skips vox.com)."""
    if h in SKIP_HOSTS:
        return True
    # Allow m.youtube.com / mobile.twitter.com style prefixes without suffix traps.
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
    # rate limit?
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
    return "ok"  # paywall decided later during enrichment


def main() -> int:
    if len(sys.argv) != 2:
        print("Usage: _scrape_chapter.py <chapter_number>")
        return 2
    ch = int(sys.argv[1])
    src_path = DATA / f"chapter-{ch:02d}.json"
    data = json.loads(src_path.read_text(encoding="utf-8"))
    ART.mkdir(parents=True, exist_ok=True)
    LOGS.mkdir(parents=True, exist_ok=True)
    cache = load_cache()

    before = firecrawl_status()
    m = re.search(r"Credits:\s*([0-9,]+)", before)
    credits_before = m.group(1).replace(",", "") if m else None

    results = []
    for s in data["sources"]:
        sid = f"ch{ch:02d}-s{s['id']:02d}"
        url = (s.get("url") or "").strip()
        out = ART / f"{sid}.md"
        entry = {
            "id": s["id"],
            "source_key": sid,
            "url": url,
            "ok": False,
            "status": "error",
            "bytes": 0,
            "error": None,
            "reused": False,
        }

        if not url:
            entry["status"] = "empty_url"
            results.append(entry)
            print(f"{sid}: empty_url")
            continue

        h = host(url)
        if is_skip_host(h):
            entry["status"] = "skipped"
            results.append(entry)
            print(f"{sid}: skipped ({h})")
            continue

        if url in cache and cache[url].get("artifact") and (EXTENDED / cache[url]["artifact"]).exists():
            # reuse prior artifact by copying path reference
            prior = cache[url]
            entry["ok"] = prior.get("status") in ("ok", "paywall")
            entry["status"] = prior.get("status", "ok")
            entry["reused"] = True
            entry["artifact"] = prior["artifact"]
            # also copy to this source key if different
            src_art = EXTENDED / prior["artifact"]
            if src_art.exists() and prior["artifact"] != f"artifacts/{sid}.md":
                out.write_text(src_art.read_text(encoding="utf-8", errors="replace"), encoding="utf-8")
                entry["artifact"] = f"artifacts/{sid}.md"
                entry["bytes"] = out.stat().st_size
            elif src_art.exists():
                entry["artifact"] = prior["artifact"]
                entry["bytes"] = src_art.stat().st_size
            results.append(entry)
            print(f"{sid}: reused -> {entry['status']}")
            continue

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

        results.append(entry)
        print(f"{sid}: {entry['status']} ({entry['bytes']} bytes) {err[:80] if err else ''}")
        save_cache(cache)

    after = firecrawl_status()
    m2 = re.search(r"Credits:\s*([0-9,]+)", after)
    credits_after = m2.group(1).replace(",", "") if m2 else None

    log = {
        "chapter": ch,
        "credits_before": int(credits_before) if credits_before else None,
        "credits_after": int(credits_after) if credits_after else None,
        "sources": results,
    }
    (LOGS / f"chapter-{ch:02d}.scrape.log.json").write_text(
        json.dumps(log, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
    )
    save_cache(cache)
    ok_n = sum(1 for r in results if r["status"] in ("ok", "paywall"))
    print(f"DONE chapter {ch}: {ok_n}/{len(results)} retrieved; credits {credits_before} -> {credits_after}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
