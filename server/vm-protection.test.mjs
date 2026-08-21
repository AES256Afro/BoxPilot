import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { hashPassword } from "./security.mjs";
import { createStateStore } from "./state.mjs";
import { createVmProtectionService } from "./vm-protection.mjs";

const directories = [];
const exportId = "11111111-1111-4111-8111-111111111111";
const domainUuid = "22222222-2222-4222-8222-222222222222";

async function setup({ ready = true } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "boxpilot-vm-protection-"));
  directories.push(directory);
  const store = createStateStore({ stateDirectory: directory });
  const bootstrap = store.createBootstrapToken();
  const owner = store.consumeBootstrapToken(bootstrap.token, { username: "owner", passwordHash: await hashPassword("password password") });
  store.recordVmExport({
    id: exportId, domainName: "ubuntu-lab", domainUuid, destination: "local-managed",
    artifactPath: `/var/lib/boxpilot-managed/vm-exports/${exportId}`, manifestChecksumSha256: "a".repeat(64), sizeBytes: 8192,
    protected: false, encrypted: false, restoreDrill: { passed: false }, createdBy: owner.id,
  });
  const status = ready ? {
    adapter: "mounted-restic", ready: true, encrypted: true, independent: true, resticVersion: "0.19.1",
    repositoryId: "b".repeat(64), destinationRevision: "c".repeat(64), destinationFreeBytes: 10 * 1024 ** 3, blockers: [],
  } : {
    adapter: "mounted-restic", ready: false, encrypted: false, independent: false, resticVersion: null,
    repositoryId: null, destinationRevision: null, destinationFreeBytes: null, blockers: ["Install restic before configuring VM protection"],
  };
  const helper = { request: vi.fn(async () => status) };
  return { store, owner, helper, service: createVmProtectionService({ store, helper }) };
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("VM encrypted independent protection", () => {
  it("refuses to prepare when the destination is not ready", async () => {
    const { store, service } = await setup({ ready: false });
    await expect(service.prepareOperation({ exportId })).rejects.toThrow("Install restic");
    store.close();
  });

  it("pins secret-free export evidence and destination revision into the parameters", async () => {
    const { store, helper, service } = await setup();
    const parameters = await service.prepareOperation({ exportId });
    expect(parameters).toMatchObject({ exportId, domainName: "ubuntu-lab", domainUuid, expectedManifestChecksumSha256: "a".repeat(64), expectedSizeBytes: 8192, expectedDestinationRevision: "c".repeat(64) });
    expect(parameters.backupId).toMatch(/^[a-f0-9-]{36}$/);
    expect(JSON.stringify(parameters)).not.toMatch(/password|path|repository/i);
    expect(helper.request).toHaveBeenCalledWith("virtualization.export.backup.inspect", {});
    await expect(service.prepareOperation({ exportId: "99999999-9999-4999-8999-999999999999" })).rejects.toThrow("VM export not found");
    store.close();
  });

  it("records encrypted repository evidence without claiming restore protection", async () => {
    const { store, owner, service } = await setup();
    const parameters = await service.prepareOperation({ exportId });
    const job = { parameters, createdBy: owner.id };
    const result = {
      created: true, backupId: parameters.backupId, exportId, domain: "ubuntu-lab", domainUuid,
      destination: "mounted-restic", repositoryId: "b".repeat(64), snapshotId: "d".repeat(64), sizeBytes: 8192, fileCount: 3,
      encrypted: true, independent: true, repositoryVerified: true, protected: false, restoreDrill: { passed: false, reason: "not run" },
    };
    expect(service.recordOperation(job, result)).toMatchObject({ encrypted: true, independent: true, repositoryVerified: true, protected: false, restoreDrill: { passed: false } });
    expect((await service.list()).backups).toHaveLength(1);
    expect(() => service.recordOperation(job, { ...result, protected: true })).toThrow("evidence validation failed");
    store.close();
  });
});
