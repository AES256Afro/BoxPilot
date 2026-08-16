import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { rollbackApprovedKeel, keelRollbackScriptInternals } from "./boxpilot-keel-rollback.mjs";
import { pathsForKeelRollback } from "../server/keel-rollback-spec.mjs";
import { keelBackupScriptInternals } from "./boxpilot-keel-backup.mjs";

const directories = [];
const rollbackId = "55555555-5555-4555-8555-555555555555";
const promotionId = "33333333-3333-4333-8333-333333333333";
const installId = "44444444-4444-4444-8444-444444444444";
const evidence = "a".repeat(64);

afterEach(async () => Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))));

async function createState(root, note) {
  await mkdir(path.join(root, "uploads"), { recursive: true, mode: 0o700 });
  const database = new DatabaseSync(path.join(root, "keel.db"));
  for (const table of ["AppSetting", "Page", "User", "Workspace"]) database.exec(`CREATE TABLE ${table} (id INTEGER PRIMARY KEY);`);
  database.close();
  await writeFile(path.join(root, ".env"), "DATABASE_URL=file:/var/lib/keel/keel.db\nPORT=3000\n", { mode: 0o600 });
  await writeFile(path.join(root, "uploads", "note.txt"), `${note}\n`, { mode: 0o600 });
}

async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "boxpilot-keel-rollback-"));
  directories.push(directory);
  const production = path.join(directory, "keel-production");
  const source = path.join(directory, "promotion-checkpoint");
  await createState(production, "current promoted production");
  await createState(source, "pre-promotion checkpoint");
  const previousTree = (await keelBackupScriptInternals.inspectTree(source)).digest;
  const paths = { root: path.join(directory, "rollbacks"), displacedRoot: path.join(directory, "displaced"), approval: path.join(directory, "approval.json"), active: path.join(directory, "rollbacks", ".active.json") };
  const installPaths = { state: production };
  const approval = { approvedAt: "2026-08-16T12:00:00.000Z", expectedInstallId: installId, expectedPreviousStateTreeDigestSha256: previousTree, expectedRollbackEvidenceChecksumSha256: evidence, promotionId, releaseVersion: "1.2.6", rollbackId, unitName: "boxpilot-keel-rollback.service" };
  const inspectSource = vi.fn(async () => ({ ready: true, promotionId, previousInstallId: installId, statePath: source, evidenceChecksumSha256: evidence, stateTreeDigestSha256: previousTree }));
  const run = vi.fn(async (_binary, args) => ({ ok: args[0] !== "is-active", stdout: "", stderr: "" }));
  return { directory, production, source, previousTree, paths, installPaths, approval, inspectSource, run };
}

describe("fixed Keel operator rollback", () => {
  it("restores an exact retained checkpoint while preserving current production and the original source", async () => {
    const values = await fixture();
    const result = await rollbackApprovedKeel({
      ...values, loadApproval: async () => JSON.stringify(values.approval), now: () => new Date("2026-08-16T12:01:00.000Z"),
      requestHealth: async () => true,
      installHelper: { inspect: async () => ({ state: "installed", installed: true, healthy: true, installId, releaseVersion: "1.2.6" }) },
      account: { uid: process.getuid(), gid: process.getgid() },
    });
    const targets = pathsForKeelRollback(rollbackId, values.paths);
    expect(result).toMatchObject({ passed: true, productionStateReplaced: true, displacedStateRetained: true, sourceRollbackCheckpointUnchanged: true, ownerLoginTested: false });
    expect(await readFile(path.join(values.production, "uploads", "note.txt"), "utf8")).toBe("pre-promotion checkpoint\n");
    expect(await readFile(path.join(targets.displacedFinalState, "uploads", "note.txt"), "utf8")).toBe("current promoted production\n");
    expect(await readFile(path.join(values.source, "uploads", "note.txt"), "utf8")).toBe("pre-promotion checkpoint\n");
    await expect(stat(values.paths.active)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await stat(targets.result)).mode & 0o7777).toBe(0o600);
  });

  it("restores current production automatically if the retained source changes during final verification", async () => {
    const values = await fixture();
    let inspections = 0;
    values.inspectSource.mockImplementation(async () => ({
      ready: true, promotionId, previousInstallId: installId, statePath: values.source,
      evidenceChecksumSha256: ++inspections > 1 ? "d".repeat(64) : evidence, stateTreeDigestSha256: values.previousTree,
    }));
    await expect(rollbackApprovedKeel({
      ...values, loadApproval: async () => JSON.stringify(values.approval), now: () => new Date("2026-08-16T12:01:00.000Z"),
      requestHealth: async () => true,
      installHelper: { inspect: async () => ({ state: "installed", installed: true, healthy: true, installId, releaseVersion: "1.2.6" }) },
      account: { uid: process.getuid(), gid: process.getgid() },
    })).rejects.toThrow("automatic recovery restored");
    expect(await readFile(path.join(values.production, "uploads", "note.txt"), "utf8")).toBe("current promoted production\n");
    await expect(stat(values.paths.active)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects stale or expanded approval markers", async () => {
    const values = await fixture();
    expect(() => keelRollbackScriptInternals.parseApproval(JSON.stringify(values.approval), new Date("2026-08-16T12:06:00.000Z"))).toThrow("stale");
    expect(() => keelRollbackScriptInternals.parseApproval(JSON.stringify({ ...values.approval, path: "/tmp" }), new Date("2026-08-16T12:01:00.000Z"))).toThrow("identity");
  });

  it.each(["current-moved", "checkpoint-activated"])("restores displaced current production after interruption in phase %s", async (phase) => {
    const values = await fixture();
    const targets = pathsForKeelRollback(rollbackId, values.paths);
    await mkdir(targets.root, { recursive: true, mode: 0o700 });
    await mkdir(targets.displacedRoot, { recursive: true, mode: 0o700 });
    await mkdir(targets.displacedPartial, { mode: 0o700 });
    await rename(values.production, targets.displacedPartialState);
    if (phase === "checkpoint-activated") await createState(values.production, "activated old checkpoint copy");
    const active = { ...values.approval, phase, updatedAt: "2026-08-16T12:01:30.000Z" };
    await writeFile(values.paths.active, `${JSON.stringify(active)}\n`, { mode: 0o600 });
    await keelRollbackScriptInternals.restoreCurrentProduction(active, { paths: values.paths, installPaths: values.installPaths, run: values.run, requestHealth: async () => true });
    expect(await readFile(path.join(values.production, "uploads", "note.txt"), "utf8")).toBe("current promoted production\n");
    await expect(stat(values.paths.active)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(targets.displacedPartial)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
