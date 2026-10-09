import { defineOperation } from "./registry.mjs";
import { parseServeStatus } from "../tailscale-serve.mjs";
import { composeVerdicts, planProbes } from "../reachability.mjs";
import { coversEveryAddress, serveUrl } from "../ports.mjs";

export { parseServeStatus };

/** What Tailscale Serve publishes now; empty when Tailscale cannot say. */
async function serveStatus(run) {
  const status = await Promise.resolve().then(() => run(tailscaleBinary(), ["serve", "status", "--json"], { timeout: 15_000, maxBuffer: 2 * 1024 * 1024 })).catch(() => null);
  return status?.ok ? parseServeStatus(status.stdout) : [];
}
const urlOf = (serve) => serveUrl(serve);

/** Serve again what was withdrawn, as it was; whether every one of them came back. */
async function republish(run, serves, progress) {
  let ok = true;
  for (const serve of serves) {
    const target = serve.target && /^https?:\/\/127\.0\.0\.1:\d+\/?$/.test(serve.target) ? serve.target.replace(/\/$/, "") : `http://127.0.0.1:${serve.port}`;
    const args = ["serve", "--bg", "--yes", `--https=${serve.port}`, target];
    progress?.(`$ tailscale ${args.join(" ")}`, "stdout");
    ok = (await run(tailscaleBinary(), args, { timeout: 60_000 }).catch(() => ({ ok: false }))).ok && ok;
  }
  return ok;
}

/**
 * Why an app published on the home network cannot also be served on the tailnet at the same port.
 * tailscaled holds a served port on the tailnet address; Docker publishes a home-network app on
 * every address; on Linux the second of the two to bind fails with "address already in use". That
 * is how Dockge stopped starting on the owner's server (2026-09-29).
 */
export function servedOnEveryAddress(name, port, { hostNetwork = false } = {}) {
  const where = hostNetwork ? `${name} shares this server's own network and listens on port ${port} on every address itself` : `${name} is on your home network at port ${port}, published on every address`;
  const instead = hostNetwork
    ? `It already reaches devices on your tailnet at http://<this server>:${port}, without HTTPS.`
    : `To reach ${name} over HTTPS on your tailnet, change who can reach it to Tailnet only: it then answers at its tailnet HTTPS address and no longer on your home network. On the home network it already reaches devices on your tailnet at http://<this server>:${port}, without HTTPS.`;
  return `${where}, and Tailscale Serve would hold the same port on the tailnet address. Linux does not let the two share it: whichever starts first keeps it and the other stops working, which is how an app ends up refusing to start after a restart or a reboot. ${instead}`;
}

/**
 * Publish a tailnet-only app's web ports with Tailscale Serve, from what the deployer said it wrote
 * (`exposure`, `hostPorts`, `name`). Tailnet only puts those ports on 127.0.0.1, so without Serve
 * there is no way in at all. The app is in place either way, so a Serve that fails is a warning with
 * the way to fix it. app.install does this after the deployer, and so does a machine snapshot
 * restore for each app it brings back. `{ served, urls, warnings? }`.
 */
export async function serveTailnetOnly(deployed, { run, progress = null }) {
  if (deployed?.exposure !== "tailnet" || !run) return { served: false, urls: [] };
  const webPorts = (deployed.hostPorts ?? []).filter((entry) => entry.protocol !== "udp" && entry.exposure === "loopback" && (entry.tailnet ?? "serve") === "serve").map((entry) => entry.host);
  const failures = [];
  for (const port of webPorts) {
    const args = ["serve", "--bg", "--yes", `--https=${port}`, `http://127.0.0.1:${port}`];
    progress?.(`$ tailscale ${args.join(" ")}`, "stdout");
    const result = await Promise.resolve().then(() => run(tailscaleBinary(), args, { timeout: 60_000 })).catch((error) => ({ ok: false, stderr: error.message }));
    if (!result.ok) failures.push(`${port}: ${String(result.stderr ?? "").split("\n").slice(-2).join(" ").trim() || "is Tailscale running?"}`);
  }
  const serves = webPorts.length ? await serveStatus(run) : [];
  const urls = webPorts.map((port) => serves.find((serve) => serve.port === port)).filter(Boolean).map(urlOf);
  return {
    served: urls.length > 0, urls,
    ...(failures.length ? { warnings: [`${deployed.name ?? deployed.id ?? "The app"} is installed for your tailnet only, but publishing it with Tailscale Serve failed (${failures.join("; ")}). Until it is published nothing can open it: on its Reach tab, choose Publish on the tailnet.`] } : {}),
  };
}

const idField = { type: "string", pattern: /^[a-z0-9][a-z0-9-]{1,62}$/ };
// An app's install values. secretEnvOf: env entries its manifest (named by `id`) calls a password or
// secret are secrets, which jobs stage in memory and schedules and flows refuse to store (M29.1).
const valuesField = { type: "object", optional: true, secretEnvOf: "id", validate:(value) => (Object.keys(value).every((key) => ["ports", "env", "volumes", "setup", "exposure", "networkMode"].includes(key)) ? null : "may only contain ports, env, volumes, setup, exposure, and networkMode") };
// Concrete device paths resolved by the web process (the helper's sandbox has no real /dev); the deployer keeps only those matching the manifest.
const devicesField = { type: "array", optional: true, nullable: true, validate: (value) => (value.length > 32 || value.some((entry) => typeof entry !== "string" || !/^\/dev\/[A-Za-z0-9._/-]{1,64}$/.test(entry)) ? "must be up to 32 /dev paths" : null) };
const minutes = (value) => value * 60_000;
/** A compose file's sha256 (catalog/compose-review.mjs composeSha256), as `allowCompose` names one. */
const composeHashField = { type: "string", optional: true, pattern: /^[a-f0-9]{64}$/ };

/**
 * Sweep 4: a restore whose request allows a backup's compose file to be started exactly as it was
 * archived, granting more than the catalog does, is high risk with a typed confirmation that names
 * the app, whatever the operation's own tier: approving that file approves whatever it hands its
 * containers. The jobs service and the registry take the tier from this hook (server/index.mjs).
 */
export function archivedComposeRisk(parameters) {
  const allowed = parameters?.allowCompose;
  return (typeof allowed === "string" && allowed) || (allowed && typeof allowed === "object" && Object.keys(allowed).length) ? "high" : "low";
}
/**
 * A checkpoint is a whole app backup taken before the change (app-helper.mjs checkpointCeilingMs:
 * stopping the app, up to an hour of archive, starting it again), with room for its checksum. The
 * operations that take one budget this on top of their own steps: on their old budgets the archive
 * alone could outlast the job, which was recorded failed while the helper carried on unwatched.
 * apps.test.mjs keeps it at or above the helper's ceiling.
 */
const checkpointMs = minutes(70);
const tailscaleBinary = () => process.env.BOXPILOT_TAILSCALE_BINARY ?? "/usr/bin/tailscale";

/** Parse one-JSON-per-line `docker stats --no-stream --format json` output. */
export function parseDockerStats(output) {
  const toBytes = (text) => {
    const match = String(text ?? "").match(/^([\d.]+)\s*(B|KiB|MiB|GiB|TiB|kB|MB|GB|TB)/i);
    if (!match) return null;
    const scale = { b: 1, kib: 1024, mib: 1024 ** 2, gib: 1024 ** 3, tib: 1024 ** 4, kb: 1000, mb: 1000 ** 2, gb: 1000 ** 3, tb: 1000 ** 4 }[match[2].toLowerCase()] ?? 1;
    return Math.round(Number(match[1]) * scale);
  };
  return String(output ?? "").split("\n").filter(Boolean).map((line) => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean)
    .map((entry) => ({ name: entry.Name ?? "", cpuPercent: Number(String(entry.CPUPerc ?? "").replace("%", "")) || 0, memBytes: toBytes(String(entry.MemUsage ?? "").split("/")[0]) }));
}

/** Sum container stats per app id: bp-<id> and bp-<id>-<sidecar> roll up together. */
export function aggregateAppStats(rows, appIds) {
  const stats = {};
  const sorted = [...appIds].sort((a, b) => b.length - a.length); // longest prefix wins (app ids can prefix each other)
  for (const row of rows) {
    if (!row.name.startsWith("bp-")) continue;
    const rest = row.name.slice(3);
    const id = sorted.find((candidate) => rest === candidate || rest.startsWith(`${candidate}-`));
    if (!id) continue;
    stats[id] ??= { cpuPercent: 0, memBytes: 0, containers: 0 };
    stats[id].cpuPercent = Math.round((stats[id].cpuPercent + row.cpuPercent) * 100) / 100;
    stats[id].memBytes += row.memBytes ?? 0;
    stats[id].containers += 1;
  }
  return stats;
}


/** Catalog application operations — one generic implementation for every manifest. */
export function appOperations() {
  return [
    defineOperation({ id: "app.inspect", title: "Inspect catalog applications", risk: "low", readOnly: true, description: "Installed state, container status, and ports for every catalog application.", run: (_p, { apps }) => apps.inspect({}) }),
    defineOperation({
      // operator, for the same reason as storage.folders: this runs in the root helper and reads
      // through directory permissions, so it would tell a viewer the path and size of every app's
      // data. And it is the longest read the helper has - a folder walk, minutes rather than
      // milliseconds - so leaving it open to anyone signed in means eight concurrent calls can hold
      // every read slot and stop the rest of the product reading anything at all.
      id: "app.data.usage", title: "Measure application data folders", risk: "low", readOnly: true, minimumRole: "operator", timeoutMs: 30 * 60_000,
      description: "How much disk each installed application's data folders are holding, and which drive each one is on. Read-only: it walks the folders the manifests declare and measures them, and takes no paths from the request.",
      run: (_p, { apps }) => apps.dataUsage(),
    }),
    defineOperation({ id: "app.updates.inspect", title: "Check application updates", risk: "low", readOnly: true, description: "Compares installed applications with the current catalog.", run: (_p, { apps }) => apps.checkUpdates() }),
    defineOperation({
      id: "app.logs", title: "Read application logs", risk: "low", readOnly: true, minimumRole: "operator", timeoutMs: 60_000,
      parameters: { fields: { id: idField, lines: { type: "number", optional: true, validate: (value) => (Number.isInteger(value) && value >= 1 && value <= 1000 ? null : "must be 1-1000") }, container: { type: "string", optional: true, pattern: /^[a-z0-9][a-z0-9-]{0,62}$/ } } },
      run: (parameters, { apps }) => apps.logs(parameters),
    }),
    defineOperation({
      id: "app.stats.inspect", title: "Read application resource use", risk: "low", readOnly: true, timeoutMs: 60_000,
      description: "Live CPU and memory per installed app (sidecars included), from docker stats.",
      run: async (_parameters, { run, apps }) => {
        const docker = process.env.BOXPILOT_DOCKER_BINARY ?? "/usr/bin/docker";
        // Only the ids are needed to group the stats rows. The full inspection - a docker inspect
        // of every container plus an image inspect per app - ran here as well, on every Apps page
        // load, alongside the one /catalog had already paid for.
        const [ids, stats] = await Promise.all([
          typeof apps.installedIds === "function" ? apps.installedIds() : apps.inspect({}).then(({ applications }) => applications.map((application) => application.id)),
          run(docker, ["stats", "--no-stream", "--format", "json"], { timeout: 30_000, maxBuffer: 2 * 1024 * 1024 }),
        ]);
        if (!stats.ok) return { available: false, stats: {} };
        return { available: true, stats: aggregateAppStats(parseDockerStats(stats.stdout), ids) };
      },
    }),
    defineOperation({
      id: "compose.projects.inspect", title: "List compose projects BoxPilot did not create", risk: "low", readOnly: true, minimumRole: "operator", timeoutMs: 60_000,
      description: "Compose stacks running on this server that were started outside BoxPilot, with their status and compose file locations. Nothing is changed.",
      parameters: { fields: {} },
      run: (parameters, { apps }) => apps.foreignProjects(),
    }),
    defineOperation({
      id: "compose.project.action", title: "Start, stop, or restart a compose stack", risk: "medium", timeoutMs: minutes(6),
      description: "Runs docker compose start, stop, or restart on a compose stack on this server that BoxPilot did not create, using the stack's own compose files. Lifecycle only; the stack is not modified or adopted.",
      parameters: { fields: { name: { type: "string", maxLength: 120, pattern: /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/ }, action: { type: "string", enum: ["start", "stop", "restart"] } } },
      run: (parameters, { apps, progress }) => apps.foreignProjectAction({ name: parameters.name, action: parameters.action }, { progress }),
    }),
    defineOperation({
      // operator, like app.logs and logs.read: container logs carry tokens, session ids, addresses
      // and whatever the application decided to print. These are stacks BoxPilot did not create,
      // so it has even less idea what is in them than it does for its own.
      id: "compose.project.logs", title: "Read a compose stack's logs", risk: "low", readOnly: true, minimumRole: "operator", timeoutMs: 60_000,
      description: "Tails the logs of a compose stack BoxPilot did not create. Nothing is changed.",
      parameters: { fields: { name: { type: "string", maxLength: 120, pattern: /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/ }, lines: { type: "number", optional: true } } },
      run: (parameters, { apps }) => apps.foreignProjectLogs({ name: parameters.name, lines: parameters.lines ?? 200 }),
    }),
    defineOperation({
      id: "app.vpn.inspect", title: "Read where a tunneled app's traffic leaves", risk: "low", readOnly: true, timeoutMs: 30_000,
      description: "For an app that runs through a VPN tunnel: whether the tunnel container is up, and the public IP and place its own log says the traffic leaves from. Nothing is changed.",
      parameters: { fields: { id: idField } },
      run: (parameters, { apps }) => apps.vpnStatus({ id: parameters.id }),
    }),
    defineOperation({
      id: "app.reachability.inspect", title: "Check how an app can be reached", risk: "low", readOnly: true, timeoutMs: 60_000,
      description: "Walks the path a browser walks: is the app and every helper container running, which addresses hold its ports after the exposure choice, does each one actually answer, and which address forms a browser refuses outright. Probes run from the server itself. Nothing is changed.",
      parameters: { fields: { id: idField } },
      run: async (parameters, { apps, runUnit, jobLog }) => {
        const facts = await apps.reachabilityFacts({ id: parameters.id });
        const plan = planProbes(facts, facts.serves);
        const wanted = plan.filter((address) => address.probe).map((address) => ({ id: address.id, url: address.url, ...(address.sourceAddress ? { sourceAddress: address.sourceAddress } : {}) }));
        const probed = wanted.length
          ? await runUnit.runTask("app.reachability.probe", { probes: wanted }, { timeoutMs: 45_000, logPath: jobLog?.path ?? null })
          : { results: [] };
        return composeVerdicts(plan, probed.results ?? [], facts);
      },
    }),
    defineOperation({
      id: "app.serve.inspect", title: "Read tailnet HTTPS publishing", risk: "low", readOnly: true, timeoutMs: 30_000,
      description: "Which local ports Tailscale Serve currently publishes over HTTPS on the tailnet.",
      run: async (_parameters, { run }) => {
        const status = await run(tailscaleBinary(), ["serve", "status", "--json"], { timeout: 15_000, maxBuffer: 2 * 1024 * 1024 });
        if (!status.ok) return { available: false, serves: [] };
        return { available: true, serves: parseServeStatus(status.stdout) };
      },
    }),
    defineOperation({
      id: "app.serve.withdraw", title: "Stop publishing a tailnet address", risk: "medium", timeoutMs: minutes(2),
      description: "Withdraws one tailnet HTTPS address. Meant for an address left behind when an app's port changed: publishing records the port an app had at the time, and stopping publishes the port it has now, so the old entry cannot otherwise be reached. Nothing about the app itself changes.",
      parameters: { fields: { port: { type: "number", validate: (value) => (Number.isInteger(value) && value >= 1 && value <= 65535 ? null : "must be a port between 1 and 65535") } } },
      run: async (parameters, { run }) => {
        const result = await run(tailscaleBinary(), ["serve", "--yes", `--https=${parameters.port}`, "off"], { timeout: 60_000 });
        if (!result.ok) throw new Error(`Could not stop publishing port ${parameters.port}: ${result.stderr.split("\n").slice(-2).join(" ")}`);
        return { withdrawn: true, port: parameters.port };
      },
    }),
    defineOperation({
      // With start, it may build the app's container again, which can pull its image.
      id: "app.serve.set", title: "Publish an app on the tailnet", risk: "medium", timeoutMs: minutes(17),
      description: "Serves the app's web port over HTTPS on your tailnet with a real certificate (tailnet only, Funnel stays off), or stops serving it. Serve fronts a port the app publishes on this server alone: an app published on your home network is refused, because Tailscale would hold the same port on the tailnet address and Linux will not let Docker publish it on every address beside that; change who can reach it to Tailnet only instead. With start, the app is started once it is no longer served, its container built again if it was removed.",
      parameters: { fields: { id: idField, enabled: { type: "boolean" }, start: { type: "boolean", optional: true } } },
      run: async (parameters, { run, apps, progress }) => {
        const { applications } = await apps.inspect({ id: parameters.id });
        const application = applications[0];
        if (!application?.installed) throw new Error("The app is not installed");
        const port = application.urls[0]?.host;
        if (!port) throw new Error("The app has no web port to publish");
        const name = application.name ?? parameters.id;
        if (parameters.enabled) {
          const published = (application.published ?? []).find((entry) => entry.host === port && entry.protocol === "tcp");
          if (published && coversEveryAddress(published.bind)) throw new Error(servedOnEveryAddress(name, port, { hostNetwork: Boolean(published.hostNetwork) }));
        }
        const before = parameters.enabled ? [] : await serveStatus(run);
        const args = parameters.enabled
          ? ["serve", "--bg", "--yes", `--https=${port}`, `http://127.0.0.1:${port}`]
          : ["serve", "--yes", `--https=${port}`, "off"];
        progress?.(`$ tailscale ${args.join(" ")}`, "stdout");
        const result = await run(tailscaleBinary(), args, { timeout: 60_000 });
        if (!result.ok) throw new Error(`tailscale serve failed: ${result.stderr.split("\n").slice(-2).join(" ") || "is Tailscale running?"}`);
        const serves = await serveStatus(run);
        const entry = serves.find((serve) => serve.port === port) ?? null;
        if (parameters.enabled && !entry) throw new Error("tailscale accepted the command but the port is not being served; check tailscale serve status");
        const withdrawn = before.find((serve) => serve.port === port) ?? null;
        // Repair's fix for a port Serve held (Dockge, 2026-09-29): the app can have it now, so start it.
        let started = null;
        if (!parameters.enabled && parameters.start) {
          progress?.(`${name} no longer shares port ${port} with Tailscale Serve; starting it.`, "stdout");
          started = await apps.action({ id: parameters.id, action: "start" }, { progress });
        }
        return {
          id: parameters.id, enabled: parameters.enabled, port, url: entry ? urlOf(entry) : null,
          ...(withdrawn ? { withdrawn: urlOf(withdrawn) } : {}),
          ...(started ? { started: true, status: started.status ?? null, recreated: Boolean(started.recreated) } : {}),
        };
      },
    }),
    defineOperation({
      // Pulls the previous images again, so a slow line can be given more time (M30.3): up to 4x.
      id: "app.rollback", title: "Go back to the previous version", risk: "medium", timeoutMs: checkpointMs + minutes(40), maxTimeoutMs: 4 * (checkpointMs + minutes(40)),
      description: "Takes a data checkpoint, then puts the application back on the versions it was running before its last update - the app and any sidecar that moved with it. The version to restore comes from this application's own recorded history, not from the request, so nothing else can be deployed this way. Data and settings are untouched; only the images change.",
      parameters: { fields: { id: idField, at: { type: "string", optional: true, maxLength: 32, pattern: /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/ }, checkpoint: { type: "boolean", optional: true }, devices: devicesField } },
      run: (parameters, { apps, progress, timeScale }) => apps.rollbackApp({ id: parameters.id, at: parameters.at ?? null, devices: parameters.devices ?? null }, { progress, checkpoint: parameters.checkpoint ?? true, timeScale }),
    }),
    defineOperation({
      id: "app.backup", title: "Back up application data", risk: "medium", timeoutMs: minutes(70),
      description: "Stops the app briefly, archives its compose project and the volumes BoxPilot manages, restarts it, and keeps the newest copies. Folders you pointed the app at yourself (a photo or media library, for instance) are not included; back those up the way you back up the rest of that disk.",
      parameters: { fields: { id: idField, keep: { type: "number", optional: true, validate: (value) => (Number.isInteger(value) && value >= 1 && value <= 30 ? null : "must be a whole number between 1 and 30") } } },
      run: (parameters, { apps, progress }) => apps.backup({ id: parameters.id, keep: parameters.keep ?? 5 }, { progress }),
    }),
    defineOperation({
      id: "homepage.sync", title: "Sync Homepage with installed apps", risk: "low", timeoutMs: 60_000,
      // Safe to run again after a restart cut it off (M30.2): it rebuilds BoxPilot's one group from
      // the apps installed now and swaps the file in with a rename, so a second run writes what one
      // clean run would. It runs inside the helper, so a restart stops it rather than leaving it going.
      rerunAfterInterrupt: true,
      description: "Writes a BoxPilot group into Homepage's services.yaml with every installed app, its link, description, icon and live container status, and keeps the groups you wrote yourself. Repeats automatically after installs and uninstalls.",
      parameters: { fields: { host: { type: "string", optional: true, maxLength: 253, pattern: /^[A-Za-z0-9][A-Za-z0-9.-]{0,252}$/ } } },
      run: (parameters, { apps, progress }) => apps.syncHomepage({ host: parameters.host }, { progress }),
    }),
    defineOperation({
      id: "app.backups.counts", title: "Count application backups", risk: "low", readOnly: true, timeoutMs: 30_000,
      description: "How many data backups each application has, from one walk of the backup root.",
      run: (_parameters, { apps }) => apps.countAppBackups(),
    }),
    defineOperation({
      id: "app.backups.inspect", title: "List application backups", risk: "low", readOnly: true, minimumRole: "operator", timeoutMs: 30_000,
      parameters: { fields: { id: idField } },
      run: (parameters, { apps }) => apps.listAppBackups(parameters),
    }),
    defineOperation({
      id: "app.backup.verify", title: "Rehearse restoring a backup", risk: "medium", timeoutMs: minutes(70),
      description: "Proves a backup would actually restore: checks it against the checksum recorded when it was written, unpacks the whole archive into scratch space, confirms everything it claims to contain is there and that its compose file is valid, then deletes the scratch copy. The app is never stopped and nothing it holds is changed. Without a backup name, the newest one is checked.",
      parameters: { fields: { id: idField, backup: { type: "string", optional: true, maxLength: 40, pattern: /^\d{8}T\d{6}Z\.tar\.gz$/ } } },
      run: (parameters, { apps, progress }) => apps.verifyAppBackup({ id: parameters.id, backup: parameters.backup ?? null }, { progress }),
    }),
    defineOperation({
      // Its safety copy of the current state is a whole backup, like a checkpoint.
      id: "app.backup.restore", title: "Restore application data from a backup", risk: "high", timeoutMs: checkpointMs + minutes(90),
      // Allowing a backup's own compose file is typed out, naming the app (sweep 4).
      confirm: (parameters) => (parameters.allowCompose ? `allow ${parameters.id}` : null),
      confirmWhen: "it starts a backup's own compose file as it was archived",
      description: "Checksums the backup and unpacks it beside the app, checks nothing else holds its ports, saves the current state as a safety copy, then replaces the app's data and configuration with the backup and starts it. An app the backup has reachable for the tailnet only is then published over HTTPS on your tailnet with Tailscale Serve. A compose file edited by hand (or one whose settings no longer fit the catalog) is started exactly as it was backed up only when it gives the app nothing past the catalog, this server already runs it, or allowCompose names its sha256.",
      parameters: { fields: { id: idField, backup: { type: "string", maxLength: 40, pattern: /^\d{8}T\d{6}Z\.tar\.gz$/ }, allowCompose: composeHashField } },
      // The deployer writes the backup's compose file again for this server and says who can reach
      // the app and on which ports, as an install does: a tailnet-only app's web ports are on
      // 127.0.0.1 for Serve to front, so it is published as app.install and a snapshot restore do.
      run: async (parameters, { apps, run, progress }) => {
        const restored = await apps.restoreAppBackup(parameters, { progress });
        if (restored?.exposure !== "tailnet" || !run) return restored;
        const published = await serveTailnetOnly({ ...restored, name: restored.name ?? parameters.id }, { run, progress });
        const warnings = [...(restored.warnings ?? []), ...(published.warnings ?? [])];
        return { ...restored, served: published.served, urls: published.urls, ...(warnings.length ? { warnings } : {}) };
      },
    }),
    defineOperation({
      // operator (ADR-003), like app.backup.files: it reads inside a backup as root, and says what the
      // backup's compose file mounts from this server. It reads the first few kilobytes of the archive,
      // not all of it. The restore dialog asks it before staging a restore (sweep 4).
      id: "app.backup.review", title: "Check what restoring a backup would start", risk: "low", readOnly: true, minimumRole: "operator", timeoutMs: minutes(5),
      description: "Whether restoring this backup would start its compose file exactly as it was archived (edited by hand, or with settings that no longer fit the catalog), and if so every setting in it that gives the app more than the catalog does - privileged, host folders, devices, capabilities, the host's network - with the file's sha256 to allow it by. Data folders the backup's settings name that an install would refuse are listed too. Nothing is unpacked or changed.",
      parameters: { fields: { id: idField, backup: { type: "string", maxLength: 40, pattern: /^\d{8}T\d{6}Z\.tar\.gz$/ } } },
      run: (parameters, { apps }) => apps.reviewAppBackup({ id: parameters.id, backup: parameters.backup }),
    }),
    defineOperation({
      // operator: this lists what is inside a backup - every filename in the app's config and data,
      // which is more revealing than the folder listing storage.folders already gates. Its only
      // caller is the restore-a-single-file dialog, which is medium risk and so beyond a viewer
      // anyway. It also inflates a whole archive to answer, so it is not a cheap thing to invite.
      id: "app.backup.files", title: "List the files in an application backup", risk: "low", readOnly: true, minimumRole: "operator", timeoutMs: minutes(10),
      description: "Paths, sizes, and kinds inside one backup archive, so a single file or folder can be restored. The first 5000 come back, or the first 5000 whose path contains the filter: a backup with more is filtered here, not in the browser.",
      parameters: { fields: { id: idField, backup: { type: "string", maxLength: 40, pattern: /^\d{8}T\d{6}Z\.tar\.gz$/ }, filter: { type: "string", optional: true, maxLength: 200 } } },
      run: (parameters, { apps }) => apps.listAppBackupFiles({ id: parameters.id, backup: parameters.backup, ...(parameters.filter ? { filter: parameters.filter } : {}) }),
    }),
    defineOperation({
      id: "app.backup.restore-path", title: "Restore one file or folder from a backup", risk: "medium", timeoutMs: checkpointMs + minutes(60),
      description: "Checksums the backup, takes a data checkpoint, stops the app briefly, restores only the chosen path over the current one, and starts the app again. Everything else is untouched.",
      parameters: { fields: { id: idField, backup: { type: "string", maxLength: 40, pattern: /^\d{8}T\d{6}Z\.tar\.gz$/ }, path: { type: "string", maxLength: 512, validate: (value) => (value && !value.startsWith("/") && !value.split("/").some((part) => part === "" || part === "." || part === "..") ? null : "must be a relative path inside the backup") } } },
      run: (parameters, { apps, progress }) => apps.restoreAppBackupPath({ id: parameters.id, backup: parameters.backup, path: parameters.path }, { progress }),
    }),
    defineOperation({
      id: "app.backup.delete", title: "Delete an application backup", risk: "medium",
      description: "Removes one archive and its record. The app and its live data are untouched, and any copy already mirrored off this server stays where it is.", timeoutMs: 60_000,
      parameters: { fields: { id: idField, backup: { type: "string", maxLength: 40, pattern: /^\d{8}T\d{6}Z\.tar\.gz$/ } } },
      run: (parameters, { apps }) => apps.deleteAppBackup(parameters),
    }),
    defineOperation({
      id: "app.compose.edit", title: "Edit application compose file", risk: "high", timeoutMs: checkpointMs + minutes(20),
      description: "Takes a data checkpoint, then replaces the app's compose.yaml verbatim, giving you full control and full responsibility. Validated by docker compose, applied with rollback; the next Settings change or Update regenerates the file from the manifest.",
      parameters: { fields: { id: idField, compose: { type: "string", secret: true, maxLength: 65536 }, checkpoint: { type: "boolean", optional: true } } },
      run: (parameters, { apps, progress }) => apps.editCompose({ id: parameters.id, compose: parameters.compose }, { progress, checkpoint: parameters.checkpoint ?? true }),
    }),
    defineOperation({
      id: "app.config.inspect", title: "Show an app's settings", risk: "low", readOnly: true, timeoutMs: 30_000,
      description: "Declared public environment settings and masked private values. Reading the raw Compose file requires an elevated owner session.",
      parameters: { fields: { id: idField } },
      run: (parameters, { apps }) => apps.config(parameters),
    }),
    defineOperation({
      id: "app.compose.inspect", title: "Read the raw application Compose file", risk: "low", readOnly: true, elevatedOnly: true, minimumRole: "owner", timeoutMs: 30_000,
      description: "Reads the fixed Compose file for editing. It may contain inline credentials, so it requires owner verification and is audited.",
      parameters: { fields: { id: idField } },
      run: (parameters, { apps }) => apps.readComposeConfig(parameters),
    }),
    defineOperation({
      id: "app.secrets", title: "Reveal application secrets", risk: "low", readOnly: true, elevatedOnly: true, minimumRole: "owner", timeoutMs: 30_000,
      description: "Shows the generated passwords and tokens stored in the application's .env. Requires a recent password (elevated session) and is audited.",
      parameters: { fields: { id: idField } },
      run: (parameters, { apps }) => apps.secrets(parameters),
    }),
    defineOperation({
      // Pulls the app's images; a slow line or a large image can be given more time (M30.3): up to 4x.
      id: "app.install", title: "Install application", risk: "medium", timeoutMs: minutes(25), maxTimeoutMs: minutes(100),
      description: "Writes the compose project, pulls the image, starts the container, and waits for it to be healthy; rolls back on failure. An app installed for the tailnet only (Zulip, unless you choose otherwise) is then published over HTTPS on your tailnet with Tailscale Serve.",
      parameters: { fields: { id: idField, values: valuesField, devices: devicesField } },
      run: async (parameters, { apps, run, progress, timeScale }) => {
        const installed = await apps.install({ id: parameters.id, values: parameters.values ?? {}, devices: parameters.devices ?? null }, { progress, timeScale });
        if (installed?.exposure !== "tailnet" || !run) return installed;
        const published = await serveTailnetOnly({ ...installed, name: installed.name ?? parameters.id }, { run, progress });
        // The install's own warnings (an optional port something holds) are kept beside Serve's.
        const warnings = [...(installed.warnings ?? []), ...(published.warnings ?? [])];
        return { ...installed, served: published.served, urls: published.urls, ...(warnings.length ? { warnings } : {}) };
      },
    }),
    defineOperation({
      id: "app.uninstall", title: "Uninstall application (keep data)", risk: "medium", timeoutMs: minutes(10),
      description: "Stops and removes the container; the application's data directory is kept for reinstall.",
      parameters: { fields: { id: idField } },
      run: (parameters, { apps, progress }) => apps.uninstall({ id: parameters.id, purge: false }, { progress }),
    }),
    defineOperation({
      // Repair's "Reinstall" for an app listed as installed with no container (M35). A container
      // pruned away can take its image with it, so this may pull, and may be given more time.
      id: "app.reinstall", title: "Rebuild an application's container", risk: "medium", timeoutMs: minutes(25), maxTimeoutMs: minutes(100),
      description: "For an app BoxPilot lists as installed that has no container: builds its container again from its saved compose project (or, if that file is gone too, from the catalog with its saved settings on the image it last ran), starts it and waits for it to be healthy. With start set to false it only creates the container and leaves it stopped, for an app that was stopped on purpose. Its data folder is used as it is; nothing is reset or deleted. If it does not come up, what started is taken down again.",
      parameters: { fields: { id: idField, devices: devicesField, start: { type: "boolean", optional: true } } },
      run: (parameters, { apps, progress, timeScale }) => apps.reinstall({ id: parameters.id, devices: parameters.devices ?? null, start: parameters.start !== false }, { progress, timeScale }),
    }),
    defineOperation({
      // Repair's "Back up now" for several apps at once (M35): one job, one approval, one log.
      id: "app.backup.many", title: "Back up several applications", risk: "medium", timeoutMs: minutes(360),
      description: "Backs up each app in turn exactly as Back up application data does: stops it briefly, archives its compose project and the volumes BoxPilot manages, starts it again, and keeps the newest copies. Only one app is stopped at a time. One that fails does not stop the others; the job names it at the end.",
      parameters: { fields: {
        ids: { type: "array", validate: (value) => (value.length >= 1 && value.length <= 40 && value.every((entry) => typeof entry === "string" && idField.pattern.test(entry)) && new Set(value).size === value.length ? null : "must list 1 to 40 different app ids") },
        keep: { type: "number", optional: true, validate: (value) => (Number.isInteger(value) && value >= 1 && value <= 30 ? null : "must be a whole number between 1 and 30") },
      } },
      run: (parameters, { apps, progress }) => apps.backupMany({ ids: parameters.ids, keep: parameters.keep ?? 5 }, { progress }),
    }),
    defineOperation({
      id: "app.purge", title: "Uninstall application and delete its data", risk: "high", confirm: (parameters) => parameters.id, timeoutMs: minutes(10),
      description: "Stops and removes the container and deletes everything under the application's data directory.",
      parameters: { fields: { id: idField } },
      run: (parameters, { apps, progress }) => apps.uninstall({ id: parameters.id, purge: true }, { progress }),
    }),
    defineOperation({
      id: "app.vpn.killswitch.drill", title: "Prove the kill switch", risk: "medium", timeoutMs: minutes(5),
      description: "Forces the VPN tunnel down for a few seconds, checks that nothing can reach the internet while it is down, then brings it back and confirms the exit address returned. Downloads pause for the duration and resume by themselves. The result is recorded, so 'if the VPN drops, nothing leaks' is a tested fact rather than a sentence.",
      parameters: { fields: { id: idField } },
      run: (parameters, { apps, progress }) => apps.vpnKillSwitchDrill({ id: parameters.id }, { progress }),
    }),
    defineOperation({
      // Pulls the new images; a slow line or a large image can be given more time (M30.3): up to 4x.
      id: "app.update", title: "Update application", risk: "medium", timeoutMs: checkpointMs + minutes(40), maxTimeoutMs: 4 * (checkpointMs + minutes(40)),
      description: "Takes a data checkpoint, pulls the catalog's current image, and recreates the container; restores the previous image if it fails to become healthy.",
      parameters: { fields: { id: idField, checkpoint: { type: "boolean", optional: true }, devices: devicesField } },
      run: (parameters, { apps, progress, timeScale }) => apps.update({ id: parameters.id, devices: parameters.devices ?? null }, { progress, checkpoint: parameters.checkpoint ?? true, timeScale }),
    }),
    defineOperation({
      id: "app.exposure.set", title: "Change who can reach an application", risk: "medium", timeoutMs: minutes(15),
      description: "Tailnet only publishes the app on your tailnet over HTTPS and stops it listening on the network, so Tailscale authenticates every visitor before the app sees them. Home network publishes it on the LAN address instead, where anything on your network can reach it and only the firewall stands in the way; its tailnet HTTPS address is withdrawn first, because Tailscale holds that port on the tailnet address and Docker cannot publish it on every address beside it.",
      parameters: { fields: { id: idField, mode: { type: "string", validate: (value) => (["lan", "tailnet"].includes(value) ? null : "must be lan or tailnet") }, devices: devicesField } },
      run: async (parameters, { apps, run, progress }) => {
        const tailnet = parameters.mode === "tailnet";
        // Home network: stop serving first. tailscaled holds a served port on the tailnet address, and
        // Docker cannot publish that port on every address while it does ("address already in use"),
        // so rebinding first failed, and so did its rollback. Serve is put back if the rebind fails.
        let withdrawn = [];
        if (!tailnet) {
          const { applications } = await apps.inspect({ id: parameters.id });
          const webPorts = new Set((applications[0]?.urls ?? []).map((url) => url.host));
          for (const serve of (await serveStatus(run)).filter((entry) => webPorts.has(entry.port))) {
            const args = ["serve", "--yes", `--https=${serve.port}`, "off"];
            progress?.(`$ tailscale ${args.join(" ")}`, "stdout");
            const result = await run(tailscaleBinary(), args, { timeout: 60_000 });
            if (!result.ok) {
              await republish(run, withdrawn, progress);
              throw new Error(`Could not stop serving ${urlOf(serve)} on the tailnet, so the app was left as it was: ${result.stderr.split("\n").slice(-2).join(" ").trim() || "is Tailscale running?"}`);
            }
            withdrawn.push(serve);
          }
        }
        // Tailnet only: rebind first, then publish. Doing it the other way round would leave Serve
        // pointing at a port that is still answering the whole LAN.
        progress?.(tailnet ? "Binding the app to this server only..." : "Publishing the app on the LAN address...", "stdout");
        let reconfigured;
        try {
          reconfigured = await apps.reconfigure({ id: parameters.id, values: { exposure: parameters.mode }, devices: parameters.devices ?? null }, { progress, checkpoint: false });
        } catch (error) {
          // The app is still on this server only, where Serve reaches it: publish it as it was.
          const back = await republish(run, withdrawn, progress);
          throw Object.assign(new Error(`${error.message}${withdrawn.length ? (back ? ` Tailscale Serve publishes it again at ${withdrawn.map(urlOf).join(", ")}.` : ` Publishing it on the tailnet again failed too; turn it back on from the app's card.`) : ""}`), { code: error.code });
        }
        const hostPorts = reconfigured.hostPorts ?? [];
        // Only the app's HTTP ports can go through Serve, which terminates HTTPS and proxies HTTP.
        // The rest moved to the tailnet address or stayed on the LAN when the compose was written,
        // and are reported here so the answer says where the whole app ended up, not just its UI.
        const webPorts = hostPorts.filter((entry) => entry.protocol !== "udp" && (entry.tailnet ?? "serve") === "serve").map((entry) => entry.host);
        const elsewhere = hostPorts.filter((entry) => entry.protocol === "udp" || (entry.tailnet ?? "serve") !== "serve")
          .map((entry) => ({ id: entry.id, host: entry.host, protocol: entry.protocol, reach: entry.exposure }));
        const gone = withdrawn.map(urlOf);
        if (!webPorts.length) return { id: parameters.id, mode: parameters.mode, port: null, ports: [], urls: [], url: null, served: false, elsewhere, ...(gone.length ? { withdrawn: gone } : {}) };

        // Home network: whatever was served was withdrawn before the rebind, above.
        const failures = [];
        for (const port of tailnet ? webPorts : []) {
          const args = ["serve", "--bg", "--yes", `--https=${port}`, `http://127.0.0.1:${port}`];
          progress?.(`$ tailscale ${args.join(" ")}`, "stdout");
          const result = await run(tailscaleBinary(), args, { timeout: 60_000 });
          if (!result.ok) failures.push(`${port}: ${result.stderr.split("\n").slice(-2).join(" ").trim() || "is Tailscale running?"}`);
        }
        // A tailnet-only app that is not published has no way in at all, so that failure has to be loud.
        if (failures.length && tailnet) throw new Error(`The app is now reachable only on this server, but publishing it on the tailnet failed: ${failures.join("; ")}`);

        const serves = await serveStatus(run);
        const urls = webPorts.map((port) => serves.find((serve) => serve.port === port)).filter(Boolean).map((serve) => `https://${serve.dnsName}:${serve.port}`);
        return { id: parameters.id, mode: parameters.mode, port: webPorts[0], ports: webPorts, urls, url: urls[0] ?? null, served: urls.length > 0, elsewhere, ...(gone.length ? { withdrawn: gone } : {}) };
      },
    }),
    defineOperation({
      id: "app.password.set", title: "Change an application's sign-in password", risk: "medium", timeoutMs: minutes(15),
      description: "Sets the password the app's sign-in page asks for and recreates the container so it takes effect. Data is untouched.",
      parameters: { fields: { id: idField, password: { type: "string", secret: true, validate: (value) => (value.length >= 8 && value.length <= 128 && !/[\r\n]/.test(value) ? null : "must be 8 to 128 characters") }, devices: devicesField } },
      run: (parameters, { apps, progress }) => apps.setPassword({ id: parameters.id, password: parameters.password, devices: parameters.devices ?? null }, { progress }),
    }),
    defineOperation({
      id: "app.backup.protection", title: "Read which apps have backups", risk: "low", readOnly: true, timeoutMs: minutes(2),
      description: "For every installed app: whether its data is worth backing up, how many backups exist, and how old the newest one is.",
      run: (_parameters, { apps }) => apps.backupProtection(),
    }),
    defineOperation({
      id: "app.models.inspect", title: "List an application's models", risk: "low", readOnly: true, minimumRole: "operator", timeoutMs: minutes(2),
      description: "Which language models this app has downloaded, with the disk each one takes.",
      parameters: { fields: { id: idField } },
      run: (parameters, { apps }) => apps.listModels({ id: parameters.id }),
    }),
    defineOperation({
      // A model is tens of gigabytes; a slow line can be given more time (M30.3): up to 4x, ten hours.
      id: "app.model.pull", title: "Download a language model", risk: "medium", timeoutMs: minutes(150), maxTimeoutMs: minutes(600),
      description: "Downloads a model into this app. Large models are tens of gigabytes and can take an hour or more; progress appears in the job log as it goes.",
      parameters: { fields: { id: idField, model: { type: "string", maxLength: 128, pattern: /^[a-z0-9][a-z0-9._/-]{0,96}(:[a-zA-Z0-9._-]{1,32})?$/ } } },
      run: (parameters, { apps, progress, timeScale }) => apps.pullModel({ id: parameters.id, model: parameters.model }, { progress, timeScale }),
    }),
    defineOperation({
      id: "app.model.remove", title: "Remove a language model", risk: "medium", timeoutMs: minutes(6),
      description: "Deletes a downloaded model and frees its disk. It can be downloaded again at any time.",
      parameters: { fields: { id: idField, model: { type: "string", maxLength: 128, pattern: /^[a-z0-9][a-z0-9._/-]{0,96}(:[a-zA-Z0-9._-]{1,32})?$/ } } },
      run: (parameters, { apps, progress }) => apps.removeModel({ id: parameters.id, model: parameters.model }, { progress }),
    }),
    defineOperation({
      id: "app.reconfigure", title: "Change application settings", risk: "medium", timeoutMs: checkpointMs + minutes(15),
      description: "Takes a data checkpoint, rewrites ports, settings, and volume paths, and recreates the container; restores the previous configuration on failure.",
      parameters: { fields: { id: idField, values: valuesField, checkpoint: { type: "boolean", optional: true }, devices: devicesField } },
      run: (parameters, { apps, progress }) => apps.reconfigure({ id: parameters.id, values: parameters.values ?? {}, devices: parameters.devices ?? null }, { progress, checkpoint: parameters.checkpoint ?? true }),
    }),
    defineOperation({
      id: "app.action", title: "Start, stop, pause, or restart application", risk: "low", timeoutMs: minutes(5),
      description: "Pause freezes the container (0 CPU, keeps its memory, resumes instantly); stop shuts it down and frees its memory. Start, restart, and unpause bring it back; start and restart build the container again from its saved compose project if it was removed (by docker system prune, say). Start and restart first check that nothing else holds the app's ports, and name what does when something does.",
      parameters: { fields: { id: idField, action: { type: "string", enum: ["start", "stop", "restart", "pause", "unpause"] } } },
      run: (parameters, { apps, progress }) => apps.action(parameters, { progress }),
    }),
  ];
}
