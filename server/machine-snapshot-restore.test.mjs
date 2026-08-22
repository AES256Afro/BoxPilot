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
    await expect(helper.describe({ source: "usb", artifact })).rejects.toThrow("local or mirror");

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
});
