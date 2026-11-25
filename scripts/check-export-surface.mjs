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
 * Only files git tracks are read. The first version walked the filesystem, and passed on everything
 * locally while failing in CI: a built demo bundle left in the working copy by `npm run demo:publish`
 * (`demo-site/public/assets/StorageLead-*.js`, gitignored) contains every name in the app, so every
 * export looked read and the check was quietly inert. A build artifact in someone's working copy
 * must not be able to decide the answer, and git's list is the one CI and a checkout agree on.
 *
 * What it reads: declaration exports (`export function`, `export const|let|class`, with `async`, `*`
 * and TypeScript modifiers), and export lists (`export { a, b as c }`, `export { a } from "./x"`),
 * whose exported name is the one after `as`. Not `export default`, not `export * from`, not
 * `export type|interface` nor a list entry marked `type` — the type checker already has an opinion
 * about those. "Read somewhere else" is a word-boundary match in any other file of the corpus below,
 * which counts a name reached through a string or a computed property as unread: that is what the
 * allowlist is for.
 *
 * A list entry that passes a binding through (`export { x } from "./y"`, or `export { x }` where the
 * file imported `x`) needs one more thing of its reader. The first version skipped lists, and six
 * such pass-throughs nobody imported sat in server/ (M84, CODE-9); but the plain rule cannot see
 * them either, because the module that defines `x` always mentions it, as does everyone who imports
 * it from there. So for those a reader must also name this file in a relative specifier (an import,
 * an `export … from`, a dynamic `import()`, a `vi.mock`) that resolves to it. A name declared in the
 * file and listed is judged like a declaration export.
 */
import { execFile as execFileCallback } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

const allowedPath = "scripts/export-surface-allowed.json";

/** Where exports are counted. */
const sourceRoots = ["server", "src", "scripts", "packages"];
/** Everything that may read one: the sources, the tests, the catalog, the deployment, the configs. */
const corpusRoots = ["server", "src", "scripts", "packages", "test", "tests", "catalog", "deploy", "automations", ".github", "demo-site"];
const corpusRootFiles = ["package.json", "vite.config.ts", "eslint.config.mjs", "index.html", "docker-compose.yml", "Dockerfile", "tsconfig.json", "tsconfig.app.json", "tsconfig.node.json", "tsconfig.server.json"];

const sourceExtensions = [".mjs", ".ts", ".tsx"];
const corpusExtensions = [...sourceExtensions, ".js", ".json", ".yml", ".yaml", ".sh", ".service", ".html", ".css", ".Dockerfile"];
const skippedDirectories = new Set(["node_modules", "dist", "fixtures", ".git"]);

/** Every file git tracks, posix-separated. Throws if this is not a checkout: the caller says so. */
async function trackedFiles() {
  const { stdout } = await execFile("git", ["ls-files", "-z"], { maxBuffer: 64 * 1024 * 1024 });
  return stdout.split("\0").filter(Boolean).map((file) => file.split(path.sep).join("/"));
}

const underRoot = (file, roots) => roots.some((root) => file === root || file.startsWith(`${root}/`));
const inSkippedDirectory = (file) => file.split("/").slice(0, -1).some((segment) => skippedDirectories.has(segment));
const matching = (files, roots, extensions) => files
  .filter((file) => underRoot(file, roots) && extensions.some((extension) => file.endsWith(extension)) && !inSkippedDirectory(file))
  .sort();

const isTest = (file) => /\.test\.(mjs|ts|tsx)$/.test(file);
const isDeclaration = (file) => file.endsWith(".d.ts");

/** `export [async] function|const|let|class NAME`, skipping `export type` and `export interface`. */
const exportPattern = /^export\s+(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(?:function\s*\*?|const|let|class)\s+([A-Za-z_$][\w$]*)/gm;

async function collect() {
  let tracked = null;
  try { tracked = await trackedFiles(); } catch { tracked = null; }
  if (!tracked) {
    console.error(`Could not ask git which files are tracked, so ${allowedPath} cannot be judged. Run this in a checkout.`);
    process.exit(2);
  }
  const sources = matching(tracked, sourceRoots, sourceExtensions).filter((file) => !isTest(file) && !isDeclaration(file));
  // Not the allowlist: it names every entry, so leaving it in the corpus makes each one look read
  // and the check passes on anything (found while writing it).
  const corpusFiles = [...matching(tracked, corpusRoots, corpusExtensions), ...corpusRootFiles.filter((file) => tracked.includes(file))]
    .filter((file) => file !== allowedPath)
    .sort();
  const corpus = new Map();
  await Promise.all(corpusFiles.map(async (file) => {
    try { corpus.set(file, await readFile(file, "utf8")); } catch { /* a listed config a checkout may not have */ }
  }));
  return { sources, corpus };
}

/** `export { … }` with an optional `from "…"`; `export type { … }` is left to the type checker. */
const exportListPattern = /^export\s*\{([^}]*)\}\s*(?:from\s*["']([^"']+)["'])?/gm;
/** An import clause, `import a, { b, c as d } from "…"` or `import * as e from "…"`, not `import type`. */
const importClausePattern = /^import\s+(?!type\s)([^;"']*?)\s+from\s*["'][^"']+["']/gm;
/** `import|export … from "./x"`: the clause, and the specifier. */
const fromClausePattern = /\b(?:import|export)\s+(?:type\s+)?([^;"'()]*?)\s+from\s*["'](\.\.?(?:\/[^"'\n]*)?)["']/g;
/** A relative module specifier in any string: `import()`, `vi.mock`, a bare `import "./x"`. */
const relativeSpecifierPattern = /["'](\.\.?(?:\/[^"'\n]*)?)["']/g;
const identifier = /^[A-Za-z_$][\w$]*$/;

/** `a`, `b as c`, `type T` → the names a list exports, and the local name each comes from. */
function listEntries(body) {
  return body.split(",").map((entry) => entry.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "").trim()).filter(Boolean)
    .filter((entry) => !/^type\s/.test(entry))
    .map((entry) => {
      const [local, exported = local] = entry.split(/\s+as\s+/).map((part) => part.trim());
      return { local, exported };
    })
    .filter(({ local, exported }) => identifier.test(exported) && exported !== "default" && (identifier.test(local) || local === "default"));
}

/** The names a file's import clauses bind. */
function importedNames(text) {
  const names = new Set();
  for (const [, clause] of text.matchAll(importClausePattern)) {
    const braces = clause.match(/\{([^}]*)\}/);
    if (braces) for (const { exported } of listEntries(braces[1])) names.add(exported);
    const rest = clause.replace(/\{[^}]*\}/, "");
    const namespace = rest.match(/\*\s*as\s+([A-Za-z_$][\w$]*)/);
    if (namespace) names.add(namespace[1]);
    const defaultName = rest.replace(/\*\s*as\s+[A-Za-z_$][\w$]*/, "").replace(/,/g, " ").trim();
    if (identifier.test(defaultName)) names.add(defaultName);
  }
  return names;
}

/** Every exported name in a file: `{ name, passedThrough }`, the second for a binding from elsewhere. */
function exportsOf(text) {
  const found = [...text.matchAll(exportPattern)].map(([, name]) => ({ name, passedThrough: false }));
  const imported = importedNames(text);
  for (const [, body, from] of text.matchAll(exportListPattern)) {
    for (const { local, exported } of listEntries(body)) found.push({ name: exported, passedThrough: Boolean(from) || imported.has(local) });
  }
  return found;
}

const moduleCandidates = (target) => [target, ...[".mjs", ".js", ".ts", ".tsx"].map((extension) => `${target}${extension}`), ...["mjs", "js", "ts", "tsx"].map((extension) => `${target}/index.${extension}`)];

const resolvesTo = (from, specifier, file) => moduleCandidates(path.posix.normalize(path.posix.join(path.posix.dirname(from), specifier.replace(/[?#].*$/, "")))).includes(file);

/**
 * Whether `text`, the file at `from`, takes `name` from the module `file`: a named import or
 * re-export of it from there, or any other way of reaching that module whole (a namespace or default
 * import, `import()`, `vi.mock`), after which a mention of the name is as good as it gets.
 */
function takesFrom(text, from, file, name) {
  const clauses = new Set();
  for (const match of text.matchAll(fromClausePattern)) {
    const [, clause, specifier] = match;
    clauses.add(match.index + match[0].lastIndexOf(specifier) - 1);
    if (!resolvesTo(from, specifier, file)) continue;
    const braces = clause.match(/^\{([^}]*)\}$/);
    if (!braces) return true;
    if (braces[1].split(",").some((entry) => entry.replace(/^\s*type\s+/, "").split(/\s+as\s+/)[0].trim() === name)) return true;
  }
  for (const match of text.matchAll(relativeSpecifierPattern)) {
    if (!clauses.has(match.index) && resolvesTo(from, match[1], file)) return true;
  }
  return false;
}

/** Every export nothing outside its own file reads, as "<path>: <name>". */
function unread({ sources, corpus }) {
  const found = new Set();
  for (const file of sources) {
    const text = corpus.get(file);
    if (!text) continue;
    for (const { name, passedThrough } of exportsOf(text)) {
      const word = new RegExp(`\\b${name.replace(/\$/g, "\\$")}\\b`);
      let read = false;
      for (const [other, otherText] of corpus) {
        if (other === file) continue;
        if (otherText.includes(name) && word.test(otherText) && (!passedThrough || takesFrom(otherText, other, file, name))) { read = true; break; }
      }
      if (!read) found.add(`${file}: ${name}`);
    }
  }
  return [...found].sort();
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
