/**
 * Generic application deployer (helper side, runs as root). One implementation for every catalog
 * manifest: install, uninstall, purge, update, reconfigure, start/stop/restart, inspect, logs.
 * Layout per app: <catalogRoot>/<id>/{compose.yaml,.env,boxpilot.json,<managed volume dirs>}.
 */
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { chown, mkdir, readFile, readdir, rename, rm, stat, writeFile, realpath } from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import { fixedRun } from "./exec.mjs";
import { parseServeStatus } from "./tailscale-serve.mjs";
import { createCatalogService } from "./catalog/index.mjs";
import { deviceMatchesPattern, renderCompose, projectNameFor, resolveDevices } from "./catalog/compose.mjs";
import { isDeniedHostPath } from "./catalog/schema.mjs";
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
    if (!match) continue;
    const raw = match[2];
    // Secrets are written single-quoted so Compose does not expand a dollar sign inside them;
    // \' is the one escape that form recognises. Files written before that are still unquoted.
    env[match[1]] = raw.startsWith("'") && raw.endsWith("'") && raw.length >= 2
      ? raw.slice(1, -1).replace(/\\'/g, () => "'")
      : raw;
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
  listDevices = (directory) => readdir(directory),
  chownDirectory = (target, uid, gid) => chown(target, uid, gid),
  tailscaleBinary = process.env.BOXPILOT_TAILSCALE_BINARY ?? "/usr/bin/tailscale",
} = {}) {
  const root = path.resolve(catalogRoot);
  const dirFor = (id) => path.join(root, id);
  /** Apps this process has installed or uninstalled: their containers are worth asking about even
   *  when no project directory remains, because a rollback that could not stop them removes it. */
  const recentlyTouched = new Set();
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

  /** Container status for many apps in one docker call; names that do not exist only add stderr noise. */
  async function containerStatuses(ids) {
    const absent = { exists: false, running: false, status: "absent", health: "none", restarts: 0, image: null, startedAt: null };
    const statuses = new Map(ids.map((id) => [id, absent]));
    if (!ids.length) return statuses;
    const format = '{"name":"{{.Name}}","running":{{.State.Running}},"status":"{{.State.Status}}","health":"{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}","restarts":{{.RestartCount}},"image":"{{.Image}}","startedAt":"{{.State.StartedAt}}"}';
    const inspected = await docker(["inspect", "--format", format, ...ids.map(projectNameFor)]);
    for (const line of String(inspected?.stdout ?? "").split("\n")) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line);
        const name = typeof parsed.name === "string" ? parsed.name.replace(/^\//, "") : null;
        const id = name ? ids.find((candidate) => projectNameFor(candidate) === name) : ids.length === 1 ? ids[0] : null;
        if (!id) continue;
        delete parsed.name;
        statuses.set(id, { exists: true, ...parsed });
      } catch { /* one malformed line does not hide the others */ }
    }
    return statuses;
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
      ...(manifest.setup ? { setup: values.setup ?? [] } : {}),
    };
  }

  /**
   * Run the manifest's setup choices (blocklists, plugins) inside the running container.
   * Commands are idempotent by contract, so every install and settings change re-applies the
   * chosen ones. Failures are reported, never fatal: the app itself is up.
   */
  async function applySetup(manifest, values, progress = null) {
    if (!manifest.setup) return null;
    const chosen = manifest.setup.choices.filter((choice) => (values.setup ?? []).includes(choice.id));
    const applied = []; const failed = [];
    for (const choice of chosen) {
      progress?.(`${manifest.setup.title}: ${choice.label}`, "stdout");
      const result = await compose(manifest.id, ["exec", "-T", choice.service ?? manifest.id, ...choice.exec], { timeout: 15 * 60_000 });
      if (result.ok) applied.push(choice.id);
      else { failed.push({ id: choice.id, error: redact(`${result.stderr}\n${result.stdout}`).trim().split("\n").filter(Boolean).slice(-2).join(" ") }); progress?.(`${choice.label} failed: ${failed.at(-1).error}`, "stderr"); }
    }
    if (manifest.setup.finalize && applied.length) {
      progress?.(manifest.setup.finalizeLabel ?? `${manifest.setup.title}: finishing`, "stdout");
      const result = await compose(manifest.id, ["exec", "-T", manifest.id, ...manifest.setup.finalize], { timeout: 15 * 60_000, progress });
      if (!result.ok) { failed.push({ id: "finalize", error: redact(`${result.stderr}\n${result.stdout}`).trim().split("\n").filter(Boolean).slice(-2).join(" ") }); progress?.(`${manifest.setup.finalizeLabel ?? "Finishing"} failed: ${failed.at(-1).error}`, "stderr"); }
    }
    return { applied, failed };
  }

  /** The uid/gid an app's container actually runs as, from `user:` or a PUID-style variable. */
  function effectiveOwner(manifest) {
    if (manifest.user) {
      const [uid, gid] = manifest.user.split(":").map((part) => Number.parseInt(part, 10));
      return Number.isInteger(uid) ? { uid, gid: Number.isInteger(gid) ? gid : uid } : null;
    }
    const number = (names) => {
      const entry = manifest.env.find((item) => names.includes(item.name));
      const value = Number.parseInt(entry?.default ?? "", 10);
      return Number.isInteger(value) ? value : null;
    };
    const uid = number(["PUID", "UID", "USER_UID", "PLEX_UID"]);
    return uid === null ? null : { uid, gid: number(["PGID", "GID", "USER_GID", "PLEX_GID"]) ?? uid };
  }

  async function writeProject(manifest, values, { existingEnv = {}, devices: provided = null } = {}) {
    const directory = dirFor(manifest.id);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    // Images that run as a fixed non-root user (declared with `user:`) must be able to write their
    // managed volumes, which the helper creates as root. Ownership is set on the directory only;
    // existing files are never touched.
    const owner = manifest.user ? manifest.user.split(":").map((part) => Number.parseInt(part, 10)) : null;
    for (const volume of manifest.volumes) {
      if (!volume.path) continue;
      const target = path.join(directory, volume.path);
      await mkdir(target, { recursive: true, mode: 0o755 });
      if (owner && Number.isInteger(owner[0])) await chownDirectory(target, owner[0], Number.isInteger(owner[1]) ? owner[1] : owner[0]).catch(() => {});
    }
    for (const sidecar of manifest.sidecars ?? []) for (const volume of sidecar.volumes) await mkdir(path.join(directory, volume.path), { recursive: true, mode: 0o755 });
    // A folder the app is pointed at may not exist yet. Docker would create it as root:root, and an
    // app that runs as a normal user (PUID, or a declared `user:`) then cannot write its own data —
    // the install looks fine and every download or upload fails. Create it ourselves and hand it over.
    // An existing folder is never touched: it is the owner's library, with their ownership.
    const runsAs = effectiveOwner(manifest);
    for (const volume of manifest.volumes) {
      const chosen = values.volumes?.[volume.id] ?? volume.hostPath;
      // Only folders meant to hold data: every system mount a manifest declares is on the deny list.
      if (!chosen || isDeniedHostPath(chosen)) continue;
      if (await stat(chosen).then(() => true, () => false)) continue;
      await mkdir(chosen, { recursive: true, mode: 0o755 }).catch(() => {});
      if (runsAs) await chownDirectory(chosen, runsAs.uid, runsAs.gid).catch(() => {});
    }
    for (const volume of manifest.volumes) {
      const hostPath = values.volumes?.[volume.id];
      // Only paths the owner changed are checked: the manifest's own mounts (e.g. the Docker socket, which
      // lives under /run) are curated and already carry the app's risk tier.
      if (!hostPath || hostPath === volume.hostPath) continue;
      const real = await realpath(hostPath).catch(() => hostPath);
      if (isDeniedHostPath(real)) throw new Error(`${hostPath} resolves to ${real}, a protected system location; pick a folder under /srv, /mnt, /media, or your home`);
    }
    // The web process resolves device globs against the real /dev (this process may run without one); only paths matching the manifest are accepted.
    const devices = Array.isArray(provided)
      ? [...new Set(provided.filter((device) => manifest.devices.some((pattern) => deviceMatchesPattern(device, pattern))))]
      : await resolveDevices(manifest.devices, listDevices);
    if (manifest.devices.some((pattern) => /[?*[]/.test(pattern)) && !devices.length) throw new Error(`${manifest.name} needs a device matching ${manifest.devices.join(", ")} and none exists on this server`);
    const rendered = renderCompose(manifest, values, { existingEnv, lanAddress, devices });
    await writeFile(path.join(directory, ".env.tmp"), rendered.envFile, { mode: 0o600 });
    await rename(path.join(directory, ".env.tmp"), path.join(directory, ".env"));
    await writeFile(path.join(directory, "compose.yaml.tmp"), rendered.composeYaml, { mode: 0o600 });
    await rename(path.join(directory, "compose.yaml.tmp"), path.join(directory, "compose.yaml"));
    return rendered;
  }

  /**
   * One application's public shape. `known` lets a caller that has already established there is no
   * project directory skip both the state read and the container lookup.
   */
  async function describe(manifest, status = null, known = undefined) {
    const state = known ? known.state : await readState(manifest.id);
    if (!status && !known) status = await containerStatus(manifest.id);
    if (!status) status = { exists: false, running: false, status: "absent", health: "none", restarts: 0, image: null, startedAt: null };
    return {
      id: manifest.id,
      installed: Boolean(state && state.installed),
      dataPresent: Boolean(state),
      state: state ? { installedAt: state.installedAt, updatedAt: state.updatedAt, manifestSha256: state.manifestSha256, image: state.image, values: { ports: state.values?.ports ?? {}, env: state.values?.env ?? {}, volumes: state.values?.volumes ?? {}, setup: Array.isArray(state.values?.setup) ? state.values.setup : [] }, pinnedRollback: state.pinnedRollback ?? false, uninstalledAt: state.uninstalledAt ?? null } : null,
      container: status,
      urls: state && state.installed ? manifest.ports.filter((port) => port.protocol === "tcp").map((port) => ({ id: port.id, label: port.label, host: state.values?.ports?.[port.id] ?? port.host, exposure: port.exposure })) : [],
      updateAvailable: Boolean(state?.installed && state.image?.reference && state.image.reference !== manifest.image.reference),
      installedImage: state?.image?.reference ?? null,
    };
  }

  /**
   * App ids with a project directory, or null when the catalog root itself could not be read —
   * which is not the same as "nothing is installed" and must not be reported as such.
   */
  async function presentIds() {
    try {
      const entries = await readdir(root, { withFileTypes: true });
      return new Set(entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name));
    } catch (error) {
      if (error.code === "ENOENT") return new Set(); // nothing installed yet: a genuine empty set
      return null;
    }
  }

  async function inspect({ id = null } = {}) {
    const { manifests, problems } = await catalog.all();
    const selected = id ? manifests.filter((manifest) => manifest.id === id) : manifests;
    // One readdir tells us which of the 128 apps could possibly be installed. Without it this read
    // 128 state files (125 of them missing) and asked Docker about 128 container names that do not
    // exist — on every Overview load, three times over.
    const present = await presentIds();
    // A rollback that could not stop its containers removes the project directory anyway, so
    // "no directory" is not proof that nothing is running. The container lookup is one call for
    // any number of names, so ask about the recently-touched ids too.
    const known = present === null ? null : new Set([...present, ...recentlyTouched]);
    const candidates = known === null ? selected : selected.filter((manifest) => known.has(manifest.id));
    const statuses = await containerStatuses(candidates.map((manifest) => manifest.id));
    const described = await Promise.all(selected.map((manifest) => (known === null || known.has(manifest.id)
      ? describe(manifest, statuses.get(manifest.id))
      : describe(manifest, undefined, { state: null }))));
    const readProblems = present === null ? [...problems, { file: root, errors: ["The application directory could not be read, so installed state is unknown"] }] : problems;
    return { applications: described, problems: readProblems, catalogRoot: root };
  }

  async function install({ id, values: rawValues = {}, devices = null }, { progress = null } = {}) {
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
    const rendered = await writeProject(manifest, values, { existingEnv: await readEnv(id), devices });
    const up = await compose(id, ["up", "--detach", "--remove-orphans"], { timeout: 15 * 60_000, progress });
    try {
      if (!up.ok) throw new Error(`docker compose up failed: ${redact(up.stderr).split("\n").slice(-4).join(" ")}`);
      const status = await waitHealthy(manifest, progress);
      progress?.(`${manifest.name} is up`, "stdout");
      await writeState(id, { id, installed: true, installedAt: clock().toISOString(), updatedAt: clock().toISOString(), manifestSha256: manifest.sha256 ?? null, image: { reference: manifest.image.reference, id: status.image }, values: storableValues(manifest, values, rendered.env), pinnedRollback: false });
      const setup = await applySetup(manifest, values, progress);
      await refreshHomepage(id, progress);
      return { installed: true, id, name: manifest.name, image: status.image, hostPorts: rendered.hostPorts, health: status.health, secretsGenerated: manifest.env.filter((entry) => entry.generate).map((entry) => entry.name), setup };
    } catch (error) {
      progress?.(`Install failed: ${error.message}. Rolling back...`, "stderr");
      await compose(id, ["down", "--remove-orphans"], { timeout: 120_000, progress }).catch(() => {});
      recentlyTouched.add(id);
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
      await refreshHomepage(id, progress);
      return { uninstalled: true, purged: true, id, dataRemoved: true };
    }
    await writeState(id, { ...(state ?? { id }), installed: false, uninstalledAt: clock().toISOString() });
    await rm(path.join(dirFor(id), "compose.yaml"), { force: true });
    await refreshHomepage(id, progress);
    return { uninstalled: true, purged: false, id, dataRemoved: false, dataDirectory: dirFor(id) };
  }

  /**
   * Pre-change checkpoint (M6.7): an ordinary app backup taken right before an update, a
   * settings change, or a compose edit, so the change can be undone from the card's Restore.
   * Only managed volumes flagged for backup are archived (config-sized, not media libraries).
   */
  async function checkpoint({ id, reason }, { progress = null } = {}) {
    progress?.(`Checkpoint before ${reason}: backing up current data first`, "stdout");
    const result = await backup({ id, keep: 5 }, { progress });
    return { artifact: result.artifact, checksumSha256: result.checksumSha256, sizeBytes: result.sizeBytes, downtimeMs: result.downtimeMs };
  }

  async function update({ id, devices = null }, { progress = null, checkpoint: takeCheckpoint = true } = {}) {
    const manifest = await ensureManifest(id);
    const state = await readState(id);
    if (!state?.installed) throw new Error(`${manifest.name} is not installed`);
    const before = await containerStatus(id);
    // A catalog release can move a sidecar's tag too (a database major version, say). Rolling back
    // only the app image would leave the new database refusing the old data directory, while the
    // rollback reported success.
    const beforeSidecars = {};
    for (const sidecar of manifest.sidecars ?? []) {
      const status = await containerStatus(`${id}-${sidecar.id}`).catch(() => null);
      if (status?.image) beforeSidecars[sidecar.id] = status.image;
    }
    // Stored state may predate the current manifest (or older releases stored values the
    // operator could not change); keep only what the manifest accepts today.
    const { values, errors } = resolveValues(manifest, sanitizeStoredValues(manifest, state.values ?? {}));
    if (errors.length) throw new Error(`Stored settings no longer match the manifest: ${errors.join("; ")}`);
    const saved = takeCheckpoint ? await checkpoint({ id, reason: "update" }, { progress }) : null;
    await writeProject(manifest, values, { existingEnv: await readEnv(id), devices }); // picks up manifest changes (new image tag)
    const pull = await compose(id, ["pull"], { timeout: 30 * 60_000, progress });
    if (!pull.ok) throw new Error(`docker compose pull failed: ${redact(pull.stderr).split("\n").slice(-3).join(" ")}`);
    const up = await compose(id, ["up", "--detach", "--remove-orphans"], { timeout: 15 * 60_000, progress });
    try {
      if (!up.ok) throw new Error(`docker compose up failed: ${redact(up.stderr).split("\n").slice(-4).join(" ")}`);
      const status = await waitHealthy(manifest, progress);
      await writeState(id, { ...state, updatedAt: clock().toISOString(), manifestSha256: manifest.sha256 ?? null, image: { reference: manifest.image.reference, id: status.image }, values: storableValues(manifest, values, values.env), pinnedRollback: false });
      return { updated: true, id, previousImage: before.image, image: status.image, changed: before.image !== status.image, checkpoint: saved };
    } catch (error) {
      let rolledBack = false;
      if (before.image) {
        const pinned = {
          ...manifest,
          image: { ...manifest.image, reference: before.image },
          sidecars: (manifest.sidecars ?? []).map((sidecar) => (beforeSidecars[sidecar.id] ? { ...sidecar, image: beforeSidecars[sidecar.id] } : sidecar)),
        };
        await writeProject(pinned, values, { existingEnv: await readEnv(id), devices }).catch(() => {});
        progress?.(`Update failed: ${error.message}. Restoring previous image...`, "stderr");
        const rollback = await compose(id, ["up", "--detach", "--remove-orphans"], { timeout: 10 * 60_000, progress });
        rolledBack = rollback.ok;
        if (rolledBack) await writeState(id, { ...state, pinnedRollback: true, image: { reference: before.image, id: before.image } }).catch(() => {});
      }
      throw new Error(`${manifest.name} update failed${rolledBack ? "; the previous image was restored" : " and automatic rollback also failed"}. ${error.message}`);
    }
  }

  async function reconfigure({ id, values: rawValues = {}, devices = null }, { progress = null, checkpoint: takeCheckpoint = true } = {}) {
    const manifest = await ensureManifest(id);
    const state = await readState(id);
    if (!state?.installed) throw new Error(`${manifest.name} is not installed`);
    const { values, errors } = resolveValues(manifest, rawValues);
    if (errors.length) throw new Error(`Invalid settings: ${errors.join("; ")}`);
    const saved = takeCheckpoint ? await checkpoint({ id, reason: "settings change" }, { progress }) : null;
    const previousCompose = await readFile(path.join(dirFor(id), "compose.yaml"), "utf8").catch(() => null);
    const previousEnv = await readFile(path.join(dirFor(id), ".env"), "utf8").catch(() => "");
    const rendered = await writeProject(manifest, values, { existingEnv: parseEnvFile(previousEnv), devices });
    const up = await compose(id, ["up", "--detach", "--remove-orphans"], { timeout: 15 * 60_000, progress });
    try {
      if (!up.ok) throw new Error(`docker compose up failed: ${redact(up.stderr).split("\n").slice(-4).join(" ")}`);
      await waitHealthy(manifest, progress);
      await writeState(id, { ...state, updatedAt: clock().toISOString(), values: storableValues(manifest, values, rendered.env) });
      const setup = await applySetup(manifest, values, progress);
      return { reconfigured: true, id, hostPorts: rendered.hostPorts, checkpoint: saved, setup };
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

  /**
   * Power-user escape hatch: replace the app's compose.yaml verbatim. Validated with
   * `docker compose config`, applied with rollback to the previous file on failure.
   * The next Settings change or Update regenerates the file from the manifest.
   */
  async function editCompose({ id, compose: composeText }, { progress = null, checkpoint: takeCheckpoint = true } = {}) {
    const manifest = await ensureManifest(id);
    const state = await readState(id);
    if (!state?.installed) throw new Error(`${manifest.name} is not installed`);
    if (typeof composeText !== "string" || !composeText.trim() || composeText.length > 65536) throw new Error("Compose text must be a non-empty string under 64 KB");
    let parsed;
    try { parsed = YAML.parse(composeText); } catch (parseError) { throw new Error(`Not valid YAML: ${parseError.message}`); }
    if (!parsed || typeof parsed !== "object" || !parsed.services || typeof parsed.services !== "object") throw new Error("The compose file must define services");
    const target = path.join(dirFor(id), "compose.yaml");
    const previous = await readFile(target, "utf8").catch(() => null);
    if (previous === null) throw new Error("There is no compose.yaml to edit");
    const saved = takeCheckpoint ? await checkpoint({ id, reason: "compose edit" }, { progress }) : null;
    await writeFile(target, composeText, { mode: 0o600 });
    const check = await compose(id, ["config", "--quiet"], { timeout: 60_000, progress });
    if (!check.ok) {
      await writeFile(target, previous, { mode: 0o600 });
      throw new Error(`docker compose rejected the file; the previous one was restored: ${redact(check.stderr).split("\n").slice(-3).join(" ")}`);
    }
    const up = await compose(id, ["up", "--detach", "--remove-orphans"], { timeout: 15 * 60_000, progress });
    try {
      if (!up.ok) throw new Error(`docker compose up failed: ${redact(up.stderr).split("\n").slice(-4).join(" ")}`);
      await waitHealthy(manifest, progress);
      await writeState(id, { ...state, updatedAt: clock().toISOString(), rawEdited: true });
      return { edited: true, id, rawEdited: true, checkpoint: saved };
    } catch (error) {
      progress?.(`Edit failed: ${error.message}. Restoring the previous compose file...`, "stderr");
      await writeFile(target, previous, { mode: 0o600 });
      const rolledBack = (await compose(id, ["up", "--detach", "--remove-orphans"], { timeout: 10 * 60_000, progress })).ok;
      throw new Error(`${manifest.name} rejected the edited compose file${rolledBack ? "; the previous one was restored" : " and automatic rollback also failed"}. ${error.message}`);
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
  const homepageGroup = "BoxPilot";
  const homepageHostPattern = /^[A-Za-z0-9][A-Za-z0-9.-]{0,252}$/;

  /**
   * M8.2: write a "BoxPilot" group into Homepage's services.yaml listing every installed
   * catalog app (link, description, dashboard icon, live container status through the
   * read-only Docker socket Homepage already mounts). Other groups the operator wrote are
   * kept. `host` is what the browser should use to reach this server; it is remembered so
   * installs and uninstalls can refresh the dashboard without asking again.
   */
  /** Local ports Tailscale Serve publishes over HTTPS right now; empty when Tailscale is absent. */
  async function servedPorts() {
    const result = await runCommand(tailscaleBinary, ["serve", "status", "--json"], { timeout: 15_000, maxBuffer: 2 * 1024 * 1024 }).catch(() => ({ ok: false, stdout: "" }));
    return new Set(result.ok ? parseServeStatus(result.stdout).map((entry) => entry.port) : []);
  }

  async function syncHomepage({ host } = {}, { progress = null } = {}) {
    const homepage = await catalog.get("homepage");
    if (!homepage) throw new Error("Homepage is not in the catalog");
    const homepageState = await readState("homepage");
    if (!homepageState?.installed) throw new Error("Homepage is not installed");
    const rememberedPath = path.join(dirFor("homepage"), "boxpilot-homepage-sync.json");
    const remembered = await readFile(rememberedPath, "utf8").then(JSON.parse).catch(() => null);
    const linkHost = host ?? remembered?.host ?? null;
    if (typeof linkHost !== "string" || !homepageHostPattern.test(linkHost)) throw new Error("A host name or address for the dashboard links is required");
    const configDirectory = path.join(dirFor("homepage"), "config");
    const tailnetHost = /\.ts\.net$/i.test(linkHost);
    const served = tailnetHost ? await servedPorts() : new Set();
    const { manifests } = await catalog.all();
    const entries = [];
    for (const manifest of manifests) {
      if (manifest.id === "homepage") continue;
      const state = await readState(manifest.id);
      if (!state?.installed) continue;
      const port = manifest.ports.find((entry) => entry.protocol === "tcp") ?? null;
      const hostPort = port ? state.values?.ports?.[port.id] ?? port.host : null;
      // A loopback app answers on the server itself only. Tailscale Serve is how it is meant to be
      // reached, so link the HTTPS address when it is published and the dashboard is being read on
      // the tailnet; otherwise say where it lives rather than offering an address that fails in the
      // reader's browser.
      const loopback = port?.exposure === "loopback";
      const publishedOnTailnet = loopback && tailnetHost && served.has(Number(hostPort));
      const href = port ? (loopback ? (publishedOnTailnet ? `https://${linkHost}:${hostPort}` : null) : `http://${linkHost}:${hostPort}`) : null;
      const description = loopback && !publishedOnTailnet ? `${manifest.description} (on the server itself, at 127.0.0.1:${hostPort} — publish it with Serve to reach it from elsewhere)` : manifest.description;
      entries.push({ [manifest.name]: { ...(href ? { href } : {}), description, icon: `${manifest.id}.png`, server: "boxpilot", container: projectNameFor(manifest.id) } });
    }
    await mkdir(configDirectory, { recursive: true });
    const servicesPath = path.join(configDirectory, "services.yaml");
    let existing = [];
    try { const parsed = YAML.parse(await readFile(servicesPath, "utf8")); if (Array.isArray(parsed)) existing = parsed; } catch { existing = []; }
    const kept = existing.filter((group) => !(group && typeof group === "object" && Object.keys(group)[0] === homepageGroup));
    const services = [{ [homepageGroup]: entries }, ...kept];
    const pending = `${servicesPath}.${randomUUID()}.tmp`;
    await writeFile(pending, `# The "${homepageGroup}" group is managed by BoxPilot and rewritten on every sync; other groups are kept.\n${YAML.stringify(services)}`, { mode: 0o644 });
    // Replace in one step: a truncating write can leave torn YAML that the next sync would discard.
    await rename(pending, servicesPath);
    const dockerPath = path.join(configDirectory, "docker.yaml");
    try { await stat(dockerPath); } catch { await writeFile(dockerPath, "boxpilot:\n  socket: /var/run/docker.sock\n", { mode: 0o644 }); }
    await writeFile(rememberedPath, JSON.stringify({ host: linkHost, syncedAt: clock().toISOString() }), { mode: 0o600 });
    progress?.(`Homepage now lists ${entries.length} installed app(s) in its ${homepageGroup} group`, "stdout");
    return { synced: true, services: entries.length, groupsKept: kept.length, host: linkHost };
  }

  /** Best-effort dashboard refresh after an install or uninstall; never fails the main job. */
  async function refreshHomepage(changedId, progress) {
    if (changedId === "homepage") return;
    try {
      const state = await readState("homepage");
      if (!state?.installed) return;
      await syncHomepage({}, { progress });
    } catch (error) {
      progress?.(`Homepage dashboard not refreshed: ${error.message}`, "stderr");
    }
  }

  async function backup({ id, keep = 5 }, { progress = null } = {}) {
    const manifest = await ensureManifest(id);
    const state = await readState(id);
    if (!state) throw new Error(`${manifest.name} has no data to back up`);
    if (keep !== null && (!Number.isInteger(keep) || keep < 1 || keep > 30)) throw new Error("keep must be a whole number between 1 and 30");
    const directory = dirFor(id);
    const contents = ["boxpilot.json"];
    for (const name of ["compose.yaml", ".env"]) { try { await stat(path.join(directory, name)); contents.push(name); } catch { /* uninstalled apps have no compose.yaml */ } }
    const skippedHostPaths = [];
    const skippedVolumes = [];
    for (const volume of manifest.volumes) {
      // Anything not going into the archive is recorded, so the owner is told what a backup leaves out
      // — whether it is a folder they chose or a volume the manifest does not archive.
      if (!volume.backup || !volume.path) {
        if (volume.hostPath) skippedHostPaths.push(volume.hostPath);
        else if (volume.path) skippedVolumes.push(volume.label ?? volume.id);
        continue;
      }
      try { await stat(path.join(directory, volume.path)); contents.push(volume.path); } catch { /* volume directory not created yet */ }
    }
    for (const sidecar of manifest.sidecars ?? []) {
      for (const volume of sidecar.volumes) {
        if (!volume.backup) continue;
        try { await stat(path.join(directory, volume.path)); contents.push(volume.path); } catch { /* not created yet */ }
      }
    }
    const status = await containerStatus(id);
    const wasRunning = status.running;
    const started = clock().getTime();
    if (wasRunning) {
      progress?.(`Stopping ${manifest.name} for a consistent backup...`, "stdout");
      const stop = await compose(id, ["stop"], { timeout: 120_000, progress });
      if (!stop.ok) throw new Error(`docker compose stop failed: ${redact(stop.stderr).split("\n").slice(-3).join(" ")}`);
    }
    const backupDirectory = backupDirFor(id);
    // Names are second-granular; a checkpoint followed by a restore's safety copy can land in
    // the same second, so step forward until the name is free instead of overwriting.
    let stamp = null; let artifact = null;
    for (let offset = 0; offset < 120; offset += 1) {
      stamp = new Date(clock().getTime() + offset * 1000).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
      artifact = path.join(backupDirectory, `${stamp}.tar.gz`);
      if (!(await stat(artifact).then(() => true, () => false))) break;
      if (offset === 119) throw new Error("Could not find a free backup name");
    }
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
    const meta = { id, createdAt: clock().toISOString(), artifact: path.basename(artifact), checksumSha256, sizeBytes: artifactStat.size, downtimeMs, contents, skippedVolumes, skippedHostPaths, image: state.image?.reference ?? null };
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
  /**
   * How many backups each app has, from one walk of the backup root. The recovery kit needs only
   * the counts, and asking per app cost a helper round trip and a directory walk each.
   */
  async function countAppBackups() {
    const backupRootPath = path.resolve(backupRoot);
    let entries;
    try {
      entries = await readdir(backupRootPath, { withFileTypes: true });
    } catch (error) {
      // A root that does not exist yet genuinely holds nothing; one that cannot be read is
      // unknown, and reporting it as zero would tell the owner every app is unprotected.
      if (error.code !== "ENOENT") return { available: false, counts: {}, reason: error.message };
      entries = [];
    }
    const counts = {};
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const names = await readdir(path.join(backupRootPath, entry.name)).catch(() => []);
      counts[entry.name] = names.filter((name) => backupNamePattern.test(name)).length;
    }
    return { available: true, counts };
  }

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
      backups.push({ artifact: name, createdAt: meta?.createdAt ?? artifactStat?.mtime?.toISOString() ?? null, sizeBytes: meta?.sizeBytes ?? artifactStat?.size ?? null, checksumSha256: meta?.checksumSha256 ?? null, downtimeMs: meta?.downtimeMs ?? null, skippedHostPaths: meta?.skippedHostPaths ?? [], skippedVolumes: meta?.skippedVolumes ?? [], image: meta?.image ?? null });
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
    // Extract beside the app and swap, so the result is the backup and nothing else. Unpacking over
    // the live directory would leave every file written since — for a database that means old control
    // files next to newer WAL segments, which is neither the backup nor the present state.
    const live = dirFor(id);
    const staged = `${live}.restoring`;
    const displaced = `${live}.replaced`;
    await rm(staged, { recursive: true, force: true });
    await rm(displaced, { recursive: true, force: true });
    await mkdir(staged, { recursive: true, mode: 0o700 });
    progress?.(`$ tar -xzf ${backupName}`, "stdout");
    const extract = await runCommand(tarBinary, ["-xzf", artifact, "-C", staged], { timeout: 60 * 60_000, maxBuffer: 4 * 1024 * 1024 });
    if (!extract.ok) {
      await rm(staged, { recursive: true, force: true });
      throw new Error(`tar extraction failed: ${extract.stderr.split("\n").slice(-2).join(" ")}. Nothing was replaced; the safety backup above holds the pre-restore state.`);
    }
    if (await stat(live).then(() => true, () => false)) await rename(live, displaced);
    try {
      await rename(staged, live);
    } catch (error) {
      // Put the app back exactly as it was rather than leaving it with no directory at all.
      if (await stat(displaced).then(() => true, () => false)) await rename(displaced, live).catch(() => {});
      await rm(staged, { recursive: true, force: true });
      throw new Error(`Could not swap in the restored files (${error.message}); the app was left as it was.`);
    }
    await rm(displaced, { recursive: true, force: true });
    const up = await compose(id, ["up", "--detach", "--remove-orphans"], { timeout: 15 * 60_000, progress });
    if (!up.ok) throw new Error(`Restored the files, but docker compose up failed: ${redact(up.stderr).split("\n").slice(-4).join(" ")}`);
    const healthy = await waitHealthy(manifest, progress);
    return { restored: true, id, backup: backupName, image: healthy.image, health: healthy.health };
  }

  function backupArtifactFor(id, backupName) {
    if (typeof backupName !== "string" || !backupNamePattern.test(backupName)) throw new Error("Backup name is invalid");
    return { backupDirectory: backupDirFor(id), artifact: path.join(backupDirFor(id), backupName) };
  }

  /** `tar -tzv` listing of one backup: relative path, size, and kind. Capped so a huge archive cannot flood the UI. */
  async function listAppBackupFiles({ id, backup: backupName, limit = 5000 }) {
    await ensureManifest(id);
    const { artifact } = backupArtifactFor(id, backupName);
    await stat(artifact).catch(() => { throw new Error(`Backup ${backupName} does not exist`); });
    const listing = await runCommand(tarBinary, ["-tzvf", artifact], { timeout: 10 * 60_000, maxBuffer: 64 * 1024 * 1024 });
    if (!listing.ok) throw new Error(`Could not read the archive: ${listing.stderr.split("\n").slice(-2).join(" ")}`);
    const files = [];
    // GNU tar: "mode owner/group size YYYY-MM-DD HH:MM name"; bsdtar: "mode links owner group size Mon DD HH:MM|YYYY name".
    const gnu = /^([-dlcbps][rwxsStT-]{9})\s+\S+\s+(\d+)\s+\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}(?::\d{2})?\s+(.+)$/;
    const bsd = /^([-dlcbps][rwxsStT-]{9})\s+\d+\s+\S+\s+\S+\s+(\d+)\s+[A-Za-z]{3}\s+\d{1,2}\s+(?:\d{2}:\d{2}|\d{4})\s+(.+)$/;
    for (const line of listing.stdout.split("\n")) {
      const match = line.match(gnu) ?? line.match(bsd);
      if (!match) continue;
      const relative = match[3].replace(/ -> .*$/, "").replace(/^\.\//, "").replace(/\/$/, "");
      if (!relative || relative === ".") continue;
      files.push({ path: relative, sizeBytes: Number(match[2]), type: match[1].startsWith("d") ? "directory" : match[1].startsWith("l") ? "link" : "file" });
      if (files.length >= limit) break;
    }
    return { id, backup: backupName, files, truncated: files.length >= limit };
  }

  /** Restore one path (file or directory) from a backup after a checkpoint; everything else stays as it is. */
  async function restoreAppBackupPath({ id, backup: backupName, path: relativePath }, { progress = null } = {}) {
    const manifest = await ensureManifest(id);
    const { backupDirectory, artifact } = backupArtifactFor(id, backupName);
    if (typeof relativePath !== "string" || !relativePath || relativePath.startsWith("/") || relativePath.split("/").some((part) => part === "" || part === "." || part === "..")) throw new Error("Path must be a relative path inside the backup");
    const listing = await listAppBackupFiles({ id, backup: backupName, limit: 200_000 });
    const member = listing.files.find((entry) => entry.path === relativePath);
    if (!member) throw new Error(`${relativePath} is not in ${backupName}`);
    let meta = null;
    try { meta = JSON.parse(await readFile(path.join(backupDirectory, backupName.replace(/\.tar\.gz$/, ".json")), "utf8")); } catch { meta = null; }
    if (meta?.checksumSha256) {
      progress?.("Verifying the backup checksum...", "stdout");
      if ((await sha256File(artifact)) !== meta.checksumSha256) throw new Error(`Backup ${backupName} failed its checksum; it may be damaged. Nothing was changed.`);
    }
    const saved = await checkpoint({ id, reason: "file restore" }, { progress });
    const status = await containerStatus(id);
    if (status.running) {
      const stop = await compose(id, ["stop"], { timeout: 120_000, progress });
      if (!stop.ok) throw new Error(`docker compose stop failed: ${redact(stop.stderr).split("\n").slice(-3).join(" ")}`);
    }
    try {
      progress?.(`$ tar -xzf ${backupName} ${relativePath}`, "stdout");
      const extract = await runCommand(tarBinary, ["-xzf", artifact, "-C", dirFor(id), relativePath], { timeout: 60 * 60_000, maxBuffer: 4 * 1024 * 1024 });
      if (!extract.ok) throw new Error(`tar extraction failed: ${extract.stderr.split("\n").slice(-2).join(" ")}. The checkpoint ${saved.artifact} holds the pre-restore state.`);
    } finally {
      if (status.running) {
        const start = await compose(id, ["start"], { timeout: 180_000, progress });
        if (!start.ok) progress?.(`${manifest.name} did not start again: ${redact(start.stderr).split("\n").slice(-2).join(" ")}`, "stderr");
      }
    }
    return { restored: true, id, backup: backupName, path: relativePath, type: member.type, sizeBytes: member.sizeBytes, checkpoint: saved };
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

  return { syncHomepage, inspect, countAppBackups, install, uninstall, update, reconfigure, action, logs, config, editCompose, secrets, backup, listAppBackups, restoreAppBackup, listAppBackupFiles, restoreAppBackupPath, deleteAppBackup, checkUpdates, catalogRoot: root, internals: { containerStatus, waitHealthy, writeProject, readState, parseEnvFile } };
}
