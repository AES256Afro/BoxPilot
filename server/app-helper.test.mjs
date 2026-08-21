import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAppHelper } from "./app-helper.mjs";
import { createCatalogService } from "./catalog/index.mjs";

const directories = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((d) => rm(d, { recursive: true, force: true }))); });

async function setup({ healthKind = "running", exitOnUp = false, failUp = false } = {}) {
  const catalogDirectory = await mkdtemp(path.join(os.tmpdir(), "boxpilot-cat-")); directories.push(catalogDirectory);
  const catalogRoot = await mkdtemp(path.join(os.tmpdir(), "boxpilot-approot-")); directories.push(catalogRoot);
  await writeFile(path.join(catalogDirectory, "demo.yaml"), `schemaVersion: 2\nid: demo\nname: Demo\ncategory: T\ndescription: d\nimage:\n  reference: nginx:1.27\nports:\n  - id: web\n    container: 80\n    host: 8080\nvolumes:\n  - id: data\n    container: /data\n    path: data\n  - id: docker\n    container: /var/run/docker.sock\n    hostPath: /var/run/docker.sock\nenv:\n  - name: ADMIN_PASSWORD\n    type: password\n    generate: true\n  - name: TZ\n    default: Etc/UTC\nhealth:\n  kind: ${healthKind}\n  stableSeconds: 4\n  timeoutSeconds: 30\n`);
  const containers = new Map();
  const calls = [];
  const runDocker = vi.fn(async (_binary, args) => {
    calls.push(args.join(" "));
    if (args[0] === "version") return { ok: true, stdout: "28.0.0", stderr: "" };
    if (args[0] === "inspect") {
      const container = containers.get(args[args.length - 1]);
      if (!container) return { ok: false, stdout: "", stderr: "No such object" };
      return { ok: true, stdout: JSON.stringify(container), stderr: "" };
    }
    if (args[0] === "logs") return { ok: true, stdout: "line1\npassword=hunter2", stderr: "" };
    if (args[0] === "compose") {
      const name = args[args.indexOf("--project-name") + 1];
      const verb = args.find((arg, index) => index > 0 && ["up", "down", "pull", "start", "stop", "restart"].includes(arg));
      if (verb === "up") {
        if (failUp) return { ok: false, stdout: "", stderr: "Error response from daemon: port is already allocated" };
        containers.set(name, exitOnUp ? { running: false, status: "exited", health: "none", restarts: 0, image: "sha256:new", startedAt: "x", exitCode: 1 } : { running: true, status: "running", health: healthKind === "healthcheck" ? "healthy" : "none", restarts: 0, image: "sha256:new", startedAt: "x", exitCode: 0 });
      }
      if (verb === "down") containers.delete(name);
      if (verb === "stop") { const c = containers.get(name); if (c) Object.assign(c, { running: false, status: "exited" }); }
      if (verb === "start" || verb === "restart") { const c = containers.get(name); if (c) Object.assign(c, { running: true, status: "running" }); }
      return { ok: true, stdout: "", stderr: "" };
    }
    return { ok: false, stdout: "", stderr: `unexpected ${args.join(" ")}` };
  });
  let nowMs = Date.parse("2026-08-19T12:00:00.000Z");
  const clock = () => new Date(nowMs);
  const wait = vi.fn(async (ms) => { nowMs += ms; });
  const catalog = createCatalogService({ directory: catalogDirectory, ttlMs: 0 });
  const backupRoot = await mkdtemp(path.join(os.tmpdir(), "boxpilot-appbk-")); directories.push(backupRoot);
  const apps = createAppHelper({ catalogRoot, backupRoot, runDocker, catalog, wait, clock, lanAddress: "192.168.1.10" });
  const advance = (ms) => { nowMs += ms; };
  return { apps, calls, containers, catalogRoot, catalogDirectory, backupRoot, advance };
}

describe("generic app deployer", () => {
  it("installs, inspects, acts on, reconfigures, updates, and uninstalls an app from its manifest", async () => {
    const { apps, calls, catalogRoot } = await setup();
    const installed = await apps.install({ id: "demo", values: { ports: { web: 9090 } } });
    expect(installed).toMatchObject({ installed: true, id: "demo", hostPorts: [{ id: "web", host: 9090 }], secretsGenerated: ["ADMIN_PASSWORD"] });
    expect(calls).toContainEqual(expect.stringMatching(/^compose --project-name bp-demo --file .*compose\.yaml --env-file .*\.env up --detach --remove-orphans$/));
    const compose = await readFile(path.join(catalogRoot, "demo", "compose.yaml"), "utf8");
    expect(compose).toContain("192.168.1.10:9090:80");
    expect(compose).toContain("ADMIN_PASSWORD: ${ADMIN_PASSWORD}");
    const env = await readFile(path.join(catalogRoot, "demo", ".env"), "utf8");
    expect(env).toMatch(/^ADMIN_PASSWORD=\S+\n$/);
    expect(await readdir(path.join(catalogRoot, "demo"))).toEqual(expect.arrayContaining(["compose.yaml", ".env", "boxpilot.json", "data"]));

    const { applications } = await apps.inspect({});
    expect(applications[0]).toMatchObject({ id: "demo", installed: true, container: { running: true }, urls: [{ id: "web", host: 9090 }], updateAvailable: false, installedImage: "nginx:1.27" });
    expect(JSON.stringify(applications)).not.toContain(env.trim().split("=")[1]);

    await expect(apps.install({ id: "demo" })).rejects.toThrow("already installed");
    await expect(apps.action({ id: "demo", action: "stop" })).resolves.toMatchObject({ running: false });
    await expect(apps.action({ id: "demo", action: "start" })).resolves.toMatchObject({ running: true });
    await expect(apps.action({ id: "demo", action: "explode" })).rejects.toThrow("start, stop, or restart");

    const logs = await apps.logs({ id: "demo", lines: 5 });
    expect(logs.lines.join("\n")).toContain("password=[REDACTED]");

    const effective = await apps.config({ id: "demo" });
    expect(effective.compose).toContain("ADMIN_PASSWORD: ${ADMIN_PASSWORD}");
    expect(effective.env).toContainEqual({ name: "ADMIN_PASSWORD", value: "••••••••", secret: true });
    expect(JSON.stringify(effective)).not.toContain(env.trim().split("=")[1]); // masked, never the real secret

    await expect(apps.reconfigure({ id: "demo", values: { ports: { web: 9191 }, env: { TZ: "Europe/Berlin" } } })).resolves.toMatchObject({ reconfigured: true, hostPorts: [{ host: 9191 }] });
    expect(await readFile(path.join(catalogRoot, "demo", ".env"), "utf8")).toBe(env); // secret preserved
    expect(await readFile(path.join(catalogRoot, "demo", "compose.yaml"), "utf8")).toContain("TZ: Europe/Berlin");

    // Non-configurable volumes are rendered into compose but never persisted as operator settings.
    expect(await readFile(path.join(catalogRoot, "demo", "compose.yaml"), "utf8")).toContain("/var/run/docker.sock:/var/run/docker.sock");
    expect(JSON.parse(await readFile(path.join(catalogRoot, "demo", "boxpilot.json"), "utf8")).values.volumes).toEqual({});

    const updated = await apps.update({ id: "demo" });
    expect(updated).toMatchObject({ updated: true, checkpoint: { artifact: expect.stringMatching(/\.tar\.gz$/), checksumSha256: expect.stringMatching(/^[a-f0-9]{64}$/) } });
    expect(calls).toContainEqual(expect.stringMatching(/compose .* pull$/));
    // The checkpoint is a regular backup the card can restore from; it happens before the pull.
    expect((await apps.listAppBackups({ id: "demo" })).backups.map((entry) => entry.artifact)).toContain(updated.checkpoint.artifact);
    expect(calls.findIndex((call) => / stop$/.test(call))).toBeLessThan(calls.findIndex((call) => / pull$/.test(call)));
    await expect(apps.update({ id: "demo" }, { checkpoint: false })).resolves.toMatchObject({ updated: true, checkpoint: null });

    await expect(apps.uninstall({ id: "demo", purge: false })).resolves.toMatchObject({ uninstalled: true, dataRemoved: false });
    expect(await readdir(path.join(catalogRoot, "demo"))).toEqual(expect.arrayContaining(["data", "boxpilot.json"]));
    expect((await apps.inspect({})).applications[0]).toMatchObject({ installed: false, dataPresent: true });
    await apps.install({ id: "demo" });
    await expect(apps.uninstall({ id: "demo", purge: true })).resolves.toMatchObject({ purged: true, dataRemoved: true });
    await expect(readdir(path.join(catalogRoot, "demo"))).rejects.toThrow();
  });

  it("edits the raw compose file with validation and rollback", async () => {
    const { apps, catalogRoot } = await setup();
    await apps.install({ id: "demo" });
    const composePath = path.join(catalogRoot, "demo", "compose.yaml");
    const original = await readFile(composePath, "utf8");

    await expect(apps.editCompose({ id: "demo", compose: "not: [valid" })).rejects.toThrow("Not valid YAML");
    await expect(apps.editCompose({ id: "demo", compose: "just: scalars" })).rejects.toThrow("must define services");
    expect(await readFile(composePath, "utf8")).toBe(original);

    const edited = original.replace("restart: unless-stopped", "restart: always");
    await expect(apps.editCompose({ id: "demo", compose: edited })).resolves.toMatchObject({ edited: true, rawEdited: true, checkpoint: { artifact: expect.stringMatching(/\.tar\.gz$/) } });
    expect((await apps.listAppBackups({ id: "demo" })).backups).toHaveLength(1);
    expect(await readFile(composePath, "utf8")).toBe(edited);
    expect(JSON.parse(await readFile(path.join(catalogRoot, "demo", "boxpilot.json"), "utf8")).rawEdited).toBe(true);
  });

  it("updates an app whose stored state echoes values the manifest does not accept", async () => {
    // Older releases persisted every hostPath volume (docker socket included) into
    // boxpilot.json; updates then failed validation. Stored state is sanitized instead.
    const { apps, catalogRoot } = await setup();
    await apps.install({ id: "demo" });
    const statePath = path.join(catalogRoot, "demo", "boxpilot.json");
    const state = JSON.parse(await readFile(statePath, "utf8"));
    state.values.volumes = { docker: "/var/run/docker.sock" };
    state.values.env.REMOVED_SETTING = "stale";
    await writeFile(statePath, JSON.stringify(state));

    await expect(apps.update({ id: "demo" })).resolves.toMatchObject({ updated: true });
    const after = JSON.parse(await readFile(statePath, "utf8"));
    expect(after.values.volumes).toEqual({});
    expect(after.values.env.REMOVED_SETTING).toBeUndefined();
  });

  it("rolls back a failed fresh install and reports the container's last log lines", async () => {
    const { apps, catalogRoot } = await setup({ exitOnUp: true });
    await expect(apps.install({ id: "demo" })).rejects.toThrow(/rolled back.*Container exited/);
    await expect(readdir(path.join(catalogRoot, "demo"))).rejects.toThrow();
    const failing = await setup({ failUp: true });
    await expect(failing.apps.install({ id: "demo" })).rejects.toThrow("port is already allocated");
  });

  it("refuses unknown apps and invalid settings before touching docker", async () => {
    const { apps, calls } = await setup();
    await expect(apps.install({ id: "nope" })).rejects.toThrow("not in the catalog");
    await expect(apps.install({ id: "demo", values: { ports: { web: 70000 } } })).rejects.toThrow("Invalid settings");
    await expect(apps.install({ id: "../x" })).rejects.toThrow("invalid");
    expect(calls.filter((call) => call.startsWith("compose"))).toEqual([]);
  });

  it("populates Homepage with installed apps, keeps operator groups, and refreshes after uninstall", async () => {
    const { apps, catalogRoot, catalogDirectory } = await setup();
    await writeFile(path.join(catalogDirectory, "homepage.yaml"), "schemaVersion: 2\nid: homepage\nname: Homepage\ncategory: Dashboard\ndescription: dash\nimage:\n  reference: ghcr.io/gethomepage/homepage:v1\nports:\n  - id: web\n    container: 3000\n    host: 3000\nvolumes:\n  - id: config\n    container: /app/config\n    path: config\nhealth:\n  kind: running\n  stableSeconds: 1\n  timeoutSeconds: 10\n");
    await expect(apps.syncHomepage({ host: "192.168.1.10" })).rejects.toThrow("not installed");
    await apps.install({ id: "homepage" });
    const configDirectory = path.join(catalogRoot, "homepage", "config");
    await writeFile(path.join(configDirectory, "services.yaml"), "- Mine:\n    - Router:\n        href: http://192.168.1.1\n");
    await apps.install({ id: "demo" }); // no host remembered yet: the auto-refresh is skipped, not fatal

    const result = await apps.syncHomepage({ host: "192.168.1.10" });
    expect(result).toMatchObject({ synced: true, services: 1, groupsKept: 1, host: "192.168.1.10" });
    const services = await readFile(path.join(configDirectory, "services.yaml"), "utf8");
    expect(services).toContain("- BoxPilot:");
    expect(services).toContain("href: http://192.168.1.10:8080");
    expect(services).toContain("container: bp-demo");
    expect(services).toContain("- Mine:");
    expect(services.indexOf("- BoxPilot:")).toBeLessThan(services.indexOf("- Mine:"));
    expect(await readFile(path.join(configDirectory, "docker.yaml"), "utf8")).toContain("socket: /var/run/docker.sock");

    await apps.uninstall({ id: "demo", purge: false });
    const after = await readFile(path.join(configDirectory, "services.yaml"), "utf8");
    expect(after).not.toContain("bp-demo");
    expect(after).toContain("- Mine:");
  });

  it("backs up, prunes, restores, and deletes app data with a real archive", async () => {
    const { apps, calls, catalogRoot, backupRoot, advance } = await setup();
    await apps.install({ id: "demo" });
    await writeFile(path.join(catalogRoot, "demo", "data", "file.txt"), "precious");

    const first = await apps.backup({ id: "demo" });
    expect(first).toMatchObject({ backedUp: true, artifact: expect.stringMatching(/^\d{8}T\d{6}Z\.tar\.gz$/), contents: expect.arrayContaining(["boxpilot.json", "compose.yaml", ".env", "data"]), pruned: [] });
    expect(typeof first.checksumSha256).toBe("string");
    expect(first.downtimeMs).not.toBeNull(); // it was running: stop + start around the archive
    expect(calls).toContainEqual(expect.stringMatching(/compose .* stop$/));
    expect(calls).toContainEqual(expect.stringMatching(/compose .* start$/));
    expect(await readdir(path.join(backupRoot, "demo"))).toEqual(expect.arrayContaining([first.artifact, first.artifact.replace(/\.tar\.gz$/, ".json")]));

    advance(60_000);
    await writeFile(path.join(catalogRoot, "demo", "data", "file.txt"), "changed since backup");
    const second = await apps.backup({ id: "demo", keep: 1 });
    expect(second.pruned).toEqual([first.artifact]);
    const listed = await apps.listAppBackups({ id: "demo" });
    expect(listed.backups).toHaveLength(1);
    expect(listed.backups[0]).toMatchObject({ artifact: second.artifact, checksumSha256: second.checksumSha256 });

    advance(60_000);
    await writeFile(path.join(catalogRoot, "demo", "data", "file.txt"), "broken state");
    const restored = await apps.restoreAppBackup({ id: "demo", backup: second.artifact });
    expect(restored).toMatchObject({ restored: true, backup: second.artifact });
    expect(await readFile(path.join(catalogRoot, "demo", "data", "file.txt"), "utf8")).toBe("changed since backup");
    // The restore first saved the broken state as a safety copy alongside the restored one.
    expect((await apps.listAppBackups({ id: "demo" })).backups.length).toBe(2);

    await expect(apps.restoreAppBackup({ id: "demo", backup: "evil/../../x.tar.gz" })).rejects.toThrow("invalid");
    await expect(apps.deleteAppBackup({ id: "demo", backup: second.artifact })).resolves.toMatchObject({ deleted: true });
    await expect(apps.deleteAppBackup({ id: "demo", backup: second.artifact })).rejects.toThrow("does not exist");
  });
});
