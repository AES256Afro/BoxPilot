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
  it("drops retired feature tables from an existing database", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "boxpilot-state-legacy-"));
    directories.push(directory);
    const databasePath = path.join(directory, "boxpilot.sqlite3");
    const legacy = new DatabaseSync(databasePath);
    legacy.exec(`
      CREATE TABLE fleet_agents (id TEXT PRIMARY KEY, name TEXT NOT NULL);
      CREATE TABLE router_checkpoints (id TEXT PRIMARY KEY);
      CREATE TABLE migration_sources (id TEXT PRIMARY KEY);
      INSERT INTO fleet_agents VALUES ('11111111-1111-4111-8111-111111111111', 'porch-pi');
    `);
    legacy.close();

    const store = createStateStore({ databasePath, stateDirectory: directory });
    const tables = new DatabaseSync(databasePath).prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name);
    expect(tables).not.toContain("fleet_agents");
    expect(tables).not.toContain("router_checkpoints");
    expect(tables).not.toContain("migration_sources");
    expect(tables).toContain("jobs");
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

  it("persists immutable expiring plan revisions", async () => {
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
    const retention = store.recordControllerRetention({
      id: "44444444-4444-4444-8444-444444444444",
      repositoryId: protection.repositoryId,
      beforeSnapshotSetRevision: "e".repeat(64),
      afterSnapshotSetRevision: "f".repeat(64),
      beforeCount: 4,
      afterCount: 3,
      forgotten: [{ protectionId: protection.id, backupId, snapshotId: protection.snapshotId }],
      keptSnapshotIds: ["1".repeat(64), "2".repeat(64), "3".repeat(64)],
      repositoryVerified: true,
      complete: true,
      prunePerformed: false,
      createdBy: owner.id,
    });
    expect(retention).toMatchObject({ beforeCount: 4, afterCount: 3, repositoryVerified: true, complete: true, prunePerformed: false });
    expect(store.getControllerBackupProtection(protection.id)).toMatchObject({ protected: false, retained: false, retention: { runId: retention.id } });
    expect(store.listControllerRetentionRuns()).toEqual([retention]);
    expect(store.listAudit()).toEqual(expect.arrayContaining([expect.objectContaining({ type: "controller.backup.protected", subjectId: protection.id })]));
    expect(store.listAudit()).toEqual(expect.arrayContaining([expect.objectContaining({ type: "controller.retention.applied", subjectId: retention.id })]));
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

  it("adds operators and viewers, changes roles, disables accounts, and keeps one owner", async () => {
    const store = await testStore();
    const bootstrap = store.createBootstrapToken();
    const owner = store.consumeBootstrapToken(bootstrap.token, { username: "operator", passwordHash: "hash" });
    expect(store.findOwnerById(owner.id).role).toBe("owner");
    const sam = store.createOwnerAccount({ username: "sam", passwordHash: "hash2", role: "operator", createdBy: owner.id });
    expect(store.listOwners().map((person) => [person.username, person.role])).toEqual([["operator", "owner"], ["sam", "operator"]]);
    expect(() => store.createOwnerAccount({ username: "sam", passwordHash: "x", role: "viewer", createdBy: owner.id })).toThrow("already taken");
    expect(() => store.createOwnerAccount({ username: "eve", passwordHash: "x", role: "root", createdBy: owner.id })).toThrow("Role must be");
    const session = store.createSession(sam.id);
    expect(store.getSession(session.token).owner).toMatchObject({ username: "sam", role: "operator" });
    expect(store.setOwnerRole(sam.id, "viewer", { actorId: owner.id }).role).toBe("viewer");
    expect(store.getSession(session.token)).toBeNull(); // role changes end existing sessions
    expect(() => store.setOwnerRole(owner.id, "viewer", { actorId: owner.id })).toThrow("at least one owner");
    expect(() => store.disableOwner(owner.id, { actorId: owner.id })).toThrow("at least one owner");
    const keep = store.createSession(owner.id); const other = store.createSession(owner.id);
    store.setOwnerPassword(owner.id, "hash-new", { keepSessionTokenHash: store.getSession(keep.token).tokenHash });
    expect(store.findOwnerById(owner.id).passwordHash).toBe("hash-new");
    expect(store.getSession(keep.token)).not.toBeNull();
    expect(store.getSession(other.token)).toBeNull();
    expect(store.disableOwner(sam.id, { actorId: owner.id }).role).toBe("disabled");
    expect(store.listAudit().map((event) => event.type)).toEqual(expect.arrayContaining(["people.added", "people.role-changed", "people.password-changed", "people.disabled"]));
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

  it("notifies job subscribers with coalesced snapshots and stops after unsubscribe", async () => {
    const store = await testStore();
    const bootstrap = store.createBootstrapToken();
    const owner = store.consumeBootstrapToken(bootstrap.token, { username: "operator", passwordHash: "hash" });
    const events = [];
    const unsubscribe = store.subscribeJobs((job) => events.push(job));

    const job = store.createJob({ type: "helper.canary.verify", title: "Verify helper", createdBy: owner.id });
    await Promise.resolve();
    // Creation plus its initial steps deliver one snapshot, not one per write.
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ id: job.id, state: "awaiting_approval", steps: [expect.anything(), expect.anything()] });

    store.transitionJob(job.id, "awaiting_approval", "applying");
    store.addJobStep(job.id, "apply", "running", "Working");
    await Promise.resolve();
    expect(events).toHaveLength(2);
    expect(events[1]).toMatchObject({ id: job.id, state: "applying", steps: expect.arrayContaining([expect.objectContaining({ name: "apply" })]) });

    unsubscribe();
    store.transitionJob(job.id, "applying", "completed");
    await Promise.resolve();
    expect(events).toHaveLength(2);
    store.close();
  });
});

describe("history retention", () => {
  it("prunes old finished jobs beyond the newest few and caps audit rows", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "boxpilot-prune-"));
    directories.push(directory);
    const store = createStateStore({ stateDirectory: directory });
    const owner = store.consumeBootstrapToken(store.createBootstrapToken().token, { username: "admin", passwordHash: "x" });
    const ids = [];
    for (let i = 0; i < 4; i += 1) ids.push(store.createJob({ type: "op:apt.refresh", title: "x", risk: "low", parameters: {}, createdBy: owner.id, initialSteps: [] }).id);
    store.transitionJob(ids[0], "awaiting_approval", "completed");
    store.transitionJob(ids[1], "awaiting_approval", "failed", { error: "x" });
    for (let i = 0; i < 30; i += 1) store.recordAudit("test.event", { actorId: owner.id, subjectId: null, details: {} });
    // A day later: the finished jobs are inside their window, and nothing is abandoned yet.
    const tomorrow = new Date(Date.now() + 86_400_000).toISOString();
    const early = store.pruneHistory({ keepJobs: 0, jobDays: 90, keepAudit: 20_000, now: tomorrow });
    expect(early).toMatchObject({ removedJobs: 0, removedAbandoned: 0 });
    expect(store.getJob(ids[2])).not.toBeNull();

    const future = new Date(Date.now() + 100 * 86_400_000).toISOString();
    const result = store.pruneHistory({ keepJobs: 0, jobDays: 90, keepAudit: 10, now: future });
    expect(result.removedJobs).toBe(2); // the two finished ones
    expect(store.getJob(ids[0])).toBeNull();
    // The two still awaiting approval were staged before a restart that lost their parameters:
    // after a month they are abandoned, not pending, so they go too.
    expect(result.removedAbandoned).toBe(2);
    expect(store.getJob(ids[2])).toBeNull();
    expect(result.removedAudit).toBeGreaterThan(0);
  });

  it("clears expired sessions and spent plans, and keeps the ones still in use", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "boxpilot-prune-sessions-"));
    directories.push(directory);
    const store = createStateStore({ stateDirectory: directory });
    const owner = store.consumeBootstrapToken(store.createBootstrapToken().token, { username: "admin", passwordHash: "x" });
    const live = store.createSession(owner.id, { ttlMs: 60 * 60_000 });
    const dead = store.createSession(owner.id, { ttlMs: 1 });
    await new Promise((resolve) => setTimeout(resolve, 5));

    const result = store.pruneHistory({ now: new Date().toISOString() });
    expect(result.removedSessions).toBe(1);
    expect(store.getSession(live.token)).not.toBeNull();
    expect(store.getSession(dead.token)).toBeNull();
  });

  it("removes the bootstrap token row once it has been spent", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "boxpilot-prune-bootstrap-"));
    directories.push(directory);
    const store = createStateStore({ stateDirectory: directory });
    const { token } = store.createBootstrapToken();
    store.consumeBootstrapToken(token, { username: "admin", passwordHash: "x" });
    // Nothing may be left holding a hash of a credential that has already been used.
    const inspector = new DatabaseSync(path.join(directory, "boxpilot.sqlite3"), { readOnly: true });
    expect(inspector.prepare("SELECT COUNT(*) AS n FROM bootstrap_tokens").get().n).toBe(0);
    inspector.close();
    expect(() => store.consumeBootstrapToken(token, { username: "second", passwordHash: "x" })).toThrow();
  });
});

describe("job visibility", () => {
  it("lists only one account's jobs when scoped", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "boxpilot-scope-"));
    directories.push(directory);
    const store = createStateStore({ stateDirectory: directory });
    const owner = store.consumeBootstrapToken(store.createBootstrapToken().token, { username: "admin", passwordHash: "x" });
    const helper = store.createOwnerAccount({ username: "helper", passwordHash: "x", role: "operator", createdBy: owner.id });
    const ownerJob = store.createJob({ type: "op:apt.refresh", title: "owner", risk: "low", parameters: { secret: "theirs" }, createdBy: owner.id, initialSteps: [] });
    const helperJob = store.createJob({ type: "op:apt.refresh", title: "helper", risk: "low", parameters: {}, createdBy: helper.id, initialSteps: [] });
    expect(store.listJobs(50).map((job) => job.id).sort()).toEqual([ownerJob.id, helperJob.id].sort());
    expect(store.listJobs(50, { createdBy: helper.id }).map((job) => job.id)).toEqual([helperJob.id]);
  });
});

describe("the bootstrap token", () => {
  it("can be checked without being spent, and stops being usable once it is", async () => {
    const store = await testStore();
    const { token } = store.createBootstrapToken();
    // Checking is read-only: the setup screen can reject junk without paying for a password hash.
    expect(store.bootstrapTokenUsable(token)).toBe(true);
    expect(store.bootstrapTokenUsable(token)).toBe(true);
    expect(store.bootstrapTokenUsable("not-a-real-token")).toBe(false);
    store.consumeBootstrapToken(token, { username: "admin", passwordHash: "x" });
    expect(store.bootstrapTokenUsable(token)).toBe(false);
  });
});
