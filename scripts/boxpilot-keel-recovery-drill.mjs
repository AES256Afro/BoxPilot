#!/usr/local/bin/node
import { execFile as execFileCallback, spawn as spawnCallback } from "node:child_process";
import http from "node:http";
import path from "node:path";
import { promisify } from "node:util";
import { chmod, chown, cp, lstat, mkdir, open, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { validUuid } from "../server/keel-artifact-spec.mjs";
import { keelInstallPaths, keelServiceIdentity } from "../server/keel-install-spec.mjs";
import { inspectKeelRecoveryState } from "../server/keel-recovery-state.mjs";
import { keelRecoveryPaths } from "../server/keel-recovery-spec.mjs";
import { keelRecoveryDrillEnvironment, keelRecoveryDrillIdentity, keelRecoveryDrillPaths, pathsForKeelRecoveryDrill } from "../server/keel-recovery-drill-spec.mjs";
import { keelBackupScriptInternals } from "./boxpilot-keel-backup.mjs";

const execFile = promisify(execFileCallback);
const shaPattern = /^[a-f0-9]{64}$/;
const fixedBinaries = Object.freeze({ getent: "/usr/bin/getent", node: "/usr/local/bin/node", systemctl: "/usr/bin/systemctl" });

async function metadata(target) {
  try { return await lstat(target); } catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

function parseApproval(raw, now = new Date()) {
  let value;
  try { value = JSON.parse(raw); } catch { throw new Error("The Keel recovery drill approval marker is invalid"); }
  const expectedKeys = ["approvedAt", "drillId", "expectedEvidenceChecksumSha256", "expectedStateTreeDigestSha256", "recoveryId", "releaseVersion", "unitName"];
  const keys = value && typeof value === "object" && !Array.isArray(value) ? Object.keys(value).sort() : [];
  if (keys.length !== expectedKeys.length || keys.some((key, index) => key !== expectedKeys[index])) throw new Error("The Keel recovery drill approval marker has unexpected fields");
  if (!validUuid(value.drillId) || !validUuid(value.recoveryId) || !shaPattern.test(value.expectedEvidenceChecksumSha256 ?? "")
    || !shaPattern.test(value.expectedStateTreeDigestSha256 ?? "") || value.releaseVersion !== keelRecoveryDrillIdentity.releaseVersion
    || value.unitName !== keelRecoveryDrillIdentity.unitName || typeof value.approvedAt !== "string") throw new Error("The approved Keel recovery drill identity changed");
  const approvedTime = Date.parse(value.approvedAt);
  const age = now.getTime() - approvedTime;
  if (!Number.isFinite(approvedTime) || age < -30000 || age > 5 * 60 * 1000) throw new Error("The Keel recovery drill approval marker is stale");
  return value;
}

async function defaultRun(binary, args, options = {}) {
  try {
    const result = await execFile(binary, args, { timeout: options.timeout ?? 30000, maxBuffer: 256 * 1024, encoding: "utf8", env: options.env });
    return { ok: true, stdout: result.stdout.trim(), stderr: result.stderr.trim() };
  } catch (error) {
    return { ok: false, stdout: String(error.stdout ?? "").trim(), stderr: String(error.stderr ?? "").trim() };
  }
}

async function inspectServiceAccount(run = defaultRun) {
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

async function hardenDrillTree(root, uid, gid) {
  const stack = [root];
  while (stack.length) {
    const current = stack.pop();
    const value = await lstat(current);
    if (value.isSymbolicLink()) throw new Error("The Keel recovery drill copy contains a symbolic link");
    if (value.isDirectory()) {
      await chown(current, uid, gid);
      await chmod(current, 0o700);
      for (const name of await readdir(current)) stack.push(path.join(current, name));
    } else {
      if (!value.isFile() || value.nlink !== 1) throw new Error("The Keel recovery drill copy contains an unsafe file");
      await chown(current, uid, gid);
      await chmod(current, 0o600);
    }
  }
}

async function defaultHealthRequest() {
  return new Promise((resolve) => {
    const request = http.get({ hostname: keelRecoveryDrillIdentity.bindAddress, port: keelRecoveryDrillIdentity.port, path: "/api/health", timeout: 2500 }, (response) => {
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

async function terminateChild(child) {
  if (!child) return { stopped: true, requested: false, forced: false };
  if (child.exitCode !== null || child.signalCode !== null) return { stopped: true, requested: false, forced: false };
  const exitPromise = new Promise((resolve) => child.once("exit", () => resolve(true)));
  const requested = child.kill("SIGTERM");
  const exited = await Promise.race([
    exitPromise,
    new Promise((resolve) => setTimeout(() => resolve(false), 10000)),
  ]);
  let forced = false;
  if (!exited && child.exitCode === null && child.signalCode === null) {
    forced = true;
    child.kill("SIGKILL");
  }
  if (!exited) await new Promise((resolve) => child.once("exit", resolve));
  return { stopped: true, requested, forced };
}

async function serviceState(run = defaultRun) {
  const result = await run(fixedBinaries.systemctl, ["is-active", keelServiceIdentity.unitName]);
  return result.ok ? result.stdout : "inactive";
}

export async function runApprovedKeelRecoveryDrill({
  recoveryPaths = keelRecoveryPaths,
  drillPaths = keelRecoveryDrillPaths,
  releasePath = keelInstallPaths.release,
  loadApproval = () => readFile(drillPaths.approval, "utf8"),
  now = () => new Date(),
  run = defaultRun,
  inspectRecovery = (recoveryId) => inspectKeelRecoveryState(recoveryId, { recoveryPaths }),
  account = null,
  requestHealth = defaultHealthRequest,
  healthWait = waitForHealth,
  spawn = spawnCallback,
  expectedRootUid = 0,
  expectedRootGid = 0,
} = {}) {
  const approval = parseApproval(await loadApproval(), now());
  const targets = pathsForKeelRecoveryDrill(approval.drillId, drillPaths);
  const before = await inspectRecovery(approval.recoveryId);
  if (!before.ready || before.evidenceChecksumSha256 !== approval.expectedEvidenceChecksumSha256
    || before.stateTreeDigestSha256 !== approval.expectedStateTreeDigestSha256) throw new Error("The selected stopped Keel recovery changed before its drill");
  const release = await metadata(releasePath);
  if (!release?.isDirectory() || release.isSymbolicLink()) throw new Error("The exact Keel release is unavailable for the drill");
  const serviceAccount = account ?? await inspectServiceAccount(run);
  if (!serviceAccount) throw new Error("The dedicated Keel service identity is unavailable");
  if (await metadata(targets.partial) || await metadata(targets.result)) throw new Error("The generated Keel recovery drill target already exists");
  const productionServiceBefore = await serviceState(run);
  let child = null;
  let completed = false;
  try {
    await mkdir(targets.root, { recursive: true, mode: 0o700 });
    await chmod(targets.root, 0o700);
    await chown(targets.root, expectedRootUid, expectedRootGid);
    await mkdir(targets.partial, { mode: 0o700 });
    await cp(before.statePath, targets.state, { recursive: true, dereference: false, errorOnExist: true, force: false });
    await hardenDrillTree(targets.state, serviceAccount.uid, serviceAccount.gid);
    const environment = keelRecoveryDrillEnvironment(targets.state);
    const environmentFile = Object.entries(environment)
      .filter(([key]) => !["PATH", "LANG", "LC_ALL"].includes(key))
      .map(([key, value]) => `${key}=${value}`)
      .join("\n");
    await writeFile(path.join(targets.state, ".env"), `${environmentFile}\n`, { encoding: "utf8", mode: 0o600 });
    await chown(path.join(targets.state, ".env"), serviceAccount.uid, serviceAccount.gid);
    await chmod(path.join(targets.state, ".env"), 0o600);
    child = spawn(fixedBinaries.node, [path.join(releasePath, "bin", "keel.mjs"), "start", "--foreground", "--port", String(keelRecoveryDrillIdentity.port)], {
      cwd: releasePath, env: environment, uid: serviceAccount.uid, gid: serviceAccount.gid, stdio: ["ignore", "ignore", "ignore"],
    });
    let spawnError = null;
    child.once("error", (error) => { spawnError = error; });
    if (!await healthWait(requestHealth)) throw spawnError ?? new Error("Keel did not return its exact health identity inside the isolated drill");
    if (child.exitCode !== null || child.signalCode !== null) throw new Error("Keel exited before the controlled recovery drill stop");
    const stopped = await terminateChild(child);
    if (!stopped.requested || stopped.forced) throw new Error("Keel did not stop cleanly during the isolated recovery drill");
    child = null;
    const drillDatabase = keelBackupScriptInternals.inspectDatabase(path.join(targets.state, "keel.db"));
    const after = await inspectRecovery(approval.recoveryId);
    if (after.evidenceChecksumSha256 !== approval.expectedEvidenceChecksumSha256 || after.stateTreeDigestSha256 !== approval.expectedStateTreeDigestSha256) throw new Error("The source Keel recovery changed during its isolated drill");
    const productionServiceAfter = await serviceState(run);
    if (productionServiceAfter !== productionServiceBefore) throw new Error("The production Keel service state changed during the isolated drill");
    await rm(targets.partial, { recursive: true, force: false });
    const result = {
      schemaVersion: 1, passed: true, drillId: approval.drillId, recoveryId: approval.recoveryId,
      applicationId: keelRecoveryDrillIdentity.applicationId, releaseVersion: keelRecoveryDrillIdentity.releaseVersion,
      sourceEvidenceChecksumSha256: approval.expectedEvidenceChecksumSha256,
      sourceStateTreeDigestSha256: approval.expectedStateTreeDigestSha256,
      resultPath: targets.result, healthIdentityVerified: true, databaseIntegrity: drillDatabase.integrityCheck,
      foreignKeyIssues: drillDatabase.foreignKeyIssues, schemaVerified: drillDatabase.schemaVerified,
      processStarted: true, processStopped: true, network: keelRecoveryDrillIdentity.network, publishedPorts: 0,
      workspaceRemoved: true, sourceRecoveryUnchanged: true, productionStateReplaced: false,
      productionServiceChanged: false, claimChanged: false, registrationChanged: false, loginTested: false, promotionPerformed: false,
    };
    const handle = await open(targets.result, "wx", 0o600);
    try { await handle.writeFile(`${JSON.stringify(result, null, 2)}\n`, "utf8"); await handle.sync(); } finally { await handle.close(); }
    await chown(targets.result, expectedRootUid, expectedRootGid);
    await chmod(targets.result, 0o600);
    completed = true;
    return result;
  } finally {
    await terminateChild(child);
    await rm(targets.partial, { recursive: true, force: true });
    if (!completed) await rm(targets.result, { force: true });
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
if (invokedPath === import.meta.url) {
  if (process.argv.length !== 2) {
    console.error("The fixed Keel recovery drill accepts no arguments");
    process.exitCode = 64;
  } else {
    try {
      const result = await runApprovedKeelRecoveryDrill();
      console.log(`Passed isolated Keel recovery drill ${result.drillId}`);
    } catch (error) {
      console.error(error.message);
      process.exitCode = 1;
    }
  }
}

export const keelRecoveryDrillScriptInternals = { hardenDrillTree, inspectServiceAccount, parseApproval, terminateChild, waitForHealth };
