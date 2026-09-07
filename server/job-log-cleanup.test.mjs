import { mkdtemp, readFile, rm, symlink, writeFile, lstat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { releaseSavedJobLog, savedCompletedOutput } from "./job-log-cleanup.mjs";
import { jobLogPath } from "./job-log.mjs";
const directories = [];
const jobId = "11111111-2222-4333-8444-555555555555";
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });
async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "boxpilot-saved-log-")); directories.push(directory);
  const file = jobLogPath(jobId, directory);
  await writeFile(file, "complete output\n", { mode: 0o640 });
  return { directory, file, expectedUid: process.getuid(), lookup: async () => "complete output\n" };
}
describe("releasing durable job output", () => {
  it("removes only a fully saved completed log and is idempotent", async () => {
    const options = await fixture();
    expect(await releaseSavedJobLog({ jobId }, options)).toMatchObject({ removed: true, bytes: 16 });
    expect(await releaseSavedJobLog({ jobId }, options)).toMatchObject({ removed: false, retained: false, reason: "already-absent" });
  });
  it.each([null, "output\n", "other output\n"])("retains a file when its full contents were not persisted (%s)", async (saved) => {
    const options = await fixture(); options.lookup = async () => saved;
    expect((await releaseSavedJobLog({ jobId }, options)).retained).toBe(true);
    expect(await readFile(options.file, "utf8")).toBe("complete output\n");
  });
  it("refuses symlinks, foreign ownership and a file changed during inspection", async () => {
    const options = await fixture();
    expect((await releaseSavedJobLog({ jobId }, { ...options, expectedUid: 999999 })).reason).toBe("untrusted-directory");
    await rm(options.file); await symlink(path.join(options.directory, "target"), options.file);
    await writeFile(path.join(options.directory, "target"), "complete output\n");
    expect((await releaseSavedJobLog({ jobId }, options)).retained).toBe(true);
    expect(await readFile(path.join(options.directory, "target"), "utf8")).toBe("complete output\n");
    await rm(options.file); await writeFile(options.file, "complete output\n", { mode: 0o640 });
    const changed = { ...options, inspect: async (file) => { const info = await lstat(file); if (file === options.file) info.mtimeMs += 1000; return info; } };
    expect((await releaseSavedJobLog({ jobId }, changed)).reason).toBe("file-changed");
  });
  it("does not follow a caller-supplied path outside the log directory", async () => {
    await expect(releaseSavedJobLog({ jobId: "../../etc/passwd" }, await fixture())).rejects.toThrow("UUID");
  });
  it("reads only completed outputs from an existing database and never creates a missing database", async () => {
    const options = await fixture();
    const databasePath = path.join(options.directory, "state.sqlite3");
    const db = new DatabaseSync(databasePath);
    db.exec("CREATE TABLE jobs(id TEXT PRIMARY KEY,state TEXT); CREATE TABLE job_output(job_id TEXT PRIMARY KEY,output TEXT)");
    db.prepare("INSERT INTO jobs VALUES (?,?)").run(jobId, "applying");
    db.prepare("INSERT INTO job_output VALUES (?,?)").run(jobId, "complete output\n");
    expect(savedCompletedOutput(jobId, databasePath)).toBeNull();
    db.prepare("UPDATE jobs SET state='failed'").run();
    expect(savedCompletedOutput(jobId, databasePath)).toBeNull();
    db.prepare("UPDATE jobs SET state='completed'").run();
    expect(savedCompletedOutput(jobId, databasePath)).toBe("complete output\n");
    db.close();
    expect(() => savedCompletedOutput(jobId, path.join(options.directory, "missing.db"))).toThrow();
  });
});
