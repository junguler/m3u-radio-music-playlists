// m3u-metadata-embedder.js
//
// Recursively scans the input folder for .m3u / .m3u8 files (any depth),
// connects to every stream, works out its audio format and bitrate, and
// writes the playlists with that information appended to each station name,
// keeping the exact same sub-folder structure:
//
//   input/rock/a.m3u        ->  output/rock/a.m3u
//   input/world/asia/b.m3u8 ->  output/world/asia/b.m3u8
//
//   "Jazz FM"  ->  "Jazz FM - mp3 - 128kb"
//
// An older "- mp3 - 128kb" suffix is replaced, never stacked, so running the
// script again on its own output is safe. Streams that cannot be probed are
// NOT removed (unlike m3u-checker.js): they keep their original line. They
// are listed in a "<name>_metadata_report.txt" file next to the output.
//
// How a stream is probed (same logic as the M3U-Metadata-embedder page):
//
//   1. Content-Type header           -> format (mp3, aac, ogg, ...)
//   2. icy-br / ice-audio-info       -> bitrate, when the server announces it
//   3. First 128 KB of the stream    -> format and bitrate read from the real
//      audio frames (MP3, AAC/ADTS, Ogg Vorbis/Opus, WAV, FLAC, MP4/M4A)
//
// The connection is closed as soon as the answer is known, so a live stream
// is never downloaded further than needed.
//
// Hidden folders (starting with ".") and node_modules are skipped, and so is
// the output folder if it happens to live inside the input folder.
//
// Usage:
//
//   node m3u-metadata-embedder.js
//   node m3u-metadata-embedder.js input_folder/ output_folder/
//   node m3u-metadata-embedder.js input_folder/ output_folder/ --quiet
//   node m3u-metadata-embedder.js input_folder/ output_folder/ --no-report
//
// Optional environment variables:
//
//   CONCURRENCY=30           (max simultaneous stream probes)
//   FILE_CONCURRENCY=5       (max playlists processed at the same time)
//   LINK_TIMEOUT=24000       (per attempt, connecting + reading)
//   MAX_REDIRECTS=5
//   RETRY=1                  (0 = never retry a failed / empty probe)
//   DEDUPE=1                 (0 = probe a URL again every time it appears)
//   PROGRESS_INTERVAL=60000  (milliseconds between progress reports)
//
// Runtime limit (hard-coded for GitHub Actions 6h job limit):
//
//   MAX_RUNTIME_MS = 5h 45m
//   After this duration the script stops accepting new probes. Fully
//   processed playlists are removed from the input folder so a subsequent
//   run can resume with only the remaining files.
//
// Processing order:
//
//   Playlists are sorted by number of stream links (smallest first). Up to
//   FILE_CONCURRENCY playlists run concurrently. When one finishes, the
//   next-smallest unstarted playlist starts immediately.
//
// Example:
//
//   CONCURRENCY=60 FILE_CONCURRENCY=5 LINK_TIMEOUT=20000 node m3u-metadata-embedder.js

const fs = require('fs/promises');
const path = require('path');

const concurrencyLimit = Number(process.env.CONCURRENCY || 30);
const fileConcurrency = Number(process.env.FILE_CONCURRENCY || 5);
const linkTimeout = Number(process.env.LINK_TIMEOUT || 24000);
const maxRedirects = Number(process.env.MAX_REDIRECTS || 5);
const retryEnabled = process.env.RETRY !== '0';
const dedupeEnabled = process.env.DEDUPE !== '0';
const progressInterval = Number(process.env.PROGRESS_INTERVAL || 60000);

// Hard runtime limit for GitHub Actions (6h max). Stop accepting new work
// after 5h 45m so the job can finish cleanly and leave remaining files
// for a subsequent run.
const MAX_RUNTIME_MS = (5 * 60 + 45) * 60 * 1000; // 5h 45m

const USER_AGENT = 'm3u-metadata-embedder/1.0';
const SNIFF_BYTES = 131072;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Set to true when MAX_RUNTIME_MS is reached; workers stop taking new links. */
let timeUp = false;

/**
 * Global statistics used by the periodic progress report.
 */
const stats = {
  startTime: Date.now(),
  totalFiles: 0,
  filesParsed: 0,
  filesDone: 0,
  totalLinks: 0,
  checked: 0,
  withMetadata: 0,
  noMetadata: 0,
  timedOut: 0,
  unreachable: 0,
  httpError: 0,
  inFlight: 0,
  // fileName -> { total, checked, withMetadata }
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
    stats.totalLinks > 0
      ? ((stats.checked / stats.totalLinks) * 100).toFixed(1)
      : '0.0';
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
    `[${label}] Links: ${stats.checked}/${stats.totalLinks} probed (${percent}%), ${stats.inFlight} in flight`,
    `[${label}] Results: ${stats.withMetadata} with metadata, ${stats.noMetadata} reachable without metadata, ${stats.timedOut} timed out, ${stats.unreachable} unreachable, ${stats.httpError} HTTP errors`,
  ];

  if (!final) {
    lines.push(`[${label}] Speed: ${rate.toFixed(1)} links/s, ETA: ${eta}`);
    if (stats.activeFiles.size > 0) {
      const active = [...stats.activeFiles.entries()]
        .sort((a, b) => b[1].total - b[1].checked - (a[1].total - a[1].checked))
        .slice(0, 5);
      lines.push(
        `[${label}] Busiest unfinished files (${stats.activeFiles.size} in progress):`,
      );
      for (const [name, info] of active) {
        lines.push(
          `[${label}] ${name}: ${info.checked}/${info.total} probed, ${info.withMetadata} with metadata`,
        );
      }
    }
  } else {
    lines.push(`[${label}] Average speed: ${rate.toFixed(1)} links/s`);
  }
  console.log(lines.join('\n'));
}

/**
 * Records the result of one probed link in the global statistics.
 * @param {{ok: boolean, status: number|string, hasMetadata: boolean}} result
 * @param {string} fileName
 */
function recordResult(result, fileName) {
  stats.checked++;
  const fileInfo = stats.activeFiles.get(fileName);
  if (fileInfo) {
    fileInfo.checked++;
  }

  if (hasMetadata(result)) {
    stats.withMetadata++;
    if (fileInfo) {
      fileInfo.withMetadata++;
    }
  } else if (result.ok) {
    stats.noMetadata++;
  } else if (result.status === 'timeout') {
    stats.timedOut++;
  } else if (typeof result.status === 'number') {
    stats.httpError++;
  } else {
    stats.unreachable++;
  }
}

/**
 * Creates a global concurrency limiter.
 * This limiter is shared across all files, so processing multiple files
 * concurrently cannot create more than concurrencyLimit HTTP requests.
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

const isHttpUrl = (s) => /^https?:\/\//i.test(s || '');

/**
 * Parses M3U content into a header and a list of entries.
 * @param {string} text
 * @returns {{
 *   extm3u: string,
 *   header: string[],
 *   entries: Array<{extinf: string|null, extra: string[], url: string|null, title: string}>
 * }}
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
  });

  return { extm3u, header, entries };
}

/**
 * The lines of one entry, optionally with a replacement #EXTINF.
 * @param {{extinf: string|null, extra: string[], url: string|null}} entry
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

/* ============================================================
 CONTENT TYPE / HEADER HELPERS
 ============================================================ */

const CONTENT_TYPE_TO_EXT = {
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/aac': 'aac',
  'audio/aacp': 'aac',
  'audio/x-aac': 'aac',
  'audio/ogg': 'ogg',
  'application/ogg': 'ogg',
  'audio/opus': 'opus',
  'audio/flac': 'flac',
  'audio/x-flac': 'flac',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/wave': 'wav',
  'audio/webm': 'webm',
  'video/mp2t': 'ts',
  'application/vnd.apple.mpegurl': 'm3u8',
  'application/x-mpegurl': 'm3u8',
  'audio/x-mpegurl': 'm3u8',
  'audio/mpegurl': 'm3u8',
  'audio/mp4': 'm4a',
  'audio/x-m4a': 'm4a',
};

/**
 * @param {string|null} ct
 * @returns {string|null}
 */
function extFromContentType(ct) {
  if (!ct) return null;
  const clean = ct.toLowerCase().split(';')[0].trim();
  return CONTENT_TYPE_TO_EXT[clean] || null;
}

/**
 * Bitrate announced by Icecast / Shoutcast headers.
 * @param {Headers} headers
 * @returns {number|null}
 */
function bitrateFromHeaders(headers) {
  const icyBr = headers.get('icy-br');

  if (icyBr) {
    // Some servers send "128" and some "128,128" (one value per stream).
    const n = parseInt(icyBr, 10);
    if (!isNaN(n) && n > 0) {
      return n;
    }
  }

  const audioInfo = headers.get('ice-audio-info');

  if (audioInfo) {
    const match = audioInfo.match(/bitrate=(\d+)/i);
    if (match) {
      const n = parseInt(match[1], 10);
      if (!isNaN(n) && n > 0) {
        return n;
      }
    }
  }

  return null;
}

/* ============================================================
 MP3
 ============================================================ */

const MPEG_BITRATE_TABLES = {
  '3_3': [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448],
  '3_2': [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384],
  '3_1': [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
  '2_3': [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256],
  '2_2': [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
  '2_1': [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
};

const MPEG_SAMPLE_RATES = {
  3: [44100, 48000, 32000],
  2: [22050, 24000, 16000],
  0: [11025, 12000, 8000],
};

/**
 * Bytes the ID3v2 tag at the start takes up (0 when there is none).
 * @param {Uint8Array} bytes
 * @returns {number}
 */
function id3TagLength(bytes) {
  if (bytes.length >= 10 && bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) {
    return (
      10 +
      ((bytes[6] & 0x7f) << 21) +
      ((bytes[7] & 0x7f) << 14) +
      ((bytes[8] & 0x7f) << 7) +
      (bytes[9] & 0x7f)
    );
  }
  return 0;
}

/**
 * True when the 4 bytes at `i` look like an MPEG audio frame header.
 * @param {Uint8Array} bytes
 * @param {number} i
 * @returns {boolean}
 */
function isMpegHeader(bytes, i) {
  return (
    bytes[i] === 0xff &&
    (bytes[i + 1] & 0xe0) === 0xe0 &&
    ((bytes[i + 1] >> 3) & 3) !== 1 &&
    ((bytes[i + 1] >> 1) & 3) !== 0 &&
    ((bytes[i + 2] >> 4) & 15) !== 15 &&
    ((bytes[i + 2] >> 4) & 15) !== 0 &&
    ((bytes[i + 2] >> 2) & 3) !== 3
  );
}

/**
 * @param {Uint8Array} bytes
 * @returns {number|null} kbps
 */
function findMp3Bitrate(bytes) {
  const start = id3TagLength(bytes);

  for (let i = start; i < bytes.length - 4; i++) {
    if (bytes[i] === 0xff && (bytes[i + 1] & 0xe0) === 0xe0) {
      const versionBits = (bytes[i + 1] >> 3) & 0x3;
      const layerBits = (bytes[i + 1] >> 1) & 0x3;

      if (versionBits === 1 || layerBits === 0) {
        continue;
      }

      const bitrateIndex = (bytes[i + 2] >> 4) & 0xf;
      const sampleRateIndex = (bytes[i + 2] >> 2) & 0x3;

      if (bitrateIndex === 0 || bitrateIndex === 15 || sampleRateIndex === 3) {
        continue;
      }

      const versionGroup = versionBits === 3 ? '3' : '2';
      const table = MPEG_BITRATE_TABLES[`${versionGroup}_${layerBits}`];
      if (!table) continue;

      const bitrate = table[bitrateIndex];
      if (!bitrate) continue;

      // A real stream has another frame header exactly one frame later.
      const sampleRate = MPEG_SAMPLE_RATES[versionBits][sampleRateIndex];
      const padding = (bytes[i + 2] >> 1) & 1;
      const frameLength =
        layerBits === 3
          ? (Math.floor((12 * bitrate * 1000) / sampleRate) + padding) * 4
          : Math.floor(
              ((layerBits === 1 && versionBits !== 3 ? 72 : 144) * bitrate * 1000) / sampleRate,
            ) + padding;

      const next = i + frameLength;

      if (next + 4 > bytes.length || isMpegHeader(bytes, next)) {
        return bitrate;
      }
    }
  }
  return null;
}

/* ============================================================
 AAC (ADTS)
 ============================================================ */

const AAC_SAMPLE_RATES = [
  96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350,
];

/**
 * @param {Uint8Array} bytes
 * @returns {number|null} kbps
 */
function findAacBitrate(bytes) {
  for (let i = 0; i < bytes.length - 6; i++) {
    if (bytes[i] === 0xff && (bytes[i + 1] & 0xf6) === 0xf0) {
      const sampleRateIndex = (bytes[i + 2] >> 2) & 0xf;

      if (sampleRateIndex >= AAC_SAMPLE_RATES.length) {
        continue;
      }

      const sampleRate = AAC_SAMPLE_RATES[sampleRateIndex];
      const frameLength =
        ((bytes[i + 3] & 0x3) << 11) | (bytes[i + 4] << 3) | ((bytes[i + 5] >> 5) & 0x7);

      if (frameLength < 7 || frameLength > 4096) {
        continue;
      }

      const bitrate = Math.round((frameLength * 8 * sampleRate) / 1024 / 1000);

      if (bitrate > 0 && bitrate < 1000) {
        return bitrate;
      }
    }
  }
  return null;
}

/* ============================================================
 OGG / VORBIS / OPUS
 ============================================================ */

/**
 * @param {Uint8Array} bytes
 * @returns {{ext: string, bitrate: number|null}|null}
 */
function findOggInfo(bytes) {
  for (let i = 0; i < bytes.length - 27; i++) {
    if (
      bytes[i] === 0x4f &&
      bytes[i + 1] === 0x67 &&
      bytes[i + 2] === 0x67 &&
      bytes[i + 3] === 0x53
    ) {
      const pageSegments = bytes[i + 26];
      const segStart = i + 27;

      if (segStart + pageSegments > bytes.length) {
        return null;
      }

      let firstPacketLen = 0;

      for (let s = 0; s < pageSegments; s++) {
        firstPacketLen += bytes[segStart + s];
        if (bytes[segStart + s] < 255) {
          break;
        }
      }

      const dataStart = segStart + pageSegments;

      if (dataStart + firstPacketLen > bytes.length) {
        return null;
      }

      const packet = bytes.subarray(dataStart, dataStart + firstPacketLen);

      // "\x01vorbis"
      if (
        packet.length >= 30 &&
        packet[0] === 0x01 &&
        packet[1] === 0x76 &&
        packet[2] === 0x6f &&
        packet[3] === 0x72 &&
        packet[4] === 0x62 &&
        packet[5] === 0x69 &&
        packet[6] === 0x73
      ) {
        const view = new DataView(packet.buffer, packet.byteOffset, packet.byteLength);
        const bitrateMax = view.getInt32(16, true);
        const bitrateNominal = view.getInt32(20, true);
        const bitrateMin = view.getInt32(24, true);

        let kbps = null;
        if (bitrateNominal > 0) {
          kbps = Math.round(bitrateNominal / 1000);
        } else if (bitrateMax > 0) {
          kbps = Math.round(bitrateMax / 1000);
        } else if (bitrateMin > 0) {
          kbps = Math.round(bitrateMin / 1000);
        }
        return { ext: 'ogg', bitrate: kbps };
      }

      // "OpusHead"
      if (
        packet.length >= 8 &&
        packet[0] === 0x4f &&
        packet[1] === 0x70 &&
        packet[2] === 0x75 &&
        packet[3] === 0x73 &&
        packet[4] === 0x48 &&
        packet[5] === 0x65 &&
        packet[6] === 0x61 &&
        packet[7] === 0x64
      ) {
        return { ext: 'opus', bitrate: null };
      }

      return { ext: 'ogg', bitrate: null };
    }
  }
  return null;
}

/* ============================================================
 WAV
 ============================================================ */

/**
 * @param {Uint8Array} bytes
 * @returns {number|null} kbps
 */
function findWavBitrate(bytes) {
  if (bytes.length < 12) {
    return null;
  }
  if (!(bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46)) {
    return null;
  }
  if (!(bytes[8] === 0x57 && bytes[9] === 0x41 && bytes[10] === 0x56 && bytes[11] === 0x45)) {
    return null;
  }

  let pos = 12;

  while (pos + 8 <= bytes.length) {
    const id = String.fromCharCode(bytes[pos], bytes[pos + 1], bytes[pos + 2], bytes[pos + 3]);
    const size =
      bytes[pos + 4] | (bytes[pos + 5] << 8) | (bytes[pos + 6] << 16) | (bytes[pos + 7] << 24);

    if (id === 'fmt ') {
      if (pos + 8 + 16 > bytes.length) {
        return null;
      }
      const byteRate =
        bytes[pos + 16] |
        (bytes[pos + 17] << 8) |
        (bytes[pos + 18] << 16) |
        (bytes[pos + 19] << 24);
      return byteRate > 0 ? Math.round((byteRate * 8) / 1000) : null;
    }

    if (size < 0) {
      return null;
    }
    pos += 8 + size + (size % 2);
  }
  return null;
}

/* ============================================================
 FLAC
 ============================================================ */

/**
 * @param {Uint8Array} bytes
 * @returns {number|null} kbps
 */
function findFlacBitrate(bytes) {
  if (bytes.length < 42) {
    return null;
  }
  if (!(bytes[0] === 0x66 && bytes[1] === 0x4c && bytes[2] === 0x61 && bytes[3] === 0x43)) {
    return null;
  }

  const blockType = bytes[4] & 0x7f;
  if (blockType !== 0) {
    return null;
  }

  const d = 8;
  const minBlock = (bytes[d] << 8) | bytes[d + 1];
  const maxBlock = (bytes[d + 2] << 8) | bytes[d + 3];
  const minFrame = (bytes[d + 4] << 16) | (bytes[d + 5] << 8) | bytes[d + 6];
  const maxFrame = (bytes[d + 7] << 16) | (bytes[d + 8] << 8) | bytes[d + 9];
  const sampleRate = (bytes[d + 10] << 12) | (bytes[d + 11] << 4) | (bytes[d + 12] >> 4);

  const blockSize = maxBlock || minBlock;
  const frameSize = maxFrame || minFrame;

  if (blockSize && frameSize && sampleRate) {
    const kbps = Math.round((frameSize * 8 * sampleRate) / blockSize / 1000);
    if (kbps > 0 && kbps < 8000) {
      return kbps;
    }
  }
  return null;
}

/* ============================================================
 MP4 / M4A
 ============================================================ */

/**
 * @param {Uint8Array} bytes
 * @param {number} pos
 * @returns {{length: number, bytesRead: number}}
 */
function readMp4DescriptorLength(bytes, pos) {
  let length = 0;
  let bytesRead = 0;
  let b;

  do {
    b = bytes[pos + bytesRead];
    length = (length << 7) | (b & 0x7f);
    bytesRead++;
  } while ((b & 0x80) !== 0 && bytesRead < 4);

  return { length, bytesRead };
}

/**
 * @param {Uint8Array} bytes
 * @returns {number|null} kbps
 */
function findEsdsBitrate(bytes) {
  try {
    for (let i = 0; i < bytes.length - 4; i++) {
      if (
        bytes[i] === 0x65 &&
        bytes[i + 1] === 0x73 &&
        bytes[i + 2] === 0x64 &&
        bytes[i + 3] === 0x73
      ) {
        let pos = i + 4 + 4;

        if (bytes[pos] !== 0x03) {
          continue;
        }
        pos++;

        let len = readMp4DescriptorLength(bytes, pos);
        pos += len.bytesRead + 2;

        const flags = bytes[pos];
        pos++;

        if (flags & 0x80) {
          pos += 2;
        }
        if (flags & 0x40) {
          const urlLen = bytes[pos];
          pos += 1 + urlLen;
        }
        if (flags & 0x20) {
          pos += 2;
        }

        if (bytes[pos] !== 0x04) {
          continue;
        }
        pos++;

        len = readMp4DescriptorLength(bytes, pos);
        pos += len.bytesRead;
        pos += 1 + 1 + 3;

        if (pos + 8 > bytes.length) {
          return null;
        }

        const maxBitrate =
          ((bytes[pos] << 24) | (bytes[pos + 1] << 16) | (bytes[pos + 2] << 8) | bytes[pos + 3]) >>>
          0;
        const avgBitrate =
          ((bytes[pos + 4] << 24) |
            (bytes[pos + 5] << 16) |
            (bytes[pos + 6] << 8) |
            bytes[pos + 7]) >>>
          0;

        const kbps = avgBitrate
          ? Math.round(avgBitrate / 1000)
          : maxBitrate
            ? Math.round(maxBitrate / 1000)
            : null;

        if (kbps > 0 && kbps < 2000) {
          return kbps;
        }
      }
    }
  } catch {
    // Partial/malformed MP4 data.
  }
  return null;
}

/* ============================================================
 FORMAT SNIFFING
 ============================================================ */

/**
 * Guesses the audio format from the first bytes of a stream.
 * @param {Uint8Array} bytes
 * @returns {string|null}
 */
function sniffFormatFromBytes(bytes) {
  if (bytes.length < 4) {
    return null;
  }

  if (bytes[0] === 0x4f && bytes[1] === 0x67 && bytes[2] === 0x67 && bytes[3] === 0x53) {
    return 'ogg';
  }

  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x41 &&
    bytes[10] === 0x56 &&
    bytes[11] === 0x45
  ) {
    return 'wav';
  }

  if (bytes[0] === 0x66 && bytes[1] === 0x4c && bytes[2] === 0x61 && bytes[3] === 0x43) {
    return 'flac';
  }

  if (bytes[0] === 0xff && (bytes[1] & 0xf6) === 0xf0) {
    return 'aac';
  }

  if (bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) {
    return 'mp3';
  }

  if (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0) {
    return 'mp3';
  }

  if (bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) {
    return 'webm';
  }

  if (bytes.length >= 8) {
    const boxType = String.fromCharCode(bytes[4], bytes[5], bytes[6], bytes[7]);
    if (['ftyp', 'moov', 'free', 'moof', 'mdat', 'styp', 'skip', 'wide'].includes(boxType)) {
      return 'm4a';
    }
  }

  return null;
}

/**
 * Reads the start of a stream until its format and bitrate are known
 * (or SNIFF_BYTES have been read).
 * @param {ReadableStreamDefaultReader} reader
 * @param {string|null} knownExt - format already known from Content-Type
 * @returns {Promise<{ext: string|null, bitrate: number|null}>}
 */
async function sniffAudioStream(reader, knownExt) {
  let buf = Buffer.alloc(0);
  let ext = knownExt || null;
  let bitrate = null;

  try {
    while (buf.length < SNIFF_BYTES) {
      const { done, value } = await reader.read();

      if (done || !value) {
        break;
      }

      buf = Buffer.concat([buf, value]);

      if (!ext) {
        ext = sniffFormatFromBytes(buf);
      }

      switch (ext) {
        case 'mp3':
          bitrate = findMp3Bitrate(buf);
          break;
        case 'aac':
          bitrate = findAacBitrate(buf);
          break;
        case 'wav':
          bitrate = findWavBitrate(buf);
          break;
        case 'flac':
          bitrate = findFlacBitrate(buf);
          break;
        case 'm4a':
          bitrate = findEsdsBitrate(buf);
          break;
        case 'ogg': {
          const info = findOggInfo(buf);
          if (info) {
            ext = info.ext;
            bitrate = info.bitrate;
          }
          break;
        }
        default:
          break;
      }

      if (bitrate || ext === 'webm' || ext === 'opus' || ext === 'ts' || ext === 'm3u8') {
        break;
      }
    }
  } catch {
    // Abort / network failure: return whatever was already detected.
  }

  return { ext, bitrate };
}

/* ============================================================
 PROBING ONE STREAM
 ============================================================ */

const failure = (status) => ({ ok: false, status, ext: null, bitrate: null });

/**
 * True when a probe result carries a format or bitrate worth embedding.
 * @param {{ok: boolean, ext: string|null, bitrate: number|null}} result
 * @returns {boolean}
 */
function hasMetadata(result) {
  return !!(result && result.ok && (result.ext || result.bitrate));
}

/**
 * One probe: connect, follow redirects, read headers, sniff the stream.
 * @param {string} url
 * @returns {Promise<{ok: boolean, status: number|string, ext: string|null, bitrate: number|null}>}
 */
async function attemptMetadata(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), linkTimeout);
  let response;
  let reader = null;

  try {
    let current = url;

    for (let hop = 0; ; hop++) {
      response = await fetch(current, {
        signal: controller.signal,
        redirect: 'manual',
        headers: { 'User-Agent': USER_AGENT, Accept: '*/*' },
      });

      const isRedirect =
        response.status >= 300 && response.status < 400 && response.headers.has('location');

      if (!isRedirect) {
        break;
      }

      try {
        await response.body?.cancel();
      } catch {
        // Ignore body cancellation errors.
      }

      if (hop >= maxRedirects) {
        return failure('too-many-redirects');
      }
      current = new URL(response.headers.get('location'), current).href;
    }

    if (!(response.status >= 200 && response.status < 300)) {
      return failure(response.status);
    }

    let ext = extFromContentType(response.headers.get('content-type'));
    let bitrate = bitrateFromHeaders(response.headers);

    if (!bitrate && response.body) {
      reader = response.body.getReader();
      const sniffed = await sniffAudioStream(reader, ext);
      ext = ext || sniffed.ext;
      bitrate = sniffed.bitrate;
    }

    return { ok: true, status: response.status, ext, bitrate };
  } catch (error) {
    return failure(error?.name === 'AbortError' ? 'timeout' : 'network-error');
  } finally {
    clearTimeout(timer);
    // 🔥 A live stream never ends: closing it is what stops the download,
    // and it releases the TCP socket so the Node.js event loop can exit.
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
 * Probes a URL, retrying once when the first probe failed or found nothing.
 * @param {string} url
 * @returns {Promise<{ok: boolean, status: number|string, ext: string|null, bitrate: number|null}>}
 */
async function checkUrl(url) {
  const result = await attemptMetadata(url);

  if (hasMetadata(result) || !retryEnabled || timeUp) {
    return result;
  }

  await sleep(400);
  const retry = await attemptMetadata(url);

  // Keep the more informative of the two answers.
  if (hasMetadata(retry) || (retry.ok && !result.ok)) {
    return retry;
  }
  return result;
}

/** url -> Promise<result>; a URL that appears twice is only ever probed once. */
const urlResultCache = new Map();

/**
 * @param {string} url
 * @returns {Promise<{ok: boolean, status: number|string, ext: string|null, bitrate: number|null}>}
 */
function checkLink(url) {
  if (!dedupeEnabled) {
    return checkUrl(url);
  }
  if (!urlResultCache.has(url)) {
    urlResultCache.set(url, checkUrl(url));
  }
  return urlResultCache.get(url);
}

/* ============================================================
 EMBEDDING
 ============================================================ */

const FORMAT_SUFFIX = /\s+-\s+(?:mp3|aac|ogg|opus|wav|flac|webm|ts|m3u8|m4a)(?:\s+-\s+\d+kb)?$/i;

/**
 * "Name" -> "Name - mp3 - 128kb"; an older suffix is replaced, not stacked.
 * @param {string} extinfLine
 * @param {string|null} ext
 * @param {number|null} bitrate
 * @returns {string}
 */
function embedMetadata(extinfLine, ext, bitrate) {
  const { prefix, title } = splitExtinf(extinfLine);

  if (!title) {
    return extinfLine; // No title to attach the info to.
  }

  const clean = title.replace(FORMAT_SUFFIX, '').replace(/\s+-\s+\d+kb$/i, '');

  const suffix = [ext, bitrate && `${bitrate}kb`]
    .filter(Boolean)
    .map((part) => ` - ${part}`)
    .join('');

  return `${prefix},${clean}${suffix}`;
}

/**
 * Human readable reason why a stream got no metadata.
 * @param {{ok: boolean, status: number|string, corsBlocked?: boolean}} result
 * @returns {string}
 */
function describeReason(result) {
  if (result.ok) {
    return 'reachable, but no recognizable metadata found';
  }

  switch (result.status) {
    case 'timeout':
      return 'timed out';
    case 'network-error':
      return 'network error / dead';
    case 'too-many-redirects':
      return `more than ${maxRedirects} redirects`;
    default:
      return typeof result.status === 'number' ? `HTTP ${result.status}` : String(result.status);
  }
}

/**
 * Builds the output playlist. Every entry is kept; entries whose probe found
 * something get a new #EXTINF line.
 * @param {ReturnType<typeof parseM3U>} parsed
 * @param {Map<number, object>} results - entry index -> probe result
 * @returns {{text: string, updated: number}}
 */
function buildOutputPlaylist(parsed, results) {
  const lines = [parsed.extm3u, ...parsed.header];
  let updated = 0;

  parsed.entries.forEach((entry, index) => {
    const result = results.get(index);
    let extinf = null;

    if (entry.extinf && hasMetadata(result)) {
      const next = embedMetadata(entry.extinf, result.ext, result.bitrate);
      if (next !== entry.extinf) {
        extinf = next;
        updated++;
      }
    }

    lines.push(...renderEntry(entry, extinf));
  });

  return { text: `${lines.join('\n')}\n`, updated };
}

/**
 * Builds the text of the report listing every stream without metadata.
 * @param {ReturnType<typeof parseM3U>} parsed
 * @param {Map<number, object>} results
 * @returns {string} empty when every probed stream got metadata
 */
function buildReport(parsed, results) {
  const blocks = [];

  parsed.entries.forEach((entry, index) => {
    const result = results.get(index);
    if (result && !hasMetadata(result)) {
      blocks.push(
        `${entry.title || '(no title)'}\n${entry.url}\nreason: ${describeReason(result)}\n`,
      );
    }
  });

  return blocks.join('\n');
}

/**
 * Probes the stream links of one playlist using the shared global limiter.
 * @param {Array<{entry: object, index: number}>} jobs
 * @param {string} fileName
 * @param {boolean} quiet
 * @param {(task: () => Promise<any>) => Promise<any>} limiter
 * @returns {Promise<Map<number, object>>} entry index -> probe result
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
          return await checkLink(entry.url);
        } finally {
          stats.inFlight--;
        }
      });

      // A null result means we aborted due to the time limit.
      if (result === null) {
        continue;
      }

      recordResult(result, fileName);
      results.set(index, result);

      if (!quiet) {
        const found = hasMetadata(result)
          ? `${result.ext || '?'}${result.bitrate ? ` ${result.bitrate}kb` : ''}`
          : describeReason(result);
        console.log(`[${fileName}] ${found}: ${entry.url}`);
      }
    }
  }

  const workerCount = Math.min(concurrencyLimit, jobs.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

/**
 * Processes one M3U file.
 * fileName is the path relative to inputDir (e.g. "rock/90s/a.m3u").
 * The result is written to the same relative path inside outputDir,
 * creating sub-folders as needed.
 * @param {string} inputDir
 * @param {string} outputDir
 * @param {string} fileName - relative path, "/" separated
 * @param {boolean} quiet
 * @param {boolean} writeReport
 * @param {(task: () => Promise<any>) => Promise<any>} limiter
 */
async function processFile(inputDir, outputDir, fileName, quiet, writeReport, limiter) {
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

  const jobs = parsed.entries
    .map((entry, index) => ({ entry, index }))
    .filter((job) => isHttpUrl(job.entry.url));

  stats.filesParsed++;
  stats.activeFiles.set(fileName, { total: jobs.length, checked: 0, withMetadata: 0 });

  if (!quiet) {
    console.log(`[${fileName}] Found ${jobs.length} stream links.`);
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

  const results = jobs.length
    ? await processLinks(jobs, fileName, quiet, limiter)
    : new Map();

  // If the time limit interrupted this file, keep it in the input folder
  // so a later run can finish the remaining links.
  const fileInfo = stats.activeFiles.get(fileName);
  if (timeUp && fileInfo && fileInfo.checked < fileInfo.total) {
    const message = `${fileInfo.checked}/${fileInfo.total} probed`;
    console.log(
      quiet
        ? `${fileName} incomplete - ${message} (time limit)`
        : `[${fileName}] Incomplete due to runtime limit (${message}). Keeping in input folder.`,
    );
    return;
  }

  const playlist = buildOutputPlaylist(parsed, results);

  const outputPath = path.join(outputDir, fileName);
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, playlist.text, 'utf8');

  if (quiet) {
    console.log(`${fileName} embedded - ${playlist.updated}/${jobs.length} streams got metadata`);
  } else {
    console.log(
      `[${fileName}] Complete: ${playlist.updated}/${jobs.length} streams got metadata. Saved to "${outputPath}"`,
    );
  }

  if (writeReport) {
    const report = buildReport(parsed, results);
    const reportPath = outputPath.replace(/\.m3u8?$/i, '') + '_metadata_report.txt';

    if (report) {
      await fs.writeFile(reportPath, report, 'utf8');
      if (!quiet) {
        console.log(`[${fileName}] Report saved to "${reportPath}"`);
      }
    } else {
      // A stale report from an earlier run would be misleading.
      await fs.rm(reportPath, { force: true });
    }
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
 * @param {boolean} quiet
 * @param {boolean} writeReport
 */
async function main(inputDir, outputDir, quiet = false, writeReport = true) {
  await fs.mkdir(outputDir, { recursive: true });
  const m3uFiles = await collectM3UFiles(inputDir, [outputDir]);

  if (m3uFiles.length === 0) {
    if (!quiet) {
      console.log(`No .m3u or .m3u8 files found in "${inputDir}" (searched recursively)`);
    }
    return;
  }

  // Sort playlists by number of stream links (smallest first) and
  // pre-compute the global totalLinks so ETA works immediately.
  if (!quiet) {
    console.log(
      `Counting stream links in ${m3uFiles.length} files to prioritise smaller playlists...`,
    );
  }
  const filesWithCounts = await Promise.all(
    m3uFiles.map(async (fileName) => {
      const content = await fs.readFile(path.join(inputDir, fileName), 'utf8');
      const linkCount = parseM3U(content).entries.filter((e) => isHttpUrl(e.url)).length;
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
      `Sorted by size: smallest has ${smallest.linkCount} links (${smallest.fileName}), ` +
        `largest has ${largest.linkCount} links (${largest.fileName}).`,
    );
  }

  console.log(
    `Found ${sortedM3uFiles.length} M3U files (recursive). ` +
      `Link concurrency: ${concurrencyLimit}. ` +
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
        `Stopping new probes. Fully processed playlists have been removed from input.`,
    );
    printProgress(false);
  }, MAX_RUNTIME_MS);

  // One global probe-level limiter is shared by every file.
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
          await processFile(inputDir, outputDir, fileName, quiet, writeReport, limiter);
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
let quiet = false;
let writeReport = true;
const filteredArgs = [];
for (const arg of process.argv.slice(2)) {
  if (arg === '--quiet') {
    quiet = true;
  } else if (arg === '--no-report') {
    writeReport = false;
  } else {
    filteredArgs.push(arg);
  }
}

const inputDirectory = filteredArgs[0] || 'm3u-files';
const outputDirectory = filteredArgs[1] || 'm3u-embedded';

if (!quiet) {
  console.log('Starting M3U Metadata Embedder...');
  console.log(`Input Directory: ${inputDirectory}`);
  console.log(`Output Directory: ${outputDirectory}`);
  console.log(`Link concurrency: ${concurrencyLimit}`);
  console.log(`File concurrency: ${fileConcurrency}`);
  console.log(`Timeout: ${linkTimeout}ms`);
  console.log(`Retry: ${retryEnabled ? 'on' : 'off'}, dedupe: ${dedupeEnabled ? 'on' : 'off'}`);
  console.log(`Progress interval: ${progressInterval}ms`);
  console.log(`Max runtime: ${formatDuration(MAX_RUNTIME_MS)}`);
}

main(inputDirectory, outputDirectory, quiet, writeReport).catch((error) => {
  console.error('An error occurred:', error);
  process.exitCode = 1;
});
