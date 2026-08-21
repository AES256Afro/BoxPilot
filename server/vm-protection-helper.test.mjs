import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createVmProtectionHelper, validateVmProtectionInput } from "./vm-protection-helper.mjs";

const directories = [];
const repositoryId = "a".repeat(64);
const snapshotId = "b".repeat(64);

function digest(content) {
  return createHash("sha256").update(content).digest("hex");
}

async function fixture({ independent = true, passwordMode = 0o600 } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "boxpilot-vm-protection-helper-"));
  directories.push(directory);
  const mountRoot = path.join("/mnt", `boxpilot-test-${path.basename(directory)}`);
  const localMountRoot = path.join(directory, "mount");
  const exportRoot = path.join(directory, "exports");
  const imageRoot = path.join(directory, "images");
  const passwordFile = path.join(directory, "restic-password");
  const cacheRoot = path.join(directory, "cache");
  await Promise.all([mkdir(localMountRoot), mkdir(exportRoot), mkdir(imageRoot)]);
  await writeFile(passwordFile, "correct horse battery staple\n", { mode: passwordMode });
  const exportId = "11111111-1111-4111-8111-111111111111";
  const backupId = "22222222-2222-4222-8222-222222222222";
  const domainUuid = "33333333-3333-4333-8333-333333333333";
  const exportDirectory = path.join(exportRoot, exportId);
  await mkdir(exportDirectory, { mode: 0o700 });
  const xml = "<domain><name>ubuntu-lab</name></domain>\n";
  const disk = Buffer.from("standalone qcow2 fixture");
  await writeFile(path.join(exportDirectory, "domain.xml"), xml, { mode: 0o600 });
  await writeFile(path.join(exportDirectory, "vda.qcow2"), disk, { mode: 0o600 });
  const manifest = {
    schemaVersion: 1,
    exportId,
    domain: { name: "ubuntu-lab", uuid: domainUuid },
    destination: "local-managed",
    encrypted: false,
    protected: false,
    domainXml: { file: "domain.xml", sizeBytes: Buffer.byteLength(xml), checksumSha256: digest(xml) },
    disks: [{ target: "vda", file: "vda.qcow2", sizeBytes: disk.length, checksumSha256: digest(disk), contentVerified: true }],
    restoreDrill: { passed: false, reason: "not run" },
  };
  const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
  await writeFile(path.join(exportDirectory, "manifest.json"), manifestText, { mode: 0o600 });
  const expectedSizeBytes = Buffer.byteLength(xml) + disk.length + Buffer.byteLength(manifestText);
  const run = vi.fn(async (binary, args) => {
    if (binary === "/usr/bin/restic" && args[0] === "version") return { stdout: '{"version":"0.19.1"}', stderr: "" };
    if (binary === "/usr/bin/findmnt") return { stdout: JSON.stringify({ filesystems: [{ target: mountRoot, source: "/dev/sdb1", fstype: "ext4", options: "rw,relatime", "maj:min": "8:17" }] }), stderr: "" };
    if (binary === "/usr/bin/restic" && args.includes("cat")) return { stdout: JSON.stringify({ version: 2, id: repositoryId }), stderr: "" };
    if (binary === "/usr/bin/restic" && args.includes("backup")) return { stdout: JSON.stringify({ message_type: "summary", dry_run: false, total_bytes_processed: expectedSizeBytes, snapshot_id: snapshotId }), stderr: "" };
    if (binary === "/usr/bin/restic" && args.includes("check")) return { stdout: "", stderr: "" };
    if (binary === "/usr/bin/restic" && args.includes("snapshots")) return { stdout: JSON.stringify([{ id: snapshotId, paths: [exportDirectory], tags: [`boxpilot-export-${exportId}`, `boxpilot-backup-${backupId}`] }]), stderr: "" };
    throw new Error(`unexpected command ${binary} ${args.join(" ")}`);
  });
  const statFile = async (requestedPath) => {
    const mappedPath = requestedPath === mountRoot ? localMountRoot : requestedPath;
    const metadata = await lstat(mappedPath);
    return {
      dev: requestedPath === mountRoot ? (independent ? 2 : 1) : 1,
      uid: requestedPath === passwordFile ? 0 : metadata.uid,
      mode: requestedPath === passwordFile ? passwordMode : metadata.mode,
      size: metadata.size,
      isFile: () => metadata.isFile(),
      isDirectory: () => metadata.isDirectory(),
      isSymbolicLink: () => metadata.isSymbolicLink(),
    };
  };
  const helper = createVmProtectionHelper({
    mountRoot, passwordFile, cacheRoot, exportRoot, imageRoot, statFile,
    statFilesystem: async () => ({ bavail: 1024 * 1024, bsize: 4096 }),
    readText: readFile,
    run,
  });
  return {
    helper, run, exportId, backupId, domainUuid, expectedSizeBytes,
    expectedManifestChecksumSha256: digest(manifestText),
  };
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("encrypted independent VM backup helper", () => {
  it("validates a secret-free fixed protection input", () => {
    expect(validateVmProtectionInput({ backupId: "bad", exportId: "bad", domainName: "../../etc", domainUuid: "bad", expectedManifestChecksumSha256: "x", expectedSizeBytes: 0, expectedDestinationRevision: "x" })).toEqual([
      "Backup id must be a UUID", "Export id must be a UUID", "Domain name is invalid", "Domain UUID is invalid", "Manifest checksum is invalid", "Expected export size is invalid", "Destination revision is invalid",
    ]);
  });

  it("detects an initialized encrypted repository on a different writable filesystem", async () => {
    const { helper } = await fixture();
    await expect(helper.inspect()).resolves.toMatchObject({
      ready: true, adapter: "mounted-restic", encrypted: true, independent: true, resticVersion: "0.19.1", repositoryId,
      mount: { source: "/dev/sdb1", independentFilesystem: true, writable: true }, blockers: [],
    });
  });

  it("rejects a directory on the server's source filesystem as independent protection", async () => {
    const { helper } = await fixture({ independent: false });
    const status = await helper.inspect();
    expect(status.ready).toBe(false);
    expect(status.independent).toBe(false);
    expect(status.blockers).toContain("Mount a writable independent filesystem at the configured VM backup mount");
  });

  it("backs up only the fixed verified export and fully checks all repository data", async () => {
    const { helper, run, exportId, backupId, domainUuid, expectedSizeBytes, expectedManifestChecksumSha256 } = await fixture();
    const destination = await helper.inspect();
    const result = await helper.createBackup({
      backupId, exportId, domainName: "ubuntu-lab", domainUuid,
      expectedManifestChecksumSha256, expectedSizeBytes, expectedDestinationRevision: destination.destinationRevision,
    });
    expect(result).toMatchObject({ created: true, backupId, exportId, repositoryId, snapshotId, sizeBytes: expectedSizeBytes, encrypted: true, independent: true, repositoryVerified: true, protected: false, restoreDrill: { passed: false } });
    expect(run).toHaveBeenCalledWith("/usr/bin/restic", expect.arrayContaining(["backup", expect.stringContaining(exportId), "--tag", `boxpilot-export-${exportId}`, "--tag", `boxpilot-backup-${backupId}`]), { timeout: 12 * 60 * 60 * 1000 });
    expect(run).toHaveBeenCalledWith("/usr/bin/restic", expect.arrayContaining(["check", "--read-data", "--quiet"]), { timeout: 12 * 60 * 60 * 1000 });
    const checkCall = run.mock.calls.find(([, argumentsList]) => argumentsList.includes("check"));
    expect(checkCall[1]).not.toContain("--tag");
  });

  it("fails before restic backup when local export content changed", async () => {
    const { helper, run, exportId, backupId, domainUuid, expectedSizeBytes } = await fixture();
    const destination = await helper.inspect();
    await expect(helper.createBackup({
      backupId, exportId, domainName: "ubuntu-lab", domainUuid,
      expectedManifestChecksumSha256: "f".repeat(64), expectedSizeBytes, expectedDestinationRevision: destination.destinationRevision,
    })).rejects.toThrow("manifest checksum changed");
    expect(run.mock.calls.some(([, args]) => args.includes("backup"))).toBe(false);
  });
});
