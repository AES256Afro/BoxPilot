/**
 * Generic application deployer (helper side, runs as root). One implementation for every catalog
 * manifest: install, uninstall, purge, update, reconfigure, start/stop/restart, inspect, logs.
 * Layout per app: <catalogRoot>/<id>/{compose.yaml,.env,boxpilot.json,<managed volume dirs>}.
 */
import { constants as fsConstants } from "node:fs";
import { lchown, lstat, mkdir, open, readdir, rm, stat, realpath } from "node:fs/promises";
import { freeBytesOf as freeBytesOnDisk } from "./archive-expansion.mjs";
import path from "node:path";
import YAML from "yaml";
import { mkdirWithoutFollowing, readFileWithoutFollowing, replaceFileWithoutFollowing } from "./durable-file.mjs";
import { fixedRun } from "./exec.mjs";
import { parseServeStatus } from "./tailscale-serve.mjs";
import { createCatalogService } from "./catalog/index.mjs";
import { parseExit, parseForwardedPort } from "./vpn-exit.mjs";
import { bindingFor, deployedImages, deviceMatchesPattern, hostNetworkPorts, publishedPorts, renderCompose, projectNameFor, resolveDevices, usesTailnetHost, wantsGpu } from "./catalog/compose.mjs";
import { coversEveryAddress, findPortConflicts, holderWords, normalizeBind, portHolders, serveTargetPort, serveUrl } from "./ports.mjs";
import { createNvidiaInspector } from "./nvidia.mjs";
import { isDeniedHostPath } from "./catalog/schema.mjs";
import { measurableFolders, mountFor } from "./app-data-growth.mjs";
import { keepsBackupData, resolveValues, sanitizeStoredValues } from "./catalog/schema.mjs";
import { profileConnectionEnv, profileSecurityEnv } from "./vpn-profile.mjs";
import { dataScanCommand } from "./scan-resources.mjs";
import { shared } from "./cache.mjs";
import { formatDuration, keepTimeout, timedOut } from "./timeouts.mjs";
import { catalogImagePin, createAppBackups } from "./app-backups.mjs";
import { imageRepository } from "./catalog/compose-review.mjs";
export { catalogImagePin };
import { createAppHomepage } from "./app-homepage.mjs";
import { createAppModels } from "./app-models.mjs";
import { createForeignProjects } from "./app-foreign-projects.mjs";

/**
 * A job given more time (M30.3) runs with `timeScale` above 1: its budget over the operation's
 * normal one. The limits of the steps that download - the ones more time actually helps - grow by
 * the same factor, or the larger budget would only let the job wait longer for the same step to
 * give up. Bounded here too, whatever the caller passes.
 */
const scaled = (ms, timeScale = 1) => Math.round(ms * (Number.isFinite(timeScale) && timeScale > 1 ? Math.min(timeScale, 16) : 1));

/** A compose or exec step that hit its own limit is a timeout, not a Docker error. Null otherwise. */
const stepTimedOut = (result, step, budgetMs) => (result?.timedOut ? timedOut(`${step} did not finish within ${formatDuration(budgetMs)}`, { budgetMs, step }) : null);

const actions = Object.freeze(["start", "stop", "restart", "pause", "unpause"]);
const idPattern = /^[a-z0-9][a-z0-9-]{1,62}$/;
export { keepsBackupData };
export { backupNamePattern, checkpointCeilingMs } from "./app-backups.mjs";
/** How many updates to remember per app. Enough to step back through a bad week, small enough to store. */
export const updateHistoryLimit = 10;

/**
 * Canonicalise a path for the deny-list check even when its leaf does not exist yet: resolve every
 * symlink in the longest existing prefix, then re-attach the not-yet-created tail. Without this a
 * symlink anywhere along the path (`/srv/app/x -> /etc`) would let a root-side mkdir or chown be
 * walked into a protected location before the string-only deny check ever sees the real target.
 *
 * @param {string} target
 * @param {{ realpath?: (target: string) => Promise<string> }} [options]
 */
export async function resolveExisting(target, { realpath: resolve = realpath } = {}) {
  let current = path.resolve(target);
  const tail = [];
  for (;;) {
    try {
      const real = await resolve(current);
      return tail.length ? path.join(real, ...tail) : real;
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return path.resolve(target); // reached the filesystem root unresolved
      tail.unshift(path.basename(current));
      current = parent;
    }
  }
}

/** @param {string} binary @param {string[]} args @param {{ timeout?: number, cwd?: string, onLine?: ((line: string, stream: string) => void) | null }} [options] */
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

/** `fromDigest` for a history entry: the recorded digest of each service that moved, when any has one. */
function digestsOf(digests, movedFrom) {
  const kept = Object.fromEntries(Object.keys(movedFrom).filter((service) => digests[service]).map((service) => [service, digests[service]]));
  return Object.keys(kept).length ? { fromDigest: kept } : {};
}

/** A recorded `tag@sha256:…` belongs to the tag it was recorded beside, and is that and nothing more. */
const sameTag = (pinned, reference) => typeof pinned === "string" && pinned.startsWith(`${reference}@`) && /^sha256:[a-f0-9]{64}$/.test(pinned.slice(reference.length + 1));

/**
 * Whether the catalog's image is a move from the installed one. The catalog pinning a digest beside
 * the tag an app already runs (`app:1.2` → `app:1.2@sha256:…`) is not: offering it would put every
 * installed app through an update, checkpoint and restart for the same release. The next real
 * update records the pinned reference.
 */
export function isCatalogUpdate(installed, catalog) {
  if (typeof installed !== "string" || !installed || installed === catalog) return false;
  const pinsSameTag = !installed.includes("@") && typeof catalog === "string" && /^sha256:[a-f0-9]{64}$/.test(catalog.slice(installed.length + 1)) && catalog.startsWith(`${installed}@`);
  return !pinsSameTag;
}

export function createAppHelper({
  catalogRoot = process.env.BOXPILOT_CATALOG_ROOT ?? "/var/lib/boxpilot-managed/catalog",
  backupRoot = path.join(process.env.BOXPILOT_APPLICATION_BACKUP_ROOT ?? "/var/lib/boxpilot-managed/backups", "catalog"),
  // Machine snapshots, whose app backups pruning keeps (snapshotBackupReferences).
  machineSnapshotRoot = process.env.BOXPILOT_MACHINE_SNAPSHOT_ROOT ?? "/var/lib/boxpilot-managed/machine-snapshots",
  dockerBinary = process.env.BOXPILOT_DOCKER_BINARY ?? "/usr/bin/docker",
  tarBinary = process.env.BOXPILOT_TAR_BINARY ?? "/usr/bin/tar",
  runDocker = defaultDockerRunner,
  runCommand = fixedRun,
  scanCommand = dataScanCommand,
  catalog = createCatalogService(),
  wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  clock = () => new Date(),
  lanAddress = "0.0.0.0",
  listDevices = (directory) => readdir(directory),
  // lchown, not chown: never follow a final symlink when handing a folder to the app's user. On a
  // real directory it is identical to chown; on a symlink it touches the link, not its target.
  chownDirectory = (target, uid, gid) => lchown(target, uid, gid),
  statPath = (target) => stat(target),
  lstatPath = (target) => lstat(target),
  // Where a data folder really is, every link resolved (checkedDataFolders, dataFolderProblems).
  realpathOf = (target) => realpath(target),
  // Free space where an archive unpacks, and how much a restore leaves (archive-expansion.mjs).
  freeBytesOf = freeBytesOnDisk,
  restoreReserveBytes = 1024 ** 3,
  tailscaleBinary = process.env.BOXPILOT_TAILSCALE_BINARY ?? "/usr/bin/tailscale",
  vpnProfile = null,
  // Whether Docker can give containers an NVIDIA GPU; asked only for apps marked `gpu: optional`.
  nvidiaReady = null,
  // Every listening socket on the host, with the process holding it (`ss -l -p`), for the port check
  // before `compose up`. This process runs with PrivateNetwork=true and sees none of them itself, so
  // the helper passes the root task that can (tasks/listeners.mjs). Null skips the listener half.
  hostListeners = null,
} = {}) {
  const root = path.resolve(catalogRoot);
  const dirFor = (id) => path.join(root, id);
  /** Apps whose install rolled back in this process: their containers are worth asking about even
   *  when no project directory remains, because a rollback that could not stop them removes it. */
  const recentlyTouched = new Set();
  const docker = (args, options) => runDocker(dockerBinary, args, options);
  const gpuReady = nvidiaReady ?? createNvidiaInspector({ run: (binary, args, options) => (binary === "/usr/bin/docker" ? docker(args, options) : runCommand(binary, args, options)) }).dockerRuntimeReady;

  async function readState(id) {
    try { return JSON.parse(await readFileWithoutFollowing(path.join(dirFor(id), "boxpilot.json"))); } catch { return null; }
  }
  // Never through a link: an app's folder is whatever its last restored backup held.
  async function writeState(id, state) {
    await replaceFileWithoutFollowing(path.join(dirFor(id), "boxpilot.json"), JSON.stringify(state, null, 2), { mode: 0o600 });
  }
  async function readEnv(id) {
    try { return parseEnvFile(await readFileWithoutFollowing(path.join(dirFor(id), ".env"))); } catch { return {}; }
  }

  /**
   * Whether Docker answers, asking up to `attempts` times: at boot it may still be starting. The
   * helper waits here outside any lane (interrupted-backups.mjs), so the owner's own start of
   * docker.service, which holds the Docker lane, is never queued behind the wait.
   */
  async function waitForDocker({ attempts = 40, delayMs = 15_000 } = {}) {
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      if ((await docker(["info", "--format", "{{.ServerVersion}}"], { timeout: 30_000 })).ok) return true;
      if (attempt < attempts) await wait(delayMs);
    }
    return false;
  }

  /** The deployed compose.yaml and .env as they are now (null when absent), so a failed change can put them back. */
  async function readProjectFiles(id) {
    const read = (name) => readFileWithoutFollowing(path.join(dirFor(id), name)).catch(() => null);
    return { compose: await read("compose.yaml"), env: await read(".env") };
  }

  async function restoreProjectFiles(id, saved) {
    for (const [name, content] of [["compose.yaml", saved.compose], [".env", saved.env]]) {
      if (content === null) continue;
      await replaceFileWithoutFollowing(path.join(dirFor(id), name), content, { mode: 0o600 });
    }
  }

  async function containerStatus(id) {
    const name = projectNameFor(id);
    const result = await docker(["inspect", "--format", '{"running":{{.State.Running}},"status":"{{.State.Status}}","health":"{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}","restarts":{{.RestartCount}},"image":"{{.Image}}","startedAt":"{{.State.StartedAt}}","exitCode":{{.State.ExitCode}}}', name], { timeout: 10_000 });
    if (!result.ok) return { exists: false, running: false, status: "absent", health: "none", restarts: 0, image: null, startedAt: null };
    try { return { exists: true, ...JSON.parse(result.stdout) }; } catch { return { exists: true, running: false, status: "unknown", health: "none", restarts: 0, image: null, startedAt: null }; }
  }

  /**
   * The registry digest of each running service's image, as `tag@sha256:…`. A tag can be re-pushed,
   * so going back by tag alone may pull bytes the app never ran; the digest names exactly the image
   * that was running. Services whose image has no digest from that repository (built locally, or
   * Docker would not answer) are left out, and going back uses the tag for them.
   */
  async function runningDigests(id, references) {
    const pinned = {};
    for (const [service, reference] of Object.entries(references)) {
      if (typeof reference !== "string" || reference.includes("@")) continue;
      const status = await containerStatus(service === id ? id : `${id}-${service}`).catch(() => null);
      if (!status?.image) continue;
      const inspected = await docker(["image", "inspect", "--format", "{{json .RepoDigests}}", status.image], { timeout: 10_000 }).catch(() => null);
      if (!inspected?.ok) continue;
      let digests = [];
      try { digests = JSON.parse(String(inspected.stdout).trim() || "[]"); } catch { continue; }
      const match = (Array.isArray(digests) ? digests : []).find((entry) => typeof entry === "string" && imageRepository(entry) === imageRepository(reference) && /@sha256:[a-f0-9]{64}$/.test(entry));
      if (match) pinned[service] = `${reference}${match.slice(match.indexOf("@"))}`;
    }
    return pinned;
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
      // A sidecar is part of the app: qBittorrent "ran" for an hour while its VPN container
      // crash-looped, the deploy that broke it passed this check, and the card said Running.
      // A sidecar in a crash loop or exited fails the wait; one that is merely not yet up
      // resets the steady clock. Absent is not judged: the fake in tests and a mid-create
      // moment both look absent, and compose up already vouched the container was created.
      let sidecarsSettled = true;
      for (const sidecar of manifest.sidecars ?? []) {
        const helper = await containerStatus(`${manifest.id}-${sidecar.id}`);
        if (!helper.exists) continue;
        if (helper.running && helper.status === "restarting" && helper.restarts >= 2) {
          const logs = await docker(["logs", "--tail", "20", projectNameFor(`${manifest.id}-${sidecar.id}`)], { timeout: 10_000 });
          throw new Error(`The ${sidecar.id} container keeps restarting (${helper.restarts} times). Last log lines: ${redact(`${logs.stdout}\n${logs.stderr}`.trim()).slice(-600)}`);
        }
        if (["exited", "dead"].includes(helper.status)) {
          const logs = await docker(["logs", "--tail", "20", projectNameFor(`${manifest.id}-${sidecar.id}`)], { timeout: 10_000 });
          throw new Error(`The ${sidecar.id} container exited. Last log lines: ${redact(`${logs.stdout}\n${logs.stderr}`.trim()).slice(-600)}`);
        }
        if (!helper.running || helper.status === "restarting") sidecarsSettled = false;
      }
      // An unsettled sidecar blocks success below but never blocks noticing the app container
      // itself exiting or looping; both problems are watched every poll.
      if (!sidecarsSettled) stableSince = null;
      // Docker reports State.Running=true while a container sits in restart backoff, so "running"
      // alone is not running: a crash loop counted as steady for the whole backoff window and the
      // install declared the app up. Only the "running" status counts, and a second restart is a
      // loop — waiting out the timeout would only delay the same answer.
      if (status.running && status.status === "restarting") {
        stableSince = null;
        if (status.restarts >= 2) {
          const logs = await docker(["logs", "--tail", "20", projectNameFor(manifest.id)], { timeout: 10_000 });
          throw new Error(`Container keeps restarting (${status.restarts} times). Last log lines: ${redact(`${logs.stdout}\n${logs.stderr}`.trim()).slice(-600)}`);
        }
      } else if (status.running) {
        if (manifest.health.kind === "healthcheck") {
          if (status.health === "healthy" && sidecarsSettled) return status;
          if (status.health === "none") throw new Error("Manifest expects a container healthcheck but the image defines none");
        } else {
          if (lastRestarts !== null && status.restarts > lastRestarts) { stableSince = null; }
          lastRestarts = status.restarts;
          if (sidecarsSettled) stableSince ??= clock().getTime();
          if (stableSince !== null && clock().getTime() - stableSince >= manifest.health.stableSeconds * 1000) return status;
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

  /** @param {string} id @param {string[]} args @param {{ progress?: ((line: string, stream: string) => void) | null, timeout?: number }} [options] */
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

  /** Containers running now, as the port check needs them: name, published ports, owning app. Null when Docker cannot say. */
  async function runningContainers() {
    const result = await docker(["ps", "--format", "{{json .}}"], { timeout: 15_000 }).catch(() => null);
    if (!result?.ok) return null;
    return String(result.stdout ?? "").split("\n").filter(Boolean).map((line) => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean).map((item) => {
      const label = (key) => new RegExp(`(?:^|,)${key.replace(/\./g, "\\.")}=([^,]*)`).exec(String(item.Labels ?? ""))?.[1] || null;
      return { name: item.Names ?? null, ports: item.Ports ?? "", app: label("io.boxpilot.app"), composeProject: label("com.docker.compose.project") };
    });
  }

  /**
   * The host PIDs of the processes in the app's own container while it runs on the host's network,
   * as `docker top` lists them; empty otherwise. Those processes then hold the ports it binds, and
   * `ss` names them as themselves (pihole-FTL, python3), not as Docker's. A name says nothing about
   * whose a process is, and Docker reports Running=true through restart backoff, when the container
   * has no process at all: a Pi-hole crash-looping because systemd-resolve or libvirt's dnsmasq held
   * port 53 let that holder off as its own. Only "running" and "paused" count, and only the PIDs it
   * lists: a paused container's processes are frozen, not gone, and still hold its ports (R5B3-5).
   */
  async function ownHostNetworkPids(id) {
    const none = new Set();
    const result = await docker(["inspect", "--format", '{"running":{{.State.Running}},"status":"{{.State.Status}}","networkMode":"{{.HostConfig.NetworkMode}}"}', projectNameFor(id)], { timeout: 10_000 }).catch(() => null);
    if (!result?.ok) return none;
    let parsed = null;
    try { parsed = JSON.parse(String(result.stdout ?? "").split("\n")[0]); } catch { return none; }
    if (parsed?.running !== true || !["running", "paused"].includes(parsed.status) || parsed.networkMode !== "host") return none;
    const top = await docker(["top", projectNameFor(id), "-eo", "pid"], { timeout: 10_000 }).catch(() => null);
    if (!top?.ok) return none;
    // A header line ("PID"), then one PID a line.
    return new Set(String(top.stdout ?? "").split("\n").map((line) => line.trim()).filter((line) => /^\d+$/.test(line)).map(Number).filter((pid) => pid > 0));
  }

  /** What Tailscale Serve publishes right now; empty when Tailscale is absent. */
  async function serveEntries() {
    const result = await runCommand(tailscaleBinary, ["serve", "status", "--json"], { timeout: 15_000, maxBuffer: 2 * 1024 * 1024 }).catch(() => ({ ok: false, stdout: "" }));
    return result.ok ? parseServeStatus(result.stdout) : [];
  }

  /**
   * Whether the ports a compose project is about to publish are free, and if not, who holds each.
   *
   * Dockge's Start rebuilt its container and Docker then failed with "failed to bind host port
   * 0.0.0.0:5001/tcp: address already in use": Tailscale Serve published Dockge on the tailnet at
   * the same port, so tailscaled held 100.x.y.z:5001, and on Linux a publish on every address fails
   * while any one address holds the port. The owner got Docker's sentence and "read the log". This
   * asks first: every listener on the host (the root task names each one's process), whose container
   * each Docker listener is, and what Serve publishes. The app's own containers are never a conflict
   * with itself. A port Serve publishes that this project would publish on every address is a
   * conflict even when tailscaled is not holding it at this moment: tailscaled keeps retrying, and
   * whichever of the two binds first after a restart or a reboot wins.
   *
   * An app on the host's own network publishes nothing and binds its ports itself, on every address
   * (hostNetworkPorts): those are checked too. While its own container is running there, its own
   * processes hold its container ports, and `ss` names them as themselves (pihole-FTL), not as
   * Docker's: a listener held by one of the processes `docker top` lists for its container is the
   * app's own and left out (ownHostNetworkPids), whatever network the new compose file is on.
   * Pi-hole moving from the host network to bridge was refused on its own DNS port otherwise.
   * A port the app's own settings say it can start without (Pi-hole's admin page) is marked
   * `optional`, and assertPortsFree warns about it instead of refusing.
   *
   * Returns `{ checked, conflicts, requested }`; `checked` is false when the listeners could not be
   * read (the Serve half still ran). Each conflict is `{ port, protocol, bind, holders }` (ports.mjs
   * portHolders), with `hostNetwork`, `optional` and the port's `label` where they apply.
   */
  async function portCheck(manifest, composeText, { progress = null } = {}) {
    /** @type {{ id: string, host: number, protocol: string, bind: string, hostNetwork?: boolean, optional?: boolean, label?: string | null }[]} */
    const requested = publishedPorts(composeText).map((entry) => ({ id: entry.service, host: entry.host, protocol: entry.protocol, bind: entry.bind }));
    const hostBound = hostNetworkPorts(manifest, composeText);
    requested.push(...hostBound.map((entry) => ({ id: entry.service, host: entry.host, protocol: entry.protocol, bind: entry.bind, hostNetwork: true, optional: entry.optional, label: entry.label })));
    if (!requested.length) return { checked: true, conflicts: [], requested };
    let listeners = null;
    if (hostListeners) {
      try { listeners = await hostListeners(); } catch (error) { progress?.(`Could not read which ports are in use (${error.message}); going ahead without that check.`, "stderr"); }
    }
    if (Array.isArray(listeners) && listeners.length) {
      const ownPids = await ownHostNetworkPids(manifest.id);
      if (ownPids.size) listeners = listeners.filter((listener) => !ownPids.has(listener.process?.pid));
    }
    const everyAddress = requested.filter((entry) => entry.protocol === "tcp" && coversEveryAddress(entry.bind));
    const live = Array.isArray(listeners) ? findPortConflicts(requested, listeners) : [];
    const serves = everyAddress.length || live.length ? await serveEntries() : [];
    const selfPorts = [...new Set(requested.map((entry) => entry.host))];
    const project = projectNameFor(manifest.id);
    const own = (container) => container.app === manifest.id || container.name === project || String(container.name ?? "").startsWith(`${project}-`);
    let containers = live.length ? await runningContainers() : null;
    const found = new Map();
    for (const conflict of live) {
      const holders = portHolders(conflict, { serves, containers, own, selfPorts });
      if (holders.length) found.set(`${conflict.port}/${conflict.protocol}`, { port: conflict.port, protocol: conflict.protocol, bind: conflict.bind, holders });
    }
    for (const entry of everyAddress) {
      const serve = serves.find((candidate) => candidate.port === entry.host);
      const key = `${entry.host}/tcp`;
      if (!serve || found.get(key)?.holders.some((holder) => holder.kind === "serve")) continue;
      const targetPort = serveTargetPort(serve);
      const holder = { kind: "serve", address: null, serve, url: serveUrl(serve), targetPort, self: targetPort === null || selfPorts.includes(targetPort), armed: true };
      found.set(key, { port: entry.host, protocol: "tcp", bind: normalizeBind(entry.bind), holders: [...(found.get(key)?.holders ?? []), holder] });
    }
    // Serve fronting another app names that app, from the container publishing the port it forwards to.
    const conflicts = [...found.values()];
    const others = conflicts.flatMap((conflict) => conflict.holders).filter((holder) => holder.kind === "serve" && !holder.self && holder.targetPort);
    if (others.length) {
      containers ??= await runningContainers();
      for (const holder of others) holder.targetApp = (containers ?? []).find((container) => container.app && String(container.ports).includes(`:${holder.targetPort}->`))?.app ?? null;
    }
    for (const conflict of conflicts) {
      const wanted = requested.filter((entry) => entry.host === conflict.port && entry.protocol === conflict.protocol);
      if (wanted.some((entry) => entry.hostNetwork)) conflict.hostNetwork = true;
      if (wanted.length && wanted.every((entry) => entry.optional)) Object.assign(conflict, { optional: true, label: wanted[0].label ?? null });
    }
    return { checked: Array.isArray(listeners), conflicts, requested };
  }

  /** "Port 5001 is taken on the tailnet address by ...": who holds one port, as a sentence without its full stop. */
  function heldWords(manifest, conflict, nameOf) {
    const verb = conflict.holders.every((holder) => holder.armed) ? "is also claimed" : "is taken";
    return `Port ${conflict.port}${conflict.protocol === "udp" ? "/udp" : ""} ${verb} ${conflict.holders.map((holder) => holderWords(holder, { appName: manifest.name, nameOf })).join(", and ")}`;
  }

  async function appNames() {
    const names = new Map(((await catalog.all().catch(() => null))?.manifests ?? []).map((entry) => [entry.id, entry.name]));
    return (id) => names.get(id) ?? null;
  }

  /** The conflicts in words: who holds each port, and what the owner can do about it. */
  async function portConflictWords(manifest, conflicts) {
    const nameOf = await appNames();
    const sentences = conflicts.map((conflict) => `${heldWords(manifest, conflict, nameOf)}.`);
    const everyAddress = conflicts.some((conflict) => coversEveryAddress(conflict.bind));
    const serveSelf = conflicts.some((conflict) => conflict.holders.some((holder) => holder.kind === "serve" && holder.self));
    // On the host's own network its ports are its container ports, which no setting moves; on its
    // own network (bridge), where the owner can choose, they can.
    const hostNetwork = conflicts.some((conflict) => conflict.hostNetwork);
    const canBridge = (manifest.networkModes ?? []).includes("bridge");
    const them = conflicts.length === 1 ? "it" : "them";
    const why = !everyAddress ? ""
      : hostNetwork ? ` ${manifest.name} shares this server's own network and listens on ${them} on every address itself, and Linux will not let that share a port with a program holding it on one address${serveSelf ? ": whichever of the two starts first keeps it" : ""}.`
      : ` ${manifest.name} publishes ${them} on every address, and Linux will not let that share a port with a program holding it on one address${serveSelf ? ": whichever of the two starts first keeps it" : ""}.`;
    const next = hostNetwork
      ? serveSelf
        ? ` Stop serving ${manifest.name} on the tailnet (Repair offers it in one click): on this server's own network it already answers on the tailnet address itself.`
        : ` Stop what holds ${conflicts.length === 1 ? "the port" : "those ports"} if it should not be running${canBridge ? `, or switch ${manifest.name} to bridge networking in its Settings, where its ports can move` : ""}.`
      : serveSelf
        ? ` Serve ${manifest.name} only through Tailscale (its port moves to 127.0.0.1, where Serve reaches it), or stop serving it on the tailnet: Repair offers both in one click.`
        : ` Move ${manifest.name} to a free port in its Settings (Repair offers one), or stop what holds ${conflicts.length === 1 ? "the port" : "those ports"} if it should not be running.`;
    return `${sentences.join(" ")}${why}${next}`;
  }

  /** An optional port something holds, in words: the app starts without what it serves there. */
  async function optionalPortWords(manifest, conflict) {
    const canBridge = (manifest.networkModes ?? []).includes("bridge");
    return `${heldWords(manifest, conflict, await appNames())}, so ${manifest.name} goes ahead without ${conflict.label ? `its ${conflict.label}` : `what it serves on port ${conflict.port}`}: its own settings let it start without that port. Stop what holds it and restart ${manifest.name} to have it${canBridge ? `, or switch ${manifest.name} to bridge networking in its Settings` : ""}.`;
  }

  /**
   * Refuse, before `compose up`, a project whose ports something else holds (see portCheck).
   * `refused` opens the sentence: "Dockge was not started." The error carries `code: "port_conflict"`
   * and the conflicts themselves. A Serve port being withdrawn (app.exposure.set does that first)
   * is let go of a moment after Tailscale is told, so tailscaled alone, with no Serve entry left,
   * is given a few seconds.
   *
   * A held port the app can start without (portCheck's `optional`) is not a reason to refuse: it is
   * said in the log and returned in `warnings`, for the job's result to carry.
   *
   * @param {any} manifest
   * @param {string} composeText
   * @param {{ progress?: ((line: string, stream: string) => void) | null, refused?: string }} [options]
   */
  async function assertPortsFree(manifest, composeText, { progress = null, refused } = {}) {
    const blocking = (check) => check.conflicts.filter((conflict) => !conflict.optional);
    let result = await portCheck(manifest, composeText, { progress });
    for (let attempt = 0; attempt < 5 && blocking(result).length && blocking(result).every((conflict) => conflict.holders.every((holder) => holder.kind === "tailscale")); attempt += 1) {
      await wait(1000);
      result = await portCheck(manifest, composeText, { progress });
    }
    const warnings = [];
    for (const conflict of result.conflicts.filter((entry) => entry.optional)) warnings.push(await optionalPortWords(manifest, conflict));
    for (const warning of warnings) progress?.(warning, "stderr");
    const conflicts = blocking(result);
    if (!conflicts.length) {
      const optional = new Set(result.conflicts.map((conflict) => `${conflict.port}/${conflict.protocol}`));
      const free = [...new Set(result.requested.map((entry) => `${entry.host}/${entry.protocol}`))].filter((port) => !optional.has(port));
      if (result.checked && free.length) progress?.(`Ports ${free.join(", ")} are free.`, "stdout");
      return { ...result, warnings };
    }
    const words = await portConflictWords(manifest, conflicts);
    progress?.(words, "stderr");
    throw Object.assign(new Error(`${refused} ${words}`), { code: "port_conflict", conflicts });
  }
  /** `{ warnings }` for a result when a port check left any, else nothing. */
  const withPortWarnings = (checked) => (checked?.warnings?.length ? { warnings: checked.warnings } : {});

  /**
   * Docker's own "address already in use" or "port is already allocated", said the way the check
   * above says it: something took the port between the check and `up`, or the check could not run.
   * Null when the failure was something else.
   */
  async function bindFailure(manifest, stderr, composeText, refused) {
    const text = String(stderr ?? "");
    if (!/address already in use|port is already allocated/i.test(text)) return null;
    const conflicts = (await portCheck(manifest, composeText).catch(() => null))?.conflicts.filter((conflict) => !conflict.optional) ?? [];
    if (conflicts.length) return Object.assign(new Error(`${refused} ${await portConflictWords(manifest, conflicts)}`), { code: "port_conflict", conflicts });
    const port = /(?:bind host port|Bind for|listen (?:tcp|udp)\d?)\s+\[?[^\s\]]*\]?:(\d{1,5})/i.exec(text)?.[1] ?? null;
    const said = redact(text).split("\n").map((line) => line.trim()).filter(Boolean).at(-1)?.replace(/^Error response from daemon:\s*/i, "").slice(0, 200) ?? "";
    return Object.assign(new Error(`${refused} ${port ? `Port ${port}` : "One of its ports"} is already in use on this server, so Docker could not publish it for ${manifest.name} (Docker said: "${said}"). \`sudo ss -ltnup 'sport = :${port ?? "<port>"}'\` names what holds it. Move ${manifest.name} to a free port in its Settings, or stop what holds it if it should not be running.`), { code: "port_conflict" });
  }

  /** What boxpilot.json persists: never secrets, never values the operator cannot change. */
  function storableValues(manifest, values, env) {
    const profileActive = manifest.usesVpnProfile && env?.USE_VPN_PROFILE === "on";
    return {
      ports: values.ports,
      env: Object.fromEntries(Object.entries(env).filter(([name]) => {
        const entry = manifest.env.find((field) => field.name === name);
        if (entry?.secret) return false;
        // When the shared VPN profile drives this app, its connection values are injected fresh on
        // every deploy. Persisting them would copy the owner-only profile into per-app state, which
        // GET /catalog returns to any role, and could leave a stale copy behind. Re-derived, never stored.
        if (profileActive && entry?.fromVpnProfile) return false;
        return true;
      })),
      volumes: Object.fromEntries(Object.entries(values.volumes).filter(([id]) => manifest.volumes.find((volume) => volume.id === id)?.configurable)),
      // Persist the owner's exposure and network-mode choices so the settings form reflects them
      // and a later reconfigure keeps them rather than silently reverting to the manifest default.
      ...(values.exposure ? { exposure: values.exposure } : {}),
      ...(values.networkMode ? { networkMode: values.networkMode } : {}),
      ...(manifest.setup ? { setup: values.setup ?? [] } : {}),
    };
  }

  /**
   * Saved settings with the secrets they never hold put back from the app's .env, where the only
   * copy lives (storableValues). A required secret with no default - the Cloudflare Tunnel's token,
   * cloudflare-ddns's API token - was otherwise missing from every re-check of saved settings: the
   * tunnel could not be updated at all, a settings change wanted the token typed again, and neither
   * a reinstall nor a snapshot restore could bring it back. Only what was not given is filled, and
   * only from a non-empty value; renderCompose keeps the same value for the same reason.
   */
  function withSavedSecrets(manifest, raw, existingEnv) {
    const env = { ...(raw?.env ?? {}) };
    for (const entry of manifest.env) {
      if (!entry.secret || !entry.required || entry.fixed || entry.generate || (entry.default !== null && entry.default !== undefined)) continue;
      if (env[entry.name] !== undefined && env[entry.name] !== null && env[entry.name] !== "") continue;
      if (typeof existingEnv?.[entry.name] === "string" && existingEnv[entry.name] !== "") env[entry.name] = existingEnv[entry.name];
    }
    return { ...raw, env };
  }

  /**
   * Why these settings cannot go out together, or null: tailnet only on the host's own network.
   * Tailnet only binds an app's ports to this server for Tailscale Serve to front; on the host's
   * network the app binds every address itself and nothing is bound for it. Saved together, the
   * Reach tab said Tailscale-only about an app answering the whole house, beside a Serve link to a
   * port nothing listened on. Refused rather than changed for the owner: which of the two to give up
   * is theirs to choose, and Home network also withdraws the Serve address (app.exposure.set).
   * `switchingNetwork`: the change is the move onto the host network, not the move to tailnet only.
   */
  function hostNetworkTailnetRefusal(manifest, values, { switchingNetwork }) {
    if ((values.networkMode ?? manifest.network) !== "host" || values.exposure !== "tailnet") return null;
    if (switchingNetwork) return `${manifest.name} is reachable only through Tailscale (Tailnet only, on its Reach tab). On this server's own network it would answer on every address, so change who can reach it to Home network first, which also stops publishing it on the tailnet, then switch it to host networking. Nothing was changed.`;
    return `${manifest.name} shares this server's own network, where it answers on every address itself, so it cannot be reachable only through Tailscale.${(manifest.networkModes ?? []).includes("bridge") ? " Switch it to bridge networking in its Settings first." : ""} Nothing was changed.`;
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

  const declaredOwnerCache = new Map();

  const declaredUserCache = new Map();   // reference -> raw Config.User from the last successful inspect
  /**
   * The uid/gid the *image itself* says it runs as, for the many apps that neither declare `user:`
   * nor read PUID — AnythingLLM runs as `anythingllm`, Wiki.js as `node`, Firefly as `www-data`.
   * Their managed folders were created root-owned and the app could not write a byte into them: an
   * install that looks successful and then fails at the first upload.
   *
   * A numeric USER is taken at face value; a name has to be resolved against the image's own passwd
   * file, which means asking the image. Anything that cannot answer (no `id`, a distroless base)
   * leaves ownership alone rather than guessing, which is the behaviour we had before.
   */
  async function imageDeclaredOwner(reference, { mayRun = true } = {}) {
    if (declaredOwnerCache.has(reference)) return declaredOwnerCache.get(reference);
    let resolved = null;
    // What the image itself says its USER is, remembered from the last successful inspect. A named
    // user (node, www-data) cannot be turned into ids without starting a container, which a
    // read-only caller must never do - so it used to return null and spawn `docker image inspect`
    // again on every listing, for every such app, on every page that lists apps. The string is
    // cheap to keep; it only changes when the image is pulled, and the pull sites clear it.
    let inspected = declaredUserCache.has(reference)
      ? { ok: true, stdout: declaredUserCache.get(reference) }
      : await docker(["image", "inspect", reference, "--format", "{{.Config.User}}"], { timeout: 30_000 });
    // On a first install the image is not here yet: the project is written before anything is
    // pulled, so inspect finds nothing and the app's user cannot be read. Every app that declares
    // PUID answers from its manifest and never reaches this, which is why it stayed hidden until an
    // app arrived whose only statement of identity is the image's own USER. Without the pull, its
    // data folder is left owned by root and the container crash-loops on its first mkdir.
    if (!inspected.ok && mayRun) {
      declaredUserCache.delete(reference); declaredOwnerCache.delete(reference);
      await docker(["pull", reference], { timeout: 15 * 60_000 }).catch(() => null);
      inspected = await docker(["image", "inspect", reference, "--format", "{{.Config.User}}"], { timeout: 30_000 });
    }
    // Never cache "could not read it". The cache is keyed on the reference alone, so a read-only
    // catalog listing that ran before the image was pulled would otherwise store null and the next
    // deploy would take that cache hit instead of pulling — re-arming the very bug the pull fixes.
    if (!inspected.ok) return null;
    declaredUserCache.set(reference, inspected.stdout);
    const declared = inspected.stdout.trim();
    if (declared && declared !== "root" && declared !== "0") {
      const [rawUser, rawGroup] = declared.split(":");
      const numericUid = Number.parseInt(rawUser, 10);
      if (Number.isInteger(numericUid) && String(numericUid) === rawUser) {
        const numericGid = Number.parseInt(rawGroup ?? "", 10);
        resolved = { uid: numericUid, gid: Number.isInteger(numericGid) ? numericGid : numericUid };
      } else if (!mayRun) {
        // Resolving a NAME means starting a container to ask its passwd file. A read-only caller
        // (the catalog listing) must never do that, and must not poison the cache with "unknown"
        // either — the next deploy is allowed to ask properly.
        return null;
      } else {
        const ids = await docker(["run", "--rm", "--entrypoint", "id", reference, "-u"], { timeout: 60_000 }).catch(() => ({ ok: false, stdout: "" }));
        const groupIds = await docker(["run", "--rm", "--entrypoint", "id", reference, "-g"], { timeout: 60_000 }).catch(() => ({ ok: false, stdout: "" }));
        const uid = Number.parseInt(ids.ok ? ids.stdout.trim() : "", 10);
        const gid = Number.parseInt(groupIds.ok ? groupIds.stdout.trim() : "", 10);
        if (Number.isInteger(uid) && uid !== 0) resolved = { uid, gid: Number.isInteger(gid) ? gid : uid };
      }
    }
    declaredOwnerCache.set(reference, resolved);
    return resolved;
  }

  /**
   * The data folders a deploy mounts, each checked to be where it says it is, before anything is
   * created or handed over (R5S2-1). Every link on the way is resolved (a not-yet-created leaf too),
   * and a folder that is a link, goes through one, or resolves into a protected location is refused,
   * the manifest's own default and the owner's choice alike: the compose file names the path, Docker
   * follows whatever link is there, so a folder that is not where it says is mounted wherever the
   * link points - another app's folder, or /etc. A default used to be let through with only its
   * mkdir and chown skipped. The system mounts a manifest declares (Docker's socket, /proc) are on
   * the deny list by name, are not data folders, and are not looked at here.
   * `[{ volume, chosen, info }]`, `info` being what lstat found (null when nothing is there yet).
   */
  async function checkedDataFolders(manifest, values) {
    const checked = [];
    for (const volume of manifest.volumes) {
      const chosen = values.volumes?.[volume.id] ?? volume.hostPath;
      if (!chosen || isDeniedHostPath(chosen)) continue;
      const named = `${manifest.name}'s ${volume.label ?? volume.id} ${chosen}`;
      const real = await resolveExisting(chosen, { realpath: realpathOf });
      if (isDeniedHostPath(real)) throw new Error(`${named} resolves to ${real}, a protected system location; pick a folder under /srv, /mnt, /media, or your home`);
      const info = await lstatPath(chosen).catch(() => null);
      const instead = `Docker would mount ${real} in its place, which may be another app's folder, so ${manifest.name} was not deployed`;
      if (info?.isSymbolicLink?.()) throw new Error(`${named} is a link to ${real}. ${instead}: point it at a real folder in its settings, or make ${chosen} one.`);
      if (real !== path.resolve(chosen)) throw new Error(`${named} goes through a link: it is ${real}. ${instead}: point it at ${real} itself in its settings, or make ${chosen} a real folder.`);
      checked.push({ volume, chosen, info });
    }
    return checked;
  }

  async function writeProject(manifest, values, { existingEnv = {}, devices: provided = null } = {}) {
    const directory = dirFor(manifest.id);
    const dataFolders = await checkedDataFolders(manifest, values);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    // Images that run as a fixed non-root user (declared with `user:`) must be able to write their
    // managed volumes, which the helper creates as root. Ownership is set on the directory only;
    // existing files are never touched.
    // Who the container runs as: what the manifest declares, else what the image declares itself.
    const managedOwner = effectiveOwner(manifest) ?? await imageDeclaredOwner(manifest.image.reference).catch(() => null);
    for (const volume of manifest.volumes) {
      if (!volume.path) continue;
      const target = path.join(directory, volume.path);
      await mkdir(target, { recursive: true, mode: 0o755 });
      if (managedOwner) await chownDirectory(target, managedOwner.uid, managedOwner.gid).catch(() => {});
    }
    for (const sidecar of manifest.sidecars ?? []) {
      const sidecarOwner = await imageDeclaredOwner(sidecar.image).catch(() => null);
      for (const volume of sidecar.volumes) {
        if (!volume.path) continue;                 // a read-only host bind has no project directory to create
        const target = path.join(directory, volume.path);
        await mkdir(target, { recursive: true, mode: 0o755 });
        if (sidecarOwner) await chownDirectory(target, sidecarOwner.uid, sidecarOwner.gid).catch(() => {});
      }
    }
    // A folder the app is pointed at may not exist yet. Docker would create it as root:root, and an
    // app that runs as a normal user (PUID, or a declared `user:`) then cannot write its own data —
    // the install looks fine and every download or upload fails. Create it ourselves and hand it over.
    // If it already exists but is root-owned and the app must write there, hand it over too: root
    // ownership means Docker or a default created it, never the owner's own library (which carries
    // their account's ownership). A folder owned by a real user is left alone, and so is a read-only
    // mount, which the app never writes to.
    // Each one was checked above (checkedDataFolders) before anything here was created: root is never
    // walked through a link, and nothing that is not where it says is mounted at all.
    const runsAs = managedOwner;
    for (const { volume, chosen, info } of dataFolders) {
      if (!info) {
        await mkdir(chosen, { recursive: true, mode: 0o755 }).catch(() => {});
        if (runsAs) await chownDirectory(chosen, runsAs.uid, runsAs.gid).catch(() => {});
      } else if (runsAs && runsAs.uid !== 0 && !volume.readOnly && info.uid === 0) {
        await chownDirectory(chosen, runsAs.uid, runsAs.gid).catch(() => {});
      }
    }
    // The layout the manifest promises inside a data folder (a torrents/ the client writes into,
    // a tv/ the library reads) exists before the first app goes looking for it. This runs after
    // the owner-chosen paths above have been validated, and through the RESOLVED base, so a base
    // that is a symlink into a protected location has already been refused rather than written
    // through as root. Only missing folders are created and handed to the app's user; anything
    // already there is the owner's library and stays untouched, ownership included.
    for (const volume of manifest.volumes) {
      const base = volume.path ? path.join(directory, volume.path) : values.volumes?.[volume.id] ?? volume.hostPath;
      if (!base || (volume.subdirectories ?? []).length === 0) continue;
      const resolvedBase = volume.path ? base : await realpath(base).catch(() => base);
      if (!volume.path && isDeniedHostPath(resolvedBase)) continue;
      for (const name of volume.subdirectories) {
        const target = path.join(resolvedBase, name);
        if (await stat(target).then(() => true, () => false)) continue;
        await mkdir(target, { recursive: true, mode: 0o755 }).catch(() => {});
        if (runsAs) await chownDirectory(target, runsAs.uid, runsAs.gid).catch(() => {});
      }
    }
    const rendered = await renderProject(manifest, values, { existingEnv, devices: provided });
    // Never through a link at these names, or at a folder on the way to a config file: the folder
    // holds whatever the app's last restored backup did.
    await replaceFileWithoutFollowing(path.join(directory, ".env"), rendered.envFile, { mode: 0o600 });
    await replaceFileWithoutFollowing(path.join(directory, "compose.yaml"), rendered.composeYaml, { mode: 0o600 });
    // Config files shipped with the app (a prometheus.yml, a datasource yaml). Their paths were
    // validated safe and relative by the schema; each is written under the project directory and
    // mounted into the container by the compose file. Rewritten whole on every deploy, so a
    // manifest change reaches the running app.
    for (const file of rendered.files ?? []) {
      const folder = await mkdirWithoutFollowing(directory, path.posix.dirname(file.path), { mode: 0o755 });
      await replaceFileWithoutFollowing(path.join(folder, path.posix.basename(file.path)), file.content, { mode: 0o644 });
    }
    return rendered;
  }

  /**
   * The compose file and .env these settings make on this server, written nowhere: its devices, its
   * VPN profile, whether Docker has a GPU for it, its tailnet address and name. Throws when this
   * server cannot take them (a device it does not have, tailnet only with no tailnet address).
   */
  async function renderProject(manifest, values, { existingEnv = {}, devices: provided = null } = {}) {
    // The web process resolves device globs against the real /dev (this process may run without one); only paths matching the manifest are accepted.
    const wanted = [...manifest.devices, ...(manifest.optionalDevices ?? [])];
    const devices = Array.isArray(provided)
      ? [...new Set(provided.filter((device) => wanted.some((pattern) => deviceMatchesPattern(device, pattern))))]
      : await resolveDevices(wanted, listDevices);
    // Only the required list can refuse the install. An optional device — a GPU for transcoding —
    // is simply absent from the compose file on a server without one.
    const required = devices.filter((device) => manifest.devices.some((pattern) => deviceMatchesPattern(device, pattern)));
    if (manifest.devices.some((pattern) => /[?*[]/.test(pattern)) && !required.length) throw new Error(`${manifest.name} needs a device matching ${manifest.devices.join(", ")} and none exists on this server`);
    // Shared VPN profile (M17.4): a manifest can offer to draw its VPN connection from the one saved
    // profile. It is off unless the app opted in (USE_VPN_PROFILE=on), so an app carrying its own
    // connection renders exactly as before. When on, the profile's connection overwrites the app's
    // `fromVpnProfile` env, and its security options are layered onto the Gluetun sidecar.
    const sidecarEnvOverrides = {};
    if (manifest.usesVpnProfile && values.env?.USE_VPN_PROFILE === "on") {
      const profile = vpnProfile ? await vpnProfile.read() : null;
      if (!profile) throw new Error(`${manifest.name} is set to use the shared VPN profile, but none is saved. Save a VPN profile in the VPN section first, or turn off "Use my VPN profile" and give this app its own connection.`);
      const connection = profileConnectionEnv(profile);
      for (const entry of manifest.env) if (entry.fromVpnProfile && connection[entry.name] !== undefined) values.env[entry.name] = connection[entry.name];
      if (manifest.networkVia) sidecarEnvOverrides[manifest.networkVia] = profileSecurityEnv(profile);
    }
    // A GPU-capable app gets the GPU only when Docker can actually provide one; otherwise it runs
    // on the CPU, the same as on a server without a GPU.
    const gpu = wantsGpu(manifest) ? await gpuReady().catch(() => false) : false;
    // An app told this server's tailnet name (Zulip's address) cannot go out with the words
    // "${TAILNET_HOST}" in its place: it would advertise an address nobody can open.
    let tailnetHost = null;
    if (usesTailnetHost(manifest, values)) {
      tailnetHost = await tailnetDnsName();
      if (!tailnetHost) {
        const named = manifest.env.find((entry) => /\$\{TAILNET_HOST\}/.test(String(values.env?.[entry.name] ?? "")));
        throw new Error(`${manifest.name} is reached at this server's tailnet HTTPS address, and Tailscale did not say what that is (is it up and signed in?). Start Tailscale and try again${named ? `, or set ${named.label} to the address people use` : ""}. Nothing was changed.`);
      }
    }
    return renderCompose(manifest, values, { existingEnv, lanAddress, devices, tailnetAddress: await tailnetAddressFor(manifest, values), tailnetHost, sidecarEnvOverrides, gpu });
  }

  /**
   * One application's public shape. `known` lets a caller that has already established there is no
   * project directory skip both the state read and the container lookup.
   */
  /**
   * Why the app's user cannot write to a folder, or null when it can. Mirrors the kernel's basic
   * owner/group/other check; ACL exotica is out of scope — a false "fine" there just means no badge.
   */
  function folderUnwritableReason(info, owner) {
    if (!info || !owner || !Number.isInteger(owner.uid)) return null;
    if (info.uid === owner.uid) return null;
    const mode = info.mode & 0o777;
    if (info.gid === owner.gid && (mode & 0o020)) return null;
    if (mode & 0o002) return null;
    return `owned by user ${info.uid === 0 ? "root" : info.uid}, while the app runs as user ${owner.uid}`;
  }

  /** Read-write data folders this installed app cannot write into (the silent qBittorrent failure). */
  async function folderProblems(manifest, state) {
    if (!state?.installed) return [];
    // mayRun:false — this runs on every catalog listing, which must stay read-only: never start a
    // container just to render a badge. Deploys resolve fully and warm the cache for later listings.
    const owner = effectiveOwner(manifest) ?? await imageDeclaredOwner(manifest.image.reference, { mayRun: false }).catch(() => null);
    if (!owner || owner.uid === 0) return [];
    const problems = [];
    for (const volume of manifest.volumes) {
      if (volume.readOnly || (!volume.hostPath && !volume.configurable)) continue;
      const chosen = state.values?.volumes?.[volume.id] ?? volume.hostPath;
      if (!chosen || isDeniedHostPath(chosen)) continue;
      const info = await statPath(chosen).catch(() => null);
      if (!info) continue; // missing folders are created (and handed over) at the next deploy
      const reason = folderUnwritableReason(info, owner);
      // The owners as numbers too, so Repair can tell a folder a deploy hands over (root's) from
      // somebody's own, which it never touches (M35).
      if (reason) problems.push({ path: chosen, volume: volume.label, reason, ownerUid: info.uid, appUid: owner.uid });
    }
    return problems;
  }

  /**
   * The ports an installed app publishes: `{ id, host, protocol, bind, fixed, web }`, `bind` being
   * the address Docker binds ("*" for every address of both families). From the deployed compose
   * file, which is what `up` binds even after a raw edit; from the saved settings when the file is
   * gone (Reinstall writes it again from them). `id` is the manifest port it is, so a fix can move
   * it; `web` marks the ports Tailscale Serve can front.
   */
  async function publishedFor(manifest, state) {
    const stored = state.values?.ports ?? {};
    const web = (port) => Boolean(port && port.protocol === "tcp" && (port.tailnet ?? "serve") === "serve");
    // On the host's own network nothing is published: the app binds its ports itself, and nearly
    // every app binds every address. Said so, because Serve beside it collides just the same.
    if ((state.values?.networkMode ?? manifest.network) === "host" || manifest.network === "host") {
      return manifest.ports.map((port) => ({ id: port.id, host: port.container, protocol: port.protocol, bind: "*", fixed: true, web: web(port), hostNetwork: true }));
    }
    const parsed = await publishedPortsOf(manifest.id);
    const entries = parsed !== null
      ? parsed
      : manifest.ports.map((port) => ({ host: stored[port.id] ?? port.host, protocol: port.protocol, bind: bindingFor(port, state.values?.exposure ?? "lan", { lanAddress, tailnetAddress: null }).bind }));
    return entries.map((entry) => {
      const port = manifest.ports.find((candidate) => candidate.protocol === entry.protocol && (stored[candidate.id] ?? candidate.host) === entry.host) ?? null;
      return { id: port?.id ?? null, host: entry.host, protocol: entry.protocol, bind: normalizeBind(entry.bind), fixed: Boolean(port?.fixed), web: web(port) };
    });
  }

  /**
   * The compose file's published ports, parsed once per change of the file (M50): every inspect
   * read and YAML-parsed all eighteen files again, under polls every few seconds. Null when there
   * is no file to read, as before.
   */
  const portsParsed = new Map();
  async function publishedPortsOf(id) {
    const file = path.join(dirFor(id), "compose.yaml");
    let info;
    try { info = await lstat(file); } catch { portsParsed.delete(id); return null; }
    if (!info.isFile()) { portsParsed.delete(id); return null; }
    const held = portsParsed.get(id);
    if (held && held.mtimeMs === info.mtimeMs && held.size === info.size) return held.entries;
    const text = await readFileWithoutFollowing(file).catch(() => null);
    if (text === null) { portsParsed.delete(id); return null; }
    const entries = publishedPorts(text);
    portsParsed.set(id, { mtimeMs: info.mtimeMs, size: info.size, entries });
    return entries;
  }

  async function describe(manifest, status = null, known = undefined, batch = null) {
    const state = known ? known.state : await readState(manifest.id);
    if (!status && !known) status = await containerStatus(manifest.id);
    if (!status) status = { exists: false, running: false, status: "absent", health: "none", restarts: 0, image: null, startedAt: null };
    // The vpn container restarting IS the app being broken; saying "Running" because the app
    // container is up hid exactly that. Only sidecars that exist are reported.
    let sidecars = [];
    if ((manifest.sidecars ?? []).length && state?.installed) {
      const wanted = manifest.sidecars.map((sidecar) => `${manifest.id}-${sidecar.id}`);
      const looked = batch ?? await containerStatuses(wanted);
      sidecars = manifest.sidecars
        .map((sidecar) => ({ id: sidecar.id, ...(looked.get(`${manifest.id}-${sidecar.id}`) ?? { exists: false }) }))
        .filter((entry) => entry.exists)
        .map((entry) => ({ id: entry.id, running: entry.running, status: entry.status, restarts: entry.restarts ?? 0 }));
    }
    return {
      sidecars,
      id: manifest.id,
      name: manifest.name,
      installed: Boolean(state && state.installed),
      // The host ports it publishes and the address each binds, from its deployed compose file:
      // what Repair's port check compares with the host's listeners and with Tailscale Serve.
      published: state?.installed ? await publishedFor(manifest, state) : [],
      dataPresent: Boolean(state),
      state: state ? { installedAt: state.installedAt, updatedAt: state.updatedAt, manifestSha256: state.manifestSha256, image: state.image, values: { ports: state.values?.ports ?? {}, env: state.values?.env ?? {}, volumes: state.values?.volumes ?? {}, setup: Array.isArray(state.values?.setup) ? state.values.setup : [], ...(state.values?.exposure ? { exposure: state.values.exposure } : {}) }, pinnedRollback: state.pinnedRollback ?? false, uninstalledAt: state.uninstalledAt ?? null } : null,
      container: status,
      // Only the ports that speak HTTP get an "Open" link. Listing every TCP port offered to open
      // Pi-hole's DNS on 53 and Forgejo's SSH on 2222 in a browser tab, and made the Overview's
      // link for an app whichever port happened to be listed first.
      urls: state && state.installed ? (() => {
        const hostNetworked = (state.values?.networkMode ?? manifest.network) === "host";
        return manifest.ports.filter((port) => port.protocol === "tcp" && (port.tailnet ?? "serve") === "serve").map((port) => ({ id: port.id, label: port.label, host: hostNetworked ? port.container : state.values?.ports?.[port.id] ?? port.host, exposure: port.exposure, path: signInPortId(manifest) === port.id ? manifest.signIn?.path ?? null : null }));
      })() : [],
      updateAvailable: Boolean(state?.installed && isCatalogUpdate(state.image?.reference, manifest.image.reference)),
      updateHistory: state?.updateHistory ?? [],
      installedImage: state?.image?.reference ?? null,
      folderProblems: await folderProblems(manifest, state).catch(() => []),
      // An app BoxPilot lists as installed with no container at all (M35): what is left of it, so
      // Repair can say where the record is and what "Reinstall" would build from.
      ...(state?.installed && !status.exists ? { missingContainer: { record: path.join(dirFor(manifest.id), "boxpilot.json"), project: path.join(dirFor(manifest.id), "compose.yaml"), projectPresent: await stat(path.join(dirFor(manifest.id), "compose.yaml")).then(() => true, () => false), container: projectNameFor(manifest.id) } } : {}),
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
    const statuses = await containerStatuses(candidates.flatMap((manifest) => [manifest.id, ...(manifest.sidecars ?? []).map((sidecar) => `${manifest.id}-${sidecar.id}`)]));
    const described = await Promise.all(selected.map((manifest) => (known === null || known.has(manifest.id)
      ? describe(manifest, statuses.get(manifest.id), undefined, statuses)
      : describe(manifest, undefined, { state: null }))));
    const readProblems = present === null ? [...problems, { file: root, errors: ["The application directory could not be read, so installed state is unknown"] }] : problems;
    return { applications: described, problems: readProblems, catalogRoot: root };
  }

  /**
   * `storedValues` (a machine snapshot restore) says the values are settings an earlier release
   * saved, not the owner's entry: what the catalog no longer has is dropped, as update does, and a
   * secret they never hold comes from the .env restored beside them.
   */
  async function install({ id, values: rawValues = {}, devices = null }, { progress = null, timeScale = 1, storedValues = false } = {}) {
    const manifest = await ensureManifest(id);
    const existing = await readState(id);
    if (existing?.installed) throw new Error(`${manifest.name} is already installed; use reconfigure or update`);
    const given = storedValues ? withSavedSecrets(manifest, sanitizeStoredValues(manifest, rawValues ?? {}), await readEnv(id)) : rawValues;
    // An install that does not say who can reach the app takes the manifest's default: tailnet only
    // for an app that must not face the home network (Zulip). Only here: a reconfigure keeps what
    // was stored, so a manifest gaining a default never moves an app already installed. Never on the
    // host's own network, where there is nothing to bind to this server alone.
    const withExposure = given?.exposure === undefined && manifest.defaultExposure === "tailnet" && (given?.networkMode ?? manifest.network) !== "host" ? { ...given, exposure: "tailnet" } : given;
    const { values, errors } = resolveValues(manifest, withExposure);
    if (errors.length) throw new Error(`Invalid settings: ${errors.join("; ")}`);
    const refusal = storedValues ? null : hostNetworkTailnetRefusal(manifest, values, { switchingNetwork: false });
    if (refusal) throw new Error(refusal);
    const probe = await docker(["version", "--format", "{{.Server.Version}}"], { timeout: 10_000 });
    if (!probe.ok) throw new Error("Docker Engine is not available; install it from Repair Center first");
    let directoryExisted = true;
    try { await stat(dirFor(id)); } catch { directoryExisted = false; }
    progress?.(`Writing compose project for ${manifest.name} (${manifest.image.reference})`, "stdout");
    const rendered = await writeProject(manifest, values, { existingEnv: await readEnv(id), devices });
    // Before anything is pulled or started: a port something else holds would fail `up` after the
    // download, with Docker's sentence instead of who holds it.
    let ports;
    try {
      ports = await assertPortsFree(manifest, rendered.composeYaml, { progress, refused: `${manifest.name} was not installed; nothing was started.` });
    } catch (error) {
      if (!directoryExisted) await rm(dirFor(id), { recursive: true, force: true }).catch(() => {});
      throw error;
    }
    // `up` downloads every image the app does not have yet before it starts anything.
    const upBudgetMs = scaled(15 * 60_000, timeScale);
    const up = await compose(id, ["up", "--detach", "--remove-orphans"], { timeout: upBudgetMs, progress });
    try {
      if (!up.ok) throw stepTimedOut(up, "Downloading the images and starting the app", upBudgetMs) ?? await bindFailure(manifest, up.stderr, rendered.composeYaml, "Docker could not publish its ports.") ?? new Error(`docker compose up failed: ${redact(up.stderr).split("\n").slice(-4).join(" ")}`);
      const status = await waitHealthy(manifest, progress);
      progress?.(`${manifest.name} is up`, "stdout");
      await writeState(id, { id, installed: true, installedAt: clock().toISOString(), updatedAt: clock().toISOString(), manifestSha256: manifest.sha256 ?? null, image: { reference: manifest.image.reference, id: status.image }, values: storableValues(manifest, values, rendered.env), pinnedRollback: false });
      const setup = await applySetup(manifest, values, progress);
      await refreshHomepage(id, progress);
      return { installed: true, id, name: manifest.name, image: status.image, hostPorts: rendered.hostPorts, exposure: values.exposure ?? "lan", health: status.health, secretsGenerated: manifest.env.filter((entry) => entry.generate).map((entry) => entry.name), setup, ...withPortWarnings(ports) };
    } catch (error) {
      progress?.(`Install failed: ${error.message}. Rolling back...`, "stderr");
      await compose(id, ["down", "--remove-orphans"], { timeout: 120_000, progress }).catch(() => {});
      recentlyTouched.add(id);
      if (!directoryExisted) await rm(dirFor(id), { recursive: true, force: true }).catch(() => {});
      throw keepTimeout(error, new Error(`${manifest.name} installation failed and was rolled back. ${error.message}`));
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
   * Build an installed app's container again when it has none (M35).
   *
   * The owner's server listed six apps as installed while Docker had no container for any of them.
   * BoxPilot's record of an install is the app's boxpilot.json, and a container can go without it:
   * `docker system prune` removes every stopped container (BoxPilot's own "Clean up Docker disk
   * space" runs it), and so does removing one by hand or from another compose tool. The data folder
   * and the compose project are still there, so install refused ("already installed") and Start had
   * nothing to start. This brings the container back from what was saved: the compose project as it
   * is, or, when that file is gone too, written again from the catalog with the saved settings on
   * the image the app last ran. The data is used as it is; nothing is reset or deleted.
   *
   * `start: false` builds the container and leaves it stopped (`up --no-start`), for an app the
   * owner had stopped on purpose: it comes back exactly as it was left.
   */
  async function reinstall({ id, devices = null, start = true }, { progress = null, timeScale = 1 } = {}) {
    const manifest = await ensureManifest(id);
    const state = await readState(id);
    if (!state?.installed) throw new Error(`${manifest.name} is not installed; install it from the App catalog`);
    const before = await containerStatus(id);
    if (before.exists) throw new Error(`${manifest.name} already has a container (${before.status}); start or restart it instead`);
    const saved = await readProjectFiles(id);
    let rewritten = false;
    if (saved.compose === null) {
      // As update does: settings a catalog revision has dropped are dropped, not a reason to refuse.
      const existingEnv = await readEnv(id);
      const { values, errors } = resolveValues(manifest, withSavedSecrets(manifest, sanitizeStoredValues(manifest, state.values ?? {}), existingEnv));
      if (errors.length) throw new Error(`${manifest.name}'s saved settings no longer fit the catalog (${errors.join("; ")}); uninstall it and install it again from the App catalog`);
      const savedImage = catalogImagePin(state.image?.reference, manifest.image.reference, manifest.image.formerRepositories);
      const pinned = savedImage ? { ...manifest, image: { ...manifest.image, reference: savedImage } } : manifest;
      progress?.(`${manifest.name}'s compose project is gone too; writing it again from its saved settings, on ${pinned.image.reference}`, "stdout");
      await writeProject(pinned, values, { existingEnv, devices });
      rewritten = true;
    } else {
      progress?.(`Building ${manifest.name}'s container again from its saved project, ${path.join(dirFor(id), "compose.yaml")}`, "stdout");
    }
    // Ports are bound when a container starts, not when it is created, so only a start is checked.
    const project = rewritten ? await readFileWithoutFollowing(path.join(dirFor(id), "compose.yaml")).catch(() => "") : saved.compose;
    const ports = start ? await assertPortsFree(manifest, project, { progress, refused: `${manifest.name} was not started again; nothing was built. Its data folder and saved settings are as they were.` }) : null;
    // `up` pulls the image first when a prune took it along with the container.
    const upBudgetMs = scaled(15 * 60_000, timeScale);
    const up = await compose(id, start ? ["up", "--detach", "--remove-orphans"] : ["up", "--no-start", "--remove-orphans"], { timeout: upBudgetMs, progress });
    try {
      if (!up.ok) throw stepTimedOut(up, start ? "Downloading the image and starting the app" : "Downloading the image and creating the container", upBudgetMs) ?? await bindFailure(manifest, up.stderr, project, "Docker could not publish its ports.") ?? new Error(`docker compose up failed: ${redact(up.stderr).split("\n").slice(-4).join(" ")}`);
      if (!start) {
        const created = await containerStatus(id);
        if (!created.exists) throw new Error("docker compose made no container");
        progress?.(`${manifest.name}'s container is back, stopped as you left it`, "stdout");
        await writeState(id, { ...state, updatedAt: clock().toISOString() });
        return { reinstalled: true, started: false, id, name: manifest.name, projectRewritten: rewritten, status: created.status };
      }
      const status = await waitHealthy(manifest, progress);
      progress?.(`${manifest.name} is up again`, "stdout");
      await writeState(id, { ...state, updatedAt: clock().toISOString() });
      await refreshHomepage(id, progress);
      return { reinstalled: true, started: true, id, name: manifest.name, projectRewritten: rewritten, image: status.image, health: status.health, ...withPortWarnings(ports) };
    } catch (error) {
      progress?.(`${manifest.name} did not come up: ${error.message}. Taking down what started...`, "stderr");
      await compose(id, ["down", "--remove-orphans"], { timeout: 120_000, progress }).catch(() => {});
      recentlyTouched.add(id);
      throw keepTimeout(error, new Error(`${manifest.name} could not be ${start ? "started" : "created"} again, so what ${start ? "started" : "was made"} was taken down. Its data folder and saved settings are as they were. ${error.message}`));
    }
  }

  async function update({ id, devices = null }, { progress = null, checkpoint: takeCheckpoint = true, timeScale = 1 } = {}) {
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
    const { values, errors } = resolveValues(manifest, withSavedSecrets(manifest, sanitizeStoredValues(manifest, state.values ?? {}), await readEnv(id)));
    if (errors.length) throw new Error(`Stored settings no longer match the manifest: ${errors.join("; ")}`);
    const saved = takeCheckpoint ? await checkpoint({ id, reason: "update" }, { progress }) : null;
    // What is running right now, read from the deployed compose file before it is overwritten. This
    // is the only exact record: the manifest below has already moved to the new tags, and stored
    // state carries the app's own image but never its sidecars'.
    const previous = await readProjectFiles(id);
    const runningBefore = deployedImages(previous.compose ?? "");
    const digestsBefore = await runningDigests(id, runningBefore);
    try {
      await writeProject(manifest, values, { existingEnv: await readEnv(id), devices }); // picks up manifest changes (new image tag)
      declaredUserCache.delete(manifest.image.reference); declaredOwnerCache.delete(manifest.image.reference);   // a pull can change the image's USER
      const pullBudgetMs = scaled(30 * 60_000, timeScale);
      const pull = await compose(id, ["pull"], { timeout: pullBudgetMs, progress });
      if (!pull.ok) throw stepTimedOut(pull, "Downloading the new images", pullBudgetMs) ?? new Error(`docker compose pull failed: ${redact(pull.stderr).split("\n").slice(-3).join(" ")}`);
      // `up` recreates the containers, which lets go of their ports and binds them again: something
      // waiting for one (Tailscale Serve on the same port) takes it in between.
      await assertPortsFree(manifest, await readFileWithoutFollowing(path.join(dirFor(id), "compose.yaml")).catch(() => ""), { progress, refused: "Its ports are not free." });
    } catch (error) {
      // Nothing has been restarted yet, so the containers still run the old version: put the files
      // that describe them back, or the next restart would quietly move the app forward.
      await restoreProjectFiles(id, previous).catch(() => {});
      throw keepTimeout(error, new Error(`${manifest.name} update failed before anything was restarted; the app was unchanged. ${error.message}`));
    }
    const upBudgetMs = scaled(15 * 60_000, timeScale);
    const up = await compose(id, ["up", "--detach", "--remove-orphans"], { timeout: upBudgetMs, progress });
    try {
      if (!up.ok) throw stepTimedOut(up, "Starting the new version", upBudgetMs) ?? new Error(`docker compose up failed: ${redact(up.stderr).split("\n").slice(-4).join(" ")}`);
      const status = await waitHealthy(manifest, progress);
      const deployedNow = deployedImages(await readFileWithoutFollowing(path.join(dirFor(id), "compose.yaml")).catch(() => ""));
      // Keep what it came from, so going back is a click rather than an archaeology exercise. Only
      // when something actually moved: re-running an update that changes nothing is not history.
      const movedFrom = Object.fromEntries(Object.entries(runningBefore).filter(([service, reference]) => deployedNow[service] !== reference));
      const history = Object.keys(movedFrom).length
        ? [{ at: clock().toISOString(), from: movedFrom, ...digestsOf(digestsBefore, movedFrom), to: Object.fromEntries(Object.keys(movedFrom).map((service) => [service, deployedNow[service] ?? null])) }, ...(state.updateHistory ?? [])].slice(0, updateHistoryLimit)
        : state.updateHistory ?? [];
      await writeState(id, { ...state, updatedAt: clock().toISOString(), manifestSha256: manifest.sha256 ?? null, image: { reference: manifest.image.reference, id: status.image }, values: storableValues(manifest, values, values.env), pinnedRollback: false, updateHistory: history });
      return { updated: true, id, previousImage: before.image, image: status.image, changed: before.image !== status.image, previousReference: runningBefore[id] ?? state.image?.reference ?? null, reference: manifest.image.reference, checkpoint: saved };
    } catch (error) {
      let rolledBack = false;
      progress?.(`Update failed: ${error.message}. Restoring previous image...`, "stderr");
      // Pin the exact images that were running. If that cannot be written, the compose file that
      // was deployed before is the next best thing; never start the version that just failed again.
      let pinnedImages = false;
      if (before.image) {
        const pinned = {
          ...manifest,
          image: { ...manifest.image, reference: before.image },
          sidecars: (manifest.sidecars ?? []).map((sidecar) => (beforeSidecars[sidecar.id] ? { ...sidecar, image: beforeSidecars[sidecar.id] } : sidecar)),
        };
        pinnedImages = await writeProject(pinned, values, { existingEnv: await readEnv(id), devices }).then(() => true, () => false);
      }
      const restored = pinnedImages || await restoreProjectFiles(id, previous).then(() => previous.compose !== null, () => false);
      if (restored) {
        const rollback = await compose(id, ["up", "--detach", "--remove-orphans"], { timeout: 10 * 60_000, progress });
        rolledBack = rollback.ok;
        if (rolledBack && pinnedImages) await writeState(id, { ...state, pinnedRollback: true, image: { reference: before.image, id: before.image } }).catch(() => {});
      }
      // rolledBack says which in a field the job records from, rather than reading it from the words.
      throw keepTimeout(error, Object.assign(new Error(`${manifest.name} update failed${rolledBack ? "; the previous image was restored" : " and automatic rollback also failed"}. ${error.message}`), { rolledBack }));
    }
  }

  /**
   * Put an app back on the versions it was running before its last update (M22.2).
   *
   * The failure path inside update() already knows how to redeploy a pinned image; this is the same
   * move made deliberately, for the update that succeeded and turned out wrong two days later. It
   * takes no image from the caller — only what this app's own history records — so it can restore a
   * previous version and nothing else. Catalog references are version tags, never `latest`, so the
   * old image is re-pullable even after an unused-image prune has removed it locally.
   */
  async function rollbackApp({ id, at = null, devices = null }, { progress = null, checkpoint: takeCheckpoint = true, timeScale = 1 } = {}) {
    const manifest = await ensureManifest(id);
    const state = await readState(id);
    if (!state?.installed) throw new Error(`${manifest.name} is not installed`);
    const history = state.updateHistory ?? [];
    // `at` names one of this app's own recorded updates, so stepping back several releases is still
    // only ever a version it actually ran. Without it, take the newest *update* — never a rollback.
    // After a rollback, history[0] describes the version just left behind, so choosing it would
    // redeploy exactly what the owner was escaping and report that as success.
    const last = at ? history.find((entry) => entry.at === at) : history.find((entry) => !entry.rolledBack);
    if (at && !last) throw new Error(`${manifest.name} has no recorded version from ${at} to go back to`);
    if (!last || !Object.keys(last.from ?? {}).length) throw new Error(`${manifest.name} has not been updated since it was installed, so there is nothing to go back to`);

    // Only services this manifest still builds can be pinned. A recorded version naming a sidecar
    // the catalog has since dropped would otherwise redeploy the current images and report the old
    // ones restored, leaving the app on the release being escaped with a success message.
    // And only to that service's own catalog image: the history lives in boxpilot.json, which a
    // restored backup brings with it.
    const catalogImageOf = (service) => (service === id ? manifest.image.reference : (manifest.sidecars ?? []).find((sidecar) => sidecar.id === service)?.image ?? null);
    const pinFor = (service, reference) => catalogImageOf(service) !== null && catalogImagePin(reference, catalogImageOf(service), service === id ? manifest.image.formerRepositories : []);
    // The digest recorded beside the tag is the exact image that ran; history written before
    // digests were recorded has only the tag. The digest is held to the same repository rule.
    const restoreTo = Object.fromEntries(Object.entries(last.from).filter(([service, reference]) => pinFor(service, reference))
      .map(([service, reference]) => [service, pinFor(service, last.fromDigest?.[service]) && sameTag(last.fromDigest[service], reference) ? last.fromDigest[service] : reference]));
    if (!Object.keys(restoreTo).length) throw new Error(`${manifest.name} has no recorded version that still matches how it is built today, so there is nothing to go back to`);

    const { values, errors } = resolveValues(manifest, withSavedSecrets(manifest, sanitizeStoredValues(manifest, state.values ?? {}), await readEnv(id)));
    if (errors.length) throw new Error(`Stored settings no longer match the manifest: ${errors.join("; ")}`);
    // Pin every service that moved, app and sidecars alike: restoring the app onto an upgraded
    // database is how a rollback reports success and leaves the app unable to read its own data.
    const pinned = {
      ...manifest,
      ...(restoreTo[id] ? { image: { ...manifest.image, reference: restoreTo[id] } } : {}),
      sidecars: (manifest.sidecars ?? []).map((sidecar) => (restoreTo[sidecar.id] ? { ...sidecar, image: restoreTo[sidecar.id] } : sidecar)),
    };
    const saved = takeCheckpoint ? await checkpoint({ id, reason: "going back a version" }, { progress }) : null;
    // What is deployed right now, which is what this rollback moves away from. Stepping back several
    // releases means the entry being undone describes an older hop, so its `to` is not where the app
    // actually is — reading the deployed file is the only answer that stays true at any depth.
    const previous = await readProjectFiles(id);
    const runningBefore = deployedImages(previous.compose ?? "");
    const digestsBefore = await runningDigests(id, runningBefore);
    const restoring = Object.entries(restoreTo).map(([service, reference]) => `${service} to ${reference}`).join(", ");
    progress?.(`Putting ${manifest.name} back: ${restoring}`, "stdout");
    let started = false;
    let status;
    try {
      await writeProject(pinned, values, { existingEnv: await readEnv(id), devices });
      // Pull explicitly: the previous image is unused after an update, so a prune may have removed it.
      declaredUserCache.delete(manifest.image.reference); declaredOwnerCache.delete(manifest.image.reference);   // a pull can change the image's USER
      const pullBudgetMs = scaled(30 * 60_000, timeScale);
      const pull = await compose(id, ["pull"], { timeout: pullBudgetMs, progress });
      if (!pull.ok) throw stepTimedOut(pull, "Downloading the previous version", pullBudgetMs) ?? new Error(`Could not fetch the previous version: ${redact(pull.stderr).split("\n").slice(-3).join(" ")}`);
      started = true;
      const upBudgetMs = scaled(15 * 60_000, timeScale);
      const up = await compose(id, ["up", "--detach", "--remove-orphans"], { timeout: upBudgetMs, progress });
      if (!up.ok) throw stepTimedOut(up, "Starting the previous version", upBudgetMs) ?? new Error(`${manifest.name} would not start on the previous version: ${redact(up.stderr).split("\n").slice(-4).join(" ")}`);
      status = await waitHealthy(manifest, progress);
    } catch (error) {
      // Put back the compose file this app was running, as reconfigure and a compose edit do, and
      // start it again if the attempt got as far as replacing the containers.
      const restored = await restoreProjectFiles(id, previous).then(() => previous.compose !== null, () => false);
      if (!started) throw keepTimeout(error, new Error(`${manifest.name} could not go back a version; the app was unchanged. ${error.message}`));
      progress?.(`Going back failed: ${error.message}. Restoring the version it was on...`, "stderr");
      const back = restored && (await compose(id, ["up", "--detach", "--remove-orphans"], { timeout: 10 * 60_000, progress })).ok;
      throw keepTimeout(error, new Error(`${manifest.name} could not go back a version${back ? "; the version it was on was restored" : " and restoring the version it was on also failed"}. ${error.message}`));
    }
    // The rollback is itself an entry, so going back twice steps back twice rather than ping-ponging.
    const movedFrom = Object.fromEntries(Object.keys(restoreTo).map((service) => [service, runningBefore[service] ?? last.to?.[service] ?? null]));
    const entry = { at: clock().toISOString(), from: movedFrom, ...digestsOf(digestsBefore, movedFrom), to: restoreTo, rolledBack: true };
    await writeState(id, {
      ...state,
      updatedAt: clock().toISOString(),
      image: { reference: restoreTo[id] ?? state.image?.reference ?? null, id: status.image },
      pinnedRollback: true,
      // Entries newer than the one undone describe versions this app is no longer on, so they are
      // dropped rather than left ahead of the current state where "go back" would offer them again.
      updateHistory: [entry, ...history.slice(history.indexOf(last) + 1)].slice(0, updateHistoryLimit),
    });
    progress?.(`${manifest.name} is back on ${restoreTo[id] ?? "its previous version"}`, "stdout");
    return { rolledBack: true, id, restored: restoreTo, from: movedFrom, checkpoint: saved };
  }

  /**
   * @param {{ id: string, values?: { ports?: object, env?: object, volumes?: object, setup?: any, exposure?: any, networkMode?: string }, devices?: any }} request
   * @param {{ progress?: ((line: string, stream: string) => void) | null, checkpoint?: boolean }} [options]
   */
  async function reconfigure({ id, values: rawValues = {}, devices = null }, { progress = null, checkpoint: takeCheckpoint = true } = {}) {
    const manifest = await ensureManifest(id);
    const state = await readState(id);
    if (!state?.installed) throw new Error(`${manifest.name} is not installed`);
    // What is not being changed stays as it is. A caller that only flips one thing (the exposure
    // toggle) used to reset everything else to catalog defaults: the owner's VPN provider, their
    // folders, their ports, all silently gone. The stored values are the baseline; the request
    // overrides only what it names. Saved settings a catalog release has since dropped are dropped
    // here too, as update does: merged back in raw, every Settings, Reach or password change of
    // such an app failed with "is not a setting of this application".
    const stored = sanitizeStoredValues(manifest, state.values ?? {});
    const merged = {
      ports: { ...stored.ports, ...rawValues.ports },
      env: { ...stored.env, ...rawValues.env },
      volumes: { ...stored.volumes, ...rawValues.volumes },
      setup: rawValues.setup ?? stored.setup,
      exposure: rawValues.exposure ?? stored.exposure,
      networkMode: rawValues.networkMode ?? stored.networkMode,
    };
    // A secret the request does not re-enter is the one in .env (withSavedSecrets): a settings change
    // never asks for the tunnel token again.
    const previousEnv = await readFileWithoutFollowing(path.join(dirFor(id), ".env")).catch(() => "");
    const { values, errors } = resolveValues(manifest, withSavedSecrets(manifest, merged, parseEnvFile(previousEnv)));
    if (errors.length) throw new Error(`Invalid settings: ${errors.join("; ")}`);
    // An app already saved that way (before this was refused) keeps its other settings changeable;
    // Reach's Home network is how it leaves that state.
    const storedOnHost = (stored.networkMode ?? manifest.network) === "host";
    const refusal = storedOnHost && stored.exposure === "tailnet" ? null : hostNetworkTailnetRefusal(manifest, values, { switchingNetwork: !storedOnHost });
    if (refusal) throw new Error(refusal);
    const saved = takeCheckpoint ? await checkpoint({ id, reason: "settings change" }, { progress }) : null;
    const previousCompose = await readFileWithoutFollowing(path.join(dirFor(id), "compose.yaml")).catch(() => null);
    const rendered = await writeProject(manifest, values, { existingEnv: parseEnvFile(previousEnv), devices });
    // The new ports are checked before the containers are recreated. Putting a served app on the
    // home network (every address) while Serve still holds its port on the tailnet address is the
    // Dockge trap: refused here, with the old files back, rather than found by a failed `up` whose
    // rollback then fails the same way.
    let ports;
    try {
      ports = await assertPortsFree(manifest, rendered.composeYaml, { progress, refused: `${manifest.name}'s settings were not changed; nothing was restarted.` });
    } catch (error) {
      if (previousCompose !== null) await restoreProjectFiles(id, { compose: previousCompose, env: previousEnv }).catch(() => {});
      throw error;
    }
    const up = await compose(id, ["up", "--detach", "--remove-orphans"], { timeout: 15 * 60_000, progress });
    try {
      if (!up.ok) throw await bindFailure(manifest, up.stderr, rendered.composeYaml, "Docker could not publish its ports.") ?? new Error(`docker compose up failed: ${redact(up.stderr).split("\n").slice(-4).join(" ")}`);
      await waitHealthy(manifest, progress);
      await writeState(id, { ...state, updatedAt: clock().toISOString(), values: storableValues(manifest, values, rendered.env) });
      const setup = await applySetup(manifest, values, progress);
      return { reconfigured: true, id, hostPorts: rendered.hostPorts, checkpoint: saved, setup, ...withPortWarnings(ports) };
    } catch (error) {
      let rolledBack = false;
      if (previousCompose !== null) {
        await replaceFileWithoutFollowing(path.join(dirFor(id), "compose.yaml"), previousCompose, { mode: 0o600 });
        await replaceFileWithoutFollowing(path.join(dirFor(id), ".env"), previousEnv, { mode: 0o600 });
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
    const previous = await readFileWithoutFollowing(target).catch(() => null);
    if (previous === null) throw new Error("There is no compose.yaml to edit");
    const saved = takeCheckpoint ? await checkpoint({ id, reason: "compose edit" }, { progress }) : null;
    await replaceFileWithoutFollowing(target, composeText, { mode: 0o600 });
    const check = await compose(id, ["config", "--quiet"], { timeout: 60_000, progress });
    if (!check.ok) {
      await replaceFileWithoutFollowing(target, previous, { mode: 0o600 });
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
      await replaceFileWithoutFollowing(target, previous, { mode: 0o600 });
      const rolledBack = (await compose(id, ["up", "--detach", "--remove-orphans"], { timeout: 10 * 60_000, progress })).ok;
      throw Object.assign(new Error(`${manifest.name} rejected the edited compose file${rolledBack ? "; the previous one was restored" : " and automatic rollback also failed"}. ${error.message}`), { rolledBack });
    }
  }

  async function action({ id, action: verb }, { progress = null } = {}) {
    const manifest = await ensureManifest(id);
    if (!actions.includes(verb)) throw new Error("Action must be start, stop, restart, pause, or unpause");
    const state = await readState(id);
    if (!state?.installed) throw new Error(`${manifest.name} is not installed`);
    // A container removed outright (M35): `docker system prune` deletes every stopped container,
    // and `compose start` then has nothing to start. Start and restart build it again from the saved
    // compose project, which is what they mean; the data is in volumes and folders a prune leaves.
    let project = null;
    let ports = null;
    if (verb === "start" || verb === "restart") {
      const before = await containerStatus(id);
      project = (await readProjectFiles(id)).compose;
      const refused = `${manifest.name} was not ${verb === "start" ? "started" : "restarted"}.`;
      if (!before.exists) {
        if (project === null) throw new Error(`${manifest.name} has no container and its compose project is gone too; use Reinstall in Repair, which writes it again from the saved settings`);
        progress?.(`${manifest.name} has no container (removed while it was stopped); building it again from its saved compose project.`, "stdout");
        ports = await assertPortsFree(manifest, project, { progress, refused });
        const up = await compose(id, ["up", "--detach", "--remove-orphans"], { timeout: 15 * 60_000, progress });
        if (!up.ok) throw await bindFailure(manifest, up.stderr, project, refused) ?? new Error(`docker compose up failed: ${redact(up.stderr).split("\n").slice(-3).join(" ")}`);
        const status = await containerStatus(id);
        return { id, action: verb, running: status.running, status: status.status, recreated: true, ...withPortWarnings(ports) };
      }
      // Starting what already runs binds nothing. A restart lets go of every port and binds it again,
      // which is when something waiting for one takes it.
      if (project !== null && (verb === "restart" || !before.running)) ports = await assertPortsFree(manifest, project, { progress, refused });
    }
    let result = await compose(id, [verb], { timeout: 180_000, progress });
    // A stopped container is pinned to the network it was created on, and anything that prunes
    // Docker — `docker system prune`, Portainer, a compose UI the owner runs themselves — takes
    // that network with it, because nothing running is attached. Starting then fails with a
    // network ID that no longer exists, and plain `up` cannot fix it either: the container has to
    // be built again. Its data is in volumes and bind mounts, so that costs nothing but a moment.
    if (!result.ok && verb !== "stop" && /network [0-9a-f]{12,}.*not found|has active endpoints/i.test(result.stderr)) {
      progress?.(`${manifest.name}'s network was removed while it was stopped; building the container again.`, "stdout");
      result = await compose(id, ["up", "--detach", "--force-recreate", "--remove-orphans"], { timeout: 15 * 60_000, progress });
    }
    if (!result.ok) throw (project !== null ? await bindFailure(manifest, result.stderr, project, `${manifest.name} was not ${verb === "start" ? "started" : "restarted"}.`) : null) ?? new Error(`docker compose ${verb} failed: ${redact(result.stderr).split("\n").slice(-3).join(" ")}`);
    const status = await containerStatus(id);
    return { id, action: verb, running: status.running, status: status.status, ...withPortWarnings(ports) };
  }

  /**
   * Run one fixed command inside an installed app's running container, as a named user, for an
   * operation written for that app (Zulip's manage.py). Nothing here reaches a job log: the output
   * can be a one-time link or an API key, so the caller decides what, if anything, is kept.
   */
  async function execIn({ id, service = null, user, argv, env = {}, timeoutMs = 120_000 }) {
    const manifest = await ensureManifest(id);
    const target = service ?? manifest.id;
    if (target !== manifest.id && !(manifest.sidecars ?? []).some((sidecar) => sidecar.id === target)) throw new Error(`${manifest.name} has no service called ${target}`);
    if (typeof user !== "string" || !/^[a-z_][a-z0-9_-]{0,31}$/.test(user)) throw new Error("The user to run as is invalid");
    if (!Array.isArray(argv) || !argv.length || argv.length > 32 || argv.some((part) => typeof part !== "string" || part.length > 16_384 || part.includes("\0"))) throw new Error("The command is invalid");
    const pairs = Object.entries(env ?? {});
    if (pairs.length > 16 || pairs.some(([name, value]) => !/^[A-Z][A-Z0-9_]{0,63}$/.test(name) || typeof value !== "string" || value.length > 4096 || /[\0\r\n]/.test(value))) throw new Error("The command's environment is invalid");
    const state = await readState(id);
    if (!state?.installed) throw new Error(`${manifest.name} is not installed`);
    const status = await containerStatus(target === manifest.id ? id : `${id}-${target}`);
    if (!status.running) throw new Error(`${manifest.name} is not running; start it and try again`);
    const flags = pairs.flatMap(([name, value]) => ["--env", `${name}=${value}`]);
    const result = await compose(id, ["exec", "-T", "--user", user, ...flags, target, ...argv], { timeout: timeoutMs });
    return { ok: result.ok, stdout: String(result.stdout ?? ""), stderr: String(result.stderr ?? ""), timedOut: Boolean(result.timedOut) };
  }

  /** @param {{ id: string, lines?: number | string, container?: string | null }} request */
  async function logs({ id, lines = 200, container = null }) {
    const manifest = await ensureManifest(id);
    // The tunnel's log is where the public IP and every connection problem lives, and the notes
    // kept telling the owner to read it while the Logs button could only show the app container.
    let name = projectNameFor(id);
    if (container) {
      if (!(manifest.sidecars ?? []).some((sidecar) => sidecar.id === container)) throw new Error(`${manifest.name} has no helper container named ${container}`);
      name = projectNameFor(`${id}-${container}`);
    }
    const tail = Math.min(Math.max(Number.parseInt(String(lines), 10) || 200, 1), 1000);
    const result = await docker(["logs", "--tail", String(tail), "--timestamps", name], { timeout: 30_000 });
    if (!result.ok && !result.stdout) throw new Error(`docker logs failed: ${redact(result.stderr).split("\n").slice(-2).join(" ")}`);
    const entries = `${result.stdout}\n${result.stderr}`.split("\n").filter(Boolean).map(redact).slice(-tail);
    return { id, container: container ?? null, lines: entries };
  }

  /**
   * Where a tunneled app's traffic leaves, read from the tunnel container's own log: the public
   * IP gluetun verified and the place it belongs to, next to whether the tunnel is even running.
   */
  async function vpnStatus({ id }) {
    const manifest = await ensureManifest(id);
    if (!manifest.networkVia) return { id, tunneled: false };
    const state = await readState(id);
    if (!state?.installed) return { id, tunneled: true, running: false, exit: null };
    const status = await containerStatus(`${id}-${manifest.networkVia}`);
    const result = await docker(["logs", "--tail", "300", "--timestamps", projectNameFor(`${id}-${manifest.networkVia}`)], { timeout: 30_000 });
    const exit = parseExit(`${result.stdout}\n${result.stderr}`);
    const forwardedPort = parseForwardedPort(`${result.stdout}\n${result.stderr}`);
    return { id, tunneled: true, sidecarId: manifest.networkVia, running: status.running && status.status === "running", status: status.status, exit, forwardedPort };
  }

  /**
   * The kill-switch drill (M17.3): force the tunnel down for a few seconds, prove nothing leaks,
   * bring it back, and record the whole thing. The claim "if the VPN drops, downloads stop
   * instead of leaking" becomes a recorded fact for this install, the way a restore drill makes
   * "backups work" a fact. Every command runs inside the app's own network namespace via docker
   * exec, which is also why the helper's own network isolation is no obstacle.
   *
   * The restore is attempted no matter what went wrong in between: a drill that leaves the
   * tunnel down has failed at its one job.
   */
  async function vpnKillSwitchDrill({ id }, { progress = null } = {}) {
    const manifest = await ensureManifest(id);
    if (!manifest.networkVia) throw new Error(`${manifest.name} does not run through a VPN tunnel`);
    const state = await readState(id);
    if (!state?.installed) throw new Error(`${manifest.name} is not installed`);
    const name = projectNameFor(id);
    const inTunnel = (args, timeout = 10_000) => docker(["exec", name, ...args], { timeout });
    const control = async (method, path, body = null) => {
      const args = ["curl", "-m", "5", "-sS", ...(method === "PUT" ? ["-X", "PUT", "-d", body] : []), `http://127.0.0.1:8000${path}`];
      const result = await inTunnel(args);
      if (!result.ok) throw new Error(`The tunnel's control endpoint did not answer (${redact(result.stderr).slice(-120)})`);
      try { return JSON.parse(result.stdout); } catch { throw new Error("The tunnel's control endpoint answered with something unreadable"); }
    };

    const hasCurl = await inTunnel(["curl", "--version"], 10_000);
    if (!hasCurl.ok) throw new Error(`${manifest.name}'s image carries no curl, which the drill needs to speak to the tunnel from inside`);
    const status = await control("GET", "/v1/vpn/status");
    if (status.status !== "running") throw new Error(`The tunnel is not running (${status.status ?? "unknown"}); there is nothing to drill`);
    const before = await control("GET", "/v1/publicip/ip").catch(() => null);
    progress?.(`Tunnel up${before?.public_ip ? `, exiting at ${before.public_ip} (${before.country ?? "?"})` : ""}. Forcing it down...`, "stdout");

    const stoppedAt = clock().getTime();
    await control("PUT", "/v1/vpn/status", '{"status":"stopped"}');
    let leaked = false;
    let restored = false;
    try {
      await wait(2000);
      // The one question: with the tunnel down, can anything get out? A firewall that holds
      // answers with silence; an answer from the internet is a leak.
      const probe = await inTunnel(["curl", "-m", "4", "-sS", "-o", "/dev/null", "-w", "%{http_code}", "https://1.1.1.1/"], 12_000);
      leaked = probe.ok && /^[1-5]\d\d$/.test(probe.stdout.trim());
      progress?.(leaked ? "LEAK: the internet answered while the tunnel was down." : "Nothing left while the tunnel was down; the kill switch held.", leaked ? "stderr" : "stdout");
    } finally {
      await control("PUT", "/v1/vpn/status", '{"status":"running"}').catch(() => {});
      for (let attempt = 0; attempt < 15; attempt += 1) {
        const back = await control("GET", "/v1/vpn/status").catch(() => null);
        if (back?.status === "running") { restored = true; break; }
        await wait(2000);
      }
    }
    const downForMs = clock().getTime() - stoppedAt;
    if (!restored) throw new Error("The tunnel did not come back after the drill; restart the app. The drill result was not recorded as a pass.");
    let after = null;
    for (let attempt = 0; attempt < 10 && !after?.public_ip; attempt += 1) {
      await wait(2000);
      after = await control("GET", "/v1/publicip/ip").catch(() => null);
    }
    progress?.(`Tunnel restored${after?.public_ip ? `, exiting at ${after.public_ip} (${after.country ?? "?"})` : ""}.`, "stdout");
    return {
      id, held: !leaked, leaked, restored, downForMs,
      exitBefore: before?.public_ip ?? null, exitAfter: after?.public_ip ?? null,
      verdict: leaked
        ? "LEAKED: something reached the internet while the tunnel was down. Do not rely on this tunnel; check the app's network settings."
        : `The kill switch held: nothing left this app while the tunnel was down for ${(downForMs / 1000).toFixed(1)}s, and the tunnel came back on its own.`,
    };
  }

  // Compose projects BoxPilot did not create (app-foreign-projects.mjs).
  const { foreignProjects, foreignProjectAction, foreignProjectLogs } = createForeignProjects({ docker, redact });

  async function readConfigurationFile(id, name) {
    const directory = await lstat(dirFor(id));
    if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error("Application configuration requires a real project directory");
    const handle = await open(path.join(dirFor(id), name), fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
    try {
      const metadata = await handle.stat();
      const limit = 64 * 1024;
      if (!metadata.isFile() || metadata.size > limit) throw new Error("Configuration must be a regular file no larger than 64 KiB");
      const buffer = Buffer.alloc(limit + 1);
      let total = 0;
      while (total < buffer.length) {
        const { bytesRead } = await handle.read(buffer, total, buffer.length - total, total);
        if (!bytesRead) break;
        total += bytesRead;
      }
      if (total > limit) throw new Error("Configuration exceeded its 64 KiB read limit");
      return buffer.subarray(0, total).toString("utf8");
    } finally { await handle.close(); }
  }

  /** Raw Compose can contain arbitrary inline credentials, so only the elevated owner operation calls this. */
  async function readComposeConfig({ id }) {
    const manifest = await ensureManifest(id);
    if (!(await readState(id))?.installed) throw new Error(`${manifest.name} is not installed`);
    return { id, compose: await readConfigurationFile(id, "compose.yaml") };
  }

  /** Viewer-readable settings. Unknown .env entries are private; raw Compose has a separate owner read. */
  async function config({ id }) {
    const manifest = await ensureManifest(id);
    const state = await readState(id);
    if (!state?.installed) throw new Error(`${manifest.name} is not installed`);
    const text = await readConfigurationFile(id, ".env").catch((error) => { if (error.code === "ENOENT") return ""; throw error; });
    const env = parseEnvFile(text);
    const publicNames = new Set(manifest.env.filter((entry) => !entry.secret && entry.type !== "password").map((entry) => entry.name));
    const entries = Object.keys(env).sort().map((name) => ({ name, value: publicNames.has(name) ? env[name] : "••••••••", secret: !publicNames.has(name) }));
    return { id, name: manifest.name, compose: null, composeProtected: true, env: entries, directory: dirFor(id) };
  }

  /**
   * This server's own tailnet address, for ports that have to move somewhere reachable but cannot
   * go through Serve. Null when Tailscale is absent or not up.
   *
   * Only an answer is remembered, and only for a minute: the helper usually starts before
   * Tailscale does, and remembering "no address" from then meant every later deploy treated the
   * server as having no tailnet at all.
   */
  const tailnetCacheMs = 60_000;
  const tailnetCache = { address: null, dnsName: null };
  const cachedTailnet = (key) => (tailnetCache[key] && clock().getTime() - tailnetCache[key].at < tailnetCacheMs ? tailnetCache[key].value : null);
  const rememberTailnet = (key, value) => { tailnetCache[key] = value ? { value, at: clock().getTime() } : null; return value; };
  async function tailnetAddress() {
    const cached = cachedTailnet("address");
    if (cached) return cached;
    const result = await runCommand(tailscaleBinary, ["ip", "-4"], { timeout: 15_000 }).catch(() => ({ ok: false, stdout: "" }));
    const address = result.ok ? (result.stdout.split("\n").map((line) => line.trim()).find((line) => /^\d{1,3}(\.\d{1,3}){3}$/.test(line)) ?? null) : null;
    return rememberTailnet("address", address);
  }

  /**
   * The tailnet address a compose file for these values binds to. A port that moves to the tailnet
   * address has nowhere safe to go without one: the renderer would leave it on the LAN, which for
   * an app the owner set to "tailnet only" publishes it to the whole house. Refuse instead, before
   * anything is written, so the app stays exactly as it was.
   */
  async function tailnetAddressFor(manifest, values) {
    if (values.exposure !== "tailnet") return null;
    const address = await tailnetAddress();
    if (address) return address;
    const network = (manifest.networkModes ?? [manifest.network]).includes(values.networkMode) ? values.networkMode : manifest.network;
    if (network === "host" || manifest.network === "host") return null; // no published ports to bind
    const stranded = (manifest.ports ?? []).filter((port) => port.exposure !== "loopback" && (port.tailnet ?? "serve") === "address");
    if (stranded.length) throw new Error(`${manifest.name} is set to tailnet only, but this server has no tailnet address right now (is Tailscale up?). ${stranded.map((port) => port.label ?? port.id).join(", ")} would have been left open on the home network, so nothing was changed`);
    return null;
  }

  /** This server's tailnet machine name (homebox.tail...ts.net), or null without Tailscale. */
  async function tailnetDnsName() {
    const cached = cachedTailnet("dnsName");
    if (cached) return cached;
    const result = await runCommand(tailscaleBinary, ["status", "--json"], { timeout: 15_000, maxBuffer: 4 * 1024 * 1024 }).catch(() => ({ ok: false, stdout: "" }));
    let dnsName = null;
    try { dnsName = result.ok ? (JSON.parse(result.stdout).Self?.DNSName ?? "").replace(/\.$/, "") || null : null; } catch { dnsName = null; }
    return rememberTailnet("dnsName", dnsName);
  }

  /**
   * What the reachability doctor needs to know before it probes anything: the app's containers,
   * the addresses its ports actually live on after the exposure choice, and this host's own
   * names. All of it from this helper's own records and Tailscale's answers, nothing guessed.
   */
  async function reachabilityFacts({ id }) {
    const manifest = await ensureManifest(id);
    const state = await readState(id);
    const status = await containerStatus(id);
    const sidecarNames = (manifest.sidecars ?? []).map((sidecar) => `${id}-${sidecar.id}`);
    const looked = state?.installed && sidecarNames.length ? await containerStatuses(sidecarNames) : new Map();
    const sidecars = (manifest.sidecars ?? [])
      .map((sidecar) => ({ id: sidecar.id, ...(looked.get(`${id}-${sidecar.id}`) ?? { exists: false }) }))
      .filter((entry) => entry.exists)
      .map((entry) => ({ id: entry.id, running: entry.running, status: entry.status, restarts: entry.restarts ?? 0 }));
    const serveResult = await runCommand(tailscaleBinary, ["serve", "status", "--json"], { timeout: 15_000, maxBuffer: 2 * 1024 * 1024 }).catch(() => ({ ok: false, stdout: "" }));
    const serves = serveResult.ok ? parseServeStatus(serveResult.stdout) : [];
    const tailnet = await tailnetAddress();
    const hostNetworked = (state?.values?.networkMode ?? manifest.network) === "host";
    const ports = manifest.ports.filter((port) => port.protocol !== "udp").map((port) => {
      const host = hostNetworked ? port.container : state?.values?.ports?.[port.id] ?? port.host;
      const { exposure } = bindingFor(port, state?.values?.exposure ?? "lan", { lanAddress, tailnetAddress: tailnet });
      return { id: port.id, label: port.label, host, exposure, protocol: port.protocol };
    });
    return {
      installed: Boolean(state?.installed),
      running: status.running && status.status === "running",
      sidecars, ports, serves,
      lanAddress: lanAddress && lanAddress !== "0.0.0.0" ? lanAddress : null,
      tailnetAddress: tailnet,
      tailnetDnsName: await tailnetDnsName(),
    };
  }

  // Homepage's BoxPilot group, refreshed after an install or an uninstall (app-homepage.mjs).
  const { syncHomepage, refreshHomepage } = createAppHomepage({ catalog, readState, dirFor, runCommand, tailscaleBinary, clock });

  // App backup and restore, interrupted backups and pre-change checkpoints (app-backups.mjs).
  const {
    interruptedBackups, resumeInterruptedBackup, backupMany, checkpoint, backup, countAppBackups, backupProtection, listAppBackups, verifyAppBackup,
    reviewAppBackup, reviewArchive, dataFoldersRefused, restoreAppBackup, listAppBackupFiles, restoreAppBackupPath, deleteAppBackup,
  } = createAppBackups({
    root, backupRoot, machineSnapshotRoot, tarBinary, runCommand, catalog, wait, clock, realpathOf, freeBytesOf, restoreReserveBytes, idPattern, dirFor, presentIds, readState, ensureManifest,
    containerStatus, compose, waitHealthy, assertPortsFree, renderProject, readProjectFiles, withSavedSecrets, redact, parseEnvFile, resolveExisting,
  });

  /** Generated/secret settings for an installed app, read from its .env. Only exposed to an elevated session; never stored in a job. */
  /** The port a manifest's sign-in page lives on: the one it names, else its first web port. */
  function signInPortId(manifest) {
    if (!manifest.signIn) return null;
    return manifest.signIn.port ?? manifest.ports.find((port) => port.protocol === "tcp" && port.exposure !== "loopback" && (port.tailnet ?? "serve") === "serve")?.id ?? null;
  }

  /**
   * Set the password an app's sign-in page asks for.
   *
   * A generated password lived behind the elevated Secrets view and could only be changed by
   * finding the right variable in Settings. For an app that reads it from the environment on every
   * start — Pi-hole does — this is also the only place a change sticks. The stored values carry
   * everything but secrets, and the project's .env keeps every other secret as it was.
   */
  async function setPassword({ id, password, devices = null }, { progress = null } = {}) {
    const manifest = await ensureManifest(id);
    if (!manifest.signIn?.passwordEnv) throw new Error(`${manifest.name} does not have a sign-in password BoxPilot can set`);
    if (typeof password !== "string" || password.length < 8 || password.length > 128) throw new Error("The password must be 8 to 128 characters");
    const state = await readState(id);
    if (!state?.installed) throw new Error(`${manifest.name} is not installed`);
    const stored = sanitizeStoredValues(manifest, state.values ?? {});
    const result = await reconfigure({ id, values: { ...stored, env: { ...stored.env, [manifest.signIn.passwordEnv]: password } }, devices }, { progress, checkpoint: false });
    return { id, changed: true, hostPorts: result.hostPorts };
  }

  // Language models an app runs (app-models.mjs).
  const { listModels, pullModel, removeModel, parseModelList } = createAppModels({ ensureManifest, readState, containerStatus, compose, redact, scaled, stepTimedOut });

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

  /**
   * How much disk each installed app's data folders are holding (M23.1).
   *
   * The forecast can already say a drive is filling; this is what says which app is filling it. The
   * paths are derived here from the manifests and the stored values, never taken from the request,
   * so this cannot be pointed at somewhere it should not look.
   *
   * `du` walks every inode under a folder, which on a media library is slow and, worse, unbounded.
   * Each folder therefore gets its own timeout and they are measured one at a time: a nightly
   * reading that misses one folder is fine, a nightly reading that saturates the disk is not. A
   * folder that could not be measured comes back as null rather than zero, because "we did not
   * look" and "it is empty" must not be recorded as the same thing.
   */
  async function dataUsage({ timeoutMsPerFolder = 4 * 60_000, budgetMs = 25 * 60_000 } = {}) {
    // Twenty-five folders each allowed four minutes is longer than the operation's own budget, so
    // without a deadline a slow night ends with the connection timing out and every reading thrown
    // away after doing all of the work. Folders past the deadline come back unmeasured instead,
    // which the history already knows how to skip, and the ones that were measured are kept.
    const deadline = clock().getTime() + budgetMs;
    const applications = await inspect({});
    const { manifests } = await catalog.all();
    const byId = new Map(manifests.map((manifest) => [manifest.id, manifest]));
    // The mount points that exist, so each folder can be attributed to the drive it sits on.
    const listed = await runCommand("findmnt", ["--json", "--list", "--output", "TARGET"], { timeout: 15_000 }).catch(() => null);
    let mounts = [];
    try { mounts = JSON.parse(listed?.stdout ?? "{}").filesystems?.map((row) => row.target) ?? []; } catch { mounts = []; }

    const entries = [];
    const measurements = new Map();
    let scansRun = 0;
    for (const application of applications.applications ?? []) {
      const manifest = byId.get(application.id);
      if (!manifest) continue;
      for (const folder of measurableFolders({ manifest, live: application }, { directory: dirFor(manifest.id) })) {
        // -s one total, -b in bytes, -x without crossing into another filesystem: a bind mount
        // below a data folder belongs to whatever owns it, not to the app that happens to sit above.
        let measurement = measurements.get(folder.path);
        if (!measurement) {
          const remaining = deadline - clock().getTime();
          const command = remaining > 0 ? await scanCommand(folder.path) : null;
          if (command) scansRun += 1;
          const measured = remaining <= 0 ? null
            : await runCommand(command.binary, command.args, { timeout: Math.min(timeoutMsPerFolder, remaining) }).catch(() => null);
          // Only a clean exit counts. du that hit a subtree it could not read exits non-zero and
          // still prints a total - a total missing everything it could not see. Measured on this
          // server: an unreadable folder yields "0" and exit 1. Reading that number would record the
          // folder as having emptied overnight, which is why the exit code is checked and not just
          // the output.
          const token = measured?.ok && typeof measured.stdout === "string" ? measured.stdout.trim().split(/\s+/)[0] : "";
          const bytes = /^\d+$/.test(token) ? Number(token) : NaN;
          measurement = { bytes: Number.isSafeInteger(bytes) && bytes >= 0 ? bytes : null, priority: command?.priority ?? null };
          // Failures are shared only inside this pass too. A second app must not immediately
          // repeat a four-minute failed walk of the same folder. The next pass retries it.
          measurements.set(folder.path, measurement);
        }
        entries.push({
          key: `${folder.appId}:${folder.path}`,
          appId: folder.appId,
          label: folder.label,
          path: folder.path,
          mount: mountFor(folder.path, mounts),
          ...measurement,
        });
      }
    }
    const owners = new Map();
    for (const entry of entries) {
      if (!owners.has(entry.path)) owners.set(entry.path, new Set());
      owners.get(entry.path).add(entry.appId);
    }
    for (const entry of entries) if (owners.get(entry.path).size > 1) entry.sharedWith = [...owners.get(entry.path)].sort();
    return { measuredAt: clock().toISOString(), entries, scansRun, uniquePaths: measurements.size, reusedReadings: entries.length - measurements.size };
  }

  /** Ids of the apps installed here: one directory read and one small state file each, no docker. */
  async function installedIds() {
    const ids = await presentIds();
    if (ids === null) throw new Error("The application directory could not be read; installed app statistics are unavailable");
    const installed = [];
    for (const id of ids) {
      if (!idPattern.test(id)) continue;
      const state = await readState(id);
      if (state?.installed) installed.push(id);
    }
    return installed;
  }

  return { syncHomepage, inspect, installedIds, dataUsage: shared(dataUsage), reachabilityFacts, vpnKillSwitchDrill, foreignProjects, foreignProjectAction, foreignProjectLogs, vpnStatus, listModels, pullModel, removeModel, countAppBackups, backupProtection, install, uninstall, reinstall, backupMany, interruptedBackups, waitForDocker, resumeInterruptedBackup, update, reconfigure, action, execIn, logs, config, readComposeConfig, editCompose, secrets, setPassword, backup, listAppBackups, verifyAppBackup, reviewAppBackup, reviewArchive, dataFoldersRefused, restoreAppBackup, rollbackApp, listAppBackupFiles, restoreAppBackupPath, deleteAppBackup, checkUpdates, catalogRoot: root, internals: { imageDeclaredOwner, parseModelList, containerStatus, waitHealthy, writeProject, readState, parseEnvFile } };
}
