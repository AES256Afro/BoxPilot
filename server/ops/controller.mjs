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
  ];
}
