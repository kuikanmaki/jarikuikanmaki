#!/usr/bin/env python3
"""Rescue remaining preview thumbs via a real Chromium fetch (Playwright).

Use when urllib is blocked (403/AVIF/bot walls) but a desktop browser can load
the image. Writes the same WebP thumbs + manifest entries as
`_cache_preview_images.py`.

Requires: `npx playwright` with Chromium installed, plus macOS `sips` + `cwebp`.
"""

from __future__ import annotations

import json
import subprocess
import sys
import tempfile
from pathlib import Path

from _cache_preview_images import (
    MANIFEST_PATH,
    OUT_DIR,
    SITE_PREFIX,
    convert_to_webp,
    extract_artifact_candidates,
    has_local_thumb,
    is_remote,
    iter_sources,
    looks_like_image_bytes,
    unescape_url,
    utc_now,
)

ROOT = Path(__file__).resolve().parents[3]
JOBS_HELPER = r"""
const { chromium } = require('playwright');
const fs = require('fs');

(async () => {
  const jobs = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
  const outDir = process.argv[3];
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
    extraHTTPHeaders: {
      Accept: 'image/jpeg,image/png,image/webp,image/gif,image/*;q=0.8,*/*;q=0.5',
    },
  });
  const page = await context.newPage();
  const results = [];

  for (const job of jobs) {
    let saved = null;
    let err = 'no-url';
    for (const url of job.urls) {
      try {
        const res = await page.goto(url, {
          waitUntil: 'commit',
          timeout: 45000,
        });
        if (!res || !res.ok()) {
          err = `http-${res ? res.status() : 'null'}`;
          continue;
        }
        const ctype = (res.headers()['content-type'] || '').toLowerCase();
        const buf = Buffer.from(await res.body());
        if (!ctype.startsWith('image/') && buf.length < 1000) {
          err = `not-image:${ctype || 'unknown'}`;
          continue;
        }
        if (buf.slice(4, 12).toString() === 'ftypavif') {
          err = 'avif';
          continue;
        }
        const rawPath = `${outDir}/${job.key}.raw`;
        fs.writeFileSync(rawPath, buf);
        saved = { key: job.key, url, rawPath, bytes: buf.length, ctype };
        break;
      } catch (e) {
        err = String(e && e.message ? e.message : e).slice(0, 120);
      }
    }
    results.push(saved || { key: job.key, error: err });
    process.stdout.write(
      saved
        ? `ok ${job.key} ${saved.bytes}\n`
        : `fail ${job.key} ${err}\n`
    );
  }

  await browser.close();
  fs.writeFileSync(`${outDir}/results.json`, JSON.stringify(results, null, 2));
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
"""


def build_jobs() -> list[dict]:
    jobs = []
    for source in iter_sources():
        key = source["source_key"]
        if has_local_thumb(key):
            continue
        cands = extract_artifact_candidates(source)
        remote = unescape_url(source.get("image_url") or "")
        urls: list[str] = []
        for u in ([remote] if is_remote(remote) else []) + cands:
            if u not in urls:
                urls.append(u)
        if not urls:
            continue
        jobs.append({"key": key, "urls": urls[:5]})
    return jobs


def main() -> None:
    jobs = build_jobs()
    print(f"Browser rescue candidates: {len(jobs)}")
    if not jobs:
        return

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="preview-browser-") as tmp:
        tmp_dir = Path(tmp)
        jobs_path = tmp_dir / "jobs.json"
        script_path = tmp_dir / "fetch.js"
        raw_dir = tmp_dir / "raw"
        raw_dir.mkdir()
        jobs_path.write_text(json.dumps(jobs), encoding="utf-8")
        script_path.write_text(JOBS_HELPER, encoding="utf-8")

        cmd = [
            "npx",
            "--yes",
            "playwright",
            "test",
        ]
        # Prefer direct node + playwright from local node_modules
        fetch_cmd = [
            "node",
            str(script_path),
            str(jobs_path),
            str(raw_dir),
        ]
        env = dict(**{k: v for k, v in __import__("os").environ.items()})
        node_modules = ROOT / "node_modules"
        env["NODE_PATH"] = str(node_modules)
        print("Launching Chromium via Playwright…")
        proc = subprocess.run(
            fetch_cmd,
            cwd=str(ROOT),
            capture_output=True,
            text=True,
            env=env,
        )
        sys.stdout.write(proc.stdout)
        if proc.returncode != 0:
            sys.stderr.write(proc.stderr)
            raise SystemExit(f"playwright fetch failed ({proc.returncode})")

        results = json.loads((raw_dir / "results.json").read_text(encoding="utf-8"))
        manifest = (
            json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
            if MANIFEST_PATH.exists()
            else {}
        )
        ok = fail = 0
        for row in results:
            key = row["key"]
            if "error" in row or "rawPath" not in row:
                fail += 1
                continue
            raw = Path(row["rawPath"])
            data = raw.read_bytes()
            if not looks_like_image_bytes(data):
                # allow jpeg/png even if magic helper is strict
                if not (data[:3] == b"\xff\xd8\xff" or data[:8] == b"\x89PNG\r\n\x1a\n"):
                    print(f"  skip {key}: not an image ({row.get('ctype')})")
                    fail += 1
                    continue
            dest = OUT_DIR / f"{key}.webp"
            try:
                convert_to_webp(raw, dest)
            except Exception as err:
                print(f"  convert-fail {key}: {type(err).__name__}: {err}")
                fail += 1
                continue
            manifest[key] = {
                "remote": row["url"],
                "path": f"{SITE_PREFIX}/{key}.webp",
                "bytes": dest.stat().st_size,
                "fetched_at": utc_now(),
                "source": "browser",
            }
            ok += 1

        MANIFEST_PATH.write_text(
            json.dumps(dict(sorted(manifest.items())), indent=2, ensure_ascii=False) + "\n",
            encoding="utf-8",
        )
        print(f"Browser rescue done: ok={ok} fail={fail} thumbs={len(list(OUT_DIR.glob('*.webp')))}")


if __name__ == "__main__":
    main()
