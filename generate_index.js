const fs = require("fs");
const path = require("path");
const { execFileSync, spawn } = require("child_process");

// Running inside GitHub Actions (or any CI)? Then incomplete Git history is a
// hard failure instead of a quiet fallback, because file dates would be wrong.
const IN_CI = !!(process.env.GITHUB_ACTIONS || process.env.CI);

// Executable and binary extensions to exclude (all lowercase: the extension
// is lowercased before it is looked up here).
const EXECUTABLE_EXTENSIONS = new Set([
  // Windows
  ".exe", ".dll", ".msi", ".com", ".bat", ".cmd", ".scr", ".pif", ".gadget",
  // macOS
  ".app", ".dmg", ".pkg", ".dsym",
  // Linux
  ".bin", ".run", ".deb", ".rpm", ".snap", ".flatpak", ".appimage",
  // Shared libraries
  ".so", ".dylib", ".a", ".lib", ".ko",
  // Compiled objects
  ".o", ".obj", ".pyc", ".pyo", ".class", ".elf", ".out",
  // Other executables
  ".jar", ".war", ".ear", ".vbs", ".vbe", ".ws", ".wsf", ".msc", ".lnk",
]);

// Directories to skip.
const EXCLUDED_DIRS = new Set([
  ".git", "node_modules", ".github", "__pycache__", ".vscode", ".idea",
  ".cache", ".npm", ".yarn", "vendor", ".bundle",
]);

// Files whose name starts with this are indexed but not deployed. The viewer
// loads them directly from the repository's raw-content URL instead.
const EXTERNAL_PREFIX = "---";

// System/meta files to skip.
const EXCLUDED_FILES = new Set([
  "generate_index.js", "file_index.json", ".DS_Store", "Thumbs.db",
  "desktop.ini", ".gitignore", ".gitattributes", "package-lock.json",
  "yarn.lock", "pnpm-lock.yaml",
]);

// File type categories. An extension is matched against the categories in
// this order and the FIRST match wins. Keep each extension in one category.
function getFileCategory(filename) {
  const ext = path.extname(filename).toLowerCase();

  const categories = {
    image: [
      ".jpg", ".jpeg", ".png", ".gif", ".bmp", ".svg", ".webp", ".ico",
      ".tiff", ".tif", ".avif", ".heic", ".heif",
    ],
    video: [
      // .ogg is deliberately NOT here: in practice it is audio (Vorbis/Opus).
      // Video-in-Ogg uses .ogv.
      ".mp4", ".webm", ".ogv", ".mov", ".avi", ".mkv", ".m4v",
      ".3gp", ".flv",
    ],
    audio: [
      ".mp3", ".wav", ".ogg", ".oga", ".flac", ".aac", ".m4a", ".wma",
      ".opus", ".aiff",
    ],
    document: [".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx"],
    code: [
      ".js", ".ts", ".jsx", ".tsx", ".py", ".rb", ".java", ".c", ".cpp",
      ".h", ".hpp", ".cs", ".go", ".rs", ".php", ".swift", ".kt", ".scala",
      ".r", ".m", ".mm", ".pl", ".pm", ".lua", ".sh", ".bash", ".zsh",
      ".fish", ".ps1", ".psm1", ".vue", ".svelte", ".elm", ".clj", ".cljs",
      ".ex", ".exs", ".erl", ".hrl", ".hs", ".fs", ".fsx", ".ml", ".mli",
      ".nim", ".cr", ".v", ".zig", ".d", ".pas", ".pp", ".asm", ".s",
      ".sql", ".graphql", ".gql",
    ],
    markup: [
      ".html", ".htm", ".xml", ".xhtml", ".xaml", ".wxml", ".jsp",
      ".asp", ".aspx", ".erb", ".ejs", ".haml", ".slim", ".pug", ".jade",
      ".twig", ".hbs", ".mustache", ".njk", ".liquid",
    ],
    style: [".css", ".scss", ".sass", ".less", ".styl", ".stylus", ".postcss"],
    data: [
      ".json", ".yaml", ".yml", ".toml", ".ini", ".cfg", ".conf",
      ".properties", ".env", ".csv", ".tsv",
      // Playlist files (plain text).
      ".m3u", ".m3u8", ".pls", ".xspf", ".wpl", ".asx", ".cue",
    ],
    text: [
      ".txt", ".md", ".markdown", ".rst", ".rtf", ".log", ".nfo", ".diz",
      ".srt", ".vtt", ".sub", ".ass", ".ssa",
    ],
    font: [".ttf", ".otf", ".woff", ".woff2", ".eot"],
    archive: [
      ".zip", ".tar", ".gz", ".bz2", ".xz", ".7z", ".rar", ".tgz", ".tbz2",
    ],
  };

  for (const [category, extensions] of Object.entries(categories)) {
    if (extensions.includes(ext)) return category;
  }

  return "other";
}

function isExecutable(filename) {
  return EXECUTABLE_EXTENSIONS.has(path.extname(filename).toLowerCase());
}

// Whether a tracked Git path would be eligible for the browser index. This
// mirrors the directory/file exclusions in scanDirectory().
function isIndexableGitPath(filePath) {
  const parts = filePath.split("/");
  const filename = parts[parts.length - 1];

  if (!filename || filename.startsWith(".")) return false;
  if (EXCLUDED_FILES.has(filename) || isExecutable(filename)) return false;

  for (const dirname of parts.slice(0, -1)) {
    if (EXCLUDED_DIRS.has(dirname) || dirname.startsWith(".")) return false;
  }

  return true;
}

function gitExecBuffer(args, maxBuffer = 256 * 1024 * 1024) {
  return execFileSync("git", args, {
    encoding: "buffer",
    maxBuffer,
    stdio: ["ignore", "pipe", "ignore"],
  });
}

// Read the current commit's tree without opening file blobs. This works with
// the workflow's blob:none partial clone, including files omitted from the
// working tree by sparse checkout.
function getTrackedBlobEntries() {
  let output;
  try {
    output = gitExecBuffer(["ls-tree", "-r", "-z", "HEAD"]);
  } catch (error) {
    if (IN_CI) throw new Error("Could not read the current Git tree: " + error.message);
    console.warn("Could not read the current Git tree; using filesystem-only indexing.");
    return null;
  }

  const entries = [];

  for (const record of output.toString("utf8").split("\0")) {
    if (!record) continue;
    const tab = record.indexOf("\t");
    if (tab < 0) continue;

    const metadata = record.slice(0, tab).split(" ");
    const filePath = record.slice(tab + 1);
    const mode = metadata[0];
    const type = metadata[1];

    if (type === "blob") entries.push({ mode, path: filePath });
  }

  return entries;
}

function assertCompleteHistory() {
  if (!IN_CI) return;

  try {
    const shallow = execFileSync("git", ["rev-parse", "--is-shallow-repository"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();

    if (shallow !== "false") {
      throw new Error(
        "Repository history is shallow. The workflow must fetch the full " +
        "ancestry of the checked-out commit (with blob:none)."
      );
    }
  } catch (error) {
    throw new Error("Could not verify complete Git history: " + error.message);
  }
}

// Find the newest commit touching each CURRENT tracked path. The log is read
// as a stream and stopped as soon as every current path has been found. This
// avoids buffering the entire repository history and avoids walking old,
// deleted paths after all indexed files already have dates.
function buildFileDateMap(currentPaths) {
  assertCompleteHistory();

  const dates = new Map();
  const pending = new Set(currentPaths);
  if (pending.size === 0) return Promise.resolve(dates);

  return new Promise((resolve, reject) => {
    const child = spawn("git", [
      "-c", "core.quotepath=false",
      "--no-pager",
      "log",
      "--name-only",
      "--no-renames",
      "-z",
      "--format=%x01%cI",
    ], { stdio: ["ignore", "pipe", "pipe"] });

    let currentDate = null;
    let intentionallyStopped = false;
    let buffer = "";
    let stderr = "";

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
      if (stderr.length > 16000) stderr = stderr.slice(-16000);
    });

    const consumeToken = (token) => {
      if (intentionallyStopped || !token) return;

      if (token.startsWith("\x01")) {
        const parsed = new Date(token.slice(1).trim());
        currentDate = Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
        return;
      }

      // Git's pretty-format separator contributes one newline before the
      // first pathname in each commit. Remove only that separator; with -z,
      // any newline that is actually part of a filename remains intact.
      const filePath = token.startsWith("\n") ? token.slice(1) : token;
      if (!currentDate || !filePath || !pending.delete(filePath)) return;

      dates.set(filePath, currentDate);
      if (pending.size === 0) {
        intentionallyStopped = true;
        child.kill("SIGTERM");
      }
    };

    child.stdout.on("data", (chunk) => {
      if (intentionallyStopped) return;
      buffer += chunk;

      let separator;
      while (!intentionallyStopped && (separator = buffer.indexOf("\0")) !== -1) {
        const token = buffer.slice(0, separator);
        buffer = buffer.slice(separator + 1);
        consumeToken(token);
      }
    });

    child.on("error", (error) => {
      reject(new Error("Could not start git log: " + error.message));
    });

    child.on("close", (code, signal) => {
      if (pending.size === 0 && intentionallyStopped) {
        resolve(dates);
        return;
      }

      // The final token is normally empty because Git terminates path output
      // with NUL, but consume it defensively if a Git version omits that byte.
      if (buffer) consumeToken(buffer);
      if (pending.size === 0 && code === 0) {
        resolve(dates);
        return;
      }

      const missing = Array.from(pending).slice(0, 8);
      const detail = stderr.trim() || `git log exited with code ${code} (${signal || "no signal"})`;
      const message =
        `Could not obtain modification dates for ${pending.size} current file(s). ` +
        `Examples: ${missing.join(", ")}. ${detail}`;

      if (IN_CI) reject(new Error(message));
      else {
        console.warn(message + " (those files will use filesystem modification times)");
        resolve(dates);
      }
    });
  });
}

// Sparse checkout leaves external-prefix blobs out of the worktree. Their
// exact sizes are still needed by the viewer, so read those sizes from the
// GitHub Git Trees API (tree metadata; no file contents are downloaded).
async function getMissingExternalEntries(trackedEntries, fileDateMap) {
  const missing = trackedEntries.filter(({ path: filePath }) => {
    if (!isIndexableGitPath(filePath)) return false;
    if (!path.posix.basename(filePath).startsWith(EXTERNAL_PREFIX)) return false;

    try {
      fs.lstatSync(filePath);
      return false; // Present locally; scanDirectory() will index it.
    } catch (error) {
      if (error.code === "ENOENT") return true;
      throw error;
    }
  });

  if (missing.length === 0) return [];

  const repository = process.env.GITHUB_REPOSITORY;
  const token = process.env.GITHUB_TOKEN;
  if (!repository) {
    throw new Error(
      `Found ${missing.length} external file(s) missing from the working tree, ` +
      "but GITHUB_REPOSITORY is unavailable. Run the workflow or use a full checkout."
    );
  }

  const treeSha = execFileSync("git", ["rev-parse", "HEAD^{tree}"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
  const url = `https://api.github.com/repos/${repository}/git/trees/${treeSha}?recursive=1`;
  const headers = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  const response = await fetch(url, { headers });
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 1200);
    throw new Error(
      `GitHub tree API request failed (${response.status} ${response.statusText}): ${detail}`
    );
  }

  const treeData = await response.json();
  if (treeData.truncated) {
    throw new Error(
      "GitHub returned a truncated recursive tree (the API caps recursive trees at " +
      "100,000 entries / 7 MB). Refusing to publish external files with missing or " +
      "incorrect sizes. This repository needs a non-recursive tree lookup for its " +
      "external-file directories."
    );
  }

  const requested = new Set(missing.map((entry) => entry.path));
  const sizes = new Map();
  for (const entry of treeData.tree || []) {
    if (entry.type === "blob" && requested.has(entry.path) && Number.isSafeInteger(entry.size)) {
      sizes.set(entry.path, entry.size);
    }
  }

  const unresolved = missing.filter(({ path: filePath }) => !sizes.has(filePath));
  if (unresolved.length) {
    throw new Error(
      "GitHub tree metadata did not return sizes for: " +
      unresolved.slice(0, 8).map((entry) => entry.path).join(", ")
    );
  }

  return missing.map(({ path: filePath }) => {
    const modified = fileDateMap.get(filePath);
    if (!modified && IN_CI) {
      throw new Error(`No Git history date was found for external file: ${filePath}`);
    }

    return {
      path: filePath,
      entry: {
        name: path.posix.basename(filePath),
        type: "file",
        category: getFileCategory(filePath),
        size: sizes.get(filePath),
        modified: modified || new Date().toISOString(),
        external: 1,
      },
    };
  });
}

function scanDirectory(dir, relativePath = "", indexedPaths = new Set(), fileDateMap = new Map()) {
  const entries = [];

  try {
    const items = fs.readdirSync(dir, { withFileTypes: true });

    for (const item of items) {
      const fullPath = path.join(dir, item.name);
      const itemRelativePath = relativePath
        ? `${relativePath}/${item.name}`
        : item.name;

      if (item.isDirectory()) {
        if (EXCLUDED_DIRS.has(item.name) || item.name.startsWith(".")) continue;

        const children = scanDirectory(fullPath, itemRelativePath, indexedPaths, fileDateMap);
        if (children.length > 0) {
          let latest = null;
          for (const child of children) {
            if (child.modified && (!latest || child.modified > latest)) latest = child.modified;
          }
          entries.push({
            name: item.name,
            type: "directory",
            children,
            modified: latest,
          });
        }
        continue;
      }

      if (EXCLUDED_FILES.has(item.name)) continue;
      if (item.name.startsWith(".")) continue;
      if (isExecutable(item.name)) continue;

      try {
        const stats = fs.statSync(fullPath);
        const modified = fileDateMap.get(itemRelativePath) || stats.mtime.toISOString();
        const entry = {
          name: item.name,
          type: "file",
          category: getFileCategory(item.name),
          size: stats.size,
          modified,
        };
        if (item.name.startsWith(EXTERNAL_PREFIX)) entry.external = 1;
        entries.push(entry);
        indexedPaths.add(itemRelativePath);
      } catch (error) {
        console.warn(`Could not stat file: ${fullPath}`);
      }
    }
  } catch (error) {
    console.warn(`Could not read directory: ${dir}: ${error.message}`);
  }

  entries.sort(compareEntries);
  return entries;
}

function compareEntries(a, b) {
  if (a.type === "directory" && b.type !== "directory") return -1;
  if (a.type !== "directory" && b.type === "directory") return 1;
  return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
}

function insertPath(rootEntries, filePath, fileEntry) {
  const parts = filePath.split("/");
  let currentEntries = rootEntries;

  for (const dirname of parts.slice(0, -1)) {
    let directory = currentEntries.find(
      (entry) => entry.type === "directory" && entry.name === dirname
    );

    if (!directory) {
      directory = { name: dirname, type: "directory", children: [], modified: null };
      currentEntries.push(directory);
    }

    currentEntries = directory.children;
  }

  if (!currentEntries.some((entry) => entry.name === fileEntry.name && entry.type === "file")) {
    currentEntries.push(fileEntry);
  }
}

// Re-sort after external files have been inserted and recalculate directory
// dates so folders containing only external files still appear correctly.
function finalizeTree(items) {
  for (const item of items) {
    if (item.type !== "directory") continue;

    finalizeTree(item.children);
    let latest = null;
    for (const child of item.children) {
      if (child.modified && (!latest || child.modified > latest)) latest = child.modified;
    }
    item.modified = latest;
  }

  items.sort(compareEntries);
}

function countItems(items) {
  let files = 0;
  let dirs = 0;

  for (const item of items) {
    if (item.type === "directory") {
      dirs++;
      const counts = countItems(item.children);
      files += counts.files;
      dirs += counts.dirs;
    } else {
      files++;
    }
  }

  return { files, dirs };
}

async function main() {
  console.log("Reading tracked file metadata...");
  const startTime = Date.now();
  const trackedEntries = getTrackedBlobEntries();
  const currentTrackedPaths = (trackedEntries || [])
    .filter(({ path: filePath }) => isIndexableGitPath(filePath))
    .map(({ path: filePath }) => filePath);

  if (IN_CI && currentTrackedPaths.length === 0) {
    throw new Error("Git tree contains no indexable files; refusing to write an empty index.");
  }

  console.log(`Finding last-modified dates for ${currentTrackedPaths.length} tracked files...`);
  const fileDateMap = await buildFileDateMap(currentTrackedPaths);

  console.log("Scanning checked-out files...");
  const indexedPaths = new Set();
  const root = scanDirectory(".", "", indexedPaths, fileDateMap);

  const externalEntries = await getMissingExternalEntries(trackedEntries || [], fileDateMap);
  for (const item of externalEntries) {
    if (!indexedPaths.has(item.path)) {
      insertPath(root, item.path, item.entry);
      indexedPaths.add(item.path);
    }
  }

  if (IN_CI) {
    const missingTrackedPaths = currentTrackedPaths.filter((filePath) => !indexedPaths.has(filePath));
    if (missingTrackedPaths.length) {
      throw new Error(
        `The checkout/index scan missed ${missingTrackedPaths.length} tracked file(s): ` +
        missingTrackedPaths.slice(0, 8).join(", ")
      );
    }
  }

  finalizeTree(root);

  const index = {
    generated: new Date().toISOString(),
    source: process.env.GITHUB_REPOSITORY
      ? {
          repo: process.env.GITHUB_REPOSITORY,
          branch: process.env.GITHUB_REF_NAME || "main",
        }
      : null,
    root,
  };

  const counts = countItems(index.root);
  index.stats = counts;

  if (counts.files === 0) {
    throw new Error("No files found; refusing to write an empty index.");
  }

  fs.writeFileSync("file_index.json", JSON.stringify(index));
  const externalCount = Array.from(indexedPaths).filter((filePath) =>
    path.posix.basename(filePath).startsWith(EXTERNAL_PREFIX)
  ).length;

  console.log(
    `Done in ${Date.now() - startTime}ms. Found ${counts.files} files in ` +
    `${counts.dirs} directories; ${externalCount} external file(s).`
  );
}

main().catch((error) => {
  console.error("ERROR: " + (error && error.stack ? error.stack : error));
  process.exitCode = 1;
});
