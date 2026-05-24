# /// script
# requires-python = ">=3.12"
# dependencies = ["requests"]
# ///
"""
Stage 4 - Dead-link check (threaded, chunked, resumable, checkpointed).

A bounded ThreadPoolExecutor of `concurrency` worker threads, each doing a
blocking ranged GET with a hard socket timeout. URLs are processed in chunks so
memory stays flat and results commit continuously -- so it can be stopped and
restarted freely (only url_norms not already in `liveness` are checked).

(An earlier asyncio version scheduled all ~1.44M coroutines at once and thrashed
the event loop -- this thread-pool design avoids that entirely.)

Alive  = HTTP status < 400, OR an audio/* / mpegurl / ICY content-type, OR a
         legacy "ICY 200 OK" status line (SHOUTcast) via a raw-socket fallback.
Dead   = DNS failure, connection refused/reset, TLS error, timeout, 4xx/5xx.

Scope (--scope):  all (default) | prior (upstream checked/ only) | classified
Tunables: --concurrency N (default 512), --timeout S (default 6), --limit N
"""
import argparse
import os
import queue
import socket
import sqlite3
import threading
import time

import requests
import urllib3

urllib3.disable_warnings()
DB = os.path.join(os.path.dirname(__file__), ".cache", "stations.db")
ALIVE_CT = ("audio/", "application/ogg", "video/", "application/vnd.apple.mpegurl",
            "application/x-mpegurl", "application/octet-stream", "application/dash")
HEADERS = {"Range": "bytes=0-2", "User-Agent": "Mozilla/5.0", "Icy-MetaData": "1"}

CONC = 512
TIMEOUT = 6.0
_tl = threading.local()

# Per-host DNS cache. Most cost on a mostly-dead corpus is getaddrinfo hanging
# ~20-25s on hosts whose nameservers are gone (NOT covered by the connect
# timeout, and timeouts aren't OS-cached so every URL re-hangs). 1.44M URLs map
# to only ~102k hosts (~14 URLs each), so we resolve each host once with a hard
# cap and cache the verdict -> dead-host URLs become instant.
_dns = {}
_dns_lock = threading.Lock()


def host_ok(host):
    # Plain cached getaddrinfo (measured: 92% resolve <1s, failures fast). No
    # per-resolve thread spawn -- that caused a thread explosion that drowned
    # the OS resolver. One lookup per host, cached; dead-DNS hosts then instant.
    with _dns_lock:
        if host in _dns:
            return _dns[host]
    try:
        socket.getaddrinfo(host, None)
        ok = True
    except Exception:
        ok = False
    with _dns_lock:
        _dns[host] = ok
    return ok


def session():
    s = getattr(_tl, "s", None)
    if s is None:
        s = requests.Session()
        a = requests.adapters.HTTPAdapter(pool_connections=4, pool_maxsize=4,
                                          max_retries=0)
        s.mount("http://", a)
        s.mount("https://", a)
        _tl.s = s
    return s


def check(url):
    # connect timeout kept short (alive servers connect fast); no ICY re-probe
    # (it doubled the cost on dead URLs) -> a small false-dead rate on pure-ICY
    # SHOUTcast servers is the deliberate trade for throughput.
    netloc = url.split("://", 1)[-1].split("/", 1)[0]
    host = netloc.rsplit("@", 1)[-1].rsplit(":", 1)[0].strip("[]").lower()
    if host and not host_ok(host):
        return ("dead", 0)
    ctimeout = min(TIMEOUT, 3.0)
    try:
        with session().get(url, headers=HEADERS, stream=True, allow_redirects=True,
                           timeout=(ctimeout, TIMEOUT), verify=False) as r:
            if r.status_code < 400:
                return ("alive", r.status_code)
            ct = r.headers.get("Content-Type", "").lower()
            if any(ct.startswith(c) for c in ALIVE_CT) or "icy" in ct:
                return ("alive", r.status_code)
            return ("dead", r.status_code)
    except Exception:
        return ("dead", 0)


def pending_urls(con, scope):
    where = ""
    if scope == "prior":
        where = "WHERE in_checked=1"
    elif scope == "classified":
        where = ("WHERE url_norm IN (SELECT url_norm FROM facets WHERE "
                 "category IS NOT NULL OR country IS NOT NULL OR language IS NOT NULL)")
    q = (f"SELECT url_norm, url FROM stations_dedup {where} "
         f"{'AND' if where else 'WHERE'} url_norm NOT IN (SELECT url_norm FROM liveness)")
    return con.execute(q).fetchall()


def main():
    global CONC, TIMEOUT
    ap = argparse.ArgumentParser()
    ap.add_argument("--scope", choices=["all", "prior", "classified"], default="all")
    ap.add_argument("--concurrency", type=int, default=1000)
    ap.add_argument("--timeout", type=float, default=4.0)
    ap.add_argument("--limit", type=int, default=0)
    args = ap.parse_args()
    CONC, TIMEOUT = args.concurrency, args.timeout
    threading.stack_size(512 * 1024)  # fit many worker threads

    con = sqlite3.connect(DB)
    con.execute("PRAGMA journal_mode=WAL")
    con.execute("CREATE TABLE IF NOT EXISTS liveness("
                "url_norm TEXT PRIMARY KEY, status TEXT, code INTEGER, checked_at REAL)")
    con.commit()

    todo = pending_urls(con, args.scope)
    if args.limit:
        todo = todo[:args.limit]
    total = len(todo)
    done0 = con.execute("SELECT COUNT(*) FROM liveness").fetchone()[0]
    print(f"scope={args.scope} pending={total} already_checked={done0} "
          f"concurrency={CONC} timeout={TIMEOUT}s", flush=True)
    if not total:
        print("nothing to do")
        return

    # producer-consumer: CONC worker threads stay saturated (no chunk barrier),
    # a feeder thread bounds the task queue, main thread drains + checkpoints.
    task_q = queue.Queue(maxsize=CONC * 2)
    res_q = queue.Queue(maxsize=CONC * 4)
    STOP = object()

    def worker():
        while True:
            item = task_q.get()
            if item is STOP:
                return
            un, url = item
            res_q.put((un, *check(url), time.time()))

    def feeder():
        for item in todo:
            task_q.put(item)
        for _ in range(CONC):
            task_q.put(STOP)

    workers = [threading.Thread(target=worker, daemon=True) for _ in range(CONC)]
    for t in workers:
        t.start()
    threading.Thread(target=feeder, daemon=True).start()

    done = alive = last = 0
    t0 = time.time()
    buf = []
    while done < total:
        un, status, code, ts = res_q.get()
        buf.append((un, status, code, ts))
        done += 1
        if status == "alive":
            alive += 1
        if len(buf) >= 3000:
            con.executemany("INSERT OR REPLACE INTO liveness VALUES(?,?,?,?)", buf)
            con.commit()
            buf.clear()
        if done - last >= 10000:
            last = done
            rate = done / (time.time() - t0)
            eta = (total - done) / rate / 60 if rate else 0
            print(f"  {done}/{total} alive={alive} ({100*alive/done:.0f}%) "
                  f"{rate:.0f}/s eta~{eta:.0f}m", flush=True)
    if buf:
        con.executemany("INSERT OR REPLACE INTO liveness VALUES(?,?,?,?)", buf)
        con.commit()

    a = con.execute("SELECT COUNT(*) FROM liveness WHERE status='alive'").fetchone()[0]
    d = con.execute("SELECT COUNT(*) FROM liveness WHERE status='dead'").fetchone()[0]
    con.close()
    print(f"\ndone in {(time.time()-t0)/60:.1f}m  alive={a} dead={d}")


if __name__ == "__main__":
    main()
