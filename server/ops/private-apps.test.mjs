import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createPrivateCatalogStore } from "../private-catalog.mjs";
import { createRegistryAuth } from "../registry-auth.mjs";
import { registry } from "./index.mjs";
import { confirmTextFor } from "./registry.mjs";

const directories = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });

const manifestText = (id) => ["schemaVersion: 2", `id: ${id}`, "name: Tool", "category: Test", "description: d", "image:", `  reference: ghcr.io/example/tool:1.0@sha256:${"a".repeat(64)}`].join("\n") + "\n";
const fakeToken = () => ["tok", "z".repeat(24)].join("_");

async function setup({ app = null } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "boxpilot-private-ops-"));
  directories.push(root);
  const catalogRoot = path.join(root, "apps");
  await mkdir(catalogRoot);
  const privateCatalog = createPrivateCatalogStore({ directory: path.join(root, "private-catalog"), groupId: () => null, builtInIds: async () => new Set(["demo"]) });
  const logins = [];
  const registryAuth = createRegistryAuth({
    directory: path.join(root, "registry-auth"),
    runDocker: async (_binary, args, options) => {
      logins.push({ args, input: options.input });
      const file = path.join(options.env.DOCKER_CONFIG, "config.json");
      const seen = JSON.parse(await readFile(file, "utf8"));
      await writeFile(file, JSON.stringify({ auths: { ...seen.auths, [args[1]]: { auth: Buffer.from(`${args[3]}:${options.input}`).toString("base64") } } }));
      return { ok: true, stdout: "Login Succeeded", stderr: "" };
    },
  });
  const apps = { catalogRoot, inspect: async ({ id }) => ({ applications: app ? [{ id, name: "Tool", ...app }] : [] }) };
  return { root, catalogRoot, privateCatalog, registryAuth, apps, logins, dependencies: { privateCatalog, registryAuth, apps } };
}

describe("the private app operations' entries", () => {
  it("keep every change for the owner, at high risk where it reaches what runs as root", () => {
    const entry = (id) => { const operation = registry.get(id); return { risk: operation.risk, minimumRole: operation.minimumRole, readOnly: operation.readOnly }; };
    expect(entry("catalog.private.save")).toEqual({ risk: "high", minimumRole: "owner", readOnly: false });
    expect(entry("catalog.private.remove")).toEqual({ risk: "high", minimumRole: "owner", readOnly: false });
    expect(entry("registry.signin")).toEqual({ risk: "high", minimumRole: "owner", readOnly: false });
    // The tier and role of removing a saved credential (credentials.remove).
    expect(entry("registry.signout")).toEqual({ risk: registry.get("credentials.remove").risk, minimumRole: "owner", readOnly: false });
    expect(entry("registry.inspect")).toEqual({ risk: "low", minimumRole: "operator", readOnly: true });
  });

  it("ask for the app's id typed to save or remove it, and hold the token as a secret", () => {
    expect(confirmTextFor(registry.get("catalog.private.save"), { id: "private-tool", manifest: manifestText("private-tool") })).toBe("private-tool");
    expect(confirmTextFor(registry.get("catalog.private.remove"), { id: "private-tool" })).toBe("private-tool");
    expect(registry.get("registry.signin").parameters.fields.token.secret).toBe(true);
  });

  it("validate what they are given before anything runs", () => {
    expect(registry.validate("catalog.private.save", { id: "tool", manifest: "x" })).toMatch(/invalid value/);
    expect(registry.validate("catalog.private.save", { id: "private-tool", manifest: "x".repeat(64 * 1024 + 1) })).toMatch(/too long/);
    expect(registry.validate("registry.signin", { registry: "https://ghcr.io", username: "someone", token: fakeToken() })).toMatch(/invalid value/);
    expect(registry.validate("registry.signin", { username: "someone", token: "short" })).toMatch(/token/);
    expect(registry.validate("registry.signin", { username: "someone", token: fakeToken() })).toBeNull();
    expect(registry.validate("registry.signout", { registry: "ghcr.io" })).toBeNull();
  });
});

describe("saving and removing a private app", () => {
  it("saves the manifest under its id", async () => {
    const { dependencies, root } = await setup();
    expect(await registry.execute("catalog.private.save", { id: "private-tool", manifest: manifestText("private-tool") }, dependencies)).toMatchObject({ id: "private-tool", replaced: false });
    expect(await readdir(path.join(root, "private-catalog"))).toEqual(["private-tool.yaml"]);
  });

  it("refuses to remove one that is installed, or whose data is still here, and removes it once it is gone", async () => {
    const installed = await setup({ app: { installed: true, dataPresent: true } });
    await registry.execute("catalog.private.save", { id: "private-tool", manifest: manifestText("private-tool") }, installed.dependencies);
    await expect(registry.execute("catalog.private.remove", { id: "private-tool" }, installed.dependencies)).rejects.toThrow("Tool is installed: uninstall it first");

    const kept = await setup({ app: { installed: false, dataPresent: true } });
    await registry.execute("catalog.private.save", { id: "private-tool", manifest: manifestText("private-tool") }, kept.dependencies);
    await expect(registry.execute("catalog.private.remove", { id: "private-tool" }, kept.dependencies)).rejects.toThrow("data is still on this server");

    // A folder left without a record (no live row for it) is data too.
    const folder = await setup();
    await registry.execute("catalog.private.save", { id: "private-tool", manifest: manifestText("private-tool") }, folder.dependencies);
    await mkdir(path.join(folder.catalogRoot, "private-tool"));
    await expect(registry.execute("catalog.private.remove", { id: "private-tool" }, folder.dependencies)).rejects.toThrow("data is still on this server");
    expect(await readdir(path.join(folder.root, "private-catalog"))).toEqual(["private-tool.yaml"]);

    const gone = await setup({ app: { installed: false, dataPresent: false } });
    await registry.execute("catalog.private.save", { id: "private-tool", manifest: manifestText("private-tool") }, gone.dependencies);
    expect(await registry.execute("catalog.private.remove", { id: "private-tool" }, gone.dependencies)).toEqual({ id: "private-tool", removed: true });
    expect(await readdir(path.join(gone.root, "private-catalog"))).toEqual([]);
  });
});

describe("registry sign-ins", () => {
  it("sign in to ghcr.io unless another is named, list user names only, and sign out", async () => {
    const { dependencies, logins } = await setup();
    const token = fakeToken();
    expect(await registry.execute("registry.signin", { username: "someone", token }, dependencies)).toMatchObject({ registry: "ghcr.io", username: "someone", signedIn: true });
    expect(logins[0].args.slice(0, 2)).toEqual(["login", "ghcr.io"]);
    expect(logins[0].input).toBe(token);
    const listed = await registry.execute("registry.inspect", {}, dependencies);
    expect(listed).toEqual({ registries: [{ registry: "ghcr.io", username: "someone" }] });
    expect(JSON.stringify(listed)).not.toContain(token);
    expect(await registry.execute("registry.signout", { registry: "ghcr.io" }, dependencies)).toEqual({ registry: "ghcr.io", signedOut: true });
    expect(await registry.execute("registry.inspect", {}, dependencies)).toEqual({ registries: [] });
  });
});
