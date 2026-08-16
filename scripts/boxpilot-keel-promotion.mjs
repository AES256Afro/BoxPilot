#!/usr/local/bin/node
import { execFile as execFileCallback } from "node:child_process";
import http from "node:http";
import path from "node:path";
import { promisify } from "node:util";
import { chmod, chown, cp, lstat, mkdir, open, readFile, readdir, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { validUuid } from "../server/keel-artifact-spec.mjs";
import { createKeelInstallHelper } from "../server/keel-install-helper.mjs";
import { keelInstallPaths, keelServiceIdentity } from "../server/keel-install-spec.mjs";
import { createKeelRecoveryDrillHelper } from "../server/keel-recovery-drill-helper.mjs";
import { inspectKeelRecoveryState } from "../server/keel-recovery-state.mjs";
import { keelPromotionIdentity, keelPromotionPaths, pathsForKeelPromotion } from "../server/keel-promotion-spec.mjs";
import { keelBackupScriptInternals } from "./boxpilot-keel-backup.mjs";

const execFile = promisify(execFileCallback);
const shaPattern = /^[a-f0-9]{64}$/;
const phases = new Set(["prepared", "source-moved", "candidate-activated", "rollback-published"]);
const fixedBinaries = Object.freeze({ getent: "/usr/bin/getent", systemctl: "/usr/bin/systemctl" });
const approvalKeys = ["approvedAt", "drillId", "expectedEvidenceChecksumSha256", "expectedInstallId", "expectedStateTreeDigestSha256", "promotionId", "recoveryId", "releaseVersion", "unitName"];

async function metadata(target) {
  try { return await lstat(target); } catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

async function defaultRun(binary, args, { timeout = 30000 } = {}) {
  try {
    const result = await execFile(binary, args, { timeout, maxBuffer: 256 * 1024, encoding: "utf8", env: { PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin", LANG: "C.UTF-8", LC_ALL: "C.UTF-8" } });
    return { ok: true, stdout: result.stdout.trim(), stderr: result.stderr.trim() };
  } catch (error) {
    return { ok: false, stdout: String(error.stdout ?? "").trim(), stderr: String(error.stderr ?? "").trim() };
  }
}

function exactKeys(value, expected) {
  const keys = value && typeof value === "object" && !Array.isArray(value) ? Object.keys(value).sort() : [];
  const sorted = [...expected].sort();
  return keys.length === sorted.length && keys.every((key, index) => key === sorted[index]);
}

function validateIdentity(value) {
  return exactKeys(value, approvalKeys)
    && validUuid(value.promotionId) && validUuid(value.recoveryId) && validUuid(value.drillId) && validUuid(value.expectedInstallId)
    && shaPattern.test(value.expectedEvidenceChecksumSha256 ?? "") && shaPattern.test(value.expectedStateTreeDigestSha256 ?? "")
    && typeof value.approvedAt === "string" && Number.isFinite(Date.parse(value.approvedAt))
    && value.releaseVersion === keelPromotionIdentity.releaseVersion && value.unitName === keelPromotionIdentity.unitName;
}

function parseApproval(raw, now = new Date()) {
  let value;
  try { value = JSON.parse(raw); } catch { throw new Error("The Keel promotion approval marker is invalid"); }
  if (!validateIdentity(value)) throw new Error("The Keel promotion approval identity changed");
  const age = now.getTime() - Date.parse(value.approvedAt);
  if (age < -30000 || age > 5 * 60 * 1000) throw new Error("The Keel promotion approval marker is stale");
  return value;
}

function parseActive(raw) {
  let value;
  try { value = JSON.parse(raw); } catch { throw new Error("The Keel promotion active marker is invalid"); }
  const identity = Object.fromEntries(approvalKeys.map((key) => [key, value?.[key]]));
  if (!exactKeys(value, [...approvalKeys, "phase", "updatedAt"]) || !validateIdentity(identity) || !phases.has(value.phase)
    || typeof value.updatedAt !== "string" || !Number.isFinite(Date.parse(value.updatedAt))) throw new Error("The Keel promotion active marker changed");
  return value;
}

async function writeActive(identity, phase, paths = keelPromotionPaths, now = new Date()) {
  const partial = pathsForKeelPromotion(identity.promotionId, paths).activePartial;
  if (await metadata(partial)) throw new Error("A Keel promotion marker partial already exists");
  await writeFile(partial, `${JSON.stringify({ ...identity, phase, updatedAt: now.toISOString() })}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
  await chmod(partial, 0o600);
  await rename(partial, paths.active);
}

async function inspectAccount(run = defaultRun) {
  const [passwdResult, groupResult] = await Promise.all([
    run(fixedBinaries.getent, ["passwd", keelServiceIdentity.account]),
    run(fixedBinaries.getent, ["group", keelServiceIdentity.group]),
  ]);
  if (!passwdResult.ok || !groupResult.ok) return null;
  const passwd = passwdResult.stdout.split(":");
  const group = groupResult.stdout.split(":");
  const uid = Number.parseInt(passwd[2], 10);
  const gid = Number.parseInt(group[2], 10);
  if (passwd.length !== 7 || group.length !== 4 || passwd[0] !== keelServiceIdentity.account || group[0] !== keelServiceIdentity.group
    || !Number.isInteger(uid) || !Number.isInteger(gid) || Number.parseInt(passwd[3], 10) !== gid
    || passwd[5] !== keelInstallPaths.state || !["/usr/sbin/nologin", "/sbin/nologin"].includes(passwd[6])) return null;
  return { uid, gid };
}

async function hardenState(root, uid, gid) {
  const stack = [root];
  while (stack.length > 0) {
    const target = stack.pop();
    const value = await lstat(target);
    if (value.isSymbolicLink()) throw new Error("The Keel promotion candidate contains a symbolic link");
    if (value.isDirectory()) {
      await chown(target, uid, gid);
      await chmod(target, 0o700);
      for (const name of await readdir(target)) stack.push(path.join(target, name));
    } else {
      if (!value.isFile() || value.nlink !== 1) throw new Error("The Keel promotion candidate contains an unsafe file");
      await chown(target, uid, gid);
      await chmod(target, 0o600);
    }
  }
}

async function defaultHealthRequest() {
  return new Promise((resolve) => {
    const request = http.get({ hostname: keelServiceIdentity.bindAddress, port: keelServiceIdentity.port, path: "/api/health", timeout: 2500 }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { body += chunk; if (body.length > 8192) request.destroy(); });
      response.on("end", () => {
        try { const value = JSON.parse(body); resolve(response.statusCode === 200 && value?.app === "keel" && value?.ok === true); } catch { resolve(false); }
      });
    });
    request.once("timeout", () => request.destroy());
    request.once("error", () => resolve(false));
  });
}

async function waitForHealth(requestHealth = defaultHealthRequest) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (await requestHealth()) return true;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  return false;
}

async function stopService(run = defaultRun) {
  const stopped = await run(fixedBinaries.systemctl, ["stop", keelPromotionIdentity.serviceUnitName], { timeout: 60000 });
  if (!stopped.ok) throw new Error("The managed Keel service could not be stopped for promotion");
  const active = await run(fixedBinaries.systemctl, ["is-active", "--quiet", keelPromotionIdentity.serviceUnitName]);
  if (active.ok) throw new Error("The managed Keel service remained active during promotion");
}

async function startHealthy(run = defaultRun, requestHealth = defaultHealthRequest) {
  const started = await run(fixedBinaries.systemctl, ["start", keelPromotionIdentity.serviceUnitName], { timeout: 120000 });
  return started.ok && await waitForHealth(requestHealth);
}

async function removeRollbackContainer(targets) {
  for (const target of [targets.rollbackPartialEvidence, targets.rollbackFinalEvidence]) await unlink(target).catch((error) => { if (error.code !== "ENOENT") throw error; });
  for (const target of [targets.rollbackPartial, targets.rollbackFinal]) await rm(target, { recursive: true, force: true });
}

async function restorePreviousProduction(active, {
  paths = keelPromotionPaths,
  installPaths = keelInstallPaths,
  run = defaultRun,
  requestHealth = defaultHealthRequest,
} = {}) {
  const targets = pathsForKeelPromotion(active.promotionId, paths);
  await stopService(run).catch(async () => {
    const service = await run(fixedBinaries.systemctl, ["is-active", "--quiet", keelPromotionIdentity.serviceUnitName]);
    if (service.ok) throw new Error("The managed Keel service could not be stopped for interrupted-promotion recovery");
  });
  const rollbackState = await metadata(targets.rollbackPartialState) ? targets.rollbackPartialState
    : await metadata(targets.rollbackFinalState) ? targets.rollbackFinalState : null;
  if (["source-moved", "candidate-activated", "rollback-published"].includes(active.phase) && !rollbackState) throw new Error("The interrupted Keel promotion rollback state is missing");
  if (["candidate-activated", "rollback-published"].includes(active.phase) && await metadata(installPaths.state)) {
    if (await metadata(targets.candidate)) throw new Error("The interrupted Keel promotion candidate path is occupied");
    await rename(installPaths.state, targets.candidate);
  }
  if (active.phase === "source-moved" && await metadata(installPaths.state)) throw new Error("The interrupted Keel promotion has an unexpected production state");
  if (rollbackState) await rename(rollbackState, installPaths.state);
  if (await metadata(targets.candidate)) await rm(targets.candidate, { recursive: true, force: true });
  await removeRollbackContainer(targets);
  await unlink(targets.result).catch((error) => { if (error.code !== "ENOENT") throw error; });
  if (!await startHealthy(run, requestHealth)) throw new Error("The previous Keel production state was restored but did not recover its exact health identity");
  await unlink(targets.activePartial).catch((error) => { if (error.code !== "ENOENT") throw error; });
  await unlink(paths.active);
  await unlink(paths.approval).catch((error) => { if (error.code !== "ENOENT") throw error; });
  return { recovered: true, promotionId: active.promotionId, previousProductionRestored: true };
}

export async function reconcileInterruptedKeelPromotion(options = {}) {
  const paths = options.paths ?? keelPromotionPaths;
  const marker = await metadata(paths.active);
  if (!marker) return { recovered: false, previousProductionRestored: false };
  if (!marker.isFile() || marker.isSymbolicLink() || marker.nlink !== 1 || marker.uid !== 0 || marker.gid !== 0 || (marker.mode & 0o7777) !== 0o600 || marker.size > 64 * 1024) throw new Error("The Keel promotion active marker is unsafe");
  const active = parseActive(await readFile(paths.active, "utf8"));
  return restorePreviousProduction(active, options);
}

export async function promoteApprovedKeel({
  paths = keelPromotionPaths,
  installPaths = keelInstallPaths,
  loadApproval = () => readFile(paths.approval, "utf8"),
  now = () => new Date(),
  run = defaultRun,
  requestHealth = defaultHealthRequest,
  installHelper = createKeelInstallHelper({ inspectHealth: defaultHealthRequest }),
  inspectRecovery = (recoveryId) => inspectKeelRecoveryState(recoveryId),
  drillHelper = createKeelRecoveryDrillHelper(),
  account = null,
} = {}) {
  if (await metadata(paths.active)) return reconcileInterruptedKeelPromotion({ paths, installPaths, run, requestHealth });
  const approval = parseApproval(await loadApproval(), now());
  const targets = pathsForKeelPromotion(approval.promotionId, paths);
  const before = await installHelper.inspect();
  if (before.state !== "installed" || before.installed !== true || before.healthy !== true || before.installId !== approval.expectedInstallId
    || before.releaseVersion !== keelPromotionIdentity.releaseVersion) throw new Error("The exact healthy Keel production installation changed before promotion");
  const recovery = await inspectRecovery(approval.recoveryId);
  if (recovery.evidenceChecksumSha256 !== approval.expectedEvidenceChecksumSha256 || recovery.stateTreeDigestSha256 !== approval.expectedStateTreeDigestSha256) throw new Error("The stopped Keel recovery changed before promotion");
  await drillHelper.readResult({
    drillId: approval.drillId,
    recoveryId: approval.recoveryId,
    expectedEvidenceChecksumSha256: approval.expectedEvidenceChecksumSha256,
    expectedStateTreeDigestSha256: approval.expectedStateTreeDigestSha256,
  });
  const serviceAccount = account ?? await inspectAccount(run);
  if (!serviceAccount) throw new Error("The dedicated Keel service identity is unavailable");
  await mkdir(targets.root, { recursive: true, mode: 0o700 });
  await mkdir(targets.rollbackRoot, { recursive: true, mode: 0o700 });
  await chmod(targets.root, 0o700);
  await chmod(targets.rollbackRoot, 0o700);
  for (const target of [targets.candidate, targets.result, targets.activePartial, targets.rollbackPartial, targets.rollbackFinal]) if (await metadata(target)) throw new Error("A generated Keel promotion or rollback target already exists");
  await writeActive(approval, "prepared", paths, now());
  let completed = false;
  try {
    await cp(recovery.statePath, targets.candidate, { recursive: true, errorOnExist: true, force: false, verbatimSymlinks: true });
    await hardenState(targets.candidate, serviceAccount.uid, serviceAccount.gid);
    const candidateTree = await keelBackupScriptInternals.inspectTree(targets.candidate);
    const candidateDatabase = keelBackupScriptInternals.inspectDatabase(path.join(targets.candidate, "keel.db"));
    if (candidateTree.digest !== approval.expectedStateTreeDigestSha256 || candidateDatabase.integrityCheck !== "ok"
      || candidateDatabase.foreignKeyIssues !== 0 || candidateDatabase.schemaVerified !== true) throw new Error("The generated Keel promotion candidate failed its exact state and database checks");
    await mkdir(targets.rollbackPartial, { mode: 0o700 });
    await chmod(targets.rollbackPartial, 0o700);
    if ((await stat(installPaths.state)).dev !== (await stat(targets.rollbackPartial)).dev || (await stat(targets.candidate)).dev !== (await stat(installPaths.state)).dev) throw new Error("Keel promotion requires production, candidate, and rollback state on one filesystem for atomic exchange");
    await stopService(run);
    const previousTree = await keelBackupScriptInternals.inspectTree(installPaths.state);
    const previousDatabase = keelBackupScriptInternals.inspectDatabase(path.join(installPaths.state, "keel.db"));
    if (previousDatabase.integrityCheck !== "ok" || previousDatabase.foreignKeyIssues !== 0 || previousDatabase.schemaVerified !== true) throw new Error("The stopped current Keel production state is not a healthy rollback checkpoint");
    await rename(installPaths.state, targets.rollbackPartialState);
    await writeActive(approval, "source-moved", paths, now());
    await rename(targets.candidate, installPaths.state);
    await writeActive(approval, "candidate-activated", paths, now());
    if (!await startHealthy(run, requestHealth)) throw new Error("The promoted Keel state did not return the exact health identity");
    const promotedTree = await keelBackupScriptInternals.inspectTree(installPaths.state);
    const promotedDatabase = keelBackupScriptInternals.inspectDatabase(path.join(installPaths.state, "keel.db"));
    const sourceAfter = await inspectRecovery(approval.recoveryId);
    if (promotedTree.digest !== approval.expectedStateTreeDigestSha256 || promotedDatabase.integrityCheck !== "ok"
      || promotedDatabase.foreignKeyIssues !== 0 || promotedDatabase.schemaVerified !== true
      || sourceAfter.evidenceChecksumSha256 !== approval.expectedEvidenceChecksumSha256
      || sourceAfter.stateTreeDigestSha256 !== approval.expectedStateTreeDigestSha256) throw new Error("The promoted Keel state or source recovery changed during verification");
    const rollbackEvidence = {
      schemaVersion: 1, promotionId: approval.promotionId, recoveryId: approval.recoveryId, drillId: approval.drillId,
      createdAt: now().toISOString(), previousInstallId: approval.expectedInstallId, previousStateTreeDigestSha256: previousTree.digest,
      previousDatabaseIntegrity: "ok", previousForeignKeyIssues: 0, previousSchemaVerified: true,
      statePath: targets.rollbackFinalState, productionServiceStoppedForCheckpoint: true, automaticRollbackAvailable: true,
    };
    const evidenceHandle = await open(targets.rollbackPartialEvidence, "wx", 0o600);
    try { await evidenceHandle.writeFile(`${JSON.stringify(rollbackEvidence, null, 2)}\n`, "utf8"); await evidenceHandle.sync(); } finally { await evidenceHandle.close(); }
    await chmod(targets.rollbackPartialEvidence, 0o600);
    await rename(targets.rollbackPartial, targets.rollbackFinal);
    await writeActive(approval, "rollback-published", paths, now());
    const result = {
      schemaVersion: 1, passed: true, promotionId: approval.promotionId, recoveryId: approval.recoveryId, drillId: approval.drillId,
      applicationId: "keel", releaseVersion: keelPromotionIdentity.releaseVersion, previousInstallId: approval.expectedInstallId,
      sourceEvidenceChecksumSha256: approval.expectedEvidenceChecksumSha256, sourceStateTreeDigestSha256: approval.expectedStateTreeDigestSha256,
      previousStateTreeDigestSha256: previousTree.digest, promotedStateTreeDigestSha256: promotedTree.digest,
      rollbackPath: targets.rollbackFinalState, rollbackEvidencePath: targets.rollbackFinalEvidence, rollbackAvailable: true,
      healthIdentityVerified: true, databaseIntegrity: "ok", foreignKeyIssues: 0, schemaVerified: true,
      productionStateReplaced: true, sourceRecoveryUnchanged: true, automaticRollbackTestedOnFailure: false,
      registrationStateRestoredFromRecovery: true, claimStateRestoredFromRecovery: true, ownerLoginTested: false,
      network: keelPromotionIdentity.network, publishedPortsChanged: false, tailscaleChanged: false, firewallChanged: false, routerChanged: false,
      browserPathAccepted: false, browserCommandAccepted: false, browserTokenAccepted: false,
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
      await restorePreviousProduction(active, { paths, installPaths, run, requestHealth });
      throw new Error(`${error.message}; automatic rollback restored the previous healthy Keel production state`);
    }
    throw error;
  } finally {
    if (!completed && await metadata(targets.candidate)) await rm(targets.candidate, { recursive: true, force: true });
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
if (invokedPath === import.meta.url) {
  if (process.argv.length !== 2) {
    console.error("The fixed Keel production promotion accepts no arguments");
    process.exitCode = 64;
  } else {
    try {
      const result = await promoteApprovedKeel();
      console.log(result.recovered ? `Recovered interrupted Keel promotion ${result.promotionId}` : `Promoted Keel recovery ${result.recoveryId} with rollback ${result.rollbackPath}`);
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  }
}

export const keelPromotionScriptInternals = { exactKeys, hardenState, inspectAccount, parseActive, parseApproval, restorePreviousProduction, waitForHealth, writeActive };
