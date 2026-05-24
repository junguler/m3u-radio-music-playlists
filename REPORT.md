# Clean & organize report

Pipeline: `tools/clean/` (Python via `uv`). Source playlists were ingested into a SQLite index, then the old repo content was replaced by the faceted tree at the repo root (full set) plus `alive-only/` (verified-reachable).

## 1. Ingest
- Parsed **8,372,691** entries from **99,645** leaf `.m3u` files (excluding `---everything-*`, `+checked+/`, `+merged+/`, `keep_one/`).

## 2. Dedupe (normalized URL)
- Dropped **89,184** junk / non-http(s) / placeholder-host rows.
- Collapsed to **1,441,165** unique stations by normalized URL (scheme-agnostic, default ports + trailing `/`,`;` stripped, volatile query params removed).
- Removed **6,842,342** duplicate entries (82.6% of http rows).
- 517,793 carry an upstream alive-prior flag (seen in a source `checked/` folder).

## 3. Classification coverage
| facet | classified | % |
|---|---:|---:|
| category | 561,401 | 39.0% |
| country | 587,332 | 40.8% |
| language | 552,306 | 38.3% |

- **333,981** (23.2%) had no detectable facet (generic names from alphabetical sources) → `organized/unclassified.m3u`.
- Signals, by priority: filename token (gazetteer match via `pycountry` + curated genre list) › host ccTLD (vanity TLDs blacklisted) › name script detection › country→language fallback.

## 4. Dead-link check
- Checked **1,441,165 / 1,441,165** (100.0%).
- **212,319** alive (14.7%), **1,228,846** dead (85.3%).
- Complete. `alive-only/` holds the verified-reachable tree:
  - `alive-only/by-category/` — 90,088 live entries
  - `alive-only/by-country/` — 78,490 live entries
  - `alive-only/by-language/` — 83,259 live entries
  - `alive-only/---everything.m3u.gz` — 212,319 live stations

## 5. Shipped repository (root = verified-alive only)
The full dead-heavy set was dropped; the repo root holds only the 212k verified-reachable stations. Regenerate the full set anytime with `05_emit.py` (writes to root) — the alive tree comes from `--alive`.

- `by-category/` — 95 files, 90,088 entries
- `by-country/` — 206 files, 78,490 entries
- `by-language/` — 112 files, 83,259 entries
- `unclassified.m3u` — 52,676
- `---everything.m3u.gz` — 212,319 (all live stations, gzipped)
- `README.md` — repo overview & per-facet index
