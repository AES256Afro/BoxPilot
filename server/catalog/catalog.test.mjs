import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadCatalog } from "./index.mjs";
import { renderCompose } from "./compose.mjs";
import { resolveValues, validateManifest } from "./schema.mjs";

const base = { schemaVersion: 2, id: "demo", name: "Demo", category: "Test", description: "A demo", image: { reference: "nginx:1.27" } };
const directories = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((d) => rm(d, { recursive: true, force: true }))); });

describe("manifest schema", () => {
  it("accepts a minimal manifest and fills defaults", () => {
    const { manifest, errors } = validateManifest(base);
    expect(errors).toEqual([]);
    expect(manifest).toMatchObject({ id: "demo", risk: "medium", ports: [], volumes: [], env: [], health: { kind: "running", stableSeconds: 10 }, network: "bridge" });
  });

  it("rejects unknown fields, bad ids, bad images, and inconsistent volumes", () => {
    expect(validateManifest({ ...base, bogus: 1 }).errors).toContainEqual(expect.stringContaining("bogus"));
    expect(validateManifest({ ...base, id: "Bad Id" }).errors).toContainEqual(expect.stringContaining("manifest.id"));
    expect(validateManifest({ ...base, image: { reference: "nginx:1.27; rm -rf /" } }).errors).toContainEqual(expect.stringContaining("image.reference"));
    expect(validateManifest({ ...base, volumes: [{ id: "x", container: "/x", path: "data", hostPath: "/srv" }] }).errors).toContainEqual(expect.stringContaining("exactly one of"));
    expect(validateManifest({ ...base, volumes: [{ id: "x", container: "/x", path: "../etc" }] }).errors).toContainEqual(expect.stringContaining("simple relative"));
    expect(validateManifest({ ...base, env: [{ name: "lower", default: "x" }] }).errors).toContainEqual(expect.stringContaining("env[0].name"));
    expect(validateManifest({ ...base, capabilities: ["NET_ADMIN"] }).errors).toContainEqual(expect.stringContaining("CAP_"));
    expect(validateManifest({ ...base, schemaVersion: 1 }).errors).toContainEqual(expect.stringContaining("schemaVersion"));
  });

  it("resolves values with defaults and rejects bad input", () => {
    const { manifest } = validateManifest({ ...base, ports: [{ id: "web", container: 80, host: 8080 }, { id: "fixed", container: 53, host: 53, fixed: true }], volumes: [{ id: "media", container: "/media", hostPath: "/srv/media", configurable: true }], env: [{ name: "TZ", type: "timezone", default: "Etc/UTC" }, { name: "SECRET", type: "password", generate: true }, { name: "MODE", options: ["a", "b"], default: "a" }, { name: "NEEDED", required: true }] });
    expect(resolveValues(manifest, {}).errors).toContainEqual(expect.stringContaining("NEEDED"));
    const good = resolveValues(manifest, { ports: { web: 9090 }, env: { NEEDED: "yes", TZ: "America/Chicago" }, volumes: { media: "/mnt/media/" } });
    expect(good.errors).toEqual([]);
    expect(good.values).toEqual({ ports: { web: 9090, fixed: 53 }, env: { TZ: "America/Chicago", SECRET: "", MODE: "a", NEEDED: "yes" }, volumes: { media: "/mnt/media" } });
    expect(resolveValues(manifest, { ports: { fixed: 5353 }, env: { NEEDED: "y" } }).errors).toContainEqual(expect.stringContaining("fixed"));
    expect(resolveValues(manifest, { ports: { web: 53 }, env: { NEEDED: "y" } }).errors).toContainEqual(expect.stringContaining("collides"));
    expect(resolveValues(manifest, { env: { NEEDED: "y", MODE: "z" } }).errors).toContainEqual(expect.stringContaining("one of"));
    expect(resolveValues(manifest, { env: { NEEDED: "y", TZ: "not a tz!" } }).errors).toContainEqual(expect.stringContaining("Region/City"));
    expect(resolveValues(manifest, { env: { NEEDED: "y" }, volumes: { media: "/etc/ssl" } }).errors).toContainEqual(expect.stringContaining("protected"));
    expect(resolveValues(manifest, { env: { NEEDED: "y" }, volumes: { media: "/srv/../etc" } }).errors).toContainEqual(expect.stringContaining("clean"));
    expect(resolveValues(manifest, { env: { NEEDED: "y", EXTRA: "1" } }).errors).toContainEqual(expect.stringContaining("EXTRA"));
  });

  it("renders compose with secrets only in .env and generates missing passwords", () => {
    const { manifest } = validateManifest({ ...base, ports: [{ id: "web", container: 80, host: 8080, exposure: "loopback" }, { id: "dns", container: 53, protocol: "udp" }], volumes: [{ id: "data", container: "/data", path: "data" }], env: [{ name: "ADMIN_PASSWORD", type: "password", generate: true }, { name: "TZ", default: "Etc/UTC" }], capabilities: ["CAP_NET_BIND_SERVICE"] });
    const values = resolveValues(manifest, {}).values;
    const first = renderCompose(manifest, values, { lanAddress: "192.168.1.10" });
    expect(first.composeYaml).toContain("127.0.0.1:8080:80");
    expect(first.composeYaml).toContain("192.168.1.10:53:53/udp");
    expect(first.composeYaml).toContain("ADMIN_PASSWORD: ${ADMIN_PASSWORD}");
    expect(first.composeYaml).not.toContain(first.env.ADMIN_PASSWORD);
    expect(first.envFile).toMatch(/^ADMIN_PASSWORD=[A-Za-z0-9_-]{20,}\n$/);
    expect(first.composeYaml).toContain("cap_drop:\n      - ALL");
    const second = renderCompose(manifest, values, { existingEnv: { ADMIN_PASSWORD: "keep-me" } });
    expect(second.env.ADMIN_PASSWORD).toBe("keep-me");
  });
});

describe("catalog loader", () => {
  it("loads valid manifests, reports invalid ones, and enforces id = file name", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "boxpilot-catalog-")); directories.push(directory);
    await writeFile(path.join(directory, "good.yaml"), "schemaVersion: 2\nid: good\nname: Good\ncategory: T\ndescription: d\nimage:\n  reference: nginx:1\n");
    await writeFile(path.join(directory, "bad.yaml"), "schemaVersion: 2\nid: bad\nname: Bad\n");
    await writeFile(path.join(directory, "mismatch.yaml"), "schemaVersion: 2\nid: other\nname: O\ncategory: T\ndescription: d\nimage:\n  reference: nginx:1\n");
    await writeFile(path.join(directory, "broken.yaml"), "schemaVersion: [2\n");
    const { manifests, problems } = await loadCatalog({ directory });
    expect(manifests.map((manifest) => manifest.id)).toEqual(["good"]);
    expect(manifests[0].sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(problems.map((problem) => problem.file).sort()).toEqual(["bad.yaml", "broken.yaml", "mismatch.yaml"]);
  });

  it("ships a valid built-in catalog", async () => {
    const { manifests, problems } = await loadCatalog();
    expect(problems).toEqual([]);
    expect(manifests.map((manifest) => manifest.id)).toEqual(expect.arrayContaining(["jellyfin", "homepage", "portainer"]));
    for (const manifest of manifests) expect(resolveValues(manifest, {}).errors).toEqual([]);
  });
});
