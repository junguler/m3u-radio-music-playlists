# /// script
# requires-python = ">=3.12"
# dependencies = []
# ///
"""
Stage 6 - Write organized/REPORT.md summarizing the whole clean/organize run.
Re-runnable; picks up dead-link stats from `liveness` if present.
"""
import os
import sqlite3

HERE = os.path.dirname(__file__)
DB = os.path.join(HERE, ".cache", "stations.db")
REPO = os.path.abspath(os.path.join(HERE, "..", ".."))
OUT = os.path.join(REPO, "REPORT.md")


def main():
    con = sqlite3.connect(DB)
    meta = dict(con.execute("SELECT k,v FROM meta").fetchall())

    def c(q):
        return con.execute(q).fetchone()[0]

    ingest_rows = int(meta.get("ingest_rows", 0))
    ingest_files = int(meta.get("ingest_files", 0))
    junk = int(meta.get("dedup_junk", 0))
    uniq = c("SELECT COUNT(*) FROM stations_dedup")
    L = []
    w = L.append
    w("# Clean & organize report\n")
    w("Pipeline: `tools/clean/` (Python via `uv`). Source playlists were ingested "
      "into a SQLite index, then the old repo content was replaced by the faceted "
      "tree at the repo root (full set) plus `alive-only/` (verified-reachable).\n")

    w("## 1. Ingest")
    w(f"- Parsed **{ingest_rows:,}** entries from **{ingest_files:,}** leaf `.m3u` "
      "files (excluding `---everything-*`, `+checked+/`, `+merged+/`, `keep_one/`).\n")

    w("## 2. Dedupe (normalized URL)")
    w(f"- Dropped **{junk:,}** junk / non-http(s) / placeholder-host rows.")
    w(f"- Collapsed to **{uniq:,}** unique stations by normalized URL "
      "(scheme-agnostic, default ports + trailing `/`,`;` stripped, volatile "
      "query params removed).")
    dupes = ingest_rows - junk - uniq
    if dupes > 0:
        w(f"- Removed **{dupes:,}** duplicate entries "
          f"({100*dupes/max(ingest_rows-junk,1):.1f}% of http rows).")
    w(f"- {c('SELECT COUNT(*) FROM stations_dedup WHERE in_checked=1'):,} carry an "
      "upstream alive-prior flag (seen in a source `checked/` folder).\n")

    w("## 3. Classification coverage")
    w("| facet | classified | % |")
    w("|---|---:|---:|")
    for col in ("category", "country", "language"):
        n = c(f"SELECT COUNT(*) FROM facets WHERE {col} IS NOT NULL")
        w(f"| {col} | {n:,} | {100*n/uniq:.1f}% |")
    none = c("SELECT COUNT(*) FROM facets WHERE category IS NULL AND "
             "country IS NULL AND language IS NULL")
    w(f"\n- **{none:,}** ({100*none/uniq:.1f}%) had no detectable facet "
      "(generic names from alphabetical sources) → `organized/unclassified.m3u`.")
    w("- Signals, by priority: filename token (gazetteer match via `pycountry` + "
      "curated genre list) › host ccTLD (vanity TLDs blacklisted) › name script "
      "detection › country→language fallback.\n")

    w("## 4. Dead-link check")
    has = con.execute("SELECT name FROM sqlite_master WHERE type='table' "
                      "AND name='liveness'").fetchone()
    if has:
        checked = c("SELECT COUNT(*) FROM liveness")
        alive = c("SELECT COUNT(*) FROM liveness WHERE status='alive'")
        dead = c("SELECT COUNT(*) FROM liveness WHERE status='dead'")
        pct = 100 * checked / uniq if uniq else 0
        w(f"- Checked **{checked:,} / {uniq:,}** ({pct:.1f}%).")
        if checked:
            w(f"- **{alive:,}** alive ({100*alive/checked:.1f}%), "
              f"**{dead:,}** dead ({100*dead/checked:.1f}%).")
        if checked < uniq:
            w("- _In progress / resumable._ Run "
              "`uv run tools/clean/04_check_dead.py --scope all` to continue, then "
              "`uv run tools/clean/05_emit.py --alive` for the verified tree.")
        else:
            w("- Complete. `alive-only/` holds the verified-reachable tree:")
            for col, sub in (("category", "by-category"), ("country", "by-country"),
                             ("language", "by-language")):
                n = c(f"SELECT COUNT(*) FROM facets f JOIN liveness l USING(url_norm) "
                      f"WHERE l.status='alive' AND f.{col} IS NOT NULL")
                w(f"  - `alive-only/{sub}/` — {n:,} live entries")
            w(f"  - `alive-only/---everything.m3u.gz` — {alive:,} live stations")
    else:
        w("- Not yet run. `uv run tools/clean/04_check_dead.py --scope all`, then "
          "`uv run tools/clean/05_emit.py --alive`.")
    w("")

    w("## 5. Shipped repository (root = verified-alive only)")
    w("The full dead-heavy set was dropped; the repo root holds only the "
      "212k verified-reachable stations. Regenerate the full set anytime with "
      "`05_emit.py` (writes to root) — the alive tree comes from `--alive`.\n")
    alive_join = ("FROM facets f JOIN liveness l USING(url_norm) "
                  "WHERE l.status='alive'")
    for col, sub in (("category", "by-category"), ("country", "by-country"),
                     ("language", "by-language")):
        nfiles = len(set(con.execute(
            f"SELECT f.{col} {alive_join} AND f.{col} IS NOT NULL")))
        nrows = c(f"SELECT COUNT(*) {alive_join} AND f.{col} IS NOT NULL")
        w(f"- `{sub}/` — {nfiles} files, {nrows:,} entries")
    aun = c("SELECT COUNT(*) FROM stations_dedup s JOIN liveness l USING(url_norm) "
            "JOIN facets f USING(url_norm) WHERE l.status='alive' AND "
            "f.category IS NULL AND f.country IS NULL AND f.language IS NULL")
    aliven = c("SELECT COUNT(*) FROM liveness WHERE status='alive'")
    w(f"- `unclassified.m3u` — {aun:,}")
    w(f"- `---everything.m3u.gz` — {aliven:,} (all live stations, gzipped)")
    w("- `README.md` — repo overview & per-facet index")

    with open(OUT, "w", encoding="utf-8") as fh:
        fh.write("\n".join(L) + "\n")
    con.close()
    print("wrote", OUT)


if __name__ == "__main__":
    main()
