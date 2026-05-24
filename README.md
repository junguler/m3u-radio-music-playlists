# m3u radio music playlists — cleaned, verified & organized

Internet-radio stream playlists, **deduplicated, dead-link-checked, and faceted**
by category, country, and language. Built from a fork of
[junguler/m3u-radio-music-playlists](https://github.com/junguler/m3u-radio-music-playlists):
every source playlist was ingested, duplicate/junk streams removed, every stream
probed for reachability, and **only the verified-live stations kept**.

Open any `.m3u` in VLC, mpv, Winamp, or any player that reads playlists.

## Structure

```
by-category/      one .m3u per genre   (pop, rock, jazz, gospel, dance, 80s, …)
by-country/       one .m3u per country (Germany, USA, Brazil, Egypt, …)
by-language/      one .m3u per language (Arabic, German, Spanish, Russian, …)
unclassified.m3u  live stations with no detectable facet
---everything.m3u.gz   all live stations in one gzipped playlist
REPORT.md         full pipeline stats
tools/clean/      the regeneration pipeline (Python via uv)
```

A station can appear in several files at once — e.g. an Egyptian Arabic pop
station shows up under `by-country/Egypt.m3u`, `by-language/Arabic.m3u`, and
`by-category/pop.m3u`.

## What's inside

| | |
|---|---|
| Source entries ingested | 8,372,691 |
| Unique after dedupe (normalized URL) | 1,441,165 |
| Reachable streams probed | 1,441,165 (100%) |
| **Live stations kept** | **212,319** (14.7% — the rest were dead and dropped) |
| └ by category / country / language | 90,088 / 78,490 / 83,259 entries |

See **[REPORT.md](REPORT.md)** for the full breakdown.

## Regenerating

Everything is reproducible from `tools/clean/` (no system Python needed — uses
[`uv`](https://docs.astral.sh/uv/)-managed CPython):

```sh
uv run tools/clean/01_ingest.py             # parse all source .m3u -> SQLite index
uv run tools/clean/02_dedupe.py             # normalize URLs + dedupe
uv run tools/clean/03_classify.py           # category / country / language
uv run --python 3.14t tools/clean/04_check_dead.py --scope all   # dead-link check (free-threaded)
uv run tools/clean/05_emit.py --alive       # write the verified-live faceted tree
uv run tools/clean/06_report.py             # refresh REPORT.md
```

`05_emit.py` (no flag) writes the full unfiltered set instead; `--alive` writes
the verified-live tree shipped here. The multi-GB SQLite index
(`tools/clean/.cache/`) is gitignored.

## Credits

Source data and the original scraping effort:
[junguler/m3u-radio-music-playlists](https://github.com/junguler/m3u-radio-music-playlists).
