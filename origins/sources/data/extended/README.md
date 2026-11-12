# Extended corpus (bibliographic source of truth)

`chapter-*.json` in this directory are the **sole catalog records** for Origins sources.

For the full data dictionary, workflows, and integrity checklist, see **[../README.md](../README.md)**.

| Path | Role |
|---|---|
| `chapter-*.json` | Canonical bibliographic + acquisition fields (`status`, `url`, `artifact`, `acquisition_note`, authority ids) |
| `artifacts/` | Captured text/PDF extracts (gitignored); paths referenced from chapter records |
| `url-cache.json` | **Pipeline cache only** (gitignored) — rebuilt from chapter records |
| `logs/` | Scrape run journals (gitignored); not visitor-facing |
| `image-url-cache.json` | Enrichment cache for `image_url` (gitignored) |

Visitor-facing data is generated into `../corpus-index.json` and `../authority-search-index.json`.
