/**
 * Generic application deployer (helper side, runs as root). One implementation for every catalog
 * manifest: install, uninstall, purge, update, reconfigure, start/stop/restart, inspect, logs.
 * Layout per app: <catalogRoot>/<id>/{compose.yaml,.env,boxpilot.json,<managed volume dirs>}.
 */
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fixedRun } from "./exec.mjs";
import { createCatalogService } from "./catalog/index.mjs";
import { renderCompose, projectNameFor } from "./catalog/compose.mjs";
import { resolveValues, sanitizeStoredValues } from "./catalog/schema.mjs";

const actions = Object.freeze(["start", "stop", "restart"]);
const idPattern = /^[a-z0-9][a-z0-9-]{1,62}$/;
export const backupNamePattern = /^\d{8}T\d{6}Z\.tar\.gz$/;

async function sha256File(target) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(target)) hash.update(chunk);
  return hash.digest("hex");
}

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
  backupRoot = path.join(process.env.BOXPILOT_APPLICATION_BACKUP_ROOT ?? "/var/lib/boxpilot-managed/backups", "catalog"),
  dockerBinary = process.env.BOXPILOT_DOCKER_BINARY ?? "/usr/bin/docker",
  tarBinary = process.env.BOXPILOT_TAR_BINARY ?? "/usr/bin/tar",
  runDocker = defaultDockerRunner,
  runCommand = fixedRun,
  catalog = createCatalogService(),
  wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  clock = () => new Date(),
  lanAddress = "0.0.0.0",
} = {}) {
  const root = path.resolve(catalogRoot);
  const dirFor = (id) => path.join(root, id);
  const backupDirFor = (id) => path.join(path.resolve(backupRoot), id);
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

  /** What boxpilot.json persists: never secrets, never values the operator cannot change. */
  function storableValues(manifest, values, env) {
    return {
      ports: values.ports,
      env: Object.fromEntries(Object.entries(env).filter(([name]) => !manifest.env.find((entry) => entry.name === name)?.secret)),
      volumes: Object.fromEntries(Object.entries(values.volumes).filter(([id]) => manifest.volumes.find((volume) => volume.id === id)?.configurable)),
    };
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
      await writeState(id, { id, installed: true, installedAt: clock().toISOString(), updatedAt: clock().toISOString(), manifestSha256: manifest.sha256 ?? null, image: { reference: manifest.image.reference, id: status.image }, values: storableValues(manifest, values, rendered.env), pinnedRollback: false });
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
    // Stored state may predate the current manifest (or older releases stored values the
    // operator could not change); keep only what the manifest accepts today.
    const { values, errors } = resolveValues(manifest, sanitizeStoredValues(manifest, state.values ?? {}));
    if (errors.length) throw new Error(`Stored settings no longer match the manifest: ${errors.join("; ")}`);
    await writeProject(manifest, values, { existingEnv: await readEnv(id) }); // picks up manifest changes (new image tag)
    const pull = await compose(id, ["pull"], { timeout: 30 * 60_000, progress });
    if (!pull.ok) throw new Error(`docker compose pull failed: ${redact(pull.stderr).split("\n").slice(-3).join(" ")}`);
    const up = await compose(id, ["up", "--detach", "--remove-orphans"], { timeout: 15 * 60_000, progress });
    try {
      if (!up.ok) throw new Error(`docker compose up failed: ${redact(up.stderr).split("\n").slice(-4).join(" ")}`);
      const status = await waitHealthy(manifest, progress);
      await writeState(id, { ...state, updatedAt: clock().toISOString(), manifestSha256: manifest.sha256 ?? null, image: { reference: manifest.image.reference, id: status.image }, values: storableValues(manifest, values, values.env), pinnedRollback: false });
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
      await writeState(id, { ...state, updatedAt: clock().toISOString(), values: storableValues(manifest, values, rendered.env) });
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

  /**
   * Consistent backup of an app's managed data: stop, tar the compose project plus every
   * backup-flagged managed volume, restart, then prune to `keep` copies. hostPath volumes
   * (locations the operator manages) are listed as skipped, never silently included.
   */
  async function backup({ id, keep = 5 }, { progress = null } = {}) {
    const manifest = await ensureManifest(id);
    const state = await readState(id);
    if (!state) throw new Error(`${manifest.name} has no data to back up`);
    if (keep !== null && (!Number.isInteger(keep) || keep < 1 || keep > 30)) throw new Error("keep must be a whole number between 1 and 30");
    const directory = dirFor(id);
    const contents = ["boxpilot.json"];
    for (const name of ["compose.yaml", ".env"]) { try { await stat(path.join(directory, name)); contents.push(name); } catch { /* uninstalled apps have no compose.yaml */ } }
    const skippedHostPaths = [];
    for (const volume of manifest.volumes) {
      if (!volume.backup) continue;
      if (volume.path) { try { await stat(path.join(directory, volume.path)); contents.push(volume.path); } catch { /* volume directory not created yet */ } }
      else if (volume.hostPath) skippedHostPaths.push(volume.hostPath);
    }
    const status = await containerStatus(id);
    const wasRunning = status.running;
    const started = clock().getTime();
    if (wasRunning) {
      progress?.(`Stopping ${manifest.name} for a consistent backup...`, "stdout");
      const stop = await compose(id, ["stop"], { timeout: 120_000, progress });
      if (!stop.ok) throw new Error(`docker compose stop failed: ${redact(stop.stderr).split("\n").slice(-3).join(" ")}`);
    }
    const stamp = clock().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
    const backupDirectory = backupDirFor(id);
    const artifact = path.join(backupDirectory, `${stamp}.tar.gz`);
    let downtimeMs = null;
    try {
      await mkdir(backupDirectory, { recursive: true, mode: 0o700 });
      progress?.(`$ tar -czf ${stamp}.tar.gz ${contents.join(" ")}`, "stdout");
      const archive = await runCommand(tarBinary, ["-czf", artifact, "-C", directory, ...contents], { timeout: 60 * 60_000, maxBuffer: 4 * 1024 * 1024 });
      if (!archive.ok) throw new Error(`tar failed: ${archive.stderr.split("\n").slice(-2).join(" ")}`);
    } catch (error) {
      await rm(artifact, { force: true }).catch(() => {});
      if (wasRunning) await compose(id, ["start"], { timeout: 180_000, progress }).catch(() => {});
      throw error;
    } finally {
      if (wasRunning) downtimeMs = clock().getTime() - started;
    }
    if (wasRunning) {
      const start = await compose(id, ["start"], { timeout: 180_000, progress });
      if (!start.ok) throw new Error(`The backup succeeded (${path.basename(artifact)}), but ${manifest.name} did not start again: ${redact(start.stderr).split("\n").slice(-3).join(" ")}`);
    }
    const [checksumSha256, artifactStat] = await Promise.all([sha256File(artifact), stat(artifact)]);
    const meta = { id, createdAt: clock().toISOString(), artifact: path.basename(artifact), checksumSha256, sizeBytes: artifactStat.size, downtimeMs, contents, skippedHostPaths, image: state.image?.reference ?? null };
    await writeFile(path.join(backupDirectory, `${stamp}.json`), JSON.stringify(meta, null, 2), { mode: 0o600 });
    let pruned = [];
    if (keep !== null) {
      const names = (await readdir(backupDirectory)).filter((name) => backupNamePattern.test(name)).sort().reverse();
      pruned = names.slice(keep);
      for (const name of pruned) {
        await rm(path.join(backupDirectory, name), { force: true });
        await rm(path.join(backupDirectory, name.replace(/\.tar\.gz$/, ".json")), { force: true });
      }
    }
    progress?.(`Backup ${meta.artifact} written (${meta.sizeBytes} bytes)${pruned.length ? `; pruned ${pruned.length} old cop${pruned.length === 1 ? "y" : "ies"}` : ""}`, "stdout");
    return { backedUp: true, ...meta, pruned };
  }

  /** Backups on disk for one app, newest first. The filesystem is the source of truth. */
  async function listAppBackups({ id }) {
    await ensureManifest(id);
    const backupDirectory = backupDirFor(id);
    let names = [];
    try { names = (await readdir(backupDirectory)).filter((name) => backupNamePattern.test(name)).sort().reverse(); } catch { names = []; }
    const backups = [];
    for (const name of names) {
      let meta = null;
      try { meta = JSON.parse(await readFile(path.join(backupDirectory, name.replace(/\.tar\.gz$/, ".json")), "utf8")); } catch { meta = null; }
      const artifactStat = await stat(path.join(backupDirectory, name)).catch(() => null);
      backups.push({ artifact: name, createdAt: meta?.createdAt ?? artifactStat?.mtime?.toISOString() ?? null, sizeBytes: meta?.sizeBytes ?? artifactStat?.size ?? null, checksumSha256: meta?.checksumSha256 ?? null, downtimeMs: meta?.downtimeMs ?? null, skippedHostPaths: meta?.skippedHostPaths ?? [], image: meta?.image ?? null });
    }
    return { id, directory: backupDirectory, backups };
  }

  /** Restore a backup over the app directory: checksum check, safety backup, stop, extract, start. */
  async function restoreAppBackup({ id, backup: backupName }, { progress = null } = {}) {
    const manifest = await ensureManifest(id);
    if (typeof backupName !== "string" || !backupNamePattern.test(backupName)) throw new Error("Backup name is invalid");
    const backupDirectory = backupDirFor(id);
    const artifact = path.join(backupDirectory, backupName);
    await stat(artifact).catch(() => { throw new Error(`Backup ${backupName} does not exist`); });
    let meta = null;
    try { meta = JSON.parse(await readFile(path.join(backupDirectory, backupName.replace(/\.tar\.gz$/, ".json")), "utf8")); } catch { meta = null; }
    if (meta?.checksumSha256) {
      progress?.("Verifying the backup checksum...", "stdout");
      const actual = await sha256File(artifact);
      if (actual !== meta.checksumSha256) throw new Error(`Backup ${backupName} failed its checksum; it may be damaged. Nothing was changed.`);
    }
    try {
      progress?.("Taking a safety backup of the current state first...", "stdout");
      const safety = await backup({ id, keep: null }, { progress });
      progress?.(`Current state saved as ${safety.artifact}`, "stdout");
    } catch (error) {
      progress?.(`Safety backup failed (${error.message}); continuing with the restore`, "stderr");
    }
    const status = await containerStatus(id);
    if (status.running) {
      const stop = await compose(id, ["stop"], { timeout: 120_000, progress });
      if (!stop.ok) throw new Error(`docker compose stop failed: ${redact(stop.stderr).split("\n").slice(-3).join(" ")}`);
    }
    await mkdir(dirFor(id), { recursive: true, mode: 0o700 });
    progress?.(`$ tar -xzf ${backupName}`, "stdout");
    const extract = await runCommand(tarBinary, ["-xzf", artifact, "-C", dirFor(id)], { timeout: 60 * 60_000, maxBuffer: 4 * 1024 * 1024 });
    if (!extract.ok) throw new Error(`tar extraction failed: ${extract.stderr.split("\n").slice(-2).join(" ")}. The safety backup above holds the pre-restore state.`);
    const up = await compose(id, ["up", "--detach", "--remove-orphans"], { timeout: 15 * 60_000, progress });
    if (!up.ok) throw new Error(`Restored the files, but docker compose up failed: ${redact(up.stderr).split("\n").slice(-4).join(" ")}`);
    const healthy = await waitHealthy(manifest, progress);
    return { restored: true, id, backup: backupName, image: healthy.image, health: healthy.health };
  }

  async function deleteAppBackup({ id, backup: backupName }) {
    await ensureManifest(id);
    if (typeof backupName !== "string" || !backupNamePattern.test(backupName)) throw new Error("Backup name is invalid");
    const backupDirectory = backupDirFor(id);
    await stat(path.join(backupDirectory, backupName)).catch(() => { throw new Error(`Backup ${backupName} does not exist`); });
    await rm(path.join(backupDirectory, backupName), { force: true });
    await rm(path.join(backupDirectory, backupName.replace(/\.tar\.gz$/, ".json")), { force: true });
    return { deleted: true, id, backup: backupName };
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

  return { inspect, install, uninstall, update, reconfigure, action, logs, config, secrets, backup, listAppBackups, restoreAppBackup, deleteAppBackup, checkUpdates, catalogRoot: root, internals: { containerStatus, waitHealthy, writeProject, readState, parseEnvFile } };
}
