const fs = require("fs");
const path = require("path");

// Executable and binary extensions to exclude
const EXECUTABLE_EXTENSIONS = new Set([
  // Windows
  ".exe", ".dll", ".msi", ".com", ".bat", ".cmd", ".scr", ".pif", ".gadget",
  // macOS
  ".app", ".dmg", ".pkg", ".dSYM",
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

// File type categories
function getFileCategory(filename) {
  const ext = path.extname(filename).toLowerCase();

  const categories = {
    image: [
      ".jpg", ".jpeg", ".png", ".gif", ".bmp", ".svg", ".webp", ".ico",
      ".tiff", ".tif", ".avif", ".heic", ".heif",
    ],
    video: [
      ".mp4", ".webm", ".ogg", ".ogv", ".mov", ".avi", ".mkv", ".m4v",
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
      ".html", ".htm", ".xml", ".xhtml", ".xaml", ".svg", ".wxml", ".jsp",
      ".asp", ".aspx", ".erb", ".ejs", ".haml", ".slim", ".pug", ".jade",
      ".twig", ".blade.php", ".hbs", ".mustache", ".njk", ".liquid",
    ],
    style: [".css", ".scss", ".sass", ".less", ".styl", ".stylus", ".postcss"],
    data: [
      ".json", ".yaml", ".yml", ".toml", ".ini", ".cfg", ".conf",
      ".properties", ".env", ".csv", ".tsv", ".xml",
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

// Get human-readable file size
function formatSize(bytes) {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
}

// Recursively scan directory
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
          entries.push({
            name: item.name,
            path: itemRelativePath,
            type: "directory",
            children: children,
          });
        }
        continue;
      }

      if (EXCLUDED_FILES.has(item.name)) continue;
      if (item.name.startsWith(".")) continue;
      if (isExecutable(item.name)) continue;

      try {
        const stats = fs.statSync(fullPath);
        const category = getFileCategory(item.name);

        entries.push({
          name: item.name,
          path: itemRelativePath,
          type: "file",
          category: category,
          extension: path.extname(item.name).toLowerCase(),
          size: stats.size,
          sizeFormatted: formatSize(stats.size),
          modified: stats.mtime.toISOString(),
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

fs.writeFileSync("file_index.json", JSON.stringify(index));

console.log(
  `Done in ${Date.now() - startTime}ms. Found ${counts.files} files in ${counts.dirs} directories.`
);