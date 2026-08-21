import { randomUUID } from "node:crypto";
import { defineOperation } from "./registry.mjs";

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
      description: "One root-only archive to redeploy this box: a fresh verified controller database backup, every installed app's compose project with its settings and secrets, app-backup references, netplan/ufw/fstab, and each VM's definition. App data volumes stay in their own backups. Contains secrets — keep copies only on encrypted or physically controlled media.",
      parameters: { exact: false, fields: { snapshotId: { type: "string", optional: true } } },
      run: ({ snapshotId }, { machineSnapshot }) => machineSnapshot.create({ snapshotId: snapshotId ?? randomUUID() }),
    }),
    defineOperation({
      id: "host.snapshot.sources", title: "List restorable machine snapshots", risk: "low", readOnly: true, timeoutMs: 60_000,
      description: "Machine snapshots in the local store and on the off-box mirror.",
      run: (_parameters, { machineSnapshot }) => machineSnapshot.sources(),
    }),
    defineOperation({
      id: "host.snapshot.describe", title: "Inspect a machine snapshot", risk: "low", readOnly: true, timeoutMs: 10 * 60_000,
      parameters: { fields: { source: { type: "string", enum: ["local", "mirror"] }, artifact: { type: "string", pattern: /^machine-snapshot-\d{8}T\d{6}Z-[a-f0-9]{8}\.tar\.gz$/ } } },
      run: (parameters, { machineSnapshot }) => machineSnapshot.describe(parameters),
    }),
    defineOperation({
      id: "host.snapshot.restore", title: "Restore from a machine snapshot", risk: "high", timeoutMs: 6 * 60 * 60_000,
      description: "Reinstalls the selected apps with the settings and secrets in the snapshot, then restores each app's newest data archive (from the local store or the mirror). Network, firewall, fstab, VM definitions, and the database copy are staged for review, never applied automatically.",
      parameters: { fields: { source: { type: "string", enum: ["local", "mirror"] }, artifact: { type: "string", pattern: /^machine-snapshot-\d{8}T\d{6}Z-[a-f0-9]{8}\.tar\.gz$/ }, apps: { type: "array", optional: true, validate: (value) => (value.every((id) => typeof id === "string" && /^[a-z0-9][a-z0-9-]{1,62}$/.test(id)) ? null : "must list app ids") }, restoreData: { type: "boolean", optional: true } } },
      run: (parameters, { machineSnapshot, apps, progress }) => machineSnapshot.restore({ ...parameters, apps: parameters.apps ?? "all", restoreData: parameters.restoreData ?? true }, { apps, progress }),
    }),
    defineOperation({
      id: "backup.sync", title: "Mirror local backups to the independent destination", risk: "medium", timeoutMs: 6 * 60 * 60_000,
      description: "Copies the local backup roots (controller backups, application backups, machine snapshots) onto the independent backup mount with hash verification. Nothing is ever deleted from the destination.",
      run: (_parameters, { machineSnapshot }) => machineSnapshot.sync(),
    }),
  ];
}
