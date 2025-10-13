// generate_index.js
const fs = require('fs');
const path = require('path');

// --- Configuration ---
// Add folders or files you want to exclude from the index
const EXCLUDED_ITEMS = [
    '.git',
    'node_modules',
    '.github', // Exclude the workflow folder itself
    'index.json', // Don't index the index file
];
// The root folder to scan. '.' means the current directory.
const ROOT_DIR = '.';
// --- End Configuration ---

/**
 * Recursively builds a tree structure of a directory.
 * @param {string} dirPath - The path of the directory to scan.
 * @returns {Array} An array of file and folder objects.
 */
function buildTree(dirPath) {
    const items = fs.readdirSync(dirPath);

    const tree = items
        .filter(item => !EXCLUDED_ITEMS.includes(item))
        .map(item => {
            const fullPath = path.join(dirPath, item);
            const stats = fs.statSync(fullPath);
            const relativePath = path.relative(ROOT_DIR, fullPath);

            if (stats.isDirectory()) {
                return {
                    name: item,
                    type: 'folder',
                    path: relativePath.replace(/\\/g, '/'), // Ensure forward slashes for web
                    children: buildTree(fullPath)
                };
            } else {
                return {
                    name: item,
                    type: 'file',
                    path: relativePath.replace(/\\/g, '/'),
                    size: stats.size // Add file size in bytes
                };
            }
        });

    // Sort: folders first, then files, both alphabetically
    tree.sort((a, b) => {
        if (a.type === b.type) {
            return a.name.localeCompare(b.name);
        }
        return a.type === 'folder' ? -1 : 1;
    });

    return tree;
}

const fileTree = buildTree(ROOT_DIR);

// Write the final tree to index.json
fs.writeFileSync('index.json', JSON.stringify(fileTree, null, 2));

console.log('✅ index.json has been successfully generated!');