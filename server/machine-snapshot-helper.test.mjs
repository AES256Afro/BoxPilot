import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fixedRun } from "./exec.mjs";
import { createMachineSnapshotHelper } from "./machine-snapshot-helper.mjs";

const directories = [];
const snapshotId = "11111111-1111-4111-8111-111111111111";

async function fixture({ mounted = true } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "boxpilot-machine-snapshot-"));
  directories.push(root);
  const paths = {
    snapshotRoot: path.join(root, "machine-snapshots"),
    catalogRoot: path.join(root, "catalog"),
    applicationBackupRoot: path.join(root, "backups", "catalog"),
    controllerBackupRoot: path.join(root, "backups", "boxpilot-controller"),
    mountRoot: path.join(root, "mount"),
    netplanDirectory: path.join(root, "netplan"),
    ufwDirectory: path.join(root, "ufw"),
    fstabPath: path.join(root, "fstab"),
  };
  // An installed app with settings, a secret env, and one recorded data backup.
  await mkdir(path.join(paths.catalogRoot, "uptime-kuma"), { recursive: true });
  await writeFile(path.join(paths.catalogRoot, "uptime-kuma", "boxpilot.json"), JSON.stringify({ id: "uptime-kuma", installed: true }));
  await writeFile(path.join(paths.catalogRoot, "uptime-kuma", "compose.yaml"), "services: {}\n");
  await writeFile(path.join(paths.catalogRoot, "uptime-kuma", ".env"), "ADMIN_TOKEN=do-not-lose\n");
  await mkdir(path.join(paths.applicationBackupRoot, "uptime-kuma"), { recursive: true });
  await writeFile(path.join(paths.applicationBackupRoot, "uptime-kuma", "20260816T030000Z.tar.gz"), "app-backup-bytes");
  await mkdir(paths.controllerBackupRoot, { recursive: true });
  await mkdir(paths.netplanDirectory, { recursive: true });
  await writeFile(path.join(paths.netplanDirectory, "01-config.yaml"), "network: {version: 2}\n");
  await mkdir(paths.ufwDirectory, { recursive: true });
  await writeFile(path.join(paths.ufwDirectory, "user.rules"), "### RULES ###\n");
  await writeFile(paths.fstabPath, "# fstab\n");
  await mkdir(paths.mountRoot, { recursive: true });

  const controllerArtifactDirectory = path.join(paths.controllerBackupRoot, "generated");
  await mkdir(controllerArtifactDirectory, { recursive: true });
  await writeFile(path.join(controllerArtifactDirectory, "boxpilot.sqlite3"), "sqlite-copy-bytes");
  await writeFile(path.join(controllerArtifactDirectory, "manifest.json"), JSON.stringify({ schemaVersion: 1 }));
  const controllerBackups = {
    createBackup: vi.fn(async ({ backupId }) => ({
      backupId,
      applicationId: "boxpilot-controller",
      destination: "local-managed",
      artifactPath: path.join(controllerArtifactDirectory, "boxpilot.sqlite3"),
      manifestPath: path.join(controllerArtifactDirectory, "manifest.json"),
      checksumSha256: createHash("sha256").update("sqlite-copy-bytes").digest("hex"),
      sizeBytes: 17,
      downtimeMs: 0,
      restoreDrill: { passed: true },
    })),
  };
  // virsh reports one domain; findmnt reports the mount when `mounted`. tar runs for real.
  const run = vi.fn(async (binary, args, options) => {
    if (binary === "/usr/bin/virsh" && args.includes("list")) return { ok: true, stdout: "snapshot-lab\n" };
    if (binary === "/usr/bin/virsh" && args.includes("dumpxml")) return { ok: true, stdout: "<domain><name>snapshot-lab</name></domain>" };
    if (binary === "/usr/bin/findmnt") {
      if (!mounted) return { ok: false, stdout: "", stderr: "not mounted" };
      return { ok: true, stdout: JSON.stringify({ filesystems: [{ target: paths.mountRoot, source: "/dev/sdb1", fstype: "ext4" }] }) };
    }
    return fixedRun(binary, args, options);
  });
  const helper = createMachineSnapshotHelper({
    run,
    controllerBackups,
    ...paths,
    virshBinary: "/usr/bin/virsh",
    findmntBinary: "/usr/bin/findmnt",
    requireIndependentDevice: false,
    keep: 2,
    now: () => new Date("2026-08-21T02:00:00.000Z"),
  });
  return { helper, paths, controllerBackups, run };
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("machine snapshot helper", () => {
  it("assembles one verified secret-bearing archive from every live evidence family", async () => {
    const { helper, paths, controllerBackups } = await fixture();
    const result = await helper.create({ snapshotId });
    expect(result).toMatchObject({
      created: true,
      snapshotId,
      containsSecrets: true,
      contents: {
        apps: [{ id: "uptime-kuma", installed: true, projectFiles: 3, backups: 1 }],
        system: { netplanFiles: 1, ufwFiles: 1, fstab: true },
        vms: { available: true, domains: ["snapshot-lab"] },
      },
      boundary: { dataVolumesIncluded: false, deletesOutsideRetention: false, networkUsed: false },
    });
    expect(controllerBackups.createBackup).toHaveBeenCalledOnce();
    expect(result.controllerBackup.restoreDrill.passed).toBe(true);
    const artifact = await stat(result.artifactPath);
    expect(artifact.size).toBe(result.sizeBytes);
    expect(artifact.mode & 0o777).toBe(0o600);
    const meta = JSON.parse(await readFile(`${result.artifactPath}.meta.json`, "utf8"));
    expect(meta).toMatchObject({ snapshotId, checksumSha256: result.checksumSha256, containsSecrets: true });
    // No staging residue.
    expect((await readdir(paths.snapshotRoot)).filter((name) => name.startsWith(".staging"))).toEqual([]);
  });

  it("rejects malformed snapshot ids and keeps only the newest snapshots", async () => {
    const { helper, paths } = await fixture();
    await expect(helper.create({ snapshotId: "../../etc" })).rejects.toThrow("must be a UUID");
    await mkdir(paths.snapshotRoot, { recursive: true });
    for (const stamp of ["20260101T000000Z", "20260102T000000Z"]) {
      await writeFile(path.join(paths.snapshotRoot, `machine-snapshot-${stamp}-aaaaaaaa.tar.gz`), "old");
      await writeFile(path.join(paths.snapshotRoot, `machine-snapshot-${stamp}-aaaaaaaa.tar.gz.meta.json`), "{}");
    }
    const result = await helper.create({ snapshotId });
    expect(result.removedByRetention).toEqual(["machine-snapshot-20260101T000000Z-aaaaaaaa.tar.gz"]);
    expect((await helper.inspect()).snapshots).toHaveLength(2);
  });

  it("mirrors the local backup roots onto the mount with hash verification and no deletes", async () => {
    const { helper, paths } = await fixture();
    await helper.create({ snapshotId });
    await writeFile(path.join(paths.mountRoot, "operator-file.txt"), "keep me");
    const result = await helper.sync();
    expect(result).toMatchObject({ synced: true, verified: true, boundary: { deletesPerformed: false, networkUsed: false } });
    expect(result.copiedCount).toBeGreaterThan(0);
    const mirrored = await readFile(path.join(result.destination, "application-backups", "uptime-kuma", "20260816T030000Z.tar.gz"), "utf8");
    expect(mirrored).toBe("app-backup-bytes");
    expect(await readFile(path.join(paths.mountRoot, "operator-file.txt"), "utf8")).toBe("keep me");
    // Second sync copies nothing new and records its completion for the inspector.
    const repeat = await helper.sync();
    expect(repeat.copiedCount).toBe(0);
    expect((await helper.inspect()).sync.lastSync).toMatchObject({ copiedCount: 0 });
  });

  it("refuses to sync when the destination is not an independent mount", async () => {
    const { helper } = await fixture({ mounted: false });
    await expect(helper.sync()).rejects.toThrow("Mount an independent filesystem");
    const inspection = await helper.inspect();
    expect(inspection.sync.mount).toMatchObject({ mounted: false, independentFilesystem: false });
  });
});
