import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { onWindows } from "../test/platform.mjs";
import { readRestoreResult, restoreDatabaseCopy } from "./db-restore.mjs";

const directories = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });

const owners = (file) => { const db = new DatabaseSync(file, { readOnly: true }); try { return db.prepare("SELECT username FROM owners ORDER BY username").all().map((row) => row.username); } finally { db.close(); } };

/** A live database in WAL mode with rows still in the WAL, and an update's copy beside it holding other rows. */
async function setup() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "boxpilot-db-restore-"));
  directories.push(directory);
  const database = path.join(directory, "boxpilot.sqlite3");
  const live = new DatabaseSync(database);
  live.exec("PRAGMA journal_mode = WAL; CREATE TABLE owners (username TEXT); INSERT INTO owners VALUES ('now-alex'), ('now-sam');");
  live.close();
  await chmod(database, 0o640);
  const copyName = "boxpilot-rollback-1.150.0-20261018T101500Z.sqlite3";
  const copy = new DatabaseSync(path.join(directory, copyName));
  copy.exec("CREATE TABLE owners (username TEXT); INSERT INTO owners VALUES ('then-alex'); CREATE TABLE sessions (id TEXT); INSERT INTO sessions VALUES ('revoked-since');");
  copy.close();
  const calls = [];
  const run = vi.fn(async (binary, args) => { calls.push(args.join(" ")); return { ok: true, stderr: "" }; });
  return { directory, database, copyName, run, calls, log: vi.fn() };
}

describe.skipIf(onWindows)("putting a database copy back", () => {
  it("saves the database first, puts the copy in with the live file's mode, and starts BoxPilot on it", async () => {
    const { directory, database, copyName, run, calls, log } = await setup();
    const result = await restoreDatabaseCopy({ database, copyName, version: "1.151.0", stamp: "20261019T130000Z", run, healthy: async () => true, log });
    expect(result).toEqual({ restored: copyName, saved: "boxpilot-rollback-1.151.0-20261019T130000Z.sqlite3", rolledBack: false });
    expect(calls).toEqual(["stop boxpilot.service", "start boxpilot.service"]);
    expect(owners(database)).toEqual(["then-alex"]);
    // What was there before is a copy of its own, rows from the WAL included, readable by root alone.
    const saved = path.join(directory, result.saved);
    expect(owners(saved)).toEqual(["now-alex", "now-sam"]);
    expect((await stat(saved)).mode & 0o777).toBe(0o600);
    expect((await stat(database)).mode & 0o777).toBe(0o640);
    // The old database's WAL would replay over the copy: gone, and no staging file left behind.
    const left = await readdir(directory);
    expect(left.filter((name) => /-wal$|-shm$|\.restoring$/.test(name))).toEqual([]);
    expect(log.mock.calls.map(([line]) => line).every((line) => line.startsWith("[boxpilot-db-restore] "))).toBe(true);
  });

  it("puts the database back when BoxPilot does not answer on the copy", async () => {
    const { database, copyName, run, calls } = await setup();
    let checks = 0;
    const failure = await restoreDatabaseCopy({ database, copyName, version: "1.151.0", stamp: "20261019T130000Z", run, healthy: async () => (checks += 1) > 1, log: () => {} }).catch((error) => error);
    expect(failure.message).toMatch(/did not answer on .*put back and BoxPilot answers again/);
    expect(failure.rolledBack).toBe(true);
    expect(calls).toEqual(["stop boxpilot.service", "start boxpilot.service", "stop boxpilot.service", "start boxpilot.service"]);
    expect(owners(database)).toEqual(["now-alex", "now-sam"]);
  });

  it("stops nothing when the copy is damaged, missing, or not a copy", async () => {
    const { directory, database, copyName, run } = await setup();
    await writeFile(path.join(directory, copyName), "not a database at all, just bytes that are long enough to matter");
    await expect(restoreDatabaseCopy({ database, copyName, version: "1", stamp: "s", run, healthy: async () => true, log: () => {} })).rejects.toThrow(/integrity check.*Nothing was changed/);
    await expect(restoreDatabaseCopy({ database, copyName: "boxpilot-rollback-9.9.9-20260101T000000Z.sqlite3", version: "1", stamp: "s", run, healthy: async () => true, log: () => {} })).rejects.toThrow("Nothing was changed");
    await expect(restoreDatabaseCopy({ database, copyName: "../../etc/shadow", version: "1", stamp: "s", run, healthy: async () => true, log: () => {} })).rejects.toThrow("not a database copy");
    expect(run).not.toHaveBeenCalled();
    expect(owners(database)).toEqual(["now-alex", "now-sam"]);
  });

  it("leaves the database alone and starts BoxPilot again when BoxPilot will not stop", async () => {
    const { database, copyName, log } = await setup();
    const run = vi.fn(async (_binary, args) => ({ ok: args[0] !== "stop", stderr: "Job for boxpilot.service canceled" }));
    await expect(restoreDatabaseCopy({ database, copyName, version: "1", stamp: "s", run, healthy: async () => true, log })).rejects.toThrow("would not stop");
    expect(owners(database)).toEqual(["now-alex", "now-sam"]);
  });

  it("signs everyone out of the copy, so a session revoked since it was taken does not work again", async () => {
    const { database, copyName, run } = await setup();
    await restoreDatabaseCopy({ database, copyName, version: "1.151.0", stamp: "20261019T130000Z", run, healthy: async () => true, log: () => {} });
    const db = new DatabaseSync(database, { readOnly: true });
    try { expect(db.prepare("SELECT COUNT(*) AS n FROM sessions").get().n).toBe(0); } finally { db.close(); }
  });

  it("never follows a link planted at the copy or at the name the saved database gets", async () => {
    const { directory, database, copyName, run } = await setup();
    const elsewhere = path.join(directory, "elsewhere");
    await mkdir(elsewhere);
    // The saved database's name is guessable: a link there must not make root write through it.
    const savedName = "boxpilot-rollback-1.151.0-20261019T130000Z.sqlite3";
    await symlink(path.join(elsewhere, "created-by-root"), path.join(directory, savedName));
    await expect(restoreDatabaseCopy({ database, copyName, version: "1.151.0", stamp: "20261019T130000Z", run, healthy: async () => true, log: () => {} })).rejects.toThrow("left as it was");
    expect(await readdir(elsewhere)).toEqual([]);
    expect(owners(database)).toEqual(["now-alex", "now-sam"]);
    expect(run.mock.calls.map(([, args]) => args[0])).toEqual(["stop", "start"]);

    // A copy that is a link to some other file is refused before anything stops.
    run.mockClear();
    const secret = path.join(elsewhere, "secret.sqlite3");
    new DatabaseSync(secret).close();
    await symlink(secret, path.join(directory, "boxpilot-rollback-1.0.0-20260101T000000Z.sqlite3"));
    await expect(restoreDatabaseCopy({ database, copyName: "boxpilot-rollback-1.0.0-20260101T000000Z.sqlite3", version: "1.151.0", stamp: "20261019T140000Z", run, healthy: async () => true, log: () => {} })).rejects.toThrow("not a plain file");
    expect(run).not.toHaveBeenCalled();
  });

  it("puts the database back and starts BoxPilot when the copy cannot be written in place", async () => {
    const { database, copyName, run, calls } = await setup();
    // Something in the staging file's way stands in for a full disk.
    await mkdir(`${database}.restoring`);
    await expect(restoreDatabaseCopy({ database, copyName, version: "1.151.0", stamp: "20261019T130000Z", run, healthy: async () => true, log: () => {} })).rejects.toThrow("BoxPilot started again");
    expect(calls).toEqual(["stop boxpilot.service", "start boxpilot.service"]);
    expect(owners(database)).toEqual(["now-alex", "now-sam"]);
    expect(await readFile(database)).toBeTruthy();
  });

  it("writes how it ended where the System page reads it", async () => {
    const { directory, database, copyName, run } = await setup();
    const resultFile = path.join(directory, "elsewhere-result.json");
    const now = () => new Date("2026-10-19T13:00:00Z");
    await restoreDatabaseCopy({ database, copyName, version: "1.151.0", stamp: "20261019T130000Z", run, healthy: async () => true, log: () => {}, resultFile, now });
    expect(await readRestoreResult(resultFile)).toEqual({ at: "2026-10-19T13:00:00.000Z", copy: copyName, outcome: "restored", message: expect.any(String), saved: "boxpilot-rollback-1.151.0-20261019T130000Z.sqlite3" });
    let checks = 0;
    await restoreDatabaseCopy({ database, copyName: "boxpilot-rollback-1.151.0-20261019T130000Z.sqlite3", version: "1.151.0", stamp: "20261019T140000Z", run, healthy: async () => (checks += 1) > 1, log: () => {}, resultFile, now }).catch(() => {});
    expect(await readRestoreResult(resultFile)).toMatchObject({ outcome: "rolled-back", message: expect.stringContaining("did not answer") });
    await restoreDatabaseCopy({ database, copyName: "boxpilot-rollback-9.9.9-20260101T000000Z.sqlite3", version: "1", stamp: "s", run, healthy: async () => true, log: () => {}, resultFile, now }).catch(() => {});
    expect(await readRestoreResult(resultFile)).toMatchObject({ outcome: "failed", message: expect.stringContaining("Nothing was changed") });
    // A file that says something else is not shown.
    await writeFile(resultFile, JSON.stringify({ at: "x", copy: "../../etc/shadow", outcome: "restored" }));
    expect(await readRestoreResult(resultFile)).toBeNull();
    expect(await readRestoreResult(path.join(directory, "missing.json"))).toBeNull();
  });
});
