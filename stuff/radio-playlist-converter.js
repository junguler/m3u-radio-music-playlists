// radio-playlist-converter.js
//
// Converts radio playlists between M3U, M3U8, PLS, XSPF, WPL, ASX, CSV, JSON
// and plain text URL lists. Same parsers and writers as the Radio Playlist
// Converter page, no dependencies (it even ships its own small XML reader).
//
// Input can be:
//
//   - a folder   -> scanned recursively; the sub-folder structure is kept:
//                     input/rock/a.m3u  ->  output/rock/a.pls
//   - a file     -> converted into the output folder
//   - a URL      -> downloaded first (github.com blob/raw links are turned
//                   into raw.githubusercontent.com links, with the GitHub
//                   API as a fallback)
//   - "-"        -> read from stdin (pipe a playlist in)
//
// Supported input extensions inside a folder:
//
//   .m3u .m3u8 .pls .xspf .wpl .asx .xml .csv .txt .json
//
// The format is detected from the extension and then from the content, so a
// playlist with a wrong or missing extension still works. Use --from to
// force a format. UTF-8 and UTF-16 (BOM) files are both understood.
//
// Hidden folders (starting with ".") and node_modules are skipped, and so is
// the output folder if it happens to live inside the input folder.
//
// Usage:
//
//   node radio-playlist-converter.js --to pls
//   node radio-playlist-converter.js input_folder/ output_folder/ --to xspf
//   node radio-playlist-converter.js stations.m3u output_folder/ --to json
//   node radio-playlist-converter.js https://example.com/radio.pls out/ --to m3u8
//   cat radio.asx | node radio-playlist-converter.js - out/ --to m3u
//   node radio-playlist-converter.js stations.pls - --to m3u      (print to stdout)
//
// Options:
//
//   --to <format>        m3u | m3u8 | pls | xspf | wpl | asx | csv | json | txt
//                        (default: m3u; env OUTPUT_FORMAT)
//   --from <format>      auto | m3u | pls | xspf | wpl | asx | csv | json | txt
//                        (default: auto; env INPUT_FORMAT)
//   --name "My List"     playlist name for XSPF / WPL / ASX
//                        (default: the name found in the file, else
//                        "Converted Playlist"; env PLAYLIST_NAME)
//   --basic              "Basic name + URL only" metadata (JSON output;
//                        env METADATA=basic). Default keeps all metadata.
//   --no-dedupe          keep duplicate URLs (default: remove them)
//   --keep-empty         keep entries without a URL (default: skip them)
//   --remove-input       delete each source file after it was converted
//   --quiet              only print the progress reports and the summary
//
// Optional environment variables:
//
//   FILE_CONCURRENCY=8       (max playlists processed at the same time)
//   FETCH_TIMEOUT=20000      (milliseconds, for URL inputs)
//   PROGRESS_INTERVAL=60000  (milliseconds between progress reports)
//
// Example:
//
//   node radio-playlist-converter.js playlists/ converted/ --to m3u8 --name "Radio" --quiet

const fs = require('fs/promises');
const path = require('path');

const fileConcurrency = Number(process.env.FILE_CONCURRENCY || 8);
const fetchTimeout = Number(process.env.FETCH_TIMEOUT || 20000);
const progressInterval = Number(process.env.PROGRESS_INTERVAL || 60000);

const USER_AGENT = 'radio-playlist-converter/1.0';

const INPUT_FORMATS = ['auto', 'm3u', 'pls', 'xspf', 'wpl', 'asx', 'csv', 'json', 'txt'];
const OUTPUT_FORMATS = ['m3u', 'm3u8', 'pls', 'xspf', 'wpl', 'asx', 'csv', 'json', 'txt'];
const INPUT_EXTENSIONS = /\.(m3u8?|pls|xspf|wpl|asx|xml|csv|txt|json)$/i;

/**
 * Global statistics used by the periodic progress report.
 */
const stats = {
  startTime: Date.now(),
  totalFiles: 0,
  filesDone: 0,
  filesFailed: 0,
  entriesRead: 0,
  entriesWritten: 0,
  entriesRemoved: 0,
  // fileName -> true while a file is being processed
  activeFiles: new Set(),
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
  const label = final ? 'FINAL' : 'PROGRESS';
  const lines = [
    '',
    `[${label}] Elapsed: ${formatDuration(elapsedMs)}`,
    `[${label}] Files: ${stats.filesDone}/${stats.totalFiles} done, ${stats.filesFailed} failed`,
    `[${label}] Entries: ${stats.entriesRead} read, ${stats.entriesWritten} written, ${stats.entriesRemoved} removed (duplicates / no URL)`,
  ];
  if (!final && stats.activeFiles.size > 0) {
    lines.push(`[${label}] In progress: ${[...stats.activeFiles].slice(0, 5).join(', ')}`);
  }
  console.log(lines.join('\n'));
}

/**
 * Creates a concurrency limiter.
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
 TEXT HELPERS
 ============================================================ */

const xmlEsc = (value) =>
  String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');

/** One line, safe inside M3U / PLS values. */
const oneLine = (value) =>
  String(value ?? '')
    .replace(/[\r\n]+/g, ' ')
    .trim();

/**
 * Decodes file bytes: UTF-16 (LE/BE with BOM) or UTF-8 (BOM stripped).
 * @param {Buffer} buffer
 * @returns {string}
 */
function decodeText(buffer) {
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    return buffer.subarray(2).toString('utf16le');
  }
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
    const swapped = Buffer.from(buffer.subarray(2));
    swapped.swap16();
    return swapped.toString('utf16le');
  }
  return buffer.toString('utf8').replace(/^\uFEFF/, '');
}

/* ============================================================
 TINY XML / HTML READER
 Replaces the browser's DOMParser. It is deliberately forgiving:
 tag names and attributes are case-insensitive, unclosed tags are
 tolerated (real-world ASX files are often not valid XML) and
 namespace prefixes are ignored.
 ============================================================ */

const XML_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0' };

/**
 * @param {string} s
 * @returns {string}
 */
function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, body) => {
    if (body[0] === '#') {
      const code = body[1].toLowerCase() === 'x' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      try {
        return String.fromCodePoint(code);
      } catch {
        return match;
      }
    }
    const known = XML_ENTITIES[body.toLowerCase()];
    return known !== undefined ? known : match;
  });
}

/**
 * @typedef {{name: string, attrs: Object<string,string>, content: Array<string|XmlNode>, parent: XmlNode|null}} XmlNode
 */

/**
 * Parses XML or sloppy HTML-style markup into a tree.
 * @param {string} text
 * @returns {XmlNode} a synthetic root node
 */
function parseXml(text) {
  const root = { name: '#root', attrs: {}, content: [], parent: null };
  let current = root;

  const tokenRe =
    /<!--[\s\S]*?-->|<!\[CDATA\[([\s\S]*?)\]\]>|<\?[\s\S]*?\?>|<![^>]*>|<\/\s*([^\s>]+)\s*>|<([^\s/>!?][^\s/>]*)((?:\s+[^\s=>/]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*(\/?)>|([^<]+|<)/g;
  const attrRe = /([^\s=>/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;

  const localName = (n) => n.toLowerCase().replace(/^.*:/, '');

  let m;
  while ((m = tokenRe.exec(text))) {
    if (m[1] !== undefined) {
      current.content.push(m[1]); // CDATA: raw text
    } else if (m[2] !== undefined) {
      // Closing tag: pop up to the matching open element, if there is one.
      const name = localName(m[2]);
      for (let node = current; node && node !== root; node = node.parent) {
        if (node.name === name) {
          current = node.parent;
          break;
        }
      }
    } else if (m[3] !== undefined) {
      const attrs = {};
      let a;
      attrRe.lastIndex = 0;
      while ((a = attrRe.exec(m[4] || ''))) {
        const value = a[2] ?? a[3] ?? a[4] ?? '';
        attrs[a[1].toLowerCase().replace(/^.*:/, '')] = decodeEntities(value);
      }
      const node = { name: localName(m[3]), attrs, content: [], parent: current };
      current.content.push(node);
      if (!m[5]) {
        current = node;
      }
    } else if (m[6] !== undefined) {
      current.content.push(decodeEntities(m[6]));
    }
  }

  return root;
}

/**
 * All descendant elements (depth-first, document order).
 * @param {XmlNode} node
 * @param {string} [name] - lower-case local name filter
 * @returns {XmlNode[]}
 */
function descendants(node, name) {
  const out = [];
  const walk = (n) => {
    for (const child of n.content) {
      if (typeof child !== 'string') {
        if (!name || child.name === name) out.push(child);
        walk(child);
      }
    }
  };
  walk(node);
  return out;
}

/**
 * Direct child elements with the given name.
 * @param {XmlNode} node
 * @param {string} name
 * @returns {XmlNode[]}
 */
function childrenNamed(node, name) {
  return node.content.filter((c) => typeof c !== 'string' && c.name === name);
}

/**
 * @param {XmlNode|string} node
 * @returns {string}
 */
function textContent(node) {
  if (typeof node === 'string') return node;
  return node.content.map(textContent).join('');
}

/**
 * Text of the first descendant with this name (trimmed), or ''.
 * @param {XmlNode} node
 * @param {string} name
 * @returns {string}
 */
function firstText(node, name) {
  const found = descendants(node, name)[0];
  return found ? textContent(found).trim() : '';
}

/* ============================================================
 ENTRIES
 ============================================================ */

/**
 * Fills in every field of an entry with a safe default.
 * @param {object} entry
 * @returns {{name:string,url:string,duration:number,artist:string,album:string,genre:string,logo:string,group:string}}
 */
function normalizeEntry(entry) {
  const e = {
    name: String(entry.name || entry.title || '').trim(),
    url: String(entry.url || entry.location || '').trim(),
    duration: Number.isFinite(Number(entry.duration)) ? Number(entry.duration) : -1,
    artist: String(entry.artist || '').trim(),
    album: String(entry.album || '').trim(),
    genre: String(entry.genre || '').trim(),
    logo: String(entry.logo || entry.image || '').trim(),
    group: String(entry.group || entry.category || '').trim(),
  };
  if (!e.name) e.name = e.url || 'Unknown';
  return e;
}

/**
 * Applies the "skip entries without URLs" and "remove duplicate URLs" filters.
 * @param {object[]} entries
 * @param {{skipEmpty: boolean, dedupe: boolean}} options
 * @returns {ReturnType<typeof normalizeEntry>[]}
 */
function cleanEntries(entries, options) {
  let result = entries.map(normalizeEntry);

  if (options.skipEmpty) {
    result = result.filter((e) => e.url);
  }

  if (options.dedupe) {
    const seen = new Set();
    result = result.filter((e) => {
      const key = e.url.toLowerCase();
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }
  return result;
}

/* ============================================================
 PARSERS
 ============================================================ */

/**
 * Splits an #EXTINF line at the first comma that is not inside quotes.
 * @param {string} line
 * @returns {{prefix: string, title: string}}
 */
function splitExtinf(line) {
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    if (line[i] === '"') inQuotes = !inQuotes;
    else if (line[i] === ',' && !inQuotes) {
      return { prefix: line.slice(0, i), title: line.slice(i + 1).trim() };
    }
  }
  return { prefix: line, title: '' };
}

function parseM3U(text) {
  const entries = [];
  let pending = null;

  for (const raw of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const line = raw.trim();

    if (!line) continue;

    if (/^#EXTINF:/i.test(line)) {
      const { prefix, title } = splitExtinf(line);
      const duration = prefix.match(/^#EXTINF:\s*(-?\d+(?:\.\d+)?)/i);

      const attrs = {};
      const attrRe = /([A-Za-z0-9_-]+)="([^"]*)"/g;
      let m;
      while ((m = attrRe.exec(prefix))) attrs[m[1].toLowerCase()] = m[2];

      pending = {
        name: title,
        url: '',
        duration: duration ? Number(duration[1]) : -1,
        artist: attrs.artist || '',
        album: attrs.album || '',
        genre: attrs['group-title'] || attrs.genre || '',
        logo: attrs['tvg-logo'] || attrs.logo || '',
        group: attrs['group-title'] || '',
      };
      continue;
    }

    if (/^#EXTGRP:/i.test(line) && pending) {
      pending.group = line.slice(line.indexOf(':') + 1).trim();
      continue;
    }

    if (line.startsWith('#')) continue;

    // After an #EXTINF the next plain line is its URL, whatever the scheme.
    entries.push(pending ? { ...pending, url: line } : { name: line, url: line, duration: -1 });
    pending = null;
  }
  return entries;
}

function parsePLS(text) {
  const map = {};
  let title = '';

  for (const raw of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith(';')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;

    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    const f = key.match(/^File(\d+)$/i);
    const t = key.match(/^Title(\d+)$/i);
    const d = key.match(/^Length(\d+)$/i);

    if (f) {
      (map[f[1]] ||= {}).url = value;
    } else if (t) {
      (map[t[1]] ||= {}).name = value;
    } else if (d) {
      (map[d[1]] ||= {}).duration = Number(value);
    } else if (/^Playlist\d*$/i.test(key)) {
      title = value;
    }
  }

  const entries = Object.keys(map)
    .sort((a, b) => Number(a) - Number(b))
    .map((n) => ({
      name: map[n].name || map[n].url || 'Unknown',
      url: map[n].url || '',
      duration: Number.isFinite(map[n].duration) ? map[n].duration : -1,
    }));
  return { entries, title };
}

function parseXSPF(text) {
  const root = parseXml(text);
  const playlist = descendants(root, 'playlist')[0];
  if (!playlist) throw new Error('Invalid XSPF/XML document.');

  const title = (childrenNamed(playlist, 'title')[0] && textContent(childrenNamed(playlist, 'title')[0]).trim()) || '';

  const entries = descendants(playlist, 'track').map((track) => {
    const durationMs = firstText(track, 'duration') === '' ? NaN : Number(firstText(track, 'duration'));
    return {
      name: firstText(track, 'title') || firstText(track, 'location') || 'Unknown',
      url: firstText(track, 'location'),
      duration: Number.isFinite(durationMs) ? Math.round(durationMs / 1000) : -1,
      artist: firstText(track, 'creator'),
      album: firstText(track, 'album'),
      genre: firstText(track, 'genre'),
    };
  });
  return { entries, title };
}

function parseWPL(text) {
  const root = parseXml(text);
  const media = descendants(root, 'media');
  if (!media.length && !descendants(root, 'smil').length) {
    throw new Error('Invalid WPL/XML document.');
  }

  const entries = media.map((m) => ({
    name: m.attrs.title || m.attrs.name || m.attrs.src || 'Unknown',
    url: m.attrs.src || '',
    duration: -1,
  }));

  const head = descendants(root, 'head')[0];
  const title = head ? firstText(head, 'title') : '';
  return { entries, title };
}

function parseASX(text) {
  const root = parseXml(text);
  const asx = descendants(root, 'asx')[0];

  const entries = descendants(root, 'entry').map((entry) => {
    const ref = descendants(entry, 'ref')[0];
    const url = ref ? ref.attrs.href || '' : '';
    return {
      name: firstText(entry, 'title') || url || 'Unknown',
      url,
      duration: -1,
      artist: firstText(entry, 'author'),
    };
  });

  if (!entries.length && !asx) {
    throw new Error('Invalid ASX document.');
  }
  return { entries, title: asx ? asx.attrs.title || '' : '' };
}

function parseCSV(text) {
  text = text.replace(/^\uFEFF/, '');
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      if (quoted && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else quoted = !quoted;
    } else if (c === ',' && !quoted) {
      row.push(cell);
      cell = '';
    } else if ((c === '\n' || c === '\r') && !quoted) {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell);
      cell = '';
      if (row.some((v) => v.trim())) rows.push(row);
      row = [];
    } else cell += c;
  }
  if (cell || row.length) {
    row.push(cell);
    if (row.some((v) => v.trim())) rows.push(row);
  }
  if (!rows.length) return [];

  const headers = rows[0].map((h) => h.trim().toLowerCase());
  const find = (names) => {
    for (const n of names) {
      const i = headers.indexOf(n);
      if (i >= 0) return i;
    }
    return -1;
  };

  const nameI = find(['name', 'title', 'station', 'track']);
  const urlI = find(['url', 'location', 'file', 'src', 'stream']);
  const durationI = find(['duration', 'length']);
  const artistI = find(['artist', 'creator']);
  const albumI = find(['album']);
  const groupI = find(['group', 'group-title', 'category']);
  const genreI = find(['genre']) >= 0 ? find(['genre']) : groupI;
  const logoI = find(['logo', 'tvg-logo', 'image']);
  const looksLikeHeader = urlI >= 0 || nameI >= 0;
  const start = looksLikeHeader ? 1 : 0;

  return rows.slice(start).map((r) => ({
    name: r[nameI >= 0 ? nameI : 0] || '',
    url: r[urlI >= 0 ? urlI : Math.min(1, r.length - 1)] || '',
    duration: durationI >= 0 ? Number(r[durationI]) : -1,
    artist: artistI >= 0 ? r[artistI] : '',
    album: albumI >= 0 ? r[albumI] : '',
    genre: genreI >= 0 ? r[genreI] : '',
    group: groupI >= 0 ? r[groupI] : '',
    logo: logoI >= 0 ? r[logoI] : '',
  }));
}

function parseJSON(text) {
  const data = JSON.parse(text.replace(/^\uFEFF/, ''));
  const arr = Array.isArray(data)
    ? data
    : Array.isArray(data.entries)
      ? data.entries
      : Array.isArray(data.tracks)
        ? data.tracks
        : Array.isArray(data.playlist)
          ? data.playlist
          : null;
  if (!arr) throw new Error('JSON must contain an array of playlist entries.');
  return arr.map((e) => (typeof e === 'string' ? { name: e, url: e } : e));
}

function parseTXT(text) {
  return text
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => s && !s.startsWith('#'))
    .map((url) => ({ name: url, url, duration: -1 }));
}

/**
 * Guesses the playlist format from the file name and, failing that, the content.
 * @param {string} text
 * @param {string} fileName
 * @returns {string}
 */
function detectFormat(text, fileName = '') {
  const ext = fileName.toLowerCase().split('.').pop();
  if (['m3u', 'm3u8'].includes(ext)) return 'm3u';
  if (ext === 'pls') return 'pls';
  if (ext === 'xspf') return 'xspf';
  if (ext === 'wpl') return 'wpl';
  if (ext === 'asx') return 'asx';
  if (ext === 'csv') return 'csv';
  if (ext === 'json') return 'json';

  const trimmed = text.trim();
  if (/^#EXTM3U\b/i.test(trimmed) || /^#EXTINF:/im.test(trimmed)) return 'm3u';
  if (/^\s*\[playlist\]/im.test(trimmed) || /\bFile\d+=/i.test(trimmed)) return 'pls';
  if (/<playlist[^>]*xmlns=["']http:\/\/xspf\.org/i.test(trimmed)) return 'xspf';
  if (/<smil\b/i.test(trimmed) || /<wpl\b/i.test(trimmed)) return 'wpl';
  if (/<asx\b/i.test(trimmed)) return 'asx';
  if (/^\s*[[{]/.test(trimmed)) return 'json';
  if (
    trimmed.includes(',') &&
    /(^|,)(url|location|name|title)(,|$)/im.test(trimmed.split(/\r?\n/)[0])
  ) {
    return 'csv';
  }
  return 'txt';
}

/**
 * @param {string} text
 * @param {string} format
 * @returns {{entries: object[], title: string}}
 */
function parsePlaylist(text, format) {
  switch (format) {
    case 'm3u':
      return { entries: parseM3U(text), title: '' };
    case 'pls':
      return parsePLS(text);
    case 'xspf':
      return parseXSPF(text);
    case 'wpl':
      return parseWPL(text);
    case 'asx':
      return parseASX(text);
    case 'csv':
      return { entries: parseCSV(text), title: '' };
    case 'json':
      return { entries: parseJSON(text), title: '' };
    case 'txt':
      return { entries: parseTXT(text), title: '' };
    default:
      throw new Error(`Unsupported input format: ${format}`);
  }
}

/* ============================================================
 WRITERS
 ============================================================ */

/**
 * Optional fields that at least one entry actually has data for
 * (duration > 0 counts as data).
 */
function fieldsWithData(entries, fields) {
  return fields.filter((f) =>
    entries.some((e) => (f === 'duration' ? Number(e.duration) > 0 : String(e[f] ?? '').trim() !== '')),
  );
}

function formatEntryDuration(seconds) {
  const n = Number(seconds);
  // This converter is intended for radio/live streams.
  // Unknown, zero, or negative durations are represented as indefinite (-1).
  return Number.isFinite(n) && n > 0 ? String(Math.round(n)) : '-1';
}

function convertM3U(entries) {
  const lines = ['#EXTM3U'];
  const attr = (key, value) => (value ? ` ${key}="${oneLine(value).replace(/"/g, "'")}"` : '');

  for (const e of entries) {
    const attrs =
      attr('tvg-logo', e.logo) +
      attr('group-title', e.group) +
      attr('artist', e.artist) +
      attr('album', e.album);

    lines.push(`#EXTINF:${formatEntryDuration(e.duration)}${attrs},${oneLine(e.name)}`);
    if (e.group) lines.push(`#EXTGRP:${oneLine(e.group)}`);
    lines.push(oneLine(e.url));
  }
  return lines.join('\n');
}

function convertPLS(entries) {
  const lines = ['[playlist]'];
  entries.forEach((e, i) => {
    const n = i + 1;
    lines.push(`File${n}=${oneLine(e.url)}`);
    lines.push(`Title${n}=${oneLine(e.name)}`);
    lines.push(`Length${n}=${formatEntryDuration(e.duration)}`);
  });
  lines.push(`NumberOfEntries=${entries.length}`);
  lines.push('Version=2');
  return lines.join('\n');
}

function convertXSPF(entries, { playlistName: name }) {
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<playlist version="1" xmlns="http://xspf.org/ns/0/">',
    `  <title>${xmlEsc(name)}</title>`,
    '  <trackList>',
  ];
  for (const e of entries) {
    lines.push('    <track>');
    lines.push(`      <location>${xmlEsc(e.url)}</location>`);
    lines.push(`      <title>${xmlEsc(e.name)}</title>`);
    if (e.artist) lines.push(`      <creator>${xmlEsc(e.artist)}</creator>`);
    if (e.album) lines.push(`      <album>${xmlEsc(e.album)}</album>`);
    if (e.genre) lines.push(`      <genre>${xmlEsc(e.genre)}</genre>`);
    if (e.duration > 0) lines.push(`      <duration>${Math.round(e.duration * 1000)}</duration>`);
    lines.push('    </track>');
  }
  lines.push('  </trackList>', '</playlist>');
  return lines.join('\n');
}

function convertWPL(entries, { playlistName: name }) {
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<smil xmlns="http://www.w3.org/2001/SMIL20/Language">',
    '  <head>',
    `    <title>${xmlEsc(name)}</title>`,
    '  </head>',
    '  <body>',
    '    <seq>',
  ];
  for (const e of entries) {
    lines.push(`      <media src="${xmlEsc(e.url)}" title="${xmlEsc(e.name)}" />`);
  }
  lines.push('    </seq>', '  </body>', '</smil>');
  return lines.join('\n');
}

function convertASX(entries, { playlistName: name }) {
  const lines = ['<?xml version="1.0" encoding="UTF-8"?>', `<ASX version="3.0" TITLE="${xmlEsc(name)}">`];
  for (const e of entries) {
    lines.push('  <Entry>');
    lines.push(`    <Title>${xmlEsc(e.name)}</Title>`);
    if (e.artist) lines.push(`    <Author>${xmlEsc(e.artist)}</Author>`);
    lines.push(`    <Ref href="${xmlEsc(e.url)}" />`);
    lines.push('  </Entry>');
  }
  lines.push('</ASX>');
  return lines.join('\n');
}

const csvCell = (value) => `"${String(value ?? '').replace(/"/g, '""')}"`;

function convertCSV(entries) {
  const headers = [
    'name',
    'url',
    ...fieldsWithData(entries, ['duration', 'artist', 'album', 'genre', 'logo', 'group']),
  ];
  const lines = [headers.join(',')];
  for (const e of entries) {
    lines.push(headers.map((h) => csvCell(e[h])).join(','));
  }
  return lines.join('\n');
}

function convertJSON(entries, { preserve }) {
  const optional = preserve ? ['duration', 'artist', 'album', 'genre', 'logo', 'group'] : ['duration'];
  const keys = ['name', 'url', ...fieldsWithData(entries, optional)];
  return JSON.stringify(
    entries.map((e) => Object.fromEntries(keys.map((k) => [k, e[k]]))),
    null,
    2,
  );
}

function convertTXT(entries) {
  return entries.map((e) => e.url).join('\n');
}

/**
 * @param {ReturnType<typeof normalizeEntry>[]} entries
 * @param {string} format
 * @param {{playlistName: string, preserve: boolean}} options
 * @returns {string}
 */
function convertEntries(entries, format, options) {
  switch (format) {
    case 'm3u':
    case 'm3u8':
      return convertM3U(entries);
    case 'pls':
      return convertPLS(entries);
    case 'xspf':
      return convertXSPF(entries, options);
    case 'wpl':
      return convertWPL(entries, options);
    case 'asx':
      return convertASX(entries, options);
    case 'csv':
      return convertCSV(entries);
    case 'json':
      return convertJSON(entries, options);
    case 'txt':
      return convertTXT(entries);
    default:
      throw new Error(`Unsupported output format: ${format}`);
  }
}

/* ============================================================
 ONLINE PLAYLISTS
 ============================================================ */

/**
 * Recognises github.com blob / raw links and raw.githubusercontent.com links.
 * @param {string} input
 * @returns {{owner: string, repo: string, ref: string, path: string}|null}
 */
function parseGitHubFileURL(input) {
  let url;
  try {
    url = new URL(input);
  } catch {
    return null;
  }

  const host = url.hostname.toLowerCase();
  const parts = url.pathname.split('/').filter(Boolean);

  if (host === 'github.com') {
    // /OWNER/REPO/blob/BRANCH/PATH  or  /OWNER/REPO/raw/BRANCH/PATH
    if (parts.length >= 5 && ['blob', 'raw'].includes(parts[2].toLowerCase())) {
      return { owner: parts[0], repo: parts[1], ref: parts[3], path: parts.slice(4).join('/') };
    }
  }

  if (host === 'raw.githubusercontent.com' && parts.length >= 4) {
    let refIndex = 2;

    // /OWNER/REPO/refs/heads/BRANCH/PATH
    if (parts[2] === 'refs' && (parts[3] === 'heads' || parts[3] === 'tags') && parts.length >= 5) {
      refIndex = 4;
    }

    if (parts.length > refIndex) {
      return {
        owner: parts[0],
        repo: parts[1],
        ref: parts[refIndex],
        path: parts.slice(refIndex + 1).join('/'),
      };
    }
  }
  return null;
}

const githubRawURL = (info) =>
  `https://raw.githubusercontent.com/${info.owner}/${info.repo}/${info.ref}/${info.path}`;

const githubAPIURL = (info) =>
  `https://api.github.com/repos/${encodeURIComponent(info.owner)}/${encodeURIComponent(info.repo)}/contents/${info.path
    .split('/')
    .map(encodeURIComponent)
    .join('/')}?ref=${encodeURIComponent(info.ref)}`;

/**
 * GET with a timeout; returns the response body as a Buffer.
 * @param {string} url
 * @param {object} [headers]
 * @returns {Promise<Buffer>}
 */
async function fetchBuffer(url, headers = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), fetchTimeout);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: { 'User-Agent': USER_AGENT, Accept: '*/*', ...headers },
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}`);
    }
    return Buffer.from(await response.arrayBuffer());
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw new Error(`timed out after ${fetchTimeout}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Downloads a playlist. GitHub file links go to raw.githubusercontent.com
 * first; the (rate-limited) GitHub API is only a fallback.
 * @param {string} input
 * @returns {Promise<string>}
 */
async function fetchOnlinePlaylist(input) {
  const info = parseGitHubFileURL(input);

  const nonEmpty = (buffer) => {
    const text = decodeText(buffer);
    if (!text.trim()) throw new Error('The fetched playlist is empty.');
    return text;
  };

  if (!info) {
    return nonEmpty(await fetchBuffer(input));
  }

  for (const url of new Set([githubRawURL(info), input])) {
    try {
      return nonEmpty(await fetchBuffer(url));
    } catch {
      // try the next candidate
    }
  }

  try {
    const data = JSON.parse(
      (await fetchBuffer(githubAPIURL(info), { Accept: 'application/vnd.github+json' })).toString('utf8'),
    );
    if (!data || typeof data.content !== 'string') {
      throw new Error('GitHub API did not return file content.');
    }
    return nonEmpty(Buffer.from(data.content.replace(/\s/g, ''), 'base64'));
  } catch (error) {
    throw new Error(
      `Unable to fetch the GitHub playlist. Raw GitHub and the GitHub API both failed: ${error.message}`,
    );
  }
}

/* ============================================================
 CONVERSION OF ONE PLAYLIST
 ============================================================ */

/**
 * Parses, cleans and converts playlist text.
 * @param {string} text
 * @param {string} sourceName - file name, used for format detection
 * @param {object} config
 * @returns {{output: string, read: number, written: number, from: string}}
 */
function convertText(text, sourceName, config) {
  const format = config.from === 'auto' ? detectFormat(text, sourceName) : config.from;
  const parsed = parsePlaylist(text, format);
  const entries = cleanEntries(parsed.entries || [], config);

  if (!entries.length) {
    throw new Error('No playlist entries with URLs were found.');
  }

  const options = {
    playlistName: config.name || parsed.title || 'Converted Playlist',
    preserve: config.preserve,
  };

  return {
    output: convertEntries(entries, config.to, options),
    read: (parsed.entries || []).length,
    written: entries.length,
    from: format,
  };
}

/**
 * Keeps a source file name but gives it the extension of the output format.
 * @param {string} relativePath - "/" separated
 * @param {string} format
 * @returns {string}
 */
function outputRelativePath(relativePath, format) {
  const withoutExt = relativePath.replace(/\.[^./]+$/, '');
  return `${withoutExt}.${format}`;
}

/**
 * Converts one playlist from the input folder.
 * @param {string} inputDir
 * @param {string} outputDir
 * @param {string} fileName - relative path, "/" separated
 * @param {object} config
 */
async function processFile(inputDir, outputDir, fileName, config) {
  const fullPath = path.join(inputDir, fileName);
  stats.activeFiles.add(fileName);

  try {
    const text = decodeText(await fs.readFile(fullPath));
    const result = convertText(text, fileName, config);

    let outputPath = path.join(outputDir, outputRelativePath(fileName, config.to));
    if (path.resolve(outputPath) === path.resolve(fullPath)) {
      // Never overwrite the source file.
      outputPath = outputPath.replace(/(\.[^.]+)$/, '_converted$1');
    }

    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.writeFile(outputPath, result.output + '\n', 'utf8');

    stats.entriesRead += result.read;
    stats.entriesWritten += result.written;
    stats.entriesRemoved += result.read - result.written;

    if (!config.quiet) {
      const removed = result.read - result.written;
      console.log(
        `[${fileName}] ${result.from.toUpperCase()} -> ${config.to.toUpperCase()}: ` +
          `${result.written} entries${removed > 0 ? ` (${removed} removed)` : ''}. Saved to "${outputPath}"`,
      );
    }

    if (config.removeInput) {
      await fs.unlink(fullPath);
      if (!config.quiet) {
        console.log(`[${fileName}] Removed from input folder.`);
      }
    }
  } catch (error) {
    stats.filesFailed++;
    console.error(`[${fileName}] Error: ${error.message}`);
  } finally {
    stats.activeFiles.delete(fileName);
    stats.filesDone++;
  }
}

/**
 * Recursively collects every playlist file below rootDir.
 * Returned paths are relative to rootDir and use "/" as separator.
 * Symlinked directories are not followed.
 * @param {string} rootDir
 * @param {string[]} skipDirs - directories that must not be scanned
 * @returns {Promise<string[]>}
 */
async function collectPlaylistFiles(rootDir, skipDirs = []) {
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
      } else if (entry.isFile() && INPUT_EXTENSIONS.test(entry.name)) {
        results.push(path.relative(rootDir, fullPath).split(path.sep).join('/'));
      }
    }
  }
  await walk(rootDir);
  return results;
}

/**
 * Reads all of stdin.
 * @returns {Promise<Buffer>}
 */
async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/**
 * Converts a single playlist that is not part of a folder (file, URL, stdin).
 * @param {string} text
 * @param {string} sourceName
 * @param {string} outputTarget - folder, or "-" for stdout
 * @param {object} config
 */
async function convertSingle(text, sourceName, outputTarget, config) {
  stats.totalFiles = 1;
  try {
    const result = convertText(text, sourceName, config);
    stats.entriesRead += result.read;
    stats.entriesWritten += result.written;
    stats.entriesRemoved += result.read - result.written;

    if (outputTarget === '-') {
      process.stdout.write(result.output + '\n');
    } else {
      const outputPath = path.join(outputTarget, outputRelativePath(path.basename(sourceName), config.to));
      await fs.mkdir(outputTarget, { recursive: true });
      await fs.writeFile(outputPath, result.output + '\n', 'utf8');
      console.log(
        `${result.from.toUpperCase()} -> ${config.to.toUpperCase()}: ${result.written} entries ` +
          `(${result.read - result.written} removed). Saved to "${outputPath}"`,
      );
    }
  } catch (error) {
    stats.filesFailed++;
    console.error(`Error: ${error.message}`);
    process.exitCode = 1;
  } finally {
    stats.filesDone++;
  }
}

/**
 * Main function.
 * @param {string} input - folder, file, URL or "-"
 * @param {string} output - folder (or "-" for stdout)
 * @param {object} config
 */
async function main(input, output, config) {
  stats.startTime = Date.now();

  if (input === '-') {
    const text = decodeText(await readStdin());
    if (!text.trim()) throw new Error('Nothing was piped into stdin.');
    await convertSingle(text, 'stdin_playlist', output, config);
    return;
  }

  if (/^https?:\/\//i.test(input)) {
    if (!config.quiet) console.log(`Fetching ${input} ...`);
    const text = await fetchOnlinePlaylist(input);
    let name = 'playlist';
    try {
      const last = new URL(input).pathname.split('/').pop();
      if (last) name = decodeURIComponent(last);
    } catch {
      // keep the default name
    }
    await convertSingle(text, name, output, config);
    return;
  }

  const info = await fs.stat(input).catch(() => null);
  if (!info) {
    throw new Error(`Input "${input}" does not exist.`);
  }

  if (info.isFile()) {
    const text = decodeText(await fs.readFile(input));
    await convertSingle(text, path.basename(input), output, config);
    if (config.removeInput && !process.exitCode) await fs.unlink(input);
    return;
  }

  // Folder mode.
  if (output === '-') {
    throw new Error('Writing to stdout ("-") only works for a single playlist, not a folder.');
  }
  await fs.mkdir(output, { recursive: true });
  const files = await collectPlaylistFiles(input, [output]);

  if (files.length === 0) {
    console.log(`No playlist files found in "${input}" (searched recursively)`);
    return;
  }

  stats.totalFiles = files.length;
  console.log(
    `Found ${files.length} playlist files (recursive). ` +
      `${config.from === 'auto' ? 'Auto-detecting input format' : `Input format: ${config.from}`}. ` +
      `Output format: ${config.to}. File concurrency: ${fileConcurrency}.`,
  );

  const progressTimer = setInterval(() => printProgress(false), progressInterval);
  const limiter = createLimiter(fileConcurrency);

  try {
    await Promise.all(files.map((fileName) => limiter(() => processFile(input, output, fileName, config))));
  } finally {
    clearInterval(progressTimer);
  }
}

/**
 * Reads the command line. Unknown options stop the script with a message.
 * @param {string[]} argv
 * @returns {{positional: string[], config: object}}
 */
function parseArguments(argv) {
  const config = {
    to: (process.env.OUTPUT_FORMAT || 'm3u').toLowerCase(),
    from: (process.env.INPUT_FORMAT || 'auto').toLowerCase(),
    name: process.env.PLAYLIST_NAME || '',
    preserve: (process.env.METADATA || 'preserve').toLowerCase() !== 'basic',
    dedupe: true,
    skipEmpty: true,
    removeInput: false,
    quiet: false,
  };
  const positional = [];

  const takesValue = new Set(['--to', '--from', '--name']);
  for (let i = 0; i < argv.length; i++) {
    let arg = argv[i];
    let inlineValue = null;

    const eq = arg.startsWith('--') ? arg.indexOf('=') : -1;
    if (eq > 0) {
      inlineValue = arg.slice(eq + 1);
      arg = arg.slice(0, eq);
    }

    let value = inlineValue;
    if (takesValue.has(arg) && value === null) {
      value = argv[++i];
      if (value === undefined) throw new Error(`${arg} needs a value.`);
    }

    switch (arg) {
      case '--to':
        config.to = value.toLowerCase();
        break;
      case '--from':
        config.from = value.toLowerCase();
        break;
      case '--name':
        config.name = value;
        break;
      case '--basic':
        config.preserve = false;
        break;
      case '--no-dedupe':
        config.dedupe = false;
        break;
      case '--keep-empty':
        config.skipEmpty = false;
        break;
      case '--remove-input':
        config.removeInput = true;
        break;
      case '--quiet':
        config.quiet = true;
        break;
      default:
        if (arg.startsWith('--')) throw new Error(`Unknown option ${arg}`);
        positional.push(argv[i]);
    }
  }

  if (!OUTPUT_FORMATS.includes(config.to)) {
    throw new Error(`Unknown output format "${config.to}". Use one of: ${OUTPUT_FORMATS.join(', ')}`);
  }
  if (!INPUT_FORMATS.includes(config.from)) {
    throw new Error(`Unknown input format "${config.from}". Use one of: ${INPUT_FORMATS.join(', ')}`);
  }
  return { positional, config };
}

let parsedArguments;
try {
  parsedArguments = parseArguments(process.argv.slice(2));
} catch (error) {
  console.error(error.message);
  process.exit(1);
}

const { positional, config: runConfig } = parsedArguments;
const inputArgument = positional[0] || 'playlists';
const outputArgument = positional[1] || 'converted';

if (!runConfig.quiet && outputArgument !== '-') {
  console.log('Starting Radio Playlist Converter...');
  console.log(`Input: ${inputArgument}`);
  console.log(`Output: ${outputArgument}`);
  console.log(`Input format: ${runConfig.from}, output format: ${runConfig.to}`);
  console.log(
    `Duplicates: ${runConfig.dedupe ? 'removed' : 'kept'}, entries without URL: ${runConfig.skipEmpty ? 'skipped' : 'kept'}, ` +
      `metadata: ${runConfig.preserve ? 'preserved' : 'basic'}`,
  );
}

main(inputArgument, outputArgument, runConfig)
  .then(() => {
    if (stats.totalFiles > 1 || stats.filesFailed > 0) printProgress(true);
    if (stats.filesFailed > 0) process.exitCode = 1;
  })
  .catch((error) => {
    console.error('An error occurred:', error.message);
    process.exitCode = 1;
  });
