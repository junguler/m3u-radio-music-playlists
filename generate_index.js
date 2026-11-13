const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

// In CI a missing/shallow git history is a hard failure, not a quiet fallback:
// the site would deploy with every file dated at checkout time.
const IN_CI = !!(process.env.GITHUB_ACTIONS || process.env.CI);

// ---------------------------------------------------------------------------
// CHECKED-FOLDER COLLAPSING (keeps the deployed site under GitHub Pages' 1 GB)
//
// A folder with a sub-folder named "checked" shows the CONTENTS of that folder
// in its place and hides its own files (the unchecked variants). Other
// sub-folders are left alone, folders without "checked" are indexed as usual,
// and the folders in AGGREGATE_DIRS (and everything inside them) are exempt.
//
// The deploy workflow runs this with --apply-layout, which makes the same change
// on the throwaway CI checkout so hidden files aren't uploaded and "checked"
// files sit at the paths the viewer shows. The repository itself is never
// changed, and --apply-layout refuses to run outside CI.
//
// TO TURN IT OFF: comment out the "true" line and uncomment the "false" line.
const COLLAPSE_CHECKED = true;
// const COLLAPSE_CHECKED = false;

// Name of the folder whose contents replace the parent's files.
const CHECKED_DIR_NAME = "checked";

// Aggregate folders that are left out of this (matched by folder name).
const AGGREGATE_DIRS = new Set(["+checked+", "+merged+", "_zoo_"]);

const APPLY_LAYOUT = process.argv.includes("--apply-layout");
if (APPLY_LAYOUT && !IN_CI) {
  console.error(
    "ERROR: --apply-layout rewrites the working folder, so it only runs in CI " +
      "(GitHub Actions). Run without it on your own machine."
  );
  process.exit(1);
}

// Executable and binary extensions to exclude (lowercase: looked up after lowercasing).
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

// Directories to skip
const EXCLUDED_DIRS = new Set([
  ".git", "node_modules", ".github", "__pycache__", ".vscode", ".idea",
  ".cache", ".npm", ".yarn", "vendor", ".bundle",
]);

// Files starting with this are indexed like any other but flagged `external: 1`:
// the deploy workflow drops them from the upload and the viewer links to GitHub
// instead. Used for the very large "---everything" files.
const EXTERNAL_PREFIX = "---";

// System/meta files to skip
const EXCLUDED_FILES = new Set([
  "generate_index.js", "file_index.json", "file_index_lean.json", ".DS_Store", "Thumbs.db",
  "desktop.ini", ".gitignore", ".gitattributes", "package-lock.json",
  "yarn.lock", "pnpm-lock.yaml",
]);

// File type categories. The FIRST category listing an extension wins, so keep
// each extension in exactly one place. Built once into a Map so large repos
// don't re-allocate the arrays and run .includes() on every file.
const FILE_CATEGORIES = {
  image: [
    ".jpg", ".jpeg", ".png", ".gif", ".bmp", ".svg", ".webp", ".ico",
    ".tiff", ".tif", ".avif", ".heic", ".heif",
  ],
  video: [
    // .ogg is audio in practice (Vorbis/Opus); video-in-Ogg uses .ogv.
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
    // Playlist files (plain text)
    ".m3u", ".m3u8", ".pls", ".xspf", ".wpl", ".asx", ".cue",
  ],
  text: [
    ".txt", ".md", ".markdown", ".rst", ".rtf", ".log", ".nfo", ".diz",
    ".srt", ".vtt", ".sub", ".ass", ".ssa", // Subtitle files
  ],
  font: [".ttf", ".otf", ".woff", ".woff2", ".eot"],
  archive: [
    ".zip", ".tar", ".gz", ".bz2", ".xz", ".7z", ".rar", ".tgz", ".tbz2",
  ],
};

const CATEGORY_BY_EXTENSION = new Map();
for (const [category, extensions] of Object.entries(FILE_CATEGORIES)) {
  for (const ext of extensions) {
    if (!CATEGORY_BY_EXTENSION.has(ext)) CATEGORY_BY_EXTENSION.set(ext, category);
  }
}

function getFileCategory(filename) {
  return CATEGORY_BY_EXTENSION.get(path.extname(filename).toLowerCase()) || "other";
}

// Check if file is binary/executable
function isExecutable(filename) {
  const ext = path.extname(filename).toLowerCase();
  return EXECUTABLE_EXTENSIONS.has(ext);
}

// A fresh checkout writes every file at checkout time, so mtime is the same
// everywhere; the real "last modified" date lives in git history. One
// `git log --name-only` (newest first) gives every path's latest commit date
// in a single process: the first time a path appears is its most recent commit.
//
// core.quotepath=false stops git escaping non-ASCII paths, which would never
// match the real filename. Dates are normalised to UTC ("...Z") because ISO
// strings with different offsets don't sort correctly as text, which would
// break the folder "modified" maximum below.
function failOrWarn(message) {
  if (IN_CI) {
    console.error("ERROR: " + message);
    process.exit(1);
  }
  console.warn(message + " (falling back to filesystem mtime)");
}

function buildFileDateMap() {
  const map = new Map();

  if (IN_CI) {
    try {
      const shallow = execSync("git rev-parse --is-shallow-repository", {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
      if (shallow === "true") {
        failOrWarn(
          "Repository is a shallow clone, so file dates would be wrong. " +
            "Use `fetch-depth: 0` on actions/checkout."
        );
      }
    } catch (e) {
      // Very old git without the flag: the empty-map check below still guards.
    }
  }

  try {
    const output = execSync(
      'git -c core.quotepath=false log --name-only --no-renames --format="%x01%cI"',
      { encoding: "utf8", maxBuffer: 1024 * 1024 * 256, stdio: ["ignore", "pipe", "ignore"] }
    );
    let currentDate = null;
    for (const rawLine of output.split("\n")) {
      const line = rawLine.trim();
      if (!line) continue;
      if (rawLine.startsWith("\x01")) {
        const d = new Date(rawLine.slice(1).trim());
        currentDate = isNaN(d.getTime()) ? null : d.toISOString();
      } else if (currentDate && !map.has(line)) {
        map.set(line, currentDate);
      }
    }
  } catch (e) {
    failOrWarn("Could not read git history for file dates: " + e.message);
  }

  if (map.size === 0) {
    failOrWarn("Git history produced no file dates");
  }
  return map;
}

const fileDateMap = buildFileDateMap();

// Collapsed folders as { dir, checked }: the folder's real path and the on-disk name of its "checked" folder.
const collapsePlan = [];
let hiddenNormalFiles = 0;

// Recursively scans a directory. The output is kept small because the browser
// downloads all of it: a file is { name, type: "file", category, size, modified },
// a folder { name, type: "directory", children, modified }. Anything the page can
// derive (full path, extension, "1.2 MB") is not stored.
//
// `exempt` is true inside an aggregate folder (AGGREGATE_DIRS): no collapsing there.
// Unreadable entries are collected in scanErrors and fail the run (checked after
// the scan), so a partial index is never published.
const scanErrors = [];

function scanDirectory(dir, relativePath = "", exempt = false) {
  const entries = [];

  try {
    const items = fs.readdirSync(dir, { withFileTypes: true });

    // Checked-folder collapsing: never at the repository root (it would hide
    // index.html and friends), and only when "checked" actually has content.
    let checkedName = null;
    let hoisted = [];
    if (COLLAPSE_CHECKED && relativePath !== "" && !exempt) {
      const found = items.find(
        (i) => i.isDirectory() && i.name.toLowerCase() === CHECKED_DIR_NAME
      );
      if (found) {
        hoisted = scanDirectory(
          path.join(dir, found.name),
          `${relativePath}/${found.name}`,
          exempt
        );
        if (hoisted.length > 0) {
          checkedName = found.name;
          collapsePlan.push({ dir: relativePath, checked: checkedName });
        }
      }
    }

    for (const item of items) {
      const fullPath = path.join(dir, item.name);
      const itemRelativePath = relativePath
        ? `${relativePath}/${item.name}`
        : item.name;

      if (item.isDirectory()) {
        if (EXCLUDED_DIRS.has(item.name) || item.name.startsWith(".")) {
          continue;
        }
        // Its contents are added to this folder below.
        if (checkedName !== null && item.name === checkedName) continue;

        const children = scanDirectory(
          fullPath,
          itemRelativePath,
          exempt || AGGREGATE_DIRS.has(item.name)
        );
        if (children.length > 0) {
          // Git doesn't track folders, so a folder's date is the newest date
          // inside it (UTC ISO strings, so plain string comparison works).
          let latest = null;
          for (const child of children) {
            if (child.modified && (!latest || child.modified > latest)) {
              latest = child.modified;
            }
          }
          entries.push({
            name: item.name,
            type: "directory",
            children: children,
            modified: latest,
          });
        }
        continue;
      }

      if (EXCLUDED_FILES.has(item.name)) continue;
      if (item.name.startsWith(".")) continue;
      if (isExecutable(item.name)) continue;

      // The normal variants: hidden because the "checked" ones replace them.
      if (checkedName !== null) {
        hiddenNormalFiles++;
        continue;
      }

      try {
        const stats = fs.statSync(fullPath);
        // Dates come from the real path, even for a "checked" file shown in its parent.
        const modified =
          fileDateMap.get(itemRelativePath) || stats.mtime.toISOString();

        const entry = {
          name: item.name,
          type: "file",
          category: getFileCategory(item.name),
          size: stats.size,
          modified: modified,
        };
        if (item.name.startsWith(EXTERNAL_PREFIX)) entry.external = 1;
        // Real repository path for finalizePaths() below; not written out.
        Object.defineProperty(entry, "_src", { value: itemRelativePath });
        entries.push(entry);
      } catch (e) {
        // A dangling symlink has nothing to index; anything else is a failure.
        if (item.isSymbolicLink() && (e.code === "ENOENT" || e.code === "ELOOP")) {
          console.warn(`Skipping broken symlink: ${fullPath}`);
        } else {
          scanErrors.push(`stat ${fullPath}: ${e.code || e.message}`);
        }
      }
    }

    // Put the "checked" items into this folder; on a name clash with a sibling, the checked one wins.
    for (const h of hoisted) {
      if (checkedName === null) break;
      const clash = entries.findIndex((e) => e.name === h.name);
      if (clash >= 0) {
        console.warn(
          `"${relativePath}/${h.name}" exists next to the "${checkedName}" folder too; the checked one is used`
        );
        entries[clash] = h;
      } else {
        entries.push(h);
      }
    }
  } catch (e) {
    scanErrors.push(`read directory ${dir}: ${e.code || e.message}`);
  }

  entries.sort((a, b) => {
    if (a.type === "directory" && b.type !== "directory") return -1;
    if (a.type !== "directory" && b.type === "directory") return 1;
    return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
  });

  return entries;
}

// A "checked" file shown in its parent folder needs its real repository path
// for the GitHub link. Only the "---" files left out of the site are linked
// there, so only those get it ("repo").
function finalizePaths(items, prefix = "") {
  for (const it of items) {
    const shown = prefix ? `${prefix}/${it.name}` : it.name;
    if (it.type === "directory") {
      finalizePaths(it.children, shown);
    } else if (it.external && it._src && it._src !== shown) {
      it.repo = it._src;
    }
  }
}

// The top level only, reduced to names, so the first load is tiny: the page shows
// the root at once and fetches the rest from file_index.json right after.
//   folder: [name]    file: [name, categoryNumber]
//   an "external" file adds a third item: 1, or its real repository path
// `cats` lists the category names the numbers point into.
function toLean(items, cats) {
  return items.map((it) => {
    if (it.type === "directory") return [it.name];
    let n = cats.indexOf(it.category);
    if (n < 0) n = cats.push(it.category) - 1;
    const row = [it.name, n];
    if (it.external) row.push(it.repo || 1);
    return row;
  });
}

// Makes the checkout match the collapsed index: removes each collapsed folder's
// normal files and moves its "checked" contents up. Deepest first, so a folder
// inside a "checked" folder is handled while it is still where the scan found it.
function applyLayoutToCheckout(plan) {
  const ordered = plan
    .slice()
    .sort((a, b) => b.dir.split("/").length - a.dir.split("/").length);
  for (const { dir, checked } of ordered) {
    const checkedPath = path.join(dir, checked);
    const moving = fs.readdirSync(checkedPath);
    const movingNames = new Set(moving);
    for (const it of fs.readdirSync(dir, { withFileTypes: true })) {
      if (it.name === checked) continue;
      const p = path.join(dir, it.name);
      if (it.isDirectory()) {
        if (movingNames.has(it.name)) fs.rmSync(p, { recursive: true, force: true });
      } else {
        fs.rmSync(p, { force: true });
      }
    }
    for (const name of moving) {
      fs.renameSync(path.join(checkedPath, name), path.join(dir, name));
    }
    fs.rmSync(checkedPath, { recursive: true, force: true });
  }
}

console.log("Scanning repository...");
const startTime = Date.now();

const index = {
  generated: new Date().toISOString(),
  // Where external files load from; only known inside GitHub Actions.
  source: process.env.GITHUB_REPOSITORY
    ? {
        repo: process.env.GITHUB_REPOSITORY,
        branch: process.env.GITHUB_REF_NAME || "main",
      }
    : null,
  root: scanDirectory("."),
};
finalizePaths(index.root);

function countItems(items) {
  let files = 0, dirs = 0;
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

if (scanErrors.length > 0) {
  console.error(`ERROR: the scan was incomplete (${scanErrors.length} problem(s)); refusing to write an index.`);
  for (const m of scanErrors.slice(0, 50)) console.error("  - " + m);
  if (scanErrors.length > 50) console.error(`  ... and ${scanErrors.length - 50} more`);
  process.exit(1);
}

const counts = countItems(index.root);
index.stats = counts;

if (counts.files === 0) {
  console.error("ERROR: no files found; refusing to write an empty index.");
  process.exit(1);
}

// Two files: the lean one (root names only) is fetched first so the top level
// shows at once; the full one follows right away and replaces it.
const cats = [];
const lean = {
  generated: index.generated,
  source: index.source,
  stats: index.stats,
  root: toLean(index.root, cats),
};
lean.cats = cats;

fs.writeFileSync("file_index_lean.json", JSON.stringify(lean));
fs.writeFileSync("file_index.json", JSON.stringify(index));

if (collapsePlan.length) {
  console.log(
    `Checked-folder collapsing: ${collapsePlan.length} folders show their "${CHECKED_DIR_NAME}" files; ${hiddenNormalFiles} normal files hidden.`
  );
}
if (APPLY_LAYOUT) {
  applyLayoutToCheckout(collapsePlan);
  console.log("Applied the checked-folder layout to this checkout.");
}

console.log(
  `Done in ${Date.now() - startTime}ms. Found ${counts.files} files in ${counts.dirs} directories.`
);
