import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createKeelBackupHelper } from "./keel-backup-helper.mjs";
import { keelArtifactSpec } from "./keel-artifact-spec.mjs";
import { pathsForKeelBackup } from "./keel-backup-spec.mjs";

const directories = [];
const backupId = "11111111-1111-4111-8111-111111111111";
const installId = "22222222-2222-4222-8222-222222222222";

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "boxpilot-keel-backup-helper-"));
  directories.push(directory);
  const paths = {
    root: path.join(directory, "managed", "backups", "keel"),
    restoreRoot: path.join(directory, "managed", "restore-drills"),
    approval: path.join(directory, "run", "keel-backup-approval.json"),
  };
  await mkdir(path.dirname(paths.approval), { recursive: true, mode: 0o700 });
  await mkdir(paths.root, { recursive: true, mode: 0o700 });
  const installHelper = { inspect: vi.fn(async () => ({ installed: true, serviceActive: true, serviceEnabled: true, installId, releaseVersion: "1.2.6" })) };
  const run = vi.fn(async (_binary, args) => {
    if (args[0] !== "start" || args[1] !== "boxpilot-keel-backup.service") return { ok: true, stdout: "", stderr: "" };
    const approval = JSON.parse(await readFile(paths.approval, "utf8"));
    const targets = pathsForKeelBackup(approval.backupId, paths);
    const content = Buffer.from("private Keel recovery archive\n");
    await writeFile(targets.archive, content, { mode: 0o600, flag: "wx" });
    await chmod(targets.archive, 0o600);
    const checksumSha256 = digest(content);
    const manifestChecksumSha256 = "b".repeat(64);
    const result = {
      schemaVersion: 1, backupId: approval.backupId, installId, applicationId: "keel", destination: "local-managed",
      artifactPath: targets.archive, checksumSha256, manifestChecksumSha256, sizeBytes: content.length, downtimeMs: 125,
      releaseVersion: "1.2.6", sourceRestartVerified: true,
      restoreDrill: { passed: true, mode: "isolated-keel-export-open", network: "none", publishedPorts: 0, databaseIntegrity: "ok", foreignKeyIssues: 0, schemaVerified: true, environmentIncluded: true, treeDigestMatched: true, manifestChecksumSha256, workspaceRemoved: true, applicationStarted: false, productionStateReplaced: false },
      boundary: { browserPathAccepted: false, browserCommandAccepted: false, browserTokenAccepted: false, databaseOpened: true, secretContentReturned: false, environmentContentReturned: false, sourceServiceStopped: true, sourceRestarted: true, networkAccessRequiredForDrill: false, productionStateReplaced: false, registrationChanged: false, claimChanged: false, tailscaleChanged: false, firewallChanged: false, routerChanged: false, independentCopyCreated: false, retentionPerformed: false, prunePerformed: false },
    };
    await writeFile(targets.result, `${JSON.stringify(result)}\n`, { mode: 0o600, flag: "wx" });
    await chmod(targets.result, 0o600);
    return { ok: true, stdout: "", stderr: "" };
  });
  const helper = createKeelBackupHelper({ paths, installHelper, run, now: () => new Date("2026-08-16T12:00:00.000Z"), expectedRootUid: process.getuid(), expectedRootGid: process.getgid() });
  return { directory, paths, installHelper, run, helper };
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("Keel backup helper boundary", () => {
  it("accepts only one UUID, writes a short-lived fixed marker, and rehashes static-unit evidence", async () => {
    const { paths, run, helper } = await fixture();
    const result = await helper.backup({ backupId });
    expect(result).toMatchObject({ backupId, installId, applicationId: "keel", sourceRestartVerified: true, restoreDrill: { passed: true, mode: "isolated-keel-export-open" } });
    expect(result.checksumSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(run).toHaveBeenCalledWith("/usr/bin/systemctl", ["start", "boxpilot-keel-backup.service"], { timeout: 20 * 60 * 1000 });
    await expect(stat(paths.approval)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(helper.backup({ backupId, path: "/tmp/copy" })).rejects.toThrow("only one backupId UUID");
    await expect(helper.backup({ backupId: "../../etc" })).rejects.toThrow("only one backupId UUID");
  });

  it("recovers an interrupted inactive unit by restarting Keel and removing only generated unrecorded paths", async () => {
    const { paths, run, helper } = await fixture();
    const approval = { backupId, installId, approvedAt: "2026-08-16T12:00:00.000Z", releaseTag: keelArtifactSpec.releaseTag, releaseCommitSha: keelArtifactSpec.releaseCommitSha, releaseVersion: "1.2.6", unitName: "keel.service" };
    await writeFile(paths.approval, `${JSON.stringify(approval)}\n`, { mode: 0o600 });
    const targets = pathsForKeelBackup(backupId, paths);
    await mkdir(targets.partial, { recursive: true });
    await mkdir(targets.drill, { recursive: true });
    await writeFile(targets.archivePartial, "partial");
    await writeFile(targets.archive, "unrecorded");
    await writeFile(targets.result, "unrecorded");
    run.mockImplementation(async (_binary, args) => args[0] === "is-active" ? { ok: false, stdout: "inactive", stderr: "" } : { ok: true, stdout: "", stderr: "" });
    await expect(helper.recoverInterrupted()).resolves.toEqual({ recovered: true, active: false, sourceRestartRequested: true, generatedPathsRemoved: 5 });
    expect(run).toHaveBeenCalledWith("/usr/bin/systemctl", ["start", "keel.service"], { timeout: 120000 });
    for (const target of [paths.approval, targets.partial, targets.drill, targets.archivePartial, targets.archive, targets.result]) await expect(stat(target)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("preserves the recovery marker and generated state if source restart fails", async () => {
    const { paths, run, helper } = await fixture();
    const approval = { backupId, installId, approvedAt: "2026-08-16T12:00:00.000Z", releaseTag: keelArtifactSpec.releaseTag, releaseCommitSha: keelArtifactSpec.releaseCommitSha, releaseVersion: "1.2.6", unitName: "keel.service" };
    await writeFile(paths.approval, `${JSON.stringify(approval)}\n`, { mode: 0o600 });
    const targets = pathsForKeelBackup(backupId, paths);
    await mkdir(targets.partial, { recursive: true });
    run.mockResolvedValue({ ok: false, stdout: "", stderr: "failed" });
    await expect(helper.recoverInterrupted()).rejects.toThrow("recovery marker was preserved");
    await expect(stat(paths.approval)).resolves.toMatchObject({ size: expect.any(Number) });
    await expect(stat(targets.partial)).resolves.toMatchObject({ size: expect.any(Number) });
  });
});
