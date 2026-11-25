import { randomUUID } from "node:crypto";
import { readFile, rm, stat } from "node:fs/promises";
import { defineOperation } from "./registry.mjs";
import { destinationPatterns } from "../backup-destination.mjs";
import { serveTailnetOnly } from "./apps.mjs";
import { stageDatabaseBackup } from "../db-restore.mjs";

const appIdPattern = /^[a-z0-9][a-z0-9-]{1,62}$/;
/**
 * The devices the web process found for each app a snapshot restore installs (catalog/devices.mjs,
 * the operation's prepare hook): the helper's sandbox has no real /dev. The deployer still keeps only
 * the paths an app's manifest asks for.
 */
const devicesByAppField = {
  type: "object", optional: true,
  validate: (value) => {
    const entries = Object.entries(value);
    if (entries.length > 64) return "may name at most 64 apps";
    for (const [id, devices] of entries) {
      if (!appIdPattern.test(id)) return "must be keyed by app id";
      if (!Array.isArray(devices) || devices.length > 32 || devices.some((entry) => typeof entry !== "string" || !/^\/dev\/[A-Za-z0-9._/-]{1,64}$/.test(entry))) return `${id} must list up to 32 /dev paths`;
    }
    return null;
  },
};

/**
 * Per app id, the sha256 of the data archive's compose file the owner allowed to be started exactly
 * as it was archived (sweep 4; app-helper composeGate).
 */
const allowComposeByAppField = {
  type: "object", optional: true,
  validate: (value) => {
    const entries = Object.entries(value);
    if (entries.length > 64) return "may name at most 64 apps";
    for (const [id, hash] of entries) {
      if (!appIdPattern.test(id)) return "must be keyed by app id";
      if (typeof hash !== "string" || !/^[a-f0-9]{64}$/.test(hash)) return `${id} must be a compose file's sha256`;
    }
    return null;
  },
};
/**
 * Which data a snapshot restore brings back: each app's newest data archive anywhere it looks (the
 * default), or only the one the snapshot names.
 */
const dataFromField = { type: "string", enum: ["newest", "snapshot"], optional: true };
/** A database copy the browser can name: a controller backup by its id, a snapshot restore's copy by the restore's name. */
const databaseCopyIdPatterns = { backup: /^[a-f0-9-]{36}$/, snapshot: /^\d{8}T\d{6}Z$/ };

/** The apps a snapshot restore allows a compose file for, sorted, as its typed confirmation names them. */
const allowedApps = (parameters) => Object.keys(parameters?.allowCompose && typeof parameters.allowCompose === "object" ? parameters.allowCompose : {}).sort();

/** Machine snapshots and the off-box backup mirror (Phase 6). */
export function hostBackupOperations() {
  return [
    defineOperation({
      id: "host.snapshot.inspect", title: "List machine snapshots", risk: "low", readOnly: true, minimumRole: "operator", timeoutMs: 60_000,
      description: "Recorded machine snapshots, plus the state of the destination off this server.",
      run: (_parameters, { machineSnapshot }) => machineSnapshot.inspect(),
    }),
    defineOperation({
      id: "host.snapshot.create", title: "Create a machine snapshot", risk: "medium", timeoutMs: 30 * 60_000,
      description: "One root-only archive to redeploy this box: a fresh verified controller database backup, every installed app's compose project with its settings and secrets, app-backup references, netplan/ufw/fstab, and each VM's definition. App data volumes stay in their own backups. Contains secrets, so keep copies only on encrypted or physically controlled media.",
      parameters: { exact: false, fields: { snapshotId: { type: "string", optional: true } } },
      run: ({ snapshotId }, { machineSnapshot }) => machineSnapshot.create({ snapshotId: snapshotId ?? randomUUID() }),
    }),
    defineOperation({
      id: "host.snapshot.sources", title: "List restorable machine snapshots", risk: "low", readOnly: true, minimumRole: "operator", timeoutMs: 60_000,
      description: "Machine snapshots in the local store and in the copy off this server.",
      run: (_parameters, { machineSnapshot }) => machineSnapshot.sources(),
    }),
    defineOperation({
      // operator (ADR-003): walks every mounted filesystem as root on a two-minute budget - the throughput case ADR-003 names.
      id: "host.snapshot.discover", title: "Find machine snapshots on mounted drives", risk: "low", readOnly: true, minimumRole: "operator", timeoutMs: 2 * 60_000,
      description: "Looks for machine snapshots on every drive and share this server has mounted, including ones BoxPilot did not write. This is how a rebuilt server finds the snapshot of the one it replaces.",
      run: (_parameters, { machineSnapshot }) => machineSnapshot.discover(),
    }),
    defineOperation({
      // operator, like app.backup.files: reading inside a machine snapshot says what the server
      // holds, and inflating one to answer is minutes of work per call.
      id: "host.snapshot.describe", title: "Inspect a machine snapshot", risk: "low", readOnly: true, minimumRole: "operator", timeoutMs: 10 * 60_000,
      parameters: { fields: { source: { type: "string", enum: ["local", "mirror", "discovered"] }, artifact: { type: "string", pattern: /^machine-snapshot-\d{8}T\d{6}Z-[a-f0-9]{8}\.tar\.gz$/ }, root: { type: "string", maxLength: 4096, optional: true }, dataFrom: dataFromField } },
      // With the deployer, each app's data archive says what restoring it would start (sweep 4).
      run: (parameters, { machineSnapshot, apps }) => machineSnapshot.describe(parameters, { apps }),
    }),
    defineOperation({
      // operator (ADR-003): inlines the contents of root-only files a restore staged for review - netplan (which can carry Wi-Fi passwords), fstab, VM definitions.
      id: "host.snapshot.restores", title: "List what restores left for review", risk: "low", readOnly: true, minimumRole: "operator", timeoutMs: 60_000,
      description: "The network, firewall, fstab, and VM definitions a restore staged rather than applied, with their contents, so they can actually be reviewed.",
      run: (_parameters, { machineSnapshot }) => machineSnapshot.listRestores(),
    }),
    defineOperation({
      id: "host.snapshot.restores.discard", title: "Discard a restore's review files", risk: "medium", timeoutMs: 60_000,
      description: "Removes the staged copies one restore left for review. The restored apps and their data are untouched; this deletes only the review copies of system configuration, VM definitions, and the database backup.",
      parameters: { fields: { name: { type: "string", maxLength: 20, pattern: /^\d{8}T\d{6}Z$/ } } },
      run: (parameters, { machineSnapshot }) => machineSnapshot.discardRestore(parameters),
    }),
    defineOperation({
      // Allowing data archives' own compose files is typed out, naming each app (sweep 4).
      id: "host.snapshot.restore", title: "Restore from a machine snapshot", risk: "high", confirm: (parameters) => (allowedApps(parameters).length ? `allow ${allowedApps(parameters).join(" ")}` : "restore"), timeoutMs: 6 * 60 * 60_000,
      description: "Reinstalls the selected apps with the settings and secrets in the snapshot, then restores each app's newest data archive, from this server, the backup drive or the drive the snapshot is on, whether it was taken before the snapshot or after, and falls back to the one the snapshot names when none checks out (dataFrom: snapshot restores only the one the snapshot names). One taken after the snapshot is used only when its record, written by this release, names the app and its checksum matches; a restore's own safety copies, and backups of an app a snapshot restore installed without its data, are never used. Each newer archive passed over is said, with why. Network, firewall, fstab, VM definitions, and the database copy are staged for review, never applied automatically. A data archive whose compose file would be started exactly as it was backed up, giving the app more than the catalog does, is restored only when allowCompose names that file's sha256 for the app; otherwise nothing is restored.",
      parameters: { fields: { source: { type: "string", enum: ["local", "mirror", "discovered"] }, artifact: { type: "string", pattern: /^machine-snapshot-\d{8}T\d{6}Z-[a-f0-9]{8}\.tar\.gz$/ }, root: { type: "string", maxLength: 4096, optional: true }, apps: { type: "array", optional: true, validate: (value) => (value.every((id) => typeof id === "string" && appIdPattern.test(id)) ? null : "must list app ids") }, restoreData: { type: "boolean", optional: true }, dataFrom: dataFromField, devicesByApp: devicesByAppField, allowCompose: allowComposeByAppField } },
      // A tailnet-only app it brings back is published with Tailscale Serve, as app.install does.
      run: (parameters, { machineSnapshot, apps, run, progress }) => machineSnapshot.restore({ ...parameters, apps: parameters.apps ?? "all", restoreData: parameters.restoreData ?? true, dataFrom: parameters.dataFrom ?? "newest" }, { apps, progress, serve: run ? (deployed) => serveTailnetOnly(deployed, { run, progress }) : null }),
    }),
    defineOperation({
      // operator (ADR-003): a listing of root-only folders (the controller backups, what restores staged).
      id: "host.database.sources", title: "List the database backups that can be put back", risk: "low", readOnly: true, minimumRole: "operator", timeoutMs: 60_000,
      description: "Every verified backup of BoxPilot's database on this server, and the database copy each snapshot restore staged, newest first: what Restore the database copy can put back.",
      run: (_parameters, { machineSnapshot }) => machineSnapshot.databaseSources(),
    }),
    defineOperation({
      // High and owner only, as housekeeping.database-copies.restore, whose run it is once the copy is
      // beside the database: it replaces everything BoxPilot knows and stops BoxPilot while it does.
      id: "host.database.restore", title: "Restore the database copy", risk: "high", minimumRole: "owner", timeoutMs: 5 * 60_000, restartsService: true, runsRootTask: true,
      confirm: (parameters) => parameters.id,
      description: "Puts back a verified backup of BoxPilot's database, or the copy a snapshot restore staged: checks it against its recorded checksum and SQLite's integrity check, and refuses one taken by a newer BoxPilot (the release its record names, or tables and columns this version does not have), puts it beside the database, then stops BoxPilot, saves the database as it is now as a copy of its own, puts the backup in its place and starts BoxPilot again. If BoxPilot does not answer on it, the database it had is put back. Accounts, settings, schedules and history go back to what they were when the backup was taken, and everyone is signed out.",
      parameters: { fields: {
        kind: { type: "string", enum: ["backup", "snapshot"] },
        id: { type: "string", maxLength: 40, validate: (value) => (Object.values(databaseCopyIdPatterns).some((pattern) => pattern.test(value)) ? null : "must be a database backup's id or a restore's name") },
      } },
      run: async (parameters, { machineSnapshot, runUnit, jobLog, progress }) => {
        const database = process.env.BOXPILOT_CONTROLLER_DATABASE ?? "/var/lib/boxpilot/boxpilot.sqlite3";
        if (!databaseCopyIdPatterns[parameters.kind]?.test(parameters.id)) throw new Error("That is not a database copy of that kind. Nothing was changed.");
        const source = await machineSnapshot.databaseSource({ kind: parameters.kind, id: parameters.id });
        progress?.("Checking the backup against its checksum, SQLite's integrity check and this version's tables...", "stdout");
        const staged = await stageDatabaseBackup({ database, source: source.file, checksumSha256: source.checksumSha256, label: parameters.kind, takenBy: source.productVersion ?? null });
        progress?.(`Put beside the database as ${staged.name}`, "stdout");
        try {
          const started = await runUnit.runTask("database.copy.restore", { name: staged.name, database }, { timeoutMs: 2 * 60_000, logPath: jobLog?.path ?? null });
          // An answer that is not "started" started nothing either: the copy goes, as for a throw.
          if (started?.started !== true) throw new Error(`The service that puts the copy back did not start${typeof started?.error === "string" ? ` (${started.error.slice(0, 300)})` : ""}. Nothing was changed.`);
          return { ...started, from: { kind: parameters.kind, id: parameters.id, createdAt: source.createdAt } };
        } catch (error) {
          // Nothing was stopped: the copy put beside the database for it goes again.
          await rm(staged.path, { force: true }).catch(() => {});
          throw error;
        }
      },
    }),
    defineOperation({
      id: "backup.remote.inspect", title: "Read the state of the SSH destination off this server", risk: "low", readOnly: true, timeoutMs: 30_000,
      description: "Whether the mirror key exists (and its public half), whether a host key is pinned, and whether rsync is installed.",
      run: async (_parameters, { run }) => {
        const secrets = process.env.BOXPILOT_SECRETS_DIRECTORY ?? "/etc/boxpilot/secrets";
        const publicKey = await readFile(`${secrets}/backup-mirror-key.pub`, "utf8").then((text) => text.trim()).catch(() => null);
        const knownHosts = await readFile(`${secrets}/backup-mirror-known_hosts`, "utf8").then((text) => text.split("\n").filter((line) => line.trim() && !line.startsWith("#")).length).catch(() => 0);
        const fingerprint = publicKey ? await run("/usr/bin/ssh-keygen", ["-lf", `${secrets}/backup-mirror-key.pub`], { timeout: 15_000 }).then((result) => (result.ok ? result.stdout.trim().split(/\s+/)[1] ?? null : null)).catch(() => null) : null;
        const rsyncInstalled = await stat("/usr/bin/rsync").then(() => true, () => false);
        return { keyReady: Boolean(publicKey), publicKey, fingerprint, hostKeysPinned: knownHosts, rsyncInstalled };
      },
    }),
    defineOperation({
      id: "backup.remote.setup", title: "Create the key for copies on another computer", risk: "medium", timeoutMs: 2 * 60_000,
      description: "Creates the key this server signs in with when it copies backups to another computer. The private half never leaves this server; you allow the public half on the other computer.",
      run: (_parameters, { runUnit, jobLog }) => runUnit.runTask("backup.remote.keygen", {}, { timeoutMs: 60_000, logPath: jobLog?.path ?? null }),
    }),
    defineOperation({
      id: "backup.remote.test", title: "Test the other computer", risk: "medium", timeoutMs: 3 * 60_000,
      description: "Signs in to the other computer with that key, creates the backup folder there, checks it can be written to, reports free space, and remembers the computer's identity on first use.",
      parameters: { fields: { host: { type: "string", pattern: destinationPatterns.host }, port: { type: "number", validate: (value) => (Number.isInteger(value) && value >= 1 && value <= 65535 ? null : "must be 1-65535") }, user: { type: "string", pattern: destinationPatterns.user }, path: { type: "string", pattern: destinationPatterns.path } } },
      run: (parameters, { runUnit, jobLog }) => runUnit.runTask("backup.remote.test", parameters, { timeoutMs: 2 * 60_000, logPath: jobLog?.path ?? null }),
    }),
    defineOperation({
      id: "backup.remote.sync", title: "Copy backups to another computer", risk: "medium", timeoutMs: 6 * 60 * 60_000,
      description: "Copies the database backups, app backups and machine snapshots to the other computer and checks each arrived whole. Nothing is ever deleted there.",
      parameters: { fields: { host: { type: "string", pattern: destinationPatterns.host }, port: { type: "number", validate: (value) => (Number.isInteger(value) && value >= 1 && value <= 65535 ? null : "must be 1-65535") }, user: { type: "string", pattern: destinationPatterns.user }, path: { type: "string", pattern: destinationPatterns.path } } },
      run: (parameters, { runUnit, jobLog }) => runUnit.runTask("backup.remote.sync", parameters, { timeoutMs: 6 * 60 * 60_000 - 60_000, logPath: jobLog?.path ?? null }),
    }),
    defineOperation({
      id: "backup.sync", title: "Copy backups to the backup drive", risk: "medium", timeoutMs: 6 * 60 * 60_000,
      // Safe to run again after a restart cut it off (M30.2): each file is copied beside its target,
      // checked by hash and only then renamed into place, files already there at full size are
      // skipped, and nothing is ever deleted - so a second run finishes what the first started. It
      // runs in the helper; the two SSH and cloud mirrors run in a root task a restart does not
      // stop, which is why they are not marked.
      rerunAfterInterrupt: true,
      description: "Copies the local backups (database backups, application backups, machine snapshots) onto the backup drive with hash verification. Nothing is ever deleted from the destination.",
      run: (_parameters, { machineSnapshot }) => machineSnapshot.sync(),
    }),
  ];
}
