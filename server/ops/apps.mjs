import { defineOperation } from "./registry.mjs";
import { parseServeStatus } from "../tailscale-serve.mjs";

export { parseServeStatus };

const idField = { type: "string", pattern: /^[a-z0-9][a-z0-9-]{1,62}$/ };
const valuesField = { type: "object", optional: true, validate: (value) => (Object.keys(value).every((key) => ["ports", "env", "volumes", "setup"].includes(key)) ? null : "may only contain ports, env, volumes, and setup") };
// Concrete device paths resolved by the web process (the helper's sandbox has no real /dev); the deployer keeps only those matching the manifest.
const devicesField = { type: "array", optional: true, nullable: true, validate: (value) => (value.length > 32 || value.some((entry) => typeof entry !== "string" || !/^\/dev\/[A-Za-z0-9._/-]{1,64}$/.test(entry)) ? "must be up to 32 /dev paths" : null) };
const minutes = (value) => value * 60_000;
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
    defineOperation({ id: "app.updates.inspect", title: "Check application updates", risk: "low", readOnly: true, description: "Compares installed applications with the current catalog.", run: (_p, { apps }) => apps.checkUpdates() }),
    defineOperation({
      id: "app.logs", title: "Read application logs", risk: "low", readOnly: true, minimumRole: "operator", timeoutMs: 60_000,
      parameters: { fields: { id: idField, lines: { type: "number", optional: true, validate: (value) => (Number.isInteger(value) && value >= 1 && value <= 1000 ? null : "must be 1-1000") } } },
      run: (parameters, { apps }) => apps.logs(parameters),
    }),
    defineOperation({
      id: "app.stats.inspect", title: "Read application resource use", risk: "low", readOnly: true, timeoutMs: 60_000,
      description: "Live CPU and memory per installed app (sidecars included), from docker stats.",
      run: async (_parameters, { run, apps }) => {
        const docker = process.env.BOXPILOT_DOCKER_BINARY ?? "/usr/bin/docker";
        const [{ applications }, stats] = await Promise.all([
          apps.inspect({}),
          run(docker, ["stats", "--no-stream", "--format", "json"], { timeout: 30_000, maxBuffer: 2 * 1024 * 1024 }),
        ]);
        if (!stats.ok) return { available: false, stats: {} };
        return { available: true, stats: aggregateAppStats(parseDockerStats(stats.stdout), applications.map((application) => application.id)) };
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
      id: "app.serve.set", title: "Publish an app on the tailnet", risk: "medium", timeoutMs: minutes(2),
      description: "Serves the app's web port over HTTPS on your tailnet with a real certificate (tailnet only — Funnel stays off), or stops serving it.",
      parameters: { fields: { id: idField, enabled: { type: "boolean" } } },
      run: async (parameters, { run, apps, progress }) => {
        const { applications } = await apps.inspect({ id: parameters.id });
        const application = applications[0];
        if (!application?.installed) throw new Error("The app is not installed");
        const port = application.urls[0]?.host;
        if (!port) throw new Error("The app has no web port to publish");
        const args = parameters.enabled
          ? ["serve", "--bg", "--yes", `--https=${port}`, `http://127.0.0.1:${port}`]
          : ["serve", "--yes", `--https=${port}`, "off"];
        progress?.(`$ tailscale ${args.join(" ")}`, "stdout");
        const result = await run(tailscaleBinary(), args, { timeout: 60_000 });
        if (!result.ok) throw new Error(`tailscale serve failed: ${result.stderr.split("\n").slice(-2).join(" ") || "is Tailscale running?"}`);
        const status = await run(tailscaleBinary(), ["serve", "status", "--json"], { timeout: 15_000, maxBuffer: 2 * 1024 * 1024 });
        const serves = status.ok ? parseServeStatus(status.stdout) : [];
        const entry = serves.find((serve) => serve.port === port) ?? null;
        if (parameters.enabled && !entry) throw new Error("tailscale accepted the command but the port is not being served; check tailscale serve status");
        return { id: parameters.id, enabled: parameters.enabled, port, url: entry ? `https://${entry.dnsName}${entry.port === 443 ? "" : `:${entry.port}`}` : null };
      },
    }),
    defineOperation({
      id: "app.backup", title: "Back up application data", risk: "medium", timeoutMs: minutes(70),
      description: "Stops the app briefly, archives its compose project and the volumes BoxPilot manages, restarts it, and keeps the newest copies. Folders you pointed the app at yourself (a photo or media library, for instance) are not included — back those up the way you back up the rest of that disk.",
      parameters: { fields: { id: idField, keep: { type: "number", optional: true, validate: (value) => (Number.isInteger(value) && value >= 1 && value <= 30 ? null : "must be a whole number between 1 and 30") } } },
      run: (parameters, { apps, progress }) => apps.backup({ id: parameters.id, keep: parameters.keep ?? 5 }, { progress }),
    }),
    defineOperation({
      id: "homepage.sync", title: "Sync Homepage with installed apps", risk: "low", timeoutMs: 60_000,
      description: "Writes a BoxPilot group into Homepage's services.yaml with every installed app — link, description, icon, live container status — and keeps the groups you wrote yourself. Repeats automatically after installs and uninstalls.",
      parameters: { fields: { host: { type: "string", optional: true, maxLength: 253, pattern: /^[A-Za-z0-9][A-Za-z0-9.-]{0,252}$/ } } },
      run: (parameters, { apps, progress }) => apps.syncHomepage({ host: parameters.host }, { progress }),
    }),
    defineOperation({
      id: "app.backups.inspect", title: "List application backups", risk: "low", readOnly: true, timeoutMs: 30_000,
      parameters: { fields: { id: idField } },
      run: (parameters, { apps }) => apps.listAppBackups(parameters),
    }),
    defineOperation({
      id: "app.backup.restore", title: "Restore application data from a backup", risk: "high", timeoutMs: minutes(90),
      description: "Checksums the backup, saves the current state as a safety copy, then replaces the app's data and configuration with the backup and starts it.",
      parameters: { fields: { id: idField, backup: { type: "string", maxLength: 40, pattern: /^\d{8}T\d{6}Z\.tar\.gz$/ } } },
      run: (parameters, { apps, progress }) => apps.restoreAppBackup(parameters, { progress }),
    }),
    defineOperation({
      id: "app.backup.files", title: "List the files in an application backup", risk: "low", readOnly: true, timeoutMs: minutes(10),
      description: "Paths, sizes, and kinds inside one backup archive, so a single file or folder can be restored.",
      parameters: { fields: { id: idField, backup: { type: "string", maxLength: 40, pattern: /^\d{8}T\d{6}Z\.tar\.gz$/ } } },
      run: (parameters, { apps }) => apps.listAppBackupFiles({ id: parameters.id, backup: parameters.backup }),
    }),
    defineOperation({
      id: "app.backup.restore-path", title: "Restore one file or folder from a backup", risk: "medium", timeoutMs: minutes(60),
      description: "Checksums the backup, takes a data checkpoint, stops the app briefly, restores only the chosen path over the current one, and starts the app again. Everything else is untouched.",
      parameters: { fields: { id: idField, backup: { type: "string", maxLength: 40, pattern: /^\d{8}T\d{6}Z\.tar\.gz$/ }, path: { type: "string", maxLength: 512, validate: (value) => (value && !value.startsWith("/") && !value.split("/").some((part) => part === "" || part === "." || part === "..") ? null : "must be a relative path inside the backup") } } },
      run: (parameters, { apps, progress }) => apps.restoreAppBackupPath({ id: parameters.id, backup: parameters.backup, path: parameters.path }, { progress }),
    }),
    defineOperation({
      id: "app.backup.delete", title: "Delete an application backup", risk: "medium", timeoutMs: 60_000,
      parameters: { fields: { id: idField, backup: { type: "string", maxLength: 40, pattern: /^\d{8}T\d{6}Z\.tar\.gz$/ } } },
      run: (parameters, { apps }) => apps.deleteAppBackup(parameters),
    }),
    defineOperation({
      id: "app.compose.edit", title: "Edit application compose file", risk: "high", timeoutMs: minutes(20),
      description: "Takes a data checkpoint, then replaces the app's compose.yaml verbatim — full control, full responsibility. Validated by docker compose, applied with rollback; the next Settings change or Update regenerates the file from the manifest.",
      parameters: { fields: { id: idField, compose: { type: "string", maxLength: 65536 }, checkpoint: { type: "boolean", optional: true } } },
      run: (parameters, { apps, progress }) => apps.editCompose({ id: parameters.id, compose: parameters.compose }, { progress, checkpoint: parameters.checkpoint ?? true }),
    }),
    defineOperation({
      id: "app.config.inspect", title: "Read effective application configuration", risk: "low", readOnly: true, timeoutMs: 30_000,
      description: "The compose.yaml and .env BoxPilot wrote for the app. Secret values are masked; Reveal secrets shows them.",
      parameters: { fields: { id: idField } },
      run: (parameters, { apps }) => apps.config(parameters),
    }),
    defineOperation({
      id: "app.secrets", title: "Reveal application secrets", risk: "low", readOnly: true, elevatedOnly: true, minimumRole: "owner", timeoutMs: 30_000,
      description: "Shows the generated passwords and tokens stored in the application's .env. Requires a recent password (elevated session) and is audited.",
      parameters: { fields: { id: idField } },
      run: (parameters, { apps }) => apps.secrets(parameters),
    }),
    defineOperation({
      id: "app.install", title: "Install application", risk: "medium", timeoutMs: minutes(25),
      description: "Writes the compose project, pulls the image, starts the container, and waits for it to be healthy; rolls back on failure.",
      parameters: { fields: { id: idField, values: valuesField, devices: devicesField } },
      run: (parameters, { apps, progress }) => apps.install({ id: parameters.id, values: parameters.values ?? {}, devices: parameters.devices ?? null }, { progress }),
    }),
    defineOperation({
      id: "app.uninstall", title: "Uninstall application (keep data)", risk: "medium", timeoutMs: minutes(10),
      description: "Stops and removes the container; the application's data directory is kept for reinstall.",
      parameters: { fields: { id: idField } },
      run: (parameters, { apps, progress }) => apps.uninstall({ id: parameters.id, purge: false }, { progress }),
    }),
    defineOperation({
      id: "app.purge", title: "Uninstall application and delete its data", risk: "high", confirm: (parameters) => parameters.id, timeoutMs: minutes(10),
      description: "Stops and removes the container and deletes everything under the application's data directory.",
      parameters: { fields: { id: idField } },
      run: (parameters, { apps, progress }) => apps.uninstall({ id: parameters.id, purge: true }, { progress }),
    }),
    defineOperation({
      id: "app.update", title: "Update application", risk: "medium", timeoutMs: minutes(40),
      description: "Takes a data checkpoint, pulls the catalog's current image, and recreates the container; restores the previous image if it fails to become healthy.",
      parameters: { fields: { id: idField, checkpoint: { type: "boolean", optional: true }, devices: devicesField } },
      run: (parameters, { apps, progress }) => apps.update({ id: parameters.id, devices: parameters.devices ?? null }, { progress, checkpoint: parameters.checkpoint ?? true }),
    }),
    defineOperation({
      id: "app.reconfigure", title: "Change application settings", risk: "medium", timeoutMs: minutes(15),
      description: "Takes a data checkpoint, rewrites ports, settings, and volume paths, and recreates the container; restores the previous configuration on failure.",
      parameters: { fields: { id: idField, values: valuesField, checkpoint: { type: "boolean", optional: true }, devices: devicesField } },
      run: (parameters, { apps, progress }) => apps.reconfigure({ id: parameters.id, values: parameters.values ?? {}, devices: parameters.devices ?? null }, { progress, checkpoint: parameters.checkpoint ?? true }),
    }),
    defineOperation({
      id: "app.action", title: "Start, stop, or restart application", risk: "low", timeoutMs: minutes(5),
      parameters: { fields: { id: idField, action: { type: "string", enum: ["start", "stop", "restart"] } } },
      run: (parameters, { apps, progress }) => apps.action(parameters, { progress }),
    }),
  ];
}
