#!/usr/bin/env python3
"""Download publisher preview images and cache local WebP thumbnails.

Extended chapters keep remote `image_url` values (enrichment source of truth).
This script writes:

  assets/source-previews/{source_key}.webp
  assets/source-previews/manifest.json

`_build_corpus_index.py` prefers the local thumb when the file exists so the
public catalog does not hotlink publisher CDNs.

Requires: network, plus macOS `sips` and Homebrew `cwebp` (or any `cwebp` on PATH).
"""

from __future__ import annotations

import html
import json
import mimetypes
import subprocess
import tempfile
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlparse

DATA = Path(__file__).resolve().parent
EXTENDED = DATA / "extended"
REPO = DATA.parents[2]
OUT_DIR = REPO / "assets" / "source-previews"
MANIFEST_PATH = OUT_DIR / "manifest.json"
SITE_PREFIX = "/assets/source-previews"
SOURCE_ARRAYS = ("sources", "notes_sources")

MAX_EDGE = 640
WEBP_QUALITY = "80"
MAX_DOWNLOAD_BYTES = 8_000_000
WORKERS = 6


def unescape_url(url: str) -> str:
    return html.unescape((url or "").strip())


def is_remote(url: str) -> bool:
    return unescape_url(url).lower().startswith(("http://", "https://"))


def iter_image_sources():
    for path in sorted(EXTENDED.glob("chapter-*.json")):
        data = json.loads(path.read_text(encoding="utf-8"))
        for section in SOURCE_ARRAYS:
            for source in data.get(section) or []:
                key = source.get("source_key")
                remote = unescape_url(source.get("image_url") or "")
                if not key or not is_remote(remote):
                    continue
                yield key, remote


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
    b"\xff\xd8\xff",  # jpeg
    b"\x89PNG\r\n\x1a\n",  # png
    b"GIF87a",
    b"GIF89a",
    b"RIFF",  # webp/wav container — check further
    b"BM",  # bmp
)


def looks_like_image_bytes(data: bytes) -> bool:
    if len(data) < 12:
        return False
    if data.startswith(b"RIFF") and data[8:12] == b"WEBP":
        return True
    return any(data.startswith(sig) for sig in IMAGE_MAGIC if sig != b"RIFF")


def download(url: str, dest: Path) -> str:
    req = urllib.request.Request(
        url,
        headers={
            "User-Agent": (
                "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15"
            ),
            "Accept": "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
            "Referer": "https://jarikuikanmaki.com/",
        },
    )
    with urllib.request.urlopen(req, timeout=25) as resp:
        ctype = (resp.headers.get("Content-Type") or "").split(";")[0].strip().lower()
        data = resp.read(MAX_DOWNLOAD_BYTES + 1)
        if len(data) > MAX_DOWNLOAD_BYTES:
            raise ValueError("download too large")
        if not data:
            raise ValueError("empty body")
        if ctype and not ctype.startswith("image/") and ctype not in ("application/octet-stream",):
            raise ValueError(f"non-image content-type:{ctype}")
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
    # Reject icons/avatars before sips upscales them.
    src_w, src_h = sips_pixel_size(src)
    if max(src_w, src_h) < 120:
        raise ValueError(f"image too small:{src_w}x{src_h}")
    with tempfile.TemporaryDirectory(prefix="preview-thumb-") as tmp:
        tmp_dir = Path(tmp)
        # Force JPEG intermediate — more reliable than PNG for odd inputs.
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


def process_one(source_key: str, remote: str, manifest: dict) -> tuple[str, dict | None, str]:
    """Returns (source_key, entry_or_None, status)."""
    out_path = OUT_DIR / f"{source_key}.webp"
    site_path = f"{SITE_PREFIX}/{source_key}.webp"
    prev = manifest.get(source_key) or {}
    if (
        out_path.is_file()
        and prev.get("remote") == remote
        and prev.get("path") == site_path
        and out_path.stat().st_size > 0
    ):
        return source_key, prev, "skip"

    with tempfile.TemporaryDirectory(prefix=f"dl-{source_key}-") as tmp:
        tmp_dir = Path(tmp)
        try:
            ctype = download(remote, tmp_dir / f"raw{guess_suffix(remote, None)}")
            raw = next(tmp_dir.glob("raw*"))
            # Re-download into correctly suffixed file if Content-Type is clearer.
            # (Already saved; sips usually doesn't need the perfect suffix.)
            _ = ctype
            convert_to_webp(raw, out_path)
        except (urllib.error.URLError, urllib.error.HTTPError, ValueError, OSError, subprocess.CalledProcessError, RuntimeError) as err:
            if out_path.exists() and prev.get("remote") == remote:
                return source_key, prev, "keep-old"
            if out_path.exists() and prev.get("remote") != remote:
                # Stale file for a new remote that failed — leave old file only if remotes match.
                pass
            return source_key, None, f"fail:{type(err).__name__}"

    entry = {
        "remote": remote,
        "path": site_path,
        "bytes": out_path.stat().st_size,
        "fetched_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    }
    return source_key, entry, "ok"


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    manifest = json.loads(MANIFEST_PATH.read_text(encoding="utf-8")) if MANIFEST_PATH.exists() else {}

    items = list(iter_image_sources())
    # Last write wins if a key somehow appeared twice (should not).
    by_key = {key: remote for key, remote in items}
    print(f"Caching preview thumbs for {len(by_key)} sources → {OUT_DIR}")

    stats = {"ok": 0, "skip": 0, "fail": 0, "keep-old": 0}
    failures: list[tuple[str, str]] = []

    with ThreadPoolExecutor(max_workers=WORKERS) as pool:
        futs = {
            pool.submit(process_one, key, remote, manifest): key
            for key, remote in sorted(by_key.items())
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
                # Drop stale manifest entry if file missing
                if key in manifest and not (OUT_DIR / f"{key}.webp").exists():
                    del manifest[key]
            if done % 25 == 0 or done == len(futs):
                MANIFEST_PATH.write_text(
                    json.dumps(dict(sorted(manifest.items())), indent=2, ensure_ascii=False) + "\n",
                    encoding="utf-8",
                )
                print(f"  {done}/{len(futs)}  ok={stats['ok']} skip={stats['skip']} fail={stats['fail']}")

    # Drop manifest rows whose files vanished
    for key in list(manifest):
        if not (OUT_DIR / f"{key}.webp").is_file():
            del manifest[key]

    MANIFEST_PATH.write_text(
        json.dumps(dict(sorted(manifest.items())), indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )
    print(
        f"Done: {len(manifest)} thumbs on disk "
        f"(ok={stats['ok']} skip={stats['skip']} keep-old={stats['keep-old']} fail={stats['fail']})"
    )
    if failures:
        print("Failures (first 20):")
        for key, status in failures[:20]:
            print(f"  {key}: {status}")


if __name__ == "__main__":
    main()
