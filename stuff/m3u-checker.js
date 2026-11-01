// m3u-checker.js
//
// Recursively scans the input folder for .m3u / .m3u8 files (any depth) and
// writes the cleaned playlists to the output folder, keeping the exact same
// sub-folder structure:
//
//   input/rock/a.m3u        ->  output/rock/a.m3u
//   input/world/asia/b.m3u8 ->  output/world/asia/b.m3u8
//
// Hidden folders (starting with ".") and node_modules are skipped, and so is
// the output folder if it happens to live inside the input folder.
//
// Usage:
//
//   node m3u-checker.js
//   node m3u-checker.js input_folder/ output_folder/
//   node m3u-checker.js input_folder/ output_folder/ --quiet
//
// Optional environment variables:
//
//   CONCURRENCY=100          (max simultaneous HTTP link checks)
//   FILE_CONCURRENCY=5       (max playlists processed at the same time)
//   LINK_TIMEOUT=8000
//   MAX_REDIRECTS=3
//   PROGRESS_INTERVAL=30000  (milliseconds between progress reports)
//
// Runtime limit (hard-coded for GitHub Actions 6h job limit):
//
//   MAX_RUNTIME_MS = 5h 45m
//   After this duration the script stops accepting new link checks.
//   Fully-checked playlists are removed from the input folder so a
//   subsequent run can resume with only the remaining files.
//
// Processing order:
//
//   Playlists are sorted by number of stream links (smallest first).
//   Up to FILE_CONCURRENCY playlists run concurrently. When one finishes,
//   the next-smallest unstarted playlist starts immediately. This keeps
//   link-level concurrency saturated while still finishing small
//   playlists first so they can be removed before the time limit.
//
// Example:
//
//   CONCURRENCY=150 FILE_CONCURRENCY=5 LINK_TIMEOUT=8000 node m3u-checker.js

const fs = require('fs/promises');
const path = require('path');

const concurrencyLimit = Number(process.env.CONCURRENCY || 50);
const fileConcurrency = Number(process.env.FILE_CONCURRENCY || 5);
const linkTimeout = Number(process.env.LINK_TIMEOUT || 8000);
const maxRedirects = Number(process.env.MAX_REDIRECTS || 3);
const progressInterval = Number(process.env.PROGRESS_INTERVAL || 60000);

// Hard runtime limit for GitHub Actions (6h max). Stop accepting new work
// after 5h 45m so the job can finish cleanly and leave remaining files
// for a subsequent run.
const MAX_RUNTIME_MS = (5 * 60 + 45) * 60 * 1000; // 5h 45m

const USER_AGENT = 'm3u-checker/1.0';
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
  alive: 0,
  timedOut: 0,
  invalid: 0,
  httpError: 0,
  inFlight: 0,
  // fileName -> { total, checked, alive }
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

  // Total link count is known up-front (pre-counted while sorting),
  // so ETA is available as soon as we have a non-zero rate.
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
    `[${label}] Links: ${stats.checked}/${stats.totalLinks} checked (${percent}%), ${stats.inFlight} in flight`,
    `[${label}] Results: ${stats.alive} alive, ${stats.timedOut} timed out, ${stats.invalid} invalid/unreachable, ${stats.httpError} HTTP errors`,
  ];

  if (!final) {
    lines.push(
      `[${label}] Speed: ${rate.toFixed(1)} links/s, ETA: ${eta}`,
    );
    if (stats.activeFiles.size > 0) {
      const active = [...stats.activeFiles.entries()]
        .sort((a, b) => b[1].total - b[1].checked - (a[1].total - a[1].checked))
        .slice(0, 5);
      lines.push(
        `[${label}] Busiest unfinished files (${stats.activeFiles.size} in progress):`,
      );
      for (const [name, info] of active) {
        lines.push(
          `[${label}] ${name}: ${info.checked}/${info.total} checked, ${info.alive} alive`,
        );
      }
    }
  } else {
    lines.push(
      `[${label}] Average speed: ${rate.toFixed(1)} links/s`,
    );
  }
  console.log(lines.join('\n'));
}

/**
 * Records the result of one checked link in the global statistics.
 * @param {number|string} status
 * @param {string} fileName
 */
function recordResult(status, fileName) {
  stats.checked++;
  const fileInfo = stats.activeFiles.get(fileName);
  if (fileInfo) {
    fileInfo.checked++;
  }

  if (typeof status === 'number' && status >= 200 && status < 300) {
    stats.alive++;
    if (fileInfo) {
      fileInfo.alive++;
    }
  } else if (status === 'timedout') {
    stats.timedOut++;
  } else if (status === 'invalid') {
    stats.invalid++;
  } else {
    stats.httpError++;
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

/**
 * Parses M3U content and extracts stream links.
 * The URL does not need to be immediately after #EXTINF.
 * For example, #EXTGRP lines between the title and URL are supported.
 * @param {string} m3uContent
 * @returns {Array<{
 *   title: string,
 *   url: string,
 *   originalIndex: number,
 *   originalTitleLineIndex: number
 * }>}
 */
function parseM3UContent(m3uContent) {
  const originalLines = m3uContent.split(/\r?\n/);
  const linksToProcess = [];
  let currentTitle = '';
  let currentTitleLineIndex = -1;

  for (let i = 0; i < originalLines.length; i++) {
    const line = originalLines[i].trim();
    if (line.startsWith('#EXTINF')) {
      currentTitle = line;
      currentTitleLineIndex = i;
      continue;
    }
    if (line.startsWith('http://') || line.startsWith('https://')) {
      linksToProcess.push({
        title: currentTitle,
        url: line,
        originalIndex: i,
        originalTitleLineIndex: currentTitleLineIndex,
      });
      currentTitle = '';
      currentTitleLineIndex = -1;
    }
  }
  return linksToProcess;
}

/**
 * Performs one HTTP request with a timeout.
 * @param {string} url
 * @param {object} options
 * @returns {Promise<Response>}
 */
async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    controller.abort();
  }, linkTimeout);

  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal,
      redirect: 'manual',
      headers: {
        'User-Agent': USER_AGENT,
        Accept: '*/*',
        ...(options.headers || {}),
      },
    });
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Checks a URL with HEAD first.
 * Some streaming servers reject HEAD with 405 or 501 even though GET works,
 * so those responses fall back to a small ranged GET request.
 * @param {string} url
 * @returns {Promise<Response>}
 */
async function requestUrl(url) {
  let response = await fetchWithTimeout(url, {
    method: 'HEAD',
  });

  if (response.status === 405 || response.status === 501) {
    response = await fetchWithTimeout(url, {
      method: 'GET',
      headers: {
        Range: 'bytes=0-0',
      },
    });
    // Do not download the complete stream.
    try {
      await response.body?.cancel();
    } catch {
      // Ignore body cancellation errors.
    }
  }
  return response;
}

/** 
 * Checks a single stream link, following redirects.
 * @param {{
 *   title: string,
 *   url: string,
 *   originalIndex: number,
 *   originalTitleLineIndex: number
 * }} item
 * @param {string} fileName
 * @param {boolean} quiet
 * @param {number} redirectCount
 * @returns {Promise<{
 *   url: string,
 *   status: number|string,
 *   finalUrl?: string
 * }>}
 */
async function checkSingleLink(
  item,
  fileName,
  quiet = false,
  redirectCount = 0,
) {
  let response;
  try {
    response = await requestUrl(item.url);
    const isRedirect =
      response.status >= 300 &&
      response.status < 400 &&
      response.headers.has('location');

    if (isRedirect && redirectCount < maxRedirects) {
      const redirectUrl = response.headers.get('location');
      const absoluteRedirectUrl = new URL(redirectUrl, item.url).href;
      if (!quiet) {
        console.log(
          `[${fileName}] Redirect ${response.status}: ${item.url} -> ${absoluteRedirectUrl} (attempt ${redirectCount + 1}/${maxRedirects})`,
        );
      }
      return checkSingleLink(
        {
          ...item,
          url: absoluteRedirectUrl,
        },
        fileName,
        quiet,
        redirectCount + 1,
      );
    }

    // Treat all 2xx responses as alive.
    if (response.status >= 200 && response.status < 300) {
      if (!quiet) {
        console.log(
          `[${fileName}] Status ${response.status}: ${item.url}`,
        );
      }
      return {
        url: item.url,
        status: response.status,
        finalUrl: item.url,
      };
    }

    if (!quiet) {
      console.log(
        `[${fileName}] Status ${response.status}: ${item.url}`,
      );
    }
    return {
      url: item.url,
      status: response.status,
    };
  } catch (error) {
    if (error?.name === 'AbortError') {
      if (!quiet) {
        console.log(`[${fileName}] Timed out: ${item.url}`);
      }
      return {
        url: item.url,
        status: 'timedout',
      };
    }
    if (!quiet) {
      console.log(
        `[${fileName}] Error (${error.message}): ${item.url}`,
      );
    }
    return {
      url: item.url,
      status: 'invalid',
    };
  } finally {
    // 🔥 CRITICAL FIX FOR NODE.JS FETCH 🔥
    // We must cancel the response body to release the TCP socket back to the OS.
    // If we don't, the open sockets will keep the Node.js event loop alive
    // and the GitHub Action will hang forever after finishing its work.
    if (response?.body) {
      try {
        await response.body.cancel();
      } catch {
        // Ignore errors if the body was already consumed or canceled
      }
    }
  }
}

/**
 * Processes links using the shared global limiter.
 * @param {Array} linksToProcess
 * @param {string} fileName
 * @param {boolean} quiet
 * @param {(task: () => Promise<any>) => Promise<any>} limiter
 * @returns {Promise<Map<number, {titleLine: string, urlLine: string}>>}
 */
async function processLinks(
  linksToProcess,
  fileName,
  quiet,
  limiter,
) {
  const validLinks = new Map();
  let nextIndex = 0;

  async function worker() {
    while (true) {
      // Stop accepting new work once the runtime limit is reached.
      if (timeUp) {
        return;
      }
      const currentIndex = nextIndex++;
      if (currentIndex >= linksToProcess.length) {
        return;
      }
      const item = linksToProcess[currentIndex];

      const result = await limiter(async () => {
        // Double-check after waiting for a concurrency slot.
        if (timeUp) {
          return null;
        }
        stats.inFlight++;
        try {
          return await checkSingleLink(item, fileName, quiet);
        } finally {
          stats.inFlight--;
        }
      });

      // A null result means we aborted due to the time limit.
      if (result === null) {
        continue;
      }

      recordResult(result?.status, fileName);

      if (
        result &&
        typeof result.status === 'number' &&
        result.status >= 200 &&
        result.status < 300
      ) {
        validLinks.set(item.originalIndex, {
          titleLine: item.title,
          urlLine: result.finalUrl || item.url,
        });
      }
    }
  }

  // One worker per available global slot, capped by this file's link count.
  const workerCount = Math.min(
    concurrencyLimit,
    linksToProcess.length,
  );
  await Promise.all(
    Array.from({ length: workerCount }, () => worker()),
  );
  return validLinks;
}

/**
 * Finds the next HTTP/HTTPS URL after an #EXTINF line.
 * It stops if another #EXTINF is found first.
 * @param {string[]} lines
 * @param {number} titleIndex
 * @returns {number}
 */
function findNextUrlIndex(lines, titleIndex) {
  for (let i = titleIndex + 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.startsWith('#EXTINF')) {
      return -1;
    }
    if (line.startsWith('http://') || line.startsWith('https://')) {
      return i;
    }
  }
  return -1;
}

/**
 * Generates the cleaned M3U playlist.
 * Validated stream entries are retained. Invalid stream entries are removed.
 * Non-stream lines are preserved where practical.
 * @param {string} originalM3uContent
 * @param {Map<number, {titleLine: string, urlLine: string}>} validLinks
 * @returns {string}
 */
function generateOutputM3U(originalM3uContent, validLinks) {
  const originalLines = originalM3uContent.split(/\r?\n/);
  const outputLines = ['#EXTM3U'];

  for (let i = 0; i < originalLines.length; i++) {
    const rawLine = originalLines[i];
    const line = rawLine.trim();

    if (line.length === 0) {
      continue;
    }
    if (line.startsWith('#EXTM3U')) {
      continue;
    }
    if (line.startsWith('#EXTINF')) {
      const urlIndex = findNextUrlIndex(originalLines, i);
      if (urlIndex !== -1 && validLinks.has(urlIndex)) {
        const { titleLine, urlLine } = validLinks.get(urlIndex);
        outputLines.push(titleLine);
        // Preserve lines such as #EXTGRP between #EXTINF and the URL.
        for (let j = i + 1; j < urlIndex; j++) {
          const intermediateLine = originalLines[j].trim();
          if (
            intermediateLine.length > 0 &&
            !intermediateLine.startsWith('http://') &&
            !intermediateLine.startsWith('https://') &&
            !intermediateLine.startsWith('#EXTINF')
          ) {
            outputLines.push(intermediateLine);
          }
        }
        outputLines.push(urlLine);
        // Skip all lines belonging to this entry.
        i = urlIndex;
      } else {
        // Skip invalid #EXTINF entries and their associated URL.
        if (urlIndex !== -1) {
          i = urlIndex;
        }
      }
      continue;
    }
    if (line.startsWith('http://') || line.startsWith('https://')) {
      if (validLinks.has(i)) {
        const { urlLine } = validLinks.get(i);
        outputLines.push(urlLine);
      }
      continue;
    }
    // Preserve other playlist metadata and comments.
    outputLines.push(line);
  }
  return `${outputLines.join('\n')}\n`;
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
 * @param {(task: () => Promise<any>) => Promise<any>} limiter
 */
async function processFile(
  inputDir,
  outputDir,
  fileName,
  quiet,
  limiter,
) {
  // Bail early if the global time limit was already hit before this file started.
  if (timeUp) {
    if (!quiet) {
      console.log(
        `[${fileName}] Skipped (runtime limit already reached).`,
      );
    }
    return;
  }

  const fullPath = path.join(inputDir, fileName);
  const originalM3uContent = await fs.readFile(fullPath, 'utf8');
  const linksToProcess = parseM3UContent(originalM3uContent);

  // Register this file with the progress reporter.
  stats.filesParsed++;
  // Note: totalLinks is already set from the pre-count; we do not add again.
  stats.activeFiles.set(fileName, {
    total: linksToProcess.length,
    checked: 0,
    alive: 0,
  });

  if (!quiet) {
    console.log(
      `[${fileName}] Found ${linksToProcess.length} stream links.`,
    );
  }

  /**
   * Removes the source playlist from the input folder once it has been
   * fully processed. This lets subsequent runs resume with only the
   * remaining unchecked files.
   */
  async function removeFromInput() {
    try {
      await fs.unlink(fullPath);
      if (!quiet) {
        console.log(`[${fileName}] Removed from input folder.`);
      }
    } catch (err) {
      console.warn(
        `[${fileName}] Could not remove input file: ${err.message}`,
      );
    }
  }

  if (linksToProcess.length === 0) {
    const outputM3uContent = generateOutputM3U(
      originalM3uContent,
      new Map(),
    );
    if (outputM3uContent.trim() !== '#EXTM3U') {
      const outputPath = path.join(outputDir, fileName);
      await fs.mkdir(path.dirname(outputPath), { recursive: true });
      await fs.writeFile(
        outputPath,
        outputM3uContent,
        'utf8',
      );
      if (!quiet) {
        console.log(
          `[${fileName}] No stream links found. Saved metadata output.`,
        );
      }
    } else if (!quiet) {
      console.log(
        `[${fileName}] No stream links or meaningful content. Skipped.`,
      );
    }
    if (quiet) {
      console.log(`${fileName} checked - 0/0 streams were alive`);
    }
    // Fully processed (nothing to check) → remove from input.
    await removeFromInput();
    return;
  }

  const validLinks = await processLinks(
    linksToProcess,
    fileName,
    quiet,
    limiter,
  );

  // Decide whether this file finished completely.
  const fileInfo = stats.activeFiles.get(fileName);
  const fullyChecked =
    fileInfo && fileInfo.checked === fileInfo.total;

  // If the time limit interrupted this file, keep it in the input folder
  // so a later run can finish the remaining links.
  if (timeUp && !fullyChecked) {
    if (!quiet) {
      console.log(
        `[${fileName}] Incomplete due to runtime limit (${fileInfo ? fileInfo.checked : 0}/${linksToProcess.length} checked). Keeping in input folder.`,
      );
    } else {
      console.log(
        `${fileName} incomplete - ${fileInfo ? fileInfo.checked : 0}/${linksToProcess.length} checked (time limit)`,
      );
    }
    return;
  }

  const validStreamCount = validLinks.size;
  if (quiet) {
    console.log(
      `${fileName} checked - ${validStreamCount}/${linksToProcess.length} streams were alive`,
    );
  } else {
    console.log(
      `[${fileName}] Complete: ${validStreamCount}/${linksToProcess.length} streams alive.`,
    );
  }

  if (validStreamCount === 0) {
    if (!quiet) {
      console.log(`[${fileName}] No valid streams. Output skipped.`);
    }
    // Fully checked and nothing usable → still remove from input.
    await removeFromInput();
    return;
  }

  const outputM3UContent = generateOutputM3U(
    originalM3uContent,
    validLinks,
  );

  if (outputM3UContent.trim() === '#EXTM3U') {
    if (!quiet) {
      console.warn(
        `[${fileName}] Valid links were found, but output was empty. Skipped.`,
      );
    }
    await removeFromInput();
    return;
  }

  const outputPath = path.join(outputDir, fileName);
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(
    outputPath,
    outputM3UContent,
    'utf8',
  );

  if (!quiet) {
    console.log(`[${fileName}] Saved to "${outputPath}"`);
  }

  // Fully processed and written → remove from input so the next run
  // only sees remaining unchecked playlists.
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
        results.push(
          path.relative(rootDir, fullPath).split(path.sep).join('/'),
        );
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
 */
async function main(inputDir, outputDir, quiet = false) {
  await fs.mkdir(outputDir, { recursive: true });
  const m3uFiles = await collectM3UFiles(inputDir, [outputDir]);

  if (m3uFiles.length === 0) {
    if (!quiet) {
      console.log(
        `No .m3u or .m3u8 files found in "${inputDir}" (searched recursively)`,
      );
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
      const fullPath = path.join(inputDir, fileName);
      const content = await fs.readFile(fullPath, 'utf8');
      const linkCount = parseM3UContent(content).length;
      return { fileName, linkCount };
    }),
  );
  filesWithCounts.sort(
    (a, b) => a.linkCount - b.linkCount || a.fileName.localeCompare(b.fileName),
  );
  const sortedM3uFiles = filesWithCounts.map((f) => f.fileName);

  // Set totalLinks once from the pre-count so progress/ETA is accurate
  // from the very first report (no more "estimating...").
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
        `Stopping new link checks. Fully checked playlists have been removed from input.`,
    );
    printProgress(false);
  }, MAX_RUNTIME_MS);

  // One global link-level limiter is shared by every file.
  const limiter = createLimiter(concurrencyLimit);

  try {
    // Hybrid: keep up to `fileConcurrency` playlists in flight at once.
    // Files are taken from the sorted list (smallest first). When one
    // finishes, the next-smallest unstarted file is started immediately.
    // This keeps the link-level concurrency saturated while still
    // finishing small playlists preferentially.
    let nextIndex = 0;
    const workers = [];

    async function fileWorker() {
      while (true) {
        if (timeUp) return;
        const index = nextIndex++;
        if (index >= sortedM3uFiles.length) return;

        const fileName = sortedM3uFiles[index];
        try {
          await processFile(
            inputDir,
            outputDir,
            fileName,
            quiet,
            limiter,
          );
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
      '\n--- Runtime limit reached. Remaining unchecked playlists are still in the input folder ---',
    );
  } else if (!quiet) {
    console.log('\n--- All M3U files processed ---');
  }
}

// Parse command-line arguments.
let quiet = false;
const filteredArgs = [];
for (const arg of process.argv.slice(2)) {
  if (arg === '--quiet') {
    quiet = true;
  } else {
    filteredArgs.push(arg);
  }
}

const inputDirectory = filteredArgs[0] || 'm3u-files';
const outputDirectory = filteredArgs[1] || 'm3u-checked';

if (!quiet) {
  console.log('Starting M3U Link Checker...');
  console.log(`Input Directory: ${inputDirectory}`);
  console.log(`Output Directory: ${outputDirectory}`);
  console.log(`Link concurrency: ${concurrencyLimit}`);
  console.log(`File concurrency: ${fileConcurrency}`);
  console.log(`Timeout: ${linkTimeout}ms`);
  console.log(`Progress interval: ${progressInterval}ms`);
  console.log(`Max runtime: ${formatDuration(MAX_RUNTIME_MS)}`);
}

main(inputDirectory, outputDirectory, quiet).catch((error) => {
  console.error('An error occurred:', error);
  process.exitCode = 1;
});
