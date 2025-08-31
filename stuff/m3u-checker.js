// m3u-checker.js
// made with Gemini 2.5 Flash via https://t3.chat/ free tier - thanks
// usage example:
// node ./m3u-checker.js -> this expects m3u files in "m3u-files" folder and puts output files in "m3u-checked"
// or
// node ./m3u-checker.js input_folder/ output_folder/

const fs = require('fs/promises');
const path = require('path');

const concurrencyLimit = 10;
const linkTimeout = 5000; // 5 seconds timeout for each link
const maxRedirects = 3; // Maximum number of redirections to follow

/**
 * Parses M3U content and extracts stream links with their associated titles.
 * @param {string} m3uContent - The raw M3U playlist content.
 * @returns {Array<{title: string, url: string, originalIndex: number, originalTitleLineIndex: number}>} An array of stream objects.
 */
function parseM3UContent(m3uContent) {
  const originalLines = m3uContent.split('\n');
  const linksToProcess = [];

  let currentTitle = '';
  let currentTitleLineIndex = -1;

  for (let i = 0; i < originalLines.length; i++) {
    const line = originalLines[i].trim();

    if (line.startsWith('#EXTINF')) {
      currentTitle = line;
      currentTitleLineIndex = i;
    } else if (line.startsWith('http://') || line.startsWith('https://')) { // Explicitly check for http/https
      linksToProcess.push({
        title: currentTitle,
        url: line,
        originalIndex: i,
        originalTitleLineIndex: currentTitleLineIndex,
      });
      currentTitle = '';
      currentTitleLineIndex = -1;
    }
    // Any other lines (like #EXTGRP, comments, etc.) are ignored by this parser,
    // which is the correct behavior for identifying stream links.
  }
  return linksToProcess;
}

/**
 * Checks a single stream link for its availability, following redirects.
 * @param {{title: string, url: string, originalIndex: number, originalTitleLineIndex: number}} item - The stream item.
 * @param {string} fileName - The name of the file being processed (for logging).
 * @param {number} redirectCount - Current redirection count.
 * @returns {Promise<{url: string, status: number|string, finalUrl?: string}>} The URL, its status, and the final URL after redirects.
 */
async function checkSingleLink(item, fileName, redirectCount = 0) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), linkTimeout);

  try {
    const response = await fetch(item.url, {
      method: 'HEAD',
      signal: controller.signal,
      redirect: 'manual', // Manually handle redirects
    });
    clearTimeout(timeoutId);

    // Handle redirects
    if (
      response.status >= 300 &&
      response.status < 400 &&
      response.headers.has('location') &&
      redirectCount < maxRedirects
    ) {
      const redirectUrl = response.headers.get('location');
      const absoluteRedirectUrl = new URL(redirectUrl, item.url).href; // Resolve relative redirects
      console.log(
        `  [${fileName}] - Redirect (${response.status}): ${item.url} -> ${absoluteRedirectUrl} (Attempt ${redirectCount + 1}/${maxRedirects})`,
      );
      // Recursively call checkSingleLink with the new URL
      return await checkSingleLink(
        { ...item, url: absoluteRedirectUrl },
        fileName,
        redirectCount + 1,
      );
    }

    // If it's a successful non-redirecting link or after max redirects
    if (response.status === 200) {
      console.log(`  [${fileName}] - Status ${response.status}: ${item.url}`);
      return { url: item.url, status: response.status, finalUrl: item.url };
    } else {
      console.log(`  [${fileName}] - Status ${response.status}: ${item.url}`);
      return { url: item.url, status: response.status };
    }
  } catch (error) {
    clearTimeout(timeoutId);
    if (error.name === 'AbortError') {
      console.log(`  [${fileName}] - Timed out: ${item.url}`);
      return { url: item.url, status: 'timedout' };
    }
    console.log(`  [${fileName}] - Invalid/Error (${error.message}): ${item.url}`);
    return { url: item.url, status: 'invalid' };
  }
}

/**
 * Processes a list of stream links with a concurrency limit.
 * @param {Array<{title: string, url: string, originalIndex: number, originalTitleLineIndex: number}>} linksToProcess - Array of stream objects.
 * @param {string} fileName - The name of the file being processed.
 * @returns {Promise<Map<number, {titleLine: string, urlLine: string}>>} A map of valid links.
 */
async function processLinks(linksToProcess, fileName) {
  const tempValidLinks = new Map();
  const activePromises = new Set();
  let linksProcessedCount = 0;

  for (let i = 0; i < linksToProcess.length; i++) {
    const item = linksToProcess[i];
    const promise = checkSingleLink(item, fileName).then((result) => {
      // We only care about successful 200 status AFTER all redirects
      if (result && result.status === 200) {
        // Store the final valid URL if a redirection occurred, otherwise the original
        const urlToStore = result.finalUrl || item.url;
        tempValidLinks.set(item.originalIndex, {
          titleLine: item.title,
          urlLine: urlToStore, // Use the final validated URL
        });
      }
      linksProcessedCount++;
      // console.log(`  [${fileName}] - Processed ${linksProcessedCount}/${linksToProcess.length}`);
      activePromises.delete(promise);
      return result;
    });

    activePromises.add(promise);

    if (activePromises.size >= concurrencyLimit) {
      await Promise.race(Array.from(activePromises));
    }
  }

  await Promise.allSettled(Array.from(activePromises));
  return tempValidLinks;
}

/**
 * Generates the content for the checked M3U playlist.
 * @param {string} originalM3uContent - The original M3U content.
 * @param {Map<number, {titleLine: string, urlLine: string}>} tempValidLinks - Map of valid links by their original line index, with potentially updated URLs.
 * @returns {string} The content of the cleaned M3U playlist.
 */
function generateOutputM3U(originalM3uContent, tempValidLinks) {
  const originalLines = originalM3uContent.split('\n');
  const validLinksContent = [];
  const finalOutputLines = new Set(); // Use a Set to avoid duplicate lines in output

  validLinksContent.push('#EXTM3U');
  finalOutputLines.add('#EXTM3U'); // Add it to the set to prevent re-adding if found later

  for (let i = 0; i < originalLines.length; i++) {
    const line = originalLines[i].trim();

    if (line.startsWith('#EXTM3U')) {
      continue; // Skip the original #EXTM3U as we added it at the beginning
    }

    if (line.startsWith('#EXTINF')) {
      const nextLineIndex = i + 1;
      if (nextLineIndex < originalLines.length) {
        const nextLine = originalLines[nextLineIndex].trim();
        // Check if the current #EXTINF has a corresponding valid URL on the next line
        // The key in tempValidLinks is the index of the URL line itself.
        if ((nextLine.startsWith('http://') || nextLine.startsWith('https://')) && tempValidLinks.has(nextLineIndex)) {
          const { titleLine, urlLine } = tempValidLinks.get(nextLineIndex);
          if (!finalOutputLines.has(titleLine)) {
            validLinksContent.push(titleLine);
            finalOutputLines.add(titleLine);
          }
          // Here, we use the potentially updated `urlLine` from `tempValidLinks`
          if (!finalOutputLines.has(urlLine)) {
            validLinksContent.push(urlLine);
            finalOutputLines.add(urlLine);
          }
          i = nextLineIndex; // Skip the URL line as it's already processed with its #EXTINF
        }
      }
    } else if (line.startsWith('http://') || line.startsWith('https://')) {
      // Handle standalone HTTP links without an #EXTINF line immediately above
      if (tempValidLinks.has(i)) {
        // Here, we use the potentially updated `urlLine` from `tempValidLinks`
        const { urlLine } = tempValidLinks.get(i);
        if (!finalOutputLines.has(urlLine)) {
          validLinksContent.push(urlLine);
          finalOutputLines.add(urlLine);
        }
      }
    } else {
      // Preserve other lines that are not #EXTINF or http links, e.g., comments, empty lines
      if (line.trim() !== '' && !finalOutputLines.has(line)) {
        validLinksContent.push(line);
        finalOutputLines.add(line);
      }
    }
  }
  return validLinksContent.join('\n');
}

/**
 * Main function to read, process, and write M3U files.
 * @param {string} inputDir - The directory containing M3U files.
 * @param {string} outputDir - The directory to save checked M3U files.
 */
async function main(inputDir, outputDir) {
  try {
    // Ensure output directory exists
    await fs.mkdir(outputDir, { recursive: true });

    const files = await fs.readdir(inputDir);
    const m3uFiles = files.filter(
      (file) => file.endsWith('.m3u') || file.endsWith('.m3u8'),
    );

    if (m3uFiles.length === 0) {
      console.log(`No .m3u or .m3u8 files found in "${inputDir}"`);
      return;
    }

    console.log(`Found ${m3uFiles.length} M3U files to check in "${inputDir}".`);

    for (const fileName of m3uFiles) {
      console.log(`\n--- Checking "${fileName}" ---`);
      const fullPath = path.join(inputDir, fileName);
      const originalM3uContent = await fs.readFile(fullPath, 'utf8');

      const linksToProcess = parseM3UContent(originalM3uContent);
      console.log(`  Found ${linksToProcess.length} stream links.`);

      if (linksToProcess.length === 0) {
        console.log(`  No stream links found in "${fileName}". Copying as-is.`);
        await fs.writeFile(
          path.join(outputDir, fileName),
          originalM3uContent,
          'utf8',
        );
        continue;
      }

      const tempValidLinks = await processLinks(linksToProcess, fileName);

      const validStreamCount = tempValidLinks.size;
      console.log(
        `  Check complete for "${fileName}". Found ${validStreamCount} valid streams out of ${linksToProcess.length}.`,
      );

      const outputFileName = fileName;
      const outputPath = path.join(outputDir, outputFileName);
      const outputM3uContent = generateOutputM3U(
        originalM3uContent,
        tempValidLinks,
      );

      await fs.writeFile(outputPath, outputM3uContent, 'utf8');
      console.log(`  Saved checked playlist to "${outputPath}"`);
    }
    console.log('\n--- All M3U files processed ---');
  } catch (error) {
    console.error('An error occurred:', error);
    process.exit(1);
  }
}

// Get input and output directories from command-line arguments
const args = process.argv.slice(2);
const inputDirectory = args[0] || 'm3u-files';
const outputDirectory = args[1] || 'm3u-checked'; // Default output directory

console.log(`Starting M3U Link Checker...`);
console.log(`Input Directory: ${inputDirectory}`);
console.log(`Output Directory: ${outputDirectory}`);

main(inputDirectory, outputDirectory);
