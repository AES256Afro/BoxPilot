import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { createStateStore } from "./state.mjs";

const directories = [];

async function testStore(options = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "boxpilot-state-"));
  directories.push(directory);
  return createStateStore({ stateDirectory: directory, ...options });
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("BoxPilot state store", () => {
  it("migrates existing fleet tasks to an immediate dispatch window", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "boxpilot-state-legacy-fleet-"));
    directories.push(directory);
    const databasePath = path.join(directory, "boxpilot.sqlite3");
    const legacy = new DatabaseSync(databasePath);
    legacy.exec(`
      CREATE TABLE fleet_tasks (
        id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, type TEXT NOT NULL, payload_json TEXT NOT NULL,
        controller_acceptance_id TEXT, state TEXT NOT NULL, created_by TEXT NOT NULL,
        created_at TEXT NOT NULL, expires_at TEXT NOT NULL, completed_at TEXT
      );
      INSERT INTO fleet_tasks VALUES (
        '11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222',
        'dns.pi-hole.acceptance.v1', '{}', NULL, 'expired', '33333333-3333-4333-8333-333333333333',
        '2026-08-16T01:00:00.000Z', '2026-08-16T01:10:00.000Z', NULL
      );
    `);
    legacy.close();

    const store = createStateStore({ databasePath, stateDirectory: directory, now: () => new Date("2026-08-16T02:00:00.000Z") });
    expect(store.listFleetTasks()).toEqual([expect.objectContaining({
      availableAt: "2026-08-16T01:00:00.000Z",
      createdAt: "2026-08-16T01:00:00.000Z",
      routerAcceptanceId: null,
      state: "expired",
    })]);
    expect(store.listAudit()).toEqual([]);
    store.close();
  });

  it("requires a fresh server-local token to bootstrap one owner", async () => {
    const store = await testStore({ tokenBytes: () => Buffer.alloc(32, 7) });
    const bootstrap = store.createBootstrapToken();
    const owner = store.consumeBootstrapToken(bootstrap.token, { username: "operator", passwordHash: "hash" });

    expect(owner.username).toBe("operator");
    expect(store.ownerCount()).toBe(1);
    expect(() => store.consumeBootstrapToken(bootstrap.token, { username: "again", passwordHash: "hash" })).toThrow("already exists");
    expect(store.listAudit()).toMatchObject([{ type: "owner.bootstrapped", actorId: owner.id }]);
    store.close();
  });

  it("expires bootstrap tokens without creating an owner", async () => {
    let current = new Date("2026-08-15T12:00:00Z");
    const store = await testStore({ now: () => current });
    const bootstrap = store.createBootstrapToken({ ttlMs: 1000 });
    current = new Date("2026-08-15T12:00:02Z");

    expect(() => store.consumeBootstrapToken(bootstrap.token, { username: "operator", passwordHash: "hash" })).toThrow("invalid or expired");
    expect(store.ownerCount()).toBe(0);
    store.close();
  });

  it("stores only a digest of session tokens and enforces expiry", async () => {
    let current = new Date("2026-08-15T12:00:00Z");
    const store = await testStore({ now: () => current });
    const bootstrap = store.createBootstrapToken();
    const owner = store.consumeBootstrapToken(bootstrap.token, { username: "operator", passwordHash: "hash" });
    const session = store.createSession(owner.id, { ttlMs: 1000 });

    expect(store.getSession(session.token)?.owner.username).toBe("operator");
    current = new Date("2026-08-15T12:00:02Z");
    expect(store.getSession(session.token)).toBeNull();
    expect(store.deleteExpiredSessions()).toBe(1);
    store.close();
  });

  it("persists job plans, approvals, steps, and terminal results", async () => {
    const store = await testStore();
    const bootstrap = store.createBootstrapToken();
    const owner = store.consumeBootstrapToken(bootstrap.token, { username: "operator", passwordHash: "hash" });
    const job = store.createJob({
      type: "helper.canary.verify",
      title: "Verify helper",
      createdBy: owner.id,
      recovery: { reason: "No mutation" },
    });

    expect(job.state).toBe("awaiting_approval");
    expect(job.steps).toHaveLength(2);
    store.addApproval(job.id, owner.id);
    store.transitionJob(job.id, "awaiting_approval", "applying");
    store.transitionJob(job.id, "applying", "completed", { result: { verified: true } });

    expect(store.getJob(job.id)).toMatchObject({
      state: "completed",
      result: { verified: true },
      approvals: [{ ownerId: owner.id }],
    });
    store.close();
  });

  it("persists immutable expiring plan revisions and stages them once", async () => {
    const store = await testStore();
    const bootstrap = store.createBootstrapToken();
    const owner = store.consumeBootstrapToken(bootstrap.token, { username: "operator", passwordHash: "hash" });
    const plan = store.createPlan({
      type: "application.deploy",
      subjectId: "uptime-kuma",
      input: { hostPort: 3001 },
      output: { blockers: [] },
      createdBy: owner.id,
    });

    expect(store.getPlan(plan.id)).toMatchObject({ revision: plan.revision, status: "draft", expired: false });
    expect(store.stagePlan(plan.id, owner.id).status).toBe("staged");
    expect(() => store.stagePlan(plan.id, owner.id)).toThrow("already been staged");
    store.close();
  });

  it("records backup integrity and isolated restore evidence", async () => {
    const store = await testStore();
    const bootstrap = store.createBootstrapToken();
    const owner = store.consumeBootstrapToken(bootstrap.token, { username: "operator", passwordHash: "hash" });
    const backup = store.recordBackup({
      id: "11111111-1111-4111-8111-111111111111",
      applicationId: "uptime-kuma",
      destination: "local-managed",
      artifactPath: "/var/lib/boxpilot-managed/backups/uptime-kuma/fixture.tar.gz",
      checksumSha256: "a".repeat(64),
      sizeBytes: 4096,
      downtimeMs: 250,
      restoreDrill: { passed: true, network: "none", publishedPorts: 0 },
      createdBy: owner.id,
    });

    expect(backup).toMatchObject({ applicationId: "uptime-kuma", sizeBytes: 4096, restoreDrill: { passed: true, network: "none", publishedPorts: 0 } });
    expect(store.listAudit()).toEqual(expect.arrayContaining([expect.objectContaining({ type: "backup.verified", subjectId: backup.id })]));
    store.close();
  });

  it("records independent encrypted controller protection separately from its immutable local backup", async () => {
    const store = await testStore();
    const bootstrap = store.createBootstrapToken();
    const owner = store.consumeBootstrapToken(bootstrap.token, { username: "operator", passwordHash: "hash" });
    const backupId = "11111111-1111-4111-8111-111111111111";
    store.recordBackup({
      id: backupId,
      applicationId: "boxpilot-controller",
      destination: "local-managed",
      artifactPath: `/var/lib/boxpilot-managed/backups/boxpilot-controller/${backupId}/boxpilot.sqlite3`,
      checksumSha256: "a".repeat(64),
      sizeBytes: 8192,
      downtimeMs: 0,
      restoreDrill: { passed: true, mode: "isolated-copy-open", manifestChecksumSha256: "b".repeat(64) },
      createdBy: owner.id,
    });
    const protection = store.recordControllerBackupProtection({
      id: "22222222-2222-4222-8222-222222222222",
      backupId,
      destination: "mounted-restic-controller",
      repositoryId: "c".repeat(64),
      snapshotId: "d".repeat(64),
      sizeBytes: 8192,
      encrypted: true,
      independent: true,
      repositoryVerified: true,
      protected: true,
      restoreDrill: { passed: true, mode: "exact-snapshot-isolated-copy-open", network: "none", workspaceRemoved: true },
      createdBy: owner.id,
    });

    expect(protection).toMatchObject({ backupId, encrypted: true, independent: true, repositoryVerified: true, protected: true });
    expect(store.getControllerBackupProtectionByBackup(backupId)?.snapshotId).toBe("d".repeat(64));
    expect(store.listControllerBackupProtections()).toEqual([protection]);
    expect(() => store.recordControllerBackupProtection({ ...protection, id: "33333333-3333-4333-8333-333333333333" })).toThrow();
    expect(store.listAudit()).toEqual(expect.arrayContaining([expect.objectContaining({ type: "controller.backup.protected", subjectId: protection.id })]));
    store.close();
  });

  it("records a verified local VM export without promoting it to a protected backup", async () => {
    const store = await testStore();
    const bootstrap = store.createBootstrapToken();
    const owner = store.consumeBootstrapToken(bootstrap.token, { username: "operator", passwordHash: "hash" });
    const artifact = store.recordVmExport({
      id: "11111111-1111-4111-8111-111111111111",
      domainName: "ubuntu-lab",
      domainUuid: "22222222-2222-4222-8222-222222222222",
      destination: "local-managed",
      artifactPath: "/var/lib/boxpilot-managed/vm-exports/11111111-1111-4111-8111-111111111111",
      manifestChecksumSha256: "a".repeat(64),
      sizeBytes: 8192,
      protected: false,
      encrypted: false,
      restoreDrill: { passed: false, reason: "not run" },
      createdBy: owner.id,
    });

    expect(artifact).toMatchObject({ domainName: "ubuntu-lab", protected: false, encrypted: false, restoreDrill: { passed: false } });
    expect(store.listAudit()).toEqual(expect.arrayContaining([expect.objectContaining({ type: "vm.export.recorded", subjectId: artifact.id })]));
    store.close();
  });

  it("records an encrypted independent VM backup as unprotected until restore evidence exists", async () => {
    const store = await testStore();
    const bootstrap = store.createBootstrapToken();
    const owner = store.consumeBootstrapToken(bootstrap.token, { username: "operator", passwordHash: "hash" });
    const exportId = "11111111-1111-4111-8111-111111111111";
    store.recordVmExport({
      id: exportId, domainName: "ubuntu-lab", domainUuid: "22222222-2222-4222-8222-222222222222", destination: "local-managed",
      artifactPath: `/var/lib/boxpilot-managed/vm-exports/${exportId}`, manifestChecksumSha256: "a".repeat(64), sizeBytes: 8192,
      protected: false, encrypted: false, restoreDrill: { passed: false }, createdBy: owner.id,
    });
    const backup = store.recordVmBackup({
      id: "33333333-3333-4333-8333-333333333333", exportId, domainName: "ubuntu-lab", domainUuid: "22222222-2222-4222-8222-222222222222",
      destination: "mounted-restic", repositoryId: "b".repeat(64), snapshotId: "c".repeat(64), sizeBytes: 8192,
      encrypted: true, independent: true, repositoryVerified: true, protected: false, restoreDrill: { passed: false, reason: "not run" }, createdBy: owner.id,
    });

    expect(backup).toMatchObject({ exportId, encrypted: true, independent: true, repositoryVerified: true, protected: false, restoreDrill: { passed: false } });
    const protectedBackup = store.recordVmRestoreDrill({
      backupId: backup.id,
      restoreDrill: { passed: true, network: "none", transient: true, guestAgentPing: true, cleanupVerified: true },
      createdBy: owner.id,
    });
    expect(protectedBackup).toMatchObject({ protected: true, restoreDrill: { passed: true, network: "none", transient: true, guestAgentPing: true, cleanupVerified: true } });
    expect(() => store.recordVmRestoreDrill({ backupId: backup.id, restoreDrill: { passed: true }, createdBy: owner.id })).toThrow("already protected");
    const recovery = store.recordVmRecovery({
      id: "55555555-5555-4555-8555-555555555555",
      backupId: backup.id,
      sourceDomainName: "ubuntu-lab",
      sourceDomainUuid: "11111111-1111-4111-8111-111111111111",
      domainName: "ubuntu-recovered",
      domainUuid: "66666666-6666-4666-8666-666666666666",
      destination: "managed-libvirt-recovery",
      sizeBytes: 4096,
      state: "stopped",
      network: "none",
      autostart: false,
      createdBy: owner.id,
    });
    expect(recovery).toMatchObject({ backupId: backup.id, domainName: "ubuntu-recovered", destination: "managed-libvirt-recovery", state: "stopped", network: "none", autostart: false });
    expect(store.listVmRecoveries()).toHaveLength(1);
    const retention = store.recordVmRetention({
      id: "77777777-7777-4777-8777-777777777777",
      repositoryId: backup.repositoryId,
      beforeSnapshotSetRevision: "d".repeat(64),
      afterSnapshotSetRevision: "e".repeat(64),
      beforeCount: 4,
      afterCount: 3,
      forgotten: [{ backupId: backup.id, snapshotId: backup.snapshotId, domainName: backup.domainName }],
      keptSnapshotIds: ["f".repeat(64)],
      repositoryVerified: true,
      prunePerformed: false,
      createdBy: owner.id,
    });
    expect(retention).toMatchObject({ beforeCount: 4, afterCount: 3, repositoryVerified: true, prunePerformed: false });
    expect(store.getVmBackup(backup.id)).toMatchObject({ retained: false, retention: { runId: retention.id } });
    expect(store.listVmRetentionRuns()).toHaveLength(1);
    expect(store.listAudit()).toEqual(expect.arrayContaining([expect.objectContaining({ type: "vm.backup.recorded", subjectId: backup.id })]));
    expect(store.listAudit()).toEqual(expect.arrayContaining([expect.objectContaining({ type: "vm.restore_drill.passed", subjectId: backup.id })]));
    expect(store.listAudit()).toEqual(expect.arrayContaining([expect.objectContaining({ type: "vm.recovery.created", subjectId: recovery.id })]));
    expect(store.listAudit()).toEqual(expect.arrayContaining([expect.objectContaining({ type: "vm.retention.applied", subjectId: retention.id })]));
    store.close();
  });

  it("stores immutable sanitized migration source manifests by fingerprint", async () => {
    const store = await testStore();
    const bootstrap = store.createBootstrapToken();
    const owner = store.consumeBootstrapToken(bootstrap.token, { username: "operator", passwordHash: "hash" });
    const manifest = { schemaVersion: 1, source: { hostname: "oldbox", architecture: "x64" }, docker: { containers: [] } };
    const first = store.importMigrationSource({ fingerprint: "sha256:fixture", manifest, importedBy: owner.id });
    const duplicate = store.importMigrationSource({ fingerprint: "sha256:fixture", manifest, importedBy: owner.id });

    expect(duplicate.id).toBe(first.id);
    expect(store.listMigrationSources()).toEqual([expect.objectContaining({ fingerprint: "sha256:fixture", manifest })]);
    expect(store.listAudit()).toEqual(expect.arrayContaining([expect.objectContaining({ type: "migration.source.imported", subjectId: first.id })]));

    const transfer = store.recordMigrationTransfer({
      id: "11111111-1111-4111-8111-111111111111",
      bundleId: "22222222-2222-4222-8222-222222222222",
      sourceId: first.id,
      sourceFingerprint: first.fingerprint,
      contentRevision: "a".repeat(64),
      workloadName: "keel-notes",
      destination: "managed-migration-staging/22222222-2222-4222-8222-222222222222",
      fileCount: 4,
      sizeBytes: 8192,
      contentVerified: true,
      sourcePreserved: true,
      activationPerformed: false,
      createdBy: owner.id,
    });
    expect(transfer).toMatchObject({ bundleId: "22222222-2222-4222-8222-222222222222", workloadName: "keel-notes", contentVerified: true, sourcePreserved: true, activationPerformed: false });
    expect(store.listMigrationTransfers()).toHaveLength(1);
    expect(store.listAudit()).toEqual(expect.arrayContaining([expect.objectContaining({ type: "migration.transfer.verified", subjectId: transfer.id })]));
    store.close();
  });

  it("fails interrupted jobs without automatically retrying them", async () => {
    const store = await testStore();
    const bootstrap = store.createBootstrapToken();
    const owner = store.consumeBootstrapToken(bootstrap.token, { username: "operator", passwordHash: "hash" });
    const job = store.createJob({ type: "helper.canary.verify", title: "Verify helper", createdBy: owner.id });
    store.transitionJob(job.id, "awaiting_approval", "applying");

    expect(store.recoverInterruptedJobs()).toBe(1);
    expect(store.getJob(job.id)).toMatchObject({ state: "failed", error: expect.stringContaining("restarted") });
    store.close();
  });
});
