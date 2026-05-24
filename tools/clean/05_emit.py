# /// script
# requires-python = ">=3.12"
# dependencies = []
# ///
"""
Stage 5 - Emit the clean faceted tree from the deduped + classified index.

Writes (non-destructively, originals untouched):
  organized/by-category/<label>.m3u
  organized/by-country/<Country>.m3u
  organized/by-language/<Language>.m3u
  organized/unclassified.m3u          (no facet detected)
  organized/---everything.m3u         (all unique stations, one aggregate)
  organized/README.md                 (index + counts)

A station appears in each facet file it has a value for (so it can be in a
category, a country and a language file at once). Entries are emitted as clean
#EXTINF lines, sorted by name within each file.

Pass --alive to read alive/dead from table `liveness` (Stage 4) and write the
mirror tree under organized/alive-only/ keeping only verified-alive stations.
"""
import os
import re
import sqlite3
import sys
import unicodedata

HERE = os.path.dirname(__file__)
DB = os.path.join(HERE, ".cache", "stations.db")
REPO = os.path.abspath(os.path.join(HERE, "..", ".."))
# Faceted tree lives at the repo root; the verified mirror under alive-only/.
ALIVE = "--alive" in sys.argv
OUT = os.path.join(REPO, "alive-only") if ALIVE else REPO

FACETS = [("category", "by-category"), ("country", "by-country"),
          ("language", "by-language")]


def safe(v: str) -> str:
    s = unicodedata.normalize("NFKD", v).encode("ascii", "ignore").decode()
    s = re.sub(r"[^A-Za-z0-9]+", "_", s).strip("_")
    return s or "unknown"


def unique_names(values):
    """value -> unique safe filename within a facet dir."""
    out, seen = {}, {}
    for v in values:
        base = safe(v)
        if base in seen:
            seen[base] += 1
            base = f"{base}_{seen[base]}"
        else:
            seen[base] = 1
        out[v] = base
    return out


def extinf(name, url, logo, group):
    logo = logo or ""
    name = (name or "").replace("\n", " ").strip() or "Unknown Station"
    return f'#EXTINF:-1 tvg-logo="{logo}" group-title="{group}", {name}\n{url}\n'


def alive_clause(alias="s"):
    if not ALIVE:
        return ""
    return (f" AND {alias}.url_norm IN "
            "(SELECT url_norm FROM liveness WHERE status='alive')")


def main():
    if not os.path.exists(DB):
        sys.exit("run stages 1-3 first")
    con = sqlite3.connect(DB)
    if ALIVE and not con.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='liveness'"
    ).fetchone():
        sys.exit("--alive requested but no liveness table (run Stage 4 first)")

    os.makedirs(OUT, exist_ok=True)
    summary = {}

    for col, subdir in FACETS:
        d = os.path.join(OUT, subdir)
        os.makedirs(d, exist_ok=True)
        values = [r[0] for r in con.execute(
            f"SELECT DISTINCT {col} FROM facets f "
            f"JOIN stations_dedup s USING(url_norm) "
            f"WHERE {col} IS NOT NULL{alive_clause('s')}")]
        fnames = unique_names(sorted(values))
        rows = con.execute(
            f"SELECT f.{col}, s.name, s.url, s.logo FROM facets f "
            f"JOIN stations_dedup s USING(url_norm) "
            f"WHERE f.{col} IS NOT NULL{alive_clause('s')} "
            f"ORDER BY f.{col}, s.name")
        cur_val, fh, n_files, n_rows, per = None, None, 0, 0, {}
        for val, name, url, logo in rows:
            if val != cur_val:
                if fh:
                    fh.close()
                cur_val = val
                fh = open(os.path.join(d, fnames[val] + ".m3u"), "w",
                          encoding="utf-8")
                fh.write("#EXTM3U\n")
                n_files += 1
            fh.write(extinf(name, url, logo, val))
            n_rows += 1
            per[val] = per.get(val, 0) + 1
        if fh:
            fh.close()
        summary[col] = (n_files, n_rows, sorted(per.items(), key=lambda kv: -kv[1]))
        print(f"  {subdir}: {n_files} files, {n_rows} entries")

    # unclassified
    rows = con.execute(
        f"SELECT s.name, s.url, s.logo FROM stations_dedup s "
        f"JOIN facets f USING(url_norm) WHERE f.category IS NULL "
        f"AND f.country IS NULL AND f.language IS NULL{alive_clause('s')} "
        f"ORDER BY s.name")
    n = 0
    with open(os.path.join(OUT, "unclassified.m3u"), "w", encoding="utf-8") as fh:
        fh.write("#EXTM3U\n")
        for name, url, logo in rows:
            fh.write(extinf(name, url, logo, "unclassified"))
            n += 1
    summary["unclassified"] = n
    print(f"  unclassified.m3u: {n} entries")

    # everything
    rows = con.execute(
        f"SELECT s.name, s.url, s.logo FROM stations_dedup s "
        f"WHERE 1=1{alive_clause('s')} ORDER BY s.name")
    n = 0
    with open(os.path.join(OUT, "---everything.m3u"), "w", encoding="utf-8") as fh:
        fh.write("#EXTM3U\n")
        for name, url, logo in rows:
            fh.write(extinf(name, url, logo, "all"))
            n += 1
    summary["everything"] = n
    print(f"  ---everything.m3u: {n} entries")

    write_readme(OUT, summary)
    con.close()
    print(f"\nemitted to {OUT}")


def write_readme(out, summary):
    lines = ["# Organized radio playlists\n",
             "Deduplicated (normalized-URL) and classified by category / country / "
             "language. A station may appear under all three facets.\n",
             f"- **Total unique stations:** {summary['everything']}",
             f"- **Unclassified (no facet):** {summary['unclassified']}\n"]
    for col, subdir in FACETS:
        nf, nr, per = summary[col]
        lines.append(f"\n## {subdir}/  — {nf} files, {nr} entries\n")
        lines.append("| value | stations |")
        lines.append("|---|---:|")
        for v, c in per[:40]:
            lines.append(f"| {v} | {c} |")
        if len(per) > 40:
            lines.append(f"| _(+{len(per)-40} more)_ | |")
    with open(os.path.join(out, "README.md"), "w", encoding="utf-8") as fh:
        fh.write("\n".join(lines) + "\n")


if __name__ == "__main__":
    main()
