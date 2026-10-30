import { json, parseJson } from "./shared.mjs";

/** @param {import("./shared.mjs").StateContext & { recordAudit: import("./shared.mjs").RecordAudit }} context */
export function createBackupStore({ database, timestamp, recordAudit }) {
  function recordBackup({ id, applicationId, destination, artifactPath, checksumSha256, sizeBytes, downtimeMs, restoreDrill, createdBy }) {
    const at = timestamp();
    database.prepare(`
      INSERT INTO backups (id, application_id, destination_type, artifact_path, checksum_sha256, size_bytes, downtime_ms, restore_drill_json, created_by, created_at, verified_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, applicationId, destination, artifactPath, checksumSha256, sizeBytes, downtimeMs, json(restoreDrill), createdBy, at, at);
    recordAudit("backup.verified", { actorId: createdBy, subjectId: id, details: { applicationId, destination, checksumSha256, sizeBytes } });
    return getBackup(id);
  }

  function listBackups(limit = 50) {
    const safeLimit = Math.min(Math.max(Number.parseInt(String(limit), 10) || 50, 1), 200);
    return database.prepare("SELECT * FROM backups ORDER BY created_at DESC, rowid DESC LIMIT ?").all(safeLimit).map((row) => ({
      id: row.id,
      applicationId: row.application_id,
      destination: row.destination_type,
      artifactPath: row.artifact_path,
      checksumSha256: row.checksum_sha256,
      sizeBytes: Number(row.size_bytes),
      downtimeMs: Number(row.downtime_ms),
      restoreDrill: parseJson(row.restore_drill_json),
      createdBy: row.created_by,
      createdAt: row.created_at,
      verifiedAt: row.verified_at,
    }));
  }

  function getBackup(id) {
    const row = database.prepare("SELECT * FROM backups WHERE id = ?").get(id);
    return row ? {
      id: row.id,
      applicationId: row.application_id,
      destination: row.destination_type,
      artifactPath: row.artifact_path,
      checksumSha256: row.checksum_sha256,
      sizeBytes: Number(row.size_bytes),
      downtimeMs: Number(row.downtime_ms),
      restoreDrill: parseJson(row.restore_drill_json),
      createdBy: row.created_by,
      createdAt: row.created_at,
      verifiedAt: row.verified_at,
    } : null;
  }

  function recordControllerBackupProtection({ id, backupId, destination, repositoryId, snapshotId, sizeBytes, encrypted, independent, repositoryVerified, protected: protectedState, restoreDrill, createdBy }) {
    const at = timestamp();
    database.prepare(`
      INSERT INTO controller_backup_protections (id, backup_id, destination_type, repository_id, snapshot_id, size_bytes, encrypted, independent, repository_verified, protected, restore_drill_json, created_by, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, backupId, destination, repositoryId, snapshotId, sizeBytes, encrypted ? 1 : 0, independent ? 1 : 0, repositoryVerified ? 1 : 0, protectedState ? 1 : 0, json(restoreDrill), createdBy, at);
    recordAudit("controller.backup.protected", { actorId: createdBy, subjectId: id, details: { backupId, destination, repositoryId, snapshotId, sizeBytes, protected: protectedState } });
    return getControllerBackupProtection(id);
  }

  function mapControllerBackupProtection(row) {
    if (!row) return null;
    const retained = row.retention_run_id == null;
    return {
      id: row.id,
      backupId: row.backup_id,
      destination: row.destination_type,
      repositoryId: row.repository_id,
      snapshotId: row.snapshot_id,
      sizeBytes: Number(row.size_bytes),
      encrypted: Boolean(row.encrypted),
      independent: Boolean(row.independent),
      repositoryVerified: Boolean(row.repository_verified),
      protected: Boolean(row.protected) && retained,
      retained,
      retention: retained ? null : { runId: row.retention_run_id, forgottenAt: row.forgotten_at },
      restoreDrill: parseJson(row.restore_drill_json),
      createdBy: row.created_by,
      createdAt: row.created_at,
    };
  }

  function getControllerBackupProtection(id) {
    return mapControllerBackupProtection(database.prepare(`
      SELECT controller_backup_protections.*, controller_retention_members.run_id AS retention_run_id, controller_retention_members.forgotten_at
      FROM controller_backup_protections
      LEFT JOIN controller_retention_members ON controller_retention_members.protection_id = controller_backup_protections.id
      WHERE controller_backup_protections.id = ?
    `).get(id));
  }

  function getControllerBackupProtectionByBackup(backupId) {
    return mapControllerBackupProtection(database.prepare(`
      SELECT controller_backup_protections.*, controller_retention_members.run_id AS retention_run_id, controller_retention_members.forgotten_at
      FROM controller_backup_protections
      LEFT JOIN controller_retention_members ON controller_retention_members.protection_id = controller_backup_protections.id
      WHERE controller_backup_protections.backup_id = ?
    `).get(backupId));
  }

  function listControllerBackupProtections(limit = 50) {
    const safeLimit = Math.min(Math.max(Number.parseInt(String(limit), 10) || 50, 1), 200);
    return database.prepare(`
      SELECT controller_backup_protections.*, controller_retention_members.run_id AS retention_run_id, controller_retention_members.forgotten_at
      FROM controller_backup_protections
      LEFT JOIN controller_retention_members ON controller_retention_members.protection_id = controller_backup_protections.id
      ORDER BY controller_backup_protections.created_at DESC LIMIT ?
    `).all(safeLimit).map(mapControllerBackupProtection);
  }

  function listAllControllerBackupProtections() {
    return database.prepare(`
      SELECT controller_backup_protections.*, controller_retention_members.run_id AS retention_run_id, controller_retention_members.forgotten_at
      FROM controller_backup_protections
      LEFT JOIN controller_retention_members ON controller_retention_members.protection_id = controller_backup_protections.id
      ORDER BY controller_backup_protections.created_at DESC
    `).all().map(mapControllerBackupProtection);
  }

  function mapControllerRetentionRun(row) {
    return row ? {
      id: row.id,
      repositoryId: row.repository_id,
      beforeSnapshotSetRevision: row.before_snapshot_revision,
      afterSnapshotSetRevision: row.after_snapshot_revision,
      beforeCount: Number(row.before_count),
      afterCount: row.after_count == null ? null : Number(row.after_count),
      forgotten: parseJson(row.forgotten_json, []),
      keptSnapshotIds: parseJson(row.kept_snapshot_ids_json, []),
      repositoryVerified: Boolean(row.repository_verified),
      complete: Boolean(row.complete),
      prunePerformed: Boolean(row.prune_performed),
      verification: parseJson(row.verification_json, []),
      createdBy: row.created_by,
      createdAt: row.created_at,
    } : null;
  }

  function recordControllerRetention({ id, repositoryId, beforeSnapshotSetRevision, afterSnapshotSetRevision, beforeCount, afterCount, forgotten, keptSnapshotIds, repositoryVerified, complete = repositoryVerified, prunePerformed, verification = [], createdBy }) {
    const at = timestamp();
    database.exec("BEGIN IMMEDIATE");
    try {
      if (!Array.isArray(forgotten) || forgotten.length < 1) throw new Error("A controller retention run must identify forgotten protections");
      database.prepare(`
        INSERT INTO controller_retention_runs (id, repository_id, before_snapshot_revision, after_snapshot_revision, before_count, after_count, forgotten_json, kept_snapshot_ids_json, repository_verified, complete, prune_performed, verification_json, created_by, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(id, repositoryId, beforeSnapshotSetRevision, afterSnapshotSetRevision ?? null, beforeCount, afterCount ?? null, json(forgotten), json(keptSnapshotIds), repositoryVerified ? 1 : 0, complete ? 1 : 0, prunePerformed ? 1 : 0, json(verification), createdBy, at);
      for (const item of forgotten) {
        const protection = database.prepare("SELECT snapshot_id FROM controller_backup_protections WHERE id = ?").get(item.protectionId);
        if (!protection || protection.snapshot_id !== item.snapshotId) throw new Error("Retention evidence does not match a recorded controller protection");
        database.prepare("INSERT INTO controller_retention_members (run_id, protection_id, snapshot_id, forgotten_at) VALUES (?, ?, ?, ?)")
          .run(id, item.protectionId, item.snapshotId, at);
      }
      recordAudit("controller.retention.applied", { actorId: createdBy, subjectId: id, details: { repositoryId, beforeCount, afterCount, forgottenCount: forgotten.length, repositoryVerified, complete, prunePerformed, verification } });
      const run = getControllerRetentionRun(id);
      database.exec("COMMIT");
      return run;
    } catch (error) {
      try {
        database.exec("ROLLBACK");
      } catch {
        // Preserve the original retention-record error if SQLite already ended the transaction.
      }
      throw error;
    }
  }

  function getControllerRetentionRun(id) {
    return mapControllerRetentionRun(database.prepare("SELECT * FROM controller_retention_runs WHERE id = ?").get(id));
  }

  function listControllerRetentionRuns(limit = 50) {
    const safeLimit = Math.min(Math.max(Number.parseInt(String(limit), 10) || 50, 1), 200);
    return database.prepare("SELECT * FROM controller_retention_runs ORDER BY created_at DESC, rowid DESC LIMIT ?").all(safeLimit).map(mapControllerRetentionRun);
  }

  return {
    recordBackup,
    getBackup,
    listBackups,
    recordControllerBackupProtection,
    getControllerBackupProtection,
    getControllerBackupProtectionByBackup,
    listControllerBackupProtections,
    listAllControllerBackupProtections,
    recordControllerRetention,
    getControllerRetentionRun,
    listControllerRetentionRuns,
  };
}
