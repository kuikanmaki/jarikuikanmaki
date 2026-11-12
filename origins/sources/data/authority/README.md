# Authority files

Canonical names for people, organizations, places, topics, events, and works in the Origins extended corpus.

## Bibliographic source of truth

- **Catalog records:** `../extended/chapter-*.json` only (one file per chapter).
- **Public browse/search views:** generated `../corpus-index.json` and `../authority-search-index.json` (do not hand-edit).
- **Legacy** `../chapter-*.json` files were archived under `../_archive/` after merge; do not revive them as a second bib store.
- **Chapter shelf meta:** `../sources-index.json` (generated from extended).

## Authority source of truth

1. **Book index (primary):** `book-index.bits.xml` — BITS export from Indexia (back-of-book index).
2. **Corpus extensions:** high-frequency labels that appear in chapter JSON but not in the index (e.g. Wuhan, China, United States), marked `"source": "corpus-extension"`.

## Files

| File | Role |
|---|---|
| `authorities.json` | Master file (all types + meta) |
| `persons.json` / `orgs.json` / `places.json` / `topics.json` / `events.json` / `works.json` | Per-type splits |
| `alias-map.json` | Lowercased alias → authority id |
| `reconciliation-report.json` | Last match stats + unmatched strings |
| `book-index.bits.xml` | Raw Indexia BITS export |

## Record shape

```json
{
  "id": "person:shi-zhengli",
  "prefLabel": "Shi Zhengli",
  "indexTerm": "Shi Zhengli",
  "altLabels": ["China's Bat Woman", "Zhengli Shi"],
  "related": [{"label": "…", "id": "…"}],
  "subentries": ["…"],
  "pages": ["12", "45–46"],
  "source": "book-index"
}
```

- `prefLabel` — display form used in the corpus and future UI  
- `indexTerm` — heading as printed in the book index (often inverted for persons)  
- `altLabels` — *see* redirects + curated aliases  

## Corpus linkage

Each extended chapter source may include:

- `topic_ids` — authority ids resolved from `topics`
- `author_ids` — ordered person/org authority ids resolved from the bibliographic `author` string
- `publication_ids` — ordered org authority ids resolved from the bibliographic `publication` string
- `entity_ids` — `{ people, orgs, places }` ids resolved from `entities` (authors/publications are merged in)

**Controlled terms:** `topic_ids` / `entity_ids` (and author/publication ids) are authoritative.
Display strings in `topics` / `entities` are derived from authority `prefLabel` via
`_sync_labels_from_authorities.py` (orphan unmatched strings may remain until linked).
The `author` / `publication` fields stay as printed citation text; identity lives in `*_ids` / authorities.

Link or refresh bibliographic ids after bibliography edits:

```bash
python3 origins/sources/data/_link_authors.py
python3 origins/sources/data/_link_publications.py
python3 origins/sources/data/_sync_labels_from_authorities.py
python3 origins/sources/data/_verify_authority_links.py
python3 origins/sources/data/_build_corpus_index.py
python3 origins/sources/data/_build_authority_search_index.py
```

## Site catalog

The Sources page is a search-led catalog:

- MiniSearch over `../authority-search-index.json`
- Enriched cards from `../corpus-index.json` (public fields only; no artifacts)
- Example-search prompts + Chapters shelf + paginated results

Rebuild after authority or extended-chapter changes:

```bash
python3 origins/sources/data/_normalize_catalog.py
python3 origins/sources/data/_enrich_image_urls.py
python3 origins/sources/data/_sync_labels_from_authorities.py
python3 origins/sources/data/_verify_authority_links.py
python3 origins/sources/data/_build_corpus_index.py
python3 origins/sources/data/_verify_corpus_index.py
python3 origins/sources/data/_build_authority_search_index.py
```

`corpus-index.json` is generated-only (`input_sha256` + `corpus-index.sha256`). Do not hand-edit it.

Preview images are publisher hotlinks (`image_url` / `og:image`), shown only when available.

Extended chapter records may also include `acquisition_note` (scrape/paywall/retail metadata). That field stays local to extended JSON and is not published in `corpus-index.json`; visitor-facing `summary` should remain clean.

## Site search

The Sources page uses MiniSearch over `../authority-search-index.json` (keyword → tagged sources).

Rebuild after authority or extended-chapter changes:

```bash
python3 origins/sources/data/_build_authority_search_index.py
```
