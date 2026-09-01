#!/usr/bin/env node
/**
 * Gzip the built assets, once, at build time.
 *
 * The bundle is 686 KiB of JavaScript and the stylesheet another 105 KiB, and express.static sends
 * both exactly as they are: every first load on every device pays 773 KiB. Compressed that is 192
 * KiB, which over Tailscale from a phone is the difference between the page arriving and the owner
 * giving up on it.
 *
 * These files are content-hashed and served immutable, so the right time to compress them is now
 * rather than on every request: the work happens once here instead of once per visitor, and the
 * server spends no CPU on it at all.
 */
import { createReadStream, createWriteStream } from "node:fs";
import { readdir, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";
import { fileURLToPath } from "node:url";

const assets = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "dist", "assets");
const compressible = /\.(js|css|svg|json|map)$/;
// Below this, the gzip header and the extra request bookkeeping cost more than the bytes saved.
const worthCompressing = 1024;

const entries = await readdir(assets).catch(() => []);
let saved = 0; let count = 0;
for (const name of entries) {
  if (name.endsWith(".gz") || !compressible.test(name)) continue;
  const source = path.join(assets, name);
  const { size } = await stat(source);
  if (size < worthCompressing) continue;
  const target = `${source}.gz`;
  await pipeline(createReadStream(source), createGzip({ level: 9 }), createWriteStream(target));
  const packed = await stat(target);
  // A file that did not shrink is one more thing to keep in step for nothing.
  if (packed.size >= size) { await unlink(target); continue; }
  saved += size - packed.size; count += 1;
}
if (count) console.log(`[precompress] ${count} asset(s), ${(saved / 1024).toFixed(0)} KiB saved per first load`);
