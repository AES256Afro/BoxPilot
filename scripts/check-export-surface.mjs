#!/usr/bin/env node
/**
 * Fail on a new export that nothing outside its own file reads (M52.5).
 *
 *   node scripts/check-export-surface.mjs          # check
 *   node scripts/check-export-surface.mjs --write   # rewrite the allowlist from what is there now
 *
 * `export` on a module-private helper says "somebody else depends on this shape" where nobody does.
 * The 2026-11 code audit counted 277 of them, and twelve `*Internals` objects exported for tests
 * that no test read — two of those were propping up imports nothing else used either. The fix worth
 * having is not the 277 edits; it is this check, so the number can only go down.
 *
 * The shape is `server/ops/escalation-inventory.test.mjs`'s: a reviewed list, and a new entry fails
 * until someone has looked. `scripts/export-surface-allowed.json` maps "<path>: <name>" to why it
 * is exported anyway. A name that has since gained a reader, or gone, fails too, so the list cannot
 * rot into a list of names that no longer exist.
 *
 * What it reads, and what it therefore cannot see: declaration exports (`export function`,
 * `export const|let|class`, with `async`, `*` and TypeScript modifiers). Not `export { a, b }`, not
 * `export default`, not `export type|interface` — the type checker already has an opinion about
 * those. "Read somewhere else" is a word-boundary match in any other file of the corpus below,
 * which counts a name reached through a string or a computed property as unread: that is what the
 * allowlist is for.
 */
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const allowedPath = "scripts/export-surface-allowed.json";

/** Where exports are counted. */
const sourceRoots = ["server", "src", "scripts", "packages"];
/** Everything that may read one: the sources, the tests, the catalog, the deployment, the configs. */
const corpusRoots = ["server", "src", "scripts", "packages", "test", "tests", "catalog", "deploy", "automations", ".github", "demo-site"];
const corpusRootFiles = ["package.json", "vite.config.ts", "eslint.config.mjs", "index.html", "docker-compose.yml", "Dockerfile", "tsconfig.json", "tsconfig.app.json", "tsconfig.node.json", "tsconfig.server.json"];

const sourceExtensions = [".mjs", ".ts", ".tsx"];
const corpusExtensions = [...sourceExtensions, ".js", ".json", ".yml", ".yaml", ".sh", ".service", ".html", ".css", ".Dockerfile"];
const skippedDirectories = new Set(["node_modules", "dist", "fixtures", ".git"]);

async function walk(directory, extensions) {
  const found = [];
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return found;
    throw error;
  }
  for (const entry of entries) {
    const full = path.posix.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!skippedDirectories.has(entry.name)) found.push(...await walk(full, extensions));
    } else if (entry.isFile() && extensions.some((extension) => entry.name.endsWith(extension))) {
      found.push(full);
    }
  }
  return found;
}

const isTest = (file) => /\.test\.(mjs|ts|tsx)$/.test(file);
const isDeclaration = (file) => file.endsWith(".d.ts");

/** `export [async] function|const|let|class NAME`, skipping `export type` and `export interface`. */
const exportPattern = /^export\s+(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(?:function\s*\*?|const|let|class)\s+([A-Za-z_$][\w$]*)/gm;

async function collect() {
  const sources = (await Promise.all(sourceRoots.map((root) => walk(root, sourceExtensions)))).flat()
    .filter((file) => !isTest(file) && !isDeclaration(file))
    .sort();
  // Not the allowlist: it names every entry, so leaving it in the corpus makes each one look read
  // and the check passes on anything (found while writing it).
  const corpusFiles = [...(await Promise.all(corpusRoots.map((root) => walk(root, corpusExtensions)))).flat(), ...corpusRootFiles]
    .filter((file) => file !== allowedPath)
    .sort();
  const corpus = new Map();
  await Promise.all(corpusFiles.map(async (file) => {
    try { corpus.set(file, await readFile(file, "utf8")); } catch { /* a listed config a checkout may not have */ }
  }));
  return { sources, corpus };
}

/** Every exported declaration nothing outside its own file reads, as "<path>: <name>". */
function unread({ sources, corpus }) {
  const found = [];
  for (const file of sources) {
    const text = corpus.get(file);
    if (!text) continue;
    for (const [, name] of text.matchAll(exportPattern)) {
      const word = new RegExp(`\\b${name.replace(/\$/g, "\\$")}\\b`);
      let read = false;
      for (const [other, otherText] of corpus) {
        if (other === file) continue;
        if (otherText.includes(name) && word.test(otherText)) { read = true; break; }
      }
      if (!read) found.push(`${file}: ${name}`);
    }
  }
  return found.sort();
}

const seeded = "2026-11-04 (M52.5): exported before this check existed. Drop the export, or say here who needs it.";

const state = await collect();
const found = unread(state);

if (process.argv.includes("--write")) {
  let existing = {};
  try { existing = JSON.parse(await readFile(allowedPath, "utf8")).allowed ?? {}; } catch { /* first run */ }
  const allowed = Object.fromEntries(found.map((entry) => [entry, existing[entry] ?? seeded]));
  await writeFile(allowedPath, `${JSON.stringify({ allowed }, null, 2)}\n`);
  console.log(`exports: wrote ${Object.keys(allowed).length} reviewed entries to ${allowedPath}`);
  process.exit(0);
}

const allowed = JSON.parse(await readFile(allowedPath, "utf8")).allowed ?? {};
const unreviewed = found.filter((entry) => !(entry in allowed));
const stale = Object.keys(allowed).filter((entry) => !found.includes(entry));

for (const entry of unreviewed) console.error(`FAILED ${entry} is exported and nothing outside its own file reads it. Drop the export, or add it to ${allowedPath} with why.`);
for (const entry of stale) console.error(`FAILED ${entry} is in ${allowedPath} but is now read elsewhere, or is gone. Remove that line.`);

console.log(`exports: ${found.length - unreviewed.length} of ${found.length} unread exports are reviewed${stale.length ? `, ${stale.length} stale` : ""}`);
process.exitCode = unreviewed.length + stale.length ? 1 : 0;
