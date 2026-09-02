#!/usr/bin/env node
/**
 * Copy the built front end into the demo site.
 *
 * This was a step people were expected to remember, and the demo has more than once served a page
 * older than the bundle it was supposed to be showing. It is a script now so it cannot be skipped.
 *
 * The precompressed .gz twins are deliberately left behind: Cloudflare compresses at its own edge,
 * so shipping them would upload a second copy of every asset for nothing. Stale hashed assets are
 * removed rather than left to pile up, since nothing can reference them once index.html moves on -
 * but only those, because public/ also holds files this script did not write.
 */
import { copyFile, mkdir, readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const from = path.join(root, "dist");
const to = path.join(root, "demo-site", "public");

if (!(await stat(from).then((entry) => entry.isDirectory(), () => false))) {
  console.error("dist is not built. Run `npm run build` first.");
  process.exit(1);
}

async function sync(relative = "") {
  const source = path.join(from, relative);
  const target = path.join(to, relative);
  await mkdir(target, { recursive: true });
  const entries = await readdir(source, { withFileTypes: true });
  const wanted = new Set();
  for (const entry of entries) {
    if (entry.name.endsWith(".gz")) continue;
    wanted.add(entry.name);
    if (entry.isDirectory()) { await sync(path.join(relative, entry.name)); continue; }
    await copyFile(path.join(source, entry.name), path.join(target, entry.name));
  }
  // Prune only inside assets/, and only the content-hashed files this script put there. The rest of
  // public/ belongs to other steps - demo-data.json is written by demo-bundle.mjs and fetched by
  // the Worker - and deleting a file because dist has no copy of it breaks the deploy.
  if (relative !== "assets") return;
  for (const entry of await readdir(target, { withFileTypes: true })) {
    if (wanted.has(entry.name) || !entry.isFile()) continue;
    await rm(path.join(target, entry.name), { force: true });
    console.log(`  removed stale ${path.join(relative, entry.name)}`);
  }
}

await sync();
// The entry chunk, now that pages are their own chunks: "first .js" would name whichever page
// sorts first, which is not what anyone reading the log wants to know.
const names = await readdir(path.join(to, "assets"));
const bundle = names.find((name) => /^index-.*\.js$/.test(name)) ?? names.find((name) => name.endsWith(".js"));
console.log(`demo assets synced from dist (${bundle})`);
