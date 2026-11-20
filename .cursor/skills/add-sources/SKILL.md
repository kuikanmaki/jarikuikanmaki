---
name: add-sources
description: >-
  Mint one or more Origins Sources bibliographic records into
  extended/chapter-NN.json (including id gap-fill), scrape artifacts for only
  those keys, optionally enrich images / link authorities, and rebuild public
  indexes. Use when adding new catalog sources, filling a missing source_key
  (e.g. ch19-s22), or batch-ingesting citations into the corpus.
---

# Add Origins Sources

## Principle

Durable logic lives in `origins/sources/data/_add_sources.py`. This skill
**collects stubs → runs that CLI → reports results**. Do not hand-edit chapter
JSON or reimplement scrape/enrich in the agent unless the CLI is broken.

Never run `extended/_build_extended.py` on live chapters.

## When to use

- User wants to add one or many new sources to the catalog
- A Notes heading cites an id that has no row (gap-fill with explicit `id`)
- User pastes citations / URLs and wants ingest + artifact scrape

## Steps

1. **Collect stubs** (one object per source). Required: `chapter`, `title`.
   Usual: `author`, `publication`, `date`, `date_iso`, `url`, `type`,
   `content_kind`, `language`, `summary`. Optional: `id` (gap-fill),
   `section` (`main` default, or `notes`), `book_role`, `topics`, `entities`,
   `topic_ids`, `entity_ids`, `image_url`, `acquisition_note`.

   Prefer `topic_ids` / `entity_ids` when authorities are known. `--link` only
   resolves `author` / `publication`; label sync clears free-text `topics`
   that have no `topic_ids`. After mint, patch ids + re-run
   `_sync_labels_from_authorities.py` and `--rebuild` if needed.

2. **Validate intent**
   - Prefer the book’s citation wording for `title` / `date` when the user
     supplies a printed form.
   - Use explicit `id` when filling a gap; omit `id` to append next free.
   - Confirm the URL is not already in another `source_key` (CLI also checks).

3. **Dry-run first** (unless the user already approved exact stubs):

   ```bash
   cd origins/sources/data
   python3 _add_sources.py --stub '…' --dry-run
   # or: python3 _add_sources.py --stubs-file stubs.json --dry-run
   ```

4. **Mint + pipeline** (typical full run):

   ```bash
   python3 _add_sources.py \
     --stub '…' \
     --scrape --only-missing \
     --enrich-images --link --rebuild
   ```

   Flags:
   - `--scrape` — `extended/_scrape_chapter.py` with `--keys` for minted keys only
   - `--only-missing` — skip keys that already have an artifact
   - `--enrich-images` — `_enrich_image_urls.py` + `_cache_preview_images.py --primary`
   - `--link` — authors, publications, label sync
   - `--rebuild` — corpus-index + verify + authority search index
   - `--force` — overwrite an existing id (rare)

5. **Report** minted `source_key`s, scrape status / artifact path, and what still
   needs human review (`summary`, `book_role`, topics). Do **not** invent final
   narrative fields without review — draft stubs are OK; leave polish to the user
   unless they asked you to fill them.

6. **Commit / push** only if the user asks.

## Stub JSON shape

```json
{
  "chapter": 19,
  "id": 22,
  "section": "main",
  "type": "News article",
  "author": "Kopp, Emily",
  "title": "US scientists proposed to make viruses with unique features of SARS-CoV-2 in Wuhan",
  "publication": "U.S. Right to Know",
  "date": "January 18, 2024",
  "date_iso": "2024-01-18",
  "url": "https://usrtk.org/covid-19-origins/scientists-proposed-making-viruses-with-unique-features-of-sars-cov-2-in-wuhan/",
  "content_kind": "html_article",
  "language": "en",
  "summary": "…"
}
```

Batch: `--stubs-file` with a JSON array, or `{"stubs":[…]}`.

## Reference

See `origins/sources/data/README.md` §8.2 / §9 (add-sources workflow).
