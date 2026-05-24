# /// script
# requires-python = ">=3.12"
# dependencies = []
# ///
"""
Stage 2 - Normalize URLs & dedupe on a normalized-URL key.

Adds stations.url_norm, then builds stations_dedup with one representative row
per url_norm (the richest one), plus aggregate signals (n_dupes, in_checked).

Normalization (scheme-agnostic so http/https collapse):
  - require http(s); drop anything else and bad/placeholder hosts (-> NULL key)
  - lowercase host, drop default ports (80/443), strip trailing '/' and ';'
  - drop wildcard ('*') and volatile query params (lang, cb, _, nocache, ts, t)
  - sort remaining query params for stability
"""
import os
import sqlite3
import time
from urllib.parse import urlsplit, parse_qsl

DB = os.path.join(os.path.dirname(__file__), ".cache", "stations.db")

BAD_HOSTS = {
    "localhost", "127.0.0.1", "0.0.0.0", "::1", "example.com", "example.org",
    "test.com", "0", "1", "stream", "localhost.localdomain",
}
VOLATILE_PARAMS = {"lang", "cb", "_", "nocache", "ts", "t", "cachebuster"}


def normkey(url):
    if not url:
        return None
    s = url.strip()
    low = s.lower()
    if not (low.startswith("http://") or low.startswith("https://")):
        return None
    try:
        p = urlsplit(s)
        host = (p.hostname or "").lower()
        if not host or host in BAD_HOSTS:
            return None
        try:
            port = p.port  # raises ValueError on malformed port
        except ValueError:
            port = None
        portstr = "" if port in (80, 443, None) else f":{port}"
        path = p.path.rstrip("/").rstrip(";").rstrip("/")
        q = []
        for k, v in parse_qsl(p.query, keep_blank_values=False):
            if v == "*" or k.lower() in VOLATILE_PARAMS:
                continue
            q.append((k.lower(), v))
        q.sort()
        query = "&".join(f"{k}={v}" for k, v in q)
        key = f"{host}{portstr}{path}"
        if query:
            key += f"?{query}"
        return key
    except (ValueError, UnicodeError):
        return None


def main():
    con = sqlite3.connect(DB)
    con.create_function("normkey", 1, normkey, deterministic=True)
    t0 = time.time()

    print("computing url_norm ...", flush=True)
    cols = [r[1] for r in con.execute("PRAGMA table_info(stations)")]
    if "url_norm" not in cols:
        con.execute("ALTER TABLE stations ADD COLUMN url_norm TEXT")
    con.execute("UPDATE stations SET url_norm = normkey(url)")
    con.execute("CREATE INDEX IF NOT EXISTS idx_urlnorm ON stations(url_norm)")
    con.commit()

    total = con.execute("SELECT COUNT(*) FROM stations").fetchone()[0]
    junk = con.execute(
        "SELECT COUNT(*) FROM stations WHERE url_norm IS NULL"
    ).fetchone()[0]
    print(f"  normalized in {time.time()-t0:.1f}s "
          f"({junk} junk/non-http rows dropped from {total})", flush=True)

    print("building stations_dedup (representative per url_norm) ...", flush=True)
    con.execute("DROP TABLE IF EXISTS stations_dedup")
    con.execute(
        """
        CREATE TABLE stations_dedup AS
        SELECT name, url, url_norm, logo, group_title, bitrate,
               source_file, source_dir, n_dupes, in_checked
        FROM (
            SELECT *,
                COUNT(*)        OVER (PARTITION BY url_norm) AS n_dupes,
                MAX(from_checked) OVER (PARTITION BY url_norm) AS in_checked,
                ROW_NUMBER()    OVER (
                    PARTITION BY url_norm
                    ORDER BY (logo <> '') DESC,
                             (group_title <> '') DESC,
                             (bitrate IS NOT NULL) DESC,
                             from_checked DESC,
                             (url LIKE 'https%') DESC,
                             (name <> '') DESC,
                             length(source_file) ASC
                ) AS rn
            FROM stations
            WHERE url_norm IS NOT NULL
        )
        WHERE rn = 1
        """
    )
    con.execute("CREATE UNIQUE INDEX idx_dedup_norm ON stations_dedup(url_norm)")
    con.commit()

    uniq = con.execute("SELECT COUNT(*) FROM stations_dedup").fetchone()[0]
    in_checked = con.execute(
        "SELECT COUNT(*) FROM stations_dedup WHERE in_checked=1"
    ).fetchone()[0]
    con.executemany(
        "INSERT OR REPLACE INTO meta(k,v) VALUES(?,?)",
        [("dedup_unique", str(uniq)), ("dedup_junk", str(junk)),
         ("dedup_secs", f"{time.time()-t0:.1f}")],
    )
    con.commit()
    con.close()

    print(f"\nDedupe done in {time.time()-t0:.1f}s")
    print(f"  input rows (http)   : {total - junk}")
    print(f"  unique by url_norm  : {uniq}")
    print(f"  with alive-prior    : {in_checked} (seen in a checked/ folder)")


if __name__ == "__main__":
    main()
