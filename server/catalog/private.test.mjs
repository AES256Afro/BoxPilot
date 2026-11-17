import { chmod, mkdir, mkdtemp, readdir, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { onWindows } from "../../test/platform.mjs";
import { createCatalogService, defaultCatalogDirectory, defaultPrivateCatalogDirectory, loadCatalog, privateIdPrefix } from "./index.mjs";

/*
 * The private catalog (M71, ADR-019): the owner's own manifests, merged into the catalog service and
 * nowhere else, each tagged with where it came from and held to the private rules.
 */

const digest = (character) => `sha256:${character.repeat(64)}`;
const manifestText = ({ id, name = "App", image = `ghcr.io/example/${id}:1.0@${digest("a")}`, sidecars = "" }) => [
  "schemaVersion: 2", `id: ${id}`, `name: ${name}`, "category: Test", "description: d",
  "image:", `  reference: ${image}`, sidecars,
].filter(Boolean).join("\n") + "\n";

const directories = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });
async function temporary(prefix) {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  directories.push(directory);
  return directory;
}

/** Saved as the helper saves one: written beside, then renamed into place, which moves the folder's mtime. */
async function saveInto(directory, file, text) {
  await mkdir(directory, { recursive: true });
  const temp = path.join(directory, `.${file}.tmp`);
  await writeFile(temp, text);
  await rename(temp, path.join(directory, file));
}

async function folders() {
  const builtIn = await temporary("boxpilot-builtin-");
  await writeFile(path.join(builtIn, "demo.yaml"), manifestText({ id: "demo", name: "Demo", image: "nginx:1.27" }));
  const root = await temporary("boxpilot-private-root-");
  return { builtIn, privateDirectory: path.join(root, "private-catalog") };
}

describe("the private catalog, merged by the catalog service", () => {
  it("lists private apps beside the built-in ones, each tagged with where it came from", async () => {
    const { builtIn, privateDirectory } = await folders();
    await saveInto(privateDirectory, "private-tool.yaml", manifestText({ id: "private-tool", name: "Tool" }));
    const { manifests, problems } = await createCatalogService({ directory: builtIn, privateDirectory, ttlMs: 0 }).all();
    expect(problems).toEqual([]);
    expect(manifests.map((manifest) => [manifest.id, manifest.source, manifest.file])).toEqual([["demo", "catalog", "demo.yaml"], ["private-tool", "private", "private/private-tool.yaml"]]);
    expect(manifests[1].sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("refuses a private manifest without the prefix, without a pinned image, or under a built-in's id, and names it private/<file>", async () => {
    const { builtIn, privateDirectory } = await folders();
    await saveInto(privateDirectory, "tool.yaml", manifestText({ id: "tool" }));
    await saveInto(privateDirectory, "private-tagged.yaml", manifestText({ id: "private-tagged", image: "ghcr.io/example/tagged:1.0" }));
    // A sidecar from the same registry and owner must be pinned too; a public one need not be.
    await saveInto(privateDirectory, "private-sidecar.yaml", manifestText({ id: "private-sidecar", sidecars: ["sidecars:", "  - id: worker", "    image: ghcr.io/example/worker:2.0"].join("\n") }));
    await saveInto(privateDirectory, "private-public-sidecar.yaml", manifestText({ id: "private-public-sidecar", sidecars: ["sidecars:", "  - id: db", "    image: postgres:17"].join("\n") }));
    await saveInto(privateDirectory, "private-other.yaml", manifestText({ id: "private-mismatch" }));
    await saveInto(privateDirectory, "private-broken.yaml", "schemaVersion: [2\n");
    // The schema refuses any key it does not know, so a file cannot claim to be built in.
    await saveInto(privateDirectory, "private-claims.yaml", `${manifestText({ id: "private-claims" })}source: catalog\n`);
    const { manifests, problems } = await createCatalogService({ directory: builtIn, privateDirectory, ttlMs: 0 }).all();
    expect(manifests.map((manifest) => manifest.id)).toEqual(["demo", "private-public-sidecar"]);
    const byFile = Object.fromEntries(problems.map((problem) => [problem.file, problem.errors.join("; ")]));
    expect(Object.keys(byFile).sort()).toEqual(["private/private-broken.yaml", "private/private-claims.yaml", "private/private-other.yaml", "private/private-sidecar.yaml", "private/private-tagged.yaml", "private/tool.yaml"]);
    expect(byFile["private/tool.yaml"]).toContain(`must start with ${privateIdPrefix}`);
    expect(byFile["private/private-tagged.yaml"]).toContain("pinned by digest");
    expect(byFile["private/private-sidecar.yaml"]).toContain("sidecars[0].image");
    expect(byFile["private/private-other.yaml"]).toContain("must match the file name");
    expect(byFile["private/private-claims.yaml"]).toContain("source");
  });

  it("keeps the built-in app when a private manifest takes its id", async () => {
    const { privateDirectory } = await folders();
    // A built-in catalog that broke the prefix rule, which the test below holds the real one to.
    const builtIn = await temporary("boxpilot-builtin-");
    await writeFile(path.join(builtIn, "private-taken.yaml"), manifestText({ id: "private-taken", name: "Built in" }));
    await saveInto(privateDirectory, "private-taken.yaml", manifestText({ id: "private-taken", name: "Mine" }));
    const catalog = createCatalogService({ directory: builtIn, privateDirectory, ttlMs: 0 });
    const { manifests, problems } = await catalog.all();
    expect(manifests.map((manifest) => [manifest.id, manifest.name, manifest.source])).toEqual([["private-taken", "Built in", "catalog"]]);
    expect(problems).toEqual([{ file: "private/private-taken.yaml", errors: [expect.stringContaining("built-in app is called private-taken")] }]);
    expect((await catalog.get("private-taken")).source).toBe("catalog");
  });

  it("treats a missing private folder as no private apps: no problem, and the catalog it loaded is kept", async () => {
    const { builtIn, privateDirectory } = await folders();
    const catalog = createCatalogService({ directory: builtIn, privateDirectory, ttlMs: 0 });
    const first = await catalog.all();
    expect(first.problems).toEqual([]);
    // Same object on every look while nothing moved: the /catalog summary cache is keyed by it, and
    // a signature of null (an unreadable folder) would parse every manifest on every look.
    expect(await catalog.all()).toBe(first);
    expect(await catalog.all()).toBe(first);
  });

  it("reloads when a private app is saved or removed, and not before", async () => {
    const { builtIn, privateDirectory } = await folders();
    const catalog = createCatalogService({ directory: builtIn, privateDirectory, ttlMs: 0 });
    const before = await catalog.all();
    await saveInto(privateDirectory, "private-tool.yaml", manifestText({ id: "private-tool" }));
    const after = await catalog.all();
    expect(after).not.toBe(before);
    expect(after.manifests.map((manifest) => manifest.id)).toEqual(["demo", "private-tool"]);
    expect(await catalog.all()).toBe(after);
    // Replaced with a new digest: what Update compares with the installed image.
    await saveInto(privateDirectory, "private-tool.yaml", manifestText({ id: "private-tool", image: `ghcr.io/example/private-tool:1.1@${digest("b")}` }));
    expect((await catalog.get("private-tool")).image.reference).toContain(digest("b"));
    await rm(path.join(privateDirectory, "private-tool.yaml"));
    expect(await catalog.get("private-tool")).toBeNull();
  });

  // POSIX modes: a folder the web process cannot list. Root reads it anyway, so not as root.
  it.skipIf(onWindows || process.getuid?.() === 0)("reports a private folder it cannot read as one problem, and still lists the built-in apps", async () => {
    const { builtIn, privateDirectory } = await folders();
    await saveInto(privateDirectory, "private-tool.yaml", manifestText({ id: "private-tool" }));
    await chmod(privateDirectory, 0o000);
    try {
      const catalog = createCatalogService({ directory: builtIn, privateDirectory, ttlMs: 0 });
      const first = await catalog.all();
      expect(first.manifests.map((manifest) => manifest.id)).toEqual(["demo"]);
      expect(first.problems).toEqual([{ file: "private/", errors: [expect.stringContaining("could not be read")] }]);
      expect(await catalog.all()).toBe(first);
    } finally {
      await chmod(privateDirectory, 0o700);
    }
  });

  it("is the default of both production services, and can be turned off", () => {
    expect(createCatalogService().privateDirectory).toBe(defaultPrivateCatalogDirectory);
    expect(defaultPrivateCatalogDirectory).not.toMatch(/^\/var\/lib\/boxpilot\//);
    expect(createCatalogService({ privateDirectory: null }).privateDirectory).toBeNull();
  });
});

describe("the built-in catalog", () => {
  it("never uses the private prefix, so no release can take a private app's id", async () => {
    const files = await readdir(defaultCatalogDirectory);
    expect(files.length).toBeGreaterThan(100);
    expect(files.filter((file) => file.startsWith(privateIdPrefix))).toEqual([]);
    const { manifests } = await loadCatalog();
    expect(manifests.filter((manifest) => manifest.id.startsWith(privateIdPrefix)).map((manifest) => manifest.id)).toEqual([]);
  });

  it("is all loadCatalog reads: built in, and tagged so", async () => {
    const { builtIn } = await folders();
    const { manifests } = await loadCatalog({ directory: builtIn });
    expect(manifests.map((manifest) => [manifest.id, manifest.source])).toEqual([["demo", "catalog"]]);
  });
});
