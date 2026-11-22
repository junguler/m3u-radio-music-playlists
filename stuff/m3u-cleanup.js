#!/usr/bin/env node
'use strict';

/*
 * m3u-cleanup.js - the M3U Toolkit's clean-up fixes, as one zero-dependency Node script (Node 16+)
 *
 *   node m3u-cleanup.js                    clean every .m3u / .m3u8 in this folder and all sub folders
 *   node m3u-cleanup.js playlists/ a.m3u   or only the folders / files you name
 *   node m3u-cleanup.js --dry-run          look, report, touch nothing (do this first, you will thank yourself)
 *
 * THE ONE RULE
 *   A broken TITLE is fixed.
 *   A broken LINK is fixed if it can be fixed, and if it cannot, the entry is removed together with its title.
 *   Nothing is ever added: no logos, no groups, no tvg-anything, no sorting, no merging between files.
 *
 * WHAT IT DOES TO EACH FILE (the same fixes the toolkit tabs have)
 *   Validate & fix     BOM removed, control characters removed, spaces trimmed, blank lines removed,
 *                      exactly one #EXTM3U on the first line, #EXTINF without a URL dropped,
 *                      missing ":" / "-1" duration / title comma added, unquoted attribute values quoted,
 *                      repeated attributes removed, unbalanced quotes repaired where that is safe,
 *                      titles trimmed and de-spaced, HTML entities (&amp;) decoded,
 *                      an empty title filled from the entry's own tvg-name (only when one exists).
 *   Track link health  every http(s) link is requested (2 bytes, Range request, same as the toolkit).
 *                      A link that answers is kept. A link that does not is retried once later, because
 *                      the toolkit waits for 3 failed RUNS in a row and a single run cannot do that.
 *   Upgrade to https   a link that is dead over http gets one chance: if the https version works, the link is
 *                      swapped (fixed). If not, the entry goes. Working http links are left alone.
 *   Link repairs       spaces in a URL encoded, "http:/host" and "http//host" repaired, "host:8000;" given its
 *                      slash, a missing http:// added when the line is clearly a host name. Each repair is
 *                      verified by the link check, so a repair that leads nowhere still ends in removal.
 *   Merge & dedupe     duplicate URLs inside one file are collapsed (http/https, www., trailing / and
 *                      tracking parameters count as the same stream). The entry with the most metadata stays,
 *                      in the position of the first one. Nothing is copied between entries.
 *
 * OPTIONS
 *   --dry-run            change nothing (the report file is still written)
 *   --no-links           offline mode: format, title and duplicate fixes only, no network at all
 *   --no-dedupe          keep duplicate URLs
 *   --proxy <url>        check links through a proxy:  socks5://127.0.0.1:10000  or  http://127.0.0.1:10001
 *   --concurrency <n>    links checked at once (default 40)
 *   --per-host <n>       at most n at once against the same host name (default 4, be nice to Icecast)
 *   --timeout <ms>       per link (default 8000)
 *   --retries <n>        extra rounds for links that failed softly: timeouts, resets, 5xx (default 1)
 *   --eol keep|lf|crlf   line endings (default keep: every file keeps what it mostly uses)
 *   --max-dead <percent> safety stop (default 50), see below
 *   --force              ignore the safety stop
 *   --report <file>      report file (default m3u-cleanup-report.txt, "none" to skip it)
 *   --quiet              less output
 *
 * THE SAFETY STOP
 *   If more than --max-dead percent of all links look dead, the script assumes YOUR network is the problem
 *   (offline, DNS filtering, a proxy that is down, hosts blocked where you live) and writes nothing.
 *   Playlists are not deleted by a bad Wi-Fi day. Use --proxy, or --no-links, or --force if you mean it.
 *   Nothing is written until every check has finished, so Ctrl+C at any point is harmless.
 *
 * HONEST LIMITATIONS
 *   - "Alive" means the server answered with a success code. It does not mean audio plays, the station is
 *     still the station, or that it is not a "we have moved" web page. Same standard as the toolkit.
 *   - Servers that block by country or by user agent (401, 403, 429) are kept, not removed: they did answer.
 *   - One run is one opinion. A stream that is down for maintenance during the run is removed; the toolkit's
 *     "3 runs in a row" rule exists for exactly that reason. Keep git (or a backup) around, and read the report.
 *   - TLS certificates are not verified (a stream with an expired certificate is still a stream).
 *   - HLS manifests (files containing #EXT-X- tags) are not station lists and are skipped.
 *   - Files that are not valid UTF-8 (Windows-1256 and friends) and UTF-16 files are skipped, never guessed at.
 *     Re-save them as UTF-8 first, otherwise a clean-up script would turn your station names into question marks.
 *   - Entries with other schemes (rtmp://, mms://, ...) and local file paths cannot be checked and are kept.
 *   - An #EXTINF line whose quotes are too broken to repair safely is left as it is and listed in the report.
 */

process.env.UV_THREADPOOL_SIZE = process.env.UV_THREADPOOL_SIZE || '64'; /* many slow DNS lookups must not block each other */

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const net = require('net');
const tls = require('tls');

/* ============================================================
 OPTIONS
 ============================================================ */
const opt = {
  concurrency: 40, perHost: 4, timeout: 8000, retries: 1, maxDead: 50,
  eol: 'keep', proxy: '', report: 'm3u-cleanup-report.txt',
  links: true, dedupe: true, dry: false, force: false, quiet: false,
};
const inputs = [];

function die(message) {
  console.error(message);
  process.exit(1);
}

function readNumber(name, value, min, max) {
  const n = Number(value);
  if (value === undefined || !Number.isFinite(n) || n < min || n > max) die(`${name} needs a number from ${min} to ${max}`);
  return Math.floor(n);
}

(function parseArgs() {
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    let a = argv[i];
    let value;
    if (a.startsWith('--') && a.includes('=')) {
      value = a.slice(a.indexOf('=') + 1);
      a = a.slice(0, a.indexOf('='));
    }
    const next = () => (value !== undefined ? value : argv[++i]);
    switch (a) {
      case '-h': case '--help': printHelp(); process.exit(0); break;
      case '--dry-run': opt.dry = true; break;
      case '--no-links': opt.links = false; break;
      case '--no-dedupe': opt.dedupe = false; break;
      case '--force': opt.force = true; break;
      case '--quiet': opt.quiet = true; break;
      case '--concurrency': opt.concurrency = readNumber(a, next(), 1, 500); break;
      case '--per-host': opt.perHost = readNumber(a, next(), 1, 50); break;
      case '--timeout': opt.timeout = readNumber(a, next(), 1000, 120000); break;
      case '--retries': opt.retries = readNumber(a, next(), 0, 5); break;
      case '--max-dead': opt.maxDead = readNumber(a, next(), 1, 100); break;
      case '--eol': opt.eol = String(next()).toLowerCase(); if (!['keep', 'lf', 'crlf'].includes(opt.eol)) die('--eol needs keep, lf or crlf'); break;
      case '--proxy': opt.proxy = String(next() || ''); break;
      case '--report': opt.report = String(next() || ''); break;
      default:
        if (a.startsWith('-')) die(`Unknown option ${a} (try --help)`);
        inputs.push(a);
    }
  }
  if (!inputs.length) inputs.push('.');
})();

function printHelp() {
  const text = fs.readFileSync(__filename, 'utf8');
  const m = /\/\*([\s\S]*?)\*\//.exec(text);
  console.log(m ? m[1].replace(/^ \*[ ]?/gm, '').trim() : 'See the comment at the top of m3u-cleanup.js');
}

let proxy = null;
if (opt.proxy && opt.proxy !== 'none') {
  let pu;
  try { pu = new URL(opt.proxy); } catch { die(`--proxy is not a URL: ${opt.proxy}`); }
  const type = /^socks/i.test(pu.protocol) ? 'socks5' : /^https?:$/i.test(pu.protocol) ? 'http' : '';
  if (!type || !pu.hostname || !pu.port) die('--proxy needs a form like socks5://127.0.0.1:10000 or http://127.0.0.1:10001');
  proxy = { type, host: pu.hostname.replace(/^\[|\]$/g, ''), port: Number(pu.port) };
}

/* ============================================================
 SMALL HELPERS
 ============================================================ */
const say = (msg) => { if (!opt.quiet) console.log(msg); };
const warn = (msg) => console.error(`! ${msg}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const qcount = (s) => (s.match(/"/g) || []).length;
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

function addTo(map, key, n = 1) {
  map.set(key, (map.get(key) || 0) + n);
}

/* index of the first comma that is not inside quotes, or -1 */
function commaIndex(line) {
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '"') inQuotes = !inQuotes;
    else if (line[i] === ',' && !inQuotes) return i;
  }
  return -1;
}

const ENTITY_MAP = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const ENTITY_RE = /&(#\d+|#x[0-9a-f]+|amp|lt|gt|quot|apos);/i;
const decodeEntities = (s) =>
  s.replace(/&(#\d+|#x[0-9a-f]+|amp|lt|gt|quot|apos);/gi, (whole, body) => {
    if (body[0] === '#') {
      const code = body[1].toLowerCase() === 'x' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      try { return String.fromCodePoint(code); } catch { return whole; }
    }
    return ENTITY_MAP[body.toLowerCase()];
  });

/* attributes before the title comma. Exact reading: quoted, or unquoted up to the next key= */
function readAttrsExact(prefix) {
  const list = [];
  const re = /([\w.-]+)=(?:"([^"]*)"|((?:(?!\s[\w.-]+=)[^"])*))/g;
  let m;
  while ((m = re.exec(prefix))) {
    list.push({ key: m[1], value: m[2] !== undefined ? m[2] : m[3].trim(), quoted: m[2] !== undefined });
  }
  return list;
}

/* attributes when the quotes are broken: every value runs up to the next " key=" */
function readAttrsTolerant(prefix) {
  const marks = [];
  const re = /(^|\s)([\w.-]+)=/g;
  let m;
  while ((m = re.exec(prefix))) marks.push({ key: m[2], valueStart: m.index + m[0].length, keyStart: m.index + m[1].length });
  return marks.map((k, i) => {
    let v = prefix.slice(k.valueStart, i + 1 < marks.length ? marks[i + 1].keyStart : prefix.length).trim();
    v = v.replace(/^"/, '').replace(/"$/, '').replace(/"/g, "'").trim();
    return { key: k.key, value: v, quoted: false };
  });
}

/* ============================================================
 TITLES AND #EXTINF
 ============================================================ */
function cleanTitle(title, labels) {
  let t = title;
  if (qcount(t) % 2 === 1) {
    t = t.replace(/"/g, '');
    labels.push('stray quote removed from title');
  }
  const before = t;
  t = t.replace(/\u200B/g, '').replace(/\s+/g, ' ').trim();
  if (t !== before) labels.push('title spaces cleaned');
  if (ENTITY_RE.test(t)) {
    let n = 0;
    let prev;
    do { prev = t; t = decodeEntities(t); n++; } while (t !== prev && n < 3 && ENTITY_RE.test(t));
    t = t.replace(/[\u0000-\u001F\u007F]+/g, ' ').replace(/\s+/g, ' ').trim();
    labels.push('HTML entity decoded');
  }
  return t;
}

/* returns { line, title }. Never throws, never drops the entry: a title problem is always a fix, not a removal */
function fixExtinf(line, pl) {
  const labels = [];
  const m = /^#EXTINF(:?)\s*([\s\S]*)$/i.exec(line);
  const dm = /^(-?\d+(?:\.\d+)?)?\s*([\s\S]*)$/.exec(m[2]);
  let duration = dm[1];
  const tail = dm[2];
  let prefix;
  let title;
  let tolerant = false;
  const idx = commaIndex(tail);

  if (idx !== -1) {
    prefix = tail.slice(0, idx);
    title = tail.slice(idx + 1);
  } else if (qcount(tail) % 2 === 0) {
    /* no comma outside quotes: the attributes come first, whatever is left over is the title */
    const run = /^(?:\s*[\w.-]+=(?:"[^"]*"|[^\s"]*))*/.exec(tail)[0];
    prefix = run;
    title = tail.slice(run.length);
    labels.push('missing title comma added');
  } else {
    /* an odd number of quotes and no usable comma: the last quote opens a value that never closes */
    const lastQuote = tail.lastIndexOf('"');
    const sep = tail.indexOf(',', lastQuote + 1);
    if (sep === -1) {
      pl.unrepaired.push(line);
      pl.bump('#EXTINF too broken to repair (left as is)');
      return { line, title: '' };
    }
    prefix = tail.slice(0, sep);
    title = tail.slice(sep + 1);
    tolerant = true;
    labels.push('unbalanced quotes repaired');
  }

  const attrs = tolerant ? readAttrsTolerant(prefix) : readAttrsExact(prefix);
  const seenKeys = new Set();
  const hasDup = attrs.some((a) => (seenKeys.has(a.key) ? true : (seenKeys.add(a.key), false)));
  const hasUnquoted = attrs.some((a) => !a.quoted && a.value !== '');

  if (tolerant || hasUnquoted || hasDup) {
    const seen = new Set();
    const kept = [];
    attrs.forEach((a) => {
      if (seen.has(a.key)) { labels.push('repeated attribute removed'); return; }
      seen.add(a.key);
      if (!tolerant && !a.quoted && a.value !== '') labels.push('attribute value quoted');
      kept.push(` ${a.key}="${a.value.replace(/"/g, "'")}"`);
    });
    prefix = kept.join('');
  } else {
    prefix = prefix.trim() ? ` ${prefix.trim()}` : '';
  }

  let t = cleanTitle(title, labels);
  if (t === '') {
    const named = attrs.find((a) => a.key === 'tvg-name' && a.value.trim());
    if (named) {
      t = cleanTitle(named.value, labels);
      if (t) labels.push('empty title restored from tvg-name');
    }
  }

  if (duration === undefined) { duration = '-1'; labels.push('missing duration added'); }
  if (!m[1]) labels.push('missing ":" after #EXTINF added');

  labels.forEach((l) => pl.bump(l));
  return { line: `#EXTINF:${duration}${prefix},${t}`, title: t };
}

/* ============================================================
 URLS
 ============================================================ */
const SCHEME_RE = /^([a-z][a-z0-9+.-]*):\/\//i;
const HOSTISH_RE = /^(?:(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,24}|\d{1,3}(?:\.\d{1,3}){3})(?::\d{1,5})?(?:[/?#;].*)?$/i;
const MEDIA_EXT_RE = /\.(mp3|aac|ogg|oga|opus|flac|wav|m4a|wma|mp4|m3u8?|pls|ts|txt|jpe?g|png)$/i;

const looksLocal = (u) => /^[a-zA-Z]:[\\/]/.test(u) || u.includes('\\') || /^(\/|\.{1,2}\/|~)/.test(u);

/* kind: 'web' (http/https, will be checked), 'other' (kept as is, cannot be checked), 'bad' (cannot be fixed) */
function normalizeUrl(raw) {
  let url = raw;
  let suffix = '';
  const bar = url.indexOf('|'); /* Kodi style "url|User-Agent=..." */
  if (bar > 0) { suffix = url.slice(bar); url = url.slice(0, bar); }
  const fixes = [];

  /* scheme typos: htp://  ttp://  http:/host  http:\\host  http//host  http:///host */
  let sm = /^(h?h?t{1,3}p)(s?):\/\//i.exec(url);
  if (sm && !/^https?$/i.test(sm[1] + sm[2])) {
    url = `http${sm[2].toLowerCase()}://${url.slice(sm[0].length)}`;
    fixes.push('URL scheme typo repaired');
  } else {
    const bm = /^(https?)(:?)([\\/]*)/i.exec(url);
    if (bm && (bm[2] === ':' || bm[3].length >= 2) && !(bm[2] === ':' && bm[3] === '//') && url.length > bm[0].length) {
      url = `${bm[1].toLowerCase()}://${url.slice(bm[0].length)}`;
      fixes.push('URL scheme separator repaired');
    }
  }

  sm = SCHEME_RE.exec(url);
  if (!sm) {
    if (looksLocal(url) || !HOSTISH_RE.test(url) || (!url.includes('/') && MEDIA_EXT_RE.test(url))) return { kind: 'other', url: raw };
    url = `http://${url}`;
    fixes.push('missing http:// added');
    sm = SCHEME_RE.exec(url);
  }
  const scheme = sm[1].toLowerCase();
  if (scheme !== 'http' && scheme !== 'https') return { kind: 'other', url: raw };

  if (/\s/.test(url)) { url = url.replace(/\s+/g, '%20'); fixes.push('spaces in URL encoded'); }
  if (/^https?:\/\/[^/?#;]+;/i.test(url)) { url = url.replace(/^(https?:\/\/[^/?#;]+);/i, '$1/;'); fixes.push('Shoutcast ";" given its slash'); }

  let u;
  try { u = new URL(url); } catch { return { kind: 'bad', reason: 'URL cannot be parsed' }; }
  if (!u.hostname) return { kind: 'bad', reason: 'URL has no host name' };
  if (/[^\u0000-\u007F]/.test(url)) { url = u.href; fixes.push('non-ASCII characters in URL encoded'); }

  return { kind: 'web', base: url, suffix, url: url + suffix, fixes };
}

const JUNK_PARAM = /^(utm_[a-z]+|fbclid|gclid|cb|nocache|_|ts|timestamp|rnd)$/i;

/* the Merge & dedupe defaults: http = https, www. ignored, tracking parameters ignored */
function urlKey(url) {
  const bar = url.indexOf('|');
  const base = bar > 0 ? url.slice(0, bar) : url;
  const suffix = bar > 0 ? url.slice(bar) : '';
  let u;
  try { u = new URL(base); } catch { return `other:${url.toLowerCase()}`; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return `other:${url.toLowerCase()}`;
  const host = u.hostname.toLowerCase().replace(/^www\./, '');
  const port = u.port === '80' || u.port === '443' ? '' : u.port;
  const p = u.pathname.replace(/\/{2,}/g, '/').replace(/\/;?$/, '');
  const params = [...u.searchParams.entries()].filter(([k]) => !JUNK_PARAM.test(k));
  params.sort((a, b) => (a[0] + a[1]).localeCompare(b[0] + b[1]));
  const query = params.length ? `?${params.map(([k, v]) => `${k}=${v}`).join('&')}` : '';
  return host + (port ? `:${port}` : '') + p + query + suffix;
}

/* ============================================================
 PARSING ONE PLAYLIST
 ============================================================ */
const CTRL_G = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\uFEFF]/g;
const PRE_RE = /^#(EXTVLCOPT|EXTGRP|KODIPROP|EXTHTTP|EXTALB|EXTART)\b/i;

function readPlaylist(file) {
  const buf = fs.readFileSync(file);
  if (buf.length >= 2 && ((buf[0] === 0xff && buf[1] === 0xfe) || (buf[0] === 0xfe && buf[1] === 0xff))) {
    return { skip: 'UTF-16 file (re-save it as UTF-8 first)' };
  }
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buf);
  } catch {
    return { skip: 'not valid UTF-8 (re-save it as UTF-8 first, otherwise the station names would be damaged)' };
  }
  if (/^[ \t]*#EXT-X-/mi.test(text)) return { skip: 'HLS manifest (#EXT-X- tags), not a station list' };
  return { text };
}

function parsePlaylist(file, original) {
  const pl = {
    file, original, items: [], header: null, headerFirst: true,
    fixes: new Map(), removals: new Map(), removed: [], linkFixes: [], unrepaired: [],
  };
  pl.bump = (label, n = 1) => addTo(pl.fixes, label, n);

  let text = original;
  if (text.charCodeAt(0) === 0xfeff) { text = text.slice(1); pl.bump('BOM removed'); }

  const crlf = (text.match(/\r\n/g) || []).length;
  const rest = text.replace(/\r\n/g, '');
  const lf = (rest.match(/\n/g) || []).length;
  const cr = (rest.match(/\r/g) || []).length;
  pl.mixedEol = [crlf, lf, cr].filter((n) => n > 0).length > 1 || (cr > 0 && crlf === 0 && lf === 0);
  pl.eol = opt.eol === 'crlf' ? '\r\n' : opt.eol === 'lf' ? '\n' : crlf > lf ? '\r\n' : '\n';
  pl.finalNewline = /(\r\n|\n|\r)$/.test(text);
  if (opt.eol === 'crlf' ? (lf > 0 || cr > 0) : opt.eol === 'lf' ? (crlf > 0 || cr > 0) : pl.mixedEol) pl.bump('line endings normalized');

  const lines = text.split(/\r\n|\n|\r/);
  if (lines.length && lines[lines.length - 1] === '') lines.pop();

  let pending = null;
  let pre = [];
  let firstContent = true;
  let blanks = 0;

  const dropOrphan = (entry) => {
    addTo(pl.removals, 'no URL after #EXTINF');
    pl.removed.push({ line: entry.line, title: entry.title, url: '', reason: '#EXTINF without a URL' });
  };

  lines.forEach((original2, i) => {
    let line = original2.replace(CTRL_G, '');
    if (line !== original2) pl.bump('control characters removed');
    if (line !== line.trim()) { line = line.trim(); pl.bump('lines trimmed'); }
    if (line === '') { blanks++; return; }

    if (/^#EXTM3U/i.test(line)) {
      if (pl.header === null) { pl.header = line; if (!firstContent) pl.headerFirst = false; } else pl.bump('repeated #EXTM3U removed');
      firstContent = false;
      return;
    }
    if (firstContent) { firstContent = false; pl.headerFirst = false; }

    if (/^#EXTINF/i.test(line)) {
      if (pending) dropOrphan(pending);
      const fixed = fixExtinf(line, pl);
      pending = { kind: 'entry', pre, extinf: fixed.line, title: fixed.title, extra: [], url: null, line: i + 1 };
      pre = [];
      return;
    }
    if (line.startsWith('#')) {
      if (pending) pending.extra.push(line);
      else if (PRE_RE.test(line)) pre.push(line);
      else pl.items.push({ kind: 'raw', line });
      return;
    }

    const entry = pending || { kind: 'entry', pre, extinf: null, title: '', extra: [], url: null, line: i + 1 };
    if (!pending) pre = [];
    entry.url = line;
    entry.urlLine = i + 1;
    pl.items.push(entry);
    pending = null;
  });

  if (pending) dropOrphan(pending);
  pre.forEach((l) => pl.items.push({ kind: 'raw', line: l }));
  if (blanks) pl.bump('blank lines removed', blanks);
  if (pl.header !== null && !pl.headerFirst) pl.bump('#EXTM3U moved to the first line');

  const entries = pl.items.filter((it) => it.kind === 'entry');
  entries.forEach((entry) => {
    const n = normalizeUrl(entry.url);
    entry.origUrl = entry.url;
    if (n.kind === 'bad') entry.drop = n.reason;
    else if (n.kind === 'web') { entry.web = n; entry.url = n.url; }
  });
  pl.entryCount = entries.length;
  return pl;
}

/* ============================================================
 CHECKING LINKS
 ============================================================ */
const UA = 'Mozilla/5.0 (compatible; m3u-cleanup)';

/* a tunnel to host:port through the proxy (HTTP CONNECT or SOCKS5), resolves with a connected socket */
function tunnel(host, port) {
  return new Promise((resolve, reject) => {
    const sock = net.connect({ host: proxy.host, port: proxy.port });
    let buf = Buffer.alloc(0);
    let stage = 0;
    const fail = (e) => { sock.destroy(); reject(e instanceof Error ? e : new Error(e)); };
    const done = () => {
      sock.removeListener('data', onData);
      sock.removeListener('error', fail);
      sock.setTimeout(0);
      resolve(sock);
    };
    const SOCKS_ERR = { 1: 'general failure', 2: 'not allowed', 3: 'network unreachable', 4: 'host unreachable', 5: 'connection refused', 6: 'TTL expired', 7: 'command not supported', 8: 'address type not supported' };

    function onData(chunk) {
      buf = Buffer.concat([buf, chunk]);
      if (proxy.type === 'http') {
        const end = buf.indexOf('\r\n\r\n');
        if (end === -1) return;
        const status = /^HTTP\/\d\.\d (\d{3})/.exec(buf.toString('latin1', 0, end));
        if (status && status[1] === '200') done(); else fail(`proxy answered ${status ? status[1] : 'garbage'}`);
        return;
      }
      if (stage === 0) {
        if (buf.length < 2) return;
        if (buf[0] !== 5 || buf[1] !== 0) return fail('SOCKS5 proxy wants authentication');
        buf = buf.slice(2);
        stage = 1;
        const head = net.isIPv4(host)
          ? Buffer.from([5, 1, 0, 1, ...host.split('.').map(Number)])
          : Buffer.concat([Buffer.from([5, 1, 0, 3, Buffer.byteLength(host)]), Buffer.from(host)]);
        sock.write(Buffer.concat([head, Buffer.from([port >> 8, port & 255])]));
      }
      if (stage === 1) {
        if (buf.length < 4) return;
        if (buf[0] !== 5) return fail('SOCKS5 garbage reply');
        if (buf[1] !== 0) return fail(`SOCKS5 ${SOCKS_ERR[buf[1]] || `error ${buf[1]}`}`);
        const addrLen = buf[3] === 1 ? 4 : buf[3] === 4 ? 16 : buf[3] === 3 ? (buf.length > 4 ? 1 + buf[4] : -1) : -2;
        if (addrLen === -2) return fail('SOCKS5 garbage reply');
        if (addrLen === -1 || buf.length < 4 + addrLen + 2) return;
        done();
      }
    }

    sock.setTimeout(opt.timeout + 2000, () => fail('proxy timeout'));
    sock.once('error', fail);
    sock.on('data', onData);
    sock.once('connect', () => {
      if (proxy.type === 'http') sock.write(`CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n\r\n`);
      else sock.write(Buffer.from([5, 1, 0]));
    });
  });
}

let plainAgent = false;
let secureAgent = false;
if (proxy) {
  const hostOf = (o) => String(o.host || o.hostname).replace(/^\[|\]$/g, '');
  plainAgent = new (class extends http.Agent {
    createConnection(o, cb) { tunnel(hostOf(o), Number(o.port) || 80).then((s) => cb(null, s), cb); }
  })();
  secureAgent = new (class extends https.Agent {
    createConnection(o, cb) {
      const host = hostOf(o);
      tunnel(host, Number(o.port) || 443).then((s) => {
        const t = tls.connect({ socket: s, servername: net.isIP(host) ? undefined : (o.servername || host), rejectUnauthorized: false });
        const onError = (e) => cb(e);
        t.once('error', onError);
        t.once('secureConnect', () => { t.removeListener('error', onError); cb(null, t); });
      }, cb);
    }
  })();
}

function classify(status) {
  if ((status >= 200 && status < 300) || status === 416) return 'ok';
  if (status === 401 || status === 403 || status === 429 || status === 451) return 'keep'; /* it answered: blocked, not dead */
  if (status === 404 || status === 410) return 'hard';
  return 'soft';
}

/*
 * Fallback for servers the http module refuses to parse. Old Shoutcast answers "ICY 200 OK", which is not
 * HTTP, so the parser throws HPE_* errors even though the stream is perfectly alive. This reads the first
 * line by hand instead.
 */
function rawProbe(u, deadline) {
  return new Promise((resolve) => {
    const secure = u.protocol === 'https:';
    const port = Number(u.port) || (secure ? 443 : 80);
    const host = u.hostname.replace(/^\[|\]$/g, '');
    let sock;
    let settled = false;
    let timer;
    const finish = (r) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (sock) sock.destroy();
      resolve(r);
    };
    timer = setTimeout(() => finish({ ok: false, reason: 'timeout' }), Math.max(1, deadline - Date.now()));

    const talk = (s) => {
      sock = s;
      let buf = '';
      s.on('error', (e) => finish({ ok: false, reason: e.code || e.message || 'error' }));
      s.on('data', (d) => {
        buf += d.toString('latin1');
        if (buf.indexOf('\n') === -1 && buf.length < 1024) return;
        const m = /^(?:ICY|HTTP\/\d(?:\.\d)?) (\d{3})/.exec(buf);
        if (!m) return finish({ ok: false, reason: 'not an HTTP or ICY answer' });
        const status = Number(m[1]);
        const c = classify(status);
        const t = /^content-type:[ \t]*([^\r\n]*)/im.exec(buf);
        if (c === 'ok' || c === 'keep') finish({ ok: true, keep: c === 'keep', status, type: t ? t[1].toLowerCase() : '' });
        else finish({ ok: false, hard: c === 'hard', reason: `HTTP ${status}` });
      });
      s.write(`GET ${u.pathname || '/'}${u.search} HTTP/1.0\r\nHost: ${u.host}\r\nUser-Agent: ${UA}\r\nIcy-MetaData: 0\r\nRange: bytes=0-1\r\nConnection: close\r\n\r\n`);
    };
    const wrap = (raw) => {
      if (!secure) return talk(raw);
      const t = tls.connect({ socket: raw, servername: net.isIP(host) ? undefined : host, rejectUnauthorized: false });
      t.once('error', (e) => finish({ ok: false, reason: e.code || e.message }));
      t.once('secureConnect', () => talk(t));
    };
    if (proxy) {
      tunnel(host, port).then(wrap, (e) => finish({ ok: false, reason: e.message }));
    } else {
      const raw = net.connect({ host, port });
      raw.once('error', (e) => finish({ ok: false, reason: e.code || e.message }));
      raw.once('connect', () => wrap(raw));
    }
  });
}

/* one GET with a 2 byte Range. http(s) modules, so Shoutcast's "ICY 200 OK" answers are understood */
function probeOnce(target, deadline, redirects = 5) {
  return new Promise((resolve) => {
    let u;
    try { u = new URL(target); } catch { return resolve({ ok: false, hard: true, reason: 'bad url' }); }
    const left = deadline - Date.now();
    if (left <= 0) return resolve({ ok: false, reason: 'timeout' });
    const secure = u.protocol === 'https:';
    let req;
    let settled = false;
    let timer;
    const finish = (r) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (req) req.destroy();
      resolve(r);
    };
    timer = setTimeout(() => finish({ ok: false, reason: 'timeout' }), left);
    const options = {
      headers: { Range: 'bytes=0-1', 'Icy-MetaData': '0', 'User-Agent': UA, Accept: '*/*' },
      insecureHTTPParser: true,
      rejectUnauthorized: false,
      agent: proxy ? (secure ? secureAgent : plainAgent) : false,
    };
    try {
      req = (secure ? https : http).get(u, options, (res) => {
        const s = res.statusCode;
        if (s >= 300 && s < 400 && res.headers.location) {
          if (redirects <= 0) return finish({ ok: false, reason: 'too many redirects' });
          let next;
          try { next = new URL(res.headers.location, u).href; } catch { return finish({ ok: false, reason: 'bad redirect' }); }
          if (!/^https?:/i.test(next)) return finish({ ok: false, reason: 'redirect to a non-http address' });
          settled = true;
          clearTimeout(timer);
          req.destroy();
          return resolve(probeOnce(next, deadline, redirects - 1));
        }
        const c = classify(s);
        const type = String(res.headers['content-type'] || '').toLowerCase();
        if (c === 'ok' || c === 'keep') finish({ ok: true, keep: c === 'keep', status: s, type });
        else finish({ ok: false, hard: c === 'hard', reason: `HTTP ${s}` });
      });
    } catch (e) {
      return finish({ ok: false, reason: e.code || e.message });
    }
    req.on('error', (e) => {
      if (settled) return;
      if (typeof e.code === 'string' && e.code.startsWith('HPE_')) {
        /* the parser rejected the answer (ICY 200 OK and friends): read the status line ourselves */
        settled = true;
        clearTimeout(timer);
        req.destroy();
        return resolve(rawProbe(u, deadline));
      }
      finish({ ok: false, reason: e.code || e.message || 'error' });
    });
  });
}

/* at most opt.perHost requests per host name at the same time */
const hostActive = new Map();
const hostWaiters = new Map();
async function withHost(host, fn) {
  while ((hostActive.get(host) || 0) >= opt.perHost) {
    await new Promise((r) => { if (!hostWaiters.has(host)) hostWaiters.set(host, []); hostWaiters.get(host).push(r); });
  }
  addTo(hostActive, host);
  try { return await fn(); } finally {
    addTo(hostActive, host, -1);
    const w = hostWaiters.get(host);
    if (w && w.length) w.shift()();
  }
}

async function runPool(items, n, worker) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) await worker(items[i++]);
  }));
}

/* one link from each host in turn, so a single busy server is never hit by a whole queue at once */
function interleave(list) {
  const byHost = new Map();
  list.forEach((t) => {
    let h = '';
    try { h = new URL(t).hostname; } catch { /* checked later */ }
    if (!byHost.has(h)) byHost.set(h, []);
    byHost.get(h).push(t);
  });
  const lanes = [...byHost.values()];
  const out = [];
  for (let k = 0; out.length < list.length; k++) lanes.forEach((lane) => { if (k < lane.length) out.push(lane[k]); });
  return out;
}

function progressLine(label, done, total, extra) {
  const width = 24;
  const filled = total ? Math.round((done / total) * width) : width;
  return `${label} [${'#'.repeat(filled)}${' '.repeat(width - filled)}] ${done}/${total}${extra ? `  ${extra}` : ''}`;
}

let lastPrint = 0;
function progress(label, done, total, extra, force) {
  if (opt.quiet) return;
  const now = Date.now();
  if (process.stdout.isTTY) {
    if (!force && now - lastPrint < 150) return;
    lastPrint = now;
    process.stdout.write(`\r${progressLine(label, done, total, extra).padEnd(79)}`);
    if (force) process.stdout.write('\n');
  } else if (force || now - lastPrint > 5000) {
    lastPrint = now;
    console.log(progressLine(label, done, total, extra));
  }
}

/* checks a list of URLs, retrying soft failures in later rounds. Returns Map(url -> result) */
async function checkAll(list, label, rejectHtml) {
  const results = new Map();
  let todo = interleave(list);
  let alive = 0;
  let dead = 0;

  for (let round = 0; round <= opt.retries && todo.length; round++) {
    if (round > 0) {
      say(`Retrying ${plural(todo.length, 'link')} that failed softly (round ${round} of ${opt.retries}) ...`);
      await sleep(2000);
    }
    const timeout = round === 0 ? opt.timeout : Math.round(opt.timeout * 1.5);
    let done = 0;
    await runPool(todo, opt.concurrency, async (target) => {
      let r;
      let host = '';
      try { host = new URL(target).hostname; } catch { /* probeOnce reports it */ }
      r = await withHost(host, () => probeOnce(target, Date.now() + timeout));
      if (rejectHtml && r.ok && /text\/html|application\/xhtml/.test(r.type || '')) r = { ok: false, hard: true, reason: 'answers with a web page, not a stream' };
      const before = results.get(target);
      results.set(target, r);
      done++;
      if (round === 0) { if (r.ok) alive++; else dead++; }
      progress(round === 0 ? label : `${label} retry`, done, todo.length, round === 0 ? `alive ${alive}, failing ${dead}` : '');
      return before;
    });
    progress(round === 0 ? label : `${label} retry`, todo.length, todo.length, round === 0 ? `alive ${alive}, failing ${dead}` : '', true);
    todo = todo.filter((t) => { const r = results.get(t); return !r.ok && !r.hard; });
  }
  return results;
}

function httpsCandidates(base) {
  let u;
  try { u = new URL(base); } catch { return []; }
  if (u.protocol !== 'http:') return [];
  const same = new URL(base);
  same.protocol = 'https:';
  const list = [same.href];
  if (u.port && u.port !== '80') {
    const standard = new URL(same.href);
    standard.port = '';
    list.push(standard.href);
  }
  return [...new Set(list)];
}

/* ============================================================
 FILES
 ============================================================ */
const SKIP_DIRS = new Set(['node_modules', '.git', '.svn', '.hg']);

function walk(dir, out) {
  let list;
  try { list = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { warn(`cannot read folder ${dir}: ${e.code || e.message}`); return; }
  for (const d of list) {
    if (d.isSymbolicLink()) continue;
    const p = path.join(dir, d.name);
    if (d.isDirectory()) { if (!SKIP_DIRS.has(d.name)) walk(p, out); } else if (d.isFile() && /\.m3u8?$/i.test(d.name)) out.push(p);
  }
}

function writeFileSafely(file, text) {
  const tmp = `${file}.cleanup-tmp`;
  try {
    fs.writeFileSync(tmp, text);
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* nothing to remove */ }
    fs.writeFileSync(file, text);
  }
}

const filledAttrs = (e) => (e.extinf ? (e.extinf.match(/[\w.-]+="[^"]+"/g) || []).length : 0);
const entryScore = (e) => filledAttrs(e) * 10 + (/^https:/i.test(e.url) ? 1 : 0) + (e.title ? 1 : 0);

/* ============================================================
 MAIN
 ============================================================ */
async function main() {
  const started = Date.now();
  const rel = (f) => path.relative(process.cwd(), f) || f;

  /* ---- find files ---- */
  const files = [];
  for (const p of inputs) {
    let st;
    try { st = fs.statSync(p); } catch { die(`Not found: ${p}`); }
    if (st.isDirectory()) walk(path.resolve(p), files);
    else if (/\.m3u8?$/i.test(p)) files.push(path.resolve(p));
    else warn(`Skipped ${p}: only .m3u and .m3u8 files are processed`);
  }
  const unique = [...new Set(files)].sort();
  say(`m3u-cleanup${opt.dry ? ' (dry run: nothing will be changed)' : ''}${opt.links ? '' : ' (offline: links are not checked)'}${proxy ? ` via ${opt.proxy}` : ''}`);
  say(`Found ${plural(unique.length, 'playlist file')}`);
  if (!unique.length) return;

  /* ---- parse and fix everything that needs no network ---- */
  const playlists = [];
  const skipped = [];
  const failed = [];
  for (const file of unique) {
    try {
      const r = readPlaylist(file);
      if (r.skip) { skipped.push({ file, reason: r.skip }); continue; }
      const pl = parsePlaylist(file, r.text);
      if (pl.header === null && !pl.items.length) { skipped.push({ file, reason: 'no playlist content' }); continue; }
      playlists.push(pl);
    } catch (e) {
      failed.push({ file, reason: e.message });
    }
  }
  const totalEntries = playlists.reduce((n, pl) => n + pl.entryCount, 0);
  say(`Read ${plural(playlists.length, 'file')} with ${totalEntries} entries${skipped.length ? `; skipped ${skipped.length}` : ''}`);

  /* ---- check links ---- */
  const verdict = new Map(); /* base url -> { ok, fixed, keep, reason } */
  let linkStats = null;
  if (opt.links) {
    const targets = new Set();
    playlists.forEach((pl) => pl.items.forEach((it) => { if (it.kind === 'entry' && it.web && !it.drop) targets.add(it.web.base); }));
    const list = [...targets];

    if (list.length) {
      if (proxy) {
        await new Promise((resolve) => {
          const s = net.connect({ host: proxy.host, port: proxy.port });
          s.setTimeout(4000, () => { s.destroy(); die(`The proxy ${opt.proxy} does not answer`); });
          s.once('error', (e) => die(`The proxy ${opt.proxy} is not reachable (${e.code || e.message})`));
          s.once('connect', () => { s.destroy(); resolve(); });
        });
      }
      say(`Checking ${plural(list.length, 'unique link')} (${opt.concurrency} at a time, ${opt.timeout} ms timeout)`);
      const first = await checkAll(list, 'Links', false);

      const deadHttp = list.filter((t) => !first.get(t).ok && /^http:/i.test(t));
      const candidateOf = new Map();
      const candidates = new Set();
      deadHttp.forEach((t) => { const c = httpsCandidates(t); candidateOf.set(t, c); c.forEach((x) => candidates.add(x)); });
      let second = new Map();
      if (candidates.size) {
        say(`Looking for https versions of ${plural(deadHttp.length, 'dead http link')}`);
        second = await checkAll([...candidates], 'https', true);
      }

      let aliveN = 0;
      let keptN = 0;
      let fixedN = 0;
      const reasons = new Map();
      list.forEach((t) => {
        const r = first.get(t);
        if (r.ok) { verdict.set(t, { ok: true, keep: r.keep }); aliveN++; if (r.keep) keptN++; return; }
        const fix = (candidateOf.get(t) || []).find((c) => second.get(c) && second.get(c).ok);
        if (fix) { verdict.set(t, { ok: true, fixed: fix }); fixedN++; return; }
        verdict.set(t, { ok: false, reason: r.reason });
        addTo(reasons, r.reason);
      });
      const deadN = list.length - aliveN - fixedN;
      linkStats = { total: list.length, alive: aliveN, answeredButBlocked: keptN, fixed: fixedN, dead: deadN, reasons };
      say(`Links: ${aliveN} alive${keptN ? ` (${keptN} answered 401/403/429 and are kept)` : ''}, ${fixedN} fixed with https, ${deadN} dead`);

      const pct = (deadN / list.length) * 100;
      if (list.length >= 20 && pct > opt.maxDead && !opt.force) {
        console.error('');
        console.error(`STOP: ${deadN} of ${list.length} links (${Math.round(pct)}%) look dead, which is more than the ${opt.maxDead}% safety limit.`);
        console.error('That usually means the network is the problem, not the playlists. Why they failed:');
        [...reasons.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).forEach(([k, v]) => console.error(`  ${String(v).padStart(6)}  ${k}`));
        console.error('Nothing was changed. Try --proxy, check your connection, use --no-links for format fixes only,');
        console.error('or --force (or a higher --max-dead) if you really do mean it.');
        process.exit(2);
      }
    }
  }

  /* ---- apply: remove dead entries, swap fixed links, dedupe, render ---- */
  const totals = { fixes: new Map(), removals: new Map(), linkFixes: 0, files: 0, entriesBefore: totalEntries, entriesAfter: 0 };
  const changed = [];

  for (const pl of playlists) {
    const out = [];
    for (const it of pl.items) {
      if (it.kind === 'raw') { out.push(it); continue; }
      if (it.drop) {
        addTo(pl.removals, 'unparseable URL');
        pl.removed.push({ line: it.urlLine, title: it.title, url: it.origUrl, reason: it.drop });
        continue;
      }
      if (it.web) {
        const v = verdict.get(it.web.base);
        if (v && !v.ok) {
          addTo(pl.removals, 'dead link');
          pl.removed.push({ line: it.urlLine, title: it.title, url: it.origUrl, reason: `dead link (${v.reason})` });
          continue;
        }
        if (v && v.fixed) {
          const old = it.origUrl;
          it.url = v.fixed + it.web.suffix;
          pl.linkFixes.push({ line: it.urlLine, title: it.title, from: old, to: it.url, how: 'http dead, https works' });
          pl.bump('dead http link swapped for its https version');
        } else it.web.fixes.forEach((f) => pl.bump(f));
      }
      out.push(it);
    }

    let kept = out;
    if (opt.dedupe) {
      kept = [];
      const slot = new Map();
      for (const it of out) {
        if (it.kind === 'raw') { kept.push(it); continue; }
        const key = urlKey(it.url);
        if (!slot.has(key)) { slot.set(key, kept.length); kept.push(it); continue; }
        const at = slot.get(key);
        const winner = entryScore(it) > entryScore(kept[at]) ? it : kept[at];
        const loser = winner === it ? kept[at] : it;
        kept[at] = winner;
        addTo(pl.removals, 'duplicate URL');
        pl.removed.push({ line: loser.urlLine, title: loser.title, url: loser.origUrl, reason: `duplicate of ${winner.origUrl}` });
      }
    }

    const lines = [];
    if (pl.header === null) pl.bump('#EXTM3U header added');
    lines.push(pl.header === null ? '#EXTM3U' : pl.header);
    for (const it of kept) {
      if (it.kind === 'raw') lines.push(it.line);
      else { lines.push(...it.pre); if (it.extinf !== null) lines.push(it.extinf); lines.push(...it.extra); lines.push(it.url); }
    }
    pl.entriesAfter = kept.filter((it) => it.kind === 'entry').length;
    pl.text = lines.join(pl.eol) + (pl.finalNewline ? pl.eol : '');
    pl.changed = pl.text !== pl.original;
    totals.entriesAfter += pl.entriesAfter;
    if (pl.changed) {
      changed.push(pl);
      pl.fixes.forEach((n, k) => addTo(totals.fixes, k, n));
      pl.removals.forEach((n, k) => addTo(totals.removals, k, n));
      totals.linkFixes += pl.linkFixes.length;
    }
  }

  /* ---- write ---- */
  if (!opt.dry) {
    for (const pl of changed) {
      try { writeFileSafely(pl.file, pl.text); totals.files++; } catch (e) { failed.push({ file: pl.file, reason: `could not write: ${e.message}` }); pl.changed = false; }
    }
  } else totals.files = changed.length;

  /* ---- console summary ---- */
  const removedTotal = [...totals.removals.values()].reduce((a, b) => a + b, 0);
  say('');
  if (!opt.quiet) {
    changed.slice(0, 300).forEach((pl) => {
      const rem = [...pl.removals.values()].reduce((a, b) => a + b, 0);
      const fx = [...pl.fixes.values()].reduce((a, b) => a + b, 0);
      const bits = [];
      if (rem) bits.push(`-${rem} removed`);
      if (pl.linkFixes.length) bits.push(`${pl.linkFixes.length} links fixed`);
      if (fx) bits.push(`${fx} format/title fixes`);
      console.log(`  ${rel(pl.file)}  ${bits.join(', ') || 'rewritten'}`);
    });
    if (changed.length > 300) console.log(`  ... and ${changed.length - 300} more (see the report)`);
  }
  say('');
  console.log(`${opt.dry ? 'Would change' : 'Changed'} ${totals.files} of ${plural(playlists.length, 'file')}. Entries ${totals.entriesBefore} -> ${totals.entriesAfter} (${removedTotal} removed).`);
  if (removedTotal) [...totals.removals.entries()].sort((a, b) => b[1] - a[1]).forEach(([k, v]) => console.log(`  removed  ${String(v).padStart(6)}  ${k}`));
  if (totals.fixes.size) [...totals.fixes.entries()].sort((a, b) => b[1] - a[1]).forEach(([k, v]) => console.log(`  fixed    ${String(v).padStart(6)}  ${k}`));
  if (linkStats && linkStats.dead) {
    console.log('  why links died:');
    [...linkStats.reasons.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).forEach(([k, v]) => console.log(`           ${String(v).padStart(6)}  ${k}`));
  }
  skipped.forEach((s) => console.log(`  skipped  ${rel(s.file)}: ${s.reason}`));
  failed.forEach((s) => console.log(`  FAILED   ${rel(s.file)}: ${s.reason}`));
  const unrepaired = playlists.reduce((n, pl) => n + pl.unrepaired.length, 0);
  if (unrepaired) console.log(`  ${plural(unrepaired, 'broken #EXTINF line')} could not be repaired safely and ${unrepaired === 1 ? 'was' : 'were'} left as is (listed in the report)`);

  /* ---- report ---- */
  if (opt.report && opt.report.toLowerCase() !== 'none') {
    const r = [];
    r.push(`m3u-cleanup report - ${new Date().toISOString()}${opt.dry ? ' (dry run, nothing was changed)' : ''}`);
    r.push(`Entries ${totals.entriesBefore} -> ${totals.entriesAfter}, ${removedTotal} removed, ${totals.linkFixes} links fixed, ${totals.files} files ${opt.dry ? 'would change' : 'changed'}`);
    r.push(`Took ${Math.round((Date.now() - started) / 1000)} s`);
    r.push('');
    for (const pl of changed) {
      r.push(`=== ${rel(pl.file)}`);
      [...pl.fixes.entries()].forEach(([k, v]) => r.push(`  fixed: ${v} x ${k}`));
      pl.linkFixes.forEach((f) => r.push(`  LINK FIXED (line ${f.line}) ${f.title || '(no title)'}\n      ${f.from}\n   -> ${f.to}   [${f.how}]`));
      pl.removed.forEach((x) => r.push(`  REMOVED (line ${x.line}) ${x.title || '(no title)'}\n      ${x.url || '(no URL)'}\n      ${x.reason}`));
      pl.unrepaired.forEach((l) => r.push(`  NOT REPAIRED: ${l}`));
      r.push('');
    }
    const left = playlists.filter((pl) => !pl.changed && pl.unrepaired.length);
    left.forEach((pl) => { r.push(`=== ${rel(pl.file)}`); pl.unrepaired.forEach((l) => r.push(`  NOT REPAIRED: ${l}`)); r.push(''); });
    skipped.forEach((s) => r.push(`SKIPPED ${rel(s.file)}: ${s.reason}`));
    failed.forEach((s) => r.push(`FAILED ${rel(s.file)}: ${s.reason}`));
    try { fs.writeFileSync(opt.report, `${r.join('\n')}\n`); console.log(`Report: ${opt.report}`); } catch (e) { warn(`could not write the report: ${e.message}`); }
  }
  if (!opt.dry && totals.files) console.log('Tip: if this folder is a git repository, "git diff --stat" shows exactly what happened, and "git checkout ." undoes all of it.');
  if (failed.length) process.exitCode = 1;
}

main().catch((e) => { console.error(e && e.stack ? e.stack : e); process.exit(1); });
