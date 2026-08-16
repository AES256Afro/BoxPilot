import { chmod, chown, lstat, mkdir, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { validUuid } from "./keel-artifact-spec.mjs";
import { keelInstallPaths } from "./keel-install-spec.mjs";
import { keelRecoveryPaths } from "./keel-recovery-spec.mjs";
import { inspectKeelRecoveryState } from "./keel-recovery-state.mjs";
import { keelRecoveryDrillIdentity, keelRecoveryDrillPaths, pathsForKeelRecoveryDrill } from "./keel-recovery-drill-spec.mjs";

const shaPattern = /^[a-f0-9]{64}$/;
const expectedCreateKeys = ["drillId", "expectedEvidenceChecksumSha256", "expectedStateTreeDigestSha256", "recoveryId"];

export function validateKeelRecoveryDrillInspectInput(input) {
  const keys = input && typeof input === "object" && !Array.isArray(input) ? Object.keys(input) : [];
  return keys.length === 1 && keys[0] === "recoveryId" && validUuid(input.recoveryId) ? [] : ["Keel recovery drill inspection accepts only one recoveryId UUID"];
}

export function validateKeelRecoveryDrillCreateInput(input) {
  const errors = [];
  if (!input || typeof input !== "object" || Array.isArray(input)) return ["Keel recovery drill input must be an object"];
  const keys = Object.keys(input).sort();
  if (keys.length !== expectedCreateKeys.length || keys.some((key, index) => key !== expectedCreateKeys[index])) errors.push("Keel recovery drill accepts only the fixed typed recovery evidence fields");
  if (!validUuid(input.drillId)) errors.push("Recovery drill id must be a UUID");
  if (!validUuid(input.recoveryId)) errors.push("Recovery id must be a UUID");
  if (!shaPattern.test(input.expectedEvidenceChecksumSha256 ?? "")) errors.push("Recovery evidence checksum must be a SHA-256 digest");
  if (!shaPattern.test(input.expectedStateTreeDigestSha256 ?? "")) errors.push("Recovery state tree digest must be a SHA-256 digest");
  return errors;
}

async function metadata(target) {
  try { return await lstat(target); } catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

function exactResult(result, input, targets) {
  return result?.schemaVersion === 1 && result?.passed === true && result?.drillId === input.drillId && result?.recoveryId === input.recoveryId
    && result?.applicationId === "keel" && result?.releaseVersion === keelRecoveryDrillIdentity.releaseVersion
    && result?.sourceEvidenceChecksumSha256 === input.expectedEvidenceChecksumSha256
    && result?.sourceStateTreeDigestSha256 === input.expectedStateTreeDigestSha256
    && result?.resultPath === targets.result && result?.healthIdentityVerified === true && result?.databaseIntegrity === "ok"
    && result?.foreignKeyIssues === 0 && result?.schemaVerified === true && result?.processStarted === true && result?.processStopped === true
    && result?.network === keelRecoveryDrillIdentity.network && result?.publishedPorts === 0 && result?.workspaceRemoved === true
    && result?.sourceRecoveryUnchanged === true && result?.productionStateReplaced === false && result?.productionServiceChanged === false
    && result?.claimChanged === false && result?.registrationChanged === false && result?.loginTested === false && result?.promotionPerformed === false;
}

function parseApproval(value) {
  let approval;
  try { approval = JSON.parse(value); } catch { throw new Error("The interrupted Keel recovery drill marker is invalid"); }
  const expectedKeys = [...expectedCreateKeys, "approvedAt", "releaseVersion", "unitName"].sort();
  const keys = approval && typeof approval === "object" && !Array.isArray(approval) ? Object.keys(approval).sort() : [];
  if (keys.length !== expectedKeys.length || keys.some((key, index) => key !== expectedKeys[index])) throw new Error("The interrupted Keel recovery drill marker has unexpected fields");
  const input = Object.fromEntries(expectedCreateKeys.map((key) => [key, approval[key]]));
  const errors = validateKeelRecoveryDrillCreateInput(input);
  if (errors.length || typeof approval.approvedAt !== "string" || !Number.isFinite(Date.parse(approval.approvedAt))
    || approval.releaseVersion !== keelRecoveryDrillIdentity.releaseVersion || approval.unitName !== keelRecoveryDrillIdentity.unitName) throw new Error("The interrupted Keel recovery drill marker changed");
  return input;
}

export function createKeelRecoveryDrillHelper({
  recoveryPaths = keelRecoveryPaths,
  drillPaths = keelRecoveryDrillPaths,
  inspectRecovery = (recoveryId) => inspectKeelRecoveryState(recoveryId, { recoveryPaths }),
  runService = async () => {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    try { await promisify(execFile)("/usr/bin/systemctl", ["start", keelRecoveryDrillIdentity.unitName], { timeout: 15 * 60 * 1000, maxBuffer: 256 * 1024, encoding: "utf8" }); return { ok: true }; } catch (error) { return { ok: false, stderr: String(error.stderr ?? "") }; }
  },
  inspectService = async () => {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    try { await promisify(execFile)("/usr/bin/systemctl", ["is-active", "--quiet", keelRecoveryDrillIdentity.unitName], { timeout: 5000, maxBuffer: 64 * 1024 }); return { active: true }; } catch { return { active: false }; }
  },
  now = () => new Date(),
  expectedRootUid = 0,
  expectedRootGid = 0,
  releasePath = keelInstallPaths.release,
} = {}) {
  async function inspect(input) {
    const errors = validateKeelRecoveryDrillInspectInput(input);
    if (errors.length) throw new Error(errors.join(" | "));
    const recovery = await inspectRecovery(input.recoveryId);
    const release = await metadata(releasePath);
    const blockers = [];
    if (!release?.isDirectory() || release.isSymbolicLink()) blockers.push("The exact Keel 1.2.6 release is unavailable");
    return { ...recovery, ready: recovery.ready === true && blockers.length === 0, releaseVersion: keelRecoveryDrillIdentity.releaseVersion, drillPort: keelRecoveryDrillIdentity.port, drillNetwork: keelRecoveryDrillIdentity.network, blockers };
  }

  async function readResult(input) {
    const targets = pathsForKeelRecoveryDrill(input.drillId, drillPaths);
    const value = await metadata(targets.result);
    if (!value?.isFile() || value.isSymbolicLink() || value.nlink !== 1 || value.uid !== expectedRootUid || value.gid !== expectedRootGid || (value.mode & 0o7777) !== 0o600 || value.size > 64 * 1024) throw new Error("The fixed Keel recovery drill result is missing or unsafe");
    let result;
    try { result = JSON.parse(await readFile(targets.result, "utf8")); } catch { throw new Error("The fixed Keel recovery drill result is invalid"); }
    if (!exactResult(result, input, targets)) throw new Error("The fixed Keel recovery drill result changed or failed its evidence contract");
    return result;
  }

  async function create(input) {
    const errors = validateKeelRecoveryDrillCreateInput(input);
    if (errors.length) throw new Error(errors.join(" | "));
    await recoverInterrupted();
    const before = await inspect({ recoveryId: input.recoveryId });
    if (!before.ready || before.evidenceChecksumSha256 !== input.expectedEvidenceChecksumSha256 || before.stateTreeDigestSha256 !== input.expectedStateTreeDigestSha256) throw new Error(before.blockers.join(" | ") || "The selected Keel recovery evidence changed");
    const targets = pathsForKeelRecoveryDrill(input.drillId, drillPaths);
    await mkdir(targets.root, { recursive: true, mode: 0o700 });
    await chown(targets.root, expectedRootUid, expectedRootGid);
    await chmod(targets.root, 0o700);
    const root = await metadata(targets.root);
    if (!root?.isDirectory() || root.isSymbolicLink() || root.uid !== expectedRootUid || root.gid !== expectedRootGid || (root.mode & 0o7777) !== 0o700) throw new Error("The fixed Keel recovery drill root is unsafe");
    if (await metadata(targets.partial) || await metadata(targets.result)) throw new Error("The generated Keel recovery drill target already exists");
    const approval = { ...input, approvedAt: now().toISOString(), releaseVersion: keelRecoveryDrillIdentity.releaseVersion, unitName: keelRecoveryDrillIdentity.unitName };
    await writeFile(drillPaths.approval, `${JSON.stringify(approval)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 }).catch((error) => {
      if (error.code === "EEXIST") throw new Error("A previous Keel recovery drill requires inspection before another can start");
      throw error;
    });
    await chmod(drillPaths.approval, 0o600);
    let started;
    try { started = await runService(); } finally { await unlink(drillPaths.approval).catch((error) => { if (error.code !== "ENOENT") throw error; }); }
    if (!started.ok) throw new Error("The fixed Keel recovery drill service failed");
    const result = await readResult(input);
    const after = await inspectRecovery(input.recoveryId);
    if (after.evidenceChecksumSha256 !== input.expectedEvidenceChecksumSha256 || after.stateTreeDigestSha256 !== input.expectedStateTreeDigestSha256) throw new Error("The source Keel recovery changed during its isolated drill");
    return result;
  }

  async function recoverInterrupted() {
    const marker = await metadata(drillPaths.approval);
    if (!marker) return { recovered: false, active: false, resultRecovered: false, generatedPartialRemoved: false };
    if (!marker.isFile() || marker.isSymbolicLink() || marker.nlink !== 1 || marker.uid !== expectedRootUid || marker.gid !== expectedRootGid
      || (marker.mode & 0o7777) !== 0o600 || marker.size > 64 * 1024) throw new Error("The interrupted Keel recovery drill marker is unsafe");
    const input = parseApproval(await readFile(drillPaths.approval, "utf8"));
    const service = await inspectService();
    if (service.active) return { recovered: false, active: true, resultRecovered: false, generatedPartialRemoved: false };
    const targets = pathsForKeelRecoveryDrill(input.drillId, drillPaths);
    let resultRecovered = false;
    if (await metadata(targets.result)) {
      await readResult(input);
      resultRecovered = true;
    }
    const partial = await metadata(targets.partial);
    if (partial && !partial.isDirectory()) throw new Error("The interrupted Keel recovery drill partial is unsafe");
    if (partial) await rm(targets.partial, { recursive: true, force: true });
    await unlink(drillPaths.approval);
    return { recovered: true, active: false, resultRecovered, generatedPartialRemoved: Boolean(partial) };
  }

  return { inspect, create, readResult, recoverInterrupted };
}

export const keelRecoveryDrillHelperInternals = { exactResult, parseApproval };
