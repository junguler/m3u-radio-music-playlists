// m3u-logo-designer.js
//
// Recursively scans the input folder for .m3u / .m3u8 files (any depth),
// draws a logo image (JPEG) for every station from its title, embeds it as
// tvg-logo="..." and writes the playlists to the output folder, keeping the
// exact same sub-folder structure:
//
//   input/rock/a.m3u        ->  output/rock/a.m3u
//   input/world/asia/b.m3u8 ->  output/world/asia/b.m3u8
//                               output/logos/jazz-fm-1x2y3.jpg   (all logos)
//
// It is the command line version of the M3U Logo Designer page: same options,
// same ranges, same randomizer, and the same "look" files. Design a look in
// the page, click "Save look", then run this script on your whole repository:
//
//   node m3u-logo-designer.js input/ output/ --look my-look.json
//
// Stations that already have a tvg-logo are left alone (--overwrite replaces
// them). The same station title always gets the same logo file, so a title
// that appears in many playlists is drawn only once. By default every
// tvg-logo is a path relative to its playlist (for example "logos/x.jpg", or
// "../logos/x.jpg" for a playlist in a sub-folder).
//
// Variations, like on the page: "Vary per station" (hue shift, random colors,
// random style), "Randomize each entry" and the random shapes are all
// deterministic - the same title and seed always draw the same logo.
//
// Output choices:
//
//   (default)         loose files: output/<playlists> and output/logos/*.jpg
//   --zip             one "<name>_logos.zip" per playlist, holding the
//                     playlist plus a logos/ folder (what the page downloads)
//   --url-prefix URL  full URLs in tvg-logo instead of paths, for logos that
//                     are hosted online: the .jpg files still land in
//                     output/logos/, upload that folder to the place the URL
//                     points to, e.g.
//                     --url-prefix https://raw.githubusercontent.com/USER/REPO/main/logos/
//
// IMPORTANT - text and fonts: there is no canvas and no access to the fonts
// installed on the computer in a dependency-free Node.js script, so the text
// is drawn with a vector font that is built into this file (see the FONT
// section). It covers A-Z, 0-9 and common punctuation; lowercase letters are
// drawn as small capitals, accents are dropped, Russian is transliterated.
// Characters it cannot draw (Arabic, Persian, Chinese, emoji...) are skipped,
// and a title with nothing drawable gets a play symbol. The page's 12 "Font"
// choices become 12 looks of this font (width, weight, slant, monospace).
// The images therefore look like the page's logos in style, not pixel for
// pixel. Try a look first with:
//
//   node m3u-logo-designer.js --look my-look.json --sample "Jazz FM London"
//
// Hidden folders (starting with ".") and node_modules are skipped, and so is
// the output folder if it happens to live inside the input folder.
//
// Usage:
//
//   node m3u-logo-designer.js
//   node m3u-logo-designer.js input_folder/ output_folder/
//   node m3u-logo-designer.js input_folder/ output_folder/ --quiet
//   node m3u-logo-designer.js input_folder/ output_folder/ --look my-look.json
//   node m3u-logo-designer.js input_folder/ output_folder/ --random=1234
//   node m3u-logo-designer.js input_folder/ output_folder/ --set font=Impact --set size=256
//   node m3u-logo-designer.js --help
//   node m3u-logo-designer.js --list-options
//
// Options (more with --help):
//
//   --look FILE        load a look saved by the page (output settings in it,
//                      like the folder name or URL prefix, are ignored)
//   --set ID=VALUE     change one option, repeatable (see --list-options)
//   --random[=SEED]    random design, like the page's "Randomize all"
//   --save-look FILE   write the design in use to a look file
//   --sample "TITLE"   draw one logo to logo-sample.jpg and stop
//   --zip, --url-prefix URL, --overwrite, --skip-existing, --quiet
//
// Optional environment variables:
//
//   WORKERS=3                (drawing threads; default: CPU cores - 1, max 8,
//                             0 = draw on the main thread)
//   FILE_CONCURRENCY=4       (max playlists processed at the same time)
//   PROGRESS_INTERVAL=60000  (milliseconds between progress reports)
//
// Runtime limit (hard-coded for GitHub Actions 6h job limit):
//
//   MAX_RUNTIME_MS = 5h 45m
//   After this duration the script stops starting new logos. Fully processed
//   playlists are removed from the input folder so a subsequent run can
//   resume with only the remaining files. Add --skip-existing to the next
//   run to skip the logos that were already drawn.
//
// Processing order:
//
//   Playlists are sorted by number of logos to draw (smallest first). Up to
//   FILE_CONCURRENCY playlists run concurrently while the drawing threads
//   work through the logos in that order.
//
// Example:
//
//   WORKERS=4 node m3u-logo-designer.js m3u-files/ m3u-designed/ --look my-look.json --quiet

const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { Worker, isMainThread, parentPort } = require('worker_threads');

// Hard runtime limit for GitHub Actions (6h max). Stop starting new work
// after 5h 45m so the job can finish cleanly and leave remaining files
// for a subsequent run.
const MAX_RUNTIME_MS = (5 * 60 + 45) * 60 * 1000; // 5h 45m

/* ============================================================
 OPTIONS
 The same options, defaults and ranges as the M3U Logo Designer page, so a
 "look" saved from the page (Save look button) loads here unchanged.

 [id, label, type (r range | s select | c color | k check | t text),
  default, min | options, max, step]
 ============================================================ */

const NAMES = ['Sans', 'Impact', 'Serif', 'Mono', 'Trebuchet', 'Palatino', 'Script', 'Arial Black', 'Courier', 'Verdana', 'Geometric', 'Display'];
const SHT = ['square', 'circle', 'triangle', 'diamond', 'pentagon', 'hexagon', 'star', 'ring', 'cross', 'semicircle', 'parallelogram'];

const G = [
  ['Background', [['bgm', 'Mode', 's', 'linear', ['solid', 'linear', 'radial', 'conic', 'mesh']], ['c1', 'Color 1', 'c', '#ff6a1a'], ['c2', 'Color 2', 'c', '#a77bff'], ['c3', 'Color 3', 'c', '#ff4fa3'], ['tri', 'Use color 3', 'k', true], ['hard', 'Hard stops (bands)', 'k', false], ['ang', 'Angle', 'r', 135, 0, 360]]],
  ['Shape', [['rad', 'Corner radius %', 'r', 0, 0, 50], ['matte', 'Matte color (outside mask)', 'c', '#000000']]],
  ['Pattern overlay', [['pat', 'Pattern', 's', 'none', ['none', 'stripes', 'dots', 'grid', 'checker', 'rings', 'rays', 'waves', 'zigzag', 'crosses']], ['pc', 'Color', 'c', '#ffffff'], ['pa', 'Opacity %', 'r', 18, 0, 100], ['ps', 'Cell size', 'r', 40, 8, 160], ['pw', 'Weight %', 'r', 40, 5, 95], ['pr', 'Rotation', 'r', 45, 0, 180]]],
  ['Text', [['src', 'Text from title', 's', 'cleaned', ['full', 'cleaned', 'initials', 'first word', 'first two words', 'last word']], ['cs', 'Case', 's', 'UPPER', ['as is', 'UPPER', 'lower', 'Title']], ['font', 'Font', 's', 'Impact', NAMES], ['wt', 'Weight', 'r', 800, 100, 900, 100], ['it', 'Italic', 'k', false], ['fs', 'Max size %', 'r', 100, 20, 100], ['tp', 'Margin %', 'r', 10, 2, 30], ['lh', 'Line height %', 'r', 100, 60, 160], ['ls', 'Letter spacing', 'r', 0, -4, 30], ['al', 'Align', 's', 'center', ['left', 'center', 'right']], ['rot', 'Rotate', 'r', 0, -90, 90], ['tx', 'Offset X %', 'r', 0, -40, 40], ['ty', 'Offset Y %', 'r', 0, -40, 40], ['tm', 'Fill', 's', 'solid', ['solid', 'gradient', 'auto contrast', 'rainbow']], ['t1', 'Text color', 'c', '#ffffff'], ['t2', 'Text color 2', 'c', '#ffd100'], ['tc', 'Text contrast % (color push, halo, backing glow)', 'r', 0, 0, 100]]],
  ['Stroke', [['sw', 'Stroke width', 'r', 8, 0, 40], ['sc', 'Stroke color', 'c', '#000000'], ['sj', 'Join', 's', 'round', ['round', 'miter', 'bevel']], ['sw2', 'Outer stroke', 'r', 0, 0, 40], ['sc2', 'Outer color', 'c', '#ffd100']]],
  ['Shadow & depth', [['shx', 'Shadow X', 'r', 0, -40, 40], ['shy', 'Shadow Y', 'r', 0, -40, 40], ['shb', 'Shadow blur', 'r', 0, 0, 60], ['sha', 'Shadow opacity %', 'r', 80, 0, 100], ['shc', 'Shadow color', 'c', '#000000'], ['gl', 'Glow', 'r', 0, 0, 80], ['glc', 'Glow color', 'c', '#ffd100'], ['ex', 'Extrude depth', 'r', 0, 0, 60], ['exa', 'Extrude angle', 'r', 45, 0, 360], ['exc', 'Extrude color', 'c', '#000000']]],
  ['Frame', [['bw', 'Border', 'r', 0, 0, 60], ['bc', 'Border color', 'c', '#ffffff'], ['bw2', 'Inner line', 'r', 0, 0, 30], ['bc2', 'Inner color', 'c', '#000000'], ['bgp', 'Inner gap', 'r', 10, 0, 40]]],
  ['Effects', [['vig', 'Vignette', 'r', 0, 0, 100], ['grain', 'Grain', 'r', 0, 0, 100], ['scan', 'Scanlines', 'r', 0, 0, 100], ['rgb', 'RGB split', 'r', 0, 0, 30], ['gli', 'Glitch', 'r', 0, 0, 20], ['br', 'Brightness %', 'r', 100, 20, 200], ['ct', 'Contrast %', 'r', 100, 20, 200], ['sa', 'Saturation %', 'r', 100, 0, 250], ['hue', 'Hue rotate', 'r', 0, 0, 360], ['inv', 'Invert', 'k', false], ['pix', 'Pixelate', 'r', 1, 1, 32]]],
  ['Dither', [['dm', 'Method', 's', 'none', ['none', 'Bayer 2x2', 'Bayer 4x4', 'Bayer 8x8', 'Floyd-Steinberg', 'Atkinson', 'Random']], ['dl', 'Levels per channel', 'r', 4, 2, 16], ['dcm', 'Color', 's', 'original', ['original', 'grayscale', 'two-tone']], ['d1', 'Dark tone', 'c', '#0f380f'], ['d2', 'Light tone', 'c', '#9bbc0f'], ['dsc', 'Cell size', 'r', 2, 1, 8]]],
  ['Shapes', [['shn', 'Random shapes (count)', 'r', 0, 0, 24], ['shl', 'Random shapes layer', 's', 'behind text', ['behind text', 'over text', 'mixed']], ['shmn', 'Random min size %', 'r', 8, 2, 100], ['shmx', 'Random max size %', 'r', 40, 2, 100], ['sho', 'Random max opacity %', 'r', 70, 10, 100], ['shc2', 'Random shape colors', 's', 'palette', ['palette', 'random']], ['n_t', 'New shape: type', 's', 'circle', SHT], ['n_col', 'New shape: color', 'c', '#ffd100'], ['n_sz', 'New shape: size %', 'r', 30, 2, 100], ['n_x', 'New shape: X %', 'r', 0, -50, 50], ['n_y', 'New shape: Y %', 'r', 0, -50, 50], ['n_rot', 'New shape: rotation', 'r', 0, 0, 360], ['n_op', 'New shape: opacity %', 'r', 100, 5, 100], ['n_fill', 'New shape: style', 's', 'filled', ['filled', 'outline']], ['n_lw', 'New shape: outline width', 'r', 6, 1, 40], ['n_l', 'New shape: layer', 's', 'behind text', ['behind text', 'over text']]]],
  ['Randomize', [['rp', 'Randomize amount % (buttons + each entry)', 'r', 100, 0, 100, 5], ['each', 'Randomize each entry (every station gets its own remix of this design)', 'k', false], ['rd', 'Keep text readable when randomizing', 'k', true], ['rdm', 'Minimum text contrast % when randomizing', 'r', 40, 0, 100]]],
  ['Variation & export', [['vm', 'Vary per station', 's', 'identical', ['identical', 'hue shift', 'random colors', 'random style']], ['seed', 'Seed', 'r', 1, 1, 999], ['size', 'Image size px', 's', '512', ['128', '256', '384', '512', '768', '1024']], ['q', 'JPEG quality', 'r', 90, 40, 100], ['pre', 'Folder in zip', 't', 'logos/'], ['ow', 'Replace existing tvg-logo', 'k', false], ['plain', 'Plain filenames without hash (can change when the playlist changes)', 'k', false], ['useurl', 'Write full URLs in tvg-logo (instead of the folder path)', 'k', false], ['urlpre', 'Logo URL prefix', 't', 'https://raw.githubusercontent.com/USER/REPO/main/logos/']]],
];

const ALL = G.flatMap(([g, items]) => items.map(([id, lab, ty, def, a, b, st]) => ({ id, lab, ty, def, a, b, st, g })));
const CM = Object.fromEntries(ALL.map((c) => [c.id, c]));

/** A fresh set of default options (plus the list of manually placed shapes). */
function defaultOptions() {
  const V = {};
  ALL.forEach((c) => (V[c.id] = c.def));
  V.shapes = [];
  return V;
}

/* ============================================================
 HELPERS
 ============================================================ */

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const rgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const lum = (h) => {
  const [r, g, b] = rgb(h);
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
};
const hsl = (h, s, l) => {
  h = ((h % 360) + 360) % 360;
  s /= 100;
  l /= 100;
  const k = (n) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => Math.round(255 * (l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1))));
  return '#' + [f(0), f(8), f(4)].map((v) => v.toString(16).padStart(2, '0')).join('');
};
const hash = (s) => {
  let h = 2166136261;
  for (const ch of String(s)) {
    h ^= ch.codePointAt(0);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
};
const rng = (a) => () => {
  a = (a + 0x6d2b79f5) | 0;
  let t = Math.imul(a ^ (a >>> 15), 1 | a);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const mix = (a, b, f) => {
  const A = rgb(a);
  const B = rgb(b);
  return '#' + A.map((v, i) => Math.round(v + (B[i] - v) * f).toString(16).padStart(2, '0')).join('');
};
/** Bayer threshold matrix of size n x n (n = 2, 4, 8). */
const bay = (n) => {
  let m = [[0]];
  while (m.length < n) {
    const s = m.length;
    const q = [];
    for (let i = 0; i < 2 * s; i++) {
      q[i] = [];
      for (let j = 0; j < 2 * s; j++) {
        q[i][j] = 4 * m[i % s][j % s] + [0, 2, 3, 1][(i >= s ? 2 : 0) + (j >= s ? 1 : 0)];
      }
    }
    m = q;
  }
  return m;
};

/* ============================================================
 RANDOMIZER
 ============================================================ */

const SKIP = ['size', 'q', 'pre', 'ow', 'vm', 'seed', 'src', 'cs', 'matte', 'hue', 'rp', 'each', 'rd', 'rdm', 'plain', 'useurl', 'urlpre'];
const FXG = ['Effects', 'Dither', 'Shadow & depth', 'Frame', 'Pattern overlay', 'Shapes'];
const SP = {
  shn: [0, 10], tc: [0, 60], br: [80, 130], ct: [85, 140], sa: [70, 170], rot: [-20, 20], tx: [0, 0], ty: [-8, 8],
  fs: [75, 100], sw: [0, 16], sw2: [0, 16], ex: [0, 30], shx: [-14, 14], shy: [-14, 14], shb: [0, 25], pix: [1, 12],
  dl: [2, 8], gli: [0, 10], rgb: [0, 12], gl: [0, 40], bw: [0, 30], vig: [0, 70], grain: [0, 50], scan: [0, 60],
};

/**
 * Randomizes options in place.
 * @param {object} o - options to change
 * @param {'all'|'colors'|'style'} scope
 * @param {() => number} r - random number generator
 * @param {number} pct - randomize amount in percent
 */
function randomize(o, scope, r, pct = 100) {
  const p = pct / 100;

  if (scope !== 'style') {
    const h = r() * 360;
    const tp = r();
    const hs = tp < 0.34 ? [30, -30] : tp < 0.67 ? [180, 150] : [120, 240];
    const dark = r() < 0.55;
    const L = dark ? [14, 34] : [60, 84];
    const rl = () => L[0] + r() * (L[1] - L[0]);
    const txt = dark ? hsl(h + hs[0], 90, 88) : hsl(h, 70, 10);
    const edge = dark ? hsl(h, 70, 6) : hsl(h, 20, 96);
    const acc = hsl(h + hs[0] + 60, 95, 55);
    const PAL = {
      c1: hsl(h, 60 + r() * 40, rl()),
      c2: hsl(h + hs[0], 60 + r() * 40, rl()),
      c3: hsl(h + hs[1], 60 + r() * 40, rl()),
      t1: txt,
      t2: hsl(h + hs[1], 95, dark ? 72 : 22),
      sc: edge,
      sc2: acc,
      pc: txt,
      shc: edge,
      glc: acc,
      exc: edge,
      bc: txt,
      bc2: edge,
      d1: hsl(h, 60, 8),
      d2: hsl(h + hs[0], 70, 82),
    };
    for (const kk in PAL) if (r() < p) o[kk] = PAL[kk];
    if (scope === 'colors') {
      if (o.rd) o.tc = Math.max(o.tc, o.rdm);
      return;
    }
  }

  for (const c of ALL) {
    if (SKIP.includes(c.id) || c.id.startsWith('n_') || c.ty === 'c' || c.ty === 't' || r() >= p) continue;
    if (FXG.includes(c.g) && r() < 0.55) {
      o[c.id] = c.def;
      continue;
    }
    if (c.ty === 'r') {
      const [lo, hi] = SP[c.id] || [c.a, c.b];
      const st = c.st || 1;
      o[c.id] = Math.round((lo + r() * (hi - lo)) / st) * st;
    } else if (c.ty === 's') {
      o[c.id] = c.a[(r() * c.a.length) | 0];
    } else {
      o[c.id] = r() < 0.5;
    }
  }
  if (o.rd) o.tc = Math.max(o.tc, o.rdm);
}

/**
 * The "random shapes" of a design: deterministic for a given title and seed.
 * @param {object} o
 * @param {string} title
 * @param {() => number} r
 * @returns {object[]}
 */
function randShapes(o, title, r) {
  const out = [];
  const pal = [o.c1, o.c2, o.c3, o.t1, o.t2, o.pc, o.sc2];

  for (let i = 0; i < o.shn; i++) {
    out.push({
      t: SHT[(r() * SHT.length) | 0],
      col: o.shc2 === 'random' ? hsl(r() * 360, 80, 55) : pal[(r() * pal.length) | 0],
      sz: o.shmn + r() * Math.max(0, o.shmx - o.shmn),
      x: (r() - 0.5) * 90,
      y: (r() - 0.5) * 90,
      rot: r() * 360,
      op: Math.min(o.sho, 20 + r() * (o.sho - 20)),
      fill: r() < 0.7 ? 'filled' : 'outline',
      lw: 2 + r() * 8,
      over: o.shl === 'over text' ? true : o.shl === 'mixed' ? r() < 0.5 : false,
    });
  }
  return out;
}

/**
 * Options for one station: the base design, varied per station when the
 * "Vary per station" / "Randomize each entry" options ask for it.
 * @param {object} V - base options
 * @param {string} title
 * @returns {object}
 */
function stationOptions(V, title) {
  if (V.vm === 'identical' && !V.each) return V;

  const o = { ...V };
  const r = rng((hash(title) + V.seed * 7919) >>> 0);

  if (V.vm === 'hue shift') o.hue = (V.hue + r() * 360) % 360;
  else if (V.vm !== 'identical') randomize(o, V.vm === 'random colors' ? 'colors' : 'all', r);

  if (V.each) randomize(o, 'all', r, V.rp);
  return o;
}
/* ============================================================
 SOFTWARE RASTERIZER
 There is no canvas in plain Node.js, so everything is drawn here:

   polygons / strokes  ->  coverage mask (Float32Array, 0..1)
   mask + color        ->  blended into the RGB image

 Polygons are filled with the non-zero rule and 4 sub-scanlines per pixel
 (exact horizontal coverage), which gives smooth edges. All polygons are
 forced to the same winding so overlapping shapes form a union.
 ============================================================ */

const SUBSCAN = 4;

/** @returns {Float32Array & {bb?: number[]}} a blank N x N mask */
function newMask(N) {
  const m = new Float32Array(N * N);
  m.bb = [0, 0, -1, -1]; // empty bounding box: [minX, minY, maxX, maxY]
  return m;
}

/**
 * Adds a polygon (flat [x0,y0,x1,y1,...]) to the list, wound the same way as all others.
 * @param {number[][]} polys
 * @param {number[]} pts
 */
function addPoly(polys, pts) {
  let area = 0;
  for (let i = 0, n = pts.length; i < n; i += 2) {
    const j = (i + 2) % n;
    area += pts[i] * pts[j + 1] - pts[j] * pts[i + 1];
  }
  if (area === 0) return;
  if (area < 0) {
    const rev = [];
    for (let i = pts.length - 2; i >= 0; i -= 2) rev.push(pts[i], pts[i + 1]);
    pts = rev;
  }
  polys.push(pts);
}

/**
 * Fills polygons (non-zero rule) into a new mask.
 * @param {number[][]} polys
 * @param {number} N
 * @returns {Float32Array & {bb: number[]}}
 */
function rasterize(polys, N) {
  const mask = newMask(N);
  const H = N * SUBSCAN;
  const rows = new Array(H);

  let minY = H;
  let maxY = -1;

  for (const pts of polys) {
    const n = pts.length;
    for (let i = 0; i < n; i += 2) {
      const j = (i + 2) % n;
      let x0 = pts[i];
      let y0 = pts[i + 1] * SUBSCAN;
      let x1 = pts[j];
      let y1 = pts[j + 1] * SUBSCAN;
      if (y0 === y1) continue;

      let dir = 1;
      if (y0 > y1) {
        [x0, x1] = [x1, x0];
        [y0, y1] = [y1, y0];
        dir = -1;
      }

      const s0 = Math.max(0, Math.ceil(y0 - 0.5));
      const s1 = Math.min(H - 1, Math.ceil(y1 - 0.5) - 1);
      if (s1 < s0) continue;

      const slope = (x1 - x0) / (y1 - y0);
      for (let s = s0; s <= s1; s++) {
        let x = x0 + (s + 0.5 - y0) * slope;
        x = x < 0 ? 0 : x > N ? N : x;
        // x in 1/256 px steps with the direction in the lowest bit.
        (rows[s] || (rows[s] = [])).push(Math.round(x * 256) * 2 + (dir > 0 ? 1 : 0));
      }
      if (s0 < minY) minY = s0;
      if (s1 > maxY) maxY = s1;
    }
  }

  if (maxY < 0) return mask;

  const acc = new Float32Array(N + 2);
  const inv = 1 / SUBSCAN;
  let bbMinX = N;
  let bbMaxX = -1;
  let rowDirty = false;
  let lastRow = Math.floor(minY / SUBSCAN);

  const flushRow = (py) => {
    if (!rowDirty) return;
    const base = py * N;
    for (let x = 0; x < N; x++) {
      if (acc[x] > 0) {
        mask[base + x] = Math.min(1, acc[x] * inv);
        acc[x] = 0;
      }
    }
    acc[N] = 0;
    rowDirty = false;
  };

  for (let s = minY; s <= maxY; s++) {
    const py = Math.floor(s / SUBSCAN);
    if (py !== lastRow) {
      flushRow(lastRow);
      lastRow = py;
    }

    const row = rows[s];
    if (!row) continue;

    const keys = Float64Array.from(row).sort();
    let winding = 0;
    let start = 0;

    for (let k = 0; k < keys.length; k++) {
      const key = keys[k];
      const x = Math.floor(key / 2) / 256;
      const wasInside = winding !== 0;
      winding += key % 2 === 1 ? 1 : -1;
      const isInside = winding !== 0;

      if (!wasInside && isInside) {
        start = x;
      } else if (wasInside && !isInside && x > start) {
        const ia = Math.floor(start);
        const ib = Math.floor(x);
        if (ia === ib) {
          acc[ia] += x - start;
        } else {
          acc[ia] += ia + 1 - start;
          for (let c = ia + 1; c < ib; c++) acc[c] += 1;
          acc[ib] += x - ib;
        }
        if (ia < bbMinX) bbMinX = ia;
        if (ib > bbMaxX) bbMaxX = ib;
        rowDirty = true;
      }
    }
  }
  flushRow(lastRow);

  mask.bb = [clamp(bbMinX, 0, N - 1), clamp(Math.floor(minY / SUBSCAN), 0, N - 1), clamp(bbMaxX, 0, N - 1), clamp(Math.floor(maxY / SUBSCAN), 0, N - 1)];
  if (bbMaxX < 0) mask.bb = [0, 0, -1, -1];
  return mask;
}

/* ---------------- circles and strokes ---------------- */

/**
 * Polygon approximating a circle.
 * @returns {number[]} flat polygon
 */
function circlePoly(cx, cy, r) {
  const n = clamp(Math.ceil((2 * Math.PI) / Math.acos(1 - 0.2 / Math.max(r, 0.3))), 8, 72);
  const pts = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * 2 * Math.PI;
    pts.push(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
  }
  return pts;
}

/**
 * Turns a center line into polygons of the given width.
 * @param {number[][]} polys - output list
 * @param {number[][]} pts - [[x,y], ...]; first == last means a closed path
 * @param {number} w - line width in px
 * @param {'round'|'miter'|'bevel'} join
 * @param {'round'|'square'|'butt'} cap
 */
function strokePath(polys, pts, w, join, cap) {
  const h = w / 2;
  if (!(h > 0)) return;

  // Remove repeated points.
  let p = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    const q = pts[i];
    const last = p[p.length - 1];
    if (Math.hypot(q[0] - last[0], q[1] - last[1]) > 1e-6) p.push(q);
  }

  let closed = false;
  if (p.length > 2 && Math.hypot(p[0][0] - p[p.length - 1][0], p[0][1] - p[p.length - 1][1]) < 1e-6) {
    closed = true;
    p.pop();
  }

  if (p.length === 1) {
    if (cap === 'round' || join === 'round') addPoly(polys, circlePoly(p[0][0], p[0][1], h));
    else addPoly(polys, [p[0][0] - h, p[0][1] - h, p[0][0] + h, p[0][1] - h, p[0][0] + h, p[0][1] + h, p[0][0] - h, p[0][1] + h]);
    return;
  }

  const n = p.length;
  const segCount = closed ? n : n - 1;
  const dirs = [];

  for (let i = 0; i < segCount; i++) {
    const a = p[i];
    const b = p[(i + 1) % n];
    let dx = b[0] - a[0];
    let dy = b[1] - a[1];
    const len = Math.hypot(dx, dy);
    dx /= len;
    dy /= len;
    dirs.push([dx, dy]);

    let ax = a[0];
    let ay = a[1];
    let bx = b[0];
    let by = b[1];

    // Square caps stick out by half the width at both ends of an open path.
    if (!closed && cap === 'square') {
      if (i === 0) {
        ax -= dx * h;
        ay -= dy * h;
      }
      if (i === segCount - 1) {
        bx += dx * h;
        by += dy * h;
      }
    }

    const nx = -dy * h;
    const ny = dx * h;
    addPoly(polys, [ax + nx, ay + ny, bx + nx, by + ny, bx - nx, by - ny, ax - nx, ay - ny]);
  }

  if (!closed && cap === 'round') {
    addPoly(polys, circlePoly(p[0][0], p[0][1], h));
    addPoly(polys, circlePoly(p[n - 1][0], p[n - 1][1], h));
  }

  // Joins.
  const joinAt = (v, d1, d2) => {
    const cross = d1[0] * d2[1] - d1[1] * d2[0];
    const dot = d1[0] * d2[0] + d1[1] * d2[1];
    if (Math.abs(cross) < 1e-9 && dot > 0) return; // straight on

    const n1 = [-d1[1] * h, d1[0] * h];
    const n2 = [-d2[1] * h, d2[0] * h];
    const [vx, vy] = v;

    const bevel = () => {
      addPoly(polys, [vx, vy, vx + n1[0], vy + n1[1], vx + n2[0], vy + n2[1]]);
      addPoly(polys, [vx, vy, vx - n1[0], vy - n1[1], vx - n2[0], vy - n2[1]]);
    };

    if (join === 'round') {
      // Gentle turns (smooth curves) only need a wedge, not a full circle.
      if (dot > 0.9) bevel();
      else addPoly(polys, circlePoly(vx, vy, h));
    } else if (join === 'miter') {
      let mx = n1[0] + n2[0];
      let my = n1[1] + n2[1];
      const ml = Math.hypot(mx, my);
      if (ml < 1e-6) return bevel();
      mx /= ml;
      my /= ml;
      const cosHalf = (mx * n1[0] + my * n1[1]) / h;
      const miterLen = h / cosHalf;
      if (miterLen / h > 2) return bevel(); // miter limit 2, like the canvas
      addPoly(polys, [vx, vy, vx + n1[0], vy + n1[1], vx + mx * miterLen, vy + my * miterLen, vx + n2[0], vy + n2[1]]);
      addPoly(polys, [vx, vy, vx - n1[0], vy - n1[1], vx - mx * miterLen, vy - my * miterLen, vx - n2[0], vy - n2[1]]);
    } else {
      bevel();
    }
  };

  for (let i = 1; i < segCount; i++) joinAt(p[i], dirs[i - 1], dirs[i]);
  if (closed) joinAt(p[0], dirs[segCount - 1], dirs[0]);
}

/**
 * Mask of a set of center lines drawn with a given width.
 * @param {Array<number[][]>} paths
 * @param {number} w
 * @param {string} join
 * @param {number} N
 */
function strokeMask(paths, w, join, N) {
  const cap = join === 'round' ? 'round' : join === 'miter' ? 'square' : 'butt';
  const polys = [];
  for (const path of paths) strokePath(polys, path, w, join, cap);
  return rasterize(polys, N);
}

/* ---------------- mask operations ---------------- */

/** Copy of a mask moved by whole pixels. */
function shiftMask(mask, N, dx, dy) {
  const out = newMask(N);
  const [x0, y0, x1, y1] = mask.bb;
  if (x1 < x0) return out;

  for (let y = y0; y <= y1; y++) {
    const ty = y + dy;
    if (ty < 0 || ty >= N) continue;
    for (let x = x0; x <= x1; x++) {
      const v = mask[y * N + x];
      const tx = x + dx;
      if (v > 0 && tx >= 0 && tx < N) out[ty * N + tx] = v;
    }
  }
  out.bb = [clamp(x0 + dx, 0, N - 1), clamp(y0 + dy, 0, N - 1), clamp(x1 + dx, 0, N - 1), clamp(y1 + dy, 0, N - 1)];
  return out;
}

/** dst = max(dst, src), in place. */
function unionInto(dst, src, N) {
  const [x0, y0, x1, y1] = src.bb;
  if (x1 < x0) return;

  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const i = y * N + x;
      if (src[i] > dst[i]) dst[i] = src[i];
    }
  }

  const d = dst.bb;
  dst.bb = d[2] < d[0] ? [x0, y0, x1, y1] : [Math.min(d[0], x0), Math.min(d[1], y0), Math.max(d[2], x1), Math.max(d[3], y1)];
}

/** Box sizes whose three passes approximate a Gaussian blur of the given sigma. */
function boxRadii(sigma) {
  const wIdeal = Math.sqrt((12 * sigma * sigma) / 3 + 1);
  let wl = Math.floor(wIdeal);
  if (wl % 2 === 0) wl--;
  const wu = wl + 2;
  const m = Math.round((12 * sigma * sigma - 3 * wl * wl - 12 * wl - 9) / (-4 * wl - 4));
  return [0, 1, 2].map((i) => ((i < m ? wl : wu) - 1) / 2);
}

/**
 * Gaussian-like blur of a mask (3 box blurs).
 * @param {Float32Array & {bb: number[]}} mask
 * @param {number} N
 * @param {number} sigma
 * @returns {Float32Array & {bb: number[]}}
 */
function blurMask(mask, N, sigma) {
  if (!(sigma > 0.3)) return mask;
  const [bx0, by0, bx1, by1] = mask.bb;
  if (bx1 < bx0) return mask;

  const radii = boxRadii(sigma);
  const pad = Math.ceil(radii[0] + radii[1] + radii[2]) + 1;
  const x0 = Math.max(0, bx0 - pad);
  const y0 = Math.max(0, by0 - pad);
  const x1 = Math.min(N - 1, bx1 + pad);
  const y1 = Math.min(N - 1, by1 + pad);

  let src = Float32Array.from(mask);
  let dst = new Float32Array(N * N);

  for (const r of radii) {
    const inv = 1 / (2 * r + 1);

    // horizontal
    for (let y = y0; y <= y1; y++) {
      const base = y * N;
      let acc = 0;
      for (let i = x0 - r; i <= x0 + r; i++) if (i >= 0 && i < N) acc += src[base + i];
      for (let x = x0; x <= x1; x++) {
        dst[base + x] = acc * inv;
        const add = x + r + 1;
        const rem = x - r;
        acc += (add < N ? src[base + add] : 0) - (rem >= 0 ? src[base + rem] : 0);
      }
    }
    [src, dst] = [dst, src];

    // vertical
    for (let x = x0; x <= x1; x++) {
      let acc = 0;
      for (let i = y0 - r; i <= y0 + r; i++) if (i >= 0 && i < N) acc += src[i * N + x];
      for (let y = y0; y <= y1; y++) {
        dst[y * N + x] = acc * inv;
        const add = y + r + 1;
        const rem = y - r;
        acc += (add < N ? src[add * N + x] : 0) - (rem >= 0 ? src[rem * N + x] : 0);
      }
    }
    [src, dst] = [dst, src];
  }

  src.bb = [x0, y0, x1, y1];
  return src;
}

/* ---------------- painting ---------------- */

/**
 * Blends a color (or a per-pixel color function) through a mask into the image.
 * @param {{N: number, d: Float32Array, clip: Float32Array|null}} cv
 * @param {Float32Array & {bb?: number[]}} mask
 * @param {number[] | ((x: number, y: number, out: number[]) => void)} paint
 * @param {number} alpha
 */
function paintMask(cv, mask, paint, alpha = 1) {
  const { N, d, clip } = cv;
  const [x0, y0, x1, y1] = mask.bb || [0, 0, N - 1, N - 1];
  const isFn = typeof paint === 'function';
  const out = [0, 0, 0];

  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const i = y * N + x;
      let a = mask[i];
      if (a <= 0) continue;
      a *= alpha;
      if (clip) a *= clip[i];
      if (a <= 0) continue;

      if (isFn) paint(x + 0.5, y + 0.5, out);
      const c = isFn ? out : paint;
      const j = i * 3;
      d[j] += (c[0] - d[j]) * a;
      d[j + 1] += (c[1] - d[j + 1]) * a;
      d[j + 2] += (c[2] - d[j + 2]) * a;
    }
  }
}

/**
 * Signed distance to a rounded square (negative inside).
 * @param {number} x
 * @param {number} y
 * @param {number} N
 * @param {number} inset - distance of the square's edge from the image edge
 * @param {number} rad - corner radius
 */
function sdRound(x, y, N, inset, rad) {
  const half = N / 2 - inset;
  const rr = Math.max(0, Math.min(rad, half));
  const qx = Math.abs(x - N / 2) - (half - rr);
  const qy = Math.abs(y - N / 2) - (half - rr);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - rr;
}
/* ============================================================
 BUILT-IN FONT
 A plain Node.js script cannot use the fonts installed on the computer, so
 the text is drawn with a small vector font that lives in this file: each
 letter is a few center lines that get stroked with the chosen weight.

   - A-Z, 0-9 and  . , - _ ' " ! ? & + / : ( )
   - lowercase letters are drawn as smaller capitals
   - accents are dropped (é -> e), Russian is transliterated (Ж -> ZH)
   - anything else (Arabic, Persian, Chinese, emoji...) cannot be drawn and is
     skipped; a name with nothing drawable gets a play symbol instead

 The 12 "Font" choices of the page become 12 looks of this font (width,
 weight, slant, monospace), they are not the real typefaces.
 Glyph coordinates: x from 0, y from 0 (top) to 8 (baseline).
 ============================================================ */

/** Arc points: center, radii, start and end angle in degrees (0 = right, 90 = down). */
const arc = (cx, cy, rx, ry, a0, a1) => {
  const n = Math.max(2, Math.ceil(Math.abs(a1 - a0) / 6));
  const out = [];
  for (let i = 0; i <= n; i++) {
    const t = ((a0 + ((a1 - a0) * i) / n) * Math.PI) / 180;
    out.push([cx + rx * Math.cos(t), cy + ry * Math.sin(t)]);
  }
  return out;
};
/** Points from a flat number list. */
const pts = (...c) => {
  const out = [];
  for (let i = 0; i < c.length; i += 2) out.push([c[i], c[i + 1]]);
  return out;
};
/** Joins several point lists into one path. */
const join = (...parts) => parts.flat();
/** A small closed square: a dot. */
const dot = (x, y) => pts(x - 0.25, y - 0.25, x + 0.25, y - 0.25, x + 0.25, y + 0.55, x - 0.25, y + 0.55, x - 0.25, y - 0.25);

const FONT = {
  A: { w: 6, p: [pts(0, 8, 3, 0, 6, 8), pts(1.2, 5.2, 4.8, 5.2)] },
  B: { w: 6, p: [join(pts(0, 8, 0, 0, 3.6, 0), arc(3.6, 2, 2, 2, -90, 90), pts(0, 4)), join(pts(0, 4, 3.8, 4), arc(3.8, 6, 2.2, 2, -90, 90), pts(0, 8))] },
  C: { w: 6, p: [arc(3, 4, 3, 4, 320, 40)] },
  D: { w: 6, p: [join(pts(0, 0, 0, 8, 2.5, 8), arc(2.5, 4, 3.5, 4, 90, -90), pts(0, 0))] },
  E: { w: 6, p: [pts(6, 0, 0, 0, 0, 8, 6, 8), pts(0, 4, 4.5, 4)] },
  F: { w: 6, p: [pts(6, 0, 0, 0, 0, 8), pts(0, 4, 4.5, 4)] },
  G: { w: 6, p: [join(arc(3, 4, 3, 4, 320, 0), pts(3.2, 4))] },
  H: { w: 6, p: [pts(0, 0, 0, 8), pts(6, 0, 6, 8), pts(0, 4, 6, 4)] },
  I: { w: 0, p: [pts(0, 0, 0, 8)] },
  J: { w: 5, p: [join(pts(5, 0, 5, 5.5), arc(2.5, 5.5, 2.5, 2.5, 0, 170))] },
  K: { w: 6, p: [pts(0, 0, 0, 8), pts(6, 0, 0, 5), pts(2, 3.3, 6, 8)] },
  L: { w: 5.5, p: [pts(0, 0, 0, 8, 5.5, 8)] },
  M: { w: 6, p: [pts(0, 8, 0, 0, 3, 5, 6, 0, 6, 8)] },
  N: { w: 6, p: [pts(0, 8, 0, 0, 6, 8, 6, 0)] },
  O: { w: 6, p: [arc(3, 4, 3, 4, 0, 360)] },
  P: { w: 6, p: [join(pts(0, 8, 0, 0, 3.5, 0), arc(3.5, 2.2, 2.5, 2.2, -90, 90), pts(0, 4.4))] },
  Q: { w: 6, p: [arc(3, 4, 3, 4, 0, 360), pts(3.5, 5.5, 6.2, 8.4)] },
  R: { w: 6, p: [join(pts(0, 8, 0, 0, 3.5, 0), arc(3.5, 2.2, 2.5, 2.2, -90, 90), pts(0, 4.4)), pts(2.8, 4.4, 6, 8)] },
  S: { w: 6, p: [join(arc(3, 2, 2.8, 2, 330, 90), arc(3, 6, 2.8, 2, 270, 510))] },
  T: { w: 6, p: [pts(0, 0, 6, 0), pts(3, 0, 3, 8)] },
  U: { w: 6, p: [join(pts(0, 0, 0, 5), arc(3, 5, 3, 3, 180, 0), pts(6, 0))] },
  V: { w: 6, p: [pts(0, 0, 3, 8, 6, 0)] },
  W: { w: 6, p: [pts(0, 0, 1.5, 8, 3, 2.5, 4.5, 8, 6, 0)] },
  X: { w: 6, p: [pts(0, 0, 6, 8), pts(6, 0, 0, 8)] },
  Y: { w: 6, p: [pts(0, 0, 3, 4), pts(6, 0, 3, 4, 3, 8)] },
  Z: { w: 6, p: [pts(0, 0, 6, 0, 0, 8, 6, 8)] },
  0: { w: 6, p: [arc(3, 4, 3, 4, 0, 360)] },
  1: { w: 2.4, p: [pts(0, 1.8, 2.4, 0, 2.4, 8)] },
  2: { w: 6, p: [join(arc(3, 2.3, 2.9, 2.3, 190, 400), pts(0, 8, 6, 8))] },
  3: { w: 6, p: [join(arc(2.8, 2, 2.7, 2, 210, 450), arc(2.8, 6, 3, 2, 270, 510))] },
  4: { w: 6, p: [pts(4.5, 8, 4.5, 0, 0, 5.5, 6, 5.5)] },
  5: { w: 6, p: [join(pts(5.5, 0, 1, 0, 1.18, 3.63), arc(2.9, 5.6, 3, 2.4, 235, 510))] },
  6: { w: 6, p: [arc(3, 5.5, 3, 2.5, 0, 360), join(pts(0, 5.5), arc(3, 3.5, 3, 3.5, 180, 300))] },
  7: { w: 6, p: [pts(0, 0, 6, 0, 2, 8)] },
  8: { w: 6, p: [arc(3, 2, 2.6, 2, 0, 360), arc(3, 6, 3, 2, 0, 360)] },
  9: { w: 6, p: [arc(3, 2.5, 3, 2.5, 0, 360), join(pts(6, 2.5, 6, 4.5), arc(3, 4.5, 3, 3.5, 0, 120))] },
  '.': { w: 0, p: [dot(0, 7.4)] },
  ',': { w: 0, p: [pts(0.2, 7.2, -0.2, 9)] },
  '-': { w: 3.5, p: [pts(0, 4, 3.5, 4)] },
  _: { w: 6, p: [pts(0, 8.8, 6, 8.8)] },
  "'": { w: 0, p: [pts(0, 0, 0, 2.2)] },
  '"': { w: 1.4, p: [pts(0, 0, 0, 2.2), pts(1.4, 0, 1.4, 2.2)] },
  '!': { w: 0, p: [pts(0, 0, 0, 5.5), dot(0, 7.4)] },
  '?': { w: 6, p: [join(arc(2.8, 2.3, 2.8, 2.3, 185, 395), pts(2.8, 5, 2.8, 5.8)), dot(2.8, 7.4)] },
  '&': { w: 6, p: [pts(5.9, 8, 1, 2.8, 1, 1.2, 2.2, 0, 3.4, 1.2, 3.4, 2.6, 0.5, 5.6, 0.5, 7, 1.8, 8, 3.6, 8, 5.8, 5.4)] },
  '+': { w: 6, p: [pts(3, 2.5, 3, 6.5), pts(1, 4.5, 5, 4.5)] },
  '/': { w: 3.5, p: [pts(0, 8, 3.5, 0)] },
  ':': { w: 0, p: [dot(0, 2.8), dot(0, 7.4)] },
  '(': { w: 1.3, p: [arc(3, 4, 3, 4, 125, 235)] },
  ')': { w: 1.3, p: [arc(-1.72, 4, 3, 4, -55, 55)] },
  '\u25b6': { w: 5, p: [pts(0.5, 0, 5.5, 4, 0.5, 8, 0.5, 0)] },
};

/** How each "Font" choice of the page is imitated: width, weight, slant, monospace. */
const FONT_STYLE = {
  Sans: { sx: 1, wm: 1, slant: 0 },
  Impact: { sx: 0.74, wm: 1.3, slant: 0 },
  Serif: { sx: 1.08, wm: 0.8, slant: 0 },
  Mono: { sx: 1, wm: 0.85, slant: 0, mono: true },
  Trebuchet: { sx: 0.95, wm: 1.05, slant: 0 },
  Palatino: { sx: 1.12, wm: 0.8, slant: 0 },
  Script: { sx: 1, wm: 0.9, slant: 0.3 },
  'Arial Black': { sx: 1.1, wm: 1.45, slant: 0 },
  Courier: { sx: 1, wm: 0.65, slant: 0, mono: true },
  Verdana: { sx: 1.22, wm: 1, slant: 0 },
  Geometric: { sx: 1.1, wm: 0.9, slant: 0 },
  Display: { sx: 0.82, wm: 1.2, slant: 0.12 },
};

const CYRILLIC = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm',
  н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'kh', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'shch',
  ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya', і: 'i', ї: 'yi', є: 'ye', ґ: 'g',
};
const SPECIAL_LETTERS = { ß: 'ss', æ: 'ae', Æ: 'AE', œ: 'oe', Œ: 'OE', ø: 'o', Ø: 'O', đ: 'd', Đ: 'D', ł: 'l', Ł: 'L', þ: 'th', Þ: 'TH', ı: 'i', İ: 'I', ð: 'd', Ð: 'D' };

/**
 * Makes text drawable with the built-in font (accents removed, Russian
 * transliterated). Characters that stay unknown are kept; drawing skips them.
 * @param {string} s
 * @returns {string}
 */
function foldText(s) {
  let out = '';
  for (const ch of String(s).normalize('NFC')) {
    const lower = ch.toLowerCase();
    if (CYRILLIC[lower] !== undefined) {
      const latin = CYRILLIC[lower];
      out += ch !== lower ? latin.toUpperCase() : latin;
    } else if (SPECIAL_LETTERS[ch] !== undefined) {
      out += SPECIAL_LETTERS[ch];
    } else {
      out += ch.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    }
  }
  return out;
}

/**
 * Glyph and size factor for a character, or null when it cannot be drawn.
 * @param {string} ch
 * @returns {{g: {w: number, p: number[][][]}, s: number}|null}
 */
function glyphFor(ch) {
  if (/[a-z]/.test(ch)) return FONT[ch.toUpperCase()] ? { g: FONT[ch.toUpperCase()], s: 0.78 } : null;
  return Object.prototype.hasOwnProperty.call(FONT, ch) ? { g: FONT[ch], s: 1 } : null;
}

/** True when part of the text cannot be drawn by the built-in font. */
function hasUndrawable(text) {
  for (const ch of foldText(text)) {
    if (ch !== ' ' && !/\s/.test(ch) && !glyphFor(ch)) return true;
  }
  return false;
}

/* ============================================================
 TEXT LAYOUT
 ============================================================ */

/**
 * Lays the text out and returns its center lines in image pixels.
 * Wraps and shrinks the text exactly like the page does.
 * @returns {{paths: number[][][], thk: number, fs: number, lines: string[], lh: number, rect: number[], tf: Function, localW: number, ax: number}}
 */
function layoutText(T, o, N, k) {
  const st = FONT_STYLE[o.font] || FONT_STYLE.Sans;
  const slant = st.slant + (o.it ? 0.22 : 0);
  const cx = N / 2;
  const pad = (o.tp / 100) * N;
  const bw_ = N - 2 * pad;
  const lsPx = o.ls * k;

  let text = foldText(T).replace(/\s+/g, ' ').trim();
  if (![...text].some((ch) => ch !== ' ' && glyphFor(ch))) text = '\u25b6';

  const metrics = (fs) => {
    const capH = fs * 0.72;
    const u = capH / 8;
    const thk = Math.min(capH * 0.3, fs * (0.05 + (0.13 * o.wt) / 900) * st.wm);
    return { u, thk, gap: u + 0.9 * thk };
  };

  /** Glyph items of one line with their advances. */
  const items = (line, fs) => {
    const { u, thk, gap } = metrics(fs);
    const out = [];
    for (const ch of line) {
      if (ch === ' ') {
        const adv = 3.2 * st.sx * u + gap * 0.5 + lsPx;
        out.push({ g: null, adv, gw: adv });
        continue;
      }
      const gl = glyphFor(ch);
      if (!gl) continue;
      const gw = gl.g.w * gl.s * st.sx * u;
      if (st.mono) {
        const cell = 6 * st.sx * u;
        out.push({ ...gl, adv: cell + gap + lsPx, gw: cell, off: (cell - gw) / 2 });
      } else {
        out.push({ ...gl, adv: gw + gap + lsPx, gw, off: 0 });
      }
    }
    return out;
  };

  const widthOf = (its, fs) => {
    if (!its.length) return 0;
    const { thk } = metrics(fs);
    const last = its[its.length - 1];
    return its.reduce((s, i) => s + i.adv, 0) - (last.adv - last.gw) + thk;
  };

  const wrap = (fs) => {
    const lines = [];
    let cur = '';
    for (const w of text.split(' ')) {
      const t = cur ? `${cur} ${w}` : w;
      if (cur && widthOf(items(t, fs), fs) > bw_) {
        lines.push(cur);
        cur = w;
      } else {
        cur = t;
      }
    }
    lines.push(cur);
    return lines;
  };

  let fs = ((N * 0.6) * o.fs) / 100;
  let lines = wrap(fs);
  while (fs > 8) {
    lines = wrap(fs);
    if (Math.max(...lines.map((l) => widthOf(items(l, fs), fs))) <= bw_ && (lines.length * fs * o.lh) / 100 <= bw_) break;
    fs *= 0.94;
  }

  const { u, thk } = metrics(fs);
  const lh = (fs * o.lh) / 100;
  const ax = o.al === 'left' ? -bw_ / 2 : o.al === 'right' ? bw_ / 2 : 0;

  // Local text space (origin = text center) -> image pixels.
  const rot = (o.rot * Math.PI) / 180;
  const ca = Math.cos(rot);
  const sa = Math.sin(rot);
  const ox = cx + (o.tx / 100) * N;
  const oy = cx + (o.ty / 100) * N;
  const tf = (x, y) => [ox + x * ca - y * sa, oy + x * sa + y * ca];

  const paths = [];
  let widest = 0;

  lines.forEach((line, li) => {
    const its = items(line, fs);
    const wl = widthOf(its, fs);
    widest = Math.max(widest, wl);
    const yc = (li - (lines.length - 1) / 2) * lh;
    let pen = (o.al === 'left' ? ax : o.al === 'right' ? ax - wl : ax - wl / 2) + thk / 2;

    for (const it of its) {
      if (it.g) {
        for (const path of it.g.p) {
          paths.push(
            path.map(([gx, gy]) => {
              const ys = 8 - (8 - gy) * it.s; // vertical position in units
              return tf(pen + it.off + gx * it.s * st.sx * u + slant * (8 - ys) * u, yc + (ys - 4) * u);
            }),
          );
        }
      }
      pen += it.adv;
    }
  });

  // Backing rectangle for the text contrast option (page: width of the widest line + fs/2).
  const ww = widest + fs * 0.5;
  const hh = lines.length * lh + fs * 0.3;
  const px0 = ax + (o.al === 'left' ? ww / 2 - fs * 0.25 : o.al === 'right' ? -ww / 2 + fs * 0.25 : 0);
  const rect = [tf(px0 - ww / 2, -hh / 2), tf(px0 + ww / 2, -hh / 2), tf(px0 + ww / 2, hh / 2), tf(px0 - ww / 2, hh / 2)].flat();

  return { paths, thk, fs, lines, lh, rect, ca, sa, ox, oy };
}

/* ============================================================
 THE LOGO
 ============================================================ */

const DEG = Math.PI / 180;

/** Text the logo shows, from the station title and the "Text from title" / "Case" options. */
function logoText(title, o) {
  const clean = (s) =>
    s
      .replace(/[[(].*?[\])]/g, ' ')
      .replace(/\s[-|\u2013\u2014:]\s.*$/, '')
      .replace(/\s+/g, ' ')
      .trim() || s;
  const w0 = clean(title).split(/\s+/);

  let T =
    o.src === 'full' ? title
    : o.src === 'cleaned' ? clean(title)
    : o.src === 'initials' ? w0.map((w) => [...w][0]).join('').slice(0, 4)
    : o.src === 'first word' ? w0[0]
    : o.src === 'first two words' ? w0.slice(0, 2).join(' ')
    : w0[w0.length - 1];

  T =
    o.cs === 'UPPER' ? T.toUpperCase()
    : o.cs === 'lower' ? T.toLowerCase()
    : o.cs === 'Title' ? T.replace(/(^|\s)\p{L}/gu, (c) => c.toUpperCase())
    : T;

  return (T || title || ' ').trim() || ' ';
}

/** Average luminance (0..1) of a region of the image. */
function sampleLuminance(cv, x0, y0, x1, y1) {
  const { N, d } = cv;
  x0 = clamp(Math.floor(x0), 0, N - 1);
  x1 = clamp(Math.ceil(x1), x0 + 1, N);
  y0 = clamp(Math.floor(y0), 0, N - 1);
  y1 = clamp(Math.ceil(y1), y0 + 1, N);

  let sum = 0;
  let n = 0;
  const step = Math.max(1, Math.floor(Math.min(x1 - x0, y1 - y0) / 24));

  for (let y = y0; y < y1; y += step) {
    for (let x = x0; x < x1; x += step) {
      const j = (y * N + x) * 3;
      sum += 0.299 * d[j] + 0.587 * d[j + 1] + 0.114 * d[j + 2];
      n++;
    }
  }
  return n ? sum / n / 255 : 0;
}

/** Closed outline points of a shape, centered on 0,0. */
function shapeOutline(T, R) {
  const g = Math.PI;
  if (T === 'circle' || T === 'ring') return [arc(0, 0, R, R, 0, 360)];
  if (T === 'square') return [pts(-R * 0.8, -R * 0.8, R * 0.8, -R * 0.8, R * 0.8, R * 0.8, -R * 0.8, R * 0.8, -R * 0.8, -R * 0.8)];
  if (T === 'semicircle') return [join(arc(0, 0, R, R, 180, 360), pts(-R, 0))];
  if (T === 'cross') {
    return [
      pts(-R, -R * 0.3, R, -R * 0.3, R, R * 0.3, -R, R * 0.3, -R, -R * 0.3),
      pts(-R * 0.3, -R, R * 0.3, -R, R * 0.3, R, -R * 0.3, R, -R * 0.3, -R),
    ];
  }
  if (T === 'parallelogram') return [pts(-R, R * 0.5, -R * 0.4, -R * 0.5, R, -R * 0.5, R * 0.4, R * 0.5, -R, R * 0.5)];

  const n = { triangle: 3, diamond: 4, pentagon: 5, hexagon: 6, star: 5 }[T] || 4;
  const m = T === 'star' ? 2 : 1;
  const p = [];
  for (let i = 0; i < n * m; i++) {
    const a = -g / 2 + (i * g * 2) / (n * m);
    const r = m > 1 && i % 2 ? R * 0.45 : R;
    p.push([Math.cos(a) * r, Math.sin(a) * r]);
  }
  p.push(p[0]);
  return [p];
}

/** Draws one geometric shape. */
function drawShape(cv, s, k) {
  const N = cv.N;
  const R = ((s.sz / 100) * N) / 2;
  const ca = Math.cos(s.rot * DEG);
  const sa = Math.sin(s.rot * DEG);
  const tx = N / 2 + (s.x / 100) * N;
  const ty = N / 2 + (s.y / 100) * N;
  const place = (p) => p.map(([x, y]) => [tx + x * ca - y * sa, ty + x * sa + y * ca]);

  let lw = Math.max(1, s.lw * k);
  if (s.t === 'ring') lw = Math.max(lw, R * 0.25);

  const polys = [];
  for (const loop of shapeOutline(s.t, R)) {
    const p = place(loop);
    if (s.fill === 'outline' || s.t === 'ring') strokePath(polys, p, lw, 'round', 'round');
    else addPoly(polys, p.slice(0, -1).flat());
  }
  paintMask(cv, rasterize(polys, N), rgb(s.col), s.op / 100);
}

/** Pixelates the image: average blocks, then enlarge without smoothing. */
function pixelate(cv, b) {
  const { N, d } = cv;
  const n = Math.max(4, Math.round(N / b));
  const f = downscale(d, N, n);
  upscale(f, n, d, N);
}

/** Box-average downscale of an RGB float image. */
function downscale(d, N, n) {
  const f = new Float32Array(n * n * 3);
  for (let cy = 0; cy < n; cy++) {
    const ya = Math.floor((cy * N) / n);
    const yb = Math.max(ya + 1, Math.floor(((cy + 1) * N) / n));
    for (let cxx = 0; cxx < n; cxx++) {
      const xa = Math.floor((cxx * N) / n);
      const xb = Math.max(xa + 1, Math.floor(((cxx + 1) * N) / n));
      let r = 0;
      let g = 0;
      let b = 0;
      for (let y = ya; y < yb; y++) {
        for (let x = xa; x < xb; x++) {
          const j = (y * N + x) * 3;
          r += d[j];
          g += d[j + 1];
          b += d[j + 2];
        }
      }
      const cnt = (yb - ya) * (xb - xa);
      const o = (cy * n + cxx) * 3;
      f[o] = r / cnt;
      f[o + 1] = g / cnt;
      f[o + 2] = b / cnt;
    }
  }
  return f;
}

/** Nearest-neighbor enlargement of an n x n RGB float image into d (N x N). */
function upscale(f, n, d, N) {
  for (let y = 0; y < N; y++) {
    const sy = Math.min(n - 1, Math.floor((y * n) / N));
    for (let x = 0; x < N; x++) {
      const sx = Math.min(n - 1, Math.floor((x * n) / N));
      const o = (sy * n + sx) * 3;
      const j = (y * N + x) * 3;
      d[j] = f[o];
      d[j + 1] = f[o + 1];
      d[j + 2] = f[o + 2];
    }
  }
}

/** Dithering (ordered, error diffusion, random). */
function dither(cv, o, k, rr) {
  const { N, d } = cv;
  const n = Math.max(8, Math.round(N / (o.dsc * k)));
  const f = downscale(d, N, n);
  const L = o.dl - 1;
  const mono = o.dcm !== 'original';
  const nc = mono ? 1 : 3;

  if (mono) {
    for (let i = 0; i < n * n; i++) {
      const v = 0.299 * f[i * 3] + 0.587 * f[i * 3 + 1] + 0.114 * f[i * 3 + 2];
      f[i * 3] = f[i * 3 + 1] = f[i * 3 + 2] = v;
    }
  }

  const q = (v) => (Math.round((Math.max(0, Math.min(255, v)) / 255) * L) / L) * 255;
  const st = 255 / L;
  const bm = o.dm.startsWith('Bayer') ? bay(+o.dm.slice(6, 7)) : null;
  const ed =
    o.dm === 'Floyd-Steinberg' ? [[1, 0, 7 / 16], [-1, 1, 3 / 16], [0, 1, 5 / 16], [1, 1, 1 / 16]]
    : o.dm === 'Atkinson' ? [[1, 0, 0.125], [2, 0, 0.125], [-1, 1, 0.125], [0, 1, 0.125], [1, 1, 0.125], [0, 2, 0.125]]
    : null;

  for (let y = 0; y < n; y++) {
    for (let xx = 0; xx < n; xx++) {
      for (let ch = 0; ch < nc; ch++) {
        const i = (y * n + xx) * 3 + ch;
        const v = f[i];
        if (bm) {
          const s = bm.length;
          f[i] = q(v + ((bm[y % s][xx % s] + 0.5) / (s * s) - 0.5) * st);
        } else if (ed) {
          const nv = q(v);
          const er = v - nv;
          f[i] = nv;
          for (const [dx, dy, w] of ed) {
            const ax = xx + dx;
            const ay = y + dy;
            if (ax >= 0 && ax < n && ay < n) f[(ay * n + ax) * 3 + ch] += er * w;
          }
        } else {
          f[i] = q(v + (rr() - 0.5) * st);
        }
      }
    }
  }

  const lo = rgb(o.d1);
  const hi = rgb(o.d2);
  for (let i = 0; i < n * n; i++) {
    if (mono) {
      const v = f[i * 3] / 255;
      if (o.dcm === 'two-tone') for (let j = 0; j < 3; j++) f[i * 3 + j] = lo[j] + (hi[j] - lo[j]) * v;
    }
  }
  upscale(f, n, d, N);
}

/**
 * Draws a complete logo into a new RGB float image.
 * @param {string} title
 * @param {object} o - options (already varied for this station)
 * @param {number} N - image size in px
 * @returns {{N: number, d: Float32Array}}
 */
function draw(title, o, N) {
  const k = N / 512;
  const cx = N / 2;
  const R = Math.min(((o.rad / 100) * N), N / 2);
  const r = rng(hash('m' + o.seed + title));
  const d = new Float32Array(N * N * 3);
  const cv = { N, d, clip: null };
  const matte = rgb(o.matte);

  if (R > 0) {
    cv.clip = new Float32Array(N * N);
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) cv.clip[y * N + x] = clamp(0.5 - sdRound(x + 0.5, y + 0.5, N, 0, R), 0, 1);
  }
  const clipAt = (i) => (cv.clip ? cv.clip[i] : 1);

  /** Blends a color into one pixel, respecting the rounded-corner mask. */
  const blendPx = (i, c, a) => {
    a *= clipAt(i);
    if (a <= 0) return;
    const j = i * 3;
    d[j] += (c[0] - d[j]) * a;
    d[j + 1] += (c[1] - d[j + 1]) * a;
    d[j + 2] += (c[2] - d[j + 2]) * a;
  };

  /* ---------- background ---------- */
  const cols = (o.tri ? [o.c1, o.c2, o.c3] : [o.c1, o.c2]).map(rgb);
  const a = o.ang * DEG;
  const out = [0, 0, 0];

  const stopColor = (cl, t, hard = o.hard) => {
    t = clamp(t, 0, 1);
    const n = cl.length;
    if (hard) return cl[Math.min(n - 1, Math.floor(t * n))];
    const f = t * (n - 1);
    const i = Math.min(n - 2, Math.floor(f));
    const u = f - i;
    out[0] = cl[i][0] + (cl[i + 1][0] - cl[i][0]) * u;
    out[1] = cl[i][1] + (cl[i + 1][1] - cl[i][1]) * u;
    out[2] = cl[i][2] + (cl[i + 1][2] - cl[i][2]) * u;
    return out;
  };

  const bdx = (Math.cos(a) * N) / 2;
  const bdy = (Math.sin(a) * N) / 2;
  const len2 = 4 * (bdx * bdx + bdy * bdy);
  const conicCols = [...cols, cols[0]];

  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const px = x + 0.5;
      const py = y + 0.5;
      let c;

      if (o.bgm === 'linear') c = stopColor(cols, ((px - (cx - bdx)) * 2 * bdx + (py - (cx - bdy)) * 2 * bdy) / len2);
      else if (o.bgm === 'radial') c = stopColor(cols, Math.hypot(px - cx, py - cx) / (N * 0.72));
      else if (o.bgm === 'conic') {
        let t = (Math.atan2(py - cx, px - cx) - a) / (2 * Math.PI);
        t -= Math.floor(t);
        c = stopColor(conicCols, t);
      } else c = cols[0];

      const i = y * N + x;
      const cl = clipAt(i);
      const j = i * 3;
      d[j] = matte[0] + (c[0] - matte[0]) * cl;
      d[j + 1] = matte[1] + (c[1] - matte[1]) * cl;
      d[j + 2] = matte[2] + (c[2] - matte[2]) * cl;
    }
  }

  if (o.bgm === 'mesh') {
    for (let b = 0; b < 6; b++) {
      const bx = r() * N;
      const by = r() * N;
      const rd = N * (0.4 + r() * 0.5);
      const c = cols[b % cols.length];
      const x0 = Math.max(0, Math.floor(bx - rd));
      const x1 = Math.min(N - 1, Math.ceil(bx + rd));
      const y0 = Math.max(0, Math.floor(by - rd));
      const y1 = Math.min(N - 1, Math.ceil(by + rd));
      for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
          const t = Math.hypot(x + 0.5 - bx, y + 0.5 - by) / rd;
          if (t < 1) blendPx(y * N + x, c, 1 - t);
        }
      }
    }
  }

  /* ---------- pattern overlay (analytic, anti-aliased) ---------- */
  if (o.pat !== 'none') {
    const s = o.ps * k;
    const w = Math.max(1, (s * o.pw) / 100);
    const P = o.pat;
    const a0 = -N * 0.6;
    const pa = o.pa / 100;
    const pc = rgb(o.pc);
    const pca = Math.cos(o.pr * DEG);
    const psa = Math.sin(o.pr * DEG);
    let U = 0;
    let Vv = 0;
    const rotate = (x, y) => {
      const dx = x - cx;
      const dy = y - cx;
      U = pca * dx + psa * dy + cx;
      Vv = -psa * dx + pca * dy + cx;
    };

    /** Coverage of a stripe pattern: stripes of width wd every `period`, first one at `start`. */
    const stripe = (c, period, wd, start) => {
      const m = (((c - start) % period) + period) % period;
      return Math.max(clamp(Math.min(m, wd - m) + 0.5, 0, 1), clamp(0.5 - (period - m), 0, 1));
    };

    const pass = (fn) => {
      for (let y = 0; y < N; y++) {
        for (let x = 0; x < N; x++) {
          const cov = fn(x + 0.5, y + 0.5);
          if (cov > 0) blendPx(y * N + x, pc, cov * pa);
        }
      }
    };

    if (P === 'stripes') pass((x, y) => (rotate(x, y), stripe(U, s, w, a0)));
    else if (P === 'grid') {
      pass((x, y) => (rotate(x, y), stripe(U, s, w, a0)));
      pass((x, y) => (rotate(x, y), stripe(Vv, s, w, a0)));
    } else if (P === 'crosses') {
      pass((x, y) => (rotate(x, y), stripe(U, s, w, a0 + s / 2 - w / 2)));
      pass((x, y) => (rotate(x, y), stripe(Vv, s, w, a0 + s / 2 - w / 2)));
    } else if (P === 'rings') {
      pass((x, y) => {
        const dist = Math.hypot(x - cx, y - cx);
        const q = Math.max(1, Math.round(dist / s));
        if (q * s >= N * 1.5) return 0;
        return clamp(w / 2 - Math.abs(dist - q * s) + 0.5, 0, 1);
      });
    } else if (P === 'dots') {
      pass((x, y) => {
        rotate(x, y);
        const cu = (((U - a0) % s) + s) % s;
        const cvv = (((Vv - a0) % s) + s) % s;
        return clamp(w / 2 - Math.hypot(cu - s / 2, cvv - s / 2) + 0.5, 0, 1);
      });
    } else if (P === 'checker') {
      pass((x, y) => {
        let sum = 0;
        for (const [ox, oy] of [[-0.25, -0.25], [0.25, -0.25], [-0.25, 0.25], [0.25, 0.25]]) {
          rotate(x + ox, y + oy);
          if ((Math.floor((U - a0) / s) + Math.floor((Vv - a0) / s)) & 1) sum++;
        }
        return sum / 4;
      });
    } else if (P === 'rays') {
      const n = Math.max(6, Math.round((N * 2) / s)) & ~1;
      pass((x, y) => {
        let sum = 0;
        for (const [ox, oy] of [[-0.25, -0.25], [0.25, -0.25], [-0.25, 0.25], [0.25, 0.25]]) {
          rotate(x + ox, y + oy);
          let ang = Math.atan2(Vv - cx, U - cx);
          if (ang < 0) ang += 2 * Math.PI;
          if (Math.floor((ang / (2 * Math.PI)) * n) % 2 === 0) sum++;
        }
        return sum / 4;
      });
    } else if (P === 'waves' || P === 'zigzag') {
      const period = s * 1.2;
      pass((x, y) => {
        rotate(x, y);
        let j;
        let slope;
        if (P === 'waves') {
          j = Math.sin((U / s) * 2) * s * 0.4;
          slope = Math.cos((U / s) * 2) * 0.8;
        } else {
          const t = (U - a0) / (s / 2);
          const nn = Math.floor(t);
          const ja = (((nn % 2) + 2) % 2 === 0 ? -1 : 1) * s * 0.3;
          j = ja + (-ja - ja) * (t - nn);
          slope = (-2 * ja) / (s / 2);
        }
        const dist = Math.abs((((Vv - j - a0 + period / 2) % period) + period) % period - period / 2);
        return clamp(w / 2 - dist / Math.sqrt(1 + slope * slope) + 0.5, 0, 1);
      });
    }
  }

  const SHP = [...(o.shapes || []), ...randShapes(o, title, rng(hash('s' + o.seed + title)))];
  SHP.filter((s_) => !s_.over).forEach((s_) => drawShape(cv, s_, k));

  /* ---------- text ---------- */
  const T = logoText(title, o);
  const lay = layoutText(T, o, N, k);
  const { paths, thk, fs, lines, lh } = lay;
  const pad = (o.tp / 100) * N;
  const bw_ = N - 2 * pad;

  const tcv = o.tc / 100;
  let dk = false;
  let f1 = o.t1;
  let f2 = o.t2;

  if (tcv > 0) {
    const bh = Math.min(N, lines.length * lh + fs * 0.5);
    const yy = Math.max(0, cx + (o.ty / 100) * N - bh / 2);
    dk = sampleLuminance(cv, pad, yy, pad + bw_, yy + bh) > 0.5;
    const tg = dk ? '#000000' : '#ffffff';
    f1 = mix(o.t1, tg, tcv);
    f2 = mix(o.t2, tg, tcv);
  }

  const swE = tcv > 0 ? Math.max(o.sw, tcv * 12) : o.sw;
  const scE = o.sw > 0 || !tcv ? o.sc : dk ? '#ffffff' : '#000000';
  const outer = (swE + o.sw2) * 2 * k;
  const inner = swE * 2 * k;

  let fillPaint = rgb(f1);
  if (o.tm === 'gradient' || o.tm === 'rainbow') {
    const stops = o.tm === 'rainbow' ? [0, 1, 2, 3, 4, 5].map((i) => rgb(hsl(i * 60, 90, 60))) : [rgb(f1), rgb(f2)];
    const half = (lines.length * lh) / 2;
    fillPaint = (px, py, outc) => {
      // The gradient runs top to bottom of the (rotated) text block.
      const ly = -lay.sa * (px - lay.ox) + lay.ca * (py - lay.oy);
      const c = stopColor(stops, (ly + half) / (2 * half), false);
      outc[0] = c[0];
      outc[1] = c[1];
      outc[2] = c[2];
    };
  } else if (o.tm === 'auto contrast') {
    fillPaint = (lum(o.c1) + lum(o.c2)) / 2 > 0.55 ? [0, 0, 0] : [255, 255, 255];
  }

  const mFill = strokeMask(paths, thk, o.sj, N);
  const mOuter = outer > 0 ? strokeMask(paths, thk + outer, o.sj, N) : null;
  const mInner = swE > 0 ? strokeMask(paths, thk + inner, o.sj, N) : null;

  if (tcv > 0) {
    const rectMask = rasterize([lay.rect], N);
    const color = dk ? [255, 255, 255] : [0, 0, 0];
    paintMask(cv, blurMask(rectMask, N, (tcv * 30 * k) / 2), color, tcv * 0.5);
    paintMask(cv, rectMask, color, tcv * 0.5);
  }

  if (o.ex > 0) {
    const base = outer > 0 ? mOuter : mFill;
    const ea = (o.exa + o.rot) * DEG;
    const ext = newMask(N);
    for (let s = Math.round(o.ex * k); s > 0; s--) {
      unionInto(ext, shiftMask(base, N, Math.round(Math.cos(ea) * s), Math.round(Math.sin(ea) * s)), N);
    }
    paintMask(cv, ext, rgb(o.exc), 1);
  }

  if (o.shx || o.shy || o.shb) {
    const silhouette = outer > 0 ? mOuter : mFill;
    const moved = shiftMask(silhouette, N, Math.round(o.shx * k), Math.round(o.shy * k));
    paintMask(cv, blurMask(moved, N, (o.shb * k) / 2), rgb(o.shc), o.sha / 100);
  }

  if (o.gl > 0) {
    // The page draws the glowing text twice, so the halo is composited twice.
    const halo = blurMask(mFill, N, (o.gl * k) / 2);
    const twice = newMask(N);
    twice.bb = halo.bb;
    const [x0, y0, x1, y1] = halo.bb;
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) twice[y * N + x] = 1 - (1 - halo[y * N + x]) ** 2;
    paintMask(cv, twice, rgb(o.glc), 1);
  }

  if (o.sw2 > 0) paintMask(cv, mOuter, rgb(o.sc2), 1);
  if (swE > 0) paintMask(cv, mInner, rgb(scE), 1);
  paintMask(cv, mFill, fillPaint, 1);

  SHP.filter((s_) => s_.over).forEach((s_) => drawShape(cv, s_, k));

  /* ---------- frame + vignette ---------- */
  if (o.bw > 0 || o.bw2 > 0 || o.vig > 0) {
    const i2 = (o.bw + o.bgp) * k + (o.bw2 * k) / 2;
    const bc = rgb(o.bc);
    const bc2 = rgb(o.bc2);

    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        const px = x + 0.5;
        const py = y + 0.5;
        const i = y * N + x;

        if (o.bw > 0) {
          const cov = clamp(o.bw * k - Math.abs(sdRound(px, py, N, 0, R)) + 0.5, 0, 1);
          if (cov > 0) blendPx(i, bc, cov);
        }
        if (o.bw2 > 0) {
          const cov = clamp((o.bw2 * k) / 2 - Math.abs(sdRound(px, py, N, i2, R - i2)) + 0.5, 0, 1);
          if (cov > 0) blendPx(i, bc2, cov);
        }
        if (o.vig > 0) {
          const t = clamp((Math.hypot(px - cx, py - cx) - N * 0.25) / (N * 0.5), 0, 1);
          if (t > 0) blendPx(i, [0, 0, 0], (t * o.vig) / 100);
        }
      }
    }
  }

  /* ---------- pixel passes ---------- */
  if (o.pix > 1) pixelate(cv, Math.max(1, Math.round(o.pix * k)));

  if (o.grain || o.scan || o.rgb || o.gli || o.br !== 100 || o.ct !== 100 || o.sa !== 100 || o.hue || o.inv) {
    if (o.gli) {
      const rr = rng(hash('g' + title + o.seed));
      for (let i = 0; i < o.gli * 2; i++) {
        const y = (rr() * N) | 0;
        const h = (rr() * 0.06 * N + 2) | 0;
        const sh = ((rr() - 0.5) * o.gli * k * 6) | 0;
        for (let yy = y; yy < Math.min(N, y + h); yy++) {
          const s = yy * N * 3;
          const row = d.slice(s, s + N * 3);
          for (let xx = 0; xx < N; xx++) {
            const sx = (xx - sh + N * 4) % N;
            d.set(row.subarray(sx * 3, sx * 3 + 3), s + xx * 3);
          }
        }
      }
    }

    if (o.rgb) {
      const src = d.slice();
      const off = Math.round(o.rgb * k);
      for (let yy = 0; yy < N; yy++) {
        for (let xx = 0; xx < N; xx++) {
          const i = (yy * N + xx) * 3;
          d[i] = src[(yy * N + Math.min(N - 1, xx + off)) * 3];
          d[i + 2] = src[(yy * N + Math.max(0, xx - off)) * 3 + 2];
        }
      }
    }

    const cs = Math.cos(o.hue * DEG);
    const sn = Math.sin(o.hue * DEG);
    const m = [
      0.213 + cs * 0.787 - sn * 0.213, 0.715 - cs * 0.715 - sn * 0.715, 0.072 - cs * 0.072 + sn * 0.928,
      0.213 - cs * 0.213 + sn * 0.143, 0.715 + cs * 0.285 + sn * 0.14, 0.072 - cs * 0.072 - sn * 0.283,
      0.213 - cs * 0.213 - sn * 0.787, 0.715 - cs * 0.715 + sn * 0.715, 0.072 + cs * 0.928 + sn * 0.072,
    ];
    const b = o.br / 100;
    const c = o.ct / 100;
    const sa = o.sa / 100;
    const sp = Math.max(2, Math.round(4 * k));
    const gr = rng(hash('n' + title + o.seed));

    for (let p = 0; p < N * N; p++) {
      const i = p * 3;
      let r_ = d[i];
      let g_ = d[i + 1];
      let b_ = d[i + 2];

      if (o.hue) {
        const R2 = m[0] * r_ + m[1] * g_ + m[2] * b_;
        const G2 = m[3] * r_ + m[4] * g_ + m[5] * b_;
        b_ = m[6] * r_ + m[7] * g_ + m[8] * b_;
        r_ = R2;
        g_ = G2;
      }

      const l = 0.299 * r_ + 0.587 * g_ + 0.114 * b_;
      r_ = (l + (r_ - l) * sa - 128) * c + 128;
      g_ = (l + (g_ - l) * sa - 128) * c + 128;
      b_ = (l + (b_ - l) * sa - 128) * c + 128;
      r_ *= b;
      g_ *= b;
      b_ *= b;

      if (o.inv) {
        r_ = 255 - r_;
        g_ = 255 - g_;
        b_ = 255 - b_;
      }
      if (o.grain) {
        const n = (gr() - 0.5) * o.grain * 2.5;
        r_ += n;
        g_ += n;
        b_ += n;
      }
      if (o.scan && ((p / N / (sp / 2)) | 0) % 2) {
        const f = 1 - (o.scan / 100) * 0.7;
        r_ *= f;
        g_ *= f;
        b_ *= f;
      }

      d[i] = clamp(r_, 0, 255);
      d[i + 1] = clamp(g_, 0, 255);
      d[i + 2] = clamp(b_, 0, 255);
    }
  }

  if (o.dm !== 'none') dither(cv, o, k, rng(hash('d' + title + o.seed)));

  // Outside the rounded corners the image is the matte color again.
  if (cv.clip) {
    for (let p = 0; p < N * N; p++) {
      const cl = cv.clip[p];
      if (cl < 1) {
        const i = p * 3;
        d[i] = matte[0] + (d[i] - matte[0]) * cl;
        d[i + 1] = matte[1] + (d[i + 1] - matte[1]) * cl;
        d[i + 2] = matte[2] + (d[i + 2] - matte[2]) * cl;
      }
    }
  }

  return cv;
}
/* ============================================================
 JPEG ENCODER (baseline, 4:4:4, standard Huffman tables)
 ============================================================ */

const JPEG_ZIGZAG = [
  0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5, 12, 19, 26, 33, 40, 48, 41, 34, 27, 20, 13, 6, 7, 14, 21, 28,
  35, 42, 49, 56, 57, 50, 43, 36, 29, 22, 15, 23, 30, 37, 44, 51, 58, 59, 52, 45, 38, 31, 39, 46, 53, 60, 61, 54, 47, 55, 62, 63,
];

const JPEG_QT_LUMA = [
  16, 11, 10, 16, 24, 40, 51, 61, 12, 12, 14, 19, 26, 58, 60, 55, 14, 13, 16, 24, 40, 57, 69, 56, 14, 17, 22, 29, 51, 87, 80, 62,
  18, 22, 37, 56, 68, 109, 103, 77, 24, 35, 55, 64, 81, 104, 113, 92, 49, 64, 78, 87, 103, 121, 120, 101, 72, 92, 95, 98, 112, 100, 103, 99,
];

const JPEG_QT_CHROMA = [
  17, 18, 24, 47, 99, 99, 99, 99, 18, 21, 26, 66, 99, 99, 99, 99, 24, 26, 56, 99, 99, 99, 99, 99, 47, 66, 99, 99, 99, 99, 99, 99,
  99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99,
];

const HUFF_DC_LUMA_BITS = [0, 1, 5, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0];
const HUFF_DC_CHROMA_BITS = [0, 3, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0];
const HUFF_DC_VALS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];

const HUFF_AC_LUMA_BITS = [0, 2, 1, 3, 3, 2, 4, 3, 5, 5, 4, 4, 0, 0, 1, 0x7d];
const HUFF_AC_LUMA_VALS = [
  0x01, 0x02, 0x03, 0x00, 0x04, 0x11, 0x05, 0x12, 0x21, 0x31, 0x41, 0x06, 0x13, 0x51, 0x61, 0x07, 0x22, 0x71, 0x14, 0x32, 0x81, 0x91, 0xa1, 0x08,
  0x23, 0x42, 0xb1, 0xc1, 0x15, 0x52, 0xd1, 0xf0, 0x24, 0x33, 0x62, 0x72, 0x82, 0x09, 0x0a, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x25, 0x26, 0x27, 0x28,
  0x29, 0x2a, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3a, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49, 0x4a, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59,
  0x5a, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69, 0x6a, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7a, 0x83, 0x84, 0x85, 0x86, 0x87, 0x88, 0x89,
  0x8a, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9a, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7, 0xa8, 0xa9, 0xaa, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6,
  0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3, 0xc4, 0xc5, 0xc6, 0xc7, 0xc8, 0xc9, 0xca, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda, 0xe1, 0xe2,
  0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea, 0xf1, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8, 0xf9, 0xfa,
];

const HUFF_AC_CHROMA_BITS = [0, 2, 1, 2, 4, 4, 3, 4, 7, 5, 4, 4, 0, 1, 2, 0x77];
const HUFF_AC_CHROMA_VALS = [
  0x00, 0x01, 0x02, 0x03, 0x11, 0x04, 0x05, 0x21, 0x31, 0x06, 0x12, 0x41, 0x51, 0x07, 0x61, 0x71, 0x13, 0x22, 0x32, 0x81, 0x08, 0x14, 0x42, 0x91,
  0xa1, 0xb1, 0xc1, 0x09, 0x23, 0x33, 0x52, 0xf0, 0x15, 0x62, 0x72, 0xd1, 0x0a, 0x16, 0x24, 0x34, 0xe1, 0x25, 0xf1, 0x17, 0x18, 0x19, 0x1a, 0x26,
  0x27, 0x28, 0x29, 0x2a, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3a, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49, 0x4a, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58,
  0x59, 0x5a, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69, 0x6a, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7a, 0x82, 0x83, 0x84, 0x85, 0x86, 0x87,
  0x88, 0x89, 0x8a, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9a, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7, 0xa8, 0xa9, 0xaa, 0xb2, 0xb3, 0xb4,
  0xb5, 0xb6, 0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3, 0xc4, 0xc5, 0xc6, 0xc7, 0xc8, 0xc9, 0xca, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda,
  0xe2, 0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8, 0xf9, 0xfa,
];

/** Huffman code (value -> [code, length]) from the bits / values lists. */
function buildHuffman(bits, vals) {
  const codes = new Array(256);
  let code = 0;
  let k = 0;
  for (let len = 1; len <= 16; len++) {
    for (let i = 0; i < bits[len - 1]; i++) codes[vals[k++]] = [code++, len];
    code <<= 1;
  }
  return codes;
}

const HUFF = {
  dcLuma: buildHuffman(HUFF_DC_LUMA_BITS, HUFF_DC_VALS),
  dcChroma: buildHuffman(HUFF_DC_CHROMA_BITS, HUFF_DC_VALS),
  acLuma: buildHuffman(HUFF_AC_LUMA_BITS, HUFF_AC_LUMA_VALS),
  acChroma: buildHuffman(HUFF_AC_CHROMA_BITS, HUFF_AC_CHROMA_VALS),
};

/** DCT matrix: row u, column x, including the 1/2 scaling of each pass. */
const DCT = (() => {
  const m = new Float64Array(64);
  for (let u = 0; u < 8; u++) {
    for (let x = 0; x < 8; x++) {
      m[u * 8 + x] = 0.5 * (u === 0 ? Math.SQRT1_2 : 1) * Math.cos(((2 * x + 1) * u * Math.PI) / 16);
    }
  }
  return m;
})();

/**
 * Encodes an RGB image (float 0..255) as a baseline JPEG.
 * @param {Float32Array} rgbData - W*H*3 values
 * @param {number} W
 * @param {number} H
 * @param {number} quality - 1..100
 * @returns {Buffer}
 */
function encodeJpeg(rgbData, W, H, quality) {
  quality = clamp(Math.round(quality), 1, 100);
  const scale = quality < 50 ? 5000 / quality : 200 - quality * 2;
  const quant = (table) => table.map((v) => clamp(Math.floor((v * scale + 50) / 100), 1, 255));
  const qLuma = quant(JPEG_QT_LUMA);
  const qChroma = quant(JPEG_QT_CHROMA);

  const out = [];
  const bytes = (...b) => out.push(...b);
  const word = (v) => bytes((v >> 8) & 255, v & 255);

  // Headers.
  word(0xffd8);
  word(0xffe0);
  word(16);
  bytes(0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0); // JFIF 1.01, 1:1 aspect

  [[0, qLuma], [1, qChroma]].forEach(([id, table]) => {
    word(0xffdb);
    word(67);
    bytes(id);
    for (let i = 0; i < 64; i++) bytes(table[JPEG_ZIGZAG[i]]);
  });

  word(0xffc0);
  word(17);
  bytes(8);
  word(H);
  word(W);
  bytes(3, 1, 0x11, 0, 2, 0x11, 1, 3, 0x11, 1);

  [[0x00, HUFF_DC_LUMA_BITS, HUFF_DC_VALS], [0x10, HUFF_AC_LUMA_BITS, HUFF_AC_LUMA_VALS], [0x01, HUFF_DC_CHROMA_BITS, HUFF_DC_VALS], [0x11, HUFF_AC_CHROMA_BITS, HUFF_AC_CHROMA_VALS]].forEach(
    ([id, bits, vals]) => {
      word(0xffc4);
      word(19 + vals.length);
      bytes(id, ...bits, ...vals);
    },
  );

  word(0xffda);
  word(12);
  bytes(3, 1, 0x00, 2, 0x11, 3, 0x11, 0, 63, 0);

  // Entropy coded data.
  let bitBuf = 0;
  let bitCnt = 0;
  const putBits = (code, len) => {
    bitBuf = (bitBuf << len) | code;
    bitCnt += len;
    while (bitCnt >= 8) {
      const b = (bitBuf >> (bitCnt - 8)) & 255;
      out.push(b);
      if (b === 0xff) out.push(0);
      bitCnt -= 8;
    }
    bitBuf &= (1 << bitCnt) - 1;
  };

  const category = (v) => {
    v = Math.abs(v);
    let n = 0;
    while (v) {
      n++;
      v >>= 1;
    }
    return n;
  };

  const planes = [new Float32Array(64), new Float32Array(64), new Float32Array(64)];
  const tmp = new Float64Array(64);
  const coef = new Int32Array(64);
  const prevDC = [0, 0, 0];
  const wBlocks = Math.ceil(W / 8);
  const hBlocks = Math.ceil(H / 8);

  for (let by = 0; by < hBlocks; by++) {
    for (let bx = 0; bx < wBlocks; bx++) {
      // Gather the block as Y, Cb, Cr (edges repeat when the size is not a multiple of 8).
      for (let y = 0; y < 8; y++) {
        const sy = Math.min(H - 1, by * 8 + y);
        for (let x = 0; x < 8; x++) {
          const sx = Math.min(W - 1, bx * 8 + x);
          const j = (sy * W + sx) * 3;
          const r = clamp(rgbData[j], 0, 255);
          const g = clamp(rgbData[j + 1], 0, 255);
          const b = clamp(rgbData[j + 2], 0, 255);
          const p = y * 8 + x;
          planes[0][p] = 0.299 * r + 0.587 * g + 0.114 * b - 128;
          planes[1][p] = -0.168736 * r - 0.331264 * g + 0.5 * b;
          planes[2][p] = 0.5 * r - 0.418688 * g - 0.081312 * b;
        }
      }

      for (let c = 0; c < 3; c++) {
        const f = planes[c];
        const qt = c === 0 ? qLuma : qChroma;
        const dcT = c === 0 ? HUFF.dcLuma : HUFF.dcChroma;
        const acT = c === 0 ? HUFF.acLuma : HUFF.acChroma;

        // 2D DCT: rows, then columns.
        for (let y = 0; y < 8; y++) {
          for (let u = 0; u < 8; u++) {
            let s = 0;
            for (let x = 0; x < 8; x++) s += f[y * 8 + x] * DCT[u * 8 + x];
            tmp[y * 8 + u] = s;
          }
        }
        for (let u = 0; u < 8; u++) {
          for (let v = 0; v < 8; v++) {
            let s = 0;
            for (let y = 0; y < 8; y++) s += tmp[y * 8 + u] * DCT[v * 8 + y];
            coef[v * 8 + u] = Math.round(s / qt[v * 8 + u]);
          }
        }

        // DC
        const dc = coef[0];
        const diff = dc - prevDC[c];
        prevDC[c] = dc;
        const cat = category(diff);
        putBits(dcT[cat][0], dcT[cat][1]);
        if (cat) putBits(diff < 0 ? (diff - 1) & ((1 << cat) - 1) : diff, cat);

        // AC
        let zeros = 0;
        for (let i = 1; i < 64; i++) {
          const v = coef[JPEG_ZIGZAG[i]];
          if (v === 0) {
            zeros++;
            continue;
          }
          while (zeros > 15) {
            putBits(acT[0xf0][0], acT[0xf0][1]);
            zeros -= 16;
          }
          const ac = category(v);
          const sym = (zeros << 4) | ac;
          putBits(acT[sym][0], acT[sym][1]);
          putBits(v < 0 ? (v - 1) & ((1 << ac) - 1) : v, ac);
          zeros = 0;
        }
        if (zeros > 0) putBits(acT[0][0], acT[0][1]); // end of block
      }
    }
  }

  if (bitCnt > 0) putBits((1 << (8 - bitCnt)) - 1, 8 - bitCnt); // pad with 1 bits
  word(0xffd9);
  return Buffer.from(out);
}

/**
 * Renders one logo and returns the JPEG file.
 * @param {string} title
 * @param {object} o - options for this station
 * @param {number} N - size in px
 * @param {number} quality
 * @returns {Buffer}
 */
function renderLogo(title, o, N, quality) {
  return encodeJpeg(draw(title, o, N).d, N, N, quality);
}

/* ============================================================
 ZIP WRITER (stored, no compression: JPEGs do not shrink anyway)
 ============================================================ */

const CRC_TABLE = (() => {
  const t = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 255] ^ (c >>> 8);
  return ~c >>> 0;
}

/**
 * Builds a ZIP file.
 * @param {Array<{name: string, data: Buffer}>} files
 * @returns {Buffer}
 */
function makeZip(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  const now = new Date();
  const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
  const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();

  for (const file of files) {
    const name = Buffer.from(file.name, 'utf8');
    const crc = crc32(file.data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(0, 8); // stored
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(file.data.length, 18);
    local.writeUInt32LE(file.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, file.data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(dosTime, 12);
    central.writeUInt16LE(dosDate, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(file.data.length, 20);
    central.writeUInt32LE(file.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);

    offset += 30 + name.length + file.data.length;
  }

  const centralSize = centrals.reduce((s, b) => s + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);

  return Buffer.concat([...locals, ...centrals, end]);
}
/* ============================================================
 WORKER THREADS
 Drawing a logo takes a few hundred milliseconds of pure CPU work, so the
 script starts one worker thread per core (the script file itself is the
 worker) and sends them the logos to draw.
 ============================================================ */

if (!isMainThread) {
  parentPort.on('message', ({ id, title, opts, size, q }) => {
    try {
      const jpg = renderLogo(title, opts, size, q);
      const bytes = new Uint8Array(jpg.length);
      bytes.set(jpg);
      parentPort.postMessage({ id, jpg: bytes }, [bytes.buffer]);
    } catch (error) {
      parentPort.postMessage({ id, error: String((error && error.stack) || error) });
    }
  });
}

/**
 * A pool of render workers. With 0 workers the logos are drawn on the main thread.
 * @param {number} size
 * @returns {{render: (job: object) => Promise<Buffer|null>, close: () => Promise<void>}}
 */
function createRenderPool(size) {
  if (size <= 0) {
    return {
      render: async ({ title, opts, size: n, q }) => (timeUp ? null : renderLogo(title, opts, n, q)),
      close: async () => {},
    };
  }

  const workers = new Set();
  const idle = [];
  const queue = [];
  const running = new Map(); // worker -> { id, resolve, reject }
  let nextId = 1;

  function pump() {
    while (idle.length && queue.length) {
      const job = queue.shift();
      if (timeUp) {
        job.resolve(null);
        continue;
      }
      const worker = idle.pop();
      running.set(worker, job);
      worker.postMessage({ id: job.id, title: job.title, opts: job.opts, size: job.size, q: job.q });
    }
  }

  function spawn() {
    const worker = new Worker(__filename);
    workers.add(worker);

    worker.on('message', (msg) => {
      const job = running.get(worker);
      running.delete(worker);
      idle.push(worker);
      if (job) {
        if (msg.error) job.reject(new Error(msg.error));
        else job.resolve(Buffer.from(msg.jpg.buffer, msg.jpg.byteOffset, msg.jpg.byteLength));
      }
      pump();
    });

    worker.on('error', (error) => {
      const job = running.get(worker);
      running.delete(worker);
      workers.delete(worker);
      if (job) job.reject(error);
      spawn(); // replace the dead worker
    });

    idle.push(worker);
    return worker;
  }

  for (let i = 0; i < size; i++) spawn();

  return {
    render: (job) =>
      new Promise((resolve, reject) => {
        queue.push({ ...job, id: nextId++, resolve, reject });
        pump();
      }),
    close: async () => {
      await Promise.all([...workers].map((w) => w.terminate()));
    },
  };
}

/* ============================================================
 PROGRESS
 ============================================================ */

/** Set to true when MAX_RUNTIME_MS is reached; no new logos are started. */
let timeUp = false;

const stats = {
  startTime: Date.now(),
  totalFiles: 0,
  filesParsed: 0,
  filesDone: 0,
  totalLinks: 0, // logos to draw
  checked: 0,
  rendered: 0,
  skipped: 0,
  updatedEntries: 0,
  // fileName -> { total, checked }
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
  const percent = stats.totalLinks > 0 ? ((stats.checked / stats.totalLinks) * 100).toFixed(1) : '0.0';
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
    `[${label}] Logos: ${stats.checked}/${stats.totalLinks} done (${percent}%): ${stats.rendered} drawn, ${stats.skipped} already existed`,
    `[${label}] Playlist entries updated: ${stats.updatedEntries}`,
  ];

  if (!final) {
    lines.push(`[${label}] Speed: ${rate.toFixed(1)} logos/s, ETA: ${eta}`);
    if (stats.activeFiles.size > 0) {
      const active = [...stats.activeFiles.entries()]
        .sort((a, b) => b[1].total - b[1].checked - (a[1].total - a[1].checked))
        .slice(0, 5);
      lines.push(`[${label}] Busiest unfinished files (${stats.activeFiles.size} in progress):`);
      for (const [name, info] of active) {
        lines.push(`[${label}] ${name}: ${info.checked}/${info.total} logos`);
      }
    }
  } else {
    lines.push(`[${label}] Average speed: ${rate.toFixed(1)} logos/s`);
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
 M3U PARSING
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

/**
 * Parses M3U content into a header and a list of entries.
 * @param {string} text
 * @returns {{extm3u: string, header: string[], entries: Array<object>}}
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
    entry.hasLogo = !!entry.extinf && /tvg-logo\s*=\s*"[^"]+"/i.test(entry.extinf);
  });

  return { extm3u, header, entries };
}

/**
 * The lines of one entry, optionally with a replacement #EXTINF.
 * @param {object} entry
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

/**
 * Sets tvg-logo on an #EXTINF line (replacing an existing one).
 * @param {string} extinfLine
 * @param {string} logoValue
 * @returns {string}
 */
function applyLogo(extinfLine, logoValue) {
  const { prefix, title } = splitExtinf(extinfLine);
  const safe = String(logoValue).replace(/"/g, '%22').replace(/\s/g, '%20');

  const newPrefix = /\btvg-logo\s*=\s*"[^"]*"/i.test(prefix)
    ? prefix.replace(/\btvg-logo\s*=\s*"[^"]*"/i, `tvg-logo="${safe}"`)
    : `${prefix} tvg-logo="${safe}"`;

  return `${newPrefix},${title}`;
}

/**
 * The title a logo is designed from: the "- mp3 - 128kb" suffix that the metadata
 * embedder adds is removed, so "Jazz FM" and "Jazz FM - mp3 - 128kb" get the same logo.
 * @param {string} title
 * @returns {string}
 */
function designTitle(title) {
  const t = title
    .replace(/\s+-\s+(?:mp3|aac|ogg|opus|wav|flac|webm|ts|m3u8|m4a)(?:\s+-\s+\d+kb)?$/i, '')
    .replace(/\s+-\s+\d+kb$/i, '')
    .trim();
  return t || title;
}

/** Titles (see designTitle) of the entries that need a logo, without duplicates. */
function titlesNeedingLogo(parsed, overwrite) {
  const titles = new Set();
  for (const e of parsed.entries) {
    if (e.extinf && e.title && (overwrite || !e.hasLogo)) titles.add(designTitle(e.title));
  }
  return [...titles];
}

/* ============================================================
 LOOKS AND OPTION VALUES
 ============================================================ */

/** Options that belong to the output, not to the design: a look file does not change them. */
const OUTPUT_OPTIONS = ['pre', 'useurl', 'urlpre', 'ow', 'plain'];

/**
 * Checks and converts one option value.
 * @param {object} c - option definition
 * @param {any} raw
 * @returns {{ok: true, value: any} | {ok: false, error: string}}
 */
function coerceOption(c, raw) {
  if (c.ty === 'r') {
    const n = Number(raw);
    if (raw === '' || raw === null || !Number.isFinite(n)) return { ok: false, error: `${c.id} needs a number (${c.a} to ${c.b})` };
    const st = c.st || 1;
    return { ok: true, value: clamp(Math.round((n - c.a) / st) * st + c.a, c.a, c.b) };
  }
  if (c.ty === 's') {
    const match = c.a.find((o) => String(o).toLowerCase() === String(raw).toLowerCase());
    return match !== undefined ? { ok: true, value: match } : { ok: false, error: `${c.id} must be one of: ${c.a.join(', ')}` };
  }
  if (c.ty === 'c') {
    let s = String(raw).trim().toLowerCase();
    if (/^[0-9a-f]{3}$/.test(s)) s = `#${[...s].map((ch) => ch + ch).join('')}`;
    if (/^[0-9a-f]{6}$/.test(s)) s = `#${s}`;
    return /^#[0-9a-f]{6}$/.test(s) ? { ok: true, value: s } : { ok: false, error: `${c.id} needs a color like #ff6a1a` };
  }
  if (c.ty === 'k') {
    if (typeof raw === 'boolean') return { ok: true, value: raw };
    const s = String(raw).toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(s)) return { ok: true, value: true };
    if (['0', 'false', 'no', 'off'].includes(s)) return { ok: true, value: false };
    return { ok: false, error: `${c.id} must be true or false` };
  }
  return { ok: true, value: String(raw) };
}

/**
 * Applies a look file saved by the page ("Save look") to the options.
 * @param {object} V
 * @param {object} data - parsed JSON
 * @returns {number} number of values that were ignored
 */
function applyLook(V, data) {
  const settings = data && typeof data.settings === 'object' ? data.settings : data;
  let ignored = 0;

  for (const c of ALL) {
    if (OUTPUT_OPTIONS.includes(c.id) || settings[c.id] === undefined) continue;
    const result = coerceOption(c, settings[c.id]);
    if (result.ok) V[c.id] = result.value;
    else ignored++;
  }

  if (Array.isArray(data.shapes)) {
    V.shapes = data.shapes
      .filter((s) => s && SHT.includes(s.t))
      .map((s) => ({
        t: s.t,
        col: /^#[0-9a-f]{6}$/i.test(s.col) ? s.col : '#ffd100',
        sz: Number(s.sz) || 30,
        x: Number(s.x) || 0,
        y: Number(s.y) || 0,
        rot: Number(s.rot) || 0,
        op: Number(s.op) || 100,
        fill: s.fill === 'outline' ? 'outline' : 'filled',
        lw: Number(s.lw) || 6,
        over: !!s.over,
      }));
  }
  return ignored;
}

/** The look as a JSON object, in the format of the page's "Save look" button. */
function lookData(V) {
  const settings = {};
  ALL.forEach((c) => (settings[c.id] = V[c.id]));
  return { app: 'm3u-logo-designer', version: 1, settings, shapes: V.shapes };
}

/** Prints every option with its type, range and default. */
function printOptions() {
  for (const [group, items] of G) {
    console.log(`\n${group}`);
    for (const [id, label, ty, def, a, b, st] of items) {
      let range = '';
      if (ty === 'r') range = `${a} to ${b}${st ? `, step ${st}` : ''}`;
      else if (ty === 's') range = a.join(' | ');
      else if (ty === 'c') range = '#rrggbb';
      else if (ty === 'k') range = 'true | false';
      console.log(`  ${id.padEnd(7)} ${String(def).padEnd(8)} ${label}${range ? `  [${range}]` : ''}`);
    }
  }
}

/* ============================================================
 FILE NAMES
 ============================================================ */

const nameByTitle = new Map(); // title -> file name
const titleByName = new Map(); // file name -> title

/**
 * Stable file name for a station's logo: readable slug plus a short hash of
 * the title, so the same station always gets the same file.
 * @param {string} title
 * @param {boolean} plain - no hash
 * @returns {string}
 */
function logoFileName(title, plain) {
  if (nameByTitle.has(title)) return nameByTitle.get(title);

  const hs = hash(title).toString(36);
  const slug = foldText(title)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '');

  let base = plain ? slug || `station-${hs}` : slug ? `${slug}-${hs.slice(0, 5)}` : `station-${hs}`;
  let name = base;
  for (let n = 2; titleByName.has(`${name}.jpg`) && titleByName.get(`${name}.jpg`) !== title; n++) {
    name = `${base}-${n}`;
  }

  nameByTitle.set(title, `${name}.jpg`);
  titleByName.set(`${name}.jpg`, title);
  return `${name}.jpg`;
}

/* ============================================================
 PROCESSING
 ============================================================ */

/**
 * Processes one M3U file.
 * fileName is the path relative to inputDir (e.g. "rock/90s/a.m3u").
 * @param {string} inputDir
 * @param {string} outputDir
 * @param {string} fileName - relative path, "/" separated
 * @param {object} run - run settings (see main)
 */
async function processFile(inputDir, outputDir, fileName, run) {
  const { quiet, V, size, pool } = run;

  // Bail early if the global time limit was already hit before this file started.
  if (timeUp) {
    if (!quiet) console.log(`[${fileName}] Skipped (runtime limit already reached).`);
    return;
  }

  const fullPath = path.join(inputDir, fileName);
  const parsed = parseM3U(await fs.readFile(fullPath, 'utf8'));
  const titles = titlesNeedingLogo(parsed, V.ow);

  stats.filesParsed++;
  stats.activeFiles.set(fileName, { total: titles.length, checked: 0 });

  if (!quiet) {
    console.log(`[${fileName}] Found ${parsed.entries.length} entries, ${titles.length} different titles need a logo.`);
  }

  async function removeFromInput() {
    try {
      await fs.unlink(fullPath);
      if (!quiet) console.log(`[${fileName}] Removed from input folder.`);
    } catch (err) {
      console.warn(`[${fileName}] Could not remove input file: ${err.message}`);
    }
  }

  if (parsed.entries.length === 0) {
    if (!quiet) console.log(`[${fileName}] No entries found. Skipped.`);
    await removeFromInput();
    return;
  }

  const outputPath = path.join(outputDir, fileName);
  const fileInfo = stats.activeFiles.get(fileName);
  const finishTitle = () => {
    fileInfo.checked++;
  };

  // title -> value for tvg-logo
  const logoValue = new Map();
  const zipFiles = []; // only used with --zip
  let complete = true;

  const urlPrefix = V.urlpre.endsWith('/') || !V.urlpre ? V.urlpre : `${V.urlpre}/`;

  await Promise.all(
    titles.map(async (title) => {
      const jobFile = logoFileName(title, V.plain);

      if (run.zip) {
        // The zip holds its own copy of every logo.
        const jpg = await pool.render({ title, opts: stationOptions(V, title), size, q: V.q });
        if (!jpg) {
          complete = false;
          return;
        }
        stats.rendered++;
        stats.checked++;
        zipFiles.push({ name: `${run.pre}${jobFile}`, data: jpg });
        logoValue.set(title, V.useurl ? urlPrefix + jobFile : `${run.pre}${jobFile}`);
        finishTitle();
        return;
      }

      const ok = await ensureLogoFile(title, jobFile, run);
      if (!ok) {
        complete = false;
        return;
      }
      finishTitle();

      const target = path.join(run.logosRoot, jobFile);
      logoValue.set(
        title,
        V.useurl ? urlPrefix + jobFile : path.relative(path.dirname(outputPath), target).split(path.sep).join('/'),
      );
    }),
  );

  // If the time limit interrupted this file, keep it in the input folder
  // so a later run can finish the remaining logos.
  if (!complete || timeUp) {
    const message = `${fileInfo.checked}/${fileInfo.total} logos`;
    console.log(
      quiet
        ? `${fileName} incomplete - ${message} (time limit)`
        : `[${fileName}] Incomplete due to runtime limit (${message}). Keeping in input folder.`,
    );
    return;
  }

  // Build the playlist.
  const lines = [parsed.extm3u, ...parsed.header];
  let updated = 0;

  for (const entry of parsed.entries) {
    if (entry.extinf && entry.title && (V.ow || !entry.hasLogo) && logoValue.has(designTitle(entry.title))) {
      lines.push(...renderEntry(entry, applyLogo(entry.extinf, logoValue.get(designTitle(entry.title)))));
      updated++;
    } else {
      lines.push(...renderEntry(entry));
    }
  }
  const playlistText = `${lines.join('\n')}\n`;

  if (run.zip) {
    const stem = outputPath.replace(/\.m3u8?$/i, '');
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    const zip = makeZip([{ name: path.basename(fileName), data: Buffer.from(playlistText, 'utf8') }, ...zipFiles]);
    await fs.writeFile(`${stem}_logos.zip`, zip);
  } else {
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.writeFile(outputPath, playlistText, 'utf8');
  }

  stats.updatedEntries += updated;
  const where = run.zip ? `${outputPath.replace(/\.m3u8?$/i, '')}_logos.zip` : outputPath;

  console.log(
    quiet
      ? `${fileName} designed - ${updated} entries got a logo (${titles.length} images)`
      : `[${fileName}] Complete: ${updated} entries got a logo (${titles.length} images). Saved to "${where}"`,
  );

  // Fully processed and written → remove from input.
  await removeFromInput();
}

/** title -> Promise<boolean>: each logo is drawn once per run, however many playlists use it. */
const logoJobs = new Map();

/**
 * Makes sure the logo file of a title exists in the logos folder.
 * @returns {Promise<boolean>} false when the run was stopped before it was drawn
 */
function ensureLogoFile(title, jobFile, run) {
  if (!logoJobs.has(title)) {
    logoJobs.set(
      title,
      (async () => {
        const file = path.join(run.logosRoot, jobFile);

        if (run.skipExisting && (await fs.stat(file).then(() => true, () => false))) {
          stats.skipped++;
          stats.checked++;
          return true;
        }

        const jpg = await run.pool.render({ title, opts: stationOptions(run.V, title), size: run.size, q: run.V.q });
        if (!jpg) return false;

        await fs.mkdir(run.logosRoot, { recursive: true });
        await fs.writeFile(file, jpg);
        stats.rendered++;
        stats.checked++;
        return true;
      })(),
    );
  }
  return logoJobs.get(title);
}

/**
 * Recursively collects every .m3u / .m3u8 file below rootDir.
 * Returned paths are relative to rootDir and use "/" as separator.
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
        if (entry.name.startsWith('.') || entry.name === 'node_modules' || skip.has(path.resolve(fullPath))) {
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
 * @param {object} cfg - { quiet, zip, skipExisting, V, workers, fileConcurrency, progressInterval }
 */
async function main(inputDir, outputDir, cfg) {
  const { quiet, V } = cfg;
  const size = Number(V.size);

  await fs.mkdir(outputDir, { recursive: true });
  const m3uFiles = await collectM3UFiles(inputDir, [outputDir]);

  if (m3uFiles.length === 0) {
    if (!quiet) console.log(`No .m3u or .m3u8 files found in "${inputDir}" (searched recursively)`);
    return;
  }

  // Folder for the logo files, relative to the playlists (default "logos/").
  let pre = String(V.pre || '').replace(/\\/g, '/').replace(/^\/+/, '');
  if (pre && !pre.endsWith('/')) pre += '/';

  // Sort playlists by number of logos to draw (smallest first) and
  // pre-compute the global total so ETA works immediately.
  if (!quiet) console.log(`Counting logos in ${m3uFiles.length} files to prioritise smaller playlists...`);

  const allTitles = new Set();
  const filesWithCounts = await Promise.all(
    m3uFiles.map(async (fileName) => {
      const titles = titlesNeedingLogo(parseM3U(await fs.readFile(path.join(inputDir, fileName), 'utf8')), V.ow);
      titles.forEach((t) => allTitles.add(t));
      return { fileName, linkCount: titles.length };
    }),
  );
  filesWithCounts.sort((a, b) => a.linkCount - b.linkCount || a.fileName.localeCompare(b.fileName));
  const sortedM3uFiles = filesWithCounts.map((f) => f.fileName);

  // One logo per different title, except in zip mode where every zip draws its own.
  stats.totalLinks = cfg.zip ? filesWithCounts.reduce((s, f) => s + f.linkCount, 0) : allTitles.size;

  if (!quiet) {
    const smallest = filesWithCounts[0];
    const largest = filesWithCounts[filesWithCounts.length - 1];
    console.log(
      `Sorted by size: smallest needs ${smallest.linkCount} logos (${smallest.fileName}), ` +
        `largest needs ${largest.linkCount} (${largest.fileName}).`,
    );
  }

  const undrawable = [...allTitles].filter((t) => hasUndrawable(logoText(t, V))).length;
  if (undrawable > 0) {
    console.log(
      `Note: ${undrawable} titles contain characters the built-in font cannot draw (for example Arabic, ` +
        `Persian or Chinese). Those characters are skipped; a title with nothing drawable gets a play symbol.`,
    );
  }

  console.log(
    `Found ${sortedM3uFiles.length} M3U files (recursive). ` +
      `Image size: ${size}px. Workers: ${cfg.workers}. ` +
      `File concurrency: ${cfg.fileConcurrency}. ` +
      `Max runtime: ${formatDuration(MAX_RUNTIME_MS)}. ` +
      `Order: smallest → largest.`,
  );

  stats.totalFiles = sortedM3uFiles.length;
  stats.startTime = Date.now();

  const pool = createRenderPool(cfg.workers);
  const run = {
    quiet,
    V,
    size,
    pool,
    pre,
    zip: cfg.zip,
    skipExisting: cfg.skipExisting,
    logosRoot: path.join(outputDir, pre),
  };

  // Periodic progress report (printed even in --quiet mode).
  const progressTimer = setInterval(() => printProgress(false), cfg.progressInterval);

  // Fire once when the hard runtime limit is reached. Logos being drawn are
  // allowed to finish; nothing new is started.
  const timeUpTimer = setTimeout(() => {
    timeUp = true;
    console.log(
      `\n[TIME LIMIT] Maximum runtime of ${formatDuration(MAX_RUNTIME_MS)} reached. ` +
        `Stopping new logos. Fully processed playlists have been removed from input.`,
    );
    printProgress(false);
  }, MAX_RUNTIME_MS);

  const limiter = createLimiter(cfg.fileConcurrency);

  try {
    let nextIndex = 0;

    async function fileWorker() {
      while (true) {
        if (timeUp) return;
        const index = nextIndex++;
        if (index >= sortedM3uFiles.length) return;

        const fileName = sortedM3uFiles[index];
        try {
          await limiter(() => processFile(inputDir, outputDir, fileName, run));
        } catch (error) {
          console.error(`[${fileName}] Failed: ${error.message}`);
        } finally {
          stats.filesDone++;
          stats.activeFiles.delete(fileName);
        }
      }
    }

    const workerCount = Math.min(cfg.fileConcurrency, sortedM3uFiles.length);
    await Promise.all(Array.from({ length: workerCount }, () => fileWorker()));
  } finally {
    clearInterval(progressTimer);
    clearTimeout(timeUpTimer);
    await pool.close();
  }

  printProgress(true);

  if (timeUp) {
    console.log('\n--- Runtime limit reached. Remaining unprocessed playlists are still in the input folder ---');
  } else if (!quiet) {
    console.log('\n--- All M3U files processed ---');
  }
}

/* ============================================================
 COMMAND LINE
 ============================================================ */

const HELP = `m3u-logo-designer.js - draws a logo image for every station and embeds it as tvg-logo

  node m3u-logo-designer.js [input_folder] [output_folder] [options]

  --look FILE         load a look saved with the page's "Save look" button
  --set ID=VALUE      change one option (repeat as often as needed), e.g.
                      --set font=Impact --set c1=#ff0000 --set size=256
  --random[=SEED]     start from a random design ("Randomize all"); the seed is
                      printed so the same design can be made again
  --save-look FILE    write the design that is used to a look file
  --sample "TITLE"    draw one logo to logo-sample.jpg and stop (to try a look)
  --zip               one "<name>_logos.zip" per playlist with the playlist and
                      a logos/ folder (like the page); default: loose files
  --url-prefix URL    write full URLs in tvg-logo (default: relative paths)
  --overwrite         replace an existing tvg-logo
  --skip-existing     do not draw a logo whose file already exists (to resume)
  --list-options      print every option, its range and default
  --quiet             only print progress reports and one line per file

Environment: WORKERS (default: cores - 1), FILE_CONCURRENCY=4, PROGRESS_INTERVAL=60000`;

/**
 * Reads the command line into a configuration. Stops with a message on mistakes.
 * @param {string[]} argv
 */
function parseArguments(argv) {
  const cfg = {
    quiet: false,
    zip: false,
    skipExisting: false,
    sample: null,
    saveLook: null,
    listOptions: false,
    help: false,
    random: null,
    positional: [],
  };
  const V = defaultOptions();
  const overrides = []; // applied last
  let lookFile = null;

  const valueFlags = new Set(['--look', '--set', '--save-look', '--url-prefix', '--sample']);

  for (let i = 0; i < argv.length; i++) {
    let arg = argv[i];
    let value = null;

    const eq = arg.startsWith('--') ? arg.indexOf('=') : -1;
    if (eq > 0 && arg !== '--random') {
      value = arg.slice(eq + 1);
      arg = arg.slice(0, eq);
    }
    if (valueFlags.has(arg) && value === null) {
      value = argv[++i];
      if (value === undefined) throw new Error(`${arg} needs a value.`);
    }

    if (arg === '--random' || arg.startsWith('--random=')) {
      cfg.random = arg.includes('=') ? Number(arg.split('=')[1]) : Math.floor(Math.random() * 1e6) + 1;
      if (!Number.isFinite(cfg.random)) throw new Error('--random=SEED needs a number.');
      continue;
    }

    switch (arg) {
      case '--look':
        lookFile = value;
        break;
      case '--set': {
        const at = value.indexOf('=');
        if (at < 1) throw new Error(`--set needs ID=VALUE, got "${value}".`);
        overrides.push([value.slice(0, at).trim(), value.slice(at + 1)]);
        break;
      }
      case '--save-look':
        cfg.saveLook = value;
        break;
      case '--sample':
        cfg.sample = value;
        break;
      case '--url-prefix':
        overrides.push(['useurl', true], ['urlpre', value]);
        break;
      case '--overwrite':
        overrides.push(['ow', true]);
        break;
      case '--zip':
        cfg.zip = true;
        break;
      case '--skip-existing':
        cfg.skipExisting = true;
        break;
      case '--list-options':
        cfg.listOptions = true;
        break;
      case '--quiet':
        cfg.quiet = true;
        break;
      case '--help':
      case '-h':
        cfg.help = true;
        break;
      default:
        if (arg.startsWith('--')) throw new Error(`Unknown option ${arg}. Use --help to see the options.`);
        cfg.positional.push(argv[i]);
    }
  }

  return { cfg, V, overrides, lookFile };
}

if (isMainThread) {
  const WORKERS = process.env.WORKERS !== undefined ? Number(process.env.WORKERS) : Math.max(1, Math.min(8, os.cpus().length - 1));
  const FILE_CONCURRENCY = Number(process.env.FILE_CONCURRENCY || 4);
  const PROGRESS_INTERVAL = Number(process.env.PROGRESS_INTERVAL || 60000);

  (async () => {
    const { cfg, V, overrides, lookFile } = parseArguments(process.argv.slice(2));

    if (cfg.help) {
      console.log(HELP);
      return;
    }
    if (cfg.listOptions) {
      printOptions();
      return;
    }

    // 1. look file, 2. random design, 3. --set overrides.
    if (lookFile) {
      const ignored = applyLook(V, JSON.parse((await fs.readFile(lookFile, 'utf8')).replace(/^\uFEFF/, '')));
      if (ignored) console.warn(`${ignored} values in "${lookFile}" were not valid and were ignored.`);
    }
    if (cfg.random !== null) {
      randomize(V, 'all', rng(cfg.random));
      console.log(`Random design, seed ${cfg.random} (use --random=${cfg.random} to make it again)`);
    }
    for (const [id, raw] of overrides) {
      const c = CM[id];
      if (!c) throw new Error(`Unknown option "${id}". Use --list-options to see all options.`);
      const result = coerceOption(c, raw);
      if (!result.ok) throw new Error(result.error);
      V[id] = result.value;
    }

    if (cfg.saveLook) {
      await fs.writeFile(cfg.saveLook, JSON.stringify(lookData(V), null, 2), 'utf8');
      console.log(`Look saved to "${cfg.saveLook}"`);
    }

    if (cfg.sample !== null) {
      const jpg = renderLogo(cfg.sample, stationOptions(V, cfg.sample), Number(V.size), V.q);
      await fs.writeFile('logo-sample.jpg', jpg);
      console.log(`Sample logo for "${cfg.sample}" written to logo-sample.jpg (${jpg.length} bytes)`);
      return;
    }

    const inputDirectory = cfg.positional[0] || 'm3u-files';
    const outputDirectory = cfg.positional[1] || 'm3u-designed';

    if (!cfg.quiet) {
      console.log('Starting M3U Logo Designer...');
      console.log(`Input Directory: ${inputDirectory}`);
      console.log(`Output Directory: ${outputDirectory}`);
      console.log(`Workers: ${WORKERS}`);
      console.log(`File concurrency: ${FILE_CONCURRENCY}`);
      console.log(`Image size: ${V.size}px, JPEG quality ${V.q}`);
      console.log(
        `tvg-logo: ${cfg.zip ? 'path inside the zip' : V.useurl ? `URL (${V.urlpre})` : 'relative path'}, ` +
          `existing logos ${V.ow ? 'replaced' : 'kept'}`,
      );
      console.log(`Progress interval: ${PROGRESS_INTERVAL}ms`);
      console.log(`Max runtime: ${formatDuration(MAX_RUNTIME_MS)}`);
    }

    await main(inputDirectory, outputDirectory, {
      quiet: cfg.quiet,
      zip: cfg.zip,
      skipExisting: cfg.skipExisting,
      V,
      workers: WORKERS,
      fileConcurrency: FILE_CONCURRENCY,
      progressInterval: PROGRESS_INTERVAL,
    });
  })().catch((error) => {
    console.error('An error occurred:', error.message || error);
    process.exitCode = 1;
  });
}
