import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { hashPassword } from "./security.mjs";
import { createStateStore } from "./state.mjs";
import { createKeelRecoveryService } from "./keel-recovery.mjs";

const directories = [];
const backupId = "11111111-1111-4111-8111-111111111111";
const checksum = "a".repeat(64);
const manifestChecksum = "b".repeat(64);

async function setup({ ready = true } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "boxpilot-keel-recovery-service-"));
  directories.push(directory);
  const store = createStateStore({ stateDirectory: directory });
  const bootstrap = store.createBootstrapToken();
  const owner = store.consumeBootstrapToken(bootstrap.token, { username: "owner", passwordHash: await hashPassword("password password") });
  store.recordBackup({
    id: backupId, applicationId: "keel", destination: "local-managed", artifactPath: `/var/lib/boxpilot-managed/backups/keel/${backupId}.tar.gz`, checksumSha256: checksum,
    sizeBytes: 8192, downtimeMs: 25, restoreDrill: { passed: true, mode: "isolated-keel-export-open", network: "none", publishedPorts: 0, databaseIntegrity: "ok", foreignKeyIssues: 0, schemaVerified: true, treeDigestMatched: true, manifestChecksumSha256: manifestChecksum, applicationStarted: false, productionStateReplaced: false }, createdBy: owner.id,
  });
  const helper = { request: vi.fn(async (_operation, parameters) => ({ ready, recoveryId: parameters.recoveryId, backupId: parameters.backupId, destination: "managed-keel-recovery", initialState: "stopped", network: "none", applicationStarted: false, productionStateReplaced: false, blockers: ready ? [] : ["Target unavailable"] })) };
  return { store, owner, helper, service: createKeelRecoveryService({ store, helper }) };
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("guarded Keel recovery planning", () => {
  it("plans and stages a stopped no-network recovery clone from exact local evidence", async () => {
    const { store, owner, helper, service } = await setup();
    const plan = await service.plan(backupId, owner.id);
    expect(plan).toMatchObject({ type: "application.keel.recovery", subjectId: backupId, input: { backupId, expectedArtifactChecksumSha256: checksum, expectedManifestChecksumSha256: manifestChecksum, expectedSizeBytes: 8192 }, output: { executable: true, destination: "managed-keel-recovery", initialState: "stopped", network: "none" } });
    expect(JSON.stringify(plan.input)).not.toMatch(/path|command|password/i);
    const job = await service.stage(plan.id, plan.revision, owner.id);
    expect(job).toMatchObject({ type: "application.keel.recovery.create", state: "awaiting_approval", risk: "high" });
    await expect(service.validateJob(job)).resolves.toMatchObject({ id: plan.id, status: "staged" });
    expect(helper.request).toHaveBeenCalledWith("application.keel.recovery.inspect", plan.input);
    store.close();
  });

  it("records only strict stopped recovery evidence", async () => {
    const { store, owner, service } = await setup();
    const plan = await service.plan(backupId, owner.id);
    const job = await service.stage(plan.id, plan.revision, owner.id);
    const result = {
      created: true, recoveryId: plan.input.recoveryId, backupId, destination: "managed-keel-recovery",
      statePath: `/var/lib/boxpilot-managed/keel-recoveries/${plan.input.recoveryId}/state`, evidencePath: `/var/lib/boxpilot-managed/keel-recoveries/${plan.input.recoveryId}/recovery.json`,
      sourceArtifactChecksumSha256: checksum, sourceManifestChecksumSha256: manifestChecksum, sourceSizeBytes: 8192,
      archiveMemberCount: 7, restoredRegularFiles: 5, restoredDirectories: 2, restoredLogicalBytes: 4096, restoredTreeDigestSha256: "c".repeat(64),
      databaseIntegrity: "ok", foreignKeyIssues: 0, schemaVerified: true, environmentIncluded: true, initialState: "stopped", network: "none",
      applicationStarted: false, productionStateReplaced: false, sourceArtifactChanged: false, browserPathAccepted: false, browserCommandAccepted: false, promotionPerformed: false,
    };
    expect(service.recordResult(job, result)).toMatchObject({ id: plan.input.recoveryId, backupId, applicationId: "keel", state: "stopped", network: "none" });
    expect(service.list()).toHaveLength(1);
    expect(() => service.recordResult(job, { ...result, promotionPerformed: true })).toThrow("evidence validation failed");
    store.close();
  });

  it("blocks unknown backups and unavailable targets", async () => {
    const unavailable = await setup({ ready: false });
    const plan = await unavailable.service.plan(backupId, unavailable.owner.id);
    expect(plan.output).toMatchObject({ executable: false, blockers: ["Target unavailable"] });
    await expect(unavailable.service.stage(plan.id, plan.revision, unavailable.owner.id)).rejects.toThrow("Target unavailable");
    unavailable.store.close();
    const missing = await setup();
    await expect(missing.service.plan("99999999-9999-4999-8999-999999999999", missing.owner.id)).rejects.toThrow("Verified local Keel backup not found");
    missing.store.close();
  });
});
