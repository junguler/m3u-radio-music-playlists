const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

// Running inside GitHub Actions (or any CI)? Then a missing/shallow git
// history is a hard failure instead of a quiet fallback, because the site
// would deploy with every file showing the checkout time as its date.
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

// Directories to skip
const EXCLUDED_DIRS = new Set([
  ".git", "node_modules", ".github", "__pycache__", ".vscode", ".idea",
  ".cache", ".npm", ".yarn", "vendor", ".bundle",
]);

// System/meta files to skip
const EXCLUDED_FILES = new Set([
  "generate_index.js", "file_index.json", ".DS_Store", "Thumbs.db",
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

// Recursively scan directory.
//
// The output is kept deliberately small, because the browser downloads all of
// it before showing anything. Each file is just
//   { name, type: "file", category, size, modified }
// and each folder is { name, type: "directory", children, modified }.
// Things the page can work out for itself (the full path, the file extension
// and the human-readable size such as "1.2 MB") are NOT stored.
function scanDirectory(dir, relativePath = "") {
  const entries = [];

  try {
    const items = fs.readdirSync(dir, { withFileTypes: true });

    for (const item of items) {
      const fullPath = path.join(dir, item.name);
      const itemRelativePath = relativePath
        ? `${relativePath}/${item.name}`
        : item.name;

      if (item.isDirectory()) {
        if (EXCLUDED_DIRS.has(item.name) || item.name.startsWith(".")) {
          continue;
        }

        const children = scanDirectory(fullPath, itemRelativePath);
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

      try {
        const stats = fs.statSync(fullPath);
        const modified =
          fileDateMap.get(itemRelativePath) || stats.mtime.toISOString();

        entries.push({
          name: item.name,
          type: "file",
          category: getFileCategory(item.name),
          size: stats.size,
          modified: modified,
        });
      } catch (e) {
        console.warn(`Could not stat file: ${fullPath}`);
      }
    }
  } catch (e) {
    console.warn(`Could not read directory: ${dir}`);
  }

  entries.sort((a, b) => {
    if (a.type === "directory" && b.type !== "directory") return -1;
    if (a.type !== "directory" && b.type === "directory") return 1;
    return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
  });

  return entries;
}

console.log("Scanning repository...");
const startTime = Date.now();

const index = {
  generated: new Date().toISOString(),
  root: scanDirectory("."),
};

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

const counts = countItems(index.root);
index.stats = counts;

if (counts.files === 0) {
  console.error("ERROR: no files found; refusing to write an empty index.");
  process.exit(1);
}

fs.writeFileSync("file_index.json", JSON.stringify(index));

console.log(
  `Done in ${Date.now() - startTime}ms. Found ${counts.files} files in ${counts.dirs} directories.`
);
