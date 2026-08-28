import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAppHelper } from "./app-helper.mjs";
import { createCatalogService, loadCatalog, defaultCatalogDirectory } from "./catalog/index.mjs";

/**
 * The whole catalog, driven through the real deploy path against fakes.
 *
 * Every review sweep of this project has found the same shape of bug: a manifest field that
 * renders fine in a unit test but crashes the deployer that writes it to disk (containerFollowsHost
 * dropped by a normalizer, a sidecar host-mount with a null path throwing path.join, a probe field
 * stripped by glue). The render tests never touched the write. This does: it installs every
 * manifest with a fake Docker and asserts the deploy path never throws a *code* error. A manifest
 * that legitimately needs a device or a required secret is allowed to refuse; a TypeError is not.
 */
const directories = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((d) => rm(d, { recursive: true, force: true }))); });

// A Docker that says yes to everything the deploy path asks, and reports every container healthy.
function healthyDocker() {
  return vi.fn(async (_binary, args) => {
    const verb = args[0];
    if (verb === "version") return { ok: true, stdout: "28.0.0", stderr: "" };
    if (verb === "inspect") {
      // One line per name, each a running+healthy container (covers app and sidecar polls).
      const wantsName = String(args[2] ?? "").includes('"name"');
      const names = args.slice(3);
      const lines = names.map((name) => JSON.stringify({ ...(wantsName ? { name: `/${name}` } : {}), running: true, status: "running", health: "healthy", restarts: 0, image: "sha256:x", startedAt: "x", exitCode: 0 }));
      return { ok: true, stdout: lines.join("\n"), stderr: "" };
    }
    if (verb === "run") return { ok: true, stdout: "1000", stderr: "" };     // imageDeclaredOwner id -u/-g
    if (verb === "logs") return { ok: true, stdout: "", stderr: "" };
    if (verb === "compose") return { ok: true, stdout: args.includes("ls") ? "[]" : "", stderr: "" };
    return { ok: true, stdout: "", stderr: "" };
  });
}

/** Values that satisfy resolveValues for any manifest: required fields filled with a typed dummy. */
function dummyValues(manifest) {
  const env = {};
  for (const entry of manifest.env) {
    if (entry.fixed || entry.generate || entry.default !== null || !entry.required) continue;
    env[entry.name] = entry.options?.[0]
      ?? (entry.type === "number" ? "1" : entry.type === "boolean" ? "true" : entry.type === "timezone" ? "UTC" : "dummy-value");
  }
  return { env };
}

const codeCrash = /Cannot read propert|is not a function|is not defined|undefined is not|ERR_INVALID_ARG|reduce of|of null|of undefined/i;

describe("every catalog manifest survives the deploy path", () => {
  it("installs against a fake Docker without a single code-level crash", async () => {
    const { manifests, problems } = await loadCatalog();
    expect(problems, "the catalog itself must be clean").toEqual([]);
    expect(manifests.length).toBeGreaterThan(100);

    const catalog = createCatalogService({ directory: defaultCatalogDirectory, ttlMs: 60_000 });
    const catalogRoot = await mkdtemp(path.join(os.tmpdir(), "bp-smoke-")); directories.push(catalogRoot);
    const backupRoot = await mkdtemp(path.join(os.tmpdir(), "bp-smokebk-")); directories.push(backupRoot);
    // A fake clock that the wait advances, so waitHealthy's stableSeconds is met in a few instant
    // polls instead of spinning for real seconds per app (which OOM'd the run).
    let nowMs = Date.parse("2026-08-19T12:00:00.000Z");
    const apps = createAppHelper({
      catalogRoot, backupRoot, catalog,
      runDocker: healthyDocker(),
      clock: () => new Date(nowMs),
      wait: async (ms) => { nowMs += ms ?? 1000; },
      chownDirectory: async () => {},
      listDevices: async () => [],                         // no hardware; device-required apps refuse, which is fine
      runCommand: async () => ({ ok: true, stdout: "", stderr: "" }),
      lanAddress: "192.168.1.10",
    });
    const crashes = [];
    const refusals = [];
    let installed = 0;
    for (const manifest of manifests) {
      try {
        await apps.install({ id: manifest.id, values: dummyValues(manifest) });
        installed += 1;
      } catch (error) {
        if (error instanceof TypeError || error instanceof RangeError || codeCrash.test(error.message)) crashes.push(`${manifest.id}: ${error.message}`);
        else refusals.push(manifest.id);                   // needs a device, a specific secret, etc. — not a bug
      }
      await rm(path.join(catalogRoot, manifest.id), { recursive: true, force: true }).catch(() => {});
    }
    // The load-bearing assertion: no manifest crashes the deployer with a code error.
    expect(crashes, `deploy-path crashes:\n${crashes.join("\n")}`).toEqual([]);
    // And the fakes get most of the catalog all the way in, so the write path is genuinely exercised.
    expect(installed).toBeGreaterThan(manifests.length * 0.6);
    // The multi-part apps are the ones this test exists for: sidecars, host mounts, config files.
    // Each must have installed, not merely refused. (Prometheus with its host-bind sidecar is the
    // exact shape that once threw a TypeError in writeProject before it was fixed.)
    for (const id of ["prometheus", "grafana", "immich", "qbittorrent"]) {
      if (manifests.some((manifest) => manifest.id === id)) {
        expect(refusals, `${id} should install cleanly, not refuse`).not.toContain(id);
        expect(crashes.join(" "), `${id} must not crash the deployer`).not.toContain(id);
      }
    }
  }, 120_000);
});
