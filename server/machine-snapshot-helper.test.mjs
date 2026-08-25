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
    // A drive someone plugged into a rebuilt server: BoxPilot never wrote here.
    rescueRoot: path.join(root, "rescue"),
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
  await mkdir(path.join(paths.rescueRoot, "boxpilot-local-mirror", "machine-snapshots"), { recursive: true });

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
      // Discovery asks for every real filesystem; the mirror check asks about one mountpoint.
      if (args.includes("--real")) {
        return { ok: true, stdout: JSON.stringify({ filesystems: [
          { target: "/", source: "/dev/mapper/root", fstype: "ext4", children: [{ target: paths.rescueRoot, source: "//nas/backups", fstype: "cifs" }] },
          { target: "/run/lock", source: "tmpfs", fstype: "tmpfs" },
          ...(mounted ? [{ target: paths.mountRoot, source: "/dev/sdb1", fstype: "ext4" }] : []),
        ] }) };
      }
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

describe("restoring from a machine snapshot", () => {
  /** A stand-in deployer that keeps the app's state file the way the real one does. */
  function deployer(paths, calls = { install: 0, restoreData: 0 }) {
    const stateFile = path.join(paths.catalogRoot, "uptime-kuma", "boxpilot.json");
    return {
      calls,
      internals: { readState: async (id) => JSON.parse(await readFile(path.join(paths.catalogRoot, id, "boxpilot.json"), "utf8")).id ? JSON.parse(await readFile(path.join(paths.catalogRoot, id, "boxpilot.json"), "utf8")) : null },
      install: async () => { calls.install += 1; await writeFile(stateFile, JSON.stringify({ id: "uptime-kuma", installed: true })); },
      restoreAppBackup: async () => { calls.restoreData += 1; },
    };
  }

  it("refuses an archive whose checksum file is missing, before touching anything", async () => {
    const { helper, paths } = await fixture();
    const created = await helper.create({ snapshotId });
    await rm(`${created.artifactPath}.meta.json`);
    await writeFile(path.join(paths.catalogRoot, "uptime-kuma", "boxpilot.json"), JSON.stringify({ id: "uptime-kuma", installed: false }));
    const apps = deployer(paths);
    await expect(helper.restore({ source: "local", artifact: created.artifact }, { apps })).rejects.toThrow(/cannot be verified/);
    expect(apps.calls.install).toBe(0);
  });

  it("picks up where an interrupted restore stopped instead of starting over", async () => {
    const { helper, paths } = await fixture();
    const created = await helper.create({ snapshotId });
    const stateFile = path.join(paths.catalogRoot, "uptime-kuma", "boxpilot.json");
    // The app was installed by an earlier run of this same restore, which stopped before its data.
    await writeFile(stateFile, JSON.stringify({ id: "uptime-kuma", installed: true, restoredFrom: created.artifact }));
    const apps = deployer(paths);
    const first = await helper.restore({ source: "local", artifact: created.artifact }, { apps });
    expect(first.apps[0]).toMatchObject({ id: "uptime-kuma", installed: true, alreadyRestored: true, dataRestored: true, error: null });
    expect(apps.calls).toEqual({ install: 0, restoreData: 1 }); // installed once already; only the data was outstanding
    expect(JSON.parse(await readFile(stateFile, "utf8")).restoredDataFrom).toBe("20260816T030000Z.tar.gz");

    // Running it a third time is a no-op rather than a second data restore.
    const again = await helper.restore({ source: "local", artifact: created.artifact }, { apps });
    expect(again.apps[0]).toMatchObject({ installed: true, alreadyRestored: true, dataRestored: true });
    expect(apps.calls).toEqual({ install: 0, restoreData: 1 });
  });
});

/**
 * Finding a snapshot on a drive nobody told BoxPilot about is the whole of disaster recovery: a
 * reinstalled server has no snapshots of its own and no destination configured, because the
 * settings describing the destination were on the disk that died.
 */
describe("finding snapshots on a drive that was just plugged in", () => {
  async function plant(directory, name) {
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, name), "archive-bytes");
    await writeFile(path.join(directory, `${name}.meta.json`), JSON.stringify({
      sizeBytes: 13, createdAt: "2026-08-20T02:00:00.000Z", checksumSha256: "a".repeat(64), contents: { apps: [{ id: "jellyfin" }, { id: "pi-hole" }] },
    }));
  }

  it("finds one BoxPilot never wrote, and says which drive it is on", async () => {
    const { helper, paths } = await fixture();
    const mirror = path.join(paths.rescueRoot, "boxpilot-local-mirror", "machine-snapshots");
    await plant(mirror, "machine-snapshot-20260820T020000Z-abcdef12.tar.gz");

    const { locations } = await helper.discover();
    const found = locations.find((location) => location.root === path.resolve(mirror));
    expect(found, `looked for ${mirror} in ${locations.map((l) => l.root).join(", ")}`).toBeTruthy();
    expect(found.mount).toMatchObject({ source: "//nas/backups", filesystem: "cifs" });
    // Enough to choose between two snapshots without opening either.
    expect(found.snapshots[0]).toMatchObject({ artifact: "machine-snapshot-20260820T020000Z-abcdef12.tar.gz", apps: 2, sizeBytes: 13 });
  });

  it("says nothing about a drive that has none", async () => {
    const { helper, paths } = await fixture();
    const { locations } = await helper.discover();
    expect(locations.some((location) => location.root.startsWith(path.resolve(paths.rescueRoot)))).toBe(false);
  });

  it("does not report the local store and the mirror twice", async () => {
    const { helper, paths } = await fixture();
    await plant(paths.snapshotRoot, "machine-snapshot-20260819T020000Z-11111111.tar.gz");
    const { locations } = await helper.discover();
    expect(locations.map((location) => location.root)).not.toContain(path.resolve(paths.snapshotRoot));
  });

  it("ignores the pseudo filesystems, which are dozens and hold nothing", async () => {
    const { helper } = await fixture();
    const { locations } = await helper.discover();
    expect(locations.some((location) => location.root.startsWith("/run/lock"))).toBe(false);
  });
});

describe("restoring from a discovered drive", () => {
  it("refuses a path the browser made up", async () => {
    const { helper } = await fixture();
    // `root` reaches the server as a string from a page. Only a location this process can find
    // again for itself is allowed — otherwise a chosen path is a way to read any file on the box.
    await expect(helper.internals.resolveDiscovered("/etc", "machine-snapshot-20260820T020000Z-abcdef12.tar.gz"))
      .rejects.toThrow(/no longer mounted|no longer has snapshots/);
  });

  it("refuses an artifact that is not on the drive it names", async () => {
    const { helper, paths } = await fixture();
    const mirror = path.join(paths.rescueRoot, "boxpilot-local-mirror", "machine-snapshots");
    await mkdir(mirror, { recursive: true });
    await writeFile(path.join(mirror, "machine-snapshot-20260820T020000Z-abcdef12.tar.gz"), "archive-bytes");
    await expect(helper.internals.resolveDiscovered(mirror, "machine-snapshot-20260101T000000Z-99999999.tar.gz"))
      .rejects.toThrow(/not on that drive/);
  });

  it("resolves one that is really there", async () => {
    const { helper, paths } = await fixture();
    const mirror = path.join(paths.rescueRoot, "boxpilot-local-mirror", "machine-snapshots");
    await mkdir(mirror, { recursive: true });
    await writeFile(path.join(mirror, "machine-snapshot-20260820T020000Z-abcdef12.tar.gz"), "archive-bytes");
    const resolved = await helper.internals.resolveDiscovered(mirror, "machine-snapshot-20260820T020000Z-abcdef12.tar.gz");
    expect(resolved.artifactPath).toBe(path.join(path.resolve(mirror), "machine-snapshot-20260820T020000Z-abcdef12.tar.gz"));
  });
});
