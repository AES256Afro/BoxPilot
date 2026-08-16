import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createJobService } from "./jobs.mjs";
import { hashPassword } from "./security.mjs";
import { createStateStore } from "./state.mjs";

const directories = [];

async function setup(helper) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "boxpilot-jobs-"));
  directories.push(directory);
  const store = createStateStore({ stateDirectory: directory });
  const bootstrap = store.createBootstrapToken();
  const owner = store.consumeBootstrapToken(bootstrap.token, {
    username: "operator",
    passwordHash: await hashPassword("correct horse battery"),
  });
  return { store, owner, jobs: createJobService(store, helper) };
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("durable job executor", () => {
  it("requires password reauthentication before invoking the helper", async () => {
    const helper = { request: vi.fn() };
    const { store, owner, jobs } = await setup(helper);
    const job = jobs.createCanary(owner.id);

    await expect(jobs.approveAndRun(job.id, owner.id, "wrong password")).rejects.toThrow("reauthentication failed");
    expect(helper.request).not.toHaveBeenCalled();
    expect(store.getJob(job.id).state).toBe("awaiting_approval");
    store.close();
  });

  it("records the complete approved canary lifecycle", async () => {
    const helper = { request: vi.fn(async () => ({ verified: true, helperVersion: "0.1.0", mutationPerformed: false })) };
    const { store, owner, jobs } = await setup(helper);
    const job = jobs.createCanary(owner.id);
    const completed = await jobs.approveAndRun(job.id, owner.id, "correct horse battery");

    expect(helper.request).toHaveBeenCalledWith("canary.verify", {});
    expect(completed.state).toBe("completed");
    expect(completed.steps.map((step) => step.name)).toEqual(["preflight", "checkpoint", "approval", "apply", "apply", "verify"]);
    expect(store.listAudit().map((event) => event.type)).toContain("job.completed");
    store.close();
  });

  it("fails closed when the helper is unavailable", async () => {
    const helper = { request: vi.fn(async () => { throw new Error("Helper unavailable"); }) };
    const { store, owner, jobs } = await setup(helper);
    const job = jobs.createCanary(owner.id);

    await expect(jobs.approveAndRun(job.id, owner.id, "correct horse battery")).rejects.toThrow("Helper unavailable");
    expect(store.getJob(job.id)).toMatchObject({ state: "failed", error: "Helper unavailable" });
    store.close();
  });

  it("revalidates and executes only the exact smartmontools repair plan", async () => {
    const result = { package: "smartmontools", installed: true, version: "7.5-2", packageChanged: true, scan: { completed: true, evidenceRefreshed: true }, boundary: { fixedPackage: true, arbitraryPackageAccepted: false, aptUpdatePerformed: false, packageRemovalPerformed: false } };
    const helper = { request: vi.fn(async () => result) };
    const { store, owner } = await setup(helper);
    const validatePrerequisiteRepairJob = vi.fn(async () => ({ plan: { input: { expectedVersion: "7.5-2" } }, state: { installed: false } }));
    const jobs = createJobService(store, helper, { validatePrerequisiteRepairJob });
    const job = store.createJob({ type: "prerequisite.smartmontools.install", title: "Install smartmontools", risk: "system-package", parameters: { expectedVersion: "7.5-2" }, recovery: { automaticRollback: false }, createdBy: owner.id });
    const completed = await jobs.approveAndRun(job.id, owner.id, "correct horse battery");
    expect(validatePrerequisiteRepairJob).toHaveBeenCalledWith(expect.objectContaining({ id: job.id }));
    expect(helper.request).toHaveBeenCalledWith("prerequisite.smartmontools.install", { expectedVersion: "7.5-2" }, { timeoutMs: 15 * 60 * 1000 });
    expect(completed).toMatchObject({ state: "completed", result: { package: "smartmontools", installed: true, packageChanged: true } });
    store.close();
  });

  it("revalidates and executes only the fixed APT metadata refresh", async () => {
    const updatedAt = "2026-08-01T00:00:00.000Z";
    const result = {
      refreshed: true,
      updatedAt: "2026-08-16T07:00:00.000Z",
      state: "current",
      packageManagerState: "ready",
      boundary: { fixedAptUpdateOnly: true, packageInstallPerformed: false, packageUpgradePerformed: false, packageRemovalPerformed: false, serviceMutationPerformed: false, rebootPerformed: false, arbitraryCommandAccepted: false, browserArgumentAccepted: false },
    };
    const helper = { request: vi.fn(async () => result) };
    const { store, owner } = await setup(helper);
    const validatePrerequisiteRepairJob = vi.fn(async () => ({ plan: { input: { expectedUpdatedAt: updatedAt, expectedState: "stale" } }, state: { state: "stale", packageManagerState: "ready" } }));
    const jobs = createJobService(store, helper, { validatePrerequisiteRepairJob });
    const job = store.createJob({ type: "prerequisite.apt-metadata.refresh", title: "Refresh APT package metadata", risk: "system-package-metadata", parameters: { expectedUpdatedAt: updatedAt }, recovery: { automaticRollback: false }, createdBy: owner.id });
    const completed = await jobs.approveAndRun(job.id, owner.id, "correct horse battery");
    expect(validatePrerequisiteRepairJob).toHaveBeenCalledWith(expect.objectContaining({ id: job.id }));
    expect(helper.request).toHaveBeenCalledWith("prerequisite.apt-metadata.refresh", { expectedUpdatedAt: updatedAt }, { timeoutMs: 15 * 60 * 1000 });
    expect(completed).toMatchObject({ state: "completed", result: { refreshed: true, state: "current", boundary: { packageInstallPerformed: false, packageUpgradePerformed: false, packageRemovalPerformed: false } } });
    store.close();
  });

  it("revalidates and executes a typed Uptime Kuma deployment job", async () => {
    const helper = { request: vi.fn(async () => ({ installed: true, healthy: true, dataPreserved: true, hostPort: 3101 })) };
    const { store, owner } = await setup(helper);
    const validateApplicationJob = vi.fn(async () => {});
    const jobs = createJobService(store, helper, { validateApplicationJob });
    const job = store.createJob({
      type: "application.uptime-kuma.deploy",
      title: "Deploy Uptime Kuma",
      parameters: { hostPort: 3101 },
      recovery: { automaticRollback: true },
      createdBy: owner.id,
    });

    const completed = await jobs.approveAndRun(job.id, owner.id, "correct horse battery");
    expect(validateApplicationJob).toHaveBeenCalledWith(expect.objectContaining({ id: job.id }));
    expect(helper.request).toHaveBeenCalledWith("application.uptime-kuma.deploy", { hostPort: 3101 });
    expect(completed).toMatchObject({ state: "completed", result: { healthy: true, hostPort: 3101 } });
    store.close();
  });

  it("revalidates and stages Pi-hole without granting router, DHCP, or DNS cutover authority", async () => {
    const input = { target: "docker", hostPort: 8080, lanAddress: "192.168.8.10", networkAssessmentId: "network-plan-one", fallbackDnsAddress: "94.140.14.59" };
    const result = {
      installed: true, healthy: true, lanAddress: input.lanAddress, port: input.hostPort,
      dnsTcpBound: true, dnsUdpBound: true, dataPreserved: true, secretPreserved: true,
      routerMutationPerformed: false, dnsCutoverPerformed: false, dhcpEnabled: false,
    };
    const helper = { request: vi.fn(async () => result) };
    const { store, owner } = await setup(helper);
    const validateApplicationJob = vi.fn(async () => ({ input }));
    const jobs = createJobService(store, helper, { validateApplicationJob });
    const job = store.createJob({
      type: "application.pi-hole.deploy",
      title: "Stage Pi-hole on Bigbox",
      parameters: { hostPort: 8080, lanAddress: "192.168.8.10", networkAssessmentId: "network-plan-one" },
      recovery: { automaticRollback: true },
      createdBy: owner.id,
    });

    const completed = await jobs.approveAndRun(job.id, owner.id, "correct horse battery");

    expect(validateApplicationJob).toHaveBeenCalledWith(expect.objectContaining({ id: job.id }));
    expect(helper.request).toHaveBeenCalledWith("application.pi-hole.deploy", { lanAddress: "192.168.8.10", webPort: 8080 }, { timeoutMs: 10 * 60 * 1000 });
    expect(completed).toMatchObject({ state: "completed", result: { healthy: true, routerMutationPerformed: false, dnsCutoverPerformed: false, dhcpEnabled: false } });
    store.close();
  });

  it("records a backup only after the isolated restore evidence passes", async () => {
    const backupId = "11111111-1111-4111-8111-111111111111";
    const result = { backupId, applicationId: "uptime-kuma", sourceRestartVerified: true, restoreDrill: { passed: true } };
    const helper = { request: vi.fn(async () => result) };
    const { store, owner } = await setup(helper);
    const validateBackupJob = vi.fn(async () => {});
    const recordBackupResult = vi.fn();
    const jobs = createJobService(store, helper, { validateBackupJob, recordBackupResult });
    const job = store.createJob({
      type: "application.uptime-kuma.backup",
      title: "Back up Uptime Kuma",
      parameters: { backupId },
      recovery: { automaticRollback: true },
      createdBy: owner.id,
    });

    const completed = await jobs.approveAndRun(job.id, owner.id, "correct horse battery");

    expect(validateBackupJob).toHaveBeenCalledWith(expect.objectContaining({ id: job.id }));
    expect(helper.request).toHaveBeenCalledWith("application.uptime-kuma.backup", { backupId });
    expect(recordBackupResult).toHaveBeenCalledWith(expect.objectContaining({ id: job.id }), result);
    expect(completed.state).toBe("completed");
    store.close();
  });

  it("runs the controller snapshot through the typed helper and records only no-change restore evidence", async () => {
    const backupId = "33333333-3333-4333-8333-333333333333";
    const result = {
      backupId,
      applicationId: "boxpilot-controller",
      consistentSnapshot: true,
      snapshotMethod: "sqlite-vacuum-into",
      sourceServiceStopped: false,
      downtimeMs: 0,
      restoreDrill: { passed: true, mode: "isolated-copy-open", copyChecksumMatched: true, integrityCheck: "ok", foreignKeyIssues: 0, schemaVerified: true, ownerStatePresent: true, workspaceRemoved: true, productionDatabaseReplaced: false, serviceStarted: false },
      boundary: { databaseContentReturned: false, browserPathAccepted: false, browserCommandAccepted: false, productionDatabaseChanged: false, serviceStopped: false, networkAccessRequired: false, independentCopyCreated: false, retentionPerformed: false },
    };
    const helper = { request: vi.fn(async () => result) };
    const { store, owner } = await setup(helper);
    const validateBackupJob = vi.fn(async () => {});
    const recordBackupResult = vi.fn();
    const jobs = createJobService(store, helper, { validateBackupJob, recordBackupResult });
    const job = store.createJob({ type: "controller.database.backup", title: "Back up BoxPilot controller", parameters: { backupId, applicationId: "boxpilot-controller" }, recovery: { automaticRollback: true }, createdBy: owner.id });

    const completed = await jobs.approveAndRun(job.id, owner.id, "correct horse battery");

    expect(validateBackupJob).toHaveBeenCalledWith(expect.objectContaining({ id: job.id }));
    expect(helper.request).toHaveBeenCalledWith("controller.database.backup.create", { backupId }, { timeoutMs: 10 * 60 * 1000 });
    expect(recordBackupResult).toHaveBeenCalledWith(expect.objectContaining({ id: job.id }), result);
    expect(completed).toMatchObject({ state: "completed", result: { consistentSnapshot: true, sourceServiceStopped: false, downtimeMs: 0 } });
    store.close();
  });

  it("runs independent controller protection in the background and records only exact restored restic evidence", async () => {
    const input = { protectionId: "44444444-4444-4444-8444-444444444444", backupId: "33333333-3333-4333-8333-333333333333", expectedArtifactChecksumSha256: "a".repeat(64), expectedManifestChecksumSha256: "b".repeat(64), expectedSizeBytes: 8192, expectedDestinationRevision: "c".repeat(64) };
    let finish;
    const helper = { request: vi.fn(() => new Promise((resolve) => { finish = resolve; })) };
    const { store, owner } = await setup(helper);
    const validateControllerProtectionJob = vi.fn(async () => ({ input }));
    const recordControllerProtectionResult = vi.fn();
    const jobs = createJobService(store, helper, { validateControllerProtectionJob, recordControllerProtectionResult });
    const job = store.createJob({ type: "controller.database.backup.protect", title: "Protect BoxPilot controller", parameters: { input }, recovery: {}, createdBy: owner.id });

    const started = await jobs.approveAndStart(job.id, owner.id, "correct horse battery");
    expect(started.state).toBe("applying");
    expect(validateControllerProtectionJob).toHaveBeenCalledWith(expect.objectContaining({ id: job.id }));
    expect(helper.request).toHaveBeenCalledWith("controller.database.protection.create", input, { timeoutMs: 12 * 60 * 60 * 1000 });
    const result = { created: true, protectionId: input.protectionId, backupId: input.backupId, encrypted: true, independent: true, repositoryVerified: true, protected: true, restoreDrill: { passed: true, mode: "exact-snapshot-isolated-copy-open", network: "none", productionDatabaseReplaced: false } };
    finish(result);
    await vi.waitFor(() => expect(store.getJob(job.id).state).toBe("completed"));
    expect(recordControllerProtectionResult).toHaveBeenCalledWith(expect.objectContaining({ id: job.id }), result);
    store.close();
  });

  it("runs a Pi-hole backup as a typed long-running job and records only isolated no-cutover evidence", async () => {
    const backupId = "22222222-2222-4222-8222-222222222222";
    const result = {
      backupId,
      applicationId: "pi-hole",
      sourceRestartVerified: true,
      routerMutationPerformed: false,
      dnsCutoverPerformed: false,
      restoreDrill: {
        passed: true,
        network: "none",
        publishedPorts: 0,
        configurationIncluded: true,
        administratorSecretIncluded: true,
        routerMutationPerformed: false,
        dnsCutoverPerformed: false,
      },
    };
    let finish;
    const helper = { request: vi.fn(() => new Promise((resolve) => { finish = resolve; })) };
    const { store, owner } = await setup(helper);
    const validateBackupJob = vi.fn(async () => {});
    const recordBackupResult = vi.fn();
    const jobs = createJobService(store, helper, { validateBackupJob, recordBackupResult });
    const job = store.createJob({
      type: "application.pi-hole.backup",
      title: "Back up and restore-test Pi-hole",
      risk: "network-critical",
      parameters: { backupId, applicationId: "pi-hole" },
      recovery: { automaticRollback: true },
      createdBy: owner.id,
    });

    const started = await jobs.approveAndStart(job.id, owner.id, "correct horse battery");

    expect(validateBackupJob).toHaveBeenCalledWith(expect.objectContaining({ id: job.id }));
    expect(helper.request).toHaveBeenCalledWith("application.pi-hole.backup", { backupId }, { timeoutMs: 10 * 60 * 1000 });
    expect(started.state).toBe("applying");
    finish(result);
    await vi.waitFor(() => expect(store.getJob(job.id).state).toBe("completed"));
    expect(recordBackupResult).toHaveBeenCalledWith(expect.objectContaining({ id: job.id }), result);
    expect(store.getJob(job.id)).toMatchObject({ state: "completed", result: { applicationId: "pi-hole", routerMutationPerformed: false, dnsCutoverPerformed: false } });
    store.close();
  });

  it("runs a migration bundle transfer in the background without sending source records or paths to the helper", async () => {
    const input = {
      transferId: "11111111-1111-4111-8111-111111111111",
      bundleId: "22222222-2222-4222-8222-222222222222",
      sourceId: "source-one",
      sourceFingerprint: `sha256:${"a".repeat(64)}`,
      contentRevision: "b".repeat(64),
      expectedDestinationState: "empty",
      expectedRemainingBytes: 8192,
    };
    let finish;
    const helper = { request: vi.fn(() => new Promise((resolve) => { finish = resolve; })) };
    const { store, owner } = await setup(helper);
    const validateMigrationTransferJob = vi.fn(async () => ({ input }));
    const recordMigrationTransferResult = vi.fn();
    const jobs = createJobService(store, helper, { validateMigrationTransferJob, recordMigrationTransferResult });
    const job = store.createJob({ type: "migration.bundle.transfer", title: "Stage migration bundle", parameters: { input }, recovery: {}, createdBy: owner.id });

    const started = await jobs.approveAndStart(job.id, owner.id, "correct horse battery");
    expect(started.state).toBe("applying");
    expect(helper.request).toHaveBeenCalledWith("migration.bundle.transfer", {
      transferId: input.transferId,
      bundleId: input.bundleId,
      sourceFingerprint: input.sourceFingerprint,
      contentRevision: input.contentRevision,
      expectedDestinationState: "empty",
      expectedRemainingBytes: 8192,
    }, { timeoutMs: 12 * 60 * 60 * 1000 });
    const result = {
      created: true,
      transferId: input.transferId,
      bundleId: input.bundleId,
      contentVerified: true,
      sourcePreserved: true,
      activationPerformed: false,
      networkCutoverPerformed: false,
      sourceDeletionPerformed: false,
    };
    finish(result);
    await vi.waitFor(() => expect(store.getJob(job.id).state).toBe("completed"));
    expect(recordMigrationTransferResult).toHaveBeenCalledWith(expect.objectContaining({ id: job.id }), result);
    store.close();
  });

  it("revalidates and executes only the staged typed VM input", async () => {
    const input = { name: "ubuntu-lab", osProfile: "ubuntu-24.04", vcpus: 2, memoryMiB: 4096, diskGiB: 40, isoFile: "ubuntu.iso", network: "default", firmware: "uefi", autostart: false };
    const helper = { request: vi.fn(async () => ({ created: true, verified: true, domain: input.name, media: input.isoFile })) };
    const { store, owner } = await setup(helper);
    const validateVmCreationJob = vi.fn(async () => ({ input }));
    const jobs = createJobService(store, helper, { validateVmCreationJob });
    const job = store.createJob({
      type: "virtualization.domain.create",
      title: "Create ubuntu-lab",
      parameters: { input },
      recovery: { automaticRollback: true },
      createdBy: owner.id,
    });

    const completed = await jobs.approveAndRun(job.id, owner.id, "correct horse battery");

    expect(validateVmCreationJob).toHaveBeenCalledWith(expect.objectContaining({ id: job.id }));
    expect(helper.request).toHaveBeenCalledWith("virtualization.domain.create", input);
    expect(completed).toMatchObject({ state: "completed", result: { verified: true, domain: "ubuntu-lab" } });
    store.close();
  });

  it("revalidates and executes a typed VM lifecycle plan", async () => {
    const input = { name: "ubuntu-lab", action: "shutdown", expectedState: "running", expectedAutostart: false };
    const helper = { request: vi.fn(async () => ({ verified: true, domain: input.name, action: input.action, current: { state: "stopped", autostart: false } })) };
    const { store, owner } = await setup(helper);
    const validateVmLifecycleJob = vi.fn(async () => ({ input, output: { label: "Shut down" } }));
    const jobs = createJobService(store, helper, { validateVmLifecycleJob });
    const job = store.createJob({ type: "virtualization.domain.action", title: "Shut down ubuntu-lab", parameters: { input }, recovery: {}, createdBy: owner.id });

    const completed = await jobs.approveAndRun(job.id, owner.id, "correct horse battery");

    expect(validateVmLifecycleJob).toHaveBeenCalledWith(expect.objectContaining({ id: job.id }));
    expect(helper.request).toHaveBeenCalledWith("virtualization.domain.action", input);
    expect(completed).toMatchObject({ state: "completed", result: { verified: true, action: "shutdown" } });
    store.close();
  });

  it("revalidates and executes only a stopped-domain snapshot plan", async () => {
    const input = { name: "ubuntu-lab", snapshotName: "pre-upgrade", expectedUuid: "11111111-1111-4111-8111-111111111111", expectedState: "stopped", expectedDiskRevision: "b".repeat(64), expectedSnapshotRevision: "a".repeat(64) };
    const helper = { request: vi.fn(async () => ({ created: true, verified: true, domain: input.name, snapshotName: input.snapshotName, consistency: "offline-consistent", independentBackup: false })) };
    const { store, owner } = await setup(helper);
    const validateVmSnapshotJob = vi.fn(async () => ({ input }));
    const jobs = createJobService(store, helper, { validateVmSnapshotJob });
    const job = store.createJob({ type: "virtualization.domain.snapshot.create", title: "Snapshot ubuntu-lab", parameters: { input }, recovery: {}, createdBy: owner.id });

    const completed = await jobs.approveAndRun(job.id, owner.id, "correct horse battery");

    expect(validateVmSnapshotJob).toHaveBeenCalledWith(expect.objectContaining({ id: job.id }));
    expect(helper.request).toHaveBeenCalledWith("virtualization.domain.snapshot.create", input);
    expect(completed).toMatchObject({ state: "completed", result: { consistency: "offline-consistent", independentBackup: false } });
    store.close();
  });

  it("starts a long stopped-VM export in the background and records only verified local evidence", async () => {
    const input = { name: "ubuntu-lab", exportId: "11111111-1111-4111-8111-111111111111", expectedUuid: "22222222-2222-4222-8222-222222222222", expectedState: "stopped", expectedDiskRevision: "b".repeat(64), expectedSnapshotRevision: "a".repeat(64) };
    let finish;
    const helper = { request: vi.fn(() => new Promise((resolve) => { finish = resolve; })) };
    const { store, owner } = await setup(helper);
    const validateVmExportJob = vi.fn(async () => ({ input }));
    const recordVmExportResult = vi.fn();
    const jobs = createJobService(store, helper, { validateVmExportJob, recordVmExportResult });
    const job = store.createJob({ type: "virtualization.domain.export.create", title: "Export ubuntu-lab", parameters: { input }, recovery: {}, createdBy: owner.id });

    const started = await jobs.approveAndStart(job.id, owner.id, "correct horse battery");
    expect(started.state).toBe("applying");
    expect(helper.request).toHaveBeenCalledWith("virtualization.domain.export.create", input, { timeoutMs: 6 * 60 * 60 * 1000 });
    const result = { created: true, contentVerified: true, domain: input.name, uuid: input.expectedUuid, exportId: input.exportId, protected: false, encrypted: false, restoreDrill: { passed: false } };
    finish(result);
    await vi.waitFor(() => expect(store.getJob(job.id).state).toBe("completed"));
    expect(recordVmExportResult).toHaveBeenCalledWith(expect.objectContaining({ id: job.id }), result);
    store.close();
  });

  it("records confined cleanup when a VM export fails", async () => {
    const input = { name: "ubuntu-lab", exportId: "11111111-1111-4111-8111-111111111111", expectedUuid: "22222222-2222-4222-8222-222222222222", expectedState: "stopped", expectedDiskRevision: "b".repeat(64), expectedSnapshotRevision: "a".repeat(64) };
    const helper = { request: vi.fn(async () => { throw new Error("conversion failed Automated export cleanup completed."); }) };
    const { store, owner } = await setup(helper);
    const jobs = createJobService(store, helper, { validateVmExportJob: async () => ({ input }) });
    const job = store.createJob({ type: "virtualization.domain.export.create", title: "Export ubuntu-lab", parameters: { input }, recovery: {}, createdBy: owner.id });

    await expect(jobs.approveAndRun(job.id, owner.id, "correct horse battery")).rejects.toThrow("cleanup completed");
    expect(store.getJob(job.id)).toMatchObject({ state: "failed", steps: expect.arrayContaining([expect.objectContaining({ name: "rollback", state: "completed" })]) });
    store.close();
  });

  it("starts encrypted independent VM protection in the background without claiming restore protection", async () => {
    const input = { backupId: "11111111-1111-4111-8111-111111111111", exportId: "22222222-2222-4222-8222-222222222222", domainName: "ubuntu-lab", domainUuid: "33333333-3333-4333-8333-333333333333", expectedManifestChecksumSha256: "a".repeat(64), expectedSizeBytes: 8192, expectedDestinationRevision: "b".repeat(64) };
    let finish;
    const helper = { request: vi.fn(() => new Promise((resolve) => { finish = resolve; })) };
    const { store, owner } = await setup(helper);
    const validateVmProtectionJob = vi.fn(async () => ({ input }));
    const recordVmProtectionResult = vi.fn();
    const jobs = createJobService(store, helper, { validateVmProtectionJob, recordVmProtectionResult });
    const job = store.createJob({ type: "virtualization.export.backup.create", title: "Protect ubuntu-lab", parameters: { input }, recovery: {}, createdBy: owner.id });

    const started = await jobs.approveAndStart(job.id, owner.id, "correct horse battery");
    expect(started.state).toBe("applying");
    expect(helper.request).toHaveBeenCalledWith("virtualization.export.backup.create", input, { timeoutMs: 12 * 60 * 60 * 1000 });
    const result = { created: true, backupId: input.backupId, exportId: input.exportId, encrypted: true, independent: true, repositoryVerified: true, protected: false, restoreDrill: { passed: false } };
    finish(result);
    await vi.waitFor(() => expect(store.getJob(job.id).state).toBe("completed"));
    expect(recordVmProtectionResult).toHaveBeenCalledWith(expect.objectContaining({ id: job.id }), result);
    store.close();
  });

  it("runs exact VM retention in the background and records verified no-prune evidence", async () => {
    const input = {
      retentionId: "11111111-1111-4111-8111-111111111111",
      repositoryId: "a".repeat(64),
      expectedDestinationRevision: "b".repeat(64),
      expectedSnapshotSetRevision: "c".repeat(64),
      forgetSnapshotIds: ["d".repeat(64)],
    };
    let finish;
    const helper = { request: vi.fn(() => new Promise((resolve) => { finish = resolve; })) };
    const { store, owner } = await setup(helper);
    const validateVmRetentionJob = vi.fn(async () => ({ input }));
    const recordVmRetentionResult = vi.fn();
    const jobs = createJobService(store, helper, { validateVmRetentionJob, recordVmRetentionResult });
    const job = store.createJob({ type: "virtualization.export.backup.retention.apply", title: "Apply retention", parameters: { input }, recovery: {}, createdBy: owner.id });

    const started = await jobs.approveAndStart(job.id, owner.id, "correct horse battery");
    expect(started.state).toBe("applying");
    expect(helper.request).toHaveBeenCalledWith("virtualization.export.backup.retention.apply", input, { timeoutMs: 12 * 60 * 60 * 1000 });
    const result = { applied: true, complete: true, retentionId: input.retentionId, repositoryId: input.repositoryId, repositoryVerified: true, prunePerformed: false, spaceReclaimed: false };
    finish(result);
    await vi.waitFor(() => expect(store.getJob(job.id).state).toBe("completed"));
    expect(recordVmRetentionResult).toHaveBeenCalledWith(expect.objectContaining({ id: job.id }), result);
    store.close();
  });

  it("records confirmed retention mutation before failing a later repository verification", async () => {
    const input = {
      retentionId: "11111111-1111-4111-8111-111111111111", repositoryId: "a".repeat(64), expectedDestinationRevision: "b".repeat(64),
      expectedSnapshotSetRevision: "c".repeat(64), forgetSnapshotIds: ["d".repeat(64)],
    };
    const result = { applied: true, complete: true, retentionId: input.retentionId, repositoryId: input.repositoryId, forgottenSnapshotIds: input.forgetSnapshotIds, repositoryVerified: false, prunePerformed: false, spaceReclaimed: false };
    const helper = { request: vi.fn(async () => result) };
    const { store, owner } = await setup(helper);
    const recordVmRetentionResult = vi.fn();
    const jobs = createJobService(store, helper, { validateVmRetentionJob: async () => ({ input }), recordVmRetentionResult });
    const job = store.createJob({ type: "virtualization.export.backup.retention.apply", title: "Apply retention", parameters: { input }, recovery: {}, createdBy: owner.id });

    await expect(jobs.approveAndRun(job.id, owner.id, "correct horse battery")).rejects.toThrow("invalid operation result");
    expect(recordVmRetentionResult).toHaveBeenCalledWith(expect.objectContaining({ id: job.id }), result);
    expect(store.getJob(job.id).state).toBe("failed");
    store.close();
  });

  it("starts an isolated restore drill in the background and records only passing cleanup evidence", async () => {
    const input = {
      drillId: "11111111-1111-4111-8111-111111111111", backupId: "22222222-2222-4222-8222-222222222222", exportId: "33333333-3333-4333-8333-333333333333",
      domainName: "ubuntu-lab", domainUuid: "44444444-4444-4444-8444-444444444444", repositoryId: "a".repeat(64), snapshotId: "b".repeat(64),
      expectedManifestChecksumSha256: "c".repeat(64), expectedSizeBytes: 8192, expectedDestinationRevision: "d".repeat(64),
    };
    let finish;
    const helper = { request: vi.fn(() => new Promise((resolve) => { finish = resolve; })) };
    const { store, owner } = await setup(helper);
    const validateVmRestoreDrillJob = vi.fn(async () => ({ input }));
    const recordVmRestoreDrillResult = vi.fn();
    const jobs = createJobService(store, helper, { validateVmRestoreDrillJob, recordVmRestoreDrillResult });
    const job = store.createJob({ type: "virtualization.export.backup.restore-drill", title: "Drill ubuntu-lab", parameters: { input }, recovery: {}, createdBy: owner.id });

    const started = await jobs.approveAndStart(job.id, owner.id, "correct horse battery");
    expect(started.state).toBe("applying");
    expect(helper.request).toHaveBeenCalledWith("virtualization.export.backup.restore-drill", input, { timeoutMs: 12 * 60 * 60 * 1000 });
    const result = { passed: true, drillId: input.drillId, backupId: input.backupId, network: "none", transient: true, persistentDomainCreated: false, guestAgentPing: true, temporaryQemuDiskAccessGranted: true, temporaryQemuDiskAccessRemoved: true, transientFirmwareStateRemoved: true, cleanupVerified: true, protected: true };
    finish(result);
    await vi.waitFor(() => expect(store.getJob(job.id).state).toBe("completed"));
    expect(recordVmRestoreDrillResult).toHaveBeenCalledWith(expect.objectContaining({ id: job.id }), result);
    store.close();
  });

  it("creates a guarded recovery clone in the background and records only stopped no-network evidence", async () => {
    const input = {
      restoreId: "11111111-1111-4111-8111-111111111111", backupId: "22222222-2222-4222-8222-222222222222", exportId: "33333333-3333-4333-8333-333333333333",
      sourceDomainName: "ubuntu-lab", sourceDomainUuid: "44444444-4444-4444-8444-444444444444", targetDomainName: "ubuntu-lab-recovery",
      restoreDrillId: "55555555-5555-4555-8555-555555555555", repositoryId: "a".repeat(64), snapshotId: "b".repeat(64),
      expectedManifestChecksumSha256: "c".repeat(64), expectedSizeBytes: 8192, expectedDestinationRevision: "d".repeat(64),
    };
    let finish;
    const helper = { request: vi.fn(() => new Promise((resolve) => { finish = resolve; })) };
    const { store, owner } = await setup(helper);
    const validateVmRecoveryJob = vi.fn(async () => ({ input }));
    const recordVmRecoveryResult = vi.fn();
    const jobs = createJobService(store, helper, { validateVmRecoveryJob, recordVmRecoveryResult });
    const job = store.createJob({ type: "virtualization.backup.recovery.create", title: "Recover ubuntu-lab", parameters: { input }, recovery: {}, createdBy: owner.id });

    const started = await jobs.approveAndStart(job.id, owner.id, "correct horse battery");
    expect(started.state).toBe("applying");
    expect(helper.request).toHaveBeenCalledWith("virtualization.backup.recovery.create", input, { timeoutMs: 12 * 60 * 60 * 1000 });
    const result = {
      created: true, restoreId: input.restoreId, backupId: input.backupId, domain: input.targetDomainName,
      persistent: true, state: "stopped", network: "none", autostart: false, sourceUnchanged: true, snapshotUnchanged: true,
    };
    finish(result);
    await vi.waitFor(() => expect(store.getJob(job.id).state).toBe("completed"));
    expect(recordVmRecoveryResult).toHaveBeenCalledWith(expect.objectContaining({ id: job.id }), result);
    store.close();
  });

  it("records exact recovery-clone rollback without touching protected source evidence", async () => {
    const input = { restoreId: "11111111-1111-4111-8111-111111111111", backupId: "22222222-2222-4222-8222-222222222222", targetDomainName: "ubuntu-lab-recovery" };
    const helper = { request: vi.fn(async () => { throw new Error("definition verification failed Automatic recovery-clone rollback removed the new domain definition and generated disk directory."); }) };
    const { store, owner } = await setup(helper);
    const jobs = createJobService(store, helper, { validateVmRecoveryJob: async () => ({ input }) });
    const job = store.createJob({ type: "virtualization.backup.recovery.create", title: "Recover ubuntu-lab", parameters: { input }, recovery: {}, createdBy: owner.id });

    await expect(jobs.approveAndRun(job.id, owner.id, "correct horse battery")).rejects.toThrow("rollback removed");
    expect(store.getJob(job.id)).toMatchObject({ state: "failed", steps: expect.arrayContaining([expect.objectContaining({ name: "rollback", state: "completed" })]) });
    store.close();
  });
});
