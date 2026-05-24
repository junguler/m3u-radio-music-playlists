# /// script
# requires-python = ">=3.12"
# dependencies = []
# ///
"""
Stage 1 - Ingest & parse every leaf .m3u into a SQLite index.

Walks the repo, parses each #EXTINF + URL pair into a structured row, and
stores it in tools/clean/.cache/stations.db (table: stations).

Non-destructive: only reads the .m3u files, only writes the cache DB.

Excluded from ingest (derived / aggregate, not source-of-truth):
  - any ---everything-*.m3u / ---randomized.m3u / ---sorted.m3u
  - anything under +checked+/, +merged+/, keep_one/  (top-level derived dirs)
  - .git/

URLs found under a source's own checked/ folder are still ingested but tagged
from_checked=1 so dedupe can use "was alive at upstream check" as a prior.
"""
import os
import re
import sqlite3
import sys
import time

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
DB = os.path.join(os.path.dirname(__file__), ".cache", "stations.db")

# Top-level directories that are derived outputs, not sources.
EXCLUDED_TOP_DIRS = {"+checked+", "+merged+", "keep_one", ".git", "tools", "stuff"}

# Derived aggregate filenames (appear at root and inside each source dir).
AGG_PREFIXES = ("---everything", "---randomized", "---sorted")

# key="value"  (value may contain commas, so capture by quotes)
ATTR_RE = re.compile(r'([\w-]+)="([^"]*)"')
# trailing "  - 128 kbit/s" bitrate hint on the title
BITRATE_RE = re.compile(r"-\s*(\d{1,4})\s*kbit/s\s*$", re.IGNORECASE)


def is_aggregate(name: str) -> bool:
    return any(name.startswith(p) for p in AGG_PREFIXES)


def iter_m3u_files(repo: str):
    for dirpath, dirnames, filenames in os.walk(repo):
        rel = os.path.relpath(dirpath, repo)
        top = rel.split(os.sep)[0] if rel != "." else "."
        if top in EXCLUDED_TOP_DIRS:
            dirnames[:] = []
            continue
        for fn in filenames:
            if not fn.endswith(".m3u"):
                continue
            if is_aggregate(fn):
                continue
            yield os.path.join(dirpath, fn)


def parse_title(after_colon: str):
    """Split the part after '#EXTINF:<dur>' into (attrs_dict, title)."""
    attrs = dict(ATTR_RE.findall(after_colon))
    # Title follows the last quote-comma if attributes exist, else first comma.
    if '",' in after_colon:
        title = after_colon.rsplit('",', 1)[1]
    elif "," in after_colon:
        title = after_colon.split(",", 1)[1]
    else:
        title = ""
    return attrs, title.strip().lstrip(",").strip()


def parse_m3u(path: str):
    """Yield (name, url, logo, group_title, bitrate) tuples for one file."""
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as fh:
            lines = fh.read().splitlines()
    except OSError:
        return

    pending = None  # (name, logo, group_title, bitrate)
    for line in lines:
        s = line.strip()
        if not s:
            continue
        if s.startswith("#EXTINF:"):
            body = s[len("#EXTINF:"):]
            # strip leading duration token (e.g. "-1 ")
            m = re.match(r"\s*-?\d+\s*", body)
            after = body[m.end():] if m else body
            attrs, title = parse_title(after)
            br = None
            bm = BITRATE_RE.search(title)
            if bm:
                br = int(bm.group(1))
            pending = (
                title,
                attrs.get("tvg-logo", ""),
                attrs.get("group-title", ""),
                br,
            )
        elif s.startswith("#"):
            continue  # #EXTM3U, #PLAYLIST, #EXTGRP, comments
        else:
            # a URL (or any non-comment payload line)
            name, logo, group_title, br = pending or ("", "", "", None)
            yield (name, s, logo, group_title, br)
            pending = None


def main():
    os.makedirs(os.path.dirname(DB), exist_ok=True)
    if os.path.exists(DB):
        os.remove(DB)
    con = sqlite3.connect(DB)
    con.executescript(
        """
        PRAGMA journal_mode=OFF;
        PRAGMA synchronous=OFF;
        CREATE TABLE stations(
            id           INTEGER PRIMARY KEY,
            name         TEXT,
            url          TEXT,
            logo         TEXT,
            group_title  TEXT,
            bitrate      INTEGER,
            source_file  TEXT,
            source_dir   TEXT,
            from_checked INTEGER DEFAULT 0
        );
        CREATE TABLE meta(k TEXT PRIMARY KEY, v TEXT);
        """
    )

    t0 = time.time()
    batch = []
    n_rows = n_files = 0
    INSERT = (
        "INSERT INTO stations"
        "(name,url,logo,group_title,bitrate,source_file,source_dir,from_checked)"
        " VALUES(?,?,?,?,?,?,?,?)"
    )
    for path in iter_m3u_files(REPO):
        n_files += 1
        rel = os.path.relpath(path, REPO).replace(os.sep, "/")
        parts = rel.split("/")
        source_dir = parts[0] if len(parts) > 1 else "(root)"
        from_checked = 1 if "checked" in parts[:-1] else 0
        for name, url, logo, gt, br in parse_m3u(path):
            batch.append((name, url, logo, gt, br, rel, source_dir, from_checked))
            if len(batch) >= 10000:
                con.executemany(INSERT, batch)
                n_rows += len(batch)
                batch.clear()
        if n_files % 5000 == 0:
            print(f"  ... {n_files} files, {n_rows + len(batch)} rows", flush=True)
    if batch:
        con.executemany(INSERT, batch)
        n_rows += len(batch)

    con.execute("CREATE INDEX idx_url ON stations(url)")
    con.execute("CREATE INDEX idx_srcdir ON stations(source_dir)")
    con.executemany(
        "INSERT INTO meta(k,v) VALUES(?,?)",
        [("ingest_files", str(n_files)), ("ingest_rows", str(n_rows)),
         ("ingest_secs", f"{time.time()-t0:.1f}")],
    )
    con.commit()

    distinct_urls = con.execute(
        "SELECT COUNT(DISTINCT url) FROM stations"
    ).fetchone()[0]
    from_checked = con.execute(
        "SELECT COUNT(*) FROM stations WHERE from_checked=1"
    ).fetchone()[0]
    con.close()

    print(f"\nIngested {n_rows} rows from {n_files} files in {time.time()-t0:.1f}s")
    print(f"  distinct exact URLs : {distinct_urls}")
    print(f"  from checked/ dirs  : {from_checked}")
    print(f"  db: {DB}")


if __name__ == "__main__":
    sys.exit(main())
