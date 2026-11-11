#!/usr/bin/env python3
"""Attach publisher preview image URLs (og:image / suitable artifact image) to extended sources."""

from __future__ import annotations

import json
import re
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from urllib.parse import urlparse

DATA = Path(__file__).resolve().parent
EXTENDED = DATA / "extended"
CACHE_PATH = EXTENDED / "image-url-cache.json"
ART = EXTENDED / "artifacts"

SKIP_HOST_BITS = ("twitter.com", "x.com", "youtube.com", "youtu.be")
BAD_HINTS = (
    "logo",
    "icon",
    "sprite",
    "pixel",
    "tracking",
    "1x1",
    "favicon",
    "avatar",
    "badge",
    "banner",
    "placeholder",
    "base64-image-removed",
    "mailplusbanner",
    "nature-briefing-logo",
)
MD_IMG = re.compile(r"!\[[^\]]*\]\((https?://[^)\s]+)\)")
OG_PATTERNS = [
    re.compile(r'property=["\']og:image(?::secure_url)?["\']\s+content=["\']([^"\']+)', re.I),
    re.compile(r'content=["\']([^"\']+)["\']\s+property=["\']og:image(?::secure_url)?["\']', re.I),
    re.compile(r'name=["\']twitter:image(?::src)?["\']\s+content=["\']([^"\']+)', re.I),
    re.compile(r'content=["\']([^"\']+)["\']\s+name=["\']twitter:image(?::src)?["\']', re.I),
]


def is_pdf(url: str) -> bool:
    u = url.lower()
    return u.endswith(".pdf") or "/pdf/" in u or "/pdf?" in u


def looks_like_preview(url: str) -> bool:
    low = url.lower()
    if not low.startswith("http"):
        return False
    if any(h in low for h in BAD_HINTS):
        return False
    path = urlparse(low).path
    if path.endswith(".svg"):
        return False
    if any(path.endswith(ext) for ext in (".jpg", ".jpeg", ".png", ".webp", ".gif")):
        return True
    # CDN paths often omit extensions but include image-ish segments
    if any(x in low for x in ("/image", "/images/", "/photos/", "/media/", "wp-content/uploads", "cdn", "cache/file")):
        return True
    return False


def artifact_fallback(source_key: str | None, artifact: str | None) -> str | None:
    path = None
    if artifact:
        path = EXTENDED / artifact
    elif source_key:
        path = ART / f"{source_key}.md"
    if not path or not path.exists():
        return None
    text = path.read_text(encoding="utf-8", errors="ignore")[:12000]
    for url in MD_IMG.findall(text):
        if looks_like_preview(url):
            return url
    return None


def fetch_og_image(url: str) -> str | None:
    req = urllib.request.Request(
        url,
        headers={
            "User-Agent": "Mozilla/5.0 (compatible; OriginsCatalogBot/1.0; +https://jarikuikanmaki.com)",
            "Accept": "text/html,application/xhtml+xml",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=12) as resp:
            ctype = (resp.headers.get("Content-Type") or "").lower()
            if "html" not in ctype and "xml" not in ctype and ctype:
                return None
            chunk = resp.read(250_000).decode("utf-8", "ignore")
    except Exception:
        return None
    for pat in OG_PATTERNS:
        m = pat.search(chunk)
        if m and looks_like_preview(m.group(1).strip()):
            return m.group(1).strip()
    return None


def resolve_image(url: str, source_key: str | None, artifact: str | None) -> str | None:
    if not url or is_pdf(url):
        return None
    host = urlparse(url).netloc.lower()
    if any(h in host for h in SKIP_HOST_BITS):
        return None
    return fetch_og_image(url) or artifact_fallback(source_key, artifact)


def main() -> None:
    cache = json.loads(CACHE_PATH.read_text()) if CACHE_PATH.exists() else {}
    chapter_files = sorted(EXTENDED.glob("chapter-*.json"))

    unique: dict[str, tuple[str | None, str | None]] = {}
    for path in chapter_files:
        data = json.loads(path.read_text())
        for source in data.get("sources") or []:
            url = source.get("url") or ""
            if url and url not in unique:
                unique[url] = (source.get("source_key"), source.get("artifact"))

    todo = [u for u in unique if u not in cache]
    print(f"Resolving images for {len(todo)} new URLs ({len(unique)} unique total)…")

    with ThreadPoolExecutor(max_workers=8) as pool:
        futs = {
            pool.submit(resolve_image, url, unique[url][0], unique[url][1]): url
            for url in todo
        }
        done = 0
        for fut in as_completed(futs):
            url = futs[fut]
            image = None
            try:
                image = fut.result()
            except Exception:
                image = None
            cache[url] = image or ""
            done += 1
            if done % 25 == 0:
                CACHE_PATH.write_text(json.dumps(cache, indent=2, ensure_ascii=False) + "\n")
                print(f"  {done}/{len(todo)}")

    CACHE_PATH.write_text(json.dumps(cache, indent=2, ensure_ascii=False) + "\n")

    with_img = 0
    total = 0
    for path in chapter_files:
        data = json.loads(path.read_text())
        changed = False
        for source in data.get("sources") or []:
            total += 1
            url = source.get("url") or ""
            image = (cache.get(url) or None) if url else None
            if url and not image:
                image = artifact_fallback(source.get("source_key"), source.get("artifact"))
                if image:
                    cache[url] = image
            if image:
                if source.get("image_url") != image:
                    source["image_url"] = image
                    changed = True
                with_img += 1
            elif "image_url" in source:
                del source["image_url"]
                changed = True
        if changed:
            path.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n")

    CACHE_PATH.write_text(json.dumps(cache, indent=2, ensure_ascii=False) + "\n")
    print(f"Done: {with_img}/{total} sources have image_url")


if __name__ == "__main__":
    main()
