import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { validateManifest } from "./schema.mjs";

function builtInCatalogDirectory() {
  // Under Node, import.meta.url is file:///…/server/catalog/index.mjs. Test environments (jsdom) replace
  // the URL global and/or the module URL, so fall back to the working tree when it cannot be resolved.
  try {
    const modulePath = fileURLToPath(import.meta.url);
    return path.resolve(path.dirname(modulePath), "..", "..", "catalog");
  } catch {
    return path.resolve(process.cwd(), "catalog");
  }
}
export const defaultCatalogDirectory = process.env.BOXPILOT_CATALOG_DIRECTORY ?? builtInCatalogDirectory();

/**
 * Load every `*.yaml` manifest from the catalog directory. Invalid manifests are reported, never
 * silently skipped, so a typo in one file shows up in the UI instead of hiding an app.
 */
export async function loadCatalog({ directory = defaultCatalogDirectory } = {}) {
  let files = [];
  try {
    files = (await readdir(directory)).filter((name) => /^[a-z0-9-]+\.ya?ml$/.test(name)).sort();
  } catch (error) {
    if (error.code === "ENOENT") return { manifests: [], problems: [{ file: directory, errors: ["catalog directory not found"] }] };
    throw error;
  }
  const manifests = []; const problems = []; const ids = new Set();
  for (const file of files) {
    const raw = await readFile(path.join(directory, file), "utf8");
    let parsed;
    try { parsed = YAML.parse(raw); } catch (error) { problems.push({ file, errors: [`YAML: ${error.message}`] }); continue; }
    const { manifest, errors } = validateManifest(parsed);
    if (!manifest) { problems.push({ file, errors }); continue; }
    if (manifest.id !== file.replace(/\.ya?ml$/, "")) { problems.push({ file, errors: [`manifest.id "${manifest.id}" must match the file name`] }); continue; }
    if (ids.has(manifest.id)) { problems.push({ file, errors: ["duplicate id"] }); continue; }
    ids.add(manifest.id);
    manifests.push({ ...manifest, sha256: createHash("sha256").update(raw).digest("hex"), file });
  }
  return { manifests, problems };
}

export function createCatalogService({ directory = defaultCatalogDirectory, ttlMs = 5000, now = () => Date.now() } = {}) {
  let cache = null; let loadedAt = 0;
  async function all() {
    if (!cache || now() - loadedAt > ttlMs) { cache = await loadCatalog({ directory }); loadedAt = now(); }
    return cache;
  }
  async function get(id) {
    const { manifests } = await all();
    return manifests.find((manifest) => manifest.id === id) ?? null;
  }
  return { all, get, directory };
}
