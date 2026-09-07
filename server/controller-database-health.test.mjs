import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { createStateStore } from "./state.mjs";
import { inspectControllerDatabase, readControllerDatabaseHealth } from "./controller-database-health.mjs";
import { controllerOperations } from "./ops/controller.mjs";

const fixtures = [];
const now = () => new Date("2026-09-07T14:00:00Z");
async function fixture({ owner = true } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "boxpilot-db-health-"));
  const store = createStateStore({ stateDirectory: directory });
  if (owner) store.consumeBootstrapToken(store.createBootstrapToken().token, { username: "private-account-fixture", passwordHash: "private-password-fixture" });
  let closed = false;
  const close = () => { if (!closed) { closed = true; store.close(); } };
  fixtures.push(async () => { close(); await rm(directory, { recursive: true, force: true }); });
  return { directory, databasePath: store.databasePath, close };
}
afterEach(async () => { for (const clean of fixtures.splice(0)) await clean(); });

it("checks committed WAL state without exposing records or changing database bytes", async () => {
  const { databasePath } = await fixture();
  const before = await readFile(databasePath); const walBefore = await readFile(`${databasePath}-wal`);
  const report = await readControllerDatabaseHealth({ databasePath, now });
  expect(report.status).toBe("ready");
  expect(report.counts.fail).toBe(0);
  expect(report.checks.find((check) => check.id === "database-owner").status).toBe("pass");
  expect(JSON.stringify(report)).not.toContain("private-account-fixture");
  expect(JSON.stringify(report)).not.toContain("private-password-fixture");
  expect(await readFile(databasePath)).toEqual(before);
  expect(await readFile(`${databasePath}-wal`)).toEqual(walBefore);
});

it("checks a clean offline database through the isolated child", async () => {
  const { databasePath, close } = await fixture(); close();
  expect((await inspectControllerDatabase({ databasePath })).status).toBe("ready");
});

it("distinguishes new-install account absence from broken database structure", async () => {
  const { databasePath } = await fixture({ owner: false });
  const report = await readControllerDatabaseHealth({ databasePath, now });
  expect(report.status).toBe("warning");
  expect(report.checks.find((check) => check.id === "database-owner").status).toBe("warning");
});

it("finds related-record failures while retaining other successful checks", async () => {
  const { databasePath } = await fixture();
  const db = new DatabaseSync(databasePath);
  db.exec("PRAGMA foreign_keys = OFF; CREATE TABLE fixture_parent (id INTEGER PRIMARY KEY); CREATE TABLE fixture_child (parent_id INTEGER REFERENCES fixture_parent(id)); INSERT INTO fixture_child VALUES (42);"); db.close();
  const report = await readControllerDatabaseHealth({ databasePath, now });
  expect(report.status).toBe("needs-attention");
  expect(report.checks.find((check) => check.id === "database-foreign-keys").status).toBe("fail");
  expect(report.checks.find((check) => check.id === "database-core-tables").status).toBe("pass");
});

it("reports corruption and missing core tables without initializing a database", async () => {
  const { databasePath, close } = await fixture(); close();
  await writeFile(databasePath, "private-corrupt-content");
  const damaged = await readControllerDatabaseHealth({ databasePath, now });
  expect(damaged.status).toBe("needs-attention");
  expect(JSON.stringify(damaged)).not.toContain("private-corrupt-content");
  await rm(databasePath);
  const db = new DatabaseSync(databasePath); db.exec("CREATE TABLE unrelated (id INTEGER)"); db.close();
  const incomplete = await readControllerDatabaseHealth({ databasePath, now });
  expect(incomplete.checks.find((check) => check.id === "database-core-tables").status).toBe("fail");
  await rm(databasePath);
  expect((await readControllerDatabaseHealth({ databasePath, now })).status).toBe("needs-attention");
  await expect(readFile(databasePath)).rejects.toMatchObject({ code: "ENOENT" });
});

it("refuses linked databases and linked journal files", async () => {
  const { directory, databasePath, close } = await fixture(); close();
  const link = path.join(directory, "linked.sqlite3"); await symlink(databasePath, link);
  expect((await readControllerDatabaseHealth({ databasePath: link, now })).checks[0].status).toBe("fail");
  await symlink(databasePath, `${databasePath}-wal`);
  expect((await readControllerDatabaseHealth({ databasePath, now })).checks.find((check) => check.id === "database-wal").status).toBe("fail");
});

it("bounds child time, heap and output and omits inherited secret-bearing environment", async () => {
  const run = vi.fn(async (_binary, args, options) => {
    expect(args[0]).toBe("--max-old-space-size=48");
    expect(args.at(-1)).toBe("--probe");
    expect(options).toMatchObject({ timeout: 15_000, killSignal: "SIGKILL", maxBuffer: 32 * 1024 });
    expect(Object.keys(options.env).sort()).toEqual(["BOXPILOT_CONTROLLER_DATABASE", "LANG", "PATH"]);
    throw new Error("private failure output");
  });
  const report = await inspectControllerDatabase({ databasePath: "/missing/fixture.sqlite3", run, now });
  expect(report.status).toBe("incomplete");
  expect(JSON.stringify(report)).not.toContain("private failure output");
  expect(run).toHaveBeenCalledTimes(1);
});

it("terminates a real child at its deadline and leaves the source intact", async () => {
  const { databasePath, close } = await fixture(); close();
  const before = await readFile(databasePath);
  const report = await inspectControllerDatabase({ databasePath, timeoutMs: 1, now });
  expect(report.status).toBe("incomplete");
  expect(await readFile(databasePath)).toEqual(before);
});

it("registers database inspection as an operator read with no browser path", () => {
  const operation = controllerOperations().find((item) => item.id === "controller.database.inspect");
  expect(operation).toMatchObject({ readOnly: true, minimumRole: "operator", risk: "low" });
  expect(Object.keys(operation.parameters.fields)).toEqual([]);
});
