import { mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { onWindows } from "../test/platform.mjs";
import { createCatalogService } from "./catalog/index.mjs";
import { createPrivateCatalogStore, privateManifestLimit } from "./private-catalog.mjs";

const directories = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });

const pinned = (version, character = "a") => `ghcr.io/example/tool:${version}@sha256:${character.repeat(64)}`;
const manifestText = ({ id = "private-tool", image = pinned("1.0") } = {}) => ["schemaVersion: 2", `id: ${id}`, "name: Tool", "category: Test", "description: d", "image:", `  reference: ${image}`].join("\n") + "\n";

async function setup({ groupId = () => null, builtInIds = async () => new Set(["demo"]) } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "boxpilot-private-store-"));
  directories.push(root);
  const directory = path.join(root, "private-catalog");
  return { root, directory, store: createPrivateCatalogStore({ directory, groupId, builtInIds }) };
}

describe("saving a private app's manifest", () => {
  // POSIX modes and a group this user is in.
  it.skipIf(onWindows)("writes it whole, readable by root and the web service's group only, and the catalog lists it", async () => {
    const group = process.getgid();
    const { directory, store } = await setup({ groupId: () => group });
    const catalog = createCatalogService({ directory: path.resolve("catalog"), privateDirectory: directory, ttlMs: 0 });
    const before = await catalog.all();
    expect(await store.save({ id: "private-tool", text: manifestText() })).toEqual({ id: "private-tool", name: "Tool", image: pinned("1.0"), replaced: false });
    const folder = await stat(directory);
    const file = await stat(path.join(directory, "private-tool.yaml"));
    expect(folder.mode & 0o777).toBe(0o750);
    expect(file.mode & 0o777).toBe(0o640);
    expect([folder.gid, file.gid]).toEqual([group, group]);
    // Nothing left of the temporary file it was written as.
    expect(await readdir(directory)).toEqual(["private-tool.yaml"]);
    expect(await readFile(path.join(directory, "private-tool.yaml"), "utf8")).toBe(manifestText());
    // Renamed into place, so the folder moved and the catalog sees it on its next look.
    const after = await catalog.all();
    expect(after).not.toBe(before);
    expect((await catalog.get("private-tool"))?.source).toBe("private");
  });

  it.skipIf(onWindows)("replaces one saved before, and takes away a .yml copy of the same id", async () => {
    const { directory, store } = await setup();
    await store.save({ id: "private-tool", text: manifestText() });
    await writeFile(path.join(directory, "private-tool.yml"), manifestText());
    expect(await store.save({ id: "private-tool", text: manifestText({ image: pinned("1.1", "b") }) })).toMatchObject({ replaced: true, image: pinned("1.1", "b") });
    expect(await readdir(directory)).toEqual(["private-tool.yaml"]);
    expect((await stat(path.join(directory, "private-tool.yaml"))).mode & 0o777).toBe(0o640);
  });

  it("refuses what the catalog would not list, and writes nothing", async () => {
    const { directory, store } = await setup({ builtInIds: async () => new Set(["private-taken"]) });
    await expect(store.save({ id: "tool", text: manifestText({ id: "tool" }) })).rejects.toThrow("starts with private-");
    await expect(store.save({ id: "private-tool", text: manifestText({ id: "private-other" }) })).rejects.toThrow("id is private-other, not private-tool");
    await expect(store.save({ id: "private-tool", text: manifestText({ image: "ghcr.io/example/tool:1.0" }) })).rejects.toThrow("pinned by digest");
    await expect(store.save({ id: "private-tool", text: "schemaVersion: [2\n" })).rejects.toThrow("not valid YAML");
    await expect(store.save({ id: "private-tool", text: "schemaVersion: 2\nid: private-tool\n" })).rejects.toThrow("not valid");
    await expect(store.save({ id: "private-tool", text: `${manifestText()}source: catalog\n` })).rejects.toThrow("source");
    await expect(store.save({ id: "private-tool", text: "  " })).rejects.toThrow("empty");
    await expect(store.save({ id: "private-tool", text: `${manifestText()}#${"x".repeat(privateManifestLimit)}\n` })).rejects.toThrow("larger than 64 KiB");
    await expect(store.save({ id: "private-taken", text: manifestText({ id: "private-taken" }) })).rejects.toThrow("built-in app's id");
    await expect(stat(directory)).rejects.toMatchObject({ code: "ENOENT" });
  });

  // A symbolic link, which needs a privilege on Windows.
  it.skipIf(onWindows)("never makes its folder through a link", async () => {
    const { root, directory, store } = await setup();
    const elsewhere = await mkdtemp(path.join(os.tmpdir(), "boxpilot-elsewhere-"));
    directories.push(elsewhere);
    await symlink(elsewhere, directory);
    await expect(store.save({ id: "private-tool", text: manifestText() })).rejects.toMatchObject({ code: "ELOOP" });
    expect(await readdir(elsewhere)).toEqual([]);
    expect(await readdir(root)).toEqual(["private-catalog"]);
  });
});

describe("removing a private app's manifest", () => {
  it("deletes the file, and says so when there is none", async () => {
    const { directory, store } = await setup();
    await store.save({ id: "private-tool", text: manifestText() });
    expect(await store.remove({ id: "private-tool" })).toEqual({ id: "private-tool", removed: true });
    expect(await readdir(directory)).toEqual([]);
    await expect(store.remove({ id: "private-tool" })).rejects.toThrow("No private app is called private-tool");
    await expect(store.remove({ id: "demo" })).rejects.toThrow("starts with private-");
  });
});
