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
  await writeFile(path.join(catalogDirectory, "demo.yaml"), `schemaVersion: 2\nid: demo\nname: Demo\ncategory: T\ndescription: d\nimage:\n  reference: nginx:1.27\nports:\n  - id: web\n    container: 80\n    host: 8080\nvolumes:\n  - id: data\n    container: /data\n    path: data\nenv:\n  - name: ADMIN_PASSWORD\n    type: password\n    generate: true\n  - name: TZ\n    default: Etc/UTC\nhealth:\n  kind: ${healthKind}\n  stableSeconds: 4\n  timeoutSeconds: 30\n`);
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
  const apps = createAppHelper({ catalogRoot, runDocker, catalog, wait, clock, lanAddress: "192.168.1.10" });
  return { apps, calls, containers, catalogRoot, catalogDirectory };
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

    await expect(apps.update({ id: "demo" })).resolves.toMatchObject({ updated: true });
    expect(calls).toContainEqual(expect.stringMatching(/compose .* pull$/));

    await expect(apps.uninstall({ id: "demo", purge: false })).resolves.toMatchObject({ uninstalled: true, dataRemoved: false });
    expect(await readdir(path.join(catalogRoot, "demo"))).toEqual(expect.arrayContaining(["data", "boxpilot.json"]));
    expect((await apps.inspect({})).applications[0]).toMatchObject({ installed: false, dataPresent: true });
    await apps.install({ id: "demo" });
    await expect(apps.uninstall({ id: "demo", purge: true })).resolves.toMatchObject({ purged: true, dataRemoved: true });
    await expect(readdir(path.join(catalogRoot, "demo"))).rejects.toThrow();
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
});
