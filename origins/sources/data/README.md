# Origins Sources corpus — data guide

This directory is the **research bibliography and catalog** for *Origins of Coronavirus*: chapter-linked sources, controlled authorities, captured text artifacts, and the generated indexes that power the public Sources page.

The guide is written for two readers:

- **Catalog editors / library scientists** — how to add or revise bibliographic records safely.
- **Developers** — how layers relate, what is generated, and which scripts to run.

Related detail docs:

- [`authority/README.md`](authority/README.md) — controlled vocabulary files and Indexia BITS import
- [`extended/README.md`](extended/README.md) — short map of the extended tree

---

## 1. Conceptual model

The corpus follows a common digital-library split:

| Layer | Role | Analogy |
|---|---|---|
| **Bibliographic records** | One description per cited source | Catalog record / MARC-ish description |
| **Authorities** | Controlled names for people, orgs, places, topics, … | Name authority file / thesaurus |
| **Digital objects** | Captured page/PDF text under `extended/artifacts/` | Holding / digital surrogate |
| **Acquisition metadata** | `status`, `artifact`, `acquisition_note` | Access / copy status |
| **Derived public views** | `corpus-index.json`, `authority-search-index.json` | OPAC / discovery layer |

**Stable identifier:** `source_key` (e.g. `ch00-s01`) — chapter number + source id within that chapter. Use this in scripts, reports, and discussions.

---

## 2. Source of truth (do not invent a second catalog)

| What | Where | Editable by hand? |
|---|---|---|
| Bibliography + acquisition | `extended/chapter-00.json` … `chapter-19.json` | **Yes** — sole catalog |
| Controlled terms | `authority/*.json` (+ BITS XML) | **Yes** (prefer via Indexia/linkers) |
| Captured text/PDF extracts | `extended/artifacts/` | Local files; **gitignored** |
| Public browse cards | `corpus-index.json` | **No** — regenerate |
| Keyword search index | `authority-search-index.json` | **No** — regenerate |
| Chapter shelf list | `sources-index.json` | Prefer regenerate from extended |
| Scrape cache / logs | `extended/url-cache.json`, `extended/logs/` | Local only (gitignored); pipeline, not the catalog |
| Pre-cleanup legacy copies | `_archive/YYYY-MM-DD/` | Local only (gitignored); read-only safety copies |

Legacy top-level `data/chapter-*.json` files were removed from the live tree (archived 2026-11-12). Do not recreate them as a parallel bib store.

---

## 3. Directory map

```
origins/sources/data/
├── README.md                          ← this guide
├── extended/                          ← CATALOG OF RECORD
│   ├── chapter-NN.json                ← bibliographic + acquisition records
│   ├── artifacts/                     ← local surrogates (*.md, PDFs); not published
│   ├── logs/                          ← scrape journals
│   ├── url-cache.json                 ← scrape accelerator (rebuilt from chapters)
│   ├── image-url-cache.json           ← og:image enrichment cache
│   └── README.md
├── authority/                         ← controlled vocabulary
├── notes/                             ← chapter endnotes HTML for the UI
├── corpus-index.json                  ← GENERATED public catalog
├── corpus-index.sha256                ← fingerprint of inputs used for last build
├── authority-search-index.json        ← GENERATED MiniSearch keyword index
├── sources-index.json                 ← chapter shelf metadata (from extended)
├── _archive/                          ← dated snapshots / retired legacy files
└── _*.py                              ← build, link, verify tooling
```

Public UI (`origins/sources/index.html` + `corpus-catalog.js`) loads:

1. `corpus-index.json` — cards, filters, chapter browse  
2. `authority-search-index.json` — predictive keyword search  
3. `sources-index.json` — chapter shelf labels  
4. `notes/NN.html` — chapter notes panel  

It does **not** load per-chapter JSON or artifacts in the browser.

---

## 4. Chapter file schema

Each `extended/chapter-NN.json`:

```json
{
  "chapter": 0,
  "chapter_title": "Prologue: Night Train to Wuhan",
  "printed_pages": { "start": 1, "end": 13 },
  "sources": [ /* source records */ ]
}
```

| Field | Type | Notes |
|---|---|---|
| `chapter` | integer | `0` = Prologue; `1`–`19` = chapters |
| `chapter_title` | string | Full chapter title as in the book |
| `printed_pages` | object | Print-edition page span for the chapter |
| `sources` | array | Ordered bibliographic records for that chapter |

---

## 5. Source record data dictionary

Fields fall into four groups.

### 5.1 Citation (transcribed bibliography)

Keep these as **printed/cited** text. Do not replace `author` with an authority prefLabel.

| Field | Required | Description |
|---|---|---|
| `id` | yes | Integer id **within the chapter** (not globally unique alone) |
| `source_key` | yes | Global id: `ch{chapter:02d}-s{id:02d}` |
| `type` | yes | Human citation genre (e.g. Article, Book, Twitter post, Report) |
| `author` | yes* | Citation author string (*empty allowed when truly unknown) |
| `title` | yes | Title or quoted snippet for social posts |
| `publication` | | Journal, publisher, site, or venue |
| `date` | | Display date as cited |
| `date_iso` | | Sortable ISO date (`YYYY-MM-DD` or `YYYY`) when known |
| `url` | | Canonical or best available access URL (may be Wayback) |

### 5.2 Access / acquisition

| Field | Description |
|---|---|
| `status` | Catalog access state — see §6 |
| `artifact` | Relative path under `extended/`, e.g. `artifacts/ch00-s01.md`, or `null` |
| `content_kind` | Machine-oriented format/role — see §7 |
| `language` | ISO-ish code (`en`, `zh`, `fi`, …) |
| `acquisition_note` | Internal note (paywall, Wayback replacement, Amazon landing, embed policy). **Not** copied into `corpus-index.json` |
| `image_url` | Optional publisher preview image (hotlink) |

### 5.3 Descriptive / narrative

| Field | Description |
|---|---|
| `summary` | Neutral descriptive abstract for the catalog card |
| `book_role` | How the source functions in the book’s argument (may be empty) |

Keep `summary` visitor-safe. Put scrape/paywall mechanics in `acquisition_note`, not in `summary`.

### 5.4 Subject analysis & authorities

| Field | Role |
|---|---|
| `topics` | Display topic strings (derived from ids when linked) |
| `topic_ids` | **Authoritative** list of authority ids (any type used as subjects) |
| `entities` | `{ people, orgs, places }` display strings |
| `entity_ids` | `{ people, orgs, places }` **authoritative** id lists |
| `author_ids` | Authority ids parsed from `author` |
| `publication_ids` | Authority ids resolved from `publication` |

**Rule:** for controlled access points, **ids win**. After editing ids (or running linkers), run `_sync_labels_from_authorities.py` so display strings match `prefLabel`. Unlinked orphan strings may remain until an authority exists.

Authority id pattern: `person:…`, `org:…`, `place:…`, `topic:…`, `event:…`, `work:…`.

---

## 6. `status` values

| Value | Meaning | Typical next action |
|---|---|---|
| `ok` | Usable URL and/or surrogate; corpus treats as acquired | None |
| `paywall` | URL known; full text gated; partial artifact may exist | Leave, or improve partial capture |
| `empty_url` | No public URL in the bibliography | Supply URL, or leave (e.g. personal journal) |

Historical scrape statuses (`blocked`, `error`, `skipped`, `not_found`) were cleared or remapped during corpus recovery; do not reintroduce them without updating builders and UI.

---

## 7. `content_kind` values

Used for filtering/labels in the public catalog (`content_kind_label` is added at build time).

| Kind | Use for |
|---|---|
| `html_article` | Web articles, news, essays |
| `pdf` | PDF documents |
| `book` | Books (including Amazon product URLs) |
| `video` | YouTube / video pages (often embedded, not scraped) |
| `social_post` | X/Twitter (often embedded) |
| `gov_doc` | Government / official docs |
| `database_record` | NCBI and similar database records |
| `email` | Email messages / FOIA email PDFs as correspondence |
| `preprint` | Preprint servers |
| `presentation` | Talks / webinars |
| `personal_note` | Author journal / private note |
| `landing` | Generic web landing page (prefer more specific kinds) |
| `unknown` | Not yet classified |

`type` remains the **citation** genre; `content_kind` is the **format/access** facet. Example: `type: "Book"` + `content_kind: "book"` + Amazon `url`.

---

## 8. Workflows for catalog editors

### 8.1 Edit an existing source

1. Open `extended/chapter-NN.json`.
2. Find the object with the right `source_key` (or `id`).
3. Change citation / summary / `book_role` / `url` as needed.
4. If you change `author` or `publication`, re-run author/publication linkers (§10).
5. Rebuild public indexes (§10).
6. Hard-refresh the Sources page.

### 8.2 Add a new source to a chapter

1. Append a new object to that chapter’s `sources` array.
2. Set `id` to the next unused integer **in that chapter**.
3. Set `source_key` to `ch{NN}-s{id:02d}` (zero-padded id).
4. Fill citation fields, `type`, `content_kind`, `language`, `summary`.
5. Set `url` if public; else `status: "empty_url"` and `url: ""`.
6. If the page can be captured, add/scrape `artifacts/…` and set `artifact` + `status` (`ok` or `paywall`).
7. Add `topics` / `entities` as working strings; run linkers + label sync so `*_ids` populate.
8. Rebuild indexes (§10).

### 8.3 Change a URL (e.g. to Wayback)

1. Update `url` on the extended record (canonical access URL for the corpus).
2. Update or re-scrape the artifact if content changes.
3. Set `acquisition_note` explaining the replacement.
4. Rebuild indexes (and optionally refresh `url-cache` via reconcile/rebuild scripts).

### 8.4 What not to edit by hand

- `corpus-index.json`, `authority-search-index.json` (always regenerate)
- `url-cache.json` as if it were the catalog
- Archived files under `_archive/` (reference only)

---

## 9. Workflows for developers

### 9.1 Full catalog rebuild (after bib or authority edits)

```bash
cd origins/sources/data   # or prefix paths from repo root

python3 _link_authors.py
python3 _link_publications.py
python3 _sync_labels_from_authorities.py
python3 _verify_authority_links.py
python3 _normalize_catalog.py          # optional housekeeping
python3 _enrich_image_urls.py          # optional; needs network
python3 _build_corpus_index.py
python3 _verify_corpus_index.py
python3 _build_authority_search_index.py
```

From repo root, prefix with `origins/sources/data/`.

### 9.2 Tooling map

| Script | Purpose |
|---|---|
| `_link_authors.py` | Parse `author` → `author_ids` |
| `_link_publications.py` | Resolve `publication` → `publication_ids` |
| `_sync_labels_from_authorities.py` | Refresh `topics` / `entities` strings from ids |
| `_verify_authority_links.py` | Fail on unknown ids / label drift |
| `_build_corpus_index.py` | Build public `corpus-index.json` (+ sha256) |
| `_verify_corpus_index.py` | Confirm index matches a clean rebuild |
| `_build_authority_search_index.py` | Build MiniSearch keyword index |
| `_enrich_image_urls.py` | Fill `image_url` from og/Twitter cards |
| `_normalize_catalog.py` | Catalog normalization helpers |
| `_authority_lib.py` | Shared authority loaders |
| `extended/_scrape_chapter.py` | Firecrawl scrape into artifacts |
| `extended/_build_extended.py` | Older extended-build helper |

### 9.3 Generated index contract

`corpus-index.json` includes a subset of each source for the browser (no `acquisition_note`, no artifact bodies). It also adds:

- `chapter`, `chapter_title`
- `content_kind_label`
- `authority_ids` (flattened ids for search/filter)

Header fields `generated_at`, `input_sha256`, and `note` mark the file as generated. `corpus-index.sha256` stores the input fingerprint from the last successful build.

---

## 10. Authorities (summary)

Canonical names live under `authority/`. Primary seed is the book back-of-book index (`book-index.bits.xml` from Indexia); corpus extensions are marked `"source": "corpus-extension"`.

See [`authority/README.md`](authority/README.md) for record shape (`prefLabel`, `indexTerm`, `altLabels`, …).

---

## 11. Artifacts and rights

- Artifacts are **working surrogates** for research/editing (markdown extracts, PDFs).
- They are **not published** in git (see root `.gitignore`).
- Paywalled sources may have partial artifacts; keep `status: "paywall"` and explain in `acquisition_note`.
- Amazon book URLs are access links only — capture is a product landing page, not the book text; use `content_kind: "book"`.

---

## 12. Preservation / `_archive/`

Dated folders under `_archive/` hold:

- Retired legacy chapter JSON  
- Pre-reconcile url-cache and scrape logs  
- Label-sync snapshots and merge/reconcile reports  

Use them for audit and rollback research; they are not loaded by the site.

---

## 13. Quick integrity checklist

Before publishing a data change:

- [ ] Only extended chapters (and authorities) were hand-edited for bib truth  
- [ ] New sources have unique `source_key` / chapter `id`  
- [ ] `status` and `url` agree (`empty_url` ⇒ empty url)  
- [ ] Linkers + label sync + verify ran clean (or warnings understood)  
- [ ] `_build_corpus_index.py` + `_verify_corpus_index.py` + search index rebuild succeeded  
- [ ] Sources page: chapter shelf, search, and one expanded card look correct  

---

## 14. Counts (order of magnitude)

The live corpus is on the order of **~300 sources** across **20 chapter files** (prologue + 19). Rebuild scripts print exact `sourceCount` / status tallies when run.
