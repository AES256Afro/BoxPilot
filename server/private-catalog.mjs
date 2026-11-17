/**
 * The private catalog's files (M71, ADR-019): the owner's own app manifests, saved and removed by
 * the helper and read by the catalog service in both processes (catalog/index.mjs).
 *
 * The folder is root:boxpilot 0750 and each manifest root:boxpilot 0640: the web service lists them
 * and nothing it runs can write one, which matters because a manifest decides what the root helper
 * deploys. The helper runs with UMask=0077, so every mode is set explicitly. A manifest is written
 * under a temporary name and renamed into place, so its folder's mtime moves and the catalog
 * service sees the change on its next look.
 */
import { randomBytes } from "node:crypto";
import { chmod, chown, lstat, open, rename, rm, unlink } from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import { defaultPrivateCatalogDirectory, loadCatalog, privateManifestProblems } from "./catalog/index.mjs";
import { validateManifest } from "./catalog/schema.mjs";
import { mkdirWithoutFollowing, syncDirectory } from "./durable-file.mjs";
import { serviceGroupId } from "./job-log.mjs";

/** A private app's id: `private-`, then what the catalog allows, 63 characters in all. */
export const privateAppIdPattern = /^private-[a-z0-9][a-z0-9-]{0,54}$/;
/** The most a manifest may be: the size app.compose.edit takes for a compose file. */
export const privateManifestLimit = 64 * 1024;

const folderMode = 0o750;
const fileMode = 0o640;

/**
 * @param {{ directory?: string, groupId?: () => number | null, builtInIds?: () => Promise<Set<string>> }} [options]
 */
export function createPrivateCatalogStore({
  directory = defaultPrivateCatalogDirectory,
  // The web service's group, which reads the folder; null (a test, a machine without it) leaves the group as made.
  groupId = () => serviceGroupId(),
  builtInIds = async () => new Set((await loadCatalog()).manifests.map((manifest) => manifest.id)),
} = {}) {
  const folder = path.resolve(directory);

  /** The folder, made when missing, never through a link, with its mode and group put right every time. */
  async function ensureFolder(gid) {
    await mkdirWithoutFollowing(path.dirname(folder), path.basename(folder), { mode: folderMode });
    await chmod(folder, folderMode);
    if (gid !== null) await chown(folder, -1, gid);
    return folder;
  }

  /** `text` at `file`, whole or not at all: a new file with its mode and group, synced, renamed over the old. */
  async function writeShared(file, text, gid) {
    const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${randomBytes(6).toString("hex")}.tmp`);
    const handle = await open(temporary, "wx", fileMode);
    try {
      await handle.writeFile(text, { encoding: "utf8" });
      await handle.chmod(fileMode);
      if (gid !== null) await handle.chown(-1, gid);
      await handle.sync();
    } catch (error) {
      await handle.close().catch(() => {});
      await rm(temporary, { force: true }).catch(() => {});
      throw error;
    }
    await handle.close();
    try {
      await rename(temporary, file);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => {});
      throw error;
    }
    await syncDirectory(path.dirname(file));
  }

  /**
   * Save `text` as private app `id`, replacing one saved before. Everything the catalog would refuse
   * to list is refused here first, so a saved manifest is a listed one.
   *
   * @param {{ id: string, text: string }} request
   */
  async function save({ id, text }) {
    if (typeof id !== "string" || !privateAppIdPattern.test(id)) throw new Error("A private app's id starts with private- and is lower-case letters, digits and dashes, 63 characters at most");
    if (typeof text !== "string" || !text.trim()) throw new Error("The manifest is empty");
    if (Buffer.byteLength(text, "utf8") > privateManifestLimit) throw new Error(`The manifest is larger than ${privateManifestLimit / 1024} KiB`);
    let parsed;
    try { parsed = YAML.parse(text); } catch (error) { throw new Error(`The manifest is not valid YAML: ${error.message}`); }
    const { manifest, errors } = validateManifest(parsed);
    if (!manifest) throw new Error(`The manifest is not valid: ${errors.join("; ")}`);
    if (manifest.id !== id) throw new Error(`The manifest's id is ${manifest.id}, not ${id}`);
    const problems = privateManifestProblems(manifest);
    if (problems.length) throw new Error(`The manifest cannot be a private app: ${problems.join("; ")}`);
    if ((await builtInIds()).has(id)) throw new Error(`${id} is a built-in app's id`);
    const gid = groupId();
    await ensureFolder(gid);
    const file = path.join(folder, `${id}.yaml`);
    const replaced = await lstat(file).then(() => true, () => false);
    await writeShared(file, text, gid);
    // A copy under .yml would be the same id twice, and the catalog would list neither the same way.
    await rm(path.join(folder, `${id}.yml`), { force: true });
    return { id, name: manifest.name, image: manifest.image.reference, replaced };
  }

  /**
   * Delete private app `id`'s manifest. Whether the app may lose it (not installed, no data left) is
   * the operation's to decide; this only removes the file, or a link standing where it should be.
   *
   * @param {{ id: string }} request
   */
  async function remove({ id }) {
    if (typeof id !== "string" || !privateAppIdPattern.test(id)) throw new Error("A private app's id starts with private-");
    const removed = [];
    for (const name of [`${id}.yaml`, `${id}.yml`]) {
      const target = path.join(folder, name);
      if (!(await lstat(target).then(() => true, () => false))) continue;
      await unlink(target);
      removed.push(name);
    }
    if (!removed.length) throw new Error(`No private app is called ${id}`);
    await syncDirectory(folder);
    return { id, removed: true };
  }

  return { save, remove, directory: folder };
}
