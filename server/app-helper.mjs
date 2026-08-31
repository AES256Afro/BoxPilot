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
import { parseExit, parseForwardedPort } from "./vpn-exit.mjs";
import { bindingFor, deviceMatchesPattern, renderCompose, projectNameFor, resolveDevices } from "./catalog/compose.mjs";
import { isDeniedHostPath } from "./catalog/schema.mjs";
import { resolveValues, sanitizeStoredValues } from "./catalog/schema.mjs";
import { profileConnectionEnv, profileSecurityEnv } from "./vpn-profile.mjs";

const actions = Object.freeze(["start", "stop", "restart", "pause", "unpause"]);
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

/** "4.7 GB" as bytes. Ollama prints powers of 1000, the way the Docker CLI does. */
function parseModelSize(text) {
  const match = /^([\d.]+)\s*([KMGT]?B)$/i.exec(String(text ?? "").trim());
  if (!match) return 0;
  const scale = { B: 1, KB: 1e3, MB: 1e6, GB: 1e9, TB: 1e12 }[match[2].toUpperCase()] ?? 1;
  return Math.round(Number(match[1]) * scale);
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
  statPath = (target) => stat(target),
  tailscaleBinary = process.env.BOXPILOT_TAILSCALE_BINARY ?? "/usr/bin/tailscale",
  vpnProfile = null,
} = {}) {
  const root = path.resolve(catalogRoot);
  const dirFor = (id) => path.join(root, id);
  /** Apps whose install rolled back in this process: their containers are worth asking about even
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
      // Persist the owner's exposure and network-mode choices so the settings form reflects them
      // and a later reconfigure keeps them rather than silently reverting to the manifest default.
      ...(values.exposure ? { exposure: values.exposure } : {}),
      ...(values.networkMode ? { networkMode: values.networkMode } : {}),
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

  const declaredOwnerCache = new Map();
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
    const inspected = await docker(["image", "inspect", reference, "--format", "{{.Config.User}}"], { timeout: 30_000 });
    const declared = inspected.ok ? inspected.stdout.trim() : "";
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

  async function writeProject(manifest, values, { existingEnv = {}, devices: provided = null } = {}) {
    const directory = dirFor(manifest.id);
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
    const runsAs = managedOwner;
    for (const volume of manifest.volumes) {
      const chosen = values.volumes?.[volume.id] ?? volume.hostPath;
      // Only folders meant to hold data: every system mount a manifest declares is on the deny list.
      if (!chosen || isDeniedHostPath(chosen)) continue;
      const info = await statPath(chosen).catch(() => null);
      if (!info) {
        await mkdir(chosen, { recursive: true, mode: 0o755 }).catch(() => {});
        if (runsAs) await chownDirectory(chosen, runsAs.uid, runsAs.gid).catch(() => {});
      } else if (runsAs && runsAs.uid !== 0 && !volume.readOnly && info.uid === 0) {
        await chownDirectory(chosen, runsAs.uid, runsAs.gid).catch(() => {});
      }
    }
    for (const volume of manifest.volumes) {
      const hostPath = values.volumes?.[volume.id];
      // Only paths the owner changed are checked: the manifest's own mounts (e.g. the Docker socket, which
      // lives under /run) are curated and already carry the app's risk tier.
      if (!hostPath || hostPath === volume.hostPath) continue;
      const real = await realpath(hostPath).catch(() => hostPath);
      if (isDeniedHostPath(real)) throw new Error(`${hostPath} resolves to ${real}, a protected system location; pick a folder under /srv, /mnt, /media, or your home`);
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
    const rendered = renderCompose(manifest, values, { existingEnv, lanAddress, devices, tailnetAddress: values.exposure === "tailnet" ? await tailnetAddress() : null, sidecarEnvOverrides });
    await writeFile(path.join(directory, ".env.tmp"), rendered.envFile, { mode: 0o600 });
    await rename(path.join(directory, ".env.tmp"), path.join(directory, ".env"));
    await writeFile(path.join(directory, "compose.yaml.tmp"), rendered.composeYaml, { mode: 0o600 });
    await rename(path.join(directory, "compose.yaml.tmp"), path.join(directory, "compose.yaml"));
    // Config files shipped with the app (a prometheus.yml, a datasource yaml). Their paths were
    // validated safe and relative by the schema; each is written under the project directory and
    // mounted into the container by the compose file. Rewritten whole on every deploy, so a
    // manifest change reaches the running app.
    for (const file of rendered.files ?? []) {
      const target = path.join(directory, file.path);
      await mkdir(path.dirname(target), { recursive: true, mode: 0o755 });
      await rm(target, { force: true }).catch(() => {});
      await writeFile(target, file.content, { mode: 0o644 });
    }
    return rendered;
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
      if (reason) problems.push({ path: chosen, volume: volume.label, reason });
    }
    return problems;
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
      installed: Boolean(state && state.installed),
      dataPresent: Boolean(state),
      state: state ? { installedAt: state.installedAt, updatedAt: state.updatedAt, manifestSha256: state.manifestSha256, image: state.image, values: { ports: state.values?.ports ?? {}, env: state.values?.env ?? {}, volumes: state.values?.volumes ?? {}, setup: Array.isArray(state.values?.setup) ? state.values.setup : [] }, pinnedRollback: state.pinnedRollback ?? false, uninstalledAt: state.uninstalledAt ?? null } : null,
      container: status,
      // Only the ports that speak HTTP get an "Open" link. Listing every TCP port offered to open
      // Pi-hole's DNS on 53 and Forgejo's SSH on 2222 in a browser tab, and made the Overview's
      // link for an app whichever port happened to be listed first.
      urls: state && state.installed ? (() => {
        const hostNetworked = (state.values?.networkMode ?? manifest.network) === "host";
        return manifest.ports.filter((port) => port.protocol === "tcp" && (port.tailnet ?? "serve") === "serve").map((port) => ({ id: port.id, label: port.label, host: hostNetworked ? port.container : state.values?.ports?.[port.id] ?? port.host, exposure: port.exposure, path: signInPortId(manifest) === port.id ? manifest.signIn?.path ?? null : null }));
      })() : [],
      updateAvailable: Boolean(state?.installed && state.image?.reference && state.image.reference !== manifest.image.reference),
      installedImage: state?.image?.reference ?? null,
      folderProblems: await folderProblems(manifest, state).catch(() => []),
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
    // What is not being changed stays as it is. A caller that only flips one thing (the exposure
    // toggle) used to reset everything else to catalog defaults: the owner's VPN provider, their
    // folders, their ports, all silently gone. The stored values are the baseline; the request
    // overrides only what it names.
    const stored = state.values ?? {};
    const merged = {
      ports: { ...stored.ports, ...rawValues.ports },
      env: { ...stored.env, ...rawValues.env },
      volumes: { ...stored.volumes, ...rawValues.volumes },
      setup: rawValues.setup ?? stored.setup,
      exposure: rawValues.exposure ?? stored.exposure,
      networkMode: rawValues.networkMode ?? stored.networkMode,
    };
    const { values, errors } = resolveValues(manifest, merged);
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
    if (!actions.includes(verb)) throw new Error("Action must be start, stop, restart, pause, or unpause");
    const state = await readState(id);
    if (!state?.installed) throw new Error(`${manifest.name} is not installed`);
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
    if (!result.ok) throw new Error(`docker compose ${verb} failed: ${redact(result.stderr).split("\n").slice(-3).join(" ")}`);
    const status = await containerStatus(id);
    return { id, action: verb, running: status.running, status: status.status };
  }

  async function logs({ id, lines = 200, container = null }) {
    const manifest = await ensureManifest(id);
    // The tunnel's log is where the public IP and every connection problem lives, and the notes
    // kept telling the owner to read it while the Logs button could only show the app container.
    let name = projectNameFor(id);
    if (container) {
      if (!(manifest.sidecars ?? []).some((sidecar) => sidecar.id === container)) throw new Error(`${manifest.name} has no helper container named ${container}`);
      name = projectNameFor(`${id}-${container}`);
    }
    const tail = Math.min(Math.max(Number.parseInt(lines, 10) || 200, 1), 1000);
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

  /**
   * Compose projects on this server that BoxPilot did not create (M3.10): a stack somebody
   * started by hand in /opt or a home directory. Listed so the catalog page tells the whole
   * truth about the machine; managing them is a later, separate step.
   */
  async function foreignProjects() {
    const result = await docker(["compose", "ls", "--all", "--format", "json"], { timeout: 30_000 });
    if (!result.ok) return { available: false, projects: [] };
    let parsed;
    try { parsed = JSON.parse(result.stdout); } catch { return { available: false, projects: [] }; }
    if (!Array.isArray(parsed)) return { available: false, projects: [] };
    const projects = parsed
      // BoxPilot's own stacks are not "foreign": the per-app projects are bp-*, and a
      // compose-deployed controller's own project is "boxpilot".
      .filter((entry) => typeof entry?.Name === "string" && !entry.Name.startsWith("bp-") && entry.Name !== "boxpilot")
      .map((entry) => ({ name: entry.Name, status: entry.Status ?? "unknown", configFiles: typeof entry.ConfigFiles === "string" ? entry.ConfigFiles.split(",").map((file) => file.trim()) : [] }));
    return { available: true, projects };
  }

  /**
   * A foreign compose project resolved from `docker compose ls`, or null. The name is looked up
   * against what compose actually reports rather than trusted from the caller, so nothing can be
   * run against an arbitrary path, and BoxPilot's own projects are never treated as foreign.
   */
  async function resolveForeignProject(name) {
    if (typeof name !== "string" || !name.length || name.startsWith("bp-") || name === "boxpilot") return null;
    const { available, projects } = await foreignProjects();
    if (!available) return null;
    return projects.find((project) => project.name === name) ?? null;
  }

  /** The --file arguments for a project's compose files, from its own resolved configuration. */
  function composeFileArgs(project) {
    return project.configFiles.filter((file) => typeof file === "string" && file.startsWith("/")).flatMap((file) => ["--file", file]);
  }

  /**
   * Start, stop, or restart a compose stack BoxPilot did not create (M3.10). Lifecycle only: the
   * project's own compose files are used verbatim, so this manages what is there without adopting
   * or remodelling it.
   */
  async function foreignProjectAction({ name, action }, { progress = null } = {}) {
    if (!["start", "stop", "restart"].includes(action)) throw new Error("action must be start, stop, or restart");
    const project = await resolveForeignProject(name);
    if (!project) throw new Error(`No compose project named ${name} was found (BoxPilot's own apps are managed from their cards)`);
    const files = composeFileArgs(project);
    if (!files.length) throw new Error(`${name} does not report a compose file, so BoxPilot cannot act on it`);
    progress?.(`${action} ${name}...`, "stdout");
    const result = await docker(["compose", "--project-name", name, ...files, action], { timeout: 5 * 60_000, progress });
    if (!result.ok) throw new Error(`docker compose ${action} failed: ${redact(result.stderr).split("\n").slice(-3).join(" ")}`);
    return { name, action, done: true };
  }

  /** Tail a foreign project's logs, the same read the app cards offer for managed apps. */
  async function foreignProjectLogs({ name, lines = 200 }) {
    const project = await resolveForeignProject(name);
    if (!project) throw new Error(`No compose project named ${name} was found`);
    const files = composeFileArgs(project);
    const result = await docker(["compose", "--project-name", name, ...files, "logs", "--no-color", "--tail", String(Math.min(Math.max(Number(lines) || 200, 1), 1000))], { timeout: 30_000 });
    return { name, lines: redact(`${result.stdout}\n${result.stderr}`).split("\n").filter((line) => line.length).slice(-1000) };
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
  /**
   * This server's own tailnet address, for ports that have to move somewhere reachable but cannot
   * go through Serve. Null when Tailscale is absent or not up, which the caller treats as "leave
   * the port where it was" rather than as a failure.
   */
  let tailnetAddressCache;
  async function tailnetAddress() {
    if (tailnetAddressCache !== undefined) return tailnetAddressCache;
    const result = await runCommand(tailscaleBinary, ["ip", "-4"], { timeout: 15_000 }).catch(() => ({ ok: false, stdout: "" }));
    const address = result.ok ? (result.stdout.split("\n").map((line) => line.trim()).find((line) => /^\d{1,3}(\.\d{1,3}){3}$/.test(line)) ?? null) : null;
    tailnetAddressCache = address;
    return address;
  }

  /** This server's tailnet machine name (bigbox.tail...ts.net), or null without Tailscale. */
  let tailnetDnsNameCache;
  async function tailnetDnsName() {
    if (tailnetDnsNameCache !== undefined) return tailnetDnsNameCache;
    const result = await runCommand(tailscaleBinary, ["status", "--json"], { timeout: 15_000, maxBuffer: 4 * 1024 * 1024 }).catch(() => ({ ok: false, stdout: "" }));
    try { tailnetDnsNameCache = result.ok ? (JSON.parse(result.stdout).Self?.DNSName ?? "").replace(/\.$/, "") || null : null; } catch { tailnetDnsNameCache = null; }
    return tailnetDnsNameCache;
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
      const description = loopback && !publishedOnTailnet ? `${manifest.description} (on the server itself at 127.0.0.1:${hostPort}; publish it with Serve to reach it from elsewhere)` : manifest.description;
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

  /**
   * Which installed apps actually have a backup, and how old the newest one is.
   *
   * BoxPilot warned when its own database backup went stale and when nothing had been mirrored
   * off-box, but never that an *application* had never been backed up at all — so a server could
   * reach a dozen apps holding passwords, photos and documents with nothing protecting any of
   * them, and nothing saying so. An app counts as protectable when at least one of its volumes is
   * marked for backup; the rest (caches, downloaded models) are excluded on purpose and should not
   * be reported as unprotected.
   */
  async function backupProtection() {
    const { manifests } = await catalog.all();
    const backupRootPath = path.resolve(backupRoot);
    const apps = [];
    let readable = true;
    for (const manifest of manifests) {
      const state = await readState(manifest.id);
      if (!state?.installed) continue;
      const protectable = manifest.volumes.some((volume) => volume.backup && (volume.path || volume.hostPath));
      const directory = path.join(backupRootPath, manifest.id);
      let names = [];
      try { names = (await readdir(directory)).filter((name) => backupNamePattern.test(name)); }
      catch (error) { if (error.code !== "ENOENT") readable = false; names = []; }
      let newestAt = null;
      for (const name of names.sort().reverse().slice(0, 1)) {
        const meta = await readFile(path.join(directory, name.replace(/\.tar\.gz$/, ".json")), "utf8").then(JSON.parse).catch(() => null);
        const artifact = await stat(path.join(directory, name)).catch(() => null);
        newestAt = meta?.createdAt ?? artifact?.mtime?.toISOString() ?? null;
      }
      apps.push({ id: manifest.id, name: manifest.name, protectable, backups: names.length, newestAt });
    }
    // A root that cannot be read is unknown, not empty: reporting zero would tell the owner every
    // app is unprotected and invite them to "fix" something that may be fine.
    return { available: readable, apps, generatedAt: clock().toISOString() };
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
  async function setPassword({ id, password }, { progress = null } = {}) {
    const manifest = await ensureManifest(id);
    if (!manifest.signIn?.passwordEnv) throw new Error(`${manifest.name} does not have a sign-in password BoxPilot can set`);
    if (typeof password !== "string" || password.length < 8 || password.length > 128) throw new Error("The password must be 8 to 128 characters");
    const state = await readState(id);
    if (!state?.installed) throw new Error(`${manifest.name} is not installed`);
    const stored = sanitizeStoredValues(manifest, state.values ?? {});
    const result = await reconfigure({ id, values: { ...stored, env: { ...stored.env, [manifest.signIn.passwordEnv]: password } } }, { progress, checkpoint: false });
    return { id, changed: true, hostPorts: result.hostPorts };
  }

  /**
   * Language models an app has downloaded, and the two things you want to do with them.
   *
   * These live outside install on purpose. A large model is tens of gigabytes: pulling one inside
   * `app.install` meant a silent wait against a socket that gives up after twenty-five idle
   * minutes, so the download that most needed patience was the one guaranteed to fail. Here it is
   * an operation of its own, with its own budget and its output streamed as it goes.
   */
  function modelService(manifest) {
    if (!manifest.modelRunner) throw new Error(`${manifest.name} does not manage models`);
    return manifest.modelRunner.service;
  }

  /**
   * Models are read and written by running a command inside the container, which Docker refuses
   * unless it is running. It refuses quickly and with a message naming a container id, so the
   * check is here purely to say something the owner can act on instead.
   */
  async function readyForModels(id, manifest) {
    const state = await readState(id);
    if (!state?.installed) throw new Error(`${manifest.name} is not installed`);
    const status = await containerStatus(id);
    if (status.status === "paused") throw new Error(`${manifest.name} is paused. Resume it before changing its models`);
    if (!status.running) throw new Error(`${manifest.name} is not running. Start it before changing its models`);
  }

  /** `ollama list` as rows. Columns are separated by runs of spaces; SIZE and MODIFIED contain single ones. */
  function parseModelList(stdout) {
    const lines = String(stdout ?? "").split("\n").map((line) => line.trimEnd()).filter((line) => line.trim());
    const models = [];
    for (const line of lines) {
      const columns = line.trim().split(/\s{2,}/);
      if (columns.length < 3 || columns[0] === "NAME") continue;
      const [name, id, size, modified = ""] = columns;
      models.push({ name, id, size, modified, bytes: parseModelSize(size) });
    }
    return models;
  }

  async function listModels({ id }) {
    const manifest = await ensureManifest(id);
    // Listing is a read the panel makes on open, so a stopped app is reported rather than thrown:
    // "start it first" belongs in the panel, not in an error dialog the owner did not ask for.
    const state = await readState(id);
    if (!state?.installed) throw new Error(`${manifest.name} is not installed`);
    const status = await containerStatus(id);
    if (status.status === "paused") return { id, available: false, models: [], totalBytes: 0, reason: `${manifest.name} is paused. Resume it to see its models` };
    if (!status.running) return { id, available: false, models: [], totalBytes: 0, reason: `${manifest.name} is not running. Start it to see its models` };
    const result = await compose(id, ["exec", "-T", modelService(manifest), "ollama", "list"], { timeout: 60_000 });
    // A runner that is still starting has no answer yet, which is not a failure worth an error page.
    if (!result.ok) return { id, available: false, models: [], totalBytes: 0, reason: redact(result.stderr).split("\n").filter(Boolean).slice(-1)[0] ?? "the model runner is not answering yet" };
    const models = parseModelList(result.stdout);
    return { id, available: true, models, totalBytes: models.reduce((sum, model) => sum + model.bytes, 0), reason: null };
  }

  async function pullModel({ id, model }, { progress = null } = {}) {
    const manifest = await ensureManifest(id);
    await readyForModels(id, manifest);
    progress?.(`Downloading ${model}. Large models are tens of gigabytes; this can take a while.`, "stdout");
    // Two hours: a 20 GB model over a domestic line is comfortably an hour, and the alternative is
    // a download that dies near the end with nothing to show for it.
    const result = await compose(id, ["exec", "-T", modelService(manifest), "ollama", "pull", model], { timeout: 120 * 60_000, progress });
    if (!result.ok) throw new Error(`Could not download ${model}: ${redact(result.stderr).split("\n").filter(Boolean).slice(-2).join(" ") || "the model runner refused"}`);
    return { id, model, pulled: true, models: parseModelList((await compose(id, ["exec", "-T", modelService(manifest), "ollama", "list"], { timeout: 60_000 })).stdout) };
  }

  async function removeModel({ id, model }, { progress = null } = {}) {
    const manifest = await ensureManifest(id);
    await readyForModels(id, manifest);
    const result = await compose(id, ["exec", "-T", modelService(manifest), "ollama", "rm", model], { timeout: 5 * 60_000, progress });
    if (!result.ok) throw new Error(`Could not remove ${model}: ${redact(result.stderr).split("\n").filter(Boolean).slice(-2).join(" ") || "the model runner refused"}`);
    return { id, model, removed: true };
  }

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

  return { syncHomepage, inspect, reachabilityFacts, vpnKillSwitchDrill, foreignProjects, foreignProjectAction, foreignProjectLogs, vpnStatus, listModels, pullModel, removeModel, countAppBackups, backupProtection, install, uninstall, update, reconfigure, action, logs, config, editCompose, secrets, setPassword, backup, listAppBackups, restoreAppBackup, listAppBackupFiles, restoreAppBackupPath, deleteAppBackup, checkUpdates, catalogRoot: root, internals: { parseModelList, containerStatus, waitHealthy, writeProject, readState, parseEnvFile } };
}
