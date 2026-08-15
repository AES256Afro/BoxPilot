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

describe("VM isolated restore drill planning", () => {
  it("creates and stages a no-network transient drill plan", async () => {
    const { store, owner, helper, service } = await setup();
    const plan = await service.plan(backupId, owner.id);
    expect(plan).toMatchObject({
      type: "virtualization.export.backup.restore-drill",
      input: { backupId, exportId, domainName: "ubuntu-lab", domainUuid, repositoryId, snapshotId, expectedManifestChecksumSha256: "d".repeat(64), expectedSizeBytes: 8192, expectedDestinationRevision: destinationRevision },
      output: { executable: true, network: "none", transient: true, protected: false, protectedOnSuccess: true },
    });
    expect(JSON.stringify(plan.input)).not.toMatch(/password|path|command/i);
    const job = await service.stage(plan.id, plan.revision, owner.id);
    expect(job).toMatchObject({ type: "virtualization.export.backup.restore-drill", state: "awaiting_approval", risk: "medium" });
    await expect(service.validateJob(job)).resolves.toMatchObject({ id: plan.id, status: "staged" });
    expect(helper.request).toHaveBeenCalledWith("virtualization.export.backup.restore-drill.inspect", plan.input);
    store.close();
  });

  it("does not stage when the repository or temporary capacity is unavailable", async () => {
    const { store, owner, service } = await setup({ ready: false });
    const plan = await service.plan(backupId, owner.id);
    expect(plan.output).toMatchObject({ executable: false, blockers: ["Repository unavailable"] });
    await expect(service.stage(plan.id, plan.revision, owner.id)).rejects.toThrow("Repository unavailable");
    store.close();
  });

  it("promotes only strict passing restore evidence to protected", async () => {
    const { store, owner, service } = await setup();
    const plan = await service.plan(backupId, owner.id);
    const job = await service.stage(plan.id, plan.revision, owner.id);
    const result = {
      passed: true, drillId: plan.input.drillId, backupId, exportId, domain: "ubuntu-lab", domainUuid, repositoryId, snapshotId,
      sizeBytes: 8192, fileCount: 3, network: "none", transient: true, persistentDomainCreated: false, guestAgentPing: true,
      restoredChecksumsVerified: true, restoredDisksVerified: true, temporaryQemuDiskAccessGranted: true,
      temporaryQemuDiskAccessRemoved: true, transientFirmwareStateRemoved: true, cleanupVerified: true, protected: true,
    };
    expect(service.recordResult(job, result)).toMatchObject({ protected: true, restoreDrill: { passed: true, network: "none", guestAgentPing: true, cleanupVerified: true } });
    expect(() => service.recordResult(job, { ...result, network: "default" })).toThrow("evidence validation failed");
    store.close();
  });
});
