#!/usr/bin/env node
/**
 * The home-screen icons (M25.1): the rail's "BP" mark, amber on the console's near-black, drawn here
 * from rectangles and circles so no font, image tool or dependency is needed to make them again.
 *
 *   node scripts/make-app-icons.mjs        # writes public/icons/*.png
 *
 * Each pixel is sampled 4x4 and the letters are unions and differences of simple shapes, so the edges
 * are smooth at every size. Four files: the manifest's two (192 and 512, transparent outside the
 * rounded square), a maskable 512 (full bleed, the mark inside the safe circle), and Apple's 180,
 * full bleed with no transparency (iOS draws transparency black and rounds the corners itself).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(root, "public", "icons");

// The console's tokens (src/styles.css, dark): --cc-topbar, --cc-amber, --cc-amber-ink.
const night = [0x0c, 0x10, 0x14];
const amber = [0xff, 0xb5, 0x47];
const ink = [0x1a, 0x10, 0x00];

/** A rounded rectangle, in the 512-unit design space. */
function inRoundedRect(x, y, { left, top, right, bottom, radius }) {
  if (x < left || x > right || y < top || y > bottom) return false;
  const cx = Math.min(Math.max(x, left + radius), right - radius);
  const cy = Math.min(Math.max(y, top + radius), bottom - radius);
  return (x - cx) ** 2 + (y - cy) ** 2 <= radius ** 2;
}

const inRect = (x, y, left, top, right, bottom) => x >= left && x <= right && y >= top && y <= bottom;

/**
 * A letter's bowl: a bar from the stem to `reach`, closed by a half circle, with the same shape
 * `stroke` smaller cut out of it. `top` and `bottom` are its outer edges.
 */
function inBowl(x, y, { stem, reach, top, bottom, stroke }) {
  const radius = (bottom - top) / 2;
  const middle = top + radius;
  const outer = (x >= stem && x <= reach && y >= top && y <= bottom) || (x >= reach && (x - reach) ** 2 + (y - middle) ** 2 <= radius ** 2);
  if (!outer) return false;
  const inner = radius - stroke;
  const hole = (x >= stem && x <= reach && y >= top + stroke && y <= bottom - stroke) || (x >= reach && (x - reach) ** 2 + (y - middle) ** 2 <= inner ** 2);
  return !hole;
}

/**
 * "BP", centred on (256, 256) and `scale` times its design size: letters 170 units tall with a 34-unit
 * stroke, B's lower bowl a little wider than its upper one, as a drawn B has it.
 */
function inLetters(x, y, scale) {
  const X = 256 + (x - 256) / scale;
  const Y = 256 + (y - 256) / scale;
  const top = 171;
  const bottom = 341;
  const stroke = 34;
  const middle = 252;
  // B
  const bStem = 128;
  if (inRect(X, Y, bStem, top, bStem + stroke, bottom)) return true;
  if (inBowl(X, Y, { stem: bStem, reach: bStem + 62, top, bottom: middle + stroke / 2, stroke })) return true;
  if (inBowl(X, Y, { stem: bStem, reach: bStem + 70, top: middle - stroke / 2, bottom, stroke })) return true;
  // P
  const pStem = 276;
  if (inRect(X, Y, pStem, top, pStem + stroke, bottom)) return true;
  if (inBowl(X, Y, { stem: pStem, reach: pStem + 66, top, bottom: middle + stroke / 2 + 8, stroke })) return true;
  return false;
}

/** The colour at a point of the design, or null for transparent. */
function designs(kind) {
  if (kind === "any") {
    // The rounded square fills the canvas, as the manifest's "any" icons are drawn by launchers as they are.
    const square = { left: 16, top: 16, right: 496, bottom: 496, radius: 104 };
    return (x, y) => (!inRoundedRect(x, y, square) ? null : inLetters(x, y, 1.12) ? ink : amber);
  }
  if (kind === "maskable") {
    // Full bleed; the square sits inside the central 80% circle every mask keeps.
    const square = { left: 100, top: 100, right: 412, bottom: 412, radius: 64 };
    return (x, y) => (!inRoundedRect(x, y, square) ? night : inLetters(x, y, 0.8) ? ink : amber);
  }
  // Apple: full bleed amber; iOS rounds the corners.
  return (x, y) => (inLetters(x, y, 1.12) ? ink : amber);
}

function render(size, kind) {
  const colourAt = designs(kind);
  const samples = 4;
  const pixels = Buffer.alloc(size * size * 4);
  for (let py = 0; py < size; py += 1) {
    for (let px = 0; px < size; px += 1) {
      let r = 0; let g = 0; let b = 0; let a = 0;
      for (let sy = 0; sy < samples; sy += 1) {
        for (let sx = 0; sx < samples; sx += 1) {
          const x = ((px + (sx + 0.5) / samples) / size) * 512;
          const y = ((py + (sy + 0.5) / samples) / size) * 512;
          const colour = colourAt(x, y);
          if (!colour) continue;
          r += colour[0]; g += colour[1]; b += colour[2]; a += 1;
        }
      }
      const offset = (py * size + px) * 4;
      // Premultiplied by coverage, then divided back, so a half-covered edge keeps its colour.
      pixels[offset] = a ? Math.round(r / a) : 0;
      pixels[offset + 1] = a ? Math.round(g / a) : 0;
      pixels[offset + 2] = a ? Math.round(b / a) : 0;
      pixels[offset + 3] = Math.round((a / (samples * samples)) * 255);
    }
  }
  return pixels;
}

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/** An RGBA PNG; with `opaque`, RGB only (Apple's icon must have no alpha channel). */
function png(size, rgba, { opaque = false } = {}) {
  const channels = opaque ? 3 : 4;
  const rows = Buffer.alloc(size * (size * channels + 1));
  for (let y = 0; y < size; y += 1) {
    const row = y * (size * channels + 1);
    rows[row] = 0; // no filter
    for (let x = 0; x < size; x += 1) {
      const from = (y * size + x) * 4;
      const to = row + 1 + x * channels;
      rows[to] = rgba[from]; rows[to + 1] = rgba[from + 1]; rows[to + 2] = rgba[from + 2];
      if (!opaque) rows[to + 3] = rgba[from + 3];
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit depth
  header[9] = opaque ? 2 : 6; // truecolour, with alpha unless opaque
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", header), chunk("IDAT", deflateSync(rows, { level: 9 })), chunk("IEND", Buffer.alloc(0))]);
}

mkdirSync(outDir, { recursive: true });
const icons = [
  ["icon-192.png", 192, "any", false],
  ["icon-512.png", 512, "any", false],
  ["icon-maskable-512.png", 512, "maskable", true],
  ["apple-touch-icon.png", 180, "apple", true],
  ["favicon-32.png", 32, "any", false],
];
for (const [name, size, kind, opaque] of icons) {
  writeFileSync(path.join(outDir, name), png(size, render(size, kind), { opaque }));
  console.log(`public/icons/${name}  ${size}x${size}`);
}
