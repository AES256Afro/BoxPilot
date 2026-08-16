import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import path from "node:path";
import { lstat, readFile } from "node:fs/promises";
import { validUuid } from "./keel-artifact-spec.mjs";
import { pathsForKeelPromotion } from "./keel-promotion-spec.mjs";
import { keelBackupScriptInternals } from "../scripts/boxpilot-keel-backup.mjs";

const shaPattern = /^[a-f0-9]{64}$/;
const evidenceKeys = ["automaticRollbackAvailable", "createdAt", "drillId", "previousDatabaseIntegrity", "previousForeignKeyIssues", "previousInstallId", "previousSchemaVerified", "previousStateTreeDigestSha256", "productionServiceStoppedForCheckpoint", "promotionId", "recoveryId", "schemaVersion", "statePath"];

function exactKeys(value, expected) {
  const keys = value && typeof value === "object" && !Array.isArray(value) ? Object.keys(value).sort() : [];
  const sorted = [...expected].sort();
  return keys.length === sorted.length && keys.every((key, index) => key === sorted[index]);
}

async function sha256(file) {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(file)) digest.update(chunk);
  return digest.digest("hex");
}

async function metadata(target) {
  try { return await lstat(target); } catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

export async function inspectKeelPromotionRollbackState(promotionId, {
  expectedPreviousStateTreeDigestSha256,
  promotionPaths,
  expectedRootUid = 0,
  expectedRootGid = 0,
} = {}) {
  if (!validUuid(promotionId)) throw new Error("Keel promotion id must be a UUID");
  if (expectedPreviousStateTreeDigestSha256 !== undefined && !shaPattern.test(expectedPreviousStateTreeDigestSha256)) throw new Error("Previous state tree digest must be a SHA-256 digest");
  const targets = pathsForKeelPromotion(promotionId, promotionPaths);
  const container = await metadata(targets.rollbackFinal);
  const state = await metadata(targets.rollbackFinalState);
  const evidenceMetadata = await metadata(targets.rollbackFinalEvidence);
  if (!container?.isDirectory() || container.isSymbolicLink() || container.uid !== expectedRootUid || container.gid !== expectedRootGid || (container.mode & 0o7777) !== 0o700) throw new Error("The Keel promotion rollback container is missing or unsafe");
  if (!state?.isDirectory() || state.isSymbolicLink() || (state.mode & 0o7777) !== 0o700) throw new Error("The Keel promotion rollback state is missing or unsafe");
  if (!evidenceMetadata?.isFile() || evidenceMetadata.isSymbolicLink() || evidenceMetadata.nlink !== 1 || evidenceMetadata.uid !== expectedRootUid
    || evidenceMetadata.gid !== expectedRootGid || (evidenceMetadata.mode & 0o7777) !== 0o600 || evidenceMetadata.size > 64 * 1024) throw new Error("The Keel promotion rollback evidence is missing or unsafe");
  let evidence;
  try { evidence = JSON.parse(await readFile(targets.rollbackFinalEvidence, "utf8")); } catch { throw new Error("The Keel promotion rollback evidence is invalid"); }
  if (!exactKeys(evidence, evidenceKeys) || evidence.schemaVersion !== 1 || evidence.promotionId !== promotionId
    || !validUuid(evidence.recoveryId) || !validUuid(evidence.drillId) || !validUuid(evidence.previousInstallId)
    || !shaPattern.test(evidence.previousStateTreeDigestSha256 ?? "") || evidence.previousDatabaseIntegrity !== "ok"
    || evidence.previousForeignKeyIssues !== 0 || evidence.previousSchemaVerified !== true || evidence.statePath !== targets.rollbackFinalState
    || evidence.productionServiceStoppedForCheckpoint !== true || evidence.automaticRollbackAvailable !== true
    || typeof evidence.createdAt !== "string" || !Number.isFinite(Date.parse(evidence.createdAt))) throw new Error("The Keel promotion rollback evidence changed or failed its fixed contract");
  if (expectedPreviousStateTreeDigestSha256 !== undefined && evidence.previousStateTreeDigestSha256 !== expectedPreviousStateTreeDigestSha256) throw new Error("The Keel promotion rollback digest does not match durable promotion evidence");
  const tree = await keelBackupScriptInternals.inspectTree(targets.rollbackFinalState);
  const database = keelBackupScriptInternals.inspectDatabase(path.join(targets.rollbackFinalState, "keel.db"));
  if (tree.digest !== evidence.previousStateTreeDigestSha256 || database.integrityCheck !== "ok" || database.foreignKeyIssues !== 0 || database.schemaVerified !== true) throw new Error("The Keel promotion rollback state changed or is unhealthy");
  return {
    ready: true,
    promotionId,
    recoveryId: evidence.recoveryId,
    drillId: evidence.drillId,
    previousInstallId: evidence.previousInstallId,
    statePath: targets.rollbackFinalState,
    evidencePath: targets.rollbackFinalEvidence,
    evidenceChecksumSha256: await sha256(targets.rollbackFinalEvidence),
    stateTreeDigestSha256: tree.digest,
    databaseIntegrity: "ok",
    foreignKeyIssues: 0,
    schemaVerified: true,
  };
}

export const keelRollbackStateInternals = { exactKeys, sha256 };
