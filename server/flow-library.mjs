/**
 * The flow library (M13.11): ready-made automations shipped as files, the way the app catalog
 * ships manifests, instead of a list hardcoded in the interface.
 *
 * Each `*.yaml` in the library directory is a flow definition (name, description, steps). It is
 * validated against the live registry with the same validateFlow the API uses, so a library entry
 * that names a retired operation or a high-risk one shows up as a problem rather than a shelf item
 * that fails the moment someone adds it. Installing one is an ordinary create(); from then on it
 * is the owner's, editable like anything built by hand.
 */
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { validateFlow } from "./flows.mjs";
import { registry as defaultRegistry } from "./ops/index.mjs";

function builtInLibraryDirectory() {
  try {
    return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "automations");
  } catch {
    return path.resolve(process.cwd(), "automations");
  }
}

export const defaultLibraryDirectory = process.env.BOXPILOT_FLOW_LIBRARY_DIRECTORY ?? builtInLibraryDirectory();

const descriptionLimit = 400;

/** Load every library entry, validating steps against the registry; problems are reported, not hidden. */
export async function loadFlowLibrary({ directory = defaultLibraryDirectory, registry = defaultRegistry } = {}) {
  let files = [];
  try {
    files = (await readdir(directory)).filter((name) => /^[a-z0-9-]+\.ya?ml$/.test(name)).sort();
  } catch (error) {
    if (error.code === "ENOENT") return { library: [], problems: [] };  // no library is a fine, empty state
    throw error;
  }
  const library = []; const problems = []; const slugs = new Set();
  for (const file of files) {
    const slug = file.replace(/\.ya?ml$/, "");
    let parsed;
    try { parsed = YAML.parse(await readFile(path.join(directory, file), "utf8")); } catch (error) { problems.push({ file, errors: [`YAML: ${error.message}`] }); continue; }
    if (!parsed || typeof parsed !== "object") { problems.push({ file, errors: ["not a mapping"] }); continue; }
    if (parsed.description !== undefined && (typeof parsed.description !== "string" || parsed.description.length > descriptionLimit)) { problems.push({ file, errors: [`description must be a string of at most ${descriptionLimit} characters`] }); continue; }
    // The same gate the API uses, so a library entry can never offer a step a hand-built flow could not.
    const problem = validateFlow({ name: parsed.name, steps: parsed.steps }, registry);
    if (problem) { problems.push({ file, errors: [problem] }); continue; }
    if (slugs.has(slug)) { problems.push({ file, errors: ["duplicate library id"] }); continue; }
    slugs.add(slug);
    library.push({ slug, name: parsed.name.trim(), description: typeof parsed.description === "string" ? parsed.description : "", steps: parsed.steps });
  }
  return { library, problems };
}
