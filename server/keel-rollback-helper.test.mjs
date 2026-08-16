import path from "node:path";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createKeelRollbackHelper, validateKeelRollbackCreateInput, validateKeelRollbackInspectInput } from "./keel-rollback-helper.mjs";
import { pathsForKeelRollback } from "./keel-rollback-spec.mjs";

const directories = [];
const rollbackId = "55555555-5555-4555-8555-555555555555";
const promotionId = "33333333-3333-4333-8333-333333333333";
const installId = "44444444-4444-4444-8444-444444444444";
const evidence = "a".repeat(64);
const previousTree = "b".repeat(64);
const displacedTree = "c".repeat(64);

afterEach(async () => Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))));

describe("Keel operator rollback helper boundary", () => {
  it("accepts only fixed durable evidence and consumes a strict preserved-state result", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "boxpilot-keel-rollback-helper-"));
    directories.push(directory);
    const paths = { root: path.join(directory, "rollbacks"), displacedRoot: path.join(directory, "displaced"), approval: path.join(directory, "approval.json"), active: path.join(directory, "rollbacks", ".active.json") };
    const inspectInput = { promotionId, expectedPreviousStateTreeDigestSha256: previousTree };
    const input = { ...inspectInput, rollbackId, expectedInstallId: installId, expectedRollbackEvidenceChecksumSha256: evidence };
    const runService = vi.fn(async () => {
      const targets = pathsForKeelRollback(rollbackId, paths);
      await mkdir(targets.displacedFinalState, { recursive: true, mode: 0o700 });
      await writeFile(targets.displacedFinalEvidence, "{}\n", { mode: 0o600 });
      await chmod(targets.displacedFinalEvidence, 0o600);
      await mkdir(targets.root, { recursive: true, mode: 0o700 });
      await writeFile(targets.result, `${JSON.stringify({
        schemaVersion: 1, passed: true, rollbackId, promotionId, applicationId: "keel", releaseVersion: "1.2.6", installId,
        sourceRollbackEvidenceChecksumSha256: evidence, sourcePreviousStateTreeDigestSha256: previousTree,
        restoredStateTreeDigestSha256: previousTree, displacedStateTreeDigestSha256: displacedTree,
        displacedStatePath: targets.displacedFinalState, displacedEvidencePath: targets.displacedFinalEvidence,
        displacedStateRetained: true, sourceRollbackCheckpointUnchanged: true, rollbackRequested: true,
        productionStateReplaced: true, healthIdentityVerified: true, databaseIntegrity: "ok", foreignKeyIssues: 0,
        schemaVerified: true, automaticFailureRecoveryTested: false, ownerLoginTested: false, network: "host-loopback-only",
        publishedPortsChanged: false, tailscaleChanged: false, firewallChanged: false, routerChanged: false,
        browserPathAccepted: false, browserCommandAccepted: false, browserTokenAccepted: false,
      })}\n`, { mode: 0o600 });
      await chmod(targets.result, 0o600);
      return { ok: true };
    });
    const helper = createKeelRollbackHelper({
      paths,
      inspectSource: async () => ({ ready: true, previousInstallId: installId, evidenceChecksumSha256: evidence, stateTreeDigestSha256: previousTree }),
      installHelper: { inspect: async () => ({ state: "installed", installed: true, healthy: true, installId, releaseVersion: "1.2.6" }) },
      runService,
      expectedRootUid: process.getuid(), expectedRootGid: process.getgid(),
    });
    await expect(helper.inspect(inspectInput)).resolves.toMatchObject({ ready: true, installId, sourceCheckpointPreserved: true });
    await expect(helper.create(input)).resolves.toMatchObject({ passed: true, rollbackId, displacedStateRetained: true });
    expect(runService).toHaveBeenCalledOnce();
  });

  it("rejects browser paths, commands, tokens, and incomplete evidence", () => {
    const inspectInput = { promotionId, expectedPreviousStateTreeDigestSha256: previousTree };
    expect(validateKeelRollbackInspectInput(inspectInput)).toEqual([]);
    expect(validateKeelRollbackInspectInput({ ...inspectInput, path: "/var/lib/keel" })).not.toEqual([]);
    const input = { ...inspectInput, rollbackId, expectedInstallId: installId, expectedRollbackEvidenceChecksumSha256: evidence };
    expect(validateKeelRollbackCreateInput(input)).toEqual([]);
    expect(validateKeelRollbackCreateInput({ ...input, command: "sh" })).toContain("Keel rollback accepts only the fixed rollback, installation, promotion, and checkpoint evidence fields");
    expect(validateKeelRollbackCreateInput({ ...input, token: "secret" })).not.toEqual([]);
  });

  it("refuses to report interrupted recovery while the active marker remains", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "boxpilot-keel-rollback-recovery-"));
    directories.push(directory);
    const paths = { root: path.join(directory, "rollbacks"), displacedRoot: path.join(directory, "displaced"), approval: path.join(directory, "approval.json"), active: path.join(directory, "rollbacks", ".active.json") };
    await mkdir(paths.root, { recursive: true, mode: 0o700 });
    await writeFile(paths.active, "{}\n", { mode: 0o600 });
    const helper = createKeelRollbackHelper({
      paths, inspectService: async () => ({ active: false }), runService: async () => ({ ok: true }),
      installHelper: { inspect: async () => ({ state: "installed", installed: true, healthy: true, installId, releaseVersion: "1.2.6" }) },
      expectedRootUid: process.getuid(), expectedRootGid: process.getgid(),
    });
    await expect(helper.recoverInterrupted()).rejects.toThrow("left its active marker");
  });
});
