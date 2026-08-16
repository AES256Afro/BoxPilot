import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import path from "node:path";
import { lstat, readFile } from "node:fs/promises";
import { validUuid } from "./keel-artifact-spec.mjs";
import { pathsForKeelRecovery } from "./keel-recovery-spec.mjs";
import { keelBackupScriptInternals } from "../scripts/boxpilot-keel-backup.mjs";

const shaPattern = /^[a-f0-9]{64}$/;

async function sha256(file) {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(file)) digest.update(chunk);
  return digest.digest("hex");
}

async function safeNode(target, type, uid, gid, mode) {
  const value = await lstat(target);
  const wrongType = type === "directory" ? !value.isDirectory() : !value.isFile();
  const unsafeLinks = type === "file" && value.nlink !== 1;
  if (wrongType || value.isSymbolicLink() || unsafeLinks || value.uid !== uid || value.gid !== gid || (value.mode & 0o7777) !== mode) throw new Error(`The published Keel recovery ${type} is unsafe`);
  return value;
}

export async function inspectKeelRecoveryState(recoveryId, { recoveryPaths, expectedRootUid = 0, expectedRootGid = 0 } = {}) {
  if (!validUuid(recoveryId)) throw new Error("Keel recovery id must be a UUID");
  const targets = pathsForKeelRecovery(recoveryId, recoveryPaths);
  await safeNode(targets.final, "directory", expectedRootUid, expectedRootGid, 0o700);
  await safeNode(targets.finalState, "directory", expectedRootUid, expectedRootGid, 0o700);
  const evidenceMetadata = await safeNode(targets.finalEvidence, "file", expectedRootUid, expectedRootGid, 0o600);
  if (evidenceMetadata.size > 64 * 1024) throw new Error("The published Keel recovery evidence is too large");
  let evidence;
  try { evidence = JSON.parse(await readFile(targets.finalEvidence, "utf8")); } catch { throw new Error("The published Keel recovery evidence is invalid"); }
  if (evidence?.schemaVersion !== 1 || evidence?.recoveryId !== recoveryId || !validUuid(evidence?.backupId)
    || evidence?.destination !== "managed-keel-recovery" || evidence?.statePath !== targets.finalState
    || !shaPattern.test(evidence?.sourceArtifactChecksumSha256 ?? "") || !shaPattern.test(evidence?.sourceManifestChecksumSha256 ?? "")
    || !shaPattern.test(evidence?.restoredTreeDigestSha256 ?? "") || !Number.isSafeInteger(evidence?.sourceSizeBytes) || evidence.sourceSizeBytes < 1
    || evidence?.databaseIntegrity !== "ok" || evidence?.foreignKeyIssues !== 0 || evidence?.schemaVerified !== true
    || evidence?.environmentIncluded !== true || evidence?.initialState !== "stopped" || evidence?.network !== "none"
    || evidence?.applicationStarted !== false || evidence?.productionStateReplaced !== false || evidence?.sourceArtifactChanged !== false
    || evidence?.browserPathAccepted !== false || evidence?.browserCommandAccepted !== false || evidence?.promotionPerformed !== false) throw new Error("The published Keel recovery evidence does not match the fixed stopped-state contract");
  const tree = await keelBackupScriptInternals.inspectTree(targets.finalState);
  if (tree.digest !== evidence.restoredTreeDigestSha256 || tree.regularFiles !== evidence.restoredRegularFiles
    || tree.directories !== evidence.restoredDirectories || tree.bytes !== evidence.restoredLogicalBytes) throw new Error("The published Keel recovery state changed after creation");
  const database = keelBackupScriptInternals.inspectDatabase(path.join(targets.finalState, "keel.db"));
  if (database.integrityCheck !== "ok" || database.foreignKeyIssues !== 0 || database.schemaVerified !== true) throw new Error("The published Keel recovery database is not healthy");
  return {
    ready: true,
    recoveryId,
    backupId: evidence.backupId,
    statePath: targets.finalState,
    evidencePath: targets.finalEvidence,
    evidenceChecksumSha256: await sha256(targets.finalEvidence),
    stateTreeDigestSha256: tree.digest,
    stateLogicalBytes: tree.bytes,
    stateRegularFiles: tree.regularFiles,
    stateDirectories: tree.directories,
    databaseIntegrity: "ok",
    foreignKeyIssues: 0,
    schemaVerified: true,
    initialState: "stopped",
    network: "none",
    applicationStarted: false,
    productionStateReplaced: false,
  };
}

export const keelRecoveryStateInternals = { safeNode, sha256 };
