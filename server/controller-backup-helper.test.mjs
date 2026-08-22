import { mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { createControllerBackupHelper, controllerBackupHelperInternals } from "./controller-backup-helper.mjs";
import { createStateStore } from "./state.mjs";

const directories = [];
const backupId = "11111111-1111-4111-8111-111111111111";

async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "boxpilot-controller-backup-"));
  directories.push(directory);
  const stateDirectory = path.join(directory, "state");
  const store = createStateStore({ stateDirectory });
  const bootstrap = store.createBootstrapToken();
  const owner = store.consumeBootstrapToken(bootstrap.token, { username: "operator", passwordHash: "test-hash" });
  store.createJob({ type: "controller.database.backup", title: "Controller backup", createdBy: owner.id });
  const backupRoot = path.join(directory, "managed", "backups", "boxpilot-controller");
  const restoreDrillRoot = path.join(directory, "managed", "controller-restore-drills");
  const helper = createControllerBackupHelper({ sourceDatabasePath: store.databasePath, backupRoot, restoreDrillRoot, now: () => new Date("2026-08-16T08:00:00.000Z") });
  await helper.initialize();
  return { directory, store, helper, backupRoot, restoreDrillRoot };
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("controller database backup helper", () => {
  it("captures committed WAL state and passes an isolated copy-open restore drill", async () => {
    const { store, helper, restoreDrillRoot } = await fixture();
    expect((await stat(`${store.databasePath}-wal`)).size).toBeGreaterThan(0);
    await expect(helper.inspect()).resolves.toMatchObject({
      healthy: true,
      state: "ready",
      journalAwareSnapshot: "sqlite-vacuum-into",
      boundary: { mutationPerformed: false, databaseContentReturned: false, pathAccepted: false, commandAccepted: false },
    });

    const result = await helper.createBackup({ backupId });
    expect(result).toMatchObject({
      backupId,
      applicationId: "boxpilot-controller",
      destination: "local-managed",
      downtimeMs: 0,
      consistentSnapshot: true,
      snapshotMethod: "sqlite-vacuum-into",
      sourceServiceStopped: false,
      restoreDrill: {
        passed: true,
        mode: "isolated-copy-open",
        network: "none",
        publishedPorts: 0,
        copyChecksumMatched: true,
        integrityCheck: "ok",
        foreignKeyIssues: 0,
        schemaVerified: true,
        ownerStatePresent: true,
        workspaceRemoved: true,
        productionDatabaseReplaced: false,
        serviceStarted: false,
      },
      boundary: {
        databaseContentReturned: false,
        browserPathAccepted: false,
        browserCommandAccepted: false,
        productionDatabaseChanged: false,
        serviceStopped: false,
        networkAccessRequired: false,
        independentCopyCreated: false,
        retentionPerformed: false,
      },
    });
    expect(result.checksumSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(result.manifestChecksumSha256).toMatch(/^[a-f0-9]{64}$/);
    expect((await stat(result.artifactPath)).mode & 0o777).toBe(0o600);
    expect((await stat(path.dirname(result.artifactPath))).mode & 0o777).toBe(0o700);
    await expect(stat(path.join(restoreDrillRoot, backupId))).rejects.toMatchObject({ code: "ENOENT" });
    const manifest = JSON.parse(await readFile(result.manifestPath, "utf8"));
    expect(manifest).toMatchObject({ backupId, checksumSha256: result.checksumSha256, method: "sqlite-vacuum-into", restoreDrill: { passed: true, workspaceRemoved: true } });

    const restored = new DatabaseSync(result.artifactPath, { readOnly: true });
    expect(Number(restored.prepare("SELECT COUNT(*) AS count FROM owners").get().count)).toBe(1);
    expect(Number(restored.prepare("SELECT COUNT(*) AS count FROM jobs").get().count)).toBe(1);
    expect(restored.prepare("PRAGMA integrity_check").get().integrity_check).toBe("ok");
    expect(restored.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    restored.close();
    store.close();
  });

  it("rejects a symlink source and an incomplete database without creating an artifact", async () => {
    const { directory, store, backupRoot, restoreDrillRoot } = await fixture();
    store.close();
    const linkedSource = path.join(directory, "linked.sqlite3");
    await symlink(path.join(directory, "state", "boxpilot.sqlite3"), linkedSource);
    const linked = createControllerBackupHelper({ sourceDatabasePath: linkedSource, backupRoot, restoreDrillRoot });
    await expect(linked.inspect()).resolves.toMatchObject({ healthy: false, state: "unavailable" });
    await expect(linked.createBackup({ backupId })).rejects.toThrow("real regular file");

    const incompletePath = path.join(directory, "incomplete.sqlite3");
    const incompleteDatabase = new DatabaseSync(incompletePath);
    incompleteDatabase.exec("CREATE TABLE unrelated (id TEXT PRIMARY KEY)");
    incompleteDatabase.close();
    const incomplete = createControllerBackupHelper({ sourceDatabasePath: incompletePath, backupRoot, restoreDrillRoot });
    await expect(incomplete.inspect()).resolves.toMatchObject({ healthy: false, state: "blocked", evidence: { schemaComplete: false, ownerStatePresent: false } });
    await expect(incomplete.createBackup({ backupId })).rejects.toThrow("failed fixed backup preflight");
    await expect(stat(path.join(backupRoot, backupId))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("accepts only one server-generated UUID and keeps every path helper-owned", () => {
    expect(controllerBackupHelperInternals.validateControllerBackupInput({ backupId })).toEqual([]);
    expect(controllerBackupHelperInternals.validateControllerBackupInput({ backupId, path: "/tmp/copy" })).toEqual(["Controller backup accepts only one backupId UUID"]);
    expect(controllerBackupHelperInternals.validateControllerBackupInput({ backupId: "../../etc" })).toEqual(["Controller backup accepts only one backupId UUID"]);
    expect(() => controllerBackupHelperInternals.confinedChild("/fixed/root", "../escape")).toThrow("escaped its fixed root");
  });
});

describe("local copies on the database's own disk", () => {
  it("keeps the newest few and removes the rest, never the one just written", async () => {
    // Every backup and every machine snapshot writes a full copy of the database here, and nothing
    // removed them. On a single-disk install that is the same volume the live database is on.
    const root = await mkdtemp(path.join(os.tmpdir(), "boxpilot-controller-prune-"));
    directories.push(root);
    const backupRoot = path.join(root, "backups");
    const ids = Array.from({ length: 6 }, (_unused, index) => `0000000${index}-0000-4000-8000-00000000000${index}`);
    for (const [index, id] of ids.entries()) {
      await mkdir(path.join(backupRoot, id), { recursive: true });
      await writeFile(path.join(backupRoot, id, "boxpilot.sqlite3"), "copy");
      await utimes(path.join(backupRoot, id), new Date(1000 + index * 1000), new Date(1000 + index * 1000));
    }
    const helper = createControllerBackupHelper({ backupRoot, keepLocal: 3 });
    const removed = await helper.internals.pruneLocalBackups(ids[0]);
    const left = (await readdir(backupRoot)).sort();
    // The three newest, plus the one named as just written even though it is the oldest.
    expect(left).toEqual([ids[0], ids[3], ids[4], ids[5]].sort());
    expect(removed.sort()).toEqual([ids[1], ids[2]].sort());
  });
});
