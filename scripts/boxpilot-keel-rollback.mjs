#!/usr/local/bin/node
import path from "node:path";
import { chmod, cp, lstat, mkdir, open, readFile, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { validUuid } from "../server/keel-artifact-spec.mjs";
import { createKeelInstallHelper } from "../server/keel-install-helper.mjs";
import { keelInstallPaths } from "../server/keel-install-spec.mjs";
import { keelRollbackIdentity, keelRollbackPaths, pathsForKeelRollback } from "../server/keel-rollback-spec.mjs";
import { inspectKeelPromotionRollbackState } from "../server/keel-rollback-state.mjs";
import { keelBackupScriptInternals } from "./boxpilot-keel-backup.mjs";
import { keelPromotionScriptInternals } from "./boxpilot-keel-promotion.mjs";

const shaPattern = /^[a-f0-9]{64}$/;
const phases = new Set(["prepared", "current-moved", "checkpoint-activated", "displaced-published"]);
const approvalKeys = ["approvedAt", "expectedInstallId", "expectedPreviousStateTreeDigestSha256", "expectedRollbackEvidenceChecksumSha256", "promotionId", "releaseVersion", "rollbackId", "unitName"];
const { defaultHealthRequest, defaultRun, hardenState, inspectAccount, startHealthy, stopService } = keelPromotionScriptInternals;

async function metadata(target) {
  try { return await lstat(target); } catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

function exactKeys(value, expected) {
  const keys = value && typeof value === "object" && !Array.isArray(value) ? Object.keys(value).sort() : [];
  const sorted = [...expected].sort();
  return keys.length === sorted.length && keys.every((key, index) => key === sorted[index]);
}

function validateIdentity(value) {
  return exactKeys(value, approvalKeys) && validUuid(value.rollbackId) && validUuid(value.promotionId) && validUuid(value.expectedInstallId)
    && shaPattern.test(value.expectedPreviousStateTreeDigestSha256 ?? "") && shaPattern.test(value.expectedRollbackEvidenceChecksumSha256 ?? "")
    && typeof value.approvedAt === "string" && Number.isFinite(Date.parse(value.approvedAt))
    && value.releaseVersion === keelRollbackIdentity.releaseVersion && value.unitName === keelRollbackIdentity.unitName;
}

function parseApproval(raw, now = new Date()) {
  let value;
  try { value = JSON.parse(raw); } catch { throw new Error("The Keel rollback approval marker is invalid"); }
  if (!validateIdentity(value)) throw new Error("The Keel rollback approval identity changed");
  const age = now.getTime() - Date.parse(value.approvedAt);
  if (age < -30000 || age > 5 * 60 * 1000) throw new Error("The Keel rollback approval marker is stale");
  return value;
}

function parseActive(raw) {
  let value;
  try { value = JSON.parse(raw); } catch { throw new Error("The Keel rollback active marker is invalid"); }
  const identity = Object.fromEntries(approvalKeys.map((key) => [key, value?.[key]]));
  if (!exactKeys(value, [...approvalKeys, "phase", "updatedAt"]) || !validateIdentity(identity) || !phases.has(value.phase)
    || typeof value.updatedAt !== "string" || !Number.isFinite(Date.parse(value.updatedAt))) throw new Error("The Keel rollback active marker changed");
  return value;
}

async function writeActive(identity, phase, paths = keelRollbackPaths, now = new Date()) {
  const partial = pathsForKeelRollback(identity.rollbackId, paths).activePartial;
  if (await metadata(partial)) throw new Error("A Keel rollback marker partial already exists");
  await writeFile(partial, `${JSON.stringify({ ...identity, phase, updatedAt: now.toISOString() })}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
  await chmod(partial, 0o600);
  await rename(partial, paths.active);
}

async function removeDisplacedContainer(targets) {
  for (const target of [targets.displacedPartialEvidence, targets.displacedFinalEvidence]) await unlink(target).catch((error) => { if (error.code !== "ENOENT") throw error; });
  for (const target of [targets.displacedPartial, targets.displacedFinal]) await rm(target, { recursive: true, force: true });
}

async function restoreCurrentProduction(active, {
  paths = keelRollbackPaths,
  installPaths = keelInstallPaths,
  run = defaultRun,
  requestHealth = defaultHealthRequest,
} = {}) {
  const targets = pathsForKeelRollback(active.rollbackId, paths);
  await stopService(run).catch(async () => {
    const service = await run("/usr/bin/systemctl", ["is-active", "--quiet", keelRollbackIdentity.serviceUnitName]);
    if (service.ok) throw new Error("The managed Keel service could not be stopped for interrupted rollback recovery");
  });
  const displacedState = await metadata(targets.displacedPartialState) ? targets.displacedPartialState
    : await metadata(targets.displacedFinalState) ? targets.displacedFinalState : null;
  if (["current-moved", "checkpoint-activated", "displaced-published"].includes(active.phase) && !displacedState) throw new Error("The interrupted Keel rollback displaced production state is missing");
  if (["checkpoint-activated", "displaced-published"].includes(active.phase) && await metadata(installPaths.state)) {
    if (await metadata(targets.candidate)) throw new Error("The interrupted Keel rollback candidate path is occupied");
    await rename(installPaths.state, targets.candidate);
  }
  if (active.phase === "current-moved" && await metadata(installPaths.state)) throw new Error("The interrupted Keel rollback has an unexpected production state");
  if (displacedState) await rename(displacedState, installPaths.state);
  if (await metadata(targets.candidate)) await rm(targets.candidate, { recursive: true, force: true });
  await removeDisplacedContainer(targets);
  await unlink(targets.result).catch((error) => { if (error.code !== "ENOENT") throw error; });
  if (!await startHealthy(run, requestHealth)) throw new Error("The displaced current Keel production state was restored but did not recover its exact health identity");
  await unlink(targets.activePartial).catch((error) => { if (error.code !== "ENOENT") throw error; });
  await unlink(paths.active);
  await unlink(paths.approval).catch((error) => { if (error.code !== "ENOENT") throw error; });
  return { recovered: true, rollbackId: active.rollbackId, currentProductionRestored: true };
}

export async function reconcileInterruptedKeelRollback(options = {}) {
  const paths = options.paths ?? keelRollbackPaths;
  const marker = await metadata(paths.active);
  if (!marker) return { recovered: false, currentProductionRestored: false };
  if (!marker.isFile() || marker.isSymbolicLink() || marker.nlink !== 1 || marker.uid !== 0 || marker.gid !== 0
    || (marker.mode & 0o7777) !== 0o600 || marker.size > 64 * 1024) throw new Error("The Keel rollback active marker is unsafe");
  const active = parseActive(await readFile(paths.active, "utf8"));
  return restoreCurrentProduction(active, options);
}

export async function rollbackApprovedKeel({
  paths = keelRollbackPaths,
  installPaths = keelInstallPaths,
  loadApproval = () => readFile(paths.approval, "utf8"),
  now = () => new Date(),
  run = defaultRun,
  requestHealth = defaultHealthRequest,
  installHelper = createKeelInstallHelper({ inspectHealth: defaultHealthRequest }),
  inspectSource = (promotionId, options) => inspectKeelPromotionRollbackState(promotionId, options),
  account = null,
} = {}) {
  if (await metadata(paths.active)) return reconcileInterruptedKeelRollback({ paths, installPaths, run, requestHealth });
  const approval = parseApproval(await loadApproval(), now());
  const targets = pathsForKeelRollback(approval.rollbackId, paths);
  const before = await installHelper.inspect();
  if (before.state !== "installed" || before.installed !== true || before.healthy !== true || before.installId !== approval.expectedInstallId
    || before.releaseVersion !== keelRollbackIdentity.releaseVersion) throw new Error("The exact healthy Keel production installation changed before rollback");
  const source = await inspectSource(approval.promotionId, { expectedPreviousStateTreeDigestSha256: approval.expectedPreviousStateTreeDigestSha256 });
  if (source.evidenceChecksumSha256 !== approval.expectedRollbackEvidenceChecksumSha256 || source.previousInstallId !== approval.expectedInstallId) throw new Error("The retained Keel promotion checkpoint changed before rollback");
  const serviceAccount = account ?? await inspectAccount(run);
  if (!serviceAccount) throw new Error("The dedicated Keel service identity is unavailable");
  await mkdir(targets.root, { recursive: true, mode: 0o700 });
  await mkdir(targets.displacedRoot, { recursive: true, mode: 0o700 });
  await chmod(targets.root, 0o700);
  await chmod(targets.displacedRoot, 0o700);
  for (const target of [targets.candidate, targets.result, targets.activePartial, targets.displacedPartial, targets.displacedFinal]) if (await metadata(target)) throw new Error("A generated Keel rollback or displaced-state target already exists");
  await writeActive(approval, "prepared", paths, now());
  let completed = false;
  try {
    await cp(source.statePath, targets.candidate, { recursive: true, errorOnExist: true, force: false, verbatimSymlinks: true });
    await hardenState(targets.candidate, serviceAccount.uid, serviceAccount.gid);
    const candidateTree = await keelBackupScriptInternals.inspectTree(targets.candidate);
    const candidateDatabase = keelBackupScriptInternals.inspectDatabase(path.join(targets.candidate, "keel.db"));
    if (candidateTree.digest !== approval.expectedPreviousStateTreeDigestSha256 || candidateDatabase.integrityCheck !== "ok"
      || candidateDatabase.foreignKeyIssues !== 0 || candidateDatabase.schemaVerified !== true) throw new Error("The generated Keel rollback candidate failed its exact state and database checks");
    await mkdir(targets.displacedPartial, { mode: 0o700 });
    await chmod(targets.displacedPartial, 0o700);
    if ((await stat(installPaths.state)).dev !== (await stat(targets.displacedPartial)).dev || (await stat(targets.candidate)).dev !== (await stat(installPaths.state)).dev) throw new Error("Keel rollback requires production, candidate, and displaced state on one filesystem for atomic exchange");
    await stopService(run);
    const displacedTree = await keelBackupScriptInternals.inspectTree(installPaths.state);
    const displacedDatabase = keelBackupScriptInternals.inspectDatabase(path.join(installPaths.state, "keel.db"));
    if (displacedDatabase.integrityCheck !== "ok" || displacedDatabase.foreignKeyIssues !== 0 || displacedDatabase.schemaVerified !== true) throw new Error("The stopped current Keel production state is not a healthy displaced-state checkpoint");
    await rename(installPaths.state, targets.displacedPartialState);
    await writeActive(approval, "current-moved", paths, now());
    await rename(targets.candidate, installPaths.state);
    await writeActive(approval, "checkpoint-activated", paths, now());
    if (!await startHealthy(run, requestHealth)) throw new Error("The restored Keel rollback checkpoint did not return the exact health identity");
    const restoredTree = await keelBackupScriptInternals.inspectTree(installPaths.state);
    const restoredDatabase = keelBackupScriptInternals.inspectDatabase(path.join(installPaths.state, "keel.db"));
    const sourceAfter = await inspectSource(approval.promotionId, { expectedPreviousStateTreeDigestSha256: approval.expectedPreviousStateTreeDigestSha256 });
    if (restoredTree.digest !== approval.expectedPreviousStateTreeDigestSha256 || restoredDatabase.integrityCheck !== "ok"
      || restoredDatabase.foreignKeyIssues !== 0 || restoredDatabase.schemaVerified !== true
      || sourceAfter.evidenceChecksumSha256 !== approval.expectedRollbackEvidenceChecksumSha256
      || sourceAfter.stateTreeDigestSha256 !== approval.expectedPreviousStateTreeDigestSha256) throw new Error("The restored Keel state or original rollback checkpoint changed during verification");
    const checkpointEvidence = {
      schemaVersion: 1, rollbackId: approval.rollbackId, promotionId: approval.promotionId, createdAt: now().toISOString(), installId: approval.expectedInstallId,
      displacedStateTreeDigestSha256: displacedTree.digest, displacedDatabaseIntegrity: "ok", displacedForeignKeyIssues: 0,
      displacedSchemaVerified: true, statePath: targets.displacedFinalState, sourceRollbackCheckpointPreserved: true,
      operatorRequestedRollback: true, automaticFailureRecoveryAvailable: true,
    };
    const evidenceHandle = await open(targets.displacedPartialEvidence, "wx", 0o600);
    try { await evidenceHandle.writeFile(`${JSON.stringify(checkpointEvidence, null, 2)}\n`, "utf8"); await evidenceHandle.sync(); } finally { await evidenceHandle.close(); }
    await chmod(targets.displacedPartialEvidence, 0o600);
    await rename(targets.displacedPartial, targets.displacedFinal);
    await writeActive(approval, "displaced-published", paths, now());
    const result = {
      schemaVersion: 1, passed: true, rollbackId: approval.rollbackId, promotionId: approval.promotionId, applicationId: "keel",
      releaseVersion: keelRollbackIdentity.releaseVersion, installId: approval.expectedInstallId,
      sourceRollbackEvidenceChecksumSha256: approval.expectedRollbackEvidenceChecksumSha256,
      sourcePreviousStateTreeDigestSha256: approval.expectedPreviousStateTreeDigestSha256,
      restoredStateTreeDigestSha256: restoredTree.digest, displacedStateTreeDigestSha256: displacedTree.digest,
      displacedStatePath: targets.displacedFinalState, displacedEvidencePath: targets.displacedFinalEvidence, displacedStateRetained: true,
      sourceRollbackCheckpointUnchanged: true, rollbackRequested: true, productionStateReplaced: true, healthIdentityVerified: true,
      databaseIntegrity: "ok", foreignKeyIssues: 0, schemaVerified: true, automaticFailureRecoveryTested: false,
      ownerLoginTested: false, network: keelRollbackIdentity.network, publishedPortsChanged: false, tailscaleChanged: false,
      firewallChanged: false, routerChanged: false, browserPathAccepted: false, browserCommandAccepted: false, browserTokenAccepted: false,
    };
    const resultHandle = await open(targets.result, "wx", 0o600);
    try { await resultHandle.writeFile(`${JSON.stringify(result, null, 2)}\n`, "utf8"); await resultHandle.sync(); } finally { await resultHandle.close(); }
    await chmod(targets.result, 0o600);
    completed = true;
    await unlink(paths.active);
    return result;
  } catch (error) {
    const marker = await metadata(paths.active);
    if (marker) {
      const active = parseActive(await readFile(paths.active, "utf8"));
      await restoreCurrentProduction(active, { paths, installPaths, run, requestHealth });
      throw new Error(`${error instanceof Error ? error.message : String(error)}; automatic recovery restored the displaced healthy Keel production state`);
    }
    throw error;
  } finally {
    if (!completed && await metadata(targets.candidate)) await rm(targets.candidate, { recursive: true, force: true });
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
if (invokedPath === import.meta.url) {
  if (process.argv.length !== 2) {
    console.error("The fixed Keel operator rollback accepts no arguments");
    process.exitCode = 64;
  } else {
    try {
      const result = await rollbackApprovedKeel();
      console.log(result.recovered ? `Recovered interrupted Keel rollback ${result.rollbackId}` : `Restored Keel promotion checkpoint ${result.promotionId} with displaced state ${result.displacedStatePath}`);
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  }
}

export const keelRollbackScriptInternals = { exactKeys, parseActive, parseApproval, restoreCurrentProduction, writeActive };
