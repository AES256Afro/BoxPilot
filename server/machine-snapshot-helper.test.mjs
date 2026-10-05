import { createHash } from "node:crypto";
import {chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { onWindows, testTar } from "../test/platform.mjs";
import { fixedRun } from "./exec.mjs";
import { createMachineSnapshotHelper } from "./machine-snapshot-helper.mjs";
import { hostBackupOperations } from "./ops/host-backup.mjs";

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
    // A share on x-systemd.automount that has gone idle: only the autofs door remains in the table.
    idleShareRoot: path.join(root, "idle-share"),
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
  await mkdir(path.join(paths.idleShareRoot, "machine-snapshots"), { recursive: true });

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
      // Discovery reads the whole table (autofs included); the mirror check asks about one mountpoint.
      if (!args.includes("--mountpoint")) {
        return { ok: true, stdout: JSON.stringify({ filesystems: [
          { target: "/", source: "/dev/mapper/root", fstype: "ext4", children: [{ target: paths.rescueRoot, source: "//nas/backups", fstype: "cifs" }] },
          { target: "/run/lock", source: "tmpfs", fstype: "tmpfs" },
          { target: paths.idleShareRoot, source: "systemd-1", fstype: "autofs" },
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
    tarBinary: testTar,
    requireIndependentDevice: false,
    keep: 2,
    now: () => new Date("2026-08-21T02:00:00.000Z"),
  });
  return { helper, paths, controllerBackups, run };
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

/**
 * A snapshot archive laid out the way create() lays one out, written with a real tar: what an older
 * release left on disk. `files` are the members besides manifest.json, which lists them.
 */
async function archiveSnapshot(root, artifact, { apps, files }) {
  const staging = await mkdtemp(path.join(os.tmpdir(), "boxpilot-old-snapshot-"));
  directories.push(staging);
  for (const [relative, body] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(staging, relative)), { recursive: true });
    await writeFile(path.join(staging, relative), body);
  }
  const inventory = Object.entries(files).map(([relative, body]) => ({ path: relative, sha256: createHash("sha256").update(body).digest("hex") }));
  await writeFile(path.join(staging, "manifest.json"), JSON.stringify({ schemaVersion: 1, createdAt: "2026-08-20T02:00:00.000Z", contents: { apps, system: null, vms: null }, files: inventory }));
  await mkdir(root, { recursive: true });
  const made = await fixedRun(testTar, ["-czf", path.join(root, artifact), "-C", staging, "."]);
  if (!made.ok) throw new Error(made.stderr);
  await writeFile(path.join(root, `${artifact}.meta.json`), JSON.stringify({ artifact, createdAt: "2026-08-20T02:00:00.000Z", checksumSha256: createHash("sha256").update(await readFile(path.join(root, artifact))).digest("hex") }));
}

describe("machine snapshot helper", () => {
  // Linux only: needs /usr/bin/tar.
  it.skipIf(onWindows)("assembles one verified secret-bearing archive from every live evidence family", async () => {
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

  // Linux only: needs /usr/bin/tar.
  it.skipIf(onWindows)("rejects malformed snapshot ids and keeps only the newest snapshots", async () => {
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

  // Linux only: needs /usr/bin/tar.
  it.skipIf(onWindows)("mirrors the local backup roots onto the mount with hash verification and no deletes", async () => {
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

  it("leaves a snapshot's or a restore's working folders out of the mirror", async () => {
    const { helper, paths } = await fixture();
    // What a crashed snapshot or restore can leave behind, and what a restore stages for review:
    // each holds the controller database and every app's .env in the clear.
    const name = "machine-snapshot-20260821T020000Z-11111111.tar.gz";
    for (const [relative, body] of [
      [name, "archive"],
      [`${name}.meta.json`, "{}"],
      [`.staging-${snapshotId}/apps/uptime-kuma/.env`, "ADMIN_TOKEN=do-not-lose\n"],
      [`.restore-${snapshotId}/controller/boxpilot.sqlite3`, "sqlite"],
      ["restored/20260821T020000Z/controller/boxpilot.sqlite3", "sqlite"],
    ]) {
      await mkdir(path.dirname(path.join(paths.snapshotRoot, relative)), { recursive: true });
      await writeFile(path.join(paths.snapshotRoot, relative), body);
    }
    const result = await helper.sync();
    expect(await readdir(path.join(result.destination, "machine-snapshots"))).toEqual([name, `${name}.meta.json`]);
  });

  it("leaves an app backup still being written out of the mirror", async () => {
    // A backup writes `<stamp>.tar.gz.partial` and renames it once whole. Copied mid-write it was kept
    // forever, a truncated archive beside the real one; renamed or grown mid-copy, the sync died.
    const { helper, paths } = await fixture();
    const partial = path.join(paths.applicationBackupRoot, "uptime-kuma", "20260821T015959Z.tar.gz.partial");
    await writeFile(partial, "half an archive");
    const result = await helper.sync();
    expect(await readdir(path.join(result.destination, "application-backups", "uptime-kuma"))).toEqual(["20260816T030000Z.tar.gz"]);
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

  // Linux only: needs /usr/bin/tar.
  it.skipIf(onWindows)("refuses an archive whose checksum file is missing, before touching anything", async () => {
    const { helper, paths } = await fixture();
    const created = await helper.create({ snapshotId });
    await rm(`${created.artifactPath}.meta.json`);
    await writeFile(path.join(paths.catalogRoot, "uptime-kuma", "boxpilot.json"), JSON.stringify({ id: "uptime-kuma", installed: false }));
    const apps = deployer(paths);
    await expect(helper.restore({ source: "local", artifact: created.artifact }, { apps })).rejects.toThrow(/cannot be verified/);
    expect(apps.calls.install).toBe(0);
  });

  it("refuses a snapshot whose manifest names an application outside the catalog", async () => {
    const { paths, controllerBackups } = await fixture();
    const artifact = "machine-snapshot-20260821T020000Z-11111111.tar.gz";
    await mkdir(paths.snapshotRoot, { recursive: true });
    await writeFile(path.join(paths.snapshotRoot, artifact), "crafted");
    await writeFile(path.join(paths.snapshotRoot, `${artifact}.meta.json`), JSON.stringify({ checksumSha256: createHash("sha256").update("crafted").digest("hex") }));
    // What the crafted archive unpacks to: a manifest whose app id climbs out of the catalog, which
    // the restore would otherwise create and write into as root.
    const run = vi.fn(async (_binary, args) => {
      if (args[0] !== "-xzf" || !args.includes("-C")) return { ok: false, stdout: "", stderr: "unexpected" };
      await writeFile(path.join(args[args.indexOf("-C") + 1], "manifest.json"), JSON.stringify({ contents: { apps: [{ id: "../escaped", installed: true }] }, files: [] }));
      return { ok: true, stdout: "", stderr: "" };
    });
    const helper = createMachineSnapshotHelper({ run, controllerBackups, ...paths, requireIndependentDevice: false, now: () => new Date("2026-08-21T02:00:00.000Z") });
    const apps = { internals: { readState: vi.fn(async () => null) }, install: vi.fn(async () => {}), restoreAppBackup: vi.fn(async () => {}) };
    await expect(helper.restore({ source: "local", artifact }, { apps })).rejects.toThrow(/not a valid application id/);
    await expect(stat(path.join(paths.catalogRoot, "..", "escaped"))).rejects.toThrow();
    expect(apps.install).not.toHaveBeenCalled();
  });

  // Linux only: needs /usr/bin/tar.
  it.skipIf(onWindows)("picks up where an interrupted restore stopped instead of starting over", async () => {
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

  // R3B3-1: a restore that failed, or whose safety copy did, leaves `<id>.replaced` beside the app
  // with a boxpilot.json in it, and every snapshot since listed that as an installed app. The Restore
  // tab ticks every installed app, and the restore was then refused for a name that is no app id.
  it("leaves a restore's leftover folders out of a snapshot, and stops offering them from an older one", async () => {
    const { helper, paths } = await fixture();
    for (const leftover of ["uptime-kuma.replaced", "uptime-kuma.restoring"]) {
      await mkdir(path.join(paths.catalogRoot, leftover), { recursive: true });
      await writeFile(path.join(paths.catalogRoot, leftover, "boxpilot.json"), JSON.stringify({ id: "uptime-kuma", installed: true }));
    }
    const created = await helper.create({ snapshotId });
    expect(created.contents.apps.map((app) => app.id)).toEqual(["uptime-kuma"]);

    // One an earlier release took, with the leftover in it as an installed app.
    const older = "machine-snapshot-20260820T020000Z-abcdef12.tar.gz";
    const state = JSON.stringify({ id: "uptime-kuma", installed: true, values: { ports: {}, env: {}, volumes: {} } });
    await archiveSnapshot(paths.snapshotRoot, older, {
      apps: [{ id: "uptime-kuma", installed: true, projectFiles: 2, backups: 1 }, { id: "uptime-kuma.replaced", installed: true, projectFiles: 1, backups: 0 }],
      files: {
        "apps/uptime-kuma/boxpilot.json": state,
        "apps/uptime-kuma/.env": "ADMIN_TOKEN=do-not-lose\n",
        "apps/uptime-kuma/backups.json": JSON.stringify({ id: "uptime-kuma", backups: [{ artifact: "20260816T030000Z.tar.gz" }] }),
        "apps/uptime-kuma.replaced/boxpilot.json": state,
        "apps/uptime-kuma.replaced/backups.json": JSON.stringify({ id: "uptime-kuma.replaced", backups: [] }),
      },
    });
    const described = await helper.describe({ source: "local", artifact: older });
    expect(described.apps.map((app) => app.id)).toEqual(["uptime-kuma"]);

    // What the Restore tab sends, every installed app the snapshot describes, is what the operation takes.
    const chosen = described.apps.filter((app) => app.installed).map((app) => app.id);
    const operation = hostBackupOperations().find((entry) => entry.id === "host.snapshot.restore");
    expect(operation.parameters.fields.apps.validate(chosen)).toBeNull();
    await writeFile(path.join(paths.catalogRoot, "uptime-kuma", "boxpilot.json"), JSON.stringify({ id: "uptime-kuma", installed: false }));
    const restored = await helper.restore({ source: "local", artifact: older, apps: chosen, restoreData: false }, { apps: deployer(paths) });
    expect(restored).toMatchObject({ restored: 1, failed: 0, apps: [{ id: "uptime-kuma", installed: true, error: null }] });
    expect(await readFile(path.join(paths.catalogRoot, "uptime-kuma", ".env"), "utf8")).toBe("ADMIN_TOKEN=do-not-lose\n");
  });

  /** A deployer that records which data archive it was asked to restore. */
  const recordingDeployer = (paths) => {
    const restoredFrom = [];
    return {
      restoredFrom,
      internals: { readState: async (id) => readFile(path.join(paths.catalogRoot, id, "boxpilot.json"), "utf8").then(JSON.parse).catch(() => null) },
      install: async ({ id }) => { await writeFile(path.join(paths.catalogRoot, id, "boxpilot.json"), JSON.stringify({ id, installed: true })); return { installed: true, id, exposure: "lan", hostPorts: [] }; },
      restoreAppBackup: async ({ id, backup }) => { restoredFrom.push(`${id}/${backup}`); return { restored: true, id, backup }; },
    };
  };

  // R3B3-5: a server rebuilt from an old backup drive found the snapshot there, and looked for each
  // app's data only in its own (empty) store and the mirror it no longer had configured: every app
  // came back empty, with the archives sitting beside the snapshot on the same drive.
  it("takes each app's data from beside a snapshot found on a drive", async () => {
    const { helper, paths } = await fixture({ mounted: false });
    const created = await helper.create({ snapshotId });
    const drive = path.join(paths.rescueRoot, "boxpilot-local-mirror");
    for (const name of [created.artifact, `${created.artifact}.meta.json`]) await writeFile(path.join(drive, "machine-snapshots", name), await readFile(path.join(paths.snapshotRoot, name)));
    await mkdir(path.join(drive, "application-backups", "uptime-kuma"), { recursive: true });
    await writeFile(path.join(drive, "application-backups", "uptime-kuma", "20260816T030000Z.tar.gz"), "app-backup-bytes");
    // The rebuilt server: none of this machine's own snapshots or backups, and the app not installed.
    await rm(paths.snapshotRoot, { recursive: true, force: true });
    await rm(paths.applicationBackupRoot, { recursive: true, force: true });
    await rm(path.join(paths.catalogRoot, "uptime-kuma"), { recursive: true, force: true });

    const { locations } = await helper.discover();
    const found = locations.find((location) => location.root === path.resolve(drive, "machine-snapshots"));
    expect(found).toBeTruthy();
    const described = await helper.describe({ source: "discovered", root: found.root, artifact: created.artifact });
    expect(described.apps).toEqual([expect.objectContaining({ id: "uptime-kuma", newestBackup: "20260816T030000Z.tar.gz", dataAvailable: true, dataLocation: "drive" })]);

    const apps = recordingDeployer(paths);
    const result = await helper.restore({ source: "discovered", root: found.root, artifact: created.artifact, apps: ["uptime-kuma"] }, { apps });
    expect(result.apps).toEqual([expect.objectContaining({ id: "uptime-kuma", installed: true, dataRestored: true, error: null })]);
    expect(apps.restoredFrom).toEqual(["uptime-kuma/20260816T030000Z.tar.gz"]);
    // Copied into this server's own store first, where the deployer restores from.
    expect(await readFile(path.join(paths.applicationBackupRoot, "uptime-kuma", "20260816T030000Z.tar.gz"), "utf8")).toBe("app-backup-bytes");
  });

  // R3B3-8: an app backup's keep-N pruning removed the archive a snapshot restores from.
  it("restores the newest archive there is when the one the snapshot named is gone, and says so", async () => {
    const { helper, paths } = await fixture();
    const created = await helper.create({ snapshotId });
    await rm(path.join(paths.applicationBackupRoot, "uptime-kuma", "20260816T030000Z.tar.gz"));
    await writeFile(path.join(paths.applicationBackupRoot, "uptime-kuma", "20260817T030000Z.tar.gz"), "newer-backup-bytes");
    await writeFile(path.join(paths.catalogRoot, "uptime-kuma", "boxpilot.json"), JSON.stringify({ id: "uptime-kuma", installed: false }));

    const described = await helper.describe({ source: "local", artifact: created.artifact });
    expect(described.apps[0]).toMatchObject({ newestBackup: "20260816T030000Z.tar.gz", dataAvailable: true, dataArchive: "20260817T030000Z.tar.gz" });
    const apps = recordingDeployer(paths);
    const result = await helper.restore({ source: "local", artifact: created.artifact }, { apps });
    expect(apps.restoredFrom).toEqual(["uptime-kuma/20260817T030000Z.tar.gz"]);
    const warning = "The data archive this snapshot names, 20260816T030000Z.tar.gz, is no longer there, so its data came from 20260817T030000Z.tar.gz, the newest one there is.";
    expect(result.apps[0]).toMatchObject({ dataRestored: true, error: null, warnings: [warning] });
    expect(result.warnings).toEqual([`uptime-kuma: ${warning}`]);
  });

  // R3B3-4: only the app.install operation published a tailnet-only app with Tailscale Serve; a
  // snapshot restore called the deployer directly, so Zulip came back "installed" and unreachable.
  it("publishes a tailnet-only app it brings back with Tailscale Serve, as an install does", async () => {
    const { helper, paths } = await fixture();
    const created = await helper.create({ snapshotId });
    const notInstalled = () => writeFile(path.join(paths.catalogRoot, "uptime-kuma", "boxpilot.json"), JSON.stringify({ id: "uptime-kuma", installed: false }));
    await notInstalled();
    const apps = {
      ...recordingDeployer(paths),
      install: async ({ id }) => {
        await writeFile(path.join(paths.catalogRoot, id, "boxpilot.json"), JSON.stringify({ id, installed: true }));
        return { installed: true, id, name: "Uptime Kuma", exposure: "tailnet", hostPorts: [{ id: "web", host: 3001, protocol: "tcp", exposure: "loopback", tailnet: "serve" }] };
      },
    };
    const serving = JSON.stringify({ Web: { "homebox.tail1234.ts.net:3001": { Handlers: { "/": { Proxy: "http://127.0.0.1:3001" } } } } });
    const run = vi.fn(async (_binary, args) => (args[1] === "status" ? { ok: true, stdout: serving, stderr: "" } : { ok: true, stdout: "", stderr: "" }));
    const operation = hostBackupOperations().find((entry) => entry.id === "host.snapshot.restore");
    const parameters = { source: "local", artifact: created.artifact, apps: ["uptime-kuma"], restoreData: false };
    const result = await operation.run(parameters, { machineSnapshot: helper, apps, run, progress: () => {} });
    expect(run).toHaveBeenCalledWith(expect.stringContaining("tailscale"), ["serve", "--bg", "--yes", "--https=3001", "http://127.0.0.1:3001"], expect.anything());
    expect(result.apps[0]).toMatchObject({ installed: true, error: null, urls: ["https://homebox.tail1234.ts.net:3001"], warnings: [] });
    expect(result.warnings).toBeUndefined();

    // Serve failing leaves the app restored, and the job says how to publish it.
    await notInstalled();
    run.mockImplementation(async (_binary, args) => (args[1] === "--bg" ? { ok: false, stdout: "", stderr: "serve: Tailscale is stopped" } : { ok: true, stdout: "{}", stderr: "" }));
    const again = await operation.run(parameters, { machineSnapshot: helper, apps, run, progress: () => {} });
    expect(again.apps[0]).toMatchObject({ installed: true, error: null });
    expect(again.warnings).toEqual([expect.stringMatching(/^uptime-kuma: Uptime Kuma is installed for your tailnet only, but publishing it with Tailscale Serve failed \(3001: serve: Tailscale is stopped\)\..*choose Publish on the tailnet\.$/)]);
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

  it("probes an idle automounted share, which is a door and not a pseudo filesystem", async () => {
    // BoxPilot's own share mounting uses x-systemd.automount, so an idle share is not in the
    // mount table: an autofs entry stands where it was, and reading the path brings it back.
    // Discovery used findmnt --real, which hides autofs, so it could not see the drives the
    // product itself mounts. Three snapshots on a live NAS reported as none, from idleness alone.
    const { helper, paths } = await fixture();
    await plant(path.join(paths.idleShareRoot, "machine-snapshots"), "machine-snapshot-20260819T010000Z-0ddba11a.tar.gz");
    const { locations } = await helper.discover();
    const found = locations.find((location) => location.mount.target === paths.idleShareRoot);
    expect(found, `expected the autofs mount among ${locations.map((l) => l.mount.target).join(", ")}`).toBeTruthy();
    expect(found.mount.filesystem).toBe("autofs");
    // "systemd-1" is what the kernel calls the door; the owner knows the drive by its path.
    expect(found.mount.source).toBe(paths.idleShareRoot);
    expect(found.snapshots[0].artifact).toBe("machine-snapshot-20260819T010000Z-0ddba11a.tar.gz");
  });

  // Linux only: chmod 000 must make a folder unreadable.
  it.skipIf(onWindows)("tells a drive that did not answer apart from a drive with nothing on it", async () => {
    // A soft network mount mid-hiccup errors the read; the first version reported that as "no
    // snapshots found", which is an invented all-clear delivered to someone mid-rebuild. Seen
    // live: the same CIFS mount answered three snapshots on one read and an error on the one before.
    const { helper, paths } = await fixture();
    const mirror = path.join(paths.rescueRoot, "boxpilot-local-mirror", "machine-snapshots");
    await mkdir(mirror, { recursive: true });
    await chmod(mirror, 0o000);
    try {
      const { locations, unanswered } = await helper.discover();
      expect(locations.some((location) => location.root.startsWith(path.resolve(paths.rescueRoot)))).toBe(false);
      expect(unanswered).toEqual([expect.objectContaining({ source: "//nas/backups", error: "EACCES" })]);
    } finally {
      await chmod(mirror, 0o755);
    }
  });

  it("does not cry unanswered over a drive that merely lacks the folders", async () => {
    const { helper } = await fixture();
    const { unanswered } = await helper.discover();
    expect(unanswered).toEqual([]);
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

// R2B3-6: tar wrote straight to the snapshot's own name, so a disk that filled part-way left half an
// archive that was listed, mirrored off the box, and took one of the retention slots.
describe("a machine snapshot archive while it is being written", () => {
  const fakeTar = (run, { fail = false } = {}) => {
    const original = run.getMockImplementation();
    const written = [];
    run.mockImplementation(async (binary, args, options) => {
      if (args[0] !== "-czf") return original(binary, args, options);
      written.push(args[1]);
      await writeFile(args[1], fail ? "half an archive" : "a whole archive");
      return fail ? { ok: false, stdout: "", stderr: "tar: Cannot write: No space left on device" } : { ok: true, stdout: "", stderr: "" };
    });
    return written;
  };

  it("leaves nothing behind when it cannot be finished", async () => {
    const { helper, paths, run } = await fixture();
    const written = fakeTar(run, { fail: true });
    await expect(helper.create({ snapshotId })).rejects.toThrow("No space left on device");
    expect(written).toEqual([path.join(paths.snapshotRoot, "machine-snapshot-20260821T020000Z-11111111.tar.gz.partial")]);
    expect(await readdir(paths.snapshotRoot)).toEqual([]);
    expect((await helper.inspect()).snapshots).toEqual([]);
  });

  it("takes its name only once it is whole and described", async () => {
    const { helper, paths, run } = await fixture();
    fakeTar(run);
    const result = await helper.create({ snapshotId });
    expect(result.artifactPath).toBe(path.join(paths.snapshotRoot, "machine-snapshot-20260821T020000Z-11111111.tar.gz"));
    expect(await readFile(result.artifactPath, "utf8")).toBe("a whole archive");
    expect(result.checksumSha256).toBe(createHash("sha256").update("a whole archive").digest("hex"));
    expect((await readdir(paths.snapshotRoot)).sort()).toEqual([result.artifact, `${result.artifact}.meta.json`]);
    expect((await helper.inspect()).snapshots).toEqual([expect.objectContaining({ artifact: result.artifact, checksumSha256: result.checksumSha256 })]);
  });

  // R3B3-7: a power cut during a snapshot or a restore left the half-written archive, the folder it
  // was assembled in and the one a restore unpacked into, for good: an unencrypted copy of the
  // controller database and every app's .env that nothing ever read again.
  it("is swept away when the helper starts after a snapshot or a restore was cut off", async () => {
    const { helper, paths } = await fixture();
    const whole = "machine-snapshot-20260820T020000Z-22222222.tar.gz";
    const cut = "machine-snapshot-20260821T020000Z-11111111.tar.gz";
    const restoreId = "33333333-3333-4333-8333-333333333333";
    for (const [relative, body] of [
      [whole, "a whole archive"], [`${whole}.meta.json`, "{}"],
      [`${cut}.partial`, "half an archive"], [`${cut}.meta.json`, "{}"],
      [`.staging-${snapshotId}/controller/boxpilot.sqlite3`, "sqlite"],
      [`.staging-${snapshotId}/apps/uptime-kuma/.env`, "ADMIN_TOKEN=do-not-lose\n"],
      [`.restore-${restoreId}/apps/uptime-kuma/.env`, "ADMIN_TOKEN=do-not-lose\n"],
      ["restored/20260821T030000Z/system/fstab", "# fstab\n"],
    ]) {
      await mkdir(path.dirname(path.join(paths.snapshotRoot, relative)), { recursive: true });
      await writeFile(path.join(paths.snapshotRoot, relative), body);
    }
    const swept = await helper.sweepInterrupted();
    expect(swept.removed.sort()).toEqual([`.restore-${restoreId}`, `.staging-${snapshotId}`, `${cut}.meta.json`, `${cut}.partial`].sort());
    // A finished snapshot and what a finished restore staged for review stay.
    expect((await readdir(paths.snapshotRoot)).sort()).toEqual([whole, `${whole}.meta.json`, "restored"]);
    await expect(helper.sweepInterrupted()).resolves.toEqual({ removed: [] });
  });
});