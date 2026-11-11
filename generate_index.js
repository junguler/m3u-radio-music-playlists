const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

// Running inside GitHub Actions (or any CI)? Then a missing/shallow git
// history is a hard failure instead of a quiet fallback, because the site
// would deploy with every file showing the checkout time as its date.
const IN_CI = !!(process.env.GITHUB_ACTIONS || process.env.CI);

// ---------------------------------------------------------------------------
// CHECKED-FOLDER COLLAPSING (keeps the deployed site under GitHub Pages' 1 GB)
//
// When a folder contains a sub-folder named "checked", the viewer shows the
// CONTENTS of that "checked" folder directly in the parent folder and hides the
// parent's own files (the normal, unchecked variants). Other sub-folders of the
// parent are left alone, and folders without a "checked" folder are indexed
// as usual. The three folders in AGGREGATE_DIRS (and everything inside them)
// are never touched.
//
// The deploy workflow runs this script with --apply-layout, which makes the
// same change on the throwaway CI checkout so the hidden files are not uploaded
// and the "checked" files really sit at the paths the viewer shows. The repository
// itself is never changed, and --apply-layout refuses to run outside CI.
//
// TO TURN IT OFF: comment out the "true" line and uncomment the "false" line.
// (Everything is then indexed and deployed exactly as before.)
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

// Directories to skip
const EXCLUDED_DIRS = new Set([
  ".git", "node_modules", ".github", "__pycache__", ".vscode", ".idea",
  ".cache", ".npm", ".yarn", "vendor", ".bundle",
]);

// Files whose name starts with this are listed in the index like any other
// file but flagged `external: 1`. The deploy workflow then removes them from
// the checkout before the site is uploaded, and the viewer links to them on
// GitHub instead. Used for the very large "---everything" files.
const EXTERNAL_PREFIX = "---";

// System/meta files to skip
const EXCLUDED_FILES = new Set([
  "generate_index.js", "file_index.json", "file_index_lean.json", ".DS_Store", "Thumbs.db",
  "desktop.ini", ".gitignore", ".gitattributes", "package-lock.json",
  "yarn.lock", "pnpm-lock.yaml",
]);

// File type categories. An extension is matched against the categories in
// this order and the FIRST match wins, so an extension listed twice goes to
// whichever category comes first. Keep each extension in exactly one place.
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

  for (const [category, extensions] of Object.entries(categories)) {
    if (extensions.includes(ext)) return category;
  }

  return "other";
}

// Check if file is binary/executable
function isExecutable(filename) {
  const ext = path.extname(filename).toLowerCase();
  return EXECUTABLE_EXTENSIONS.has(ext);
}

// A fresh `actions/checkout` (or any fresh clone) writes every file to disk at
// checkout time, so fs.statSync(...).mtime is the same for every file
// regardless of when it was actually last changed. The real "last modified"
// date lives in git history instead, so we build a path -> last-commit-date
// map from it once, up front.
//
// `git log --name-only` walks commits newest-first and lists every path each
// commit touched, so the first time we see a given path is its most recent
// commit. That gives us the whole repo's per-file last-modified dates in a
// single git invocation instead of one process per file.
//
// core.quotepath=false matters: by default git quotes/escapes any path with
// non-ASCII characters as octal-escaped bytes, which then never matches the
// real UTF-8 filename.
//
// Dates are normalised to UTC ("...Z") as they are read. Git reports each
// commit in its author's own timezone (e.g. "+03:30"), and ISO strings with
// different offsets do NOT sort correctly as plain strings, which would make
// the folder "modified" maximum below wrong.
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
      // Very old git without the flag: the empty-map check below still guards us.
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

// Folders collapsed by the checked-folder rule, as { dir, checked } where dir is
// the folder's real path and checked is the on-disk name of its "checked" folder.
const collapsePlan = [];
let hiddenNormalFiles = 0;

// Recursively scan directory.
//
// The output is kept deliberately small, because the browser downloads all of
// it before showing everything. Each file is just
//   { name, type: "file", category, size, modified }
// and each folder is { name, type: "directory", children, modified }.
// Things the page can work out for itself (the full path, the file extension
// and the human-readable size such as "1.2 MB") are NOT stored.
//
// `exempt` is true inside an aggregate folder (see AGGREGATE_DIRS): no
// checked-folder collapsing happens there.
// Anything the scan could not read is collected here and makes the run fail
// (see the check after the scan), so a partial index is never published.
const scanErrors = [];

function scanDirectory(dir, relativePath = "", exempt = false) {
  const entries = [];

  try {
    const items = fs.readdirSync(dir, { withFileTypes: true });

    // Checked-folder collapsing. Never at the repository root (that would
    // hide index.html and friends), and only when the "checked" folder
    // actually has something in it.
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
          // A folder's "modified" date is the most recent modification among
          // everything inside it (recursively), since git doesn't track
          // directories directly. All dates are UTC ISO strings by now, so a
          // plain string comparison is correct.
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
        // Dates come from the file's real path, even when the file is shown
        // somewhere else (a "checked" file shown in its parent folder).
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
        // Real repository path, used by finalizePaths() below. Not written out.
        Object.defineProperty(entry, "_src", { value: itemRelativePath });
        entries.push(entry);
      } catch (e) {
        // A dangling symlink has nothing to index; anything else is a real failure.
        if (item.isSymbolicLink() && (e.code === "ENOENT" || e.code === "ELOOP")) {
          console.warn(`Skipping broken symlink: ${fullPath}`);
        } else {
          scanErrors.push(`stat ${fullPath}: ${e.code || e.message}`);
        }
      }
    }

    // Put the "checked" items into this folder. If one has the same name as a
    // sibling folder, the checked item wins.
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

// A file shown at a different place than where it really lives (a "checked"
// file shown in its parent folder) needs its real repository path when the
// viewer links to it on GitHub. Only the "---" files that are left out of the
// site are ever linked there, so only those get it ("repo").
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

// The top level only, reduced to names, so the first load is tiny: the page
// can show the root folders and files at once and fetch everything else
// (the contents of every folder, sizes, dates) from file_index.json right after.
// Nothing inside a folder is written here.
//   folder: [name]                     file: [name, categoryNumber]
//   an "external" file has a third item: 1, or its real repository path
// `cats` lists the category names that the category numbers point into.
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

// Makes the checkout match the collapsed index: removes each collapsed
// folder's normal files and moves its "checked" contents up into it. Deepest
// folders first, so a folder inside a "checked" folder is dealt with while
// it is still where the scan found it.
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
  // Where external files can be loaded from. Only known inside GitHub Actions.
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

// Two files: the lean one (root folder and file names only, very small) is
// fetched first so the page can show the top level at once; the full one
// (every folder's contents, sizes, dates) follows right away and replaces it.
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
