import { randomUUID } from "node:crypto";
import { defineOperation } from "./registry.mjs";

/** BoxPilot's own database backup as a registry operation. */
export function controllerOperations() {
  return [
    defineOperation({
      id: "controller.backup.create", title: "Back up the BoxPilot database", risk: "low", timeoutMs: 10 * 60_000,
      description: "Snapshots the live database with VACUUM INTO (no downtime), restore-drills the copy in isolation, and records the verified evidence.",
      run: async (_parameters, { controllerBackups }) => controllerBackups.createBackup({ backupId: randomUUID() }),
    }),
    defineOperation({
      id: "controller.backup.protect", title: "Protect a database backup independently", risk: "medium", timeoutMs: 12 * 60 * 60_000,
      description: "Copies one verified local backup into the separate encrypted restic repository, reads the whole repository back, and restore-drills the exact snapshot with no network. Nothing is pruned or overwritten.",
      parameters: { exact: false, fields: { backupId: { type: "string", pattern: /^[a-f0-9-]{36}$/ } } },
      run: (parameters, { controllerProtection }) => controllerProtection.protect(parameters),
    }),
    defineOperation({
      id: "controller.backup.retention.apply", title: "Apply controller backup retention", risk: "medium", timeoutMs: 12 * 60 * 60_000,
      description: "Forgets only the pinned eligible old snapshots, verifies the repository afterwards, and never prunes — reclaimed space is not claimed.",
      parameters: { exact: false, fields: { retentionId: { type: "string", optional: true } } },
      run: ({ candidates, expectedBeforeCount, ...parameters }, { controllerRetention }) => controllerRetention.apply(parameters),
    }),
  ];
}
