import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { onWindows } from "../../test/platform.mjs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { hostBackupOperations } from "./host-backup.mjs";

/**
 * The off-box mirror's own two operations (M56.2). Both were in the registry and named by no test:
 * the one that makes the key the mirror authenticates with, and the one the page reads to say
 * whether the mirror is ready at all.
 */
const operation = (id) => hostBackupOperations().find((entry) => entry.id === id);

const directories = [];
afterEach(async () => {
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
  delete process.env.BOXPILOT_SECRETS_DIRECTORY;
  delete process.env.BOXPILOT_CONTROLLER_DATABASE;
});

async function secretsDirectory(files = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "boxpilot-mirror-"));
  directories.push(directory);
  for (const [name, contents] of Object.entries(files)) await writeFile(path.join(directory, name), contents);
  process.env.BOXPILOT_SECRETS_DIRECTORY = directory;
  return directory;
}

describe("making the off-box mirror key", () => {
  it("stages the keygen task, and is medium with nothing to choose", async () => {
    const found = operation("backup.remote.setup");
    expect(found).toMatchObject({ risk: "medium", readOnly: false });
    expect(Object.keys(found.parameters?.fields ?? {})).toEqual([]);
    const runUnit = { runTask: vi.fn(async () => ({ created: true })) };
    await found.run({}, { runUnit, jobLog: { path: "/tmp/job.log" } });
    expect(runUnit.runTask).toHaveBeenCalledWith("backup.remote.keygen", {}, expect.objectContaining({ logPath: "/tmp/job.log" }));
  });
});

describe("reading whether the off-box mirror is ready", () => {
  it("reports a key, its fingerprint, the pinned host keys and rsync", async () => {
    await secretsDirectory({
      "backup-mirror-key.pub": "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5 boxpilot-backup-mirror\n",
      // One comment and one blank line, neither of which is a pinned host key.
      "backup-mirror-known_hosts": "# written by BoxPilot\n\ndestination.example ssh-ed25519 AAAA\n[dest]:2222 ssh-ed25519 BBBB\n",
    });
    const run = vi.fn(async () => ({ ok: true, stdout: "256 SHA256:abc123 boxpilot-backup-mirror (ED25519)\n" }));
    const read = await operation("backup.remote.inspect").run({}, { run });
    expect(read).toMatchObject({ keyReady: true, fingerprint: "SHA256:abc123", hostKeysPinned: 2 });
    expect(read.publicKey).toBe("ssh-ed25519 AAAAC3NzaC1lZDI1NTE5 boxpilot-backup-mirror");
    expect(typeof read.rsyncInstalled).toBe("boolean");
  });

  it("says the key is not ready rather than failing, when nothing has been set up", async () => {
    await secretsDirectory();
    const run = vi.fn(async () => ({ ok: true, stdout: "" }));
    const read = await operation("backup.remote.inspect").run({}, { run });
    expect(read).toMatchObject({ keyReady: false, publicKey: null, fingerprint: null, hostKeysPinned: 0 });
    // No key, so there is nothing to take a fingerprint of and ssh-keygen is not run.
    expect(run).not.toHaveBeenCalled();
  });

  it("still answers when ssh-keygen fails or is missing", async () => {
    await secretsDirectory({ "backup-mirror-key.pub": "ssh-ed25519 AAAA key\n" });
    const failing = await operation("backup.remote.inspect").run({}, { run: async () => ({ ok: false, stdout: "" }) });
    expect(failing).toMatchObject({ keyReady: true, fingerprint: null });
    const throwing = await operation("backup.remote.inspect").run({}, { run: async () => { throw new Error("ENOENT"); } });
    expect(throwing).toMatchObject({ keyReady: true, fingerprint: null });
  });

  it("is a read that needs no role of its own: it returns a public key and counts, nothing private", () => {
    expect(operation("backup.remote.inspect")).toMatchObject({ readOnly: true, risk: "low", minimumRole: null });
  });
});

// M91: a verified database backup, or the copy a snapshot restore staged, put back from the browser.
describe("restoring BoxPilot's database copy", () => {
  it("is high, the owner's, typed out by the copy's id, and lists what it can put back to an operator", () => {
    expect(operation("host.database.restore")).toMatchObject({ risk: "high", minimumRole: "owner", restartsService: true, runsRootTask: true });
    expect(operation("host.database.restore").confirm({ kind: "backup", id: "11111111-1111-4111-8111-111111111111" })).toBe("11111111-1111-4111-8111-111111111111");
    expect(operation("host.database.sources")).toMatchObject({ readOnly: true, risk: "low", minimumRole: "operator" });
    const { id } = operation("host.database.restore").parameters.fields;
    expect(id.validate("20261125T100000Z")).toBeNull();
    expect(id.validate("../../etc/passwd")).not.toBeNull();
  });

  // POSIX: node:sqlite files and modes.
  it.skipIf(onWindows)("checks the backup, puts it beside the database and starts the put-back with it; takes it away again when that cannot start", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "boxpilot-db-op-"));
    directories.push(directory);
    const database = path.join(directory, "boxpilot.sqlite3");
    // The live database has every table the copy has, as a running BoxPilot's does.
    const liveDb = new DatabaseSync(database); liveDb.exec("CREATE TABLE owners (username TEXT)"); liveDb.close();
    process.env.BOXPILOT_CONTROLLER_DATABASE = database;
    await mkdir(path.join(directory, "backup"));
    const file = path.join(directory, "backup", "boxpilot.sqlite3");
    const db = new DatabaseSync(file); db.exec("CREATE TABLE owners (username TEXT)"); db.close();
    const checksumSha256 = createHash("sha256").update(await readFile(file)).digest("hex");
    const machineSnapshot = { databaseSource: vi.fn(async ({ kind, id }) => ({ kind, id, file, checksumSha256, createdAt: "2026-11-20T02:00:00.000Z" })) };
    const runUnit = { runTask: vi.fn(async (_task, parameters) => ({ started: true, name: parameters.name })) };
    const parameters = { kind: "snapshot", id: "20261125T100000Z" };
    const result = await operation("host.database.restore").run(parameters, { machineSnapshot, runUnit, jobLog: { path: null }, progress: () => {} });
    expect(machineSnapshot.databaseSource).toHaveBeenCalledWith(parameters);
    expect(runUnit.runTask).toHaveBeenCalledWith("database.copy.restore", { name: expect.stringMatching(/^boxpilot-rollback-snapshot-\d{8}T\d{6}Z\.sqlite3$/), database }, expect.anything());
    expect(result).toMatchObject({ started: true, from: { kind: "snapshot", id: "20261125T100000Z" } });
    expect((await readdir(directory)).filter((name) => name.startsWith("boxpilot-rollback-snapshot-"))).toHaveLength(1);

    for (const name of await readdir(directory)) if (name.startsWith("boxpilot-rollback-")) await rm(path.join(directory, name));
    runUnit.runTask.mockRejectedValueOnce(new Error("A BoxPilot update is running"));
    await expect(operation("host.database.restore").run(parameters, { machineSnapshot, runUnit, jobLog: { path: null }, progress: () => {} })).rejects.toThrow("update is running");
    expect((await readdir(directory)).filter((name) => name.startsWith("boxpilot-rollback-"))).toEqual([]);

    // M91 review: an answer that is not "started" (resolved, not thrown) left the copy beside the database.
    runUnit.runTask.mockResolvedValueOnce({ started: false, error: "systemd-run refused" });
    await expect(operation("host.database.restore").run(parameters, { machineSnapshot, runUnit, jobLog: { path: null }, progress: () => {} })).rejects.toThrow(/did not start \(systemd-run refused\)/);
    expect((await readdir(directory)).filter((name) => name.startsWith("boxpilot-rollback-"))).toEqual([]);
  });

  // M91 review: the "newer BoxPilot" check compared PRAGMA user_version, which BoxPilot never sets.
  it.skipIf(onWindows)("refuses a copy whose record names a newer release, and passes the release on from the source", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "boxpilot-db-op-"));
    directories.push(directory);
    const database = path.join(directory, "boxpilot.sqlite3");
    const liveDb = new DatabaseSync(database); liveDb.exec("CREATE TABLE owners (username TEXT)"); liveDb.close();
    process.env.BOXPILOT_CONTROLLER_DATABASE = database;
    const file = path.join(directory, "copy.sqlite3");
    const db = new DatabaseSync(file); db.exec("CREATE TABLE owners (username TEXT)"); db.close();
    const checksumSha256 = createHash("sha256").update(await readFile(file)).digest("hex");
    const machineSnapshot = { databaseSource: vi.fn(async ({ kind, id }) => ({ kind, id, file, checksumSha256, createdAt: null, productVersion: "999.0.0" })) };
    const runUnit = { runTask: vi.fn() };
    await expect(operation("host.database.restore").run({ kind: "snapshot", id: "20261125T100000Z" }, { machineSnapshot, runUnit, jobLog: { path: null }, progress: () => {} })).rejects.toThrow(/taken by BoxPilot 999\.0\.0, newer than this/);
    expect(runUnit.runTask).not.toHaveBeenCalled();
    expect((await readdir(directory)).filter((name) => name.startsWith("boxpilot-rollback-"))).toEqual([]);
  });

  it("refuses an id of the other kind before it reads anything", async () => {
    const machineSnapshot = { databaseSource: vi.fn() };
    await expect(operation("host.database.restore").run({ kind: "backup", id: "20261125T100000Z" }, { machineSnapshot, runUnit: {}, progress: () => {} })).rejects.toThrow("not a database copy of that kind");
    expect(machineSnapshot.databaseSource).not.toHaveBeenCalled();
  });
});
