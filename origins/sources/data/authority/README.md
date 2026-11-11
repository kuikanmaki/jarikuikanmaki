# Authority files

Canonical names for people, organizations, places, topics, events, and works in the Origins extended corpus.

## Source of truth

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
- `entity_ids` — `{ people, orgs, places }` ids resolved from `entities`

Display strings in `topics` / `entities` are normalized to `prefLabel` when matched.

## Site search

The Sources page uses MiniSearch over `../authority-search-index.json` (keyword → tagged sources).

Rebuild after authority or extended-chapter changes:

```bash
python3 origins/sources/data/_build_authority_search_index.py
```
