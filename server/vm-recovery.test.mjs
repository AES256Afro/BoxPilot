import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { hashPassword } from "./security.mjs";
import { createStateStore } from "./state.mjs";
import { createVmRecoveryService } from "./vm-recovery.mjs";

const directories = [];
const exportId = "11111111-1111-4111-8111-111111111111";
const backupId = "22222222-2222-4222-8222-222222222222";
const sourceDomainUuid = "33333333-3333-4333-8333-333333333333";
const drillId = "44444444-4444-4444-8444-444444444444";
const recoveredDomainUuid = "55555555-5555-4555-8555-555555555555";
const repositoryId = "a".repeat(64);
const snapshotId = "b".repeat(64);
const destinationRevision = "c".repeat(64);

async function setup({ ready = true } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "boxpilot-recovery-service-"));
  directories.push(directory);
  const store = createStateStore({ stateDirectory: directory });
  const bootstrap = store.createBootstrapToken();
  const owner = store.consumeBootstrapToken(bootstrap.token, { username: "owner", passwordHash: await hashPassword("password password") });
  store.recordVmExport({
    id: exportId, domainName: "ubuntu-services", domainUuid: sourceDomainUuid, destination: "local-managed", artifactPath: `/var/lib/boxpilot-managed/vm-exports/${exportId}`,
    manifestChecksumSha256: "d".repeat(64), sizeBytes: 8192, protected: false, encrypted: false, restoreDrill: { passed: false }, createdBy: owner.id,
  });
  store.recordVmBackup({
    id: backupId, exportId, domainName: "ubuntu-services", domainUuid: sourceDomainUuid, destination: "mounted-restic", repositoryId, snapshotId, sizeBytes: 8192,
    encrypted: true, independent: true, repositoryVerified: true, protected: false, restoreDrill: { passed: false }, createdBy: owner.id,
  });
  store.recordVmRestoreDrill({
    backupId,
    restoreDrill: {
      passed: true, drillId, network: "none", transient: true, persistentDomainCreated: false, guestAgentPing: true,
      restoredChecksumsVerified: true, restoredDisksVerified: true, temporaryQemuDiskAccessGranted: true,
      temporaryQemuDiskAccessRemoved: true, transientFirmwareStateRemoved: true, cleanupVerified: true, fileCount: 3, sizeBytes: 8192,
    },
    createdBy: owner.id,
  });
  const helper = { request: vi.fn(async (operation, parameters) => {
    if (operation === "virtualization.export.backup.inspect") return { ready, repositoryId, destinationRevision: ready ? destinationRevision : null, blockers: ready ? [] : ["Repository unavailable"] };
    if (operation === "virtualization.backup.recovery.inspect") return {
      ready, targetDomainName: parameters.targetDomainName, targetNameAvailable: ready, network: "none", persistent: true,
      initialState: "stopped", autostart: false, memoryMiB: 2048, vcpus: 2, blockers: ready ? [] : ["Repository unavailable"],
    };
    throw new Error(`Unexpected operation ${operation}`);
  }) };
  return { store, owner, helper, service: createVmRecoveryService({ store, helper }) };
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("guarded VM recovery planning", () => {
  it("plans and stages a new stopped persistent no-network clone", async () => {
    const { store, owner, helper, service } = await setup();
    const plan = await service.plan(backupId, "ubuntu-recovered", owner.id);
    expect(plan).toMatchObject({
      type: "virtualization.backup.recovery",
      input: { backupId, exportId, sourceDomainName: "ubuntu-services", sourceDomainUuid, targetDomainName: "ubuntu-recovered", restoreDrillId: drillId, repositoryId, snapshotId, expectedDestinationRevision: destinationRevision },
      output: { executable: true, destination: "managed-libvirt-recovery", network: "none", persistent: true, initialState: "stopped", autostart: false },
    });
    expect(JSON.stringify(plan.input)).not.toMatch(/password|path|command/i);
    const job = await service.stage(plan.id, plan.revision, owner.id);
    expect(job).toMatchObject({ type: "virtualization.backup.recovery.create", state: "awaiting_approval", risk: "high" });
    await expect(service.validateJob(job)).resolves.toMatchObject({ id: plan.id, status: "staged" });
    expect(helper.request).toHaveBeenCalledWith("virtualization.backup.recovery.inspect", plan.input);
    store.close();
  });

  it("blocks invalid names and unavailable recovery prerequisites", async () => {
    const { store, owner, service } = await setup({ ready: false });
    await expect(service.plan(backupId, "boxpilot-drill-manual", owner.id)).rejects.toThrow("reserved restore-drill namespace");
    const plan = await service.plan(backupId, "ubuntu-recovered", owner.id);
    expect(plan.output).toMatchObject({ executable: false, blockers: ["Repository unavailable"] });
    await expect(service.stage(plan.id, plan.revision, owner.id)).rejects.toThrow("Repository unavailable");
    store.close();
  });

  it("never plans a recovery clone from a snapshot already forgotten by retention", async () => {
    const { store, owner, service } = await setup();
    store.recordVmRetention({
      id: "99999999-9999-4999-8999-999999999999", repositoryId, beforeSnapshotSetRevision: "e".repeat(64), afterSnapshotSetRevision: "f".repeat(64),
      beforeCount: 2, afterCount: 1, forgotten: [{ backupId, snapshotId, domainName: "ubuntu-services" }], keptSnapshotIds: [], repositoryVerified: true, prunePerformed: false, createdBy: owner.id,
    });
    await expect(service.plan(backupId, "ubuntu-recovered", owner.id)).rejects.toThrow("forgotten by an approved retention run");
    store.close();
  });

  it("records only strict stopped persistent recovery evidence", async () => {
    const { store, owner, service } = await setup();
    const plan = await service.plan(backupId, "ubuntu-recovered", owner.id);
    const job = await service.stage(plan.id, plan.revision, owner.id);
    const result = {
      created: true, restoreId: plan.input.restoreId, backupId, exportId, sourceDomain: "ubuntu-services", sourceDomainUuid,
      domain: "ubuntu-recovered", domainUuid: recoveredDomainUuid, repositoryId, snapshotId, sizeBytes: 8192, fileCount: 3,
      persistent: true, state: "stopped", network: "none", autostart: false, encryptedSource: true, protectedSource: true,
      restoredChecksumsVerified: true, restoredDisksVerified: true, sourceUnchanged: true, snapshotUnchanged: true,
    };
    expect(service.recordResult(job, result)).toMatchObject({ id: plan.input.restoreId, backupId, domainName: "ubuntu-recovered", state: "stopped", network: "none", autostart: false });
    expect(service.list()).toHaveLength(1);
    expect(() => service.recordResult(job, { ...result, network: "default" })).toThrow("evidence validation failed");
    store.close();
  });
});
