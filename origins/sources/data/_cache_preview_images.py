#!/usr/bin/env python3
"""Download publisher preview images and cache local WebP thumbnails.

Extended chapters keep remote `image_url` values (enrichment source of truth).
This script writes:

  assets/source-previews/{source_key}.webp
  assets/source-previews/manifest.json

`_build_corpus_index.py` prefers the local thumb when the file exists so the
public catalog does not hotlink publisher CDNs.

Passes
------
1. Primary: download each extended `image_url` (remote http).
2. Artifact rescue: for sources still missing a local thumb, pick a plausible
   main image from the Firecrawl artifact markdown/HTML and cache that.

Requires: network, plus macOS `sips` and Homebrew `cwebp` (or any `cwebp` on PATH).

Usage:
  python3 _cache_preview_images.py              # both passes
  python3 _cache_preview_images.py --primary    # image_url only
  python3 _cache_preview_images.py --artifacts  # rescue pass only
"""

from __future__ import annotations

import argparse
import html
import json
import mimetypes
import re
import subprocess
import tempfile
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import parse_qs, urlparse

DATA = Path(__file__).resolve().parent
EXTENDED = DATA / "extended"
ART = EXTENDED / "artifacts"
REPO = DATA.parents[2]
OUT_DIR = REPO / "assets" / "source-previews"
MANIFEST_PATH = OUT_DIR / "manifest.json"
SITE_PREFIX = "/assets/source-previews"
SOURCE_ARRAYS = ("sources", "notes_sources")

MAX_EDGE = 640
WEBP_QUALITY = "80"
MAX_DOWNLOAD_BYTES = 8_000_000
WORKERS = 6
MAX_ARTIFACT_CANDIDATES = 6

MD_IMG = re.compile(r"!\[[^\]]*\]\((https?://[^)\s]+)\)")
HTML_IMG = re.compile(r"<img[^>]+src=[\"']([^\"']+)[\"']", re.I)
OG_IMG = re.compile(
    r'(?:property|name)=[\"\'](?:og:image(?::secure_url)?|twitter:image(?::src)?)[\"\'][^>]*content=[\"\']([^\"\']+)[\"\']'
    r'|content=[\"\']([^\"\']+)[\"\'][^>]*(?:property|name)=[\"\'](?:og:image(?::secure_url)?|twitter:image(?::src)?)[\"\']',
    re.I,
)
DIM_IN_PATH = re.compile(r"(?:^|[^\d])(\d{3,4})x(\d{3,4})(?:[^\d]|$)", re.I)
FILL_SIZE = re.compile(r"resize:fill:(\d+):(\d+)", re.I)

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
    "loading",
    "channelheaders",
    "twitter.png",
    "fb-blue.png",
    "highwire/images",
    "-default.png",
    "/default.png",
    "og-image.png",
    "proton-og-image",
    "base64-image-removed",
    "mailplusbanner",
    "nature-briefing-logo",
    "web-static.archive.org/_static",
    "profile-background",
    "stock-no-photo",
    "buyside/content-images",
    "uedata=",
    "fls-na.amazon.com",
    "batch/1/OP/",
    "s170x170",
    "resize:fill:32",
    "resize:fill:40",
    "resize:fill:48",
    "resize:fill:64",
    "resize:fill:80",
)


def unescape_url(url: str) -> str:
    return html.unescape((url or "").strip())


def is_remote(url: str) -> bool:
    return unescape_url(url).lower().startswith(("http://", "https://"))


def utc_now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def guess_suffix(url: str, content_type: str | None) -> str:
    if content_type:
        ctype = content_type.split(";")[0].strip().lower()
        ext = mimetypes.guess_extension(ctype)
        if ext == ".jpe":
            ext = ".jpg"
        if ext in (".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp", ".tif", ".tiff"):
            return ext
    path = urlparse(url).path.lower()
    for ext in (".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp"):
        if path.endswith(ext):
            return ".jpg" if ext == ".jpeg" else ext
    return ".img"


IMAGE_MAGIC = (
    b"\xff\xd8\xff",
    b"\x89PNG\r\n\x1a\n",
    b"GIF87a",
    b"GIF89a",
    b"RIFF",
    b"BM",
)


def looks_like_image_bytes(data: bytes) -> bool:
    if len(data) < 12:
        return False
    if data.startswith(b"RIFF") and data[8:12] == b"WEBP":
        return True
    return any(data.startswith(sig) for sig in IMAGE_MAGIC if sig != b"RIFF")


def prefer_jpeg_url(url: str) -> str:
    """Bump tiny CDN width params and nudge formats toward JPEG when possible."""
    from urllib.parse import urlencode, urlunparse

    u = urlparse(url)
    qs = parse_qs(u.query, keep_blank_values=True)
    changed = False
    for key in ("width", "w", "maxwidth"):
        if key in qs:
            try:
                val = int(qs[key][0])
            except ValueError:
                continue
            if val < 400:
                qs[key] = ["800"]
                changed = True
    # Prefer jpeg over auto/avif when the CDN honors format/query knobs.
    for key, val in (("format", "jpg"), ("fm", "jpg"), ("auto", "format")):
        if key == "auto" and "auto" in qs:
            continue
        if key in ("format", "fm") and key in qs and qs[key][0].lower() in ("avif", "auto", "webp"):
            qs[key] = [val]
            changed = True
        elif key in ("format", "fm") and key not in qs and any(
            h in u.netloc for h in ("images.ft.com", "content.api.news", "image.minerva")
        ):
            qs[key] = [val]
            changed = True
    if not changed:
        return url
    return urlunparse((u.scheme, u.netloc, u.path, u.params, urlencode(qs, doseq=True), u.fragment))


def download(url: str, dest: Path, referer: str | None = None) -> str:
    # Prefer JPEG/PNG — many CDNs (WSJ, FT, Reuters) return AVIF when Accept lists it
    # first, and our sips pipeline cannot decode AVIF.
    headers = {
        "User-Agent": (
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
            "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15"
        ),
        "Accept": "image/jpeg,image/png,image/webp,image/gif,image/*;q=0.8,*/*;q=0.5",
    }
    if referer:
        headers["Referer"] = referer
    req = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(req, timeout=25) as resp:
        ctype = (resp.headers.get("Content-Type") or "").split(";")[0].strip().lower()
        data = resp.read(MAX_DOWNLOAD_BYTES + 1)
        if len(data) > MAX_DOWNLOAD_BYTES:
            raise ValueError("download too large")
        if not data:
            raise ValueError("empty body")
        if ctype and not ctype.startswith("image/") and ctype not in ("application/octet-stream",):
            raise ValueError(f"non-image content-type:{ctype}")
        # AVIF slipped through despite Accept — reject so caller can try another URL.
        if data[4:12] == b"ftypavif" or data[4:12] == b"ftypavis" or ctype == "image/avif":
            raise ValueError("avif-not-supported")
        if not looks_like_image_bytes(data):
            raise ValueError("body is not an image")
        dest.write_bytes(data)
        return ctype or ""


def run(cmd: list[str]) -> None:
    subprocess.run(cmd, check=True, capture_output=True)


def sips_pixel_size(path: Path) -> tuple[int, int]:
    r = subprocess.run(
        ["sips", "-g", "pixelWidth", "-g", "pixelHeight", str(path)],
        check=True,
        capture_output=True,
        text=True,
    )
    w = h = 0
    for line in r.stdout.splitlines():
        if "pixelWidth:" in line:
            w = int(line.split(":")[-1].strip())
        elif "pixelHeight:" in line:
            h = int(line.split(":")[-1].strip())
    return w, h


def convert_to_webp(src: Path, dest: Path) -> None:
    src_w, src_h = sips_pixel_size(src)
    if max(src_w, src_h) < 120:
        raise ValueError(f"image too small:{src_w}x{src_h}")
    with tempfile.TemporaryDirectory(prefix="preview-thumb-") as tmp:
        tmp_dir = Path(tmp)
        jpg = tmp_dir / "resized.jpg"
        run(
            [
                "sips",
                "-s",
                "format",
                "jpeg",
                "-Z",
                str(MAX_EDGE),
                str(src),
                "--out",
                str(jpg),
            ]
        )
        if not jpg.exists() or jpg.stat().st_size == 0:
            raise RuntimeError("sips produced no output")
        run(
            [
                "cwebp",
                "-quiet",
                "-q",
                WEBP_QUALITY,
                str(jpg),
                "-o",
                str(dest),
            ]
        )
        if not dest.exists() or dest.stat().st_size < 500:
            raise RuntimeError("cwebp produced empty/tiny output")


def hinted_dims(url: str) -> tuple[int, int]:
    low = url.lower()
    qs = parse_qs(urlparse(url).query)
    w = h = 0
    for key in ("width", "w", "maxwidth"):
        if key in qs:
            try:
                w = max(w, int(qs[key][0]))
            except ValueError:
                pass
    for key in ("height", "h", "maxheight"):
        if key in qs:
            try:
                h = max(h, int(qs[key][0]))
            except ValueError:
                pass
    m = FILL_SIZE.search(low)
    if m:
        w = max(w, int(m.group(1)))
        h = max(h, int(m.group(2)))
    m = DIM_IN_PATH.search(urlparse(url).path)
    if m:
        w = max(w, int(m.group(1)))
        h = max(h, int(m.group(2)))
    return w, h


def candidate_score(url: str, index: int) -> int:
    low = url.lower()
    if any(b in low for b in BAD_HINTS):
        return -10_000
    path = urlparse(low).path
    if path.endswith(".svg"):
        return -10_000
    score = 80 - min(index, 40)  # prefer earlier document order
    w, h = hinted_dims(url)
    edge = max(w, h)
    if edge:
        if edge < 120:
            score -= 200
        elif edge < 200:
            score -= 40
        elif edge < 400:
            score += 15
        elif edge < 700:
            score += 40
        else:
            score += 60
    if any(path.endswith(ext) for ext in (".jpg", ".jpeg", ".png", ".webp")):
        score += 12
    if path.endswith(".gif"):
        score -= 15
    if any(x in low for x in ("/cms/asset/", "_main_", "wp-content/uploads", "og-image", "hero", "feature")):
        score += 18
    if "thumb" in low or "sprite" in low:
        score -= 50
    if "im_/" in low or "web.archive.org/web/" in low:
        score += 8
    return score


def looks_like_preview_url(url: str) -> bool:
    return candidate_score(url, 0) > -1000


def artifact_path_for(source: dict) -> Path | None:
    art = source.get("artifact") or ""
    if art:
        path = EXTENDED / art
    else:
        key = source.get("source_key")
        path = ART / f"{key}.md" if key else None
    if path and path.is_file():
        return path
    return None


def extract_artifact_candidates(source: dict) -> list[str]:
    path = artifact_path_for(source)
    if not path:
        return []
    text = path.read_text(encoding="utf-8", errors="ignore")[:120_000]
    found: list[str] = []
    seen: set[str] = set()

    def add(raw: str) -> None:
        u = unescape_url(raw)
        if not is_remote(u) or u in seen:
            return
        seen.add(u)
        found.append(u)

    for m in OG_IMG.finditer(text):
        add(next(g for g in m.groups() if g))
    for u in MD_IMG.findall(text):
        add(u)
    for u in HTML_IMG.findall(text):
        add(u)

    ranked = sorted(
        ((candidate_score(u, i), -i, u) for i, u in enumerate(found)),
        reverse=True,
    )
    out = [u for score, _i, u in ranked if score > 0]
    return out[:MAX_ARTIFACT_CANDIDATES]


def iter_sources():
    for path in sorted(EXTENDED.glob("chapter-*.json")):
        data = json.loads(path.read_text(encoding="utf-8"))
        for section in SOURCE_ARRAYS:
            for source in data.get(section) or []:
                key = source.get("source_key")
                if key:
                    yield source


def has_local_thumb(source_key: str) -> bool:
    return (OUT_DIR / f"{source_key}.webp").is_file()


def process_candidates(
    source_key: str,
    candidates: list[str],
    manifest: dict,
    source_tag: str,
    referer: str | None = None,
) -> tuple[str, dict | None, str]:
    out_path = OUT_DIR / f"{source_key}.webp"
    site_path = f"{SITE_PREFIX}/{source_key}.webp"
    prev = manifest.get(source_key) or {}

    # Skip only when an existing thumb still matches the first candidate we would use.
    if (
        out_path.is_file()
        and candidates
        and prev.get("remote") == candidates[0]
        and prev.get("path") == site_path
        and out_path.stat().st_size > 0
    ):
        return source_key, prev, "skip"

    last_err = "fail:no-candidate"
    for remote in candidates:
        if not looks_like_preview_url(remote):
            continue
        urls_to_try = [prefer_jpeg_url(remote)]
        if urls_to_try[0] != remote:
            urls_to_try.append(remote)

        saw_forbidden = False
        for try_url in urls_to_try:
            with tempfile.TemporaryDirectory(prefix=f"dl-{source_key}-") as tmp:
                tmp_dir = Path(tmp)
                try:
                    download(
                        try_url,
                        tmp_dir / f"raw{guess_suffix(try_url, None)}",
                        referer=referer,
                    )
                    raw = next(tmp_dir.glob("raw*"))
                    convert_to_webp(raw, out_path)
                except urllib.error.HTTPError as err:
                    last_err = f"fail:HTTPError"
                    if err.code in (401, 403, 451):
                        saw_forbidden = True
                    continue
                except (
                    urllib.error.URLError,
                    ValueError,
                    OSError,
                    subprocess.CalledProcessError,
                    RuntimeError,
                ) as err:
                    last_err = f"fail:{type(err).__name__}"
                    continue
                entry = {
                    "remote": try_url,
                    "path": site_path,
                    "bytes": out_path.stat().st_size,
                    "fetched_at": utc_now(),
                    "source": source_tag,
                }
                return source_key, entry, "ok"

        # Only hit Wayback for hard publisher blocks (avoid rate-limit spam).
        if saw_forbidden and "web.archive.org" not in remote:
            wb = f"https://web.archive.org/web/0im_/{remote}"
            with tempfile.TemporaryDirectory(prefix=f"dl-{source_key}-wb-") as tmp:
                tmp_dir = Path(tmp)
                try:
                    download(wb, tmp_dir / f"raw{guess_suffix(wb, None)}", referer=referer)
                    raw = next(tmp_dir.glob("raw*"))
                    convert_to_webp(raw, out_path)
                    entry = {
                        "remote": wb,
                        "path": site_path,
                        "bytes": out_path.stat().st_size,
                        "fetched_at": utc_now(),
                        "source": source_tag + "+wayback",
                    }
                    return source_key, entry, "ok"
                except (
                    urllib.error.URLError,
                    urllib.error.HTTPError,
                    ValueError,
                    OSError,
                    subprocess.CalledProcessError,
                    RuntimeError,
                ) as err:
                    last_err = f"fail:{type(err).__name__}"

    if out_path.exists() and prev:
        return source_key, prev, "keep-old"
    return source_key, None, last_err


def run_pool(
    jobs: list[tuple[str, list[str], str, str | None]], manifest: dict, label: str
) -> dict:
    if not jobs:
        print(f"{label}: nothing to do")
        return manifest

    print(f"{label}: {len(jobs)} sources → {OUT_DIR}")
    stats = {"ok": 0, "skip": 0, "fail": 0, "keep-old": 0}
    failures: list[tuple[str, str]] = []

    with ThreadPoolExecutor(max_workers=WORKERS) as pool:
        futs = {
            pool.submit(process_candidates, key, cands, manifest, tag, ref): key
            for key, cands, tag, ref in jobs
        }
        done = 0
        for fut in as_completed(futs):
            key = futs[fut]
            entry = None
            status = "fail"
            try:
                key, entry, status = fut.result()
            except Exception as err:
                status = f"fail:{type(err).__name__}"
                entry = None
            done += 1
            if status == "ok":
                stats["ok"] += 1
                manifest[key] = entry
            elif status == "skip":
                stats["skip"] += 1
            elif status == "keep-old":
                stats["keep-old"] += 1
            else:
                stats["fail"] += 1
                failures.append((key, status))
                if key in manifest and not (OUT_DIR / f"{key}.webp").exists():
                    del manifest[key]
            if done % 25 == 0 or done == len(futs):
                MANIFEST_PATH.write_text(
                    json.dumps(dict(sorted(manifest.items())), indent=2, ensure_ascii=False)
                    + "\n",
                    encoding="utf-8",
                )
                print(
                    f"  {done}/{len(futs)}  ok={stats['ok']} skip={stats['skip']} "
                    f"fail={stats['fail']}"
                )

    print(
        f"{label} done: ok={stats['ok']} skip={stats['skip']} "
        f"keep-old={stats['keep-old']} fail={stats['fail']}"
    )
    if failures:
        print(f"{label} failures (first 20):")
        for key, status in failures[:20]:
            print(f"  {key}: {status}")
    return manifest


def primary_jobs() -> list[tuple[str, list[str], str, str | None]]:
    by_key: dict[str, tuple[str, list[str], str, str | None]] = {}
    for source in iter_sources():
        key = source["source_key"]
        remote = unescape_url(source.get("image_url") or "")
        page = unescape_url(source.get("url") or "") or None
        if is_remote(remote):
            by_key[key] = (
                key,
                [remote],
                "image_url",
                page if is_remote(page or "") else None,
            )
    return [by_key[k] for k in sorted(by_key)]


def artifact_jobs() -> list[tuple[str, list[str], str, str | None]]:
    jobs = []
    for source in iter_sources():
        key = source["source_key"]
        if has_local_thumb(key):
            continue
        cands = extract_artifact_candidates(source)
        # If extended still has a remote that failed earlier, try it first,
        # then artifact picks (may be better alternate URLs).
        remote = unescape_url(source.get("image_url") or "")
        page = unescape_url(source.get("url") or "") or None
        ordered: list[str] = []
        seen: set[str] = set()
        for u in ([remote] if is_remote(remote) else []) + cands:
            if u in seen:
                continue
            seen.add(u)
            ordered.append(u)
        if ordered:
            jobs.append(
                (
                    key,
                    ordered[:MAX_ARTIFACT_CANDIDATES],
                    "artifact",
                    page if is_remote(page or "") else None,
                )
            )
    return jobs


def finalize_manifest(manifest: dict) -> dict:
    for key in list(manifest):
        if not (OUT_DIR / f"{key}.webp").is_file():
            del manifest[key]
    MANIFEST_PATH.write_text(
        json.dumps(dict(sorted(manifest.items())), indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )
    return manifest


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--primary", action="store_true", help="Only cache extended image_url values")
    parser.add_argument(
        "--artifacts",
        action="store_true",
        help="Only rescue missing thumbs from artifact images",
    )
    args = parser.parse_args()
    do_primary = args.primary or not (args.primary or args.artifacts)
    do_artifacts = args.artifacts or not (args.primary or args.artifacts)
    # If neither flag: both. If one flag: only that.
    if args.primary and not args.artifacts:
        do_artifacts = False
    if args.artifacts and not args.primary:
        do_primary = False

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    manifest = json.loads(MANIFEST_PATH.read_text(encoding="utf-8")) if MANIFEST_PATH.exists() else {}

    if do_primary:
        manifest = run_pool(primary_jobs(), manifest, "Primary image_url")
        manifest = finalize_manifest(manifest)

    if do_artifacts:
        manifest = run_pool(artifact_jobs(), manifest, "Artifact rescue")
        manifest = finalize_manifest(manifest)

    local = len(list(OUT_DIR.glob("*.webp")))
    print(f"Thumbs on disk: {local}")


if __name__ == "__main__":
    main()
