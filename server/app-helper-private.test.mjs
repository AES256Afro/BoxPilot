import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createAppHelper } from "./app-helper.mjs";
import { createCatalogService } from "./catalog/index.mjs";
import { createRegistryAuth } from "./registry-auth.mjs";

/*
 * A private app's pulls carry the registry sign-ins (M71, ADR-019), and no other app's ever do.
 * Every way Docker can fetch an image for an app is driven here through a fake Docker that records
 * the environment of each call: the pull that reads an image's user and the probe that runs it, the
 * install's pulls and `up`, reinstall, update, going back a version, a settings change, start, stop
 * and restart, and uninstall. The restore of a backup goes through the same compose() (app-backups.mjs
 * is given it), as do the models' commands (app-models.mjs).
 */

const directories = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });
async function temporary(prefix) {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  directories.push(directory);
  return directory;
}

const pinned = (repository, version, character) => `${repository}:${version}@sha256:${character.repeat(64)}`;
const manifestText = ({ id, image, port }) => [
  "schemaVersion: 2", `id: ${id}`, `name: ${id}`, "category: Test", "description: d",
  "image:", `  reference: ${image}`,
  "ports:", "  - id: web", "    container: 80", `    host: ${port}`,
  // A managed folder and no PUID: who owns it comes from the image's own USER, which means pulling
  // the image and running it once to turn the name into numbers.
  "volumes:", "  - id: data", "    container: /data", "    path: data",
  "health:", "  kind: running", "  stableSeconds: 4", "  timeoutSeconds: 30",
].join("\n") + "\n";

/** As the helper saves a manifest: a new file renamed into place, so the catalog sees the change. */
async function replace(directory, file, text) {
  await mkdir(directory, { recursive: true });
  const temp = path.join(directory, `.${file}.tmp`);
  await writeFile(temp, text);
  await rename(temp, path.join(directory, file));
}

async function setup({ signedIn = true } = {}) {
  const builtIn = await temporary("boxpilot-cat-");
  const privateDirectory = path.join(await temporary("boxpilot-private-"), "private-catalog");
  const catalogRoot = await temporary("boxpilot-approot-");
  const backupRoot = await temporary("boxpilot-appbk-");
  const authDirectory = path.join(await temporary("boxpilot-auth-"), "registry-auth");
  await replace(builtIn, "demo.yaml", manifestText({ id: "demo", image: "nginx:1.27", port: 8080 }));
  await replace(privateDirectory, "private-demo.yaml", manifestText({ id: "private-demo", image: pinned("ghcr.io/example/private-demo", "1.0", "a"), port: 8081 }));
  const registryAuth = createRegistryAuth({ directory: authDirectory });
  if (signedIn) {
    await mkdir(authDirectory, { recursive: true });
    await writeFile(path.join(authDirectory, "config.json"), JSON.stringify({ auths: { "ghcr.io": { auth: Buffer.from("someone:x").toString("base64") } } }));
  }

  const containers = new Map();
  const pulled = new Set();
  const calls = [];
  const runDocker = async (_binary, args, options = {}) => {
    calls.push({ args, dockerConfig: options.env?.DOCKER_CONFIG ?? null });
    const [verb] = args;
    if (verb === "version") return { ok: true, stdout: "28.0.0", stderr: "" };
    if (verb === "pull") { pulled.add(args[1]); return { ok: true, stdout: "", stderr: "" }; }
    if (verb === "image") {
      // `image inspect <ref> --format {{.Config.User}}` answers for an image that is here; RepoDigests is not asked about.
      if (args[3] === "--format" && args[4] === "{{.Config.User}}") return pulled.has(args[2]) ? { ok: true, stdout: "app", stderr: "" } : { ok: false, stdout: "", stderr: "No such image" };
      return { ok: false, stdout: "", stderr: "No such image" };
    }
    if (verb === "run") return { ok: true, stdout: "1000", stderr: "" };
    if (verb === "inspect") {
      const lines = args.slice(3).map((name) => containers.get(name)).filter(Boolean).map((container) => JSON.stringify(container));
      return lines.length ? { ok: true, stdout: lines.join("\n"), stderr: "" } : { ok: false, stdout: "", stderr: "No such object" };
    }
    if (verb === "ps") return { ok: true, stdout: "", stderr: "" };
    if (verb === "top") return { ok: false, stdout: "", stderr: "not running" };
    if (verb === "logs") return { ok: true, stdout: "", stderr: "" };
    if (verb === "compose") {
      const name = args[args.indexOf("--project-name") + 1];
      const action = args.find((arg, index) => index > 0 && ["up", "down", "pull", "start", "stop", "restart", "config"].includes(arg));
      if (action === "up") containers.set(name, { running: true, status: "running", health: "none", restarts: 0, image: `sha256:${pulled.size}`, startedAt: "x", exitCode: 0 });
      if (action === "down") containers.delete(name);
      if (action === "stop") Object.assign(containers.get(name) ?? {}, { running: false, status: "exited" });
      if (action === "start" || action === "restart") Object.assign(containers.get(name) ?? {}, { running: true, status: "running" });
      return { ok: true, stdout: "", stderr: "" };
    }
    return { ok: false, stdout: "", stderr: `unexpected ${args.join(" ")}` };
  };
  let nowMs = Date.parse("2026-11-17T12:00:00.000Z");
  const apps = createAppHelper({
    catalogRoot, backupRoot, machineSnapshotRoot: path.join(backupRoot, "no-snapshots"), runDocker, registryAuth,
    catalog: createCatalogService({ directory: builtIn, privateDirectory, ttlMs: 0 }),
    wait: async (ms) => { nowMs += ms; }, clock: () => new Date(nowMs),
    // Nothing here reaches the host: no Tailscale, no chown of a real folder.
    runCommand: async () => ({ ok: false, code: 1, stdout: "", stderr: "not here" }),
    chownDirectory: async () => {},
  });
  return { apps, calls, containers, builtIn, privateDirectory, authDirectory };
}

/** Everything an app goes through that can fetch its images, in an order that works. */
async function everyFetch({ apps, containers, write, id, nextImage }) {
  const marks = {};
  const mark = (name, from) => { marks[name] = from; };
  const at = (calls) => calls.length;
  return async (calls) => {
    mark("install", at(calls)); await apps.install({ id, values: {} });
    mark("reconfigure", at(calls)); await apps.reconfigure({ id, values: { env: {} } }, { checkpoint: false });
    mark("restart", at(calls)); await apps.action({ id, action: "restart" });
    mark("stop", at(calls)); await apps.action({ id, action: "stop" });
    mark("start", at(calls)); await apps.action({ id, action: "start" });
    // A new image in the manifest: what Update offers and takes, and what going back undoes.
    await write(nextImage);
    expect((await apps.inspect({ id })).applications[0].updateAvailable).toBe(true);
    mark("update", at(calls)); await apps.update({ id }, { checkpoint: false });
    mark("rollback", at(calls)); await apps.rollbackApp({ id }, { checkpoint: false });
    // The container pruned away: reinstall builds it again, pulling what is gone.
    containers.delete(`bp-${id}`);
    mark("reinstall", at(calls)); await apps.reinstall({ id });
    mark("uninstall", at(calls)); await apps.uninstall({ id });
    mark("end", at(calls));
    return marks;
  };
}

/** The calls that can fetch an image or act on the app's project, by step. */
function fetching(calls, marks) {
  const steps = Object.keys(marks).filter((name) => name !== "end");
  const bounds = [...steps.map((name) => marks[name]), marks.end];
  return steps.map((name, index) => ({
    step: name,
    calls: calls.slice(bounds[index], bounds[index + 1]).filter(({ args }) => args[0] === "pull" || args[0] === "run" || args[0] === "compose"),
  }));
}

describe("a private app's docker and compose calls", () => {
  it("all carry DOCKER_CONFIG pointing at the registry sign-ins, at every place an image can be fetched", async () => {
    const context = await setup();
    const run = await everyFetch({
      ...context, id: "private-demo",
      nextImage: pinned("ghcr.io/example/private-demo", "1.1", "b"),
      write: (image) => replace(context.privateDirectory, "private-demo.yaml", manifestText({ id: "private-demo", image, port: 8081 })),
    });
    const marks = await run(context.calls);
    const steps = fetching(context.calls, marks);
    for (const { step, calls } of steps) {
      expect(calls.length, step).toBeGreaterThan(0);
      expect(calls.filter((call) => call.dockerConfig !== context.authDirectory).map((call) => `${step}: ${call.args.join(" ")}`)).toEqual([]);
    }
    const seen = (step, predicate) => steps.find((entry) => entry.step === step).calls.some(({ args }) => predicate(args));
    // The kinds of fetch each step makes, so none of the checks above was over an empty list.
    expect(seen("install", (args) => args[0] === "pull" && args[1].includes("@sha256:"))).toBe(true);
    expect(seen("install", (args) => args.join(" ").startsWith("run --rm --entrypoint id"))).toBe(true);
    expect(seen("install", (args) => args[0] === "compose" && args.includes("up"))).toBe(true);
    expect(seen("update", (args) => args[0] === "compose" && args.includes("pull"))).toBe(true);
    expect(seen("update", (args) => args[0] === "compose" && args.includes("up"))).toBe(true);
    expect(seen("rollback", (args) => args[0] === "compose" && args.includes("pull"))).toBe(true);
    expect(seen("reinstall", (args) => args[0] === "compose" && args.includes("up"))).toBe(true);
    for (const verb of ["restart", "stop", "start"]) expect(seen(verb, (args) => args[0] === "compose" && args.includes(verb))).toBe(true);
    // Only its own calls: nothing that is not about this app asked with the sign-ins.
    expect(context.calls.filter((call) => call.dockerConfig && !call.args.join(" ").includes("private-demo")).map((call) => call.args.join(" "))).toEqual([]);
  });

  it("carry nothing when no registry is signed in", async () => {
    const context = await setup({ signedIn: false });
    await context.apps.install({ id: "private-demo", values: {} });
    expect(context.calls.some((call) => call.args[0] === "pull")).toBe(true);
    expect(context.calls.filter((call) => call.dockerConfig !== null)).toEqual([]);
  });
});

describe("a catalog app's docker and compose calls", () => {
  it("never carry the registry sign-ins, even while they are saved", async () => {
    const context = await setup();
    const run = await everyFetch({
      ...context, id: "demo",
      nextImage: "nginx:1.28",
      write: (image) => replace(context.builtIn, "demo.yaml", manifestText({ id: "demo", image, port: 8080 })),
    });
    const marks = await run(context.calls);
    for (const { step, calls } of fetching(context.calls, marks)) expect(calls.length, step).toBeGreaterThan(0);
    expect(context.calls.some((call) => call.args[0] === "run")).toBe(true);
    expect(context.calls.filter((call) => call.dockerConfig !== null).map((call) => call.args.join(" "))).toEqual([]);
    expect(JSON.parse(await readFile(path.join(context.authDirectory, "config.json"), "utf8")).auths).toHaveProperty(["ghcr.io"]);
  });
});
