import { randomUUID } from "node:crypto";
import { defineOperation } from "./registry.mjs";
import { inspectControllerDatabase } from "../controller-database-health.mjs";
import { shared } from "../cache.mjs";
const databaseHealth = shared(() => inspectControllerDatabase());

/** BoxPilot's own database backup as a registry operation. */
export function controllerOperations() {
  return [
    defineOperation({
      id: "controller.database.inspect", title: "Check the BoxPilot database", risk: "low", readOnly: true, minimumRole: "operator", timeoutMs: 20_000,
      description: "Runs bounded read-only SQLite structure, related-record and core-table checks. Reports no account, setting or job contents; runs no migrations or recovery commands.",
      run: () => databaseHealth(),
    }),
    defineOperation({
      id: "controller.backup.create", title: "Back up the BoxPilot database", risk: "low", timeoutMs: 10 * 60_000,
      description: "Snapshots the live database with VACUUM INTO (no downtime), test-restores the copy, and records the result.",
      run: async (_parameters, { controllerBackups, progress }) => {
        const result = await controllerBackups.createBackup({ backupId: randomUUID() });
        for (const warning of result.warnings ?? []) progress?.(warning, "stderr");
        return result;
      },
    }),
    defineOperation({
      id: "controller.backup.protect", title: "Keep an encrypted copy of a database backup", risk: "medium", timeoutMs: 12 * 60 * 60_000,
      description: "Copies one verified local backup into the separate encrypted restic repository, reads the whole repository back, and restore-drills the exact snapshot with no network. Nothing is pruned or overwritten.",
      parameters: { exact: false, fields: { backupId: { type: "string", pattern: /^[a-f0-9-]{36}$/ } } },
      run: (parameters, { controllerProtection }) => controllerProtection.protect(parameters),
    }),
    defineOperation({
      id: "controller.backup.retention.apply", title: "Let go of old database backups", risk: "medium", timeoutMs: 12 * 60 * 60_000,
      description: "Forgets only the pinned eligible old snapshots, verifies the repository afterwards, and never prunes, so reclaimed space is not claimed.",
      parameters: { exact: false, fields: { retentionId: { type: "string", optional: true } } },
      run: ({ candidates: _candidates, expectedBeforeCount: _expectedBeforeCount, ...parameters }, { controllerRetention }) => controllerRetention.apply(parameters),
    }),
  ];
}
