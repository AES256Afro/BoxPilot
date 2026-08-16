import { copyFile, lstat, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createControllerBackupHelper } from "./controller-backup-helper.mjs";
import { createControllerProtectionHelper, controllerProtectionHelperInternals, validateControllerProtectionInput } from "./controller-protection-helper.mjs";
import { createStateStore } from "./state.mjs";

const directories = [];
const backupId = "11111111-1111-4111-8111-111111111111";
const protectionId = "22222222-2222-4222-8222-222222222222";
const repositoryId = "c".repeat(64);
const snapshotId = "d".repeat(64);

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "boxpilot-controller-protection-"));
  directories.push(directory);
  const stateDirectory = path.join(directory, "state");
  const backupRoot = path.join(directory, "managed", "backups", "boxpilot-controller");
  const localDrillRoot = path.join(directory, "managed", "controller-restore-drills");
  const protectionDrillRoot = path.join(directory, "managed", "controller-independent-restore-drills");
  const passwordFile = path.join(directory, "controller-password");
  const mountRoot = "/mnt/boxpilot-controller-test";
  const store = createStateStore({ stateDirectory });
  const token = store.createBootstrapToken();
  store.consumeBootstrapToken(token.token, { username: "operator", passwordHash: "hash" });
  const local = createControllerBackupHelper({ sourceDatabasePath: store.databasePath, backupRoot, restoreDrillRoot: localDrillRoot, now: () => new Date("2026-08-16T09:00:00.000Z") });
  await local.initialize();
  const localResult = await local.createBackup({ backupId });
  const manifestSize = (await lstat(localResult.manifestPath)).size;

  const run = vi.fn(async (binary, args) => {
    if (args[0] === "version") return { stdout: JSON.stringify({ version: "0.18.1" }), stderr: "" };
    if (binary.endsWith("findmnt")) return { stdout: JSON.stringify({ filesystems: [{ target: mountRoot, source: "/dev/test", fstype: "ext4", options: "rw", "maj:min": "9:9" }] }), stderr: "" };
    if (args.includes("cat") && args.includes("config")) return { stdout: JSON.stringify({ id: repositoryId }), stderr: "" };
    if (args.includes("backup")) return { stdout: JSON.stringify({ message_type: "summary", snapshot_id: snapshotId, total_bytes_processed: localResult.sizeBytes + manifestSize, dry_run: false }), stderr: "" };
    if (args.includes("check")) return { stdout: "", stderr: "" };
    if (args.includes("snapshots")) return { stdout: JSON.stringify([{ id: snapshotId, paths: [path.dirname(localResult.artifactPath)], tags: ["boxpilot-controller", `boxpilot-controller-backup-${backupId}`, `boxpilot-controller-protection-${protectionId}`] }]), stderr: "" };
    if (args.includes("restore")) {
      const target = args[args.indexOf("--target") + 1];
      const sourceDirectory = path.dirname(localResult.artifactPath);
      const restored = path.join(target, sourceDirectory.replace(/^\/+/, ""));
      await mkdir(restored, { recursive: true });
      await copyFile(path.join(sourceDirectory, "boxpilot.sqlite3"), path.join(restored, "boxpilot.sqlite3"));
      await copyFile(path.join(sourceDirectory, "manifest.json"), path.join(restored, "manifest.json"));
      return { stdout: "", stderr: "" };
    }
    throw new Error(`Unexpected command ${binary} ${args.join(" ")}`);
  });
  const statFile = async (filePath) => {
    if (filePath === mountRoot) return { isDirectory: () => true, isSymbolicLink: () => false, dev: 900 };
    if (filePath === passwordFile) return { isFile: () => true, isSymbolicLink: () => false, uid: 0, mode: 0o100600, size: 32 };
    return lstat(filePath);
  };
  const helper = createControllerProtectionHelper({
    mountRoot,
    passwordFile,
    cacheRoot: path.join(directory, "cache"),
    backupRoot,
    sourceDatabasePath: store.databasePath,
    restoreDrillRoot: protectionDrillRoot,
    statFile,
    statFilesystem: async () => ({ bavail: 1024 ** 2, bsize: 4096 }),
    run,
  });
  await helper.initialize();
  const parameters = {
    protectionId,
    backupId,
    expectedArtifactChecksumSha256: localResult.checksumSha256,
    expectedManifestChecksumSha256: localResult.manifestChecksumSha256,
    expectedSizeBytes: localResult.sizeBytes,
    expectedDestinationRevision: null,
  };
  const destination = await helper.inspect();
  parameters.expectedDestinationRevision = destination.destinationRevision;
  return { directory, store, helper, run, destination, parameters, localResult, protectionDrillRoot };
}

describe("controller independent protection helper", () => {
  it("accepts only server-generated identity and recorded evidence fields", () => {
    const input = { protectionId, backupId, expectedArtifactChecksumSha256: "a".repeat(64), expectedManifestChecksumSha256: "b".repeat(64), expectedSizeBytes: 8192, expectedDestinationRevision: "c".repeat(64) };
    expect(validateControllerProtectionInput(input)).toEqual([]);
    expect(validateControllerProtectionInput({ ...input, protectionId: "../../etc" })).toContain("Protection id must be a UUID");
    expect(() => controllerProtectionHelperInternals.confinedChild("/fixed/root", "../escape")).toThrow("escaped its fixed root");
  });

  it("reports a read-only ready destination with a distinct repository and recovery key", async () => {
    const { destination, run } = await fixture();
    expect(destination).toMatchObject({ ready: true, encrypted: true, independent: true, repositoryId, setupCommand: "sudo /opt/boxpilot/scripts/boxpilot-controller-restic-setup.sh", boundary: { mutationPerformed: false, browserPathAccepted: false, browserPasswordAccepted: false } });
    expect(run).toHaveBeenCalledWith(expect.stringContaining("findmnt"), expect.arrayContaining(["--mountpoint", "/mnt/boxpilot-controller-test"]), expect.any(Object));
  });

  it("reads the complete repository and restores the exact snapshot before claiming protection", async () => {
    const { helper, run, parameters, localResult, protectionDrillRoot } = await fixture();
    const result = await helper.protect(parameters);
    expect(result).toMatchObject({ created: true, protectionId, backupId, repositoryId, snapshotId, encrypted: true, independent: true, repositoryVerified: true, protected: true, restoreDrill: { passed: true, mode: "exact-snapshot-isolated-copy-open", network: "none", artifactChecksumMatched: true, manifestChecksumMatched: true, workspaceRemoved: true }, boundary: { productionDatabaseChanged: false, localBackupChanged: false, retentionPerformed: false, prunePerformed: false } });
    expect(result.artifactChecksumSha256).toBe(localResult.checksumSha256);
    expect(run.mock.calls.some(([, args]) => args.includes("check") && args.includes("--read-data"))).toBe(true);
    expect(run.mock.calls.some(([, args]) => args.includes("restore") && args.includes(snapshotId))).toBe(true);
    await expect(lstat(path.join(protectionDrillRoot, protectionId))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects changed artifact evidence before invoking restic backup", async () => {
    const { helper, run, parameters } = await fixture();
    await expect(helper.protect({ ...parameters, expectedArtifactChecksumSha256: "f".repeat(64) })).rejects.toThrow("checksum changed");
    expect(run.mock.calls.some(([, args]) => args.includes("backup"))).toBe(false);
  });
});
