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

---

## 15. Optional future migration: static JSON → database

The live site does **not** use a SQL (or other) database. Storage is flat JSON; discovery is client-side over generated indexes. That is intentional for current scope (§1–2).

This section is a **migration runbook** for a future implementer (human or coding agent) if relational querying, multi-writer editing, or server-side search becomes a product requirement. Do not migrate “just in case.”

### 15.1 Migration triggers (when it becomes rational)

Migrate only if one or more hold:

- Interactive multi-hop queries (source ↔ authority ↔ chapter networks) are used routinely, not as one-off scripts.
- Multiple editors need concurrent writes with constraints (no dangling authority ids).
- Full-text over artifacts must join back to catalog facets at query time.
- A server API must replace static `corpus-index.json` / MiniSearch downloads.

Until then, prefer: keep git + extended JSON as system of record; optionally load a **read-only SQLite replica** for ad-hoc SQL without changing the public site.

### 15.2 Design goals for any migration

1. **Preserve identifiers:** `source_key` and authority `id` (`person:…`, `org:…`, …) remain primary keys / natural keys.
2. **Single write path during cutover:** either JSON remains authoritative until flip, or DB becomes authoritative—never both writable.
3. **Generated views stay derived:** public browse/search payloads remain projections (SQL views, API serializers, or still-built JSON).
4. **Idempotent ETL:** re-running import from `extended/` + `authority/` must upsert cleanly.
5. **Parity checks:** row counts and spot checksums must match JSON before switching the UI.

### 15.3 Recommended target schema (logical)

Engine-agnostic. SQLite is enough for a first backend; Postgres if you need concurrent writers or hosted API.

| Table | PK / keys | Source |
|---|---|---|
| `chapters` | `number` (int) | `extended/chapter-*.json` header (`chapter`, `chapter_title`, `printed_pages`) |
| `sources` | `source_key` (text); unique `(chapter_number, id)` | each object in `sources[]` |
| `authorities` | `id` (text) | `authority/persons.json` etc. (`prefLabel`, `indexTerm`, `altLabels`, `source`, …) |
| `source_authors` | `(source_key, position)` → `authority_id` | `author_ids[]` (preserve order) |
| `source_publications` | `(source_key, position)` → `authority_id` | `publication_ids[]` |
| `source_topics` | `(source_key, position)` → `authority_id` | `topic_ids[]` |
| `source_entities` | `(source_key, role, position)` → `authority_id` | `entity_ids.{people,orgs,places}` with `role ∈ {people,orgs,places}` |

**`sources` columns (map 1:1 from JSON):**  
`chapter_number`, `id`, `type`, `author`, `title`, `publication`, `date`, `date_iso`, `url`, `status`, `content_kind`, `language`, `summary`, `book_role`, `artifact`, `acquisition_note`, `image_url`.

**Do not normalize away** transcribed `author` / `publication` strings—they are citation text, not authority labels (§5.1).

**Optional later tables (only if needed):**

- `artifacts` — filesystem path or object-store URI + checksum; bodies stay off-git as today  
- `source_relations` — cites / replies / same-work manifestations (not modeled in JSON yet)  
- `alias` — from `authority/alias-map.json`

**Enums:** constrain `status` and `content_kind` to the vocabularies in §6–7 (DB check constraints or lookup tables).

### 15.4 What stays out of the DB (or stays non-authoritative)

| Asset | Guidance |
|---|---|
| `corpus-index.json` / `authority-search-index.json` | Replace with API/views **or** keep generating from DB for static hosting |
| `url-cache.json`, `extended/logs/`, `_archive/` | Operational; do not treat as catalog tables |
| Artifact file bytes | Object storage or local disk; store pointers in DB only |
| MiniSearch index | Regenerate from DB or switch to server search (Postgres FTS, Meilisearch, etc.) |

### 15.5 ETL phases (implement in order)

**Phase 0 — Freeze & snapshot**

1. Tag git commit of the corpus to migrate.  
2. Run `_verify_authority_links.py` and `_verify_corpus_index.py`; fix errors first.  
3. Record counts: chapters, sources, authorities, link-array lengths.

**Phase 1 — Schema + empty DB**

1. Create tables/constraints from §15.3.  
2. Add migration version table (`schema_migrations`).

**Phase 2 — Load authorities**

1. Upsert all records from `authority/{persons,orgs,places,topics,events,works}.json`.  
2. Load `alias-map.json` if using an `alias` table.  
3. Verify: `COUNT(*)` per type matches JSON `items` length.

**Phase 3 — Load chapters & sources**

1. For each `extended/chapter-NN.json`, upsert `chapters`, then each source into `sources`.  
2. Prefer `source_key` as upsert key.  
3. Verify: source count = sum of `sources` arrays; every `source_key` unique.

**Phase 4 — Load link tables**

1. Expand `author_ids`, `publication_ids`, `topic_ids`, `entity_ids` into junction rows (preserve array order via `position`).  
2. Fail (or quarantine) rows whose `authority_id` is missing—do not silently drop without a report.  
3. Verify: for each source, junction counts equal JSON array lengths (orphans only if JSON had unknown ids).

**Phase 5 — Dual-run parity**

1. Rebuild a catalog projection from SQL equivalent to today’s `corpus-index` public fields.  
2. Diff against current `corpus-index.json` (ignore `generated_at` / hashes).  
3. Spot-check: one source per `status`, one Amazon `book`, one embed (`video`/`social_post`), one `empty_url`.

**Phase 6 — Cutover (choose one)**

| Strategy | Write path | Public read path |
|---|---|---|
| **A. DB behind API** | Editors/API → DB | Site fetches API instead of static JSON |
| **B. DB → still static** | Editors → DB; CI exports `extended/` or only indexes | Unchanged static hosting |
| **C. SQLite sidecar** | JSON remains write path | Optional local SQL for research tools only |

Recommended first cutover: **C** or **B**. Flip the browser to **A** only after parity is proven.

**Phase 7 — Decommission**

1. Stop hand-editing `extended/` if DB is authoritative (or stop writing DB if JSON remains authoritative).  
2. Document the new source of truth in §2 of this README.  
3. Keep a dated JSON export under `_archive/` (local) for rollback.

### 15.6 Reference SQL sketch (illustrative)

```sql
-- sources (subset)
CREATE TABLE sources (
  source_key     TEXT PRIMARY KEY,
  chapter_number INTEGER NOT NULL REFERENCES chapters(number),
  id             INTEGER NOT NULL,
  type           TEXT,
  author         TEXT,
  title          TEXT NOT NULL,
  publication    TEXT,
  date           TEXT,
  date_iso       TEXT,
  url            TEXT,
  status         TEXT NOT NULL CHECK (status IN ('ok','paywall','empty_url')),
  content_kind   TEXT NOT NULL,
  language       TEXT,
  summary        TEXT,
  book_role      TEXT,
  artifact       TEXT,
  acquisition_note TEXT,
  image_url      TEXT,
  UNIQUE (chapter_number, id)
);

CREATE TABLE source_topics (
  source_key   TEXT NOT NULL REFERENCES sources(source_key),
  position     INTEGER NOT NULL,
  authority_id TEXT NOT NULL REFERENCES authorities(id),
  PRIMARY KEY (source_key, position)
);
```

Implementers should expand remaining junction tables the same way.

### 15.7 Example queries the DB should unlock

These are the relational workloads that justify the move (implement as views or saved queries):

- Sources linked to authority X **and** Y.  
- Authorities co-occurring in the same source, ranked by frequency.  
- Orphan authorities (no junction rows).  
- Sources with `status = 'paywall'` in a chapter range, grouped by `content_kind`.  
- People in `entity_ids.people` who never appear in `author_ids`.

### 15.8 Acceptance criteria

Migration is done when:

- [ ] All §15.3 core tables load from current JSON without manual row edits  
- [ ] Parity diff vs `corpus-index.json` public fields is empty (timestamps aside)  
- [ ] FK constraints reject dangling authority ids  
- [ ] One documented write path; README §2 updated  
- [ ] Rollback export exists; site can revert to static JSON within one deploy  

### 15.9 Non-goals

- Rewriting citation strings into authority prefLabels  
- Publishing artifact full text into a public DB by default  
- Replacing git history as the audit log for editorial changes (keep commits or DB audit tables explicitly)
