import { chmod, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createKeelRecoveryDrillHelper, validateKeelRecoveryDrillCreateInput, validateKeelRecoveryDrillInspectInput } from "./keel-recovery-drill-helper.mjs";
import { pathsForKeelRecoveryDrill } from "./keel-recovery-drill-spec.mjs";

const directories = [];
const recoveryId = "11111111-1111-4111-8111-111111111111";
const drillId = "22222222-2222-4222-8222-222222222222";
const evidence = "a".repeat(64);
const tree = "b".repeat(64);

afterEach(async () => Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))));

describe("Keel recovery drill helper boundary", () => {
  it("accepts only the exact evidence tuple and consumes a strict root-only service result", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "boxpilot-keel-drill-helper-"));
    directories.push(directory);
    const drillPaths = { root: path.join(directory, "drills"), approval: path.join(directory, "approval.json") };
    const releasePath = path.join(directory, "release");
    await mkdir(releasePath, { recursive: true });
    const input = { drillId, recoveryId, expectedEvidenceChecksumSha256: evidence, expectedStateTreeDigestSha256: tree };
    const inspectRecovery = vi.fn(async () => ({ ready: true, recoveryId, evidenceChecksumSha256: evidence, stateTreeDigestSha256: tree }));
    const runService = vi.fn(async () => {
      const targets = pathsForKeelRecoveryDrill(drillId, drillPaths);
      await mkdir(targets.root, { recursive: true, mode: 0o700 });
      await writeFile(targets.result, `${JSON.stringify({
        schemaVersion: 1, passed: true, drillId, recoveryId, applicationId: "keel", releaseVersion: "1.2.6",
        sourceEvidenceChecksumSha256: evidence, sourceStateTreeDigestSha256: tree, resultPath: targets.result,
        healthIdentityVerified: true, databaseIntegrity: "ok", foreignKeyIssues: 0, schemaVerified: true,
        processStarted: true, processStopped: true, network: "private-loopback-only", publishedPorts: 0,
        workspaceRemoved: true, sourceRecoveryUnchanged: true, productionStateReplaced: false, productionServiceChanged: false,
        claimChanged: false, registrationChanged: false, loginTested: false, promotionPerformed: false,
      })}\n`, { mode: 0o600 });
      await chmod(targets.result, 0o600);
      return { ok: true };
    });
    const helper = createKeelRecoveryDrillHelper({ drillPaths, releasePath, inspectRecovery, runService, expectedRootUid: process.getuid(), expectedRootGid: process.getgid() });
    await expect(helper.inspect({ recoveryId })).resolves.toMatchObject({ ready: true, releaseVersion: "1.2.6", drillPort: 3100, drillNetwork: "private-loopback-only" });
    await expect(helper.create(input)).resolves.toMatchObject({ passed: true, drillId, recoveryId, workspaceRemoved: true });
    expect(runService).toHaveBeenCalledOnce();
  });

  it("rejects paths, commands, missing evidence, and changed recovery state", async () => {
    expect(validateKeelRecoveryDrillInspectInput({ recoveryId })).toEqual([]);
    expect(validateKeelRecoveryDrillInspectInput({ recoveryId, path: "/tmp" })).not.toEqual([]);
    expect(validateKeelRecoveryDrillCreateInput({ drillId, recoveryId, expectedEvidenceChecksumSha256: evidence, expectedStateTreeDigestSha256: tree })).toEqual([]);
    expect(validateKeelRecoveryDrillCreateInput({ drillId, recoveryId, expectedEvidenceChecksumSha256: evidence, expectedStateTreeDigestSha256: tree, command: "sh" })).toContain("Keel recovery drill accepts only the fixed typed recovery evidence fields");

    const directory = await mkdtemp(path.join(os.tmpdir(), "boxpilot-keel-drill-helper-changed-"));
    directories.push(directory);
    const releasePath = path.join(directory, "release");
    await mkdir(releasePath);
    const helper = createKeelRecoveryDrillHelper({ releasePath, inspectRecovery: async () => ({ ready: true, recoveryId, evidenceChecksumSha256: "c".repeat(64), stateTreeDigestSha256: tree }) });
    await expect(helper.create({ drillId, recoveryId, expectedEvidenceChecksumSha256: evidence, expectedStateTreeDigestSha256: tree })).rejects.toThrow("changed");
  });

  it("removes only the exact generated orphan after an interrupted inactive drill and preserves an active one", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "boxpilot-keel-drill-reconcile-"));
    directories.push(directory);
    const drillPaths = { root: path.join(directory, "drills"), approval: path.join(directory, "approval.json") };
    const targets = pathsForKeelRecoveryDrill(drillId, drillPaths);
    await mkdir(targets.partial, { recursive: true, mode: 0o700 });
    const approval = { drillId, recoveryId, expectedEvidenceChecksumSha256: evidence, expectedStateTreeDigestSha256: tree, approvedAt: "2026-08-16T12:00:00.000Z", releaseVersion: "1.2.6", unitName: "boxpilot-keel-recovery-drill.service" };
    await writeFile(drillPaths.approval, `${JSON.stringify(approval)}\n`, { mode: 0o600 });
    const inactive = createKeelRecoveryDrillHelper({ drillPaths, inspectService: async () => ({ active: false }), expectedRootUid: process.getuid(), expectedRootGid: process.getgid() });
    await expect(inactive.recoverInterrupted()).resolves.toEqual({ recovered: true, active: false, resultRecovered: false, generatedPartialRemoved: true });
    await expect(stat(targets.partial)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(drillPaths.approval)).rejects.toMatchObject({ code: "ENOENT" });

    await mkdir(targets.partial, { recursive: true, mode: 0o700 });
    await writeFile(drillPaths.approval, `${JSON.stringify(approval)}\n`, { mode: 0o600 });
    const active = createKeelRecoveryDrillHelper({ drillPaths, inspectService: async () => ({ active: true }), expectedRootUid: process.getuid(), expectedRootGid: process.getgid() });
    await expect(active.recoverInterrupted()).resolves.toEqual({ recovered: false, active: true, resultRecovered: false, generatedPartialRemoved: false });
    await expect(stat(targets.partial)).resolves.toBeTruthy();
    await expect(stat(drillPaths.approval)).resolves.toBeTruthy();
  });
});
