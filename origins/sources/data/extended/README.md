# Extended corpus (bibliographic source of truth)

`chapter-*.json` in this directory are the **sole catalog records** for Origins sources.

For the full data dictionary, workflows, and integrity checklist, see **[../README.md](../README.md)**.

| Path | Role |
|---|---|
| `chapter-*.json` | Canonical bibliographic + acquisition fields (`status`, `url`, `artifact`, `acquisition_note`, authority ids); may include `notes_sources` |
| `artifacts/` | Captured text/PDF extracts (gitignored); `chNN-sMM.md` (main) / `chNN-nMM.md` (notes) |
| `url-cache.json` | **Pipeline cache only** (gitignored) — rebuilt from chapter records |
| `logs/` | Scrape run journals (gitignored); not visitor-facing |
| `image-url-cache.json` | Enrichment cache for `image_url` (gitignored) |
| `_scrape_chapter.py` | Scrape + patch catalog in place (`--section main\|notes\|all`) |
| `_build_extended.py` | Legacy; refuses to overwrite live chapters |

Visitor-facing data is generated into `../corpus-index.json` and `../authority-search-index.json`.
