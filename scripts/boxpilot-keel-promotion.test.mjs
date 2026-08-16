import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { promoteApprovedKeel, keelPromotionScriptInternals } from "./boxpilot-keel-promotion.mjs";
import { pathsForKeelPromotion } from "../server/keel-promotion-spec.mjs";
import { keelBackupScriptInternals } from "./boxpilot-keel-backup.mjs";

const directories = [];
const promotionId = "33333333-3333-4333-8333-333333333333";
const recoveryId = "11111111-1111-4111-8111-111111111111";
const drillId = "22222222-2222-4222-8222-222222222222";
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
  const directory = await mkdtemp(path.join(os.tmpdir(), "boxpilot-keel-promotion-"));
  directories.push(directory);
  const production = path.join(directory, "keel-production");
  const recovery = path.join(directory, "keel-recovery");
  await createState(production, "current production");
  await createState(recovery, "recovered production");
  const tree = (await keelBackupScriptInternals.inspectTree(recovery)).digest;
  const paths = { root: path.join(directory, "promotions"), rollbackRoot: path.join(directory, "rollbacks"), approval: path.join(directory, "approval.json"), active: path.join(directory, "promotions", ".active.json") };
  const installPaths = { state: production };
  const approval = { approvedAt: "2026-08-16T12:00:00.000Z", drillId, expectedEvidenceChecksumSha256: evidence, expectedInstallId: installId, expectedStateTreeDigestSha256: tree, promotionId, recoveryId, releaseVersion: "1.2.6", unitName: "boxpilot-keel-promotion.service" };
  const inspectRecovery = vi.fn(async () => ({ ready: true, recoveryId, statePath: recovery, evidenceChecksumSha256: evidence, stateTreeDigestSha256: tree }));
  const run = vi.fn(async (_binary, args) => ({ ok: args[0] !== "is-active", stdout: "", stderr: "" }));
  return { directory, production, recovery, tree, paths, installPaths, approval, inspectRecovery, run };
}

describe("fixed Keel production recovery promotion", () => {
  it("atomically promotes the exact drilled state and preserves the prior state as rollback", async () => {
    const values = await fixture();
    const result = await promoteApprovedKeel({
      ...values,
      loadApproval: async () => JSON.stringify(values.approval),
      now: () => new Date("2026-08-16T12:01:00.000Z"),
      requestHealth: async () => true,
      installHelper: { inspect: async () => ({ state: "installed", installed: true, healthy: true, installId, releaseVersion: "1.2.6" }) },
      drillHelper: { readResult: async () => ({ passed: true }) },
      account: { uid: process.getuid(), gid: process.getgid() },
    });
    const targets = pathsForKeelPromotion(promotionId, values.paths);
    expect(result).toMatchObject({ passed: true, productionStateReplaced: true, rollbackAvailable: true, healthIdentityVerified: true, sourceRecoveryUnchanged: true, ownerLoginTested: false, tailscaleChanged: false });
    expect(await readFile(path.join(values.production, "uploads", "note.txt"), "utf8")).toBe("recovered production\n");
    expect(await readFile(path.join(targets.rollbackFinalState, "uploads", "note.txt"), "utf8")).toBe("current production\n");
    expect(await readFile(path.join(values.recovery, "uploads", "note.txt"), "utf8")).toBe("recovered production\n");
    await expect(stat(values.paths.active)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await stat(targets.result)).mode & 0o7777).toBe(0o600);
  });

  it("restores the old production automatically if final source verification changes", async () => {
    const values = await fixture();
    let inspections = 0;
    values.inspectRecovery.mockImplementation(async () => {
      inspections += 1;
      return { ready: true, recoveryId, statePath: values.recovery, evidenceChecksumSha256: evidence, stateTreeDigestSha256: inspections > 1 ? "c".repeat(64) : values.tree };
    });
    await expect(promoteApprovedKeel({
      ...values,
      loadApproval: async () => JSON.stringify(values.approval),
      now: () => new Date("2026-08-16T12:01:00.000Z"),
      requestHealth: async () => true,
      installHelper: { inspect: async () => ({ state: "installed", installed: true, healthy: true, installId, releaseVersion: "1.2.6" }) },
      drillHelper: { readResult: async () => ({ passed: true }) },
      account: { uid: process.getuid(), gid: process.getgid() },
    })).rejects.toThrow("automatic rollback restored");
    const targets = pathsForKeelPromotion(promotionId, values.paths);
    expect(await readFile(path.join(values.production, "uploads", "note.txt"), "utf8")).toBe("current production\n");
    await expect(stat(values.paths.active)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(targets.result)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(targets.rollbackFinal)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects stale or expanded approval markers", async () => {
    const values = await fixture();
    expect(() => keelPromotionScriptInternals.parseApproval(JSON.stringify(values.approval), new Date("2026-08-16T12:06:00.000Z"))).toThrow("stale");
    expect(() => keelPromotionScriptInternals.parseApproval(JSON.stringify({ ...values.approval, path: "/tmp" }), new Date("2026-08-16T12:01:00.000Z"))).toThrow("identity");
  });

  it("restores old production after interruption between the two atomic state moves", async () => {
    const values = await fixture();
    const targets = pathsForKeelPromotion(promotionId, values.paths);
    await mkdir(targets.root, { recursive: true, mode: 0o700 });
    await mkdir(targets.rollbackPartial, { recursive: true, mode: 0o700 });
    await rename(values.production, targets.rollbackPartialState);
    await writeFile(values.paths.active, `${JSON.stringify({ ...values.approval, phase: "source-moved", updatedAt: "2026-08-16T12:01:30.000Z" })}\n`, { mode: 0o600 });
    await keelPromotionScriptInternals.restorePreviousProduction({ ...values.approval, phase: "source-moved", updatedAt: "2026-08-16T12:01:30.000Z" }, {
      paths: values.paths, installPaths: values.installPaths, run: values.run, requestHealth: async () => true,
    });
    expect(await readFile(path.join(values.production, "uploads", "note.txt"), "utf8")).toBe("current production\n");
    await expect(stat(targets.rollbackPartial)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(values.paths.active)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("removes the activated candidate and restores old production after interruption", async () => {
    const values = await fixture();
    const targets = pathsForKeelPromotion(promotionId, values.paths);
    await mkdir(targets.root, { recursive: true, mode: 0o700 });
    await mkdir(targets.rollbackPartial, { recursive: true, mode: 0o700 });
    await rename(values.production, targets.rollbackPartialState);
    await createState(values.production, "activated recovery");
    await writeFile(values.paths.active, `${JSON.stringify({ ...values.approval, phase: "candidate-activated", updatedAt: "2026-08-16T12:01:30.000Z" })}\n`, { mode: 0o600 });
    await keelPromotionScriptInternals.restorePreviousProduction({ ...values.approval, phase: "candidate-activated", updatedAt: "2026-08-16T12:01:30.000Z" }, {
      paths: values.paths, installPaths: values.installPaths, run: values.run, requestHealth: async () => true,
    });
    expect(await readFile(path.join(values.production, "uploads", "note.txt"), "utf8")).toBe("current production\n");
    await expect(stat(targets.candidate)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(values.paths.active)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
