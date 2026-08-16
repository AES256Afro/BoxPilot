import path from "node:path";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createKeelPromotionHelper, validateKeelPromotionCreateInput, validateKeelPromotionInspectInput } from "./keel-promotion-helper.mjs";
import { pathsForKeelPromotion } from "./keel-promotion-spec.mjs";

const directories = [];
const promotionId = "33333333-3333-4333-8333-333333333333";
const recoveryId = "11111111-1111-4111-8111-111111111111";
const drillId = "22222222-2222-4222-8222-222222222222";
const installId = "44444444-4444-4444-8444-444444444444";
const evidence = "a".repeat(64);
const tree = "b".repeat(64);

afterEach(async () => Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))));

describe("Keel production promotion helper boundary", () => {
  it("accepts only the exact evidence tuple and consumes a strict rollback-backed result", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "boxpilot-keel-promotion-helper-"));
    directories.push(directory);
    const paths = { root: path.join(directory, "promotions"), rollbackRoot: path.join(directory, "rollbacks"), approval: path.join(directory, "approval.json"), active: path.join(directory, "promotions", ".active.json") };
    const inspectInput = { drillId, expectedEvidenceChecksumSha256: evidence, expectedStateTreeDigestSha256: tree, recoveryId };
    const input = { ...inspectInput, expectedInstallId: installId, promotionId };
    const runService = vi.fn(async () => {
      const targets = pathsForKeelPromotion(promotionId, paths);
      await mkdir(targets.rollbackFinalState, { recursive: true, mode: 0o700 });
      await writeFile(targets.rollbackFinalEvidence, "{}\n", { mode: 0o600 });
      await chmod(targets.rollbackFinalEvidence, 0o600);
      await mkdir(targets.root, { recursive: true, mode: 0o700 });
      await writeFile(targets.result, `${JSON.stringify({
        schemaVersion: 1, passed: true, promotionId, recoveryId, drillId, applicationId: "keel", releaseVersion: "1.2.6", previousInstallId: installId,
        sourceEvidenceChecksumSha256: evidence, sourceStateTreeDigestSha256: tree, previousStateTreeDigestSha256: "c".repeat(64), promotedStateTreeDigestSha256: tree,
        rollbackPath: targets.rollbackFinalState, rollbackEvidencePath: targets.rollbackFinalEvidence, rollbackAvailable: true,
        healthIdentityVerified: true, databaseIntegrity: "ok", foreignKeyIssues: 0, schemaVerified: true, productionStateReplaced: true, sourceRecoveryUnchanged: true,
        registrationStateRestoredFromRecovery: true, claimStateRestoredFromRecovery: true, ownerLoginTested: false, network: "host-loopback-only", publishedPortsChanged: false,
        tailscaleChanged: false, firewallChanged: false, routerChanged: false, browserPathAccepted: false, browserCommandAccepted: false, browserTokenAccepted: false,
      })}\n`, { mode: 0o600 });
      await chmod(targets.result, 0o600);
      return { ok: true };
    });
    const helper = createKeelPromotionHelper({
      paths,
      inspectRecovery: async () => ({ ready: true, recoveryId, evidenceChecksumSha256: evidence, stateTreeDigestSha256: tree }),
      drillHelper: { readResult: async () => ({ passed: true }) },
      installHelper: { inspect: async () => ({ state: "installed", installed: true, healthy: true, installId, releaseVersion: "1.2.6" }) },
      runService,
      expectedRootUid: process.getuid(), expectedRootGid: process.getgid(),
    });
    await expect(helper.inspect(inspectInput)).resolves.toMatchObject({ ready: true, installId, rollbackDestination: "managed-keel-promotion-rollback" });
    await expect(helper.create(input)).resolves.toMatchObject({ passed: true, promotionId, rollbackAvailable: true });
    expect(runService).toHaveBeenCalledOnce();
  });

  it("rejects browser paths, commands, tokens, and incomplete evidence", () => {
    const inspectInput = { drillId, expectedEvidenceChecksumSha256: evidence, expectedStateTreeDigestSha256: tree, recoveryId };
    expect(validateKeelPromotionInspectInput(inspectInput)).toEqual([]);
    expect(validateKeelPromotionInspectInput({ ...inspectInput, path: "/var/lib/keel" })).not.toEqual([]);
    expect(validateKeelPromotionCreateInput({ ...inspectInput, expectedInstallId: installId, promotionId })).toEqual([]);
    expect(validateKeelPromotionCreateInput({ ...inspectInput, expectedInstallId: installId, promotionId, command: "sh" })).toContain("Keel promotion accepts only the fixed promotion, installation, recovery, and drill evidence fields");
    expect(validateKeelPromotionCreateInput({ ...inspectInput, expectedInstallId: installId, promotionId, token: "secret" })).not.toEqual([]);
  });

  it("refuses to report interrupted recovery while the active marker remains", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "boxpilot-keel-promotion-helper-recovery-"));
    directories.push(directory);
    const paths = { root: path.join(directory, "promotions"), rollbackRoot: path.join(directory, "rollbacks"), approval: path.join(directory, "approval.json"), active: path.join(directory, "promotions", ".active.json") };
    await mkdir(paths.root, { recursive: true, mode: 0o700 });
    await writeFile(paths.active, "{}\n", { mode: 0o600 });
    await chmod(paths.active, 0o600);
    const helper = createKeelPromotionHelper({
      paths,
      inspectService: async () => ({ active: false }),
      runService: async () => ({ ok: true }),
      installHelper: { inspect: async () => ({ state: "installed", installed: true, healthy: true, installId, releaseVersion: "1.2.6" }) },
      expectedRootUid: process.getuid(), expectedRootGid: process.getgid(),
    });
    await expect(helper.recoverInterrupted()).rejects.toThrow("left its active marker");
  });
});
