import { json, parseJson } from "./shared.mjs";

/** @param {import("./shared.mjs").StateContext & { recordAudit: import("./shared.mjs").RecordAudit }} context */
export function createVmLedgerStore({ database, timestamp, recordAudit }) {
  function recordVmExport({ id, domainName, domainUuid, destination, artifactPath, manifestChecksumSha256, sizeBytes, protected: protectedState, encrypted, restoreDrill, createdBy }) {
    const at = timestamp();
    database.prepare(`
      INSERT INTO vm_exports (id, domain_name, domain_uuid, destination_type, artifact_path, manifest_checksum_sha256, size_bytes, protected, encrypted, restore_drill_json, created_by, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, domainName, domainUuid, destination, artifactPath, manifestChecksumSha256, sizeBytes, protectedState ? 1 : 0, encrypted ? 1 : 0, json(restoreDrill), createdBy, at);
    recordAudit("vm.export.recorded", { actorId: createdBy, subjectId: id, details: { domainName, domainUuid, destination, manifestChecksumSha256, sizeBytes, protected: protectedState, encrypted } });
    return getVmExport(id);
  }

  function mapVmExport(row) {
    return row ? {
      id: row.id,
      domainName: row.domain_name,
      domainUuid: row.domain_uuid,
      destination: row.destination_type,
      artifactPath: row.artifact_path,
      manifestChecksumSha256: row.manifest_checksum_sha256,
      sizeBytes: Number(row.size_bytes),
      protected: Boolean(row.protected),
      encrypted: Boolean(row.encrypted),
      restoreDrill: parseJson(row.restore_drill_json),
      createdBy: row.created_by,
      createdAt: row.created_at,
    } : null;
  }

  function listVmExports(limit = 50) {
    const safeLimit = Math.min(Math.max(Number.parseInt(String(limit), 10) || 50, 1), 200);
    return database.prepare("SELECT * FROM vm_exports ORDER BY created_at DESC, rowid DESC LIMIT ?").all(safeLimit).map(mapVmExport);
  }

  function getVmExport(id) {
    return mapVmExport(database.prepare("SELECT * FROM vm_exports WHERE id = ?").get(id));
  }

  function recordVmBackup({ id, exportId, domainName, domainUuid, destination, repositoryId, snapshotId, sizeBytes, encrypted, independent, repositoryVerified, protected: protectedState, restoreDrill, createdBy }) {
    const at = timestamp();
    database.prepare(`
      INSERT INTO vm_backups (id, export_id, domain_name, domain_uuid, destination_type, repository_id, snapshot_id, size_bytes, encrypted, independent, repository_verified, protected, restore_drill_json, created_by, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, exportId, domainName, domainUuid, destination, repositoryId, snapshotId, sizeBytes, encrypted ? 1 : 0, independent ? 1 : 0, repositoryVerified ? 1 : 0, protectedState ? 1 : 0, json(restoreDrill), createdBy, at);
    recordAudit("vm.backup.recorded", { actorId: createdBy, subjectId: id, details: { exportId, domainName, destination, repositoryId, snapshotId, sizeBytes, encrypted, independent, repositoryVerified, protected: protectedState } });
    return getVmBackup(id);
  }

  function mapVmBackup(row) {
    return row ? {
      id: row.id,
      exportId: row.export_id,
      domainName: row.domain_name,
      domainUuid: row.domain_uuid,
      destination: row.destination_type,
      repositoryId: row.repository_id,
      snapshotId: row.snapshot_id,
      sizeBytes: Number(row.size_bytes),
      encrypted: Boolean(row.encrypted),
      independent: Boolean(row.independent),
      repositoryVerified: Boolean(row.repository_verified),
      protected: Boolean(row.protected),
      restoreDrill: parseJson(row.restore_drill_json),
      retained: row.retention_run_id == null,
      retention: row.retention_run_id == null ? null : { runId: row.retention_run_id, forgottenAt: row.forgotten_at },
      createdBy: row.created_by,
      createdAt: row.created_at,
    } : null;
  }

  function listVmBackups(limit = 50) {
    const safeLimit = Math.min(Math.max(Number.parseInt(String(limit), 10) || 50, 1), 200);
    return database.prepare(`
      SELECT vm_backups.*, vm_retention_members.run_id AS retention_run_id, vm_retention_members.forgotten_at
      FROM vm_backups LEFT JOIN vm_retention_members ON vm_retention_members.backup_id = vm_backups.id
      ORDER BY vm_backups.created_at DESC LIMIT ?
    `).all(safeLimit).map(mapVmBackup);
  }

  function listAllVmBackups() {
    return database.prepare(`
      SELECT vm_backups.*, vm_retention_members.run_id AS retention_run_id, vm_retention_members.forgotten_at
      FROM vm_backups LEFT JOIN vm_retention_members ON vm_retention_members.backup_id = vm_backups.id
      ORDER BY vm_backups.created_at DESC
    `).all().map(mapVmBackup);
  }

  function getVmBackup(id) {
    return mapVmBackup(database.prepare(`
      SELECT vm_backups.*, vm_retention_members.run_id AS retention_run_id, vm_retention_members.forgotten_at
      FROM vm_backups LEFT JOIN vm_retention_members ON vm_retention_members.backup_id = vm_backups.id
      WHERE vm_backups.id = ?
    `).get(id));
  }

  function recordVmRestoreDrill({ backupId, restoreDrill, createdBy }) {
    database.exec("BEGIN IMMEDIATE");
    try {
      const update = database.prepare("UPDATE vm_backups SET protected = 1, restore_drill_json = ? WHERE id = ? AND protected = 0")
        .run(json(restoreDrill), backupId);
      if (Number(update.changes) !== 1) throw new Error("VM backup is unavailable or already protected");
      recordAudit("vm.restore_drill.passed", { actorId: createdBy, subjectId: backupId, details: restoreDrill });
      const backup = getVmBackup(backupId);
      database.exec("COMMIT");
      return backup;
    } catch (error) {
      try {
        database.exec("ROLLBACK");
      } catch {
        // Preserve the original evidence-write error if SQLite already ended the transaction.
      }
      throw error;
    }
  }

  function mapVmRecovery(row) {
    return row ? {
      id: row.id,
      backupId: row.backup_id,
      sourceDomainName: row.source_domain_name,
      sourceDomainUuid: row.source_domain_uuid,
      domainName: row.domain_name,
      domainUuid: row.domain_uuid,
      destination: row.destination_type,
      sizeBytes: Number(row.size_bytes),
      state: row.state,
      network: row.network,
      autostart: Boolean(row.autostart),
      createdBy: row.created_by,
      createdAt: row.created_at,
    } : null;
  }

  function recordVmRecovery({ id, backupId, sourceDomainName, sourceDomainUuid, domainName, domainUuid, destination, sizeBytes, state, network, autostart, createdBy }) {
    const at = timestamp();
    database.exec("BEGIN IMMEDIATE");
    try {
      database.prepare(`
        INSERT INTO vm_recoveries (id, backup_id, source_domain_name, source_domain_uuid, domain_name, domain_uuid, destination_type, size_bytes, state, network, autostart, created_by, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(id, backupId, sourceDomainName, sourceDomainUuid, domainName, domainUuid, destination, sizeBytes, state, network, autostart ? 1 : 0, createdBy, at);
      recordAudit("vm.recovery.created", { actorId: createdBy, subjectId: id, details: { backupId, sourceDomainName, domainName, domainUuid, destination, sizeBytes, state, network, autostart } });
      const recovery = getVmRecovery(id);
      database.exec("COMMIT");
      return recovery;
    } catch (error) {
      try {
        database.exec("ROLLBACK");
      } catch {
        // Preserve the original recovery-record error if SQLite already ended the transaction.
      }
      throw error;
    }
  }

  function getVmRecovery(id) {
    return mapVmRecovery(database.prepare("SELECT * FROM vm_recoveries WHERE id = ?").get(id));
  }

  function listVmRecoveries(limit = 50) {
    const safeLimit = Math.min(Math.max(Number.parseInt(String(limit), 10) || 50, 1), 200);
    return database.prepare("SELECT * FROM vm_recoveries ORDER BY created_at DESC, rowid DESC LIMIT ?").all(safeLimit).map(mapVmRecovery);
  }

  function listAllVmRecoveries() {
    return database.prepare("SELECT * FROM vm_recoveries ORDER BY created_at DESC, rowid DESC").all().map(mapVmRecovery);
  }

  function mapVmRetentionRun(row) {
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

  function recordVmRetention({ id, repositoryId, beforeSnapshotSetRevision, afterSnapshotSetRevision, beforeCount, afterCount, forgotten, keptSnapshotIds, repositoryVerified, complete = repositoryVerified, prunePerformed, verification = [], createdBy }) {
    const at = timestamp();
    database.exec("BEGIN IMMEDIATE");
    try {
      if (!Array.isArray(forgotten) || forgotten.length < 1) throw new Error("A retention run must identify forgotten backups");
      database.prepare(`
        INSERT INTO vm_retention_runs (id, repository_id, before_snapshot_revision, after_snapshot_revision, before_count, after_count, forgotten_json, kept_snapshot_ids_json, repository_verified, complete, prune_performed, verification_json, created_by, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(id, repositoryId, beforeSnapshotSetRevision, afterSnapshotSetRevision ?? null, beforeCount, afterCount ?? null, json(forgotten), json(keptSnapshotIds), repositoryVerified ? 1 : 0, complete ? 1 : 0, prunePerformed ? 1 : 0, json(verification), createdBy, at);
      for (const item of forgotten) {
        const backup = database.prepare("SELECT snapshot_id FROM vm_backups WHERE id = ?").get(item.backupId);
        if (!backup || backup.snapshot_id !== item.snapshotId) throw new Error("Retention evidence does not match a recorded VM backup");
        database.prepare("INSERT INTO vm_retention_members (run_id, backup_id, snapshot_id, forgotten_at) VALUES (?, ?, ?, ?)")
          .run(id, item.backupId, item.snapshotId, at);
      }
      recordAudit("vm.retention.applied", { actorId: createdBy, subjectId: id, details: { repositoryId, beforeCount, afterCount, forgottenCount: forgotten.length, repositoryVerified, complete, prunePerformed, verification } });
      const run = getVmRetentionRun(id);
      database.exec("COMMIT");
      return run;
    } catch (error) {
      try {
        database.exec("ROLLBACK");
      } catch {
        // Preserve the original evidence-write error if SQLite already ended the transaction.
      }
      throw error;
    }
  }

  function getVmRetentionRun(id) {
    return mapVmRetentionRun(database.prepare("SELECT * FROM vm_retention_runs WHERE id = ?").get(id));
  }

  function listVmRetentionRuns(limit = 50) {
    const safeLimit = Math.min(Math.max(Number.parseInt(String(limit), 10) || 50, 1), 200);
    return database.prepare("SELECT * FROM vm_retention_runs ORDER BY created_at DESC, rowid DESC LIMIT ?").all(safeLimit).map(mapVmRetentionRun);
  }

  return {
    recordVmExport,
    listVmExports,
    getVmExport,
    recordVmBackup,
    listVmBackups,
    listAllVmBackups,
    getVmBackup,
    recordVmRestoreDrill,
    recordVmRecovery,
    getVmRecovery,
    listVmRecoveries,
    listAllVmRecoveries,
    recordVmRetention,
    getVmRetentionRun,
    listVmRetentionRuns,
  };
}
