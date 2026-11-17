import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { imageRepository } from "./compose-review.mjs";
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
 * The owner's own apps (M71, ADR-019): manifests kept on this server only, for apps whose images are
 * private. Written by the helper alone (catalog.private.save), root:boxpilot 0750 with files 0640, so
 * the web service reads them and nothing it runs can plant one. Never under /var/lib/boxpilot, which
 * the web process can write.
 */
export const defaultPrivateCatalogDirectory = process.env.BOXPILOT_PRIVATE_CATALOG_DIRECTORY ?? "/var/lib/boxpilot-managed/private-catalog";

/**
 * Every private app's id starts with this, and no built-in app's does (catalog tests hold the
 * catalog to it), so a later release can never ship an app under a private app's id and take its
 * data folder, its backups and its settings.
 */
export const privateIdPrefix = "private-";

/** Registry and owner of an image (`ghcr.io/someone`), what a sidecar from the same place shares. */
function imageNamespace(reference) {
  return imageRepository(reference).split("/").slice(0, 2).join("/");
}

/**
 * What a private manifest must be beyond a valid one: its id starts with `private-`, and its image is
 * pinned by digest, as is any sidecar's image from the same registry and owner. Update offers a new
 * image when the manifest's reference differs from the installed one, so a new digest is a new
 * version; a tag alone would let what runs change without a manifest saying so.
 */
export function privateManifestProblems(manifest) {
  const problems = [];
  if (!String(manifest?.id ?? "").startsWith(privateIdPrefix)) problems.push(`its id must start with ${privateIdPrefix}`);
  const reference = String(manifest?.image?.reference ?? "");
  if (!reference.includes("@sha256:")) problems.push("image.reference must be pinned by digest (name:tag@sha256:...)");
  const namespace = reference ? imageNamespace(reference) : null;
  (manifest?.sidecars ?? []).forEach((sidecar, index) => {
    if (namespace && imageNamespace(sidecar.image) === namespace && !String(sidecar.image).includes("@sha256:")) problems.push(`sidecars[${index}].image comes from the same place as the app's image and must be pinned by digest too`);
  });
  return problems;
}

/**
 * Every manifest in one folder, tagged with where it came from. `label` is the name a problem and the
 * manifest's `file` are given. Throws what readdir throws (ENOENT for a missing folder).
 */
async function readManifests(directory, { source, label = (file) => file }) {
  const files = (await readdir(directory)).filter((name) => /^[a-z0-9-]+\.ya?ml$/.test(name)).sort();
  const manifests = []; const problems = []; const ids = new Set();
  for (const file of files) {
    let raw;
    try { raw = await readFile(path.join(directory, file), "utf8"); } catch (error) { problems.push({ file: label(file), errors: [`could not be read (${error?.code ?? "error"})`] }); continue; }
    let parsed;
    try { parsed = YAML.parse(raw); } catch (error) { problems.push({ file: label(file), errors: [`YAML: ${error.message}`] }); continue; }
    const { manifest, errors } = validateManifest(parsed);
    if (!manifest) { problems.push({ file: label(file), errors }); continue; }
    if (manifest.id !== file.replace(/\.ya?ml$/, "")) { problems.push({ file: label(file), errors: [`manifest.id "${manifest.id}" must match the file name`] }); continue; }
    if (ids.has(manifest.id)) { problems.push({ file: label(file), errors: ["duplicate id"] }); continue; }
    ids.add(manifest.id);
    // `source` is the loader's, never the file's: the schema refuses any key it does not know.
    manifests.push({ ...manifest, sha256: createHash("sha256").update(raw).digest("hex"), file: label(file), source });
  }
  return { manifests, problems };
}

/**
 * Load every `*.yaml` manifest from the catalog directory. Invalid manifests are reported, never
 * silently skipped, so a typo in one file shows up in the UI instead of hiding an app.
 *
 * The built-in catalog only: scripts, the README's count and the catalog's own tests read this, and
 * none of them may see a server's private apps. createCatalogService adds those.
 */
export async function loadCatalog({ directory = defaultCatalogDirectory } = {}) {
  try {
    return await readManifests(directory, { source: "catalog" });
  } catch (error) {
    if (error.code === "ENOENT") return { manifests: [], problems: [{ file: directory, errors: ["catalog directory not found"] }] };
    throw error;
  }
}

/**
 * The private catalog's manifests that may be listed, and why the others may not. No folder is no
 * private apps, never a problem. Problems are named `private/<file>`: the catalog page lists and
 * keys them by file, and a private file named like a built-in one must not stand in for it.
 */
async function loadPrivateCatalog(directory, builtInIds) {
  let read;
  try {
    read = await readManifests(directory, { source: "private", label: (file) => `private/${file}` });
  } catch (error) {
    if (error?.code === "ENOENT") return { manifests: [], problems: [] };
    return { manifests: [], problems: [{ file: "private/", errors: [`the private catalog could not be read (${error?.code ?? error?.message ?? "error"})`] }] };
  }
  const manifests = []; const problems = [...read.problems];
  for (const manifest of read.manifests) {
    const errors = privateManifestProblems(manifest);
    if (builtInIds.has(manifest.id)) errors.push(`a built-in app is called ${manifest.id}, and the built-in app is the one listed`);
    if (errors.length) problems.push({ file: manifest.file, errors }); else manifests.push(manifest);
  }
  return { manifests, problems };
}

/**
 * The catalog is release content: 128 manifests that change when BoxPilot itself is upgraded, and
 * at no other time. Re-reading and re-parsing them on a five-second timer cost ~32 ms of
 * synchronous YAML parsing per load, in both the web process and the helper, for the life of the
 * server. The directory's mtime answers "has anything changed" in one syscall instead, and the
 * TTL is only how often that syscall is worth making.
 *
 * The private catalog (M71) is merged in here and nowhere else, so the web service and the helper
 * list the same apps. Its folder's mtime joins the signature; a server without one says "absent",
 * a stable answer, so it costs nothing until the first private app is saved.
 *
 * Concurrent callers share one load: three panels opening at once used to start three.
 *
 * @param {{ directory?: string, privateDirectory?: string | null, ttlMs?: number, maxAgeMs?: number, now?: () => number }} [options]
 */
export function createCatalogService({ directory = defaultCatalogDirectory, privateDirectory = defaultPrivateCatalogDirectory, ttlMs = 5000, maxAgeMs = 5 * 60_000, now = () => Date.now() } = {}) {
  let cache = null; let checkedAt = 0; let signature = null; let inFlight = null; let loadedAt = 0;

  async function directorySignature() {
    let builtIn;
    try {
      const info = await stat(directory);
      builtIn = `${info.mtimeMs}:${info.size}`;
    } catch {
      return null; // no directory: loadCatalog reports the problem in its own words
    }
    if (!privateDirectory) return builtIn;
    try {
      const info = await stat(privateDirectory);
      return `${builtIn}|${info.mtimeMs}:${info.size}`;
    } catch (error) {
      // Stable either way, so neither re-parses the catalog on every look.
      return `${builtIn}|${error?.code === "ENOENT" ? "absent" : `unreadable:${error?.code ?? "error"}`}`;
    }
  }

  async function load() {
    const builtIn = await loadCatalog({ directory });
    if (!privateDirectory) return builtIn;
    const own = await loadPrivateCatalog(privateDirectory, new Set(builtIn.manifests.map((manifest) => manifest.id)));
    return { manifests: [...builtIn.manifests, ...own.manifests], problems: [...builtIn.problems, ...own.problems] };
  }

  async function all() {
    // Strictly less: a ttl of 0 means look every time, even twice in the same millisecond.
    if (cache && now() - checkedAt < ttlMs) return cache;
    if (inFlight) return inFlight;
    inFlight = (async () => {
      const current = await directorySignature();
      checkedAt = now();
      // A directory's mtime moves when entries are added, removed, or renamed — not when a file
      // inside it is edited. A release replaces the tree, so upgrades are seen immediately; an
      // edit in place is not seen at all, and would otherwise be served stale until a restart.
      // Reloading on a bounded age costs one walk every few minutes and bounds that to minutes.
      // A private manifest is always saved as a new file renamed into place, which moves its folder.
      const stale = now() - loadedAt >= maxAgeMs;
      if (cache && !stale && current !== null && current === signature) return cache;
      cache = await load();
      signature = current;
      loadedAt = now();
      return cache;
    })().finally(() => { inFlight = null; });
    return inFlight;
  }
  async function get(id) {
    const { manifests } = await all();
    return manifests.find((manifest) => manifest.id === id) ?? null;
  }
  return { all, get, directory, privateDirectory };
}

/**
 * The tier installing an app asks for, from its manifest (`risk`): the DNS servers the house leans
 * on and the VPN say high, as ADR-001 counts DNS cutovers and network-critical deploys. The job
 * layer stages app.install at the higher of this and the operation's own medium (jobs.mjs,
 * operationRiskHooks). Null when the catalog does not have the app, which the install refuses anyway.
 */
export function installRiskLookup(catalog) {
  return async (parameters) => {
    const manifest = typeof parameters?.id === "string" ? await catalog.get(parameters.id).catch(() => null) : null;
    return manifest?.risk ?? null;
  };
}

/**
 * Which of an app's settings are secrets, from its manifest: `(appId) => names`, or null when the
 * catalog does not have the app. Null is "cannot tell", never "none": a mistyped id, a retired app
 * or a flow step that names its app as {{ steps.pick.id }} must not let a token through as an
 * ordinary setting.
 */
export function secretEnvNamesLookup(catalog) {
  return async (appId) => {
    const manifest = typeof appId === "string" ? await catalog.get(appId) : null;
    if (!manifest) return null;
    return (manifest.env ?? []).filter((entry) => entry.secret || entry.type === "password").map((entry) => entry.name);
  };
}
