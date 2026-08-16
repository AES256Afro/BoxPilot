import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createKeelPromotionService } from "./keel-promotion.mjs";
import { hashPassword } from "./security.mjs";
import { createStateStore } from "./state.mjs";

const directories = [];
const backupId = "11111111-1111-4111-8111-111111111111";
const recoveryId = "22222222-2222-4222-8222-222222222222";
const drillId = "33333333-3333-4333-8333-333333333333";
const installId = "44444444-4444-4444-8444-444444444444";
const evidence = "a".repeat(64);
const tree = "b".repeat(64);

async function setup({ ready = true } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "boxpilot-keel-promotion-service-"));
  directories.push(directory);
  let instant = Date.parse("2026-08-16T12:00:00.000Z");
  const store = createStateStore({ stateDirectory: directory, now: () => new Date(instant += 1) });
  const bootstrap = store.createBootstrapToken();
  const owner = store.consumeBootstrapToken(bootstrap.token, { username: "owner", passwordHash: await hashPassword("password password") });
  store.recordBackup({ id: backupId, applicationId: "keel", destination: "local-managed", artifactPath: "/fixed/keel.tar.gz", checksumSha256: "c".repeat(64), sizeBytes: 8192, downtimeMs: 10, restoreDrill: { passed: true }, createdBy: owner.id });
  store.recordApplicationRecovery({ id: recoveryId, backupId, applicationId: "keel", destination: "managed-keel-recovery", statePath: `/var/lib/boxpilot-managed/keel-recoveries/${recoveryId}/state`, evidencePath: `/var/lib/boxpilot-managed/keel-recoveries/${recoveryId}/recovery.json`, sizeBytes: 4096, state: "stopped", network: "none", createdBy: owner.id });
  store.recordApplicationRecoveryDrill({ id: drillId, recoveryId, applicationId: "keel", releaseVersion: "1.2.6", sourceEvidenceChecksumSha256: evidence, sourceStateTreeDigestSha256: tree, network: "private-loopback-only", healthIdentityVerified: true, databaseIntegrity: "ok", foreignKeyIssues: 0, schemaVerified: true, processStarted: true, processStopped: true, workspaceRemoved: true, sourceRecoveryUnchanged: true, passed: true, createdBy: owner.id });
  const helper = { request: vi.fn(async () => ({ ready, recoveryId, drillId, evidenceChecksumSha256: evidence, stateTreeDigestSha256: tree, installId, releaseVersion: "1.2.6", network: "host-loopback-only", rollbackDestination: "managed-keel-promotion-rollback", blockers: ready ? [] : ["Production unavailable"] })) };
  return { store, owner, helper, service: createKeelPromotionService({ store, helper }) };
}

afterEach(async () => Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))));

describe("guarded Keel production recovery promotion", () => {
  it("plans, stages, and records only strict rollback-backed promotion evidence", async () => {
    const { store, owner, service } = await setup();
    const plan = await service.plan(recoveryId, owner.id);
    expect(plan).toMatchObject({ type: "application.keel.promotion", subjectId: recoveryId, output: { executable: true, network: "host-loopback-only", rollbackDestination: "managed-keel-promotion-rollback" } });
    expect(JSON.stringify(plan.input)).not.toMatch(/path|command|password|token/i);
    const job = await service.stage(plan.id, plan.revision, owner.id);
    expect(job).toMatchObject({ type: "application.keel.promotion", state: "awaiting_approval", risk: "critical" });
    const result = {
      schemaVersion: 1, passed: true, promotionId: plan.input.promotionId, recoveryId, drillId, applicationId: "keel", releaseVersion: "1.2.6", previousInstallId: installId,
      sourceEvidenceChecksumSha256: evidence, sourceStateTreeDigestSha256: tree, previousStateTreeDigestSha256: "c".repeat(64), promotedStateTreeDigestSha256: tree,
      rollbackPath: `/var/lib/boxpilot-managed/keel-promotion-rollbacks/${plan.input.promotionId}/state`, rollbackEvidencePath: `/var/lib/boxpilot-managed/keel-promotion-rollbacks/${plan.input.promotionId}/rollback.json`, rollbackAvailable: true,
      healthIdentityVerified: true, databaseIntegrity: "ok", foreignKeyIssues: 0, schemaVerified: true, productionStateReplaced: true, sourceRecoveryUnchanged: true,
      registrationStateRestoredFromRecovery: true, claimStateRestoredFromRecovery: true, ownerLoginTested: false, network: "host-loopback-only", publishedPortsChanged: false,
      tailscaleChanged: false, firewallChanged: false, routerChanged: false, browserPathAccepted: false, browserCommandAccepted: false, browserTokenAccepted: false,
    };
    expect(service.recordResult(job, result)).toMatchObject({ id: plan.input.promotionId, recoveryId, drillId, rollbackAvailable: true, ownerLoginTested: false });
    expect(service.list()).toHaveLength(1);
    expect(() => service.recordResult(job, { ...result, ownerLoginTested: true })).toThrow("evidence validation failed");
    store.close();
  });

  it("blocks missing recoveries and unavailable production", async () => {
    const unavailable = await setup({ ready: false });
    const plan = await unavailable.service.plan(recoveryId, unavailable.owner.id);
    expect(plan.output).toMatchObject({ executable: false, blockers: ["Production unavailable"] });
    await expect(unavailable.service.stage(plan.id, plan.revision, unavailable.owner.id)).rejects.toThrow("Production unavailable");
    await expect(unavailable.service.plan("99999999-9999-4999-8999-999999999999", unavailable.owner.id)).rejects.toThrow("Stopped Keel recovery clone not found");
    unavailable.store.close();
  });

  it("requires the latest matching rehearsal to pass", async () => {
    const values = await setup();
    values.store.recordApplicationRecoveryDrill({ id: "55555555-5555-4555-8555-555555555555", recoveryId, applicationId: "keel", releaseVersion: "1.2.6", sourceEvidenceChecksumSha256: evidence, sourceStateTreeDigestSha256: tree, network: "private-loopback-only", healthIdentityVerified: false, databaseIntegrity: "ok", foreignKeyIssues: 0, schemaVerified: true, processStarted: true, processStopped: true, workspaceRemoved: true, sourceRecoveryUnchanged: true, passed: false, createdBy: values.owner.id });
    await expect(values.service.plan(recoveryId, values.owner.id)).rejects.toThrow("latest isolated Keel startup rehearsal must pass");
    values.store.close();
  });
});
