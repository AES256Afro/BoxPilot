import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createKeelRecoveryHelper, keelRecoveryHelperInternals, validateKeelRecoveryInput } from "./keel-recovery-helper.mjs";
import { keelBackupIdentity, pathsForKeelBackup } from "./keel-backup-spec.mjs";
import { pathsForKeelRecovery } from "./keel-recovery-spec.mjs";
import { keelBackupScriptInternals } from "../scripts/boxpilot-keel-backup.mjs";

const execFile = promisify(execFileCallback);
const directories = [];
const backupId = "11111111-1111-4111-8111-111111111111";
const recoveryId = "22222222-2222-4222-8222-222222222222";
const installId = "33333333-3333-4333-8333-333333333333";

async function sha256(file) {
  return createHash("sha256").update(await readFile(file)).digest("hex");
}

async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "boxpilot-keel-recovery-helper-"));
  directories.push(directory);
  const backupPaths = { root: path.join(directory, "backups", "keel"), restoreRoot: path.join(directory, "drills"), approval: path.join(directory, "approval.json") };
  const recoveryPaths = { root: path.join(directory, "recoveries") };
  const source = pathsForKeelBackup(backupId, backupPaths);
  await mkdir(source.exportRoot, { recursive: true, mode: 0o700 });
  const database = new DatabaseSync(path.join(source.exportRoot, "keel.db"));
  for (const table of ["AppSetting", "Page", "User", "Workspace"]) database.exec(`CREATE TABLE ${table} (id INTEGER PRIMARY KEY);`);
  database.close();
  await writeFile(path.join(source.exportRoot, "keel.env"), "HOST=127.0.0.1\nPORT=3000\n", { mode: 0o600 });
  await writeFile(path.join(source.exportRoot, "keel.db.keel-server-secrets.key"), `${"a".repeat(64)}\n`, { mode: 0o600 });
  await mkdir(path.join(source.exportRoot, "keel.db.uploads"), { mode: 0o700 });
  await writeFile(path.join(source.exportRoot, "keel.db.uploads", "note.txt"), "private upload\n", { mode: 0o600 });
  const tree = await keelBackupScriptInternals.inspectTree(source.exportRoot, { excludeManifest: true });
  const manifest = {
    schemaVersion: 1, backupId, installId, exportedAt: "2026-08-16T12:00:00.000Z", releaseTag: keelBackupIdentity.releaseTag, releaseCommitSha: keelBackupIdentity.releaseCommitSha, releaseVersion: keelBackupIdentity.releaseVersion,
    treeDigestSha256: tree.digest, regularFiles: tree.regularFiles, directories: tree.directories, logicalBytes: tree.bytes,
    databaseIntegrity: { integrityCheck: "ok", foreignKeyIssues: 0, schemaVerified: true }, managedSecretCompanionIncluded: true, environmentIncluded: true, uploadsIncluded: true,
  };
  await writeFile(path.join(source.exportRoot, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  await execFile("/usr/bin/tar", ["--create", "--gzip", "--file", source.archive, "--directory", source.partial, "keel-export"]);
  await chmod(source.archive, 0o600);
  const expectedArtifactChecksumSha256 = await sha256(source.archive);
  const expectedManifestChecksumSha256 = await sha256(path.join(source.exportRoot, "manifest.json"));
  const archive = await stat(source.archive);
  const result = {
    schemaVersion: 1, backupId, installId, applicationId: "keel", destination: "local-managed", artifactPath: source.archive,
    checksumSha256: expectedArtifactChecksumSha256, manifestChecksumSha256: expectedManifestChecksumSha256, sizeBytes: archive.size, downtimeMs: 1, releaseVersion: "1.2.6", sourceRestartVerified: true,
    restoreDrill: { passed: true, mode: "isolated-keel-export-open", network: "none", publishedPorts: 0, databaseIntegrity: "ok", foreignKeyIssues: 0, schemaVerified: true, environmentIncluded: true, treeDigestMatched: true, manifestChecksumSha256: expectedManifestChecksumSha256, workspaceRemoved: true, applicationStarted: false, productionStateReplaced: false },
    boundary: { productionStateReplaced: false, registrationChanged: false, claimChanged: false, tailscaleChanged: false, firewallChanged: false, routerChanged: false },
  };
  await writeFile(source.result, `${JSON.stringify(result)}\n`, { mode: 0o600 });
  await chmod(source.result, 0o600);
  const input = { recoveryId, backupId, expectedArtifactChecksumSha256, expectedManifestChecksumSha256, expectedSizeBytes: archive.size };
  return { backupPaths, recoveryPaths, source, input, helper: createKeelRecoveryHelper({ backupPaths, recoveryPaths, now: () => new Date("2026-08-16T13:00:00.000Z"), expectedRootUid: process.getuid(), expectedRootGid: process.getgid() }) };
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("Keel recovery helper boundary", () => {
  it("accepts only fixed typed evidence and creates a stopped root-only clone", async () => {
    const { helper, input, recoveryPaths, source } = await fixture();
    await expect(helper.inspect(input)).resolves.toMatchObject({ ready: true, recoveryId, backupId, initialState: "stopped", network: "none", applicationStarted: false, productionStateReplaced: false });
    const result = await helper.create(input);
    expect(result).toMatchObject({ created: true, recoveryId, backupId, destination: "managed-keel-recovery", databaseIntegrity: "ok", foreignKeyIssues: 0, schemaVerified: true, initialState: "stopped", network: "none", applicationStarted: false, productionStateReplaced: false, promotionPerformed: false });
    const targets = pathsForKeelRecovery(recoveryId, recoveryPaths);
    await expect(stat(path.join(targets.finalState, "keel.db"))).resolves.toMatchObject({ mode: expect.any(Number) });
    await expect(readFile(path.join(targets.finalState, ".env"), "utf8")).resolves.toContain("HOST=127.0.0.1");
    await expect(readFile(path.join(targets.finalState, ".keel-server-secrets.key"), "utf8")).resolves.toContain("a".repeat(64));
    await expect(readFile(path.join(targets.finalState, "uploads", "note.txt"), "utf8")).resolves.toBe("private upload\n");
    await expect(sha256(source.archive)).resolves.toBe(input.expectedArtifactChecksumSha256);
    expect((await stat(targets.final)).mode & 0o7777).toBe(0o700);
    expect((await stat(path.join(targets.finalState, "keel.db"))).mode & 0o7777).toBe(0o600);
  });

  it("fails closed when source evidence changes and removes only its partial target", async () => {
    const { helper, input, recoveryPaths, source } = await fixture();
    await writeFile(source.archive, "changed", { mode: 0o600 });
    await expect(helper.create(input)).rejects.toThrow(/missing, unsafe, or changed|checksum changed/);
    const targets = pathsForKeelRecovery(recoveryId, recoveryPaths);
    await expect(stat(targets.partial)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(targets.final)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects paths, commands, changed identifiers, and unsafe archive members", () => {
    expect(validateKeelRecoveryInput({ recoveryId, backupId, expectedArtifactChecksumSha256: "a".repeat(64), expectedManifestChecksumSha256: "b".repeat(64), expectedSizeBytes: 42 })).toEqual([]);
    expect(validateKeelRecoveryInput({ recoveryId, backupId, expectedArtifactChecksumSha256: "a".repeat(64), expectedManifestChecksumSha256: "b".repeat(64), expectedSizeBytes: 42, path: "/tmp" })).toContain("Keel recovery accepts only the fixed typed backup evidence fields");
    expect(validateKeelRecoveryInput({ recoveryId: "../../etc", backupId, expectedArtifactChecksumSha256: "a".repeat(64), expectedManifestChecksumSha256: "b".repeat(64), expectedSizeBytes: 42 })).toContain("Recovery id must be a UUID");
    expect(() => keelRecoveryHelperInternals.validateArchiveMembers("keel-export/\n../../etc/passwd\nkeel-export/keel.db")).toThrow("outside its fixed root");
  });
});
