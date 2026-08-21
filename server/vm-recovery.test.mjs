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

describe("guarded VM recovery", () => {
  it("pins the drilled-backup evidence into stopped persistent no-network clone parameters", async () => {
    const { store, helper, service } = await setup();
    const parameters = await service.prepareOperation({ backupId, targetDomainName: "ubuntu-recovered" });
    expect(parameters).toMatchObject({ backupId, exportId, sourceDomainName: "ubuntu-services", sourceDomainUuid, targetDomainName: "ubuntu-recovered", restoreDrillId: drillId, repositoryId, snapshotId, expectedDestinationRevision: destinationRevision });
    expect(parameters.restoreId).toMatch(/^[a-f0-9-]{36}$/);
    expect(JSON.stringify(parameters)).not.toMatch(/password|path|command/i);
    expect(helper.request).toHaveBeenCalledWith("virtualization.backup.recovery.inspect", parameters);
    store.close();
  });

  it("blocks invalid names and unavailable recovery prerequisites", async () => {
    const { store, service } = await setup({ ready: false });
    await expect(service.prepareOperation({ backupId, targetDomainName: "boxpilot-drill-manual" })).rejects.toThrow("reserved restore-drill namespace");
    await expect(service.prepareOperation({ backupId, targetDomainName: "ubuntu-recovered" })).rejects.toThrow("Repository unavailable");
    store.close();
  });

  it("never prepares a recovery clone from a snapshot already forgotten by retention", async () => {
    const { store, owner, service } = await setup();
    store.recordVmRetention({
      id: "99999999-9999-4999-8999-999999999999", repositoryId, beforeSnapshotSetRevision: "e".repeat(64), afterSnapshotSetRevision: "f".repeat(64),
      beforeCount: 2, afterCount: 1, forgotten: [{ backupId, snapshotId, domainName: "ubuntu-services" }], keptSnapshotIds: [], repositoryVerified: true, prunePerformed: false, createdBy: owner.id,
    });
    await expect(service.prepareOperation({ backupId, targetDomainName: "ubuntu-recovered" })).rejects.toThrow("forgotten by an approved retention run");
    store.close();
  });

  it("records only strict stopped persistent recovery evidence", async () => {
    const { store, owner, service } = await setup();
    const parameters = await service.prepareOperation({ backupId, targetDomainName: "ubuntu-recovered" });
    const job = { parameters, createdBy: owner.id };
    const result = {
      created: true, restoreId: parameters.restoreId, backupId, exportId, sourceDomain: "ubuntu-services", sourceDomainUuid,
      domain: "ubuntu-recovered", domainUuid: recoveredDomainUuid, repositoryId, snapshotId, sizeBytes: 8192, fileCount: 3,
      persistent: true, state: "stopped", network: "none", autostart: false, encryptedSource: true, protectedSource: true,
      restoredChecksumsVerified: true, restoredDisksVerified: true, sourceUnchanged: true, snapshotUnchanged: true,
    };
    expect(service.recordOperation(job, result)).toMatchObject({ id: parameters.restoreId, backupId, domainName: "ubuntu-recovered", state: "stopped", network: "none", autostart: false });
    expect(service.list()).toHaveLength(1);
    expect(() => service.recordOperation(job, { ...result, network: "default" })).toThrow("evidence validation failed");
    store.close();
  });
});
