// m3u-logo-embedder.js
//
// Recursively scans the input folder for .m3u / .m3u8 files (any depth),
// looks up a logo for every station that does not have one yet, embeds it
// as tvg-logo="..." and writes the playlists to the output folder, keeping
// the exact same sub-folder structure:
//
//   input/rock/a.m3u        ->  output/rock/a.m3u
//   input/world/asia/b.m3u8 ->  output/world/asia/b.m3u8
//
// Stations that already have a tvg-logo / logo attribute are left alone.
// Stations without a logo are NOT removed (unlike m3u-checker.js): they are
// moved to the end of the playlist, in their original order. Set
// EXCLUDE_NO_LOGO=1 (or --exclude-no-logo) to drop them instead.
//
// Logo sources, tried in this order (same as the M3U Logo Embedder page).
// A candidate image is only accepted when it can really be downloaded, is a
// valid image, is big enough and is not extremely wide or tall:
//
//   radio     Radio Browser database (by stream URL, then by station name)
//   tunein    TuneIn station logos
//   wikidata  Wikidata logo property (by station name)
//   wikipedia Wikipedia article image, English
//   commons   Wikimedia Commons logo files
//   wikipedia-other  Wikipedia article images in 11 other languages
//   apple     Apple podcast / app artwork (slow: Apple limits requests)
//   search    Image search API (Brave or Serper.dev, needs an API key)
//   favicon   Website favicons: station homepage and stream host (last resort)
//
// Matching is strict on purpose: the station name must (nearly) match the
// name found at the source, so "Hip Hop FM" does not get the picture of the
// hip hop genre. Still, check the "<name>_logo_report.txt" file written next
// to every playlist: it lists where each logo came from and every station
// that got nothing.
//
// Hidden folders (starting with ".") and node_modules are skipped, and so is
// the output folder if it happens to live inside the input folder.
//
// Usage:
//
//   node m3u-logo-embedder.js
//   node m3u-logo-embedder.js input_folder/ output_folder/
//   node m3u-logo-embedder.js input_folder/ output_folder/ --quiet
//   node m3u-logo-embedder.js input_folder/ output_folder/ --exclude-no-logo
//   node m3u-logo-embedder.js input_folder/ output_folder/ --preview --no-report
//
// Options:
//
//   --quiet              only print the progress reports and one line per file
//   --exclude-no-logo    drop stations without a logo from the output
//   --preview            also write "<name>_logo_preview.html", a gallery that
//                        shows every logo next to its station (the page's
//                        "View Images" button)
//   --no-report          do not write the "<name>_logo_report.txt" files
//
// Optional environment variables:
//
//   CONCURRENCY=8            (max stations searched at the same time)
//   FILE_CONCURRENCY=5       (max playlists processed at the same time)
//   LINK_TIMEOUT=12000       (per request, in milliseconds)
//   RETRY=1                  (0 = never repeat a search after a failed lookup)
//   DEDUPE=1                 (0 = search again for every duplicate title)
//   EXCLUDE_NO_LOGO=0
//   SOURCES=radio,tunein,... (only use these sources; default: all)
//   SKIP_SOURCES=apple,...   (use all sources except these)
//   SEARCH_PROVIDER=brave    (brave | serper)
//   SEARCH_API_KEY=...       (enables the "search" source; the key is only
//                             sent to the selected provider. BRAVE_API_KEY
//                             and SERPER_API_KEY work too and pick the
//                             provider by themselves)
//   RADIO_BROWSER_HOSTS=...  (comma separated mirrors, default: de1, nl1, at1)
//   USER_AGENT=...           (sent to the lookup services. Wikimedia asks for
//                             a contact address: "name/1.0 (you@example.com)")
//   PROGRESS_INTERVAL=60000  (milliseconds between progress reports)
//
// Runtime limit (hard-coded for GitHub Actions 6h job limit):
//
//   MAX_RUNTIME_MS = 5h 45m
//   After this duration the script stops accepting new searches. Fully
//   processed playlists are removed from the input folder so a subsequent
//   run can resume with only the remaining files.
//
// Processing order:
//
//   Playlists are sorted by number of stations to search (smallest first).
//   Up to FILE_CONCURRENCY playlists run concurrently. Station titles that
//   appear in several playlists are searched only once for the whole run.
//
// Example:
//
//   CONCURRENCY=12 SKIP_SOURCES=apple SEARCH_API_KEY=xxxx node m3u-logo-embedder.js

const fs = require('fs/promises');
const path = require('path');

const concurrencyLimit = Number(process.env.CONCURRENCY || 8);
const fileConcurrency = Number(process.env.FILE_CONCURRENCY || 5);
const linkTimeout = Number(process.env.LINK_TIMEOUT || 12000);
const retryEnabled = process.env.RETRY !== '0';
const dedupeEnabled = process.env.DEDUPE !== '0';
const progressInterval = Number(process.env.PROGRESS_INTERVAL || 60000);

// Hard runtime limit for GitHub Actions (6h max). Stop accepting new work
// after 5h 45m so the job can finish cleanly and leave remaining files
// for a subsequent run.
const MAX_RUNTIME_MS = (5 * 60 + 45) * 60 * 1000; // 5h 45m

const USER_AGENT =
  process.env.USER_AGENT || 'm3u-logo-embedder/1.0 (+https://github.com/junguler)';
const IMAGE_USER_AGENT = 'Mozilla/5.0 (compatible; m3u-logo-embedder/1.0)';
const MAX_IMAGE_BYTES = 524288;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Set to true when MAX_RUNTIME_MS is reached; workers stop taking new work. */
let timeUp = false;

/**
 * Global statistics used by the periodic progress report.
 */
const stats = {
  startTime: Date.now(),
  totalFiles: 0,
  filesParsed: 0,
  filesDone: 0,
  totalLinks: 0, // stations that need a search
  checked: 0,
  found: 0,
  notFound: 0,
  inFlight: 0,
  bySource: new Map(), // label -> logos found
  // fileName -> { total, checked, found }
  activeFiles: new Map(),
};

/**
 * Formats milliseconds as e.g. "1h 02m 05s", "3m 07s" or "12s".
 * @param {number} ms
 * @returns {string}
 */
function formatDuration(ms) {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}h ${String(minutes).padStart(2, '0')}m ${String(seconds).padStart(2, '0')}s`;
  }
  if (minutes > 0) {
    return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
  }
  return `${seconds}s`;
}

/**
 * Prints one progress report.
 * @param {boolean} final - true for the closing summary
 */
function printProgress(final = false) {
  const elapsedMs = Date.now() - stats.startTime;
  const elapsedSeconds = elapsedMs / 1000;
  const percent =
    stats.totalLinks > 0 ? ((stats.checked / stats.totalLinks) * 100).toFixed(1) : '0.0';
  const rate = elapsedSeconds > 0 ? stats.checked / elapsedSeconds : 0;

  let eta = 'estimating...';
  if (stats.totalLinks > 0 && rate > 0) {
    const remaining = stats.totalLinks - stats.checked;
    eta = remaining > 0 ? formatDuration((remaining / rate) * 1000) : '0s';
  }

  const label = final ? 'FINAL' : 'PROGRESS';
  const lines = [
    '',
    `[${label}] Elapsed: ${formatDuration(elapsedMs)}`,
    `[${label}] Files: ${stats.filesDone}/${stats.totalFiles} done (${stats.filesParsed}/${stats.totalFiles} read)`,
    `[${label}] Stations: ${stats.checked}/${stats.totalLinks} searched (${percent}%), ${stats.inFlight} in flight`,
    `[${label}] Results: ${stats.found} logos found, ${stats.notFound} without a logo`,
  ];

  if (stats.bySource.size > 0) {
    const sources = [...stats.bySource.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([name, n]) => `${name} ${n}`)
      .join(', ');
    lines.push(`[${label}] By source: ${sources}`);
  }

  if (!final) {
    lines.push(`[${label}] Speed: ${rate.toFixed(2)} stations/s, ETA: ${eta}`);
    if (stats.activeFiles.size > 0) {
      const active = [...stats.activeFiles.entries()]
        .sort((a, b) => b[1].total - b[1].checked - (a[1].total - a[1].checked))
        .slice(0, 5);
      lines.push(
        `[${label}] Busiest unfinished files (${stats.activeFiles.size} in progress):`,
      );
      for (const [name, info] of active) {
        lines.push(
          `[${label}] ${name}: ${info.checked}/${info.total} searched, ${info.found} logos found`,
        );
      }
    }
  } else {
    lines.push(`[${label}] Average speed: ${rate.toFixed(2)} stations/s`);
    const dead = Object.entries(sourceHealth)
      .filter(([name]) => sourceDead(name))
      .map(([name]) => name);
    if (dead.length) {
      lines.push(
        `[${label}] WARNING: could not connect to: ${dead.join(', ')} (skipped after repeated failures)`,
      );
    }
    if (searchApiError) {
      lines.push(`[${label}] WARNING: image search API error: ${searchApiError}`);
    }
  }
  console.log(lines.join('\n'));
}

/**
 * Creates a global concurrency limiter.
 * This limiter is shared across all files, so processing multiple files
 * concurrently cannot search for more than concurrencyLimit stations at once.
 * @param {number} limit
 * @returns {(task: () => Promise<any>) => Promise<any>}
 */
function createLimiter(limit) {
  const queue = [];
  let active = 0;

  function runNext() {
    while (active < limit && queue.length > 0) {
      const { task, resolve, reject } = queue.shift();
      active++;
      Promise.resolve()
        .then(task)
        .then(resolve, reject)
        .finally(() => {
          active--;
          runNext();
        });
    }
  }

  return function limitTask(task) {
    return new Promise((resolve, reject) => {
      queue.push({ task, resolve, reject });
      runNext();
    });
  };
}

/* ============================================================
 SETTINGS
 ============================================================ */

const ALL_SOURCES = [
  'radio',
  'tunein',
  'wikidata',
  'wikipedia',
  'commons',
  'wikipedia-other',
  'apple',
  'search',
  'favicon',
];

/**
 * Reads the SOURCES / SKIP_SOURCES environment variables.
 * @returns {Set<string>} enabled source names
 */
function readEnabledSources() {
  const list = (value) =>
    String(value || '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);

  const only = list(process.env.SOURCES);
  const skip = new Set(list(process.env.SKIP_SOURCES));
  const enabled = new Set((only.length ? only : ALL_SOURCES).filter((s) => !skip.has(s)));

  for (const name of [...only, ...skip]) {
    if (!ALL_SOURCES.includes(name)) {
      console.warn(`Unknown source "${name}" in SOURCES / SKIP_SOURCES (valid: ${ALL_SOURCES.join(', ')})`);
    }
  }
  return enabled;
}

const enabledSources = readEnabledSources();

const searchProvider = (
  process.env.SEARCH_PROVIDER ||
  (process.env.SERPER_API_KEY && !process.env.BRAVE_API_KEY ? 'serper' : 'brave')
).toLowerCase();
const searchKey = (
  process.env.SEARCH_API_KEY ||
  (searchProvider === 'serper' ? process.env.SERPER_API_KEY : process.env.BRAVE_API_KEY) ||
  ''
).trim();

const RB_HOSTS = (process.env.RADIO_BROWSER_HOSTS || '')
  .split(',')
  .map((h) => h.trim().replace(/\/+$/, ''))
  .filter(Boolean);
if (!RB_HOSTS.length) {
  RB_HOSTS.push(
    'https://de1.api.radio-browser.info',
    'https://nl1.api.radio-browser.info',
    'https://at1.api.radio-browser.info',
  );
}

const WIKI_LANGS = ['de', 'fr', 'es', 'it', 'pt', 'ru', 'tr', 'nl', 'pl', 'ar', 'fa'];

/* ============================================================
 M3U PARSING
 An entry is everything that belongs to one stream: its #EXTINF
 line, any extra #-lines (#EXTGRP, #EXTVLCOPT...) and the URL.
 ============================================================ */

/**
 * Splits an #EXTINF line at the first comma that is not inside quotes.
 * @param {string} line
 * @returns {{prefix: string, title: string}}
 */
function splitExtinf(line) {
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];

    if (ch === '"') {
      inQuotes = !inQuotes;
    } else if (ch === ',' && !inQuotes) {
      return { prefix: line.slice(0, i), title: line.slice(i + 1).trim() };
    }
  }
  return { prefix: line, title: '' };
}

/**
 * Parses M3U content into a header and a list of entries.
 * @param {string} text
 * @returns {{extm3u: string, header: string[], entries: Array<object>}}
 */
function parseM3U(text) {
  const lines = text
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .map((l) => l.trim());

  let extm3u = '#EXTM3U';
  let sawEntryOrHeader = false;

  const header = [];
  const entries = [];

  let pendingExtinf = null;
  let pendingExtra = [];

  const flush = (url) => {
    entries.push({ extinf: pendingExtinf, extra: pendingExtra, url });
    pendingExtinf = null;
    pendingExtra = [];
  };

  for (const line of lines) {
    if (line === '') {
      continue;
    }

    if (/^#EXTM3U/i.test(line)) {
      // Keep attributes such as url-tvg="..." from the first header line.
      if (!sawEntryOrHeader) {
        extm3u = line;
      }
      continue;
    }

    sawEntryOrHeader = true;

    if (/^#EXTINF/i.test(line)) {
      if (pendingExtinf) {
        flush(null); // EXTINF without a URL: keep it, do not lose it.
      }
      pendingExtinf = line;
      continue;
    }

    if (line.startsWith('#')) {
      if (!entries.length && !pendingExtinf) {
        header.push(line);
      } else {
        pendingExtra.push(line);
      }
      continue;
    }

    flush(line);
  }

  if (pendingExtinf) {
    flush(null);
  }

  entries.forEach((entry) => {
    entry.title = entry.extinf ? splitExtinf(entry.extinf).title : '';
    entry.existingLogo = entry.extinf ? getExistingLogo(splitExtinf(entry.extinf).prefix) : '';
    entry.hasLogo = !!entry.existingLogo;
  });

  return { extm3u, header, entries };
}

/**
 * The lines of one entry, optionally with a replacement #EXTINF.
 * @param {object} entry
 * @param {string|null} extinfOverride
 * @returns {string[]}
 */
function renderEntry(entry, extinfOverride) {
  const out = [];

  if (entry.extinf) {
    out.push(extinfOverride || entry.extinf);
  }
  out.push(...entry.extra);
  if (entry.url) {
    out.push(entry.url);
  }
  return out;
}

/**
 * @param {string} prefix - the #EXTINF line before the title comma
 * @returns {string} the existing logo URL, or ''
 */
function getExistingLogo(prefix) {
  const m = prefix.match(/\b(?:tvg-logo|logo)\s*=\s*"([^"]*)"/i);
  return m ? m[1].trim() : '';
}

/**
 * Sets tvg-logo on an #EXTINF line (replacing an empty one if present).
 * @param {string} extinfLine
 * @param {string} logoUrl
 * @returns {string}
 */
function applyLogo(extinfLine, logoUrl) {
  const { prefix, title } = splitExtinf(extinfLine);
  const safeUrl = String(logoUrl).replace(/"/g, '%22').replace(/\s/g, '%20');

  let newPrefix;
  if (/\btvg-logo\s*=\s*"[^"]*"/i.test(prefix)) {
    newPrefix = prefix.replace(/\btvg-logo\s*=\s*"[^"]*"/i, `tvg-logo="${safeUrl}"`);
  } else {
    newPrefix = `${prefix} tvg-logo="${safeUrl}"`;
  }
  return `${newPrefix},${title}`;
}

/* ============================================================
 TITLE HELPERS
 ============================================================ */

const STOP_WORDS = new Set([
  'radio', 'fm', 'am', 'the', 'online', 'live', 'stream', 'streaming', 'hd', 'mp3',
  'aac', 'ogg', 'opus', 'flac', 'kb', 'kbps', 'official', 'and', 'of', 'de', 'la', 'le', 'el',
]);

/**
 * Removes format / bitrate suffixes and [tags] from a station title.
 * @param {string} raw
 * @returns {string}
 */
function cleanTitle(raw) {
  let t = String(raw || '');
  t = t.replace(/\s+-\s+(?:mp3|aac|ogg|opus|wav|flac|webm|ts|m3u8|m4a)(?:\s+-\s+\d+kb)?$/i, '');
  t = t.replace(/\s+-\s+\d+kb$/i, '');
  t = t.replace(/\[[^\]]*\]/g, ' ');
  t = t.replace(/\s+\d{2,3}\s?k(?:bps|b)?\b/i, ' ');
  return t.replace(/\s+/g, ' ').trim();
}

function normalizeText(s) {
  return String(s || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9\u0400-\u04ff\u0600-\u06ff\u4e00-\u9fff]+/g, ' ')
    .trim();
}

function tokenSet(s) {
  const all = normalizeText(s).split(' ').filter(Boolean);
  const meaningful = all.filter((w) => !STOP_WORDS.has(w));
  return new Set(meaningful.length ? meaningful : all);
}

/**
 * Word overlap between two names, 0..1.
 */
function similarity(a, b) {
  const A = tokenSet(a);
  const B = tokenSet(b);

  if (!A.size || !B.size) {
    return 0;
  }

  let inter = 0;
  A.forEach((w) => {
    if (B.has(w)) inter++;
  });

  const jaccard = inter / (A.size + B.size - inter);

  // Every word of the playlist title appears in the candidate name
  // (e.g. "Jazz FM" vs "Jazz FM London") is a strong match as long as the
  // title has at least two meaningful words.
  if (inter === A.size && A.size >= 2) {
    return Math.max(jaccard, 0.8);
  }
  return jaccard;
}

/**
 * Share of the playlist title's words that the candidate name also contains.
 */
function coverage(a, b) {
  const A = tokenSet(a);
  const B = tokenSet(b);

  if (!A.size) {
    return 0;
  }

  let inter = 0;
  A.forEach((w) => {
    if (B.has(w)) inter++;
  });
  return inter / A.size;
}

/** Short descriptions that say "this is a radio station" in the main languages. */
const RADIO_DESC = new RegExp(
  'radio|radyo|r\u00e1dio|\u0440\u0430\u0434\u0438\u043e|\u03c1\u03b1\u03b4\u03b9\u03bf|' +
    '\u0631\u0627\u062f\u064a\u0648|\u0631\u0627\u062f\u06cc\u0648|\u0625\u0630\u0627\u0639\u0629|' +
    'broadcast|station|sender|emisora|\u00e9metteur|stazione|zender|stacja|' +
    'rozg\u0142o|rundfunk|h\u00f6rfunk|network|channel|cha\u00eene|\\bfm\\b',
  'i',
);

/* ============================================================
 IMAGE CHECKING
 No image library: the size of an image is read straight from the
 first bytes of the file (PNG, JPEG, GIF, WebP, ICO, BMP, SVG).
 ============================================================ */

/**
 * Reads the pixel size of an image from its (possibly partial) bytes.
 * @param {Buffer} buf
 * @returns {{w: number, h: number}|'more'|null}
 *   dimensions; 'more' when more bytes are needed; null when it is not an image
 */
function imageSize(buf) {
  if (buf.length < 4) return 'more';

  // PNG
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return buf.length >= 24 ? { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) } : 'more';
  }

  // GIF
  if (buf.toString('latin1', 0, 3) === 'GIF') {
    return buf.length >= 10 ? { w: buf.readUInt16LE(6), h: buf.readUInt16LE(8) } : 'more';
  }

  // JPEG
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i + 4 <= buf.length) {
      if (buf[i] !== 0xff) {
        i++;
        continue;
      }
      const marker = buf[i + 1];
      if (marker === 0xff) {
        i++;
        continue;
      }
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        i += 2;
        continue;
      }
      const isSof = marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker);
      if (isSof) {
        return i + 9 <= buf.length ? { w: buf.readUInt16BE(i + 7), h: buf.readUInt16BE(i + 5) } : 'more';
      }
      if (marker === 0xda) return null; // image data before any size: broken
      i += 2 + buf.readUInt16BE(i + 2);
    }
    return 'more';
  }

  // WebP
  if (buf.toString('latin1', 0, 4) === 'RIFF' && buf.length >= 16 && buf.toString('latin1', 8, 12) === 'WEBP') {
    const kind = buf.toString('latin1', 12, 16);
    if (kind === 'VP8 ') return buf.length >= 30 ? { w: buf.readUInt16LE(26) & 0x3fff, h: buf.readUInt16LE(28) & 0x3fff } : 'more';
    if (kind === 'VP8L') {
      if (buf.length < 25) return 'more';
      const bits = buf.readUInt32LE(21);
      return { w: (bits & 0x3fff) + 1, h: ((bits >> 14) & 0x3fff) + 1 };
    }
    if (kind === 'VP8X') return buf.length >= 30 ? { w: 1 + buf.readUIntLE(24, 3), h: 1 + buf.readUIntLE(27, 3) } : 'more';
    return null;
  }

  // ICO (the largest icon inside)
  if (buf[0] === 0 && buf[1] === 0 && buf[2] === 1 && buf[3] === 0) {
    const count = buf.length >= 6 ? buf.readUInt16LE(4) : 0;
    if (!count || count > 64) return null;
    if (buf.length < 6 + count * 16) return 'more';
    let best = { w: 0, h: 0 };
    for (let n = 0; n < count; n++) {
      const w = buf[6 + n * 16] || 256;
      const h = buf[7 + n * 16] || 256;
      if (w * h > best.w * best.h) best = { w, h };
    }
    return best;
  }

  // BMP
  if (buf[0] === 0x42 && buf[1] === 0x4d) {
    return buf.length >= 26 ? { w: Math.abs(buf.readInt32LE(18)), h: Math.abs(buf.readInt32LE(22)) } : 'more';
  }

  // SVG
  const head = buf.toString('utf8', 0, Math.min(buf.length, 4096)).replace(/^\uFEFF/, '').trimStart();
  if (head.startsWith('<')) {
    const tag = head.match(/<svg\b[^>]*>/i);
    if (!tag) return head.length >= 1024 || buf.length >= 4096 ? null : 'more';
    const num = (name) => {
      const m = tag[0].match(new RegExp(`\\b${name}\\s*=\\s*["']\\s*([\\d.]+)\\s*(?:px)?\\s*["']`, 'i'));
      return m ? parseFloat(m[1]) : 0;
    };
    let w = num('width');
    let h = num('height');
    if (!w || !h) {
      const vb = tag[0].match(/\bviewBox\s*=\s*["']\s*[-\d.]+[ ,]+[-\d.]+[ ,]+([\d.]+)[ ,]+([\d.]+)/i);
      if (vb) {
        w = parseFloat(vb[1]);
        h = parseFloat(vb[2]);
      }
    }
    return w && h ? { w, h } : { w: 256, h: 256 };
  }

  return null;
}

/** "<minSize>|<url>" -> Promise<boolean> (loadable and big enough) */
const imageCheckCache = new Map();

/**
 * Downloads just enough of an image to read its size.
 * @param {string} url
 * @returns {Promise<{w: number, h: number}|null>}
 */
async function fetchImageInfo(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), linkTimeout);
  let response;
  let reader = null;

  try {
    response = await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: { 'User-Agent': IMAGE_USER_AGENT, Accept: 'image/*,*/*;q=0.8' },
    });

    if (!response.ok || !response.body) {
      return null;
    }

    const type = (response.headers.get('content-type') || '').toLowerCase();
    if (/^text\/(html|plain|css|javascript)/.test(type) || type.startsWith('application/json')) {
      return null;
    }

    reader = response.body.getReader();
    let buf = Buffer.alloc(0);

    while (buf.length < MAX_IMAGE_BYTES) {
      const { done, value } = await reader.read();
      if (done || !value) break;
      buf = Buffer.concat([buf, value]);

      const size = imageSize(buf);
      if (size === null) return null;
      if (size !== 'more') return size;
    }

    const last = imageSize(buf);
    return last && last !== 'more' ? last : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    // The body must be cancelled to release the TCP socket, otherwise open
    // sockets keep the Node.js event loop alive after all work is done.
    try {
      await reader?.cancel();
    } catch {
      // Ignore errors if the reader was already closed.
    }
    try {
      await response?.body?.cancel();
    } catch {
      // Ignore errors if the body was already consumed or canceled.
    }
    controller.abort();
  }
}

/**
 * True when the URL is a downloadable image that is big enough and not
 * extremely wide or tall.
 * @param {string} url
 * @param {number} minSize - smallest allowed side in px
 * @returns {Promise<boolean>}
 */
function isUsableLogo(url, minSize) {
  if (!/^https?:\/\//i.test(url)) {
    return Promise.resolve(false);
  }

  const key = `${minSize}|${url}`;
  if (!imageCheckCache.has(key)) {
    imageCheckCache.set(
      key,
      fetchImageInfo(url).then((info) => {
        if (!info || !(info.w > 0) || !(info.h > 0)) return false;
        const ratio = info.w / info.h;
        return Math.min(info.w, info.h) >= minSize && ratio >= 0.33 && ratio <= 3;
      }),
    );
  }
  return imageCheckCache.get(key);
}

/* ============================================================
 NETWORK HELPERS
 ============================================================ */

/** per source: how often it worked / failed to even connect */
const sourceHealth = {};

/** Set once when the image search API answers with an error. */
let searchApiError = null;

function noteSource(name, ok) {
  const h = sourceHealth[name] || (sourceHealth[name] = { ok: 0, fails: 0 });
  if (ok) h.ok++;
  else h.fails++;
}

/** A source that never connected after a few tries is skipped for the rest of the run. */
function sourceDead(name) {
  const h = sourceHealth[name];
  return !!h && h.ok === 0 && h.fails >= 3;
}

/**
 * GET with a timeout; returns the body as text.
 * @param {string} url
 * @param {object} [opts] - fetch options
 * @returns {Promise<string>}
 */
async function fetchText(url, opts = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), linkTimeout);

  try {
    const response = await fetch(url, {
      ...opts,
      signal: controller.signal,
      redirect: 'follow',
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json', ...(opts.headers || {}) },
    });

    if (!response.ok) {
      const error = new Error(`HTTP ${response.status}`);
      error.status = response.status;
      throw error;
    }
    return await response.text();
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

/**
 * Fetches and parses JSON, keeping track of whether the source is reachable.
 * @param {string} name - source name for the health tracking
 * @param {string} url
 * @param {{hadError: boolean}} ctx
 * @returns {Promise<any|null>}
 */
async function getJson(name, url, ctx) {
  if (sourceDead(name)) {
    return null;
  }

  try {
    const data = JSON.parse(await fetchText(url));
    noteSource(name, true);
    return data;
  } catch (e) {
    if (e.name === 'AbortError') {
      if (!timeUp) ctx.hadError = true;
      return null;
    }
    if (e instanceof TypeError) {
      // Could not connect (offline, blocked, DNS).
      noteSource(name, false);
      if (!sourceDead(name)) ctx.hadError = true;
      return null;
    }
    ctx.hadError = true;
    return null;
  }
}

/* ============================================================
 LOGO SOURCES
 Each source returns an array of candidate image URLs.
 ============================================================ */

function httpsFirst(url) {
  if (/^http:\/\//i.test(url)) {
    return [url.replace(/^http:\/\//i, 'https://'), url];
  }
  return [url];
}

function urlVariants(u) {
  const variants = [u];

  if (/^https:\/\//i.test(u)) {
    variants.push(u.replace(/^https:/i, 'http:'));
  } else if (/^http:\/\//i.test(u)) {
    variants.push(u.replace(/^http:/i, 'https:'));
  }
  return variants;
}

/** radio-browser answers by request path (also read by the favicon source) */
const rbCache = new Map();
let rbHost = null;
let rbDeadUntil = 0;

const rbUrlPath = (v) => `/json/stations/byurl?url=${encodeURIComponent(v)}`;
const rbNamePath = (title) =>
  `/json/stations/search?name=${encodeURIComponent(title)}&limit=12&hidebroken=true&order=votes&reverse=true`;

/**
 * Asks radio-browser, trying its mirrors one after another.
 * @param {string} requestPath
 * @param {{hadError: boolean}} ctx
 * @returns {Promise<any[]>}
 */
async function rbGet(requestPath, ctx) {
  if (rbCache.has(requestPath)) {
    return rbCache.get(requestPath);
  }

  if (Date.now() < rbDeadUntil) {
    ctx.hadError = true;
    return [];
  }

  const hosts = rbHost ? [rbHost, ...RB_HOSTS.filter((h) => h !== rbHost)] : RB_HOSTS;

  for (const host of hosts) {
    if (timeUp) {
      return [];
    }

    try {
      const parsed = JSON.parse(await fetchText(host + requestPath));
      rbHost = host;
      rbCache.set(requestPath, parsed);
      return parsed;
    } catch {
      // try the next mirror
    }
  }

  // Every mirror failed: stop hammering them for a bit.
  rbDeadUntil = Date.now() + 30000;
  ctx.hadError = true;
  return [];
}

async function candidatesRadioByUrl(entry, ctx) {
  for (const v of urlVariants(entry.url)) {
    const list = await rbGet(rbUrlPath(v), ctx);

    const favicons = (Array.isArray(list) ? list : [])
      .map((s) => (s.favicon || '').trim())
      .filter(Boolean);

    if (favicons.length) {
      return favicons.flatMap(httpsFirst);
    }
    if (timeUp) {
      return [];
    }
  }
  return [];
}

async function candidatesRadioByName(title, ctx) {
  const list = await rbGet(rbNamePath(title), ctx);

  return (Array.isArray(list) ? list : [])
    .filter((s) => (s.favicon || '').trim())
    .map((s) => ({
      favicon: s.favicon.trim(),
      score: similarity(title, cleanTitle(s.name)),
      votes: s.votes || 0,
    }))
    .filter((s) => s.score >= 0.6)
    .sort((a, b) => b.score - a.score || b.votes - a.votes)
    .slice(0, 4)
    .flatMap((s) => httpsFirst(s.favicon));
}

async function candidatesWikipedia(title, ctx, lang = 'en') {
  const query = lang === 'en' ? `${title} radio` : title;

  const url =
    `https://${lang}.wikipedia.org/w/api.php?action=query&format=json` +
    '&generator=search&gsrlimit=5' +
    `&gsrsearch=${encodeURIComponent(query)}` +
    '&prop=pageimages|description&piprop=thumbnail&pithumbsize=300&pilicense=any';

  const data = await getJson(`wikipedia-${lang}`, url, ctx);
  const pages = data && data.query && data.query.pages ? Object.values(data.query.pages) : [];

  return pages
    .filter((p) => p.thumbnail && p.thumbnail.source)
    .map((p) => {
      const name = String(p.title || '').replace(/\s*\([^)]*\)\s*/g, ' ');
      const desc = String(p.description || '');
      const score = similarity(title, name);

      // Every word of the station name must be in the article title, and the
      // article must be about a radio station. Without a description the
      // article title itself has to say radio, FM, etc. This stops
      // "... Hip Hop FM" from getting the picture of the hip hop genre.
      const ok =
        score >= 0.6 &&
        coverage(title, name) >= 0.8 &&
        (desc ? RADIO_DESC.test(desc) : RADIO_DESC.test(String(p.title || '')));

      return { src: p.thumbnail.source, score: ok ? score : 0, index: p.index || 99 };
    })
    .filter((p) => p.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, 3)
    .map((p) => p.src);
}

async function candidatesWikipediaOther(title, ctx) {
  const out = [];

  for (const lang of WIKI_LANGS) {
    if (timeUp) break;
    out.push(...(await candidatesWikipedia(title, ctx, lang)));
    if (out.length >= 3) break;
  }
  return out;
}

async function candidatesWikidata(title, ctx) {
  const search = await getJson(
    'wikidata',
    'https://www.wikidata.org/w/api.php?action=wbsearchentities&format=json' +
      '&language=en&uselang=en&type=item&limit=6' +
      `&search=${encodeURIComponent(title)}`,
    ctx,
  );

  const hits = ((search && search.search) || [])
    .map((h) => ({
      id: h.id,
      score: similarity(title, h.label || ''),
      cover: coverage(title, h.label || ''),
    }))
    .filter((h) => h.id && h.score >= 0.6 && h.cover >= 0.8)
    .sort((a, b) => b.score - a.score)
    .slice(0, 4);

  if (!hits.length) {
    return [];
  }

  const ids = hits.map((h) => h.id);

  const data = await getJson(
    'wikidata',
    `https://www.wikidata.org/w/api.php?action=wbgetentities&format=json&props=claims&ids=${ids.join('|')}`,
    ctx,
  );

  const out = [];

  ids.forEach((id) => {
    const claims = data && data.entities && data.entities[id] ? data.entities[id].claims : null;
    if (!claims) return;

    // P154 = logo image, P8972 = small logo or icon
    ['P154', 'P8972'].forEach((prop) => {
      (claims[prop] || []).forEach((c) => {
        const v = c.mainsnak && c.mainsnak.datavalue && c.mainsnak.datavalue.value;
        if (typeof v === 'string') {
          out.push(
            `https://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(v)}?width=400`,
          );
        }
      });
    });
  });
  return out;
}

async function candidatesCommons(title, ctx) {
  const data = await getJson(
    'commons',
    'https://commons.wikimedia.org/w/api.php?action=query&format=json' +
      '&generator=search&gsrnamespace=6&gsrlimit=10' +
      `&gsrsearch=${encodeURIComponent(`${title} logo`)}` +
      '&prop=imageinfo&iiprop=url|mime&iiurlwidth=400',
    ctx,
  );

  const pages = data && data.query && data.query.pages ? Object.values(data.query.pages) : [];

  return pages
    .map((p) => {
      const info = p.imageinfo && p.imageinfo[0];
      if (!info || !/^image\//.test(info.mime || '')) {
        return null;
      }

      const file = String(p.title || '')
        .replace(/^File:/i, '')
        .replace(/\.[a-z0-9]+$/i, '');

      const hasLogoWord = /logo|logotype|emblem|icon|brand/i.test(file);

      const name = file
        .replace(/\b(logo|logotype|emblem|icon|brand|svg|png|jpe?g)\b/gi, ' ')
        .replace(/[_\d]+/g, ' ');

      const score = similarity(title, name);

      if (score < 0.6 || coverage(title, name) < 0.8 || (!hasLogoWord && score < 0.8)) {
        return null;
      }
      return { src: info.thumburl || info.url, score, index: p.index || 99 };
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, 4)
    .map((p) => p.src);
}

async function candidatesTuneIn(title, ctx) {
  const data = await getJson(
    'tunein',
    `https://opml.radiotime.com/Search.ashx?render=json&query=${encodeURIComponent(title)}`,
    ctx,
  );

  const items = [];
  const walk = (nodes) =>
    (nodes || []).forEach((n) => {
      if (n && n.children) {
        walk(n.children);
      } else if (n) {
        items.push(n);
      }
    });
  walk(data && data.body);

  return items
    .filter((n) => n.image && n.text)
    .map((n) => {
      const name = cleanTitle(n.text).replace(/\s*\([^)]*\)\s*/g, ' ');
      return { src: n.image, score: similarity(title, name), cover: coverage(title, name) };
    })
    .filter((n) => n.score >= 0.6 && n.cover >= 0.8)
    .sort((a, b) => b.score - a.score)
    .slice(0, 4)
    .flatMap((n) => httpsFirst(n.src));
}

/** Apple allows about 20 requests a minute: next free slot */
let appleNextAt = 0;

async function appleQuery(media, title, ctx) {
  // Wait for our turn.
  const slot = Math.max(Date.now(), appleNextAt);
  appleNextAt = slot + 3200;

  let left = slot - Date.now();
  while (left > 0 && !timeUp) {
    await sleep(Math.min(left, 250));
    left = slot - Date.now();
  }
  if (timeUp) {
    return [];
  }

  const data = await getJson(
    'apple',
    `https://itunes.apple.com/search?limit=15&media=${media}&entity=${media}&term=${encodeURIComponent(title)}`,
    ctx,
  );

  return ((data && data.results) || [])
    .map((r) => {
      const art = r.artworkUrl600 || r.artworkUrl512 || r.artworkUrl100 || '';
      return {
        src: art.replace(/\/\d+x\d+(bb|sr)?\.(jpg|png)$/i, '/600x600bb.$2'),
        score: Math.max(
          similarity(title, cleanTitle(r.collectionName || '')),
          similarity(title, cleanTitle(r.trackName || '')),
        ),
        cover: Math.max(
          coverage(title, cleanTitle(r.collectionName || '')),
          coverage(title, cleanTitle(r.trackName || '')),
        ),
      };
    })
    .filter((r) => r.src && r.score >= 0.7 && r.cover >= 0.8)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .map((r) => r.src);
}

async function candidatesApple(title, ctx) {
  if (sourceDead('apple')) {
    return [];
  }

  const podcasts = await appleQuery('podcast', title, ctx);
  if (podcasts.length || sourceDead('apple')) {
    return podcasts;
  }
  return appleQuery('software', title, ctx);
}

async function candidatesImageSearch(title, ctx) {
  if (!searchKey) {
    return [];
  }

  const query = `"${title}" radio logo`;
  let url;
  let opts;

  if (searchProvider === 'serper') {
    url = 'https://google.serper.dev/images';
    opts = {
      method: 'POST',
      headers: { 'X-API-KEY': searchKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ q: query, num: 10 }),
    };
  } else {
    url =
      `https://api.search.brave.com/res/v1/images/search?q=${encodeURIComponent(query)}` +
      '&count=10&safesearch=off';
    opts = { headers: { Accept: 'application/json', 'X-Subscription-Token': searchKey } };
  }

  let data;
  try {
    data = JSON.parse(await fetchText(url, opts));
  } catch (e) {
    ctx.hadError = true;
    if (e.name !== 'AbortError' && !searchApiError) {
      searchApiError = e.message;
    }
    return [];
  }

  const urls = [];

  if (searchProvider === 'serper') {
    (data.images || []).forEach((r) => {
      if (r.imageUrl) urls.push(r.imageUrl);
      if (r.thumbnailUrl) urls.push(r.thumbnailUrl);
    });
  } else {
    (data.results || []).forEach((r) => {
      if (r.properties && r.properties.url) urls.push(r.properties.url);
      if (r.thumbnail && r.thumbnail.src) urls.push(r.thumbnail.src);
    });
  }
  return urls.slice(0, 12);
}

function validHost(h) {
  return (
    !!h &&
    h !== 'localhost' &&
    h.includes('.') &&
    !h.includes(':') &&
    !/^\d{1,3}(\.\d{1,3}){3}$/.test(h)
  );
}

function parentDomain(host) {
  const parts = host.split('.');

  if (parts.length <= 2) {
    return host;
  }

  const last = parts[parts.length - 1];
  const second = parts[parts.length - 2];
  const keep =
    last.length === 2 && ['co', 'com', 'org', 'net', 'gov', 'edu', 'ac'].includes(second) ? 3 : 2;

  return parts.slice(-keep).join('.');
}

function faviconUrlsForHost(host) {
  return [
    `https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=256`,
    `https://${host}/apple-touch-icon.png`,
    `https://${host}/favicon.ico`,
  ];
}

async function candidatesWebsiteFavicons(entry, title) {
  const hosts = [];

  const add = (u) => {
    try {
      const h = new URL(u).hostname.toLowerCase();
      if (validHost(h) && !hosts.includes(h)) {
        hosts.push(h);
      }
    } catch {
      // not a usable URL
    }
  };

  // Station homepages that radio-browser already told us about.
  if (enabledSources.has('radio')) {
    urlVariants(entry.url).forEach((v) => {
      const list = rbCache.get(rbUrlPath(v));
      (Array.isArray(list) ? list : []).forEach((st) => add(st.homepage));
    });

    const named = rbCache.get(rbNamePath(title));
    (Array.isArray(named) ? named : [])
      .filter((st) => similarity(title, cleanTitle(st.name)) >= 0.6)
      .forEach((st) => add(st.homepage));
  }

  add(entry.url);

  try {
    const h = new URL(entry.url).hostname.toLowerCase();
    if (validHost(h)) {
      add(`https://${parentDomain(h)}`);
    }
  } catch {
    // ignore
  }

  return hosts.slice(0, 5).flatMap(faviconUrlsForHost);
}

/* ============================================================
 FIND ONE LOGO
 ============================================================ */

/**
 * Asks one source for candidates and returns the first usable image.
 * @returns {Promise<{logo: string, source: string}|null>}
 */
async function trySource(label, getCandidates, minSize, ctx, parallel = 1) {
  if (timeUp) {
    return null;
  }

  let candidates;
  try {
    candidates = await getCandidates();
  } catch {
    ctx.hadError = true;
    return null;
  }

  const unique = [...new Set(candidates.filter(Boolean))];

  for (let i = 0; i < unique.length; i += parallel) {
    if (timeUp) {
      return null;
    }

    const chunk = unique.slice(i, i + parallel);
    const oks = await Promise.all(chunk.map((u) => isUsableLogo(u, minSize)));
    const k = oks.indexOf(true);

    if (k >= 0) {
      return { logo: chunk[k], source: label };
    }
  }
  return null;
}

/**
 * The order sources are tried in. `minSize` is the smallest side (px) an
 * image must have; `key` is the SOURCES name; `health` names the health
 * entry that marks the source as unreachable.
 */
const LOGO_SOURCES = [
  {
    key: 'radio',
    label: 'radio-browser (stream url)',
    candidates: (entry, title, ctx) => candidatesRadioByUrl(entry, ctx),
    minSize: 40,
  },
  {
    key: 'radio',
    label: 'radio-browser (name)',
    candidates: (entry, title, ctx) => candidatesRadioByName(title, ctx),
    minSize: 40,
  },
  {
    key: 'tunein',
    label: 'tunein',
    health: 'tunein',
    candidates: (entry, title, ctx) => candidatesTuneIn(title, ctx),
    minSize: 64,
  },
  {
    key: 'wikidata',
    label: 'wikidata',
    health: 'wikidata',
    candidates: (entry, title, ctx) => candidatesWikidata(title, ctx),
    minSize: 48,
  },
  {
    key: 'wikipedia',
    label: 'wikipedia',
    candidates: (entry, title, ctx) => candidatesWikipedia(title, ctx),
    minSize: 48,
  },
  {
    key: 'commons',
    label: 'wikimedia commons',
    health: 'commons',
    candidates: (entry, title, ctx) => candidatesCommons(title, ctx),
    minSize: 48,
  },
  {
    key: 'wikipedia-other',
    label: 'wikipedia (other languages)',
    candidates: (entry, title, ctx) => candidatesWikipediaOther(title, ctx),
    minSize: 48,
  },
  {
    key: 'apple',
    label: 'apple artwork',
    health: 'apple',
    candidates: (entry, title, ctx) => candidatesApple(title, ctx),
    minSize: 64,
  },
  {
    key: 'search',
    label: 'image search api',
    needsKey: true,
    candidates: (entry, title, ctx) => candidatesImageSearch(title, ctx),
    minSize: 64,
  },
  {
    key: 'favicon',
    label: 'website favicon',
    candidates: (entry, title) => candidatesWebsiteFavicons(entry, title),
    minSize: 32,
    parallel: 4,
  },
];

async function findLogoOnce(entry, title, ctx) {
  for (const source of LOGO_SOURCES) {
    if (
      !enabledSources.has(source.key) ||
      (source.needsKey && !searchKey) ||
      (source.health && sourceDead(source.health))
    ) {
      continue;
    }

    const hit = await trySource(
      source.label,
      () => source.candidates(entry, title, ctx),
      source.minSize,
      ctx,
      source.parallel,
    );

    if (hit) return hit;
  }
  return null;
}

/** normalized title -> Promise<{logo, source} | {reason}>; one search per title for the whole run */
const titleResults = new Map();

async function searchLogo(entry, title) {
  let ctx = { hadError: false };
  let hit = await findLogoOnce(entry, title, ctx);

  if (!hit && ctx.hadError && retryEnabled && !timeUp) {
    await sleep(600);
    ctx = { hadError: false };
    hit = await findLogoOnce(entry, title, ctx);
  }

  if (timeUp && !hit) {
    return { cancelled: true };
  }

  return (
    hit || {
      reason: ctx.hadError
        ? 'no logo found (some lookups failed or were blocked)'
        : 'no logo found',
      hadError: ctx.hadError,
    }
  );
}

/**
 * Finds a logo for one entry.
 * @param {object} entry
 * @returns {Promise<{logo?: string, source?: string, reason?: string, cancelled?: boolean}>}
 */
async function findLogo(entry) {
  if (timeUp) {
    return { cancelled: true };
  }

  const title = cleanTitle(entry.title);

  if (!title) {
    return { reason: 'no title to search with' };
  }

  if (!dedupeEnabled) {
    return searchLogo(entry, title);
  }

  const cacheKey = normalizeText(title);

  if (!titleResults.has(cacheKey)) {
    const promise = searchLogo(entry, title);
    titleResults.set(cacheKey, promise);

    // A miss caused by failed lookups (or a stopped run) is not kept:
    // a later duplicate may do better.
    promise.then((result) => {
      if (result.cancelled || (!result.logo && result.hadError)) {
        titleResults.delete(cacheKey);
      }
    });
  }
  return titleResults.get(cacheKey);
}

/* ============================================================
 BUILD OUTPUT
 Entries with a logo keep their original order. Entries without
 one go to the end, also in original order, unless the exclude
 option is on.
 ============================================================ */

/**
 * @param {ReturnType<typeof parseM3U>} parsed
 * @param {Map<number, object>} results
 * @param {boolean} excludeMissing
 */
function buildOutputPlaylist(parsed, results, excludeMissing) {
  const withLogo = [];
  const withoutLogo = [];

  let addedCount = 0;
  let keptExisting = 0;
  let excludedCount = 0;

  parsed.entries.forEach((entry, index) => {
    if (entry.hasLogo) {
      withLogo.push(...renderEntry(entry));
      keptExisting++;
      return;
    }

    const result = results.get(index);

    if (result && result.logo) {
      withLogo.push(...renderEntry(entry, applyLogo(entry.extinf, result.logo)));
      addedCount++;
      return;
    }

    // A result without a logo means a search really finished and found
    // nothing. Entries that were never searched have no result and are
    // always kept.
    if (excludeMissing && result) {
      excludedCount++;
      return;
    }

    withoutLogo.push(...renderEntry(entry, null));
  });

  const lines = [parsed.extm3u, ...parsed.header, ...withLogo, ...withoutLogo];

  return {
    text: `${lines.join('\n')}\n`,
    addedCount,
    keptExisting,
    excludedCount,
    missingCount: parsed.entries.length - keptExisting - addedCount - excludedCount,
  };
}

/**
 * Text of the logo report: stations without a logo first, then every
 * logo that was embedded (to spot wrong matches).
 * @returns {string} empty when nothing was searched
 */
function buildReport(parsed, results) {
  const notFound = [];
  const foundBlocks = [];

  parsed.entries.forEach((entry, index) => {
    const result = results.get(index);
    if (!result) return;

    const name = cleanTitle(entry.title) || '(no title)';

    if (result.logo) {
      foundBlocks.push(`${name}\n${entry.url}\nlogo: ${result.logo}\nsource: ${result.source}\n`);
    } else {
      notFound.push(`${name}\n${entry.url || '(no url)'}\nreason: ${result.reason}\n`);
    }
  });

  if (!notFound.length && !foundBlocks.length) {
    return '';
  }

  return (
    `=== NO LOGO FOUND (${notFound.length}) ===\n\n${notFound.join('\n')}` +
    `\n=== LOGOS EMBEDDED (${foundBlocks.length}) - check these for wrong matches ===\n\n` +
    foundBlocks.join('\n')
  );
}

/* ============================================================
 PREVIEW GALLERY (the page's "View Images" button)
 ============================================================ */

const htmlEsc = (s) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

/**
 * One self-contained HTML page listing every station with its logo.
 * @param {string} fileName
 * @param {ReturnType<typeof parseM3U>} parsed
 * @param {Map<number, object>} results
 * @param {boolean} excludeMissing
 * @returns {string}
 */
function buildPreviewHtml(fileName, parsed, results, excludeMissing) {
  const withLogo = [];
  const withoutLogo = [];

  parsed.entries.forEach((entry, index) => {
    const base = { title: cleanTitle(entry.title) || '(no title)', url: entry.url || '' };

    if (entry.hasLogo) {
      withLogo.push({ ...base, logo: entry.existingLogo, source: 'already had a logo', note: 'already had a logo' });
      return;
    }

    const result = results.get(index);

    if (result && result.logo) {
      withLogo.push({ ...base, logo: result.logo, source: result.source, note: `found via ${result.source}` });
    } else if (!(excludeMissing && result)) {
      withoutLogo.push({
        ...base,
        logo: '',
        source: '',
        note: result ? result.reason : 'not searched (the run was stopped before this entry)',
      });
    }
  });

  const all = [...withLogo, ...withoutLogo];

  // The same image on several entries usually means a generic or shared icon.
  const uses = new Map();
  all.forEach((i) => i.logo && uses.set(i.logo, (uses.get(i.logo) || 0) + 1));
  all.forEach((i) => {
    const n = i.logo ? uses.get(i.logo) : 0;
    i.shared = n > 1;
    if (i.shared) i.note += `, same image on ${n} entries`;
  });

  const sources = [...new Set(all.map((i) => i.source).filter(Boolean))];

  const rows = all
    .map(
      (i, n) =>
        `<div class="row" data-logo="${i.logo ? 1 : 0}" data-source="${htmlEsc(i.source)}" data-shared="${i.shared ? 1 : 0}">` +
        `<div class="num">${n + 1}</div>` +
        `<div class="thumb">${
          i.logo
            ? `<img src="${htmlEsc(i.logo)}" referrerpolicy="no-referrer" loading="lazy" alt="" onerror="this.replaceWith(document.createTextNode('?'))">`
            : '?'
        }</div>` +
        `<div class="text"><div class="title">${htmlEsc(i.title)}</div>` +
        `<div class="url">${htmlEsc(i.url)}</div><div class="note">${htmlEsc(i.note)}</div></div></div>`,
    )
    .join('\n');

  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Logo preview - ${htmlEsc(fileName)}</title>
<style>
:root{color-scheme:light dark;--bg:#fff;--fg:#111;--line:#bbb;--muted:#666}
@media (prefers-color-scheme:dark){:root{--bg:#161616;--fg:#eee;--line:#444;--muted:#999}}
body{font:15px system-ui,sans-serif;background:var(--bg);color:var(--fg);margin:0;padding:16px}
.bar{position:sticky;top:0;background:var(--bg);padding:8px 0;display:flex;gap:8px;flex-wrap:wrap;align-items:center}
select{font:inherit;padding:4px}.row{display:flex;gap:12px;align-items:center;border-bottom:1px solid var(--line);padding:8px 0}
.num{width:3em;text-align:right;color:var(--muted)}.thumb{width:64px;height:64px;flex:none;display:flex;align-items:center;justify-content:center;background:#8883;color:var(--muted)}
.thumb img{max-width:100%;max-height:100%}.title{font-weight:700}.url,.note{color:var(--muted);font-size:.85em;word-break:break-all}
</style></head><body>
<h1>${htmlEsc(fileName)}</h1>
<div class="bar"><select id="f"><option value="all">All entries</option><option value="1">Only with a logo</option><option value="0">Only without a logo</option></select>
<select id="s"><option value="">Any source</option>${all.some((i) => i.shared) ? '<option value="__shared">Same image on several entries</option>' : ''}${sources
    .map((s) => `<option>${htmlEsc(s)}</option>`)
    .join('')}</select><span id="c"></span></div>
${rows}
<script>
const f=document.getElementById('f'),s=document.getElementById('s'),c=document.getElementById('c');
function apply(){let n=0;document.querySelectorAll('.row').forEach(r=>{const ok=(f.value==='all'||r.dataset.logo===f.value)&&(!s.value||(s.value==='__shared'?r.dataset.shared==='1':r.dataset.source===s.value));r.style.display=ok?'':'none';if(ok)n++});c.textContent=n+' shown'}
f.onchange=s.onchange=apply;apply();
</script></body></html>
`;
}

/* ============================================================
 PROCESSING
 ============================================================ */

/**
 * Searches logos for the stations of one playlist using the shared global limiter.
 * @param {Array<{entry: object, index: number}>} jobs
 * @param {string} fileName
 * @param {boolean} quiet
 * @param {(task: () => Promise<any>) => Promise<any>} limiter
 * @returns {Promise<Map<number, object>>} entry index -> { logo, source } | { reason }
 */
async function processLinks(jobs, fileName, quiet, limiter) {
  const results = new Map();
  let nextIndex = 0;

  async function worker() {
    while (true) {
      // Stop accepting new work once the runtime limit is reached.
      if (timeUp) {
        return;
      }
      const currentIndex = nextIndex++;
      if (currentIndex >= jobs.length) {
        return;
      }
      const { entry, index } = jobs[currentIndex];

      const result = await limiter(async () => {
        // Double-check after waiting for a concurrency slot.
        if (timeUp) {
          return null;
        }
        stats.inFlight++;
        try {
          return await findLogo(entry);
        } finally {
          stats.inFlight--;
        }
      });

      // A null / cancelled result means we aborted due to the time limit.
      if (result === null || result.cancelled) {
        continue;
      }

      results.set(index, result);

      stats.checked++;
      const fileInfo = stats.activeFiles.get(fileName);
      if (fileInfo) fileInfo.checked++;

      if (result.logo) {
        stats.found++;
        stats.bySource.set(result.source, (stats.bySource.get(result.source) || 0) + 1);
        if (fileInfo) fileInfo.found++;
      } else {
        stats.notFound++;
      }

      if (!quiet) {
        console.log(
          result.logo
            ? `[${fileName}] Logo (${result.source}): ${cleanTitle(entry.title)} -> ${result.logo}`
            : `[${fileName}] No logo: ${cleanTitle(entry.title)} (${result.reason})`,
        );
      }
    }
  }

  const workerCount = Math.min(concurrencyLimit, jobs.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

/**
 * Entries of a playlist that need a logo search.
 * Entries that cannot be searched (no title / URL) get a ready-made result.
 * @param {ReturnType<typeof parseM3U>} parsed
 * @returns {{jobs: Array<{entry: object, index: number}>, preset: Map<number, object>}}
 */
function planSearches(parsed) {
  const jobs = [];
  const preset = new Map();

  parsed.entries.forEach((entry, index) => {
    if (entry.hasLogo) {
      return;
    }
    if (!entry.extinf || !entry.url || !cleanTitle(entry.title)) {
      preset.set(index, { reason: 'no title to search with' });
      return;
    }
    jobs.push({ entry, index });
  });

  return { jobs, preset };
}

/**
 * Processes one M3U file.
 * fileName is the path relative to inputDir (e.g. "rock/90s/a.m3u").
 * The result is written to the same relative path inside outputDir,
 * creating sub-folders as needed.
 * @param {string} inputDir
 * @param {string} outputDir
 * @param {string} fileName - relative path, "/" separated
 * @param {object} options - { quiet, excludeMissing, writeReport, writePreview }
 * @param {(task: () => Promise<any>) => Promise<any>} limiter
 */
async function processFile(inputDir, outputDir, fileName, options, limiter) {
  const { quiet, excludeMissing, writeReport, writePreview } = options;

  // Bail early if the global time limit was already hit before this file started.
  if (timeUp) {
    if (!quiet) {
      console.log(`[${fileName}] Skipped (runtime limit already reached).`);
    }
    return;
  }

  const fullPath = path.join(inputDir, fileName);
  const originalContent = await fs.readFile(fullPath, 'utf8');
  const parsed = parseM3U(originalContent);
  const { jobs, preset } = planSearches(parsed);

  stats.filesParsed++;
  stats.activeFiles.set(fileName, { total: jobs.length, checked: 0, found: 0 });

  if (!quiet) {
    console.log(
      `[${fileName}] Found ${parsed.entries.length} entries, ${jobs.length} to search for a logo.`,
    );
  }

  /**
   * Removes the source playlist from the input folder once it has been
   * fully processed, so subsequent runs only see the remaining files.
   */
  async function removeFromInput() {
    try {
      await fs.unlink(fullPath);
      if (!quiet) {
        console.log(`[${fileName}] Removed from input folder.`);
      }
    } catch (err) {
      console.warn(`[${fileName}] Could not remove input file: ${err.message}`);
    }
  }

  if (parsed.entries.length === 0) {
    if (!quiet) {
      console.log(`[${fileName}] No entries found. Skipped.`);
    }
    await removeFromInput();
    return;
  }

  const results = jobs.length ? await processLinks(jobs, fileName, quiet, limiter) : new Map();
  preset.forEach((value, key) => results.set(key, value));

  // If the time limit interrupted this file, keep it in the input folder
  // so a later run can finish the remaining stations.
  const fileInfo = stats.activeFiles.get(fileName);
  if (timeUp && fileInfo && fileInfo.checked < fileInfo.total) {
    const message = `${fileInfo.checked}/${fileInfo.total} searched`;
    console.log(
      quiet
        ? `${fileName} incomplete - ${message} (time limit)`
        : `[${fileName}] Incomplete due to runtime limit (${message}). Keeping in input folder.`,
    );
    return;
  }

  const playlist = buildOutputPlaylist(parsed, results, excludeMissing);

  const outputPath = path.join(outputDir, fileName);
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, playlist.text, 'utf8');

  const without = playlist.missingCount + playlist.excludedCount;
  const summary =
    `${playlist.addedCount} logos embedded, ${playlist.keptExisting} already had one, ` +
    `${without} without a logo${excludeMissing ? ` (${playlist.excludedCount} excluded)` : ' (moved to the end)'}`;

  console.log(quiet ? `${fileName} embedded - ${summary}` : `[${fileName}] Complete: ${summary}. Saved to "${outputPath}"`);

  const stem = outputPath.replace(/\.m3u8?$/i, '');

  if (writeReport) {
    const report = buildReport(parsed, results);
    if (report) {
      await fs.writeFile(`${stem}_logo_report.txt`, report, 'utf8');
    } else {
      await fs.rm(`${stem}_logo_report.txt`, { force: true });
    }
  }

  if (writePreview) {
    await fs.writeFile(
      `${stem}_logo_preview.html`,
      buildPreviewHtml(fileName, parsed, results, excludeMissing),
      'utf8',
    );
  }

  // Fully processed and written → remove from input.
  await removeFromInput();
}

/**
 * Recursively collects every .m3u / .m3u8 file below rootDir.
 * Returned paths are relative to rootDir and use "/" as separator,
 * e.g. "rock/90s/a.m3u". Symlinked directories are not followed.
 * @param {string} rootDir
 * @param {string[]} skipDirs - directories that must not be scanned
 * @returns {Promise<string[]>}
 */
async function collectM3UFiles(rootDir, skipDirs = []) {
  const results = [];
  const skip = new Set(skipDirs.map((dir) => path.resolve(dir)));

  async function walk(currentDir) {
    const entries = await fs.readdir(currentDir, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        if (
          entry.name.startsWith('.') ||
          entry.name === 'node_modules' ||
          skip.has(path.resolve(fullPath))
        ) {
          continue;
        }
        await walk(fullPath);
      } else if (entry.isFile() && /\.m3u8?$/i.test(entry.name)) {
        results.push(path.relative(rootDir, fullPath).split(path.sep).join('/'));
      }
    }
  }
  await walk(rootDir);
  return results;
}

/**
 * Main function.
 * @param {string} inputDir
 * @param {string} outputDir
 * @param {object} options - { quiet, excludeMissing, writeReport, writePreview }
 */
async function main(inputDir, outputDir, options) {
  const { quiet } = options;

  await fs.mkdir(outputDir, { recursive: true });
  const m3uFiles = await collectM3UFiles(inputDir, [outputDir]);

  if (m3uFiles.length === 0) {
    if (!quiet) {
      console.log(`No .m3u or .m3u8 files found in "${inputDir}" (searched recursively)`);
    }
    return;
  }

  // Sort playlists by number of stations to search (smallest first) and
  // pre-compute the global totalLinks so ETA works immediately.
  if (!quiet) {
    console.log(
      `Counting stations in ${m3uFiles.length} files to prioritise smaller playlists...`,
    );
  }
  const filesWithCounts = await Promise.all(
    m3uFiles.map(async (fileName) => {
      const content = await fs.readFile(path.join(inputDir, fileName), 'utf8');
      const linkCount = planSearches(parseM3U(content)).jobs.length;
      return { fileName, linkCount };
    }),
  );
  filesWithCounts.sort(
    (a, b) => a.linkCount - b.linkCount || a.fileName.localeCompare(b.fileName),
  );
  const sortedM3uFiles = filesWithCounts.map((f) => f.fileName);

  stats.totalLinks = filesWithCounts.reduce((sum, f) => sum + f.linkCount, 0);

  if (!quiet) {
    const smallest = filesWithCounts[0];
    const largest = filesWithCounts[filesWithCounts.length - 1];
    console.log(
      `Sorted by size: smallest has ${smallest.linkCount} stations to search (${smallest.fileName}), ` +
        `largest has ${largest.linkCount} (${largest.fileName}).`,
    );
  }

  console.log(
    `Found ${sortedM3uFiles.length} M3U files (recursive). ` +
      `Search concurrency: ${concurrencyLimit}. ` +
      `File concurrency: ${fileConcurrency}. ` +
      `Timeout: ${linkTimeout}ms. ` +
      `Max runtime: ${formatDuration(MAX_RUNTIME_MS)}. ` +
      `Order: smallest → largest.`,
  );

  stats.totalFiles = sortedM3uFiles.length;
  stats.startTime = Date.now();

  // Periodic progress report (printed even in --quiet mode).
  const progressTimer = setInterval(() => {
    printProgress(false);
  }, progressInterval);

  // Fire once when the hard runtime limit is reached. Existing in-flight
  // requests are allowed to finish; workers simply stop taking new work.
  const timeUpTimer = setTimeout(() => {
    timeUp = true;
    console.log(
      `\n[TIME LIMIT] Maximum runtime of ${formatDuration(MAX_RUNTIME_MS)} reached. ` +
        `Stopping new searches. Fully processed playlists have been removed from input.`,
    );
    printProgress(false);
  }, MAX_RUNTIME_MS);

  // One global search-level limiter is shared by every file.
  const limiter = createLimiter(concurrencyLimit);

  try {
    // Keep up to `fileConcurrency` playlists in flight at once, taken from
    // the sorted list (smallest first).
    let nextIndex = 0;
    const workers = [];

    async function fileWorker() {
      while (true) {
        if (timeUp) return;
        const index = nextIndex++;
        if (index >= sortedM3uFiles.length) return;

        const fileName = sortedM3uFiles[index];
        try {
          await processFile(inputDir, outputDir, fileName, options, limiter);
        } catch (error) {
          console.error(`[${fileName}] Failed: ${error.message}`);
        } finally {
          stats.filesDone++;
          stats.activeFiles.delete(fileName);
        }
      }
    }

    const workerCount = Math.min(fileConcurrency, sortedM3uFiles.length);
    for (let i = 0; i < workerCount; i++) {
      workers.push(fileWorker());
    }
    await Promise.all(workers);
  } finally {
    clearInterval(progressTimer);
    clearTimeout(timeUpTimer);
  }

  printProgress(true);

  if (timeUp) {
    console.log(
      '\n--- Runtime limit reached. Remaining unprocessed playlists are still in the input folder ---',
    );
  } else if (!quiet) {
    console.log('\n--- All M3U files processed ---');
  }
}

// Parse command-line arguments.
const options = {
  quiet: false,
  excludeMissing: process.env.EXCLUDE_NO_LOGO === '1',
  writeReport: true,
  writePreview: false,
};
const filteredArgs = [];
for (const arg of process.argv.slice(2)) {
  if (arg === '--quiet') {
    options.quiet = true;
  } else if (arg === '--exclude-no-logo') {
    options.excludeMissing = true;
  } else if (arg === '--no-report') {
    options.writeReport = false;
  } else if (arg === '--preview') {
    options.writePreview = true;
  } else {
    filteredArgs.push(arg);
  }
}

const inputDirectory = filteredArgs[0] || 'm3u-files';
const outputDirectory = filteredArgs[1] || 'm3u-logos';

if (!options.quiet) {
  console.log('Starting M3U Logo Embedder...');
  console.log(`Input Directory: ${inputDirectory}`);
  console.log(`Output Directory: ${outputDirectory}`);
  console.log(`Search concurrency: ${concurrencyLimit}`);
  console.log(`File concurrency: ${fileConcurrency}`);
  console.log(`Timeout: ${linkTimeout}ms`);
  console.log(`Sources: ${[...enabledSources].filter((s) => s !== 'search' || searchKey).join(', ')}`);
  if (enabledSources.has('search') && !searchKey) {
    console.log('Image search API: off (set SEARCH_API_KEY to use it)');
  } else if (searchKey) {
    console.log(`Image search API: ${searchProvider}`);
  }
  console.log(`Entries without a logo: ${options.excludeMissing ? 'excluded' : 'kept at the end'}`);
  console.log(`Progress interval: ${progressInterval}ms`);
  console.log(`Max runtime: ${formatDuration(MAX_RUNTIME_MS)}`);
}

main(inputDirectory, outputDirectory, options).catch((error) => {
  console.error('An error occurred:', error);
  process.exitCode = 1;
});
