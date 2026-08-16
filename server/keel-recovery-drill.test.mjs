import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createKeelRecoveryDrillService } from "./keel-recovery-drill.mjs";
import { hashPassword } from "./security.mjs";
import { createStateStore } from "./state.mjs";

const directories = [];
const backupId = "11111111-1111-4111-8111-111111111111";
const recoveryId = "22222222-2222-4222-8222-222222222222";
const evidence = "a".repeat(64);
const tree = "b".repeat(64);

async function setup({ ready = true } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "boxpilot-keel-drill-service-"));
  directories.push(directory);
  const store = createStateStore({ stateDirectory: directory });
  const bootstrap = store.createBootstrapToken();
  const owner = store.consumeBootstrapToken(bootstrap.token, { username: "owner", passwordHash: await hashPassword("password password") });
  store.recordBackup({ id: backupId, applicationId: "keel", destination: "local-managed", artifactPath: "/fixed/keel.tar.gz", checksumSha256: "c".repeat(64), sizeBytes: 8192, downtimeMs: 10, restoreDrill: { passed: true }, createdBy: owner.id });
  store.recordApplicationRecovery({ id: recoveryId, backupId, applicationId: "keel", destination: "managed-keel-recovery", statePath: `/var/lib/boxpilot-managed/keel-recoveries/${recoveryId}/state`, evidencePath: `/var/lib/boxpilot-managed/keel-recoveries/${recoveryId}/recovery.json`, sizeBytes: 4096, state: "stopped", network: "none", createdBy: owner.id });
  const helper = { request: vi.fn(async () => ({ ready, recoveryId, evidenceChecksumSha256: evidence, stateTreeDigestSha256: tree, releaseVersion: "1.2.6", drillPort: 3100, drillNetwork: "private-loopback-only", blockers: ready ? [] : ["Release unavailable"] })) };
  return { store, owner, helper, service: createKeelRecoveryDrillService({ store, helper }) };
}

afterEach(async () => Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))));

describe("guarded Keel recovery startup rehearsal", () => {
  it("plans, stages, and records only strict passing isolated evidence", async () => {
    const { store, owner, service } = await setup();
    const plan = await service.plan(recoveryId, owner.id);
    expect(plan).toMatchObject({ type: "application.keel.recovery-drill", subjectId: recoveryId, output: { executable: true, mode: "isolated-keel-startup-health", network: "private-loopback-only", port: 3100 } });
    expect(JSON.stringify(plan.input)).not.toMatch(/path|command|password/i);
    const job = await service.stage(plan.id, plan.revision, owner.id);
    expect(job).toMatchObject({ type: "application.keel.recovery-drill.run", state: "awaiting_approval", risk: "high" });
    const result = {
      schemaVersion: 1, passed: true, drillId: plan.input.drillId, recoveryId, applicationId: "keel", releaseVersion: "1.2.6",
      sourceEvidenceChecksumSha256: evidence, sourceStateTreeDigestSha256: tree, healthIdentityVerified: true,
      databaseIntegrity: "ok", foreignKeyIssues: 0, schemaVerified: true, processStarted: true, processStopped: true,
      network: "private-loopback-only", publishedPorts: 0, workspaceRemoved: true, sourceRecoveryUnchanged: true,
      productionStateReplaced: false, productionServiceChanged: false, claimChanged: false, registrationChanged: false,
      loginTested: false, promotionPerformed: false,
    };
    expect(service.recordResult(job, result)).toMatchObject({ id: plan.input.drillId, recoveryId, passed: true, network: "private-loopback-only" });
    expect(service.list()).toHaveLength(1);
    expect(() => service.recordResult(job, { ...result, publishedPorts: 1 })).toThrow("evidence validation failed");
    store.close();
  });

  it("blocks missing recoveries and unavailable drill prerequisites", async () => {
    const unavailable = await setup({ ready: false });
    const plan = await unavailable.service.plan(recoveryId, unavailable.owner.id);
    expect(plan.output).toMatchObject({ executable: false, blockers: ["Release unavailable"] });
    await expect(unavailable.service.stage(plan.id, plan.revision, unavailable.owner.id)).rejects.toThrow("Release unavailable");
    await expect(unavailable.service.plan("99999999-9999-4999-8999-999999999999", unavailable.owner.id)).rejects.toThrow("Stopped Keel recovery clone not found");
    unavailable.store.close();
  });
});
