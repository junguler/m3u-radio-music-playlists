#!/usr/bin/env node
'use strict';

/*
 * m3u-cleanup-offline.js - offline M3U / M3U8 cleaner (zero dependencies, Node 16+)
 *
 *   node m3u-cleanup-offline.js                    clean every .m3u / .m3u8 in this folder and subfolders
 *   node m3u-cleanup-offline.js playlists/ a.m3u   or only the folders / files you name
 *   node m3u-cleanup-offline.js --dry-run          look, change nothing
 *
 * WHAT IT DOES (no network access at all)
 *   - Removes BOM, control characters, blank lines; trims whitespace
 *   - Ensures exactly one #EXTM3U on the first line
 *   - Drops orphan #EXTINF lines that have no URL
 *   - Fixes #EXTINF: missing ":", missing duration (-1), missing title comma,
 *     unquoted attribute values, repeated attributes, unbalanced quotes (when safe)
 *   - Cleans titles: extra spaces, zero-width chars, HTML entities (&amp; etc.)
 *   - Fills an empty title from the entry's own tvg-name attribute (if present)
 *   - Repairs common URL typos offline:
 *       scheme typos (htp://, http:/, http//, ...), missing http:// on clear hostnames,
 *       spaces → %20, Shoutcast "host:port;" → "host:port/;", non-ASCII encoding
 *   - Removes entries whose URL is unparseable / obviously broken after repair attempts
 *   - Optionally deduplicates apparent duplicate streams inside one file when --dedupe
 *     is supplied. Keeps the entry with the richest metadata.
 *
 * WHAT IT NEVER DOES
 *   - No internet requests of any kind
 *   - No adding of logos, groups, tvg-* attributes, or any new metadata
 *   - No sorting, no merging between different files
 *
 * OPTIONS
 *   --dry-run            change nothing
 *   --dedupe             remove apparent duplicate URLs (off by default)
 *   --no-dedupe          explicitly keep duplicate URLs (default; retained for compatibility)
 *   --eol keep|lf|crlf   line endings (default keep)
 *   --quiet              less console output
 */

const fs = require('fs');
const path = require('path');

/* ============================================================
 OPTIONS
 ============================================================ */
const opt = {
  eol: 'keep',
  dedupe: false,
  dry: false,
  quiet: false,
};
const inputs = [];

function die(message) {
  console.error(message);
  process.exit(1);
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
      case '--dedupe': opt.dedupe = true; break;
      case '--no-dedupe': opt.dedupe = false; break;
      case '--quiet': opt.quiet = true; break;
      case '--eol':
        opt.eol = String(next()).toLowerCase();
        if (!['keep', 'lf', 'crlf'].includes(opt.eol)) die('--eol needs keep, lf or crlf');
        break;
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
  console.log(m ? m[1].replace(/^ \*[ ]?/gm, '').trim() : 'See the comment at the top of the script');
}

/* ============================================================
 SMALL HELPERS
 ============================================================ */
const say = (msg) => { if (!opt.quiet) console.log(msg); };
const warn = (msg) => console.error(`! ${msg}`);
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
 URLS (offline repair only)
 ============================================================ */
const SCHEME_RE = /^([a-z][a-z0-9+.-]*):\/\//i;
const HOSTISH_RE = /^(?:(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,24}|\d{1,3}(?:\.\d{1,3}){3})(?::\d{1,5})?(?:[/?#;].*)?$/i;
const MEDIA_EXT_RE = /\.(mp3|aac|ogg|oga|opus|flac|wav|m4a|wma|mp4|m3u8?|pls|ts|txt|jpe?g|png)$/i;

const looksLocal = (u) => /^[a-zA-Z]:[\\/]/.test(u) || u.includes('\\') || /^(\/|\.{1,2}\/|~)/.test(u);

/* kind: 'web' (http/https, repaired offline), 'other' (kept as is), 'bad' (cannot be fixed → remove entry) */
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
    if (looksLocal(url) || !HOSTISH_RE.test(url) || (!url.includes('/') && MEDIA_EXT_RE.test(url))) {
      return { kind: 'other', url: raw };
    }
    url = `http://${url}`;
    fixes.push('missing http:// added');
    sm = SCHEME_RE.exec(url);
  }
  const scheme = sm[1].toLowerCase();
  if (scheme !== 'http' && scheme !== 'https') return { kind: 'other', url: raw };

  if (/\s/.test(url)) { url = url.replace(/\s+/g, '%20'); fixes.push('spaces in URL encoded'); }
  if (/^https?:\/\/[^/?#;]+;/i.test(url)) {
    url = url.replace(/^(https?:\/\/[^/?#;]+);/i, '$1/;');
    fixes.push('Shoutcast ";" given its slash');
  }

  let u;
  try { u = new URL(url); } catch { return { kind: 'bad', reason: 'URL cannot be parsed' }; }
  if (!u.hostname) return { kind: 'bad', reason: 'URL has no host name' };
  if (/[^\u0000-\u007F]/.test(url)) { url = u.href; fixes.push('non-ASCII characters in URL encoded'); }

  return { kind: 'web', base: url, suffix, url: url + suffix, fixes };
}

const JUNK_PARAM = /^(utm_[a-z]+|fbclid|gclid|cb|nocache|_|ts|timestamp|rnd)$/i;

/* http = https, www. ignored, tracking parameters ignored */
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
    fixes: new Map(), removals: new Map(), removed: [], unrepaired: [],
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
  if (opt.eol === 'crlf' ? (lf > 0 || cr > 0) : opt.eol === 'lf' ? (crlf > 0 || cr > 0) : pl.mixedEol) {
    pl.bump('line endings normalized');
  }

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
      if (pl.header === null) {
        pl.header = line;
        if (!firstContent) pl.headerFirst = false;
      } else {
        pl.bump('repeated #EXTM3U removed');
      }
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
    if (n.kind === 'bad') {
      entry.drop = n.reason;
    } else if (n.kind === 'web') {
      entry.web = n;
      entry.url = n.url;
    }
    /* kind === 'other' → leave entry.url as the original */
  });
  pl.entryCount = entries.length;
  return pl;
}

/* ============================================================
 FILES
 ============================================================ */
const SKIP_DIRS = new Set(['node_modules', '.git', '.svn', '.hg']);

function walk(dir, out) {
  let list;
  try { list = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) {
    warn(`cannot read folder ${dir}: ${e.code || e.message}`);
    return;
  }
  for (const d of list) {
    if (d.isSymbolicLink()) continue;
    const p = path.join(dir, d.name);
    if (d.isDirectory()) {
      if (!SKIP_DIRS.has(d.name)) walk(p, out);
    } else if (d.isFile() && /\.m3u8?$/i.test(d.name)) {
      out.push(p);
    }
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
function main() {
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
  say(`m3u-cleanup-offline${opt.dry ? ' (dry run: nothing will be changed)' : ''}`);
  say(`Found ${plural(unique.length, 'playlist file')}`);
  if (!unique.length) return;

  /* ---- parse and fix ---- */
  const playlists = [];
  const skipped = [];
  const failed = [];
  for (const file of unique) {
    try {
      const r = readPlaylist(file);
      if (r.skip) { skipped.push({ file, reason: r.skip }); continue; }
      const pl = parsePlaylist(file, r.text);
      if (pl.header === null && !pl.items.length) {
        skipped.push({ file, reason: 'no playlist content' });
        continue;
      }
      playlists.push(pl);
    } catch (e) {
      failed.push({ file, reason: e.message });
    }
  }
  const totalEntries = playlists.reduce((n, pl) => n + pl.entryCount, 0);
  say(`Read ${plural(playlists.length, 'file')} with ${totalEntries} entries${skipped.length ? `; skipped ${skipped.length}` : ''}`);

  /* ---- apply removals, URL repairs, dedupe, render ---- */
  const totals = {
    fixes: new Map(),
    removals: new Map(),
    files: 0,
    entriesBefore: totalEntries,
    entriesAfter: 0,
  };
  const changed = [];

  for (const pl of playlists) {
    const out = [];
    for (const it of pl.items) {
      if (it.kind === 'raw') { out.push(it); continue; }
      if (it.drop) {
        addTo(pl.removals, 'unparseable URL');
        pl.removed.push({
          line: it.urlLine,
          title: it.title,
          url: it.origUrl,
          reason: it.drop,
        });
        continue;
      }
      if (it.web) {
        it.web.fixes.forEach((f) => pl.bump(f));
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
        if (!slot.has(key)) {
          slot.set(key, kept.length);
          kept.push(it);
          continue;
        }
        const at = slot.get(key);
        const winner = entryScore(it) > entryScore(kept[at]) ? it : kept[at];
        const loser = winner === it ? kept[at] : it;
        kept[at] = winner;
        addTo(pl.removals, 'duplicate URL');
        pl.removed.push({
          line: loser.urlLine,
          title: loser.title,
          url: loser.origUrl,
          reason: `duplicate of ${winner.origUrl}`,
        });
      }
    }

    const lines = [];
    if (pl.header === null) pl.bump('#EXTM3U header added');
    lines.push(pl.header === null ? '#EXTM3U' : pl.header);
    for (const it of kept) {
      if (it.kind === 'raw') {
        lines.push(it.line);
      } else {
        lines.push(...it.pre);
        if (it.extinf !== null) lines.push(it.extinf);
        lines.push(...it.extra);
        lines.push(it.url);
      }
    }
    pl.entriesAfter = kept.filter((it) => it.kind === 'entry').length;
    pl.text = lines.join(pl.eol) + (pl.finalNewline ? pl.eol : '');
    pl.changed = pl.text !== pl.original;
    totals.entriesAfter += pl.entriesAfter;
    if (pl.changed) {
      changed.push(pl);
      pl.fixes.forEach((n, k) => addTo(totals.fixes, k, n));
      pl.removals.forEach((n, k) => addTo(totals.removals, k, n));
    }
  }

  /* ---- write ---- */
  if (!opt.dry) {
    for (const pl of changed) {
      try {
        writeFileSafely(pl.file, pl.text);
        totals.files++;
      } catch (e) {
        failed.push({ file: pl.file, reason: `could not write: ${e.message}` });
        pl.changed = false;
      }
    }
  } else {
    totals.files = changed.length;
  }

  /* ---- concise console summary ---- */
  const removedTotal = [...totals.removals.values()].reduce((a, b) => a + b, 0);
  const unrepaired = playlists.reduce((n, pl) => n + pl.unrepaired.length, 0);

  console.log('');
  console.log(`${opt.dry ? 'Would change' : 'Changed'} ${totals.files} of ${plural(playlists.length, 'file')}. Entries ${totals.entriesBefore} -> ${totals.entriesAfter}.`);
  console.log(`${removedTotal} ${removedTotal === 1 ? 'entry' : 'entries'} removed; ${plural(skipped.length, 'file')} skipped; ${plural(failed.length, 'failure')}.`);
  if (unrepaired) {
    console.log(`${plural(unrepaired, 'broken #EXTINF line')} left unrepaired.`);
  }

  /* Keep failure details visible even when the console summary is concise. */
  failed.forEach((s) => console.log(`  FAILED ${rel(s.file)}: ${s.reason}`));

  if (failed.length) process.exitCode = 1;
}

main();
