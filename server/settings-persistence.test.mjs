/**
 * Settings stick, for every app in the catalog. The owner's complaint (30 Oct 2026): "if I go back
 * in there and change the IP or the port number, everything else should still have been saved".
 * For each catalog app this installs it with every setting the owner may change set to a value of
 * its own, then changes one setting at a time through reconfigure - exactly what Settings → Save
 * sends - and after every save checks what the container would really get (compose.yaml's
 * environment with the .env it references, the published ports, the mounted folders): the setting
 * changed is the new value, and every other one is still the owner's, secrets and generated
 * passwords included.
 */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it, vi } from "vitest";
import YAML from "yaml";
import { createAppHelper } from "./app-helper.mjs";
import { createCatalogService } from "./catalog/index.mjs";
import { parseEnvFile } from "./env-file.mjs";

const catalogDirectory = fileURLToPath(new URL("../catalog/", import.meta.url));
const directories = [];
const skipped = [];
afterAll(async () => { await Promise.all(directories.map((directory) => rm(directory, { recursive: true, force: true }))); });

/** A value of the owner's own for a setting, valid for its type; `round` makes each one different. */
function ownValue(entry, round) {
  if (entry.options?.length) { const others = entry.options.filter((option) => option !== String(entry.default ?? "")); return others.length ? others[round % others.length] : null; }
  switch (entry.type) {
    case "boolean": return String(entry.default) === "true" ? "false" : "true";
    case "number": return String((Number(entry.default) || 0) + 7 + round);
    case "timezone": return ["Europe/Berlin", "America/Chicago", "Asia/Tokyo"][round % 3];
    case "path": return `/srv/owner-${round}/${entry.name.toLowerCase()}`;
    default:
      if (/URL|ADDRESS|HOST|ENDPOINT/i.test(entry.name)) return `http://10.20.${round}.${(entry.name.length % 200) + 10}:${8000 + round}`;
      return `owner-${round}-${entry.name.toLowerCase().replace(/_/g, "-")}`;
  }
}

/** What the container would get: compose environment with ${NAME} from .env, ports, mounts. */
async function effective(root, id) {
  const project = path.join(root, id);
  const dotEnv = Object.fromEntries(parseEnvFile(await readFile(path.join(project, ".env"), "utf8").catch(() => "")));
  const compose = YAML.parse(await readFile(path.join(project, "compose.yaml"), "utf8"));
  const service = Object.values(compose.services ?? {})[0] ?? {};
  const raw = Array.isArray(service.environment) ? Object.fromEntries(service.environment.map((line) => line.split(/=(.*)/s).slice(0, 2))) : service.environment ?? {};
  const env = Object.fromEntries(Object.entries(raw).map(([name, value]) => [name, String(value ?? "").replace(/\$\{([A-Za-z0-9_]+)\}/g, (_m, ref) => dotEnv[ref] ?? "")]));
  for (const [name, value] of Object.entries(dotEnv)) if (!(name in env)) env[name] = value;
  return { network: service.network_mode ?? null, env, ports: (service.ports ?? []).map(String), volumes: (service.volumes ?? []).map((volume) => (typeof volume === "string" ? volume : `${volume.source}:${volume.target}`)) };
}

function harness() {
  const containers = new Map();
  const runDocker = vi.fn(async (_binary, args) => {
    if (args[0] === "version") return { ok: true, stdout: "28.0.0", stderr: "" };
    if (args[0] === "inspect") {
      const lines = args.slice(3).map((name) => JSON.stringify({ name: `/${name}`, running: true, status: "running", health: "healthy", restarts: 0, image: "sha256:x", startedAt: "2026-10-30T12:00:00Z", exitCode: 0 }));
      return { ok: true, stdout: lines.join("\n"), stderr: "" };
    }
    if (args[0] === "compose" && args.includes("up")) for (const a of args) containers.set(a, true);
    return { ok: true, stdout: "", stderr: "" };
  });
  return runDocker;
}

const catalog = createCatalogService({ directory: catalogDirectory, ttlMs: 0 });
const all = (await catalog.all()).manifests;

describe("settings stick for every catalog app", () => {
  it("has apps to check", () => expect(all.length).toBeGreaterThan(100));
  afterAll(() => {
    // Every app must really be checked: a skip is allowed only for the stated reasons, and only a few.
    if (skipped.length) console.log(`Not installable on a stub host (${skipped.length}):\n${skipped.join("\n")}`);
    expect(skipped.length).toBeLessThan(10);
  });

  for (const listed of all) {
    it(`${listed.id}: changing one setting keeps every other one`, async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), "boxpilot-settings-")); directories.push(root);
      let nowMs = Date.parse("2026-10-30T12:00:00Z");
      const apps = createAppHelper({ catalogRoot: root, runDocker: harness(), catalog, wait: async (ms) => { nowMs += ms; }, clock: () => new Date(nowMs), chownDirectory: async () => {}, lanAddress: "192.168.1.10" });
      const manifest = await catalog.get(listed.id);
      const editable = manifest.env.filter((entry) => !entry.fixed && !entry.generate && !entry.fromVpnProfile && ownValue(entry, 1) !== null);

      // Install with every editable setting set to the owner's own value (round 1).
      const want = Object.fromEntries(editable.map((entry) => [entry.name, ownValue(entry, 1)]));
      try {
        await apps.install({ id: manifest.id, values: { env: want } });
      } catch (error) {
        // Apps that cannot install on a stub host (a GPU, a VPN profile, devices) say why; they are
        // counted below, never silently passed.
        skipped.push(`${manifest.id}: ${String(error.message).slice(0, 120)}`);
        expect.soft(String(error.message), `${manifest.id} could not be installed in the test`).toMatch(/GPU|VPN|device|profile|tunnel|token|requires|prerequisite|not supported|host network/i);
        return;
      }
      const generated = Object.fromEntries(manifest.env.filter((entry) => entry.generate).map((entry) => [entry.name, null]));
      const first = await effective(root, manifest.id);
      for (const name of Object.keys(generated)) generated[name] = first.env[name];

      // Change one setting at a time (round 2); after each save, everything else must be the same.
      const current = { ...want };
      for (const entry of editable) {
        const next = ownValue(entry, 2);
        if (next === null || next === current[entry.name]) continue;
        await apps.reconfigure({ id: manifest.id, values: { env: { [entry.name]: next } } }, { checkpoint: false });
        current[entry.name] = next;
        const now = await effective(root, manifest.id);
        for (const [name, value] of Object.entries(current)) {
          if (name in now.env) expect(now.env[name], `${manifest.id}: ${name} after saving ${entry.name}`).toBe(value);
        }
        for (const [name, value] of Object.entries(generated)) expect(now.env[name], `${manifest.id}: generated ${name} after saving ${entry.name}`).toBe(value);
      }

      // A port change and an empty save (Settings opened and saved with nothing typed) keep it all.
      const port = manifest.ports.find((entry) => !entry.fixed);
      const before = await effective(root, manifest.id);
      if (port) await apps.reconfigure({ id: manifest.id, values: { ports: { [port.id]: port.host + 101 } } }, { checkpoint: false });
      await apps.reconfigure({ id: manifest.id, values: {} }, { checkpoint: false });
      const after = await effective(root, manifest.id);
      expect(after.env, `${manifest.id}: settings after a port change and an empty save`).toEqual(before.env);
      expect(after.volumes, `${manifest.id}: folders after a port change`).toEqual(before.volumes);
      if (port && after.network !== "host") expect(after.ports.some((line) => line.includes(`:${port.host + 101}:`)), `${manifest.id}: the new port`).toBe(true);
    });
  }
});

describe("secrets in Settings", () => {
  async function theyspy() {
    const root = await mkdtemp(path.join(os.tmpdir(), "boxpilot-secrets-")); directories.push(root);
    let nowMs = Date.parse("2026-10-30T12:00:00Z");
    const apps = createAppHelper({ catalogRoot: root, runDocker: harness(), catalog, wait: async (ms) => { nowMs += ms; }, clock: () => new Date(nowMs), chownDirectory: async () => {} });
    await apps.install({ id: "theyspy", values: { env: { TS_PIHOLE_URL: "http://192.168.8.2", TS_PIHOLE_PASSWORD: "pihole-app-password", TS_NVD_API_KEY: "wrong-nvd-key" } } });
    return { apps, root };
  }

  it("says which secrets are saved, by name only, so the form does not look empty", async () => {
    const { apps } = await theyspy();
    const { applications } = await apps.inspect({ id: "theyspy" });
    const state = applications.find((entry) => entry.id === "theyspy").state;
    expect(state.secretsSaved.sort()).toEqual(["TS_NVD_API_KEY", "TS_PIHOLE_PASSWORD"]);
    expect(JSON.stringify(applications)).not.toMatch(/pihole-app-password|wrong-nvd-key/);
  });

  it("clears one optional secret on request and keeps every other setting", async () => {
    const { apps, root } = await theyspy();
    const before = await effective(root, "theyspy");
    await apps.reconfigure({ id: "theyspy", values: { clearSecrets: ["TS_NVD_API_KEY"] } }, { checkpoint: false });
    const after = await effective(root, "theyspy");
    expect(after.env.TS_NVD_API_KEY).toBe("");
    expect({ ...after.env, TS_NVD_API_KEY: undefined }).toEqual({ ...before.env, TS_NVD_API_KEY: undefined });
    // And a later save with nothing typed keeps it cleared, and keeps the rest.
    await apps.reconfigure({ id: "theyspy", values: { env: { TS_LOOK: "light" } } }, { checkpoint: false });
    expect((await effective(root, "theyspy")).env).toMatchObject({ TS_NVD_API_KEY: "", TS_PIHOLE_PASSWORD: "pihole-app-password", TS_PIHOLE_URL: "http://192.168.8.2", TS_LOOK: "light" });
  });

  it("never clears a generated or unknown secret", async () => {
    const { apps } = await theyspy();
    for (const name of ["TS_ADMIN_PASSWORD", "TS_SESSION_SECRET", "TS_PIHOLE_URL", "NOT_A_SETTING"]) {
      await expect(apps.reconfigure({ id: "theyspy", values: { clearSecrets: [name] } }, { checkpoint: false })).rejects.toThrow("only an optional secret");
    }
  });
});
