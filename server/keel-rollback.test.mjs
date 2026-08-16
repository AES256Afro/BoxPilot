import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createKeelRollbackService } from "./keel-rollback.mjs";
import { hashPassword } from "./security.mjs";
import { createStateStore } from "./state.mjs";

const directories = [];
const backupId = "11111111-1111-4111-8111-111111111111";
const recoveryId = "22222222-2222-4222-8222-222222222222";
const drillId = "33333333-3333-4333-8333-333333333333";
const promotionId = "44444444-4444-4444-8444-444444444444";
const installId = "55555555-5555-4555-8555-555555555555";
const evidence = "a".repeat(64);
const sourceTree = "b".repeat(64);
const previousTree = "c".repeat(64);

async function setup({ ready = true } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "boxpilot-keel-rollback-service-"));
  directories.push(directory);
  const store = createStateStore({ stateDirectory: directory });
  const bootstrap = store.createBootstrapToken();
  const owner = store.consumeBootstrapToken(bootstrap.token, { username: "owner", passwordHash: await hashPassword("password password") });
  store.recordBackup({ id: backupId, applicationId: "keel", destination: "local-managed", artifactPath: "/fixed/keel.tar.gz", checksumSha256: "d".repeat(64), sizeBytes: 8192, downtimeMs: 10, restoreDrill: { passed: true }, createdBy: owner.id });
  store.recordApplicationRecovery({ id: recoveryId, backupId, applicationId: "keel", destination: "managed-keel-recovery", statePath: `/var/lib/boxpilot-managed/keel-recoveries/${recoveryId}/state`, evidencePath: `/var/lib/boxpilot-managed/keel-recoveries/${recoveryId}/recovery.json`, sizeBytes: 4096, state: "stopped", network: "none", createdBy: owner.id });
  store.recordApplicationRecoveryDrill({ id: drillId, recoveryId, applicationId: "keel", releaseVersion: "1.2.6", sourceEvidenceChecksumSha256: evidence, sourceStateTreeDigestSha256: sourceTree, network: "private-loopback-only", healthIdentityVerified: true, databaseIntegrity: "ok", foreignKeyIssues: 0, schemaVerified: true, processStarted: true, processStopped: true, workspaceRemoved: true, sourceRecoveryUnchanged: true, passed: true, createdBy: owner.id });
  store.recordApplicationRecoveryPromotion({ id: promotionId, recoveryId, drillId, applicationId: "keel", releaseVersion: "1.2.6", previousInstallId: installId, sourceEvidenceChecksumSha256: evidence, sourceStateTreeDigestSha256: sourceTree, previousStateTreeDigestSha256: previousTree, promotedStateTreeDigestSha256: sourceTree, rollbackPath: `/var/lib/boxpilot-managed/keel-promotion-rollbacks/${promotionId}/state`, rollbackEvidencePath: `/var/lib/boxpilot-managed/keel-promotion-rollbacks/${promotionId}/rollback.json`, healthIdentityVerified: true, databaseIntegrity: "ok", foreignKeyIssues: 0, schemaVerified: true, rollbackAvailable: true, sourceRecoveryUnchanged: true, ownerLoginTested: false, createdBy: owner.id });
  const helper = { request: vi.fn(async () => ({ ready, promotionId, installId, rollbackEvidenceChecksumSha256: evidence, previousStateTreeDigestSha256: previousTree, releaseVersion: "1.2.6", network: "host-loopback-only", displacedDestination: "managed-keel-rollback-checkpoint", sourceCheckpointPreserved: true, blockers: ready ? [] : ["Checkpoint unavailable"] })) };
  return { store, owner, helper, service: createKeelRollbackService({ store, helper }) };
}

afterEach(async () => Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))));

describe("guarded Keel operator rollback", () => {
  it("plans, stages, and records only strict preserved-state rollback evidence", async () => {
    const { store, owner, service } = await setup();
    const plan = await service.plan(promotionId, owner.id);
    expect(plan).toMatchObject({ type: "application.keel.rollback", subjectId: promotionId, output: { executable: true, sourceCheckpointPreserved: true } });
    expect(JSON.stringify(plan.input)).not.toMatch(/path|command|password|token/i);
    const job = await service.stage(plan.id, plan.revision, owner.id);
    expect(job).toMatchObject({ type: "application.keel.rollback", state: "awaiting_approval", risk: "critical" });
    const result = {
      schemaVersion: 1, passed: true, rollbackId: plan.input.rollbackId, promotionId, applicationId: "keel", releaseVersion: "1.2.6", installId,
      sourceRollbackEvidenceChecksumSha256: evidence, sourcePreviousStateTreeDigestSha256: previousTree, restoredStateTreeDigestSha256: previousTree,
      displacedStateTreeDigestSha256: "e".repeat(64), displacedStatePath: `/var/lib/boxpilot-managed/keel-rollback-checkpoints/${plan.input.rollbackId}/state`,
      displacedEvidencePath: `/var/lib/boxpilot-managed/keel-rollback-checkpoints/${plan.input.rollbackId}/checkpoint.json`, displacedStateRetained: true,
      sourceRollbackCheckpointUnchanged: true, rollbackRequested: true, productionStateReplaced: true, healthIdentityVerified: true,
      databaseIntegrity: "ok", foreignKeyIssues: 0, schemaVerified: true, automaticFailureRecoveryTested: false, ownerLoginTested: false, network: "host-loopback-only",
      publishedPortsChanged: false, tailscaleChanged: false, firewallChanged: false, routerChanged: false,
      browserPathAccepted: false, browserCommandAccepted: false, browserTokenAccepted: false,
    };
    expect(service.recordResult(job, result)).toMatchObject({ id: plan.input.rollbackId, promotionId, displacedStateRetained: true, sourceRollbackCheckpointUnchanged: true });
    expect(service.list()).toHaveLength(1);
    await expect(service.plan(promotionId, owner.id)).rejects.toThrow("already has a completed operator rollback");
    expect(() => service.recordResult(job, { ...result, ownerLoginTested: true })).toThrow("evidence validation failed");
    store.close();
  });

  it("surfaces helper blockers and rejects unknown promotions", async () => {
    const unavailable = await setup({ ready: false });
    const plan = await unavailable.service.plan(promotionId, unavailable.owner.id);
    expect(plan.output).toMatchObject({ executable: false, blockers: ["Checkpoint unavailable"] });
    await expect(unavailable.service.stage(plan.id, plan.revision, unavailable.owner.id)).rejects.toThrow("Checkpoint unavailable");
    await expect(unavailable.service.plan("99999999-9999-4999-8999-999999999999", unavailable.owner.id)).rejects.toThrow("Rollback-backed Keel promotion not found");
    unavailable.store.close();
  });
});
