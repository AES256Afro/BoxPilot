import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { onWindows } from "../test/platform.mjs";
import { createHash } from "node:crypto";
import { readRestoreResult, restoreDatabaseCopy, stageDatabaseBackup } from "./db-restore.mjs";
import { applySchema } from "./state/schema.mjs";

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
  // The model gateway is not running unless a test says so (`gateway.running`): is-active answers for it and is not counted as a change.
  const gateway = { running: false };
  const run = vi.fn(async (binary, args) => {
    if (args[0] === "is-active") return { ok: gateway.running, stderr: "" };
    calls.push(args.join(" "));
    return { ok: true, stderr: "" };
  });
  return { directory, database, copyName, run, calls, gateway, log: vi.fn() };
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

  it("starts the model gateway again with BoxPilot when it was running, since it stops with it", async () => {
    const { database, copyName, run, calls, gateway } = await setup();
    gateway.running = true;
    await restoreDatabaseCopy({ database, copyName, version: "1.151.0", stamp: "20261019T130000Z", run, healthy: async () => true, log: () => {} });
    expect(calls).toEqual(["stop boxpilot.service", "start boxpilot.service", "start boxpilot-model-gateway.service"]);
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
    expect(run.mock.calls.map(([, args]) => args[0]).filter((verb) => verb !== "is-active")).toEqual(["stop", "start"]);

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

  // M73: the message said the database it had was put back, and BoxPilot started again, without
  // looking at whether either had happened; rolledBack was never set on this path.
  it("says the database was left as it was when the copy never reached it, and that BoxPilot would not start", async () => {
    const { database, copyName, run } = await setup();
    await mkdir(`${database}.restoring`);
    run.mockImplementation(async (binary, args) => (args[0] === "is-active" ? { ok: false, stderr: "" } : args.join(" ") === "start boxpilot.service" ? { ok: false, stderr: "Job for boxpilot.service failed.\n" } : { ok: true, stderr: "" }));
    const failure = await restoreDatabaseCopy({ database, copyName, version: "1.151.0", stamp: "20261019T130000Z", run, healthy: async () => true, log: () => {} }).catch((error) => error);
    expect(failure.message).toMatch(/could not be written in place .*; the database was left as it was\. BoxPilot would not start again \(Job for boxpilot\.service failed\.\); see the service log/);
    expect(failure.message).not.toMatch(/put back/);
    expect(failure.rolledBack).toBe(false);
    expect(owners(database)).toEqual(["now-alex", "now-sam"]);
  });

  it("says the database could not be put back, and where it is saved, when that fails too", async () => {
    const { database, copyName, run } = await setup();
    // Something lands in the put-back's way while BoxPilot is being checked on the copy.
    const healthy = vi.fn(async () => { await mkdir(`${database}.restoring`, { recursive: true }); return false; });
    const failure = await restoreDatabaseCopy({ database, copyName, version: "1.151.0", stamp: "20261019T130000Z", run, healthy, log: () => {} }).catch((error) => error);
    expect(failure.message).toMatch(/did not answer on .*, and the database it had could not be put back \(.*\); it is saved as boxpilot-rollback-1\.151\.0-20261019T130000Z\.sqlite3\. BoxPilot started again/);
    expect(failure.rolledBack).toBe(false);
    expect(owners(database)).toEqual(["then-alex"]);
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

// M91: a verified database backup, or the copy a snapshot restore staged, could only be put back at
// the console. Staged beside the database as a copy restoreDatabaseCopy takes, once it checks out.
describe.skipIf(onWindows)("staging a database backup to be put back", () => {
  async function backup({ extra = "", corrupt = false, liveSchema = false } = {}) {
    const { directory, database } = await setup();
    // A running BoxPilot's database has every table this release makes.
    if (liveSchema) {
      for (const suffix of ["", "-wal", "-shm"]) await rm(`${database}${suffix}`, { force: true });
      const live = new DatabaseSync(database);
      try { applySchema(live); } finally { live.close(); }
    }
    const folder = await mkdtemp(path.join(os.tmpdir(), "boxpilot-db-backup-"));
    directories.push(folder);
    const file = path.join(folder, "boxpilot.sqlite3");
    const copy = new DatabaseSync(file);
    copy.exec(liveSchema ? "" : "CREATE TABLE owners (username TEXT); INSERT INTO owners VALUES ('backed-up-alex');");
    if (liveSchema) applySchema(copy);
    if (extra) copy.exec(extra);
    copy.close();
    const checksumSha256 = createHash("sha256").update(await readFile(file)).digest("hex");
    if (corrupt) await writeFile(file, "not the bytes that were written");
    return { directory, database, file, checksumSha256 };
  }
  const now = () => new Date("2026-11-25T10:00:00.000Z");

  it("puts a backup that checks out beside the database, under a name the restore takes", async () => {
    const { directory, database, file, checksumSha256 } = await backup();
    const staged = await stageDatabaseBackup({ database, source: file, checksumSha256, label: "backup", now });
    expect(staged).toEqual({ name: "boxpilot-rollback-backup-20261125T100000Z.sqlite3", path: path.join(directory, "boxpilot-rollback-backup-20261125T100000Z.sqlite3") });
    expect(owners(staged.path)).toEqual(["backed-up-alex"]);
    expect((await stat(staged.path)).mode & 0o777).toBe(0o600);
    // And the existing put-back takes it from there.
    const run = vi.fn(async (_binary, args) => ({ ok: args[0] !== "is-active", stderr: "" }));
    await restoreDatabaseCopy({ database, copyName: staged.name, version: "1.151.0", stamp: "20261125T100100Z", run, healthy: async () => true, log: () => {} });
    expect(owners(database)).toEqual(["backed-up-alex"]);
  });

  it("refuses a backup that does not match its checksum, and puts nothing beside the database", async () => {
    const { directory, database, file, checksumSha256 } = await backup({ corrupt: true });
    await expect(stageDatabaseBackup({ database, source: file, checksumSha256, label: "snapshot", now })).rejects.toThrow(/does not match the checksum.*Nothing was changed/);
    expect((await readdir(directory)).filter((name) => name.includes("-snapshot-"))).toEqual([]);
  });

  // M91 review: this compared PRAGMA user_version, which BoxPilot never sets (a fresh database has 0),
  // so a backup from a newer release was never refused.
  it("never relied on user_version: BoxPilot's own database leaves it at 0", () => {
    const fresh = new DatabaseSync(":memory:");
    try { applySchema(fresh); expect(fresh.prepare("PRAGMA user_version").get()).toEqual({ user_version: 0 }); } finally { fresh.close(); }
  });

  it("refuses a backup holding a table or a column this BoxPilot does not have: a newer release took it", async () => {
    const table = await backup({ liveSchema: true, extra: "CREATE TABLE from_the_future (id TEXT)" });
    await expect(stageDatabaseBackup({ database: table.database, source: table.file, checksumSha256: table.checksumSha256, label: "backup", now })).rejects.toThrow(/holds table from_the_future, which this BoxPilot .* does not have, so it was taken by a newer release.*Nothing was changed/);
    const column = await backup({ liveSchema: true, extra: "ALTER TABLE owners ADD COLUMN pronouns TEXT" });
    await expect(stageDatabaseBackup({ database: column.database, source: column.file, checksumSha256: column.checksumSha256, label: "backup", now })).rejects.toThrow(/holds column owners\.pronouns/);
    expect((await readdir(column.directory)).filter((name) => name.includes("-backup-"))).toEqual([]);
  });

  it("takes a backup from an older release, though it still holds a table this one has since dropped", async () => {
    const { database, file, checksumSha256 } = await backup({ liveSchema: true, extra: "CREATE TABLE fleet_agents (id TEXT); ALTER TABLE owners DROP COLUMN role" });
    await expect(stageDatabaseBackup({ database, source: file, checksumSha256, label: "backup", now })).resolves.toMatchObject({ name: "boxpilot-rollback-backup-20261125T100000Z.sqlite3" });
  });

  it("refuses a backup whose record says a newer release took it, and takes one from this release or an older one", async () => {
    const { database, file, checksumSha256 } = await backup();
    await expect(stageDatabaseBackup({ database, source: file, checksumSha256, label: "backup", takenBy: "1.200.0", version: "1.199.3", now })).rejects.toThrow(/taken by BoxPilot 1\.200\.0, newer than this 1\.199\.3.*Nothing was changed/);
    await expect(stageDatabaseBackup({ database, source: file, checksumSha256, label: "backup", takenBy: "1.199.3", version: "1.199.3", now })).resolves.toMatchObject({ name: expect.any(String) });
  });

  it("never reads a backup through a link, nor writes through one at the copy's name", async () => {
    const { directory, database, file, checksumSha256 } = await backup();
    const linked = path.join(path.dirname(file), "linked.sqlite3");
    await symlink(file, linked);
    await expect(stageDatabaseBackup({ database, source: linked, checksumSha256, label: "backup", now })).rejects.toThrow(/not a plain file/);
    const elsewhere = path.join(path.dirname(file), "elsewhere");
    await writeFile(elsewhere, "keep me");
    await symlink(elsewhere, path.join(directory, "boxpilot-rollback-backup-20261125T100000Z.sqlite3"));
    await expect(stageDatabaseBackup({ database, source: file, checksumSha256, label: "backup", now })).rejects.toThrow(/could not be put beside the database/);
    expect(await readFile(elsewhere, "utf8")).toBe("keep me");
  });
});
