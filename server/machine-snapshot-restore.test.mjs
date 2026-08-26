import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fixedRun } from "./exec.mjs";
import { createMachineSnapshotHelper } from "./machine-snapshot-helper.mjs";

const directories = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((d) => rm(d, { recursive: true, force: true }))); });
const sha = (text) => createHash("sha256").update(text).digest("hex");
const artifact = "machine-snapshot-20260821T020000Z-abcdef12.tar.gz";

/** Build a snapshot archive the way create() lays it out, with a manifest file inventory. */
async function buildSnapshot(root, { appId = "demo", withEnv = true } = {}) {
  const staging = path.join(root, "staging");
  const files = {
    [`apps/${appId}/compose.yaml`]: "services: {}\n",
    [`apps/${appId}/boxpilot.json`]: JSON.stringify({ id: appId, installed: true, values: { ports: { web: 9090 }, env: {}, volumes: {} } }),
    [`apps/${appId}/backups.json`]: JSON.stringify({ id: appId, backups: [{ artifact: "20260821T010000Z.tar.gz", sizeBytes: 10 }] }),
    "system/fstab": "# fstab\n",
    "vms/dev-1.xml": "<domain/>\n",
  };
  if (withEnv) files[`apps/${appId}/.env`] = "ADMIN_PASSWORD=keep-me\n";
  for (const [relative, content] of Object.entries(files)) { await mkdir(path.dirname(path.join(staging, relative)), { recursive: true }); await writeFile(path.join(staging, relative), content); }
  const manifest = { schemaVersion: 1, createdAt: "2026-08-21T02:00:00.000Z", contents: { apps: [{ id: appId, installed: true, projectFiles: 3, backups: 1 }], system: { fstab: true }, vms: { domains: ["dev-1"], available: true } }, files: Object.entries(files).map(([p, c]) => ({ path: p, sha256: sha(c) })) };
  await writeFile(path.join(staging, "manifest.json"), JSON.stringify(manifest));
  const snapshotRoot = path.join(root, "snapshots"); await mkdir(snapshotRoot, { recursive: true });
  const result = await fixedRun("tar", ["-czf", path.join(snapshotRoot, artifact), "-C", staging, "."]);
  if (!result.ok) throw new Error(result.stderr);
  // The checksum beside the archive is what a restore verifies against; a real snapshot always has one.
  await writeFile(path.join(snapshotRoot, `${artifact}.meta.json`), JSON.stringify({ schemaVersion: 1, artifact, checksumSha256: sha(await readFile(path.join(snapshotRoot, artifact))), createdAt: "2026-08-21T02:00:00.000Z" }));
  await rm(staging, { recursive: true, force: true });
  return snapshotRoot;
}

describe("machine snapshot restore", () => {
  it("lists sources, describes a snapshot, and rehydrates apps through the deployer with data from the mirror", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "boxpilot-restore-")); directories.push(root);
    const snapshotRoot = await buildSnapshot(root);
    const catalogRoot = path.join(root, "catalog"); const backupRoot = path.join(root, "backups", "catalog"); const mount = path.join(root, "mount");
    await mkdir(path.join(mount, "boxpilot-local-mirror", "application-backups", "demo"), { recursive: true });
    await writeFile(path.join(mount, "boxpilot-local-mirror", "application-backups", "demo", "20260821T010000Z.tar.gz"), "archive");
    const run = vi.fn(async (binary, args, options) => {
      if (binary.endsWith("findmnt")) return { ok: true, stdout: JSON.stringify({ filesystems: [{ target: mount, source: "/dev/sdb1", fstype: "ext4" }] }), stderr: "" };
      return fixedRun(binary, args, options);
    });
    const helper = createMachineSnapshotHelper({ run, snapshotRoot, catalogRoot, applicationBackupRoot: backupRoot, mountRoot: mount, controllerBackups: {}, requireIndependentDevice: false, now: () => new Date("2026-08-21T03:00:00.000Z") });

    const sources = await helper.sources();
    expect(sources.sources.find((entry) => entry.source === "local").snapshots).toEqual([expect.objectContaining({ artifact })]);
    expect(sources.sources.find((entry) => entry.source === "mirror").available).toBe(true);

    const described = await helper.describe({ source: "local", artifact });
    expect(described).toMatchObject({ createdAt: "2026-08-21T02:00:00.000Z", apps: [{ id: "demo", installed: true, newestBackup: "20260821T010000Z.tar.gz", dataAvailable: true, dataLocation: "mirror" }], vms: { domains: ["dev-1"] } });
    await expect(helper.describe({ source: "local", artifact: "machine-snapshot-20260821T020000Z-00000000.tar.gz" })).rejects.toThrow("not found");
    await expect(helper.describe({ source: "usb", artifact })).rejects.toThrow("local, mirror, or a drive BoxPilot found");

    const installed = new Map();
    const apps = {
      internals: { readState: async (id) => installed.get(id) ?? null },
      install: vi.fn(async ({ id, values }) => { installed.set(id, { installed: true, values }); return { installed: true }; }),
      restoreAppBackup: vi.fn(async ({ id, backup }) => ({ restored: true, id, backup })),
    };
    const progress = vi.fn();
    const result = await helper.restore({ source: "local", artifact, apps: "all", restoreData: true }, { apps, progress });
    expect(result).toMatchObject({ restored: 1, failed: 0, apps: [{ id: "demo", installed: true, dataRestored: true, error: null }], system: { applied: false }, vms: [{ name: "dev-1", defined: false }] });
    expect(apps.install).toHaveBeenCalledWith({ id: "demo", values: { ports: { web: 9090 }, env: {}, volumes: {} } }, expect.anything());
    expect(await readFile(path.join(catalogRoot, "demo", ".env"), "utf8")).toBe("ADMIN_PASSWORD=keep-me\n"); // secrets restored before install
    expect(JSON.parse(await readFile(path.join(catalogRoot, "demo", "boxpilot.json"), "utf8"))).toMatchObject({ installed: false, restoredFrom: artifact }); // pre-install state, deployer flips it
    expect(await readdir(path.join(backupRoot, "demo"))).toContain("20260821T010000Z.tar.gz"); // pulled from the mirror
    expect(apps.restoreAppBackup).toHaveBeenCalledWith({ id: "demo", backup: "20260821T010000Z.tar.gz" }, expect.anything());
    expect(await readFile(path.join(result.system.stagedAt, "fstab"), "utf8")).toBe("# fstab\n");
    expect(await readdir(snapshotRoot)).not.toContainEqual(expect.stringMatching(/^\.restore-/));

    // Second run: app already installed → recorded as a per-app error, nothing else breaks.
    const again = await helper.restore({ source: "local", artifact, apps: ["demo"] }, { apps, progress });
    expect(again.apps[0]).toMatchObject({ installed: false, error: expect.stringContaining("already installed") });
  });

  it("refuses a snapshot whose contents fail verification", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "boxpilot-restore-")); directories.push(root);
    const snapshotRoot = await buildSnapshot(root);
    await writeFile(path.join(snapshotRoot, `${artifact}.meta.json`), JSON.stringify({ checksumSha256: "0".repeat(64) }));
    const helper = createMachineSnapshotHelper({ snapshotRoot, catalogRoot: path.join(root, "catalog"), applicationBackupRoot: path.join(root, "b"), mountRoot: path.join(root, "m"), controllerBackups: {}, requireIndependentDevice: false });
    await expect(helper.restore({ source: "local", artifact }, { apps: { internals: { readState: async () => null }, install: vi.fn(), restoreAppBackup: vi.fn() } })).rejects.toThrow("checksum");
  });

  it("restores from a drive it merely found, which is the case a rebuilt server is in", async () => {
    // A server that has just been reinstalled has no snapshots of its own and no mirror configured,
    // because what described the mirror was on the disk that died. All it has is a drive somebody
    // mounted. This is that path end to end, not just the lookup.
    const root = await mkdtemp(path.join(os.tmpdir(), "boxpilot-restore-")); directories.push(root);
    const drive = path.join(root, "drive", "boxpilot-local-mirror", "machine-snapshots");
    await mkdir(drive, { recursive: true });
    const built = await buildSnapshot(root);
    for (const name of await readdir(built)) await writeFile(path.join(drive, name), await readFile(path.join(built, name)));
    await rm(built, { recursive: true, force: true });

    const catalogRoot = path.join(root, "catalog");
    const run = vi.fn(async (binary, args, options) => {
      if (binary === "/usr/bin/findmnt" && !args.includes("--mountpoint")) {
        return { ok: true, stdout: JSON.stringify({ filesystems: [{ target: path.join(root, "drive"), source: "/dev/sdb1", fstype: "exfat" }] }) };
      }
      if (binary === "/usr/bin/findmnt") return { ok: false, stdout: "", stderr: "not mounted" };
      return fixedRun(binary, args, options);
    });
    const helper = createMachineSnapshotHelper({
      snapshotRoot: path.join(root, "empty-snapshots"), catalogRoot,
      applicationBackupRoot: path.join(root, "backups"), controllerBackupRoot: path.join(root, "controller"),
      mountRoot: path.join(root, "not-mounted"), findmntBinary: "/usr/bin/findmnt", run,
    });

    const { locations } = await helper.discover();
    expect(locations).toHaveLength(1);
    expect(locations[0].mount).toMatchObject({ source: "/dev/sdb1", filesystem: "exfat" });

    const described = await helper.describe({ source: "discovered", root: locations[0].root, artifact });
    expect(described.apps.map((app) => app.id)).toEqual(["demo"]);

    const installed = new Map();
    const apps = {
      internals: { readState: async (id) => installed.get(id) ?? null },
      install: vi.fn(async ({ id, values }) => { installed.set(id, { installed: true, values }); return { installed: true }; }),
      restoreAppBackup: vi.fn(async () => ({ restored: true })),
    };
    const result = await helper.restore({ source: "discovered", root: locations[0].root, artifact, apps: "all", restoreData: false }, { apps });
    expect(result).toMatchObject({ restored: 1, failed: 0 });
    // The secrets have to land before the app is installed, or it comes up with generated ones.
    expect(await readFile(path.join(catalogRoot, "demo", ".env"), "utf8")).toBe("ADMIN_PASSWORD=keep-me\n");
  });

  it("will not restore from a path nobody found", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "boxpilot-restore-")); directories.push(root);
    const snapshotRoot = await buildSnapshot(root);
    const helper = createMachineSnapshotHelper({
      snapshotRoot, catalogRoot: path.join(root, "catalog"), applicationBackupRoot: path.join(root, "b"),
      mountRoot: path.join(root, "m"), run: async () => ({ ok: false, stdout: "", stderr: "no mounts" }),
    });
    // The browser picks from what discovery returned; a path of its own choosing is not a source.
    await expect(helper.restore({ source: "discovered", root: snapshotRoot, artifact }, { apps: { internals: { readState: async () => null }, install: vi.fn(), restoreAppBackup: vi.fn() } }))
      .rejects.toThrow(/no longer mounted|no longer has snapshots/);
  });

  it("makes what a restore staged reviewable, and discardable once reviewed", async () => {
    // The restore deliberately stages system config instead of applying it. That was a fiction
    // until now: the staged copies sat in a root-only directory nothing displayed, so "review"
    // meant knowing the path and having a root shell. This is the reader and the cleanup.
    const root = await mkdtemp(path.join(os.tmpdir(), "boxpilot-restore-")); directories.push(root);
    const snapshotRoot = await buildSnapshot(root);
    const helper = createMachineSnapshotHelper({ snapshotRoot, catalogRoot: path.join(root, "catalog"), applicationBackupRoot: path.join(root, "b"), mountRoot: path.join(root, "m"), controllerBackups: {}, requireIndependentDevice: false, now: () => new Date("2026-08-21T03:00:00.000Z") });
    const apps = { internals: { readState: async () => null }, install: vi.fn(async () => ({ installed: true })), restoreAppBackup: vi.fn(async () => ({ restored: true })) };
    await helper.restore({ source: "local", artifact, apps: [], restoreData: false }, { apps });

    const { restores } = await helper.listRestores();
    expect(restores).toHaveLength(1);
    expect(restores[0].name).toBe("20260821T030000Z");
    const fstab = restores[0].files.find((file) => file.path === "system/fstab");
    // The content is right there, which is the whole point: reviewable in a browser, not a shell.
    expect(fstab).toMatchObject({ area: "system", content: "# fstab\n" });
    expect(restores[0].files.some((file) => file.path === "vms/dev-1.xml")).toBe(true);

    await helper.discardRestore({ name: "20260821T030000Z" });
    expect((await helper.listRestores()).restores).toEqual([]);
  });

  it("refuses to discard anything that is not a restore review directory", async () => {
    // This is the one deletion in the snapshot tree that takes a name from the browser.
    const root = await mkdtemp(path.join(os.tmpdir(), "boxpilot-restore-")); directories.push(root);
    const snapshotRoot = await buildSnapshot(root);
    const helper = createMachineSnapshotHelper({ snapshotRoot, catalogRoot: path.join(root, "c"), applicationBackupRoot: path.join(root, "b"), mountRoot: path.join(root, "m"), controllerBackups: {}, requireIndependentDevice: false, now: () => new Date("2026-08-21T03:00:00.000Z") });
    await expect(helper.discardRestore({ name: "../../" + path.basename(snapshotRoot) })).rejects.toThrow(/not a restore review/);
    await expect(helper.discardRestore({ name: ".." })).rejects.toThrow(/not a restore review/);
    await expect(helper.discardRestore({ name: "20990101T000000Z" })).rejects.toThrow(/no longer there/);
    // and the snapshots themselves are still where they were
    expect((await helper.sources()).sources.find((entry) => entry.source === "local").snapshots).toHaveLength(1);
  });
});
