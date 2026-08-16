import { chmod, copyFile, lstat, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { createApplicationProtectionHelper, applicationProtectionHelperInternals, validateApplicationProtectionInput } from "./application-protection-helper.mjs";

const directories = [];
const backupId = "11111111-1111-4111-8111-111111111111";
const protectionId = "22222222-2222-4222-8222-222222222222";
const repositoryId = "c".repeat(64);
const snapshotId = "d".repeat(64);

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function fixture(applicationId = "pi-hole") {
  const directory = await mkdtemp(path.join(os.tmpdir(), "boxpilot-application-protection-"));
  directories.push(directory);
  const backupRoot = path.join(directory, "managed", "backups");
  const applicationRoot = path.join(directory, "managed", "apps");
  const drillRoot = path.join(directory, "managed", "application-independent-restore-drills");
  const passwordFile = path.join(directory, "application-password");
  const mountRoot = "/mnt/boxpilot-application-test";
  const applicationDirectory = path.join(backupRoot, applicationId);
  const artifactPath = path.join(applicationDirectory, `${backupId}.tar.gz`);
  await mkdir(applicationDirectory, { recursive: true });
  await mkdir(applicationRoot, { recursive: true });
  await writeFile(artifactPath, "verified application archive", { mode: 0o600 });
  await chmod(artifactPath, 0o600);
  const metadata = await lstat(artifactPath);
  const checksum = createHash("sha256").update("verified application archive").digest("hex");
  const run = vi.fn(async (binary, args) => {
    if (args[0] === "version") return { stdout: JSON.stringify({ version: "0.18.1" }), stderr: "" };
    if (binary.endsWith("findmnt")) return { stdout: JSON.stringify({ filesystems: [{ target: mountRoot, source: "/dev/test", fstype: "ext4", options: "rw", "maj:min": "9:9" }] }), stderr: "" };
    if (args.includes("cat") && args.includes("config")) return { stdout: JSON.stringify({ id: repositoryId }), stderr: "" };
    if (args.includes("backup")) return { stdout: JSON.stringify({ message_type: "summary", snapshot_id: snapshotId, total_bytes_processed: metadata.size, dry_run: false }), stderr: "" };
    if (args.includes("check")) return { stdout: "", stderr: "" };
    if (args.includes("snapshots")) return { stdout: JSON.stringify([{ id: snapshotId, paths: [artifactPath], tags: ["boxpilot-application", `boxpilot-application-${applicationId}`, `boxpilot-application-backup-${backupId}`, `boxpilot-application-protection-${protectionId}`] }]), stderr: "" };
    if (args.includes("restore")) {
      const target = args[args.indexOf("--target") + 1];
      const restored = path.join(target, path.dirname(artifactPath).replace(/^\/+/, ""));
      await mkdir(restored, { recursive: true });
      await copyFile(artifactPath, path.join(restored, path.basename(artifactPath)));
      await chmod(path.join(restored, path.basename(artifactPath)), 0o600);
      return { stdout: "", stderr: "" };
    }
    throw new Error(`Unexpected command ${binary} ${args.join(" ")}`);
  });
  const statFile = async (filePath) => {
    if (filePath === mountRoot) return { isDirectory: () => true, isSymbolicLink: () => false, dev: 900 };
    if (filePath === passwordFile) return { isFile: () => true, isSymbolicLink: () => false, uid: 0, mode: 0o100600, size: 32 };
    const value = await lstat(filePath);
    return Object.assign(value, { dev: filePath === backupRoot || filePath === applicationRoot ? 100 : value.dev });
  };
  const helper = createApplicationProtectionHelper({
    mountRoot, passwordFile, cacheRoot: path.join(directory, "cache"), backupRoot, applicationRoot, restoreDrillRoot: drillRoot,
    statFile, statFilesystem: async () => ({ bavail: 1024 ** 2, bsize: 4096 }), run,
  });
  await helper.initialize();
  const destination = await helper.inspect();
  const parameters = { protectionId, backupId, applicationId, expectedArtifactChecksumSha256: checksum, expectedSizeBytes: metadata.size, expectedDestinationRevision: destination.destinationRevision };
  return { helper, run, destination, parameters, artifactPath, drillRoot };
}

describe("application independent protection helper", () => {
  it("accepts only server-generated identity and recorded evidence fields", () => {
    const input = { protectionId, backupId, applicationId: "uptime-kuma", expectedArtifactChecksumSha256: "a".repeat(64), expectedSizeBytes: 1024, expectedDestinationRevision: "c".repeat(64) };
    expect(validateApplicationProtectionInput(input)).toEqual([]);
    expect(validateApplicationProtectionInput({ ...input, applicationId: "../../etc" })).toContain("Application id is invalid");
    expect(validateApplicationProtectionInput({ ...input, applicationId: "keel" })).toEqual([]);
    expect(() => applicationProtectionHelperInternals.confinedArchive("/fixed/root", "pi-hole", "../../etc")).toThrow("invalid");
  });

  it("reports a separate read-only ready repository and recovery key", async () => {
    const { destination } = await fixture();
    expect(destination).toMatchObject({ ready: true, encrypted: true, independent: true, repositoryId, setupCommand: "sudo /opt/boxpilot/scripts/boxpilot-application-restic-setup.sh", boundary: { mutationPerformed: false, browserPathAccepted: false, browserPasswordAccepted: false } });
  });

  it("reads the repository and restores the exact approved archive", async () => {
    const { helper, run, parameters, drillRoot } = await fixture();
    const result = await helper.protect(parameters);
    expect(result).toMatchObject({ created: true, protectionId, backupId, applicationId: "pi-hole", repositoryId, snapshotId, encrypted: true, independent: true, repositoryVerified: true, protected: true, restoreDrill: { passed: true, mode: "exact-snapshot-artifact-restore", network: "none", artifactChecksumMatched: true, artifactSizeMatched: true, workspaceRemoved: true, applicationStarted: false }, boundary: { productionApplicationChanged: false, localBackupChanged: false, routerMutationPerformed: false, dnsCutoverPerformed: false, retentionPerformed: false, prunePerformed: false } });
    expect(run.mock.calls.some(([, args]) => args.includes("check") && args.includes("--read-data"))).toBe(true);
    await expect(lstat(path.join(drillRoot, protectionId))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects changed archive evidence before invoking restic backup", async () => {
    const { helper, run, parameters } = await fixture("uptime-kuma");
    await expect(helper.protect({ ...parameters, expectedArtifactChecksumSha256: "f".repeat(64) })).rejects.toThrow("checksum changed");
    expect(run.mock.calls.some(([, args]) => args.includes("backup"))).toBe(false);
  });
});
