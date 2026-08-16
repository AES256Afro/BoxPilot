import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { pathsForKeelPromotion } from "./keel-promotion-spec.mjs";
import { inspectKeelPromotionRollbackState } from "./keel-rollback-state.mjs";
import { keelBackupScriptInternals } from "../scripts/boxpilot-keel-backup.mjs";

const directories = [];
const promotionId = "33333333-3333-4333-8333-333333333333";
const recoveryId = "11111111-1111-4111-8111-111111111111";
const drillId = "22222222-2222-4222-8222-222222222222";
const installId = "44444444-4444-4444-8444-444444444444";

afterEach(async () => Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))));

async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "boxpilot-keel-rollback-state-"));
  directories.push(directory);
  const paths = { root: path.join(directory, "promotions"), rollbackRoot: path.join(directory, "promotion-rollbacks"), approval: path.join(directory, "approval.json"), active: path.join(directory, "promotions", ".active.json") };
  const targets = pathsForKeelPromotion(promotionId, paths);
  await mkdir(path.join(targets.rollbackFinalState, "uploads"), { recursive: true, mode: 0o700 });
  await chmod(targets.rollbackFinal, 0o700);
  await chmod(targets.rollbackFinalState, 0o700);
  const database = new DatabaseSync(path.join(targets.rollbackFinalState, "keel.db"));
  for (const table of ["AppSetting", "Page", "User", "Workspace"]) database.exec(`CREATE TABLE ${table} (id INTEGER PRIMARY KEY);`);
  database.close();
  await writeFile(path.join(targets.rollbackFinalState, ".env"), "DATABASE_URL=file:/var/lib/keel/keel.db\nPORT=3000\n", { mode: 0o600 });
  await writeFile(path.join(targets.rollbackFinalState, "uploads", "note.txt"), "retained prior production\n", { mode: 0o600 });
  const tree = (await keelBackupScriptInternals.inspectTree(targets.rollbackFinalState)).digest;
  await writeFile(targets.rollbackFinalEvidence, `${JSON.stringify({
    schemaVersion: 1, promotionId, recoveryId, drillId, previousInstallId: installId, previousStateTreeDigestSha256: tree,
    previousDatabaseIntegrity: "ok", previousForeignKeyIssues: 0, previousSchemaVerified: true,
    statePath: targets.rollbackFinalState, productionServiceStoppedForCheckpoint: true, automaticRollbackAvailable: true,
    createdAt: "2026-08-16T12:00:00.000Z",
  })}\n`, { mode: 0o600 });
  await chmod(targets.rollbackFinalEvidence, 0o600);
  return { paths, targets, tree };
}

describe("retained Keel promotion rollback checkpoint inspection", () => {
  it("requires exact root-only evidence, complete tree identity, and healthy SQLite", async () => {
    const values = await fixture();
    await expect(inspectKeelPromotionRollbackState(promotionId, {
      promotionPaths: values.paths,
      expectedPreviousStateTreeDigestSha256: values.tree,
      expectedRootUid: process.getuid(), expectedRootGid: process.getgid(),
    })).resolves.toMatchObject({ ready: true, promotionId, previousInstallId: installId, stateTreeDigestSha256: values.tree, databaseIntegrity: "ok" });
  });

  it("rejects checkpoint content changed after promotion", async () => {
    const values = await fixture();
    await writeFile(path.join(values.targets.rollbackFinalState, "uploads", "note.txt"), "tampered\n", { mode: 0o600 });
    await expect(inspectKeelPromotionRollbackState(promotionId, {
      promotionPaths: values.paths,
      expectedPreviousStateTreeDigestSha256: values.tree,
      expectedRootUid: process.getuid(), expectedRootGid: process.getgid(),
    })).rejects.toThrow("changed or is unhealthy");
  });
});
