import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { hashPassword } from "./security.mjs";
import { createStateStore } from "./state.mjs";
import { restoreDrillDomainName } from "./vm-restore-drill-helper.mjs";
import { createVmRestoreDrillService } from "./vm-restore-drill.mjs";

const directories = [];
const exportId = "11111111-1111-4111-8111-111111111111";
const backupId = "22222222-2222-4222-8222-222222222222";
const domainUuid = "33333333-3333-4333-8333-333333333333";
const repositoryId = "a".repeat(64);
const snapshotId = "b".repeat(64);
const destinationRevision = "c".repeat(64);

async function setup({ ready = true } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "boxpilot-restore-drill-service-"));
  directories.push(directory);
  const store = createStateStore({ stateDirectory: directory });
  const bootstrap = store.createBootstrapToken();
  const owner = store.consumeBootstrapToken(bootstrap.token, { username: "owner", passwordHash: await hashPassword("password password") });
  store.recordVmExport({
    id: exportId, domainName: "ubuntu-lab", domainUuid, destination: "local-managed", artifactPath: `/var/lib/boxpilot-managed/vm-exports/${exportId}`,
    manifestChecksumSha256: "d".repeat(64), sizeBytes: 8192, protected: false, encrypted: false, restoreDrill: { passed: false }, createdBy: owner.id,
  });
  store.recordVmBackup({
    id: backupId, exportId, domainName: "ubuntu-lab", domainUuid, destination: "mounted-restic", repositoryId, snapshotId, sizeBytes: 8192,
    encrypted: true, independent: true, repositoryVerified: true, protected: false, restoreDrill: { passed: false }, createdBy: owner.id,
  });
  const helper = { request: vi.fn(async (operation, parameters) => {
    if (operation === "virtualization.export.backup.inspect") return { ready, repositoryId, destinationRevision: ready ? destinationRevision : null, blockers: ready ? [] : ["Repository unavailable"] };
    if (operation === "virtualization.export.backup.restore-drill.inspect") return {
      ready, drillDomain: restoreDrillDomainName(parameters.drillId), network: "none", transient: true, memoryMiB: 2048, vcpus: 2,
      restoreFreeBytes: ready ? 20 * 1024 ** 3 : null, requiredBytes: parameters.expectedSizeBytes + 1024 ** 3, blockers: ready ? [] : ["Repository unavailable"],
    };
    throw new Error(`Unexpected operation ${operation}`);
  }) };
  return { store, owner, helper, service: createVmRestoreDrillService({ store, helper }) };
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("VM isolated restore drill", () => {
  it("pins the protected-backup evidence into no-network drill parameters", async () => {
    const { store, helper, service } = await setup();
    const parameters = await service.prepareOperation({ backupId });
    expect(parameters).toMatchObject({ backupId, exportId, domainName: "ubuntu-lab", domainUuid, repositoryId, snapshotId, expectedManifestChecksumSha256: "d".repeat(64), expectedSizeBytes: 8192, expectedDestinationRevision: destinationRevision });
    expect(parameters.drillId).toMatch(/^[a-f0-9-]{36}$/);
    expect(JSON.stringify(parameters)).not.toMatch(/password|path|command/i);
    expect(helper.request).toHaveBeenCalledWith("virtualization.export.backup.restore-drill.inspect", parameters);
    store.close();
  });

  it("refuses preparation when the repository or temporary capacity is unavailable", async () => {
    const { store, service } = await setup({ ready: false });
    await expect(service.prepareOperation({ backupId })).rejects.toThrow("Repository unavailable");
    store.close();
  });

  it("never prepares a restore drill from a snapshot already forgotten by retention", async () => {
    const { store, owner, service } = await setup();
    store.recordVmRetention({
      id: "99999999-9999-4999-8999-999999999999", repositoryId, beforeSnapshotSetRevision: "e".repeat(64), afterSnapshotSetRevision: "f".repeat(64),
      beforeCount: 2, afterCount: 1, forgotten: [{ backupId, snapshotId, domainName: "ubuntu-lab" }], keptSnapshotIds: [], repositoryVerified: true, prunePerformed: false, createdBy: owner.id,
    });
    await expect(service.prepareOperation({ backupId })).rejects.toThrow("forgotten by an approved retention run");
    store.close();
  });

  it("promotes only strict passing restore evidence to protected", async () => {
    const { store, owner, service } = await setup();
    const parameters = await service.prepareOperation({ backupId });
    const job = { parameters, createdBy: owner.id };
    const result = {
      passed: true, drillId: parameters.drillId, backupId, exportId, domain: "ubuntu-lab", domainUuid, repositoryId, snapshotId,
      sizeBytes: 8192, fileCount: 3, network: "none", transient: true, persistentDomainCreated: false, guestAgentPing: true,
      restoredChecksumsVerified: true, restoredDisksVerified: true, temporaryQemuDiskAccessGranted: true,
      temporaryQemuDiskAccessRemoved: true, transientFirmwareStateRemoved: true, cleanupVerified: true, protected: true,
    };
    expect(service.recordOperation(job, result)).toMatchObject({ protected: true, restoreDrill: { passed: true, network: "none", guestAgentPing: true, cleanupVerified: true } });
    expect(() => service.recordOperation(job, { ...result, network: "default" })).toThrow("evidence validation failed");
    store.close();
  });
});
