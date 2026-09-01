import { randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { defineOperation } from "./registry.mjs";
import { destinationPatterns } from "../backup-destination.mjs";

/** Machine snapshots and the off-box backup mirror (Phase 6). */
export function hostBackupOperations() {
  return [
    defineOperation({
      id: "host.snapshot.inspect", title: "List machine snapshots", risk: "low", readOnly: true, timeoutMs: 60_000,
      description: "Recorded machine snapshots plus the off-box mirror destination state.",
      run: (_parameters, { machineSnapshot }) => machineSnapshot.inspect(),
    }),
    defineOperation({
      id: "host.snapshot.create", title: "Create a machine snapshot", risk: "medium", timeoutMs: 30 * 60_000,
      description: "One root-only archive to redeploy this box: a fresh verified controller database backup, every installed app's compose project with its settings and secrets, app-backup references, netplan/ufw/fstab, and each VM's definition. App data volumes stay in their own backups. Contains secrets, so keep copies only on encrypted or physically controlled media.",
      parameters: { exact: false, fields: { snapshotId: { type: "string", optional: true } } },
      run: ({ snapshotId }, { machineSnapshot }) => machineSnapshot.create({ snapshotId: snapshotId ?? randomUUID() }),
    }),
    defineOperation({
      id: "host.snapshot.sources", title: "List restorable machine snapshots", risk: "low", readOnly: true, timeoutMs: 60_000,
      description: "Machine snapshots in the local store and on the off-box mirror.",
      run: (_parameters, { machineSnapshot }) => machineSnapshot.sources(),
    }),
    defineOperation({
      id: "host.snapshot.discover", title: "Find machine snapshots on mounted drives", risk: "low", readOnly: true, timeoutMs: 2 * 60_000,
      description: "Looks for machine snapshots on every drive and share this server has mounted, including ones BoxPilot did not write. This is how a rebuilt server finds the snapshot of the one it replaces.",
      run: (_parameters, { machineSnapshot }) => machineSnapshot.discover(),
    }),
    defineOperation({
      // operator, like app.backup.files: reading inside a machine snapshot says what the server
      // holds, and inflating one to answer is minutes of work per call.
      id: "host.snapshot.describe", title: "Inspect a machine snapshot", risk: "low", readOnly: true, minimumRole: "operator", timeoutMs: 10 * 60_000,
      parameters: { fields: { source: { type: "string", enum: ["local", "mirror", "discovered"] }, artifact: { type: "string", pattern: /^machine-snapshot-\d{8}T\d{6}Z-[a-f0-9]{8}\.tar\.gz$/ }, root: { type: "string", maxLength: 4096, optional: true } } },
      run: (parameters, { machineSnapshot }) => machineSnapshot.describe(parameters),
    }),
    defineOperation({
      id: "host.snapshot.restores", title: "List what restores left for review", risk: "low", readOnly: true, timeoutMs: 60_000,
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
      id: "host.snapshot.restore", title: "Restore from a machine snapshot", risk: "high", confirm: () => "restore", timeoutMs: 6 * 60 * 60_000,
      description: "Reinstalls the selected apps with the settings and secrets in the snapshot, then restores each app's newest data archive (from the local store or the mirror). Network, firewall, fstab, VM definitions, and the database copy are staged for review, never applied automatically.",
      parameters: { fields: { source: { type: "string", enum: ["local", "mirror", "discovered"] }, artifact: { type: "string", pattern: /^machine-snapshot-\d{8}T\d{6}Z-[a-f0-9]{8}\.tar\.gz$/ }, root: { type: "string", maxLength: 4096, optional: true }, apps: { type: "array", optional: true, validate: (value) => (value.every((id) => typeof id === "string" && /^[a-z0-9][a-z0-9-]{1,62}$/.test(id)) ? null : "must list app ids") }, restoreData: { type: "boolean", optional: true } } },
      run: (parameters, { machineSnapshot, apps, progress }) => machineSnapshot.restore({ ...parameters, apps: parameters.apps ?? "all", restoreData: parameters.restoreData ?? true }, { apps, progress }),
    }),
    defineOperation({
      id: "backup.remote.inspect", title: "Read the off-box SSH destination state", risk: "low", readOnly: true, timeoutMs: 30_000,
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
      id: "backup.remote.setup", title: "Create the off-box mirror key", risk: "medium", timeoutMs: 2 * 60_000,
      description: "Generates an ed25519 key pair under /etc/boxpilot/secrets for the SSH mirror. The private key never leaves this server; you authorize the public key on the destination.",
      run: (_parameters, { runUnit, jobLog }) => runUnit.runTask("backup.remote.keygen", {}, { timeoutMs: 60_000, logPath: jobLog?.path ?? null }),
    }),
    defineOperation({
      id: "backup.remote.test", title: "Test the off-box SSH destination", risk: "medium", timeoutMs: 3 * 60_000,
      description: "Connects with the mirror key, creates the destination directory, checks it is writable, reports free space, and pins the host key on first use.",
      parameters: { fields: { host: { type: "string", pattern: destinationPatterns.host }, port: { type: "number", validate: (value) => (Number.isInteger(value) && value >= 1 && value <= 65535 ? null : "must be 1-65535") }, user: { type: "string", pattern: destinationPatterns.user }, path: { type: "string", pattern: destinationPatterns.path } } },
      run: (parameters, { runUnit, jobLog }) => runUnit.runTask("backup.remote.test", parameters, { timeoutMs: 2 * 60_000, logPath: jobLog?.path ?? null }),
    }),
    defineOperation({
      id: "backup.remote.sync", title: "Mirror local backups to the off-box SSH destination", risk: "medium", timeoutMs: 6 * 60 * 60_000,
      description: "rsync pushes the controller backups, application backups, and machine snapshots to the destination with checksum verification. Nothing is ever deleted there.",
      parameters: { fields: { host: { type: "string", pattern: destinationPatterns.host }, port: { type: "number", validate: (value) => (Number.isInteger(value) && value >= 1 && value <= 65535 ? null : "must be 1-65535") }, user: { type: "string", pattern: destinationPatterns.user }, path: { type: "string", pattern: destinationPatterns.path } } },
      run: (parameters, { runUnit, jobLog }) => runUnit.runTask("backup.remote.sync", parameters, { timeoutMs: 6 * 60 * 60_000 - 60_000, logPath: jobLog?.path ?? null }),
    }),
    defineOperation({
      id: "backup.sync", title: "Mirror local backups to the independent destination", risk: "medium", timeoutMs: 6 * 60 * 60_000,
      description: "Copies the local backup roots (controller backups, application backups, machine snapshots) onto the independent backup mount with hash verification. Nothing is ever deleted from the destination.",
      run: (_parameters, { machineSnapshot }) => machineSnapshot.sync(),
    }),
  ];
}
