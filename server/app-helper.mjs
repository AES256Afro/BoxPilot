/**
 * Generic application deployer (helper side, runs as root). One implementation for every catalog
 * manifest: install, uninstall, purge, update, reconfigure, start/stop/restart, inspect, logs.
 * Layout per app: <catalogRoot>/<id>/{compose.yaml,.env,boxpilot.json,<managed volume dirs>}.
 */
import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fixedRun } from "./exec.mjs";
import { createCatalogService } from "./catalog/index.mjs";
import { renderCompose, projectNameFor } from "./catalog/compose.mjs";
import { resolveValues } from "./catalog/schema.mjs";

const actions = Object.freeze(["start", "stop", "restart"]);
const idPattern = /^[a-z0-9][a-z0-9-]{1,62}$/;

async function defaultDockerRunner(binary, args, { timeout = 120_000, cwd, onLine = null } = {}) {
  return fixedRun(binary, args, { timeout, cwd, onLine, maxBuffer: 4 * 1024 * 1024, env: { PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" } });
}

function redact(value) {
  return String(value ?? "").replace(/\b(token|password|secret|api[_-]?key|authorization)\b\s*[:=]\s*[^\s,;]+/gi, "$1=[REDACTED]").slice(0, 2000);
}

function parseEnvFile(text) {
  const env = {};
  for (const line of String(text ?? "").split("\n")) {
    const match = line.match(/^([A-Z][A-Za-z0-9_]*)=(.*)$/);
    if (match) env[match[1]] = match[2];
  }
  return env;
}

export function createAppHelper({
  catalogRoot = process.env.BOXPILOT_CATALOG_ROOT ?? "/var/lib/boxpilot-managed/catalog",
  dockerBinary = process.env.BOXPILOT_DOCKER_BINARY ?? "/usr/bin/docker",
  runDocker = defaultDockerRunner,
  catalog = createCatalogService(),
  wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  clock = () => new Date(),
  lanAddress = "0.0.0.0",
} = {}) {
  const root = path.resolve(catalogRoot);
  const dirFor = (id) => path.join(root, id);
  const docker = (args, options) => runDocker(dockerBinary, args, options);

  async function readState(id) {
    try { return JSON.parse(await readFile(path.join(dirFor(id), "boxpilot.json"), "utf8")); } catch { return null; }
  }
  async function writeState(id, state) {
    const target = path.join(dirFor(id), "boxpilot.json");
    await writeFile(`${target}.tmp`, JSON.stringify(state, null, 2), { mode: 0o600 });
    await rename(`${target}.tmp`, target);
  }
  async function readEnv(id) {
    try { return parseEnvFile(await readFile(path.join(dirFor(id), ".env"), "utf8")); } catch { return {}; }
  }

  async function containerStatus(id) {
    const name = projectNameFor(id);
    const result = await docker(["inspect", "--format", '{"running":{{.State.Running}},"status":"{{.State.Status}}","health":"{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}","restarts":{{.RestartCount}},"image":"{{.Image}}","startedAt":"{{.State.StartedAt}}","exitCode":{{.State.ExitCode}}}', name], { timeout: 10_000 });
    if (!result.ok) return { exists: false, running: false, status: "absent", health: "none", restarts: 0, image: null, startedAt: null };
    try { return { exists: true, ...JSON.parse(result.stdout) }; } catch { return { exists: true, running: false, status: "unknown", health: "none", restarts: 0, image: null, startedAt: null }; }
  }

  async function waitHealthy(manifest, progress = null) {
    const deadline = clock().getTime() + manifest.health.timeoutSeconds * 1000;
    let stableSince = null; let lastRestarts = null; let last = "starting"; let reported = null;
    progress?.(manifest.health.kind === "healthcheck" ? "Waiting for the container healthcheck to pass..." : `Waiting for the container to run steadily for ${manifest.health.stableSeconds}s...`, "stdout");
    while (clock().getTime() < deadline) {
      const status = await containerStatus(manifest.id);
      last = `${status.status}/${status.health}`;
      if (last !== reported) { progress?.(`container: ${last}`, "stdout"); reported = last; }
      if (status.running) {
        if (manifest.health.kind === "healthcheck") {
          if (status.health === "healthy") return status;
          if (status.health === "none") throw new Error("Manifest expects a container healthcheck but the image defines none");
        } else {
          if (lastRestarts !== null && status.restarts > lastRestarts) { stableSince = null; }
          lastRestarts = status.restarts;
          stableSince ??= clock().getTime();
          if (clock().getTime() - stableSince >= manifest.health.stableSeconds * 1000) return status;
        }
      } else {
        stableSince = null;
        if (status.exists && ["exited", "dead"].includes(status.status)) {
          const logs = await docker(["logs", "--tail", "20", projectNameFor(manifest.id)], { timeout: 10_000 });
          throw new Error(`Container exited (code ${status.exitCode ?? "?"}). Last log lines: ${redact(`${logs.stdout}\n${logs.stderr}`.trim()).slice(-600)}`);
        }
      }
      await wait(2000);
    }
    throw new Error(`Application did not become healthy within ${manifest.health.timeoutSeconds}s (last state ${last})`);
  }

  async function compose(id, args, { progress = null, ...options } = {}) {
    const directory = dirFor(id);
    progress?.(`$ docker compose ${args.join(" ")}`, "stdout");
    return docker(["compose", "--project-name", projectNameFor(id), "--file", path.join(directory, "compose.yaml"), "--env-file", path.join(directory, ".env"), ...args], { timeout: 300_000, cwd: directory, ...(progress ? { onLine: progress } : {}), ...options });
  }

  async function ensureManifest(id) {
    if (typeof id !== "string" || !idPattern.test(id)) throw new Error("Application id is invalid");
    const manifest = await catalog.get(id);
    if (!manifest) throw new Error(`Application ${id} is not in the catalog`);
    return manifest;
  }

  async function writeProject(manifest, values, { existingEnv = {} } = {}) {
    const directory = dirFor(manifest.id);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    for (const volume of manifest.volumes) if (volume.path) await mkdir(path.join(directory, volume.path), { recursive: true, mode: 0o755 });
    const rendered = renderCompose(manifest, values, { existingEnv, lanAddress });
    await writeFile(path.join(directory, ".env.tmp"), rendered.envFile, { mode: 0o600 });
    await rename(path.join(directory, ".env.tmp"), path.join(directory, ".env"));
    await writeFile(path.join(directory, "compose.yaml.tmp"), rendered.composeYaml, { mode: 0o600 });
    await rename(path.join(directory, "compose.yaml.tmp"), path.join(directory, "compose.yaml"));
    return rendered;
  }

  async function describe(manifest) {
    const state = await readState(manifest.id);
    const status = await containerStatus(manifest.id);
    return {
      id: manifest.id,
      installed: Boolean(state && state.installed),
      dataPresent: Boolean(state),
      state: state ? { installedAt: state.installedAt, updatedAt: state.updatedAt, manifestSha256: state.manifestSha256, image: state.image, values: { ports: state.values?.ports ?? {}, env: state.values?.env ?? {}, volumes: state.values?.volumes ?? {} }, pinnedRollback: state.pinnedRollback ?? false, uninstalledAt: state.uninstalledAt ?? null } : null,
      container: status,
      urls: state && state.installed ? manifest.ports.filter((port) => port.protocol === "tcp").map((port) => ({ id: port.id, label: port.label, host: state.values?.ports?.[port.id] ?? port.host, exposure: port.exposure })) : [],
      updateAvailable: Boolean(state?.installed && state.image?.reference && state.image.reference !== manifest.image.reference),
      installedImage: state?.image?.reference ?? null,
    };
  }

  async function inspect({ id = null } = {}) {
    const { manifests, problems } = await catalog.all();
    const selected = id ? manifests.filter((manifest) => manifest.id === id) : manifests;
    const applications = [];
    for (const manifest of selected) applications.push(await describe(manifest));
    return { applications, problems, catalogRoot: root };
  }

  async function install({ id, values: rawValues = {} }, { progress = null } = {}) {
    const manifest = await ensureManifest(id);
    const existing = await readState(id);
    if (existing?.installed) throw new Error(`${manifest.name} is already installed; use reconfigure or update`);
    const { values, errors } = resolveValues(manifest, rawValues);
    if (errors.length) throw new Error(`Invalid settings: ${errors.join("; ")}`);
    const probe = await docker(["version", "--format", "{{.Server.Version}}"], { timeout: 10_000 });
    if (!probe.ok) throw new Error("Docker Engine is not available; install it from Repair Center first");
    let directoryExisted = true;
    try { await stat(dirFor(id)); } catch { directoryExisted = false; }
    progress?.(`Writing compose project for ${manifest.name} (${manifest.image.reference})`, "stdout");
    const rendered = await writeProject(manifest, values, { existingEnv: await readEnv(id) });
    const up = await compose(id, ["up", "--detach", "--remove-orphans"], { timeout: 15 * 60_000, progress });
    try {
      if (!up.ok) throw new Error(`docker compose up failed: ${redact(up.stderr).split("\n").slice(-4).join(" ")}`);
      const status = await waitHealthy(manifest, progress);
      progress?.(`${manifest.name} is up`, "stdout");
      await writeState(id, { id, installed: true, installedAt: clock().toISOString(), updatedAt: clock().toISOString(), manifestSha256: manifest.sha256 ?? null, image: { reference: manifest.image.reference, id: status.image }, values: { ports: values.ports, env: Object.fromEntries(Object.entries(rendered.env).filter(([name]) => !manifest.env.find((entry) => entry.name === name)?.secret)), volumes: values.volumes }, pinnedRollback: false });
      return { installed: true, id, name: manifest.name, image: status.image, hostPorts: rendered.hostPorts, health: status.health, secretsGenerated: manifest.env.filter((entry) => entry.generate).map((entry) => entry.name) };
    } catch (error) {
      progress?.(`Install failed: ${error.message}. Rolling back...`, "stderr");
      await compose(id, ["down", "--remove-orphans"], { timeout: 120_000, progress }).catch(() => {});
      if (!directoryExisted) await rm(dirFor(id), { recursive: true, force: true }).catch(() => {});
      throw new Error(`${manifest.name} installation failed and was rolled back. ${error.message}`);
    }
  }

  async function uninstall({ id, purge = false }, { progress = null } = {}) {
    const manifest = await ensureManifest(id);
    const state = await readState(id);
    const status = await containerStatus(id);
    if (!state && !status.exists) throw new Error(`${manifest.name} is not installed`);
    const down = await compose(id, ["down", "--remove-orphans"], { timeout: 180_000, progress });
    if (!down.ok && status.exists) throw new Error(`docker compose down failed: ${redact(down.stderr).split("\n").slice(-3).join(" ")}`);
    if (purge) {
      await rm(dirFor(id), { recursive: true, force: true });
      return { uninstalled: true, purged: true, id, dataRemoved: true };
    }
    await writeState(id, { ...(state ?? { id }), installed: false, uninstalledAt: clock().toISOString() });
    await rm(path.join(dirFor(id), "compose.yaml"), { force: true });
    return { uninstalled: true, purged: false, id, dataRemoved: false, dataDirectory: dirFor(id) };
  }

  async function update({ id }, { progress = null } = {}) {
    const manifest = await ensureManifest(id);
    const state = await readState(id);
    if (!state?.installed) throw new Error(`${manifest.name} is not installed`);
    const before = await containerStatus(id);
    const { values, errors } = resolveValues(manifest, state.values ?? {});
    if (errors.length) throw new Error(`Stored settings no longer match the manifest: ${errors.join("; ")}`);
    await writeProject(manifest, values, { existingEnv: await readEnv(id) }); // picks up manifest changes (new image tag)
    const pull = await compose(id, ["pull"], { timeout: 30 * 60_000, progress });
    if (!pull.ok) throw new Error(`docker compose pull failed: ${redact(pull.stderr).split("\n").slice(-3).join(" ")}`);
    const up = await compose(id, ["up", "--detach", "--remove-orphans"], { timeout: 15 * 60_000, progress });
    try {
      if (!up.ok) throw new Error(`docker compose up failed: ${redact(up.stderr).split("\n").slice(-4).join(" ")}`);
      const status = await waitHealthy(manifest, progress);
      await writeState(id, { ...state, updatedAt: clock().toISOString(), manifestSha256: manifest.sha256 ?? null, image: { reference: manifest.image.reference, id: status.image }, values, pinnedRollback: false });
      return { updated: true, id, previousImage: before.image, image: status.image, changed: before.image !== status.image };
    } catch (error) {
      let rolledBack = false;
      if (before.image) {
        const pinned = { ...manifest, image: { ...manifest.image, reference: before.image } };
        await writeProject(pinned, values, { existingEnv: await readEnv(id) }).catch(() => {});
        progress?.(`Update failed: ${error.message}. Restoring previous image...`, "stderr");
        const rollback = await compose(id, ["up", "--detach", "--remove-orphans"], { timeout: 10 * 60_000, progress });
        rolledBack = rollback.ok;
        if (rolledBack) await writeState(id, { ...state, pinnedRollback: true, image: { reference: before.image, id: before.image } }).catch(() => {});
      }
      throw new Error(`${manifest.name} update failed${rolledBack ? "; the previous image was restored" : " and automatic rollback also failed"}. ${error.message}`);
    }
  }

  async function reconfigure({ id, values: rawValues = {} }, { progress = null } = {}) {
    const manifest = await ensureManifest(id);
    const state = await readState(id);
    if (!state?.installed) throw new Error(`${manifest.name} is not installed`);
    const { values, errors } = resolveValues(manifest, rawValues);
    if (errors.length) throw new Error(`Invalid settings: ${errors.join("; ")}`);
    const previousCompose = await readFile(path.join(dirFor(id), "compose.yaml"), "utf8").catch(() => null);
    const previousEnv = await readFile(path.join(dirFor(id), ".env"), "utf8").catch(() => "");
    const rendered = await writeProject(manifest, values, { existingEnv: parseEnvFile(previousEnv) });
    const up = await compose(id, ["up", "--detach", "--remove-orphans"], { timeout: 15 * 60_000, progress });
    try {
      if (!up.ok) throw new Error(`docker compose up failed: ${redact(up.stderr).split("\n").slice(-4).join(" ")}`);
      await waitHealthy(manifest, progress);
      await writeState(id, { ...state, updatedAt: clock().toISOString(), values: { ports: values.ports, env: Object.fromEntries(Object.entries(rendered.env).filter(([name]) => !manifest.env.find((entry) => entry.name === name)?.secret)), volumes: values.volumes } });
      return { reconfigured: true, id, hostPorts: rendered.hostPorts };
    } catch (error) {
      let rolledBack = false;
      if (previousCompose !== null) {
        await writeFile(path.join(dirFor(id), "compose.yaml"), previousCompose, { mode: 0o600 });
        await writeFile(path.join(dirFor(id), ".env"), previousEnv, { mode: 0o600 });
        progress?.(`Reconfiguration failed: ${error.message}. Restoring previous configuration...`, "stderr");
        rolledBack = (await compose(id, ["up", "--detach", "--remove-orphans"], { timeout: 10 * 60_000, progress })).ok;
      }
      throw new Error(`${manifest.name} reconfiguration failed${rolledBack ? "; the previous configuration was restored" : ""}. ${error.message}`);
    }
  }

  async function action({ id, action: verb }, { progress = null } = {}) {
    const manifest = await ensureManifest(id);
    if (!actions.includes(verb)) throw new Error("Action must be start, stop, or restart");
    const state = await readState(id);
    if (!state?.installed) throw new Error(`${manifest.name} is not installed`);
    const result = await compose(id, [verb], { timeout: 180_000, progress });
    if (!result.ok) throw new Error(`docker compose ${verb} failed: ${redact(result.stderr).split("\n").slice(-3).join(" ")}`);
    const status = await containerStatus(id);
    return { id, action: verb, running: status.running, status: status.status };
  }

  async function logs({ id, lines = 200 }) {
    await ensureManifest(id);
    const tail = Math.min(Math.max(Number.parseInt(lines, 10) || 200, 1), 1000);
    const result = await docker(["logs", "--tail", String(tail), "--timestamps", projectNameFor(id)], { timeout: 30_000 });
    if (!result.ok && !result.stdout) throw new Error(`docker logs failed: ${redact(result.stderr).split("\n").slice(-2).join(" ")}`);
    const entries = `${result.stdout}\n${result.stderr}`.split("\n").filter(Boolean).map(redact).slice(-tail);
    return { id, lines: entries };
  }

  /** Effective compose.yaml and .env for an installed app. Secret values are masked here; app.secrets (elevated) reveals them. */
  async function config({ id }) {
    const manifest = await ensureManifest(id);
    const state = await readState(id);
    if (!state?.installed) throw new Error(`${manifest.name} is not installed`);
    let compose = null;
    try { compose = await readFile(path.join(dirFor(id), "compose.yaml"), "utf8"); } catch { compose = null; }
    const env = await readEnv(id);
    const secretNames = new Set(manifest.env.filter((entry) => entry.secret).map((entry) => entry.name));
    const entries = Object.keys(env).sort().map((name) => ({ name, value: secretNames.has(name) ? "••••••••" : env[name], secret: secretNames.has(name) }));
    return { id, name: manifest.name, compose, env: entries, directory: dirFor(id) };
  }

  /** Generated/secret settings for an installed app, read from its .env. Only exposed to an elevated session; never stored in a job. */
  async function secrets({ id }) {
    const manifest = await ensureManifest(id);
    const env = await readEnv(id);
    const entries = manifest.env.filter((entry) => entry.secret && entry.name in env).map((entry) => ({ name: entry.name, label: entry.label, value: env[entry.name] }));
    return { id, secrets: entries };
  }

  async function checkUpdates() {
    const { manifests } = await catalog.all();
    const results = [];
    for (const manifest of manifests) {
      const state = await readState(manifest.id);
      if (!state?.installed) continue;
      results.push({ id: manifest.id, manifestChanged: state.manifestSha256 !== (manifest.sha256 ?? null), imageReference: manifest.image.reference, installedImage: state.image?.id ?? null });
    }
    return { applications: results };
  }

  return { inspect, install, uninstall, update, reconfigure, action, logs, config, secrets, checkUpdates, catalogRoot: root, internals: { containerStatus, waitHealthy, writeProject, readState, parseEnvFile } };
}
