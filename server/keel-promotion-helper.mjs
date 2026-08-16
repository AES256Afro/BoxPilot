import { chmod, lstat, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { validUuid } from "./keel-artifact-spec.mjs";
import { createKeelInstallHelper } from "./keel-install-helper.mjs";
import { createKeelRecoveryDrillHelper } from "./keel-recovery-drill-helper.mjs";
import { inspectKeelRecoveryState } from "./keel-recovery-state.mjs";
import { keelPromotionIdentity, keelPromotionPaths, pathsForKeelPromotion } from "./keel-promotion-spec.mjs";

const shaPattern = /^[a-f0-9]{64}$/;
const inspectKeys = ["drillId", "expectedEvidenceChecksumSha256", "expectedStateTreeDigestSha256", "recoveryId"];
const createKeys = [...inspectKeys, "expectedInstallId", "promotionId"].sort();

export function validateKeelPromotionInspectInput(input) {
  const keys = input && typeof input === "object" && !Array.isArray(input) ? Object.keys(input).sort() : [];
  const errors = [];
  if (keys.length !== inspectKeys.length || keys.some((key, index) => key !== [...inspectKeys].sort()[index])) errors.push("Keel promotion inspection accepts only the fixed recovery and drill evidence fields");
  errors.push(...validateEvidence(input));
  return errors;
}

function validateEvidence(input) {
  const errors = [];
  if (!validUuid(input?.recoveryId)) errors.push("Recovery id must be a UUID");
  if (!validUuid(input?.drillId)) errors.push("Recovery drill id must be a UUID");
  if (!shaPattern.test(input?.expectedEvidenceChecksumSha256 ?? "")) errors.push("Recovery evidence checksum must be a SHA-256 digest");
  if (!shaPattern.test(input?.expectedStateTreeDigestSha256 ?? "")) errors.push("Recovery state tree digest must be a SHA-256 digest");
  return errors;
}

export function validateKeelPromotionCreateInput(input) {
  const errors = validateEvidence(input);
  const keys = input && typeof input === "object" && !Array.isArray(input) ? Object.keys(input).sort() : [];
  if (keys.length !== createKeys.length || keys.some((key, index) => key !== createKeys[index])) errors.push("Keel promotion accepts only the fixed promotion, installation, recovery, and drill evidence fields");
  if (!validUuid(input?.promotionId)) errors.push("Promotion id must be a UUID");
  if (!validUuid(input?.expectedInstallId)) errors.push("Managed installation id must be a UUID");
  return [...new Set(errors)];
}

async function metadata(target) {
  try { return await lstat(target); } catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

function exactResult(result, input, targets) {
  return result?.schemaVersion === 1 && result?.passed === true && result?.promotionId === input.promotionId
    && result?.recoveryId === input.recoveryId && result?.drillId === input.drillId && result?.applicationId === "keel"
    && result?.releaseVersion === keelPromotionIdentity.releaseVersion && result?.previousInstallId === input.expectedInstallId
    && result?.sourceEvidenceChecksumSha256 === input.expectedEvidenceChecksumSha256
    && result?.sourceStateTreeDigestSha256 === input.expectedStateTreeDigestSha256
    && shaPattern.test(result?.previousStateTreeDigestSha256 ?? "")
    && result?.promotedStateTreeDigestSha256 === input.expectedStateTreeDigestSha256
    && result?.rollbackPath === targets.rollbackFinalState && result?.rollbackEvidencePath === targets.rollbackFinalEvidence
    && result?.rollbackAvailable === true && result?.healthIdentityVerified === true && result?.databaseIntegrity === "ok"
    && result?.foreignKeyIssues === 0 && result?.schemaVerified === true && result?.productionStateReplaced === true
    && result?.sourceRecoveryUnchanged === true && result?.registrationStateRestoredFromRecovery === true
    && result?.claimStateRestoredFromRecovery === true && result?.ownerLoginTested === false
    && result?.network === keelPromotionIdentity.network && result?.publishedPortsChanged === false
    && result?.tailscaleChanged === false && result?.firewallChanged === false && result?.routerChanged === false
    && result?.browserPathAccepted === false && result?.browserCommandAccepted === false && result?.browserTokenAccepted === false;
}

export function createKeelPromotionHelper({
  paths = keelPromotionPaths,
  inspectRecovery = (recoveryId) => inspectKeelRecoveryState(recoveryId),
  drillHelper = createKeelRecoveryDrillHelper(),
  installHelper = createKeelInstallHelper(),
  runService = async () => {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    try { await promisify(execFile)("/usr/bin/systemctl", ["start", keelPromotionIdentity.unitName], { timeout: 20 * 60 * 1000, maxBuffer: 256 * 1024, encoding: "utf8" }); return { ok: true }; } catch (error) { return { ok: false, stderr: String(error.stderr ?? "") }; }
  },
  inspectService = async () => {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    try { await promisify(execFile)("/usr/bin/systemctl", ["is-active", "--quiet", keelPromotionIdentity.unitName], { timeout: 5000 }); return { active: true }; } catch { return { active: false }; }
  },
  now = () => new Date(),
  expectedRootUid = 0,
  expectedRootGid = 0,
} = {}) {
  async function inspect(input) {
    const errors = validateKeelPromotionInspectInput(input);
    if (errors.length) throw new Error(errors.join(" | "));
    const blockers = [];
    let recovery = null;
    let installation = null;
    try { recovery = await inspectRecovery(input.recoveryId); } catch { blockers.push("The exact stopped Keel recovery is unavailable or changed"); }
    try {
      await drillHelper.readResult(input);
    } catch { blockers.push("A passing isolated startup rehearsal matching this exact recovery evidence is required"); }
    try { installation = await installHelper.inspect(); } catch { blockers.push("The managed Keel production installation could not be inspected safely"); }
    if (recovery && (recovery.evidenceChecksumSha256 !== input.expectedEvidenceChecksumSha256 || recovery.stateTreeDigestSha256 !== input.expectedStateTreeDigestSha256)) blockers.push("The stopped Keel recovery evidence does not match the approved drill");
    if (!installation || installation.state !== "installed" || installation.installed !== true || installation.healthy !== true
      || !validUuid(installation.installId) || installation.releaseVersion !== keelPromotionIdentity.releaseVersion) blockers.push("The exact managed Keel 1.2.6 production service must be healthy before promotion");
    if (await metadata(paths.active) || await metadata(paths.approval)) blockers.push("A previous Keel production promotion requires reconciliation");
    return {
      ready: blockers.length === 0,
      recoveryId: input.recoveryId,
      drillId: input.drillId,
      evidenceChecksumSha256: recovery?.evidenceChecksumSha256 ?? null,
      stateTreeDigestSha256: recovery?.stateTreeDigestSha256 ?? null,
      installId: installation?.installId ?? null,
      releaseVersion: keelPromotionIdentity.releaseVersion,
      network: keelPromotionIdentity.network,
      rollbackDestination: "managed-keel-promotion-rollback",
      blockers,
    };
  }

  async function readResult(input) {
    const targets = pathsForKeelPromotion(input.promotionId, paths);
    const value = await metadata(targets.result);
    if (!value?.isFile() || value.isSymbolicLink() || value.nlink !== 1 || value.uid !== expectedRootUid || value.gid !== expectedRootGid
      || (value.mode & 0o7777) !== 0o600 || value.size > 64 * 1024) throw new Error("The fixed Keel promotion result is missing or unsafe");
    let result;
    try { result = JSON.parse(await readFile(targets.result, "utf8")); } catch { throw new Error("The fixed Keel promotion result is invalid"); }
    if (!exactResult(result, input, targets)) throw new Error("The fixed Keel promotion result changed or failed its evidence contract");
    const rollbackState = await metadata(targets.rollbackFinalState);
    const rollbackEvidence = await metadata(targets.rollbackFinalEvidence);
    if (!rollbackState?.isDirectory() || rollbackState.isSymbolicLink() || !rollbackEvidence?.isFile() || rollbackEvidence.isSymbolicLink()
      || rollbackEvidence.nlink !== 1 || rollbackEvidence.uid !== expectedRootUid || rollbackEvidence.gid !== expectedRootGid
      || (rollbackEvidence.mode & 0o7777) !== 0o600) throw new Error("The Keel promotion rollback checkpoint is missing or unsafe");
    return result;
  }

  async function create(input) {
    const errors = validateKeelPromotionCreateInput(input);
    if (errors.length) throw new Error(errors.join(" | "));
    await recoverInterrupted();
    const before = await inspect(Object.fromEntries(inspectKeys.map((key) => [key, input[key]])));
    if (!before.ready || before.installId !== input.expectedInstallId) throw new Error(before.blockers.join(" | ") || "The selected Keel promotion evidence changed");
    const targets = pathsForKeelPromotion(input.promotionId, paths);
    await mkdir(targets.root, { recursive: true, mode: 0o700 });
    await mkdir(targets.rollbackRoot, { recursive: true, mode: 0o700 });
    for (const target of [targets.candidate, targets.result, targets.activePartial, targets.rollbackPartial, targets.rollbackFinal]) if (await metadata(target)) throw new Error("The generated Keel promotion target already exists");
    const approval = { ...input, approvedAt: now().toISOString(), releaseVersion: keelPromotionIdentity.releaseVersion, unitName: keelPromotionIdentity.unitName };
    await writeFile(paths.approval, `${JSON.stringify(approval)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
    await chmod(paths.approval, 0o600);
    let started;
    try { started = await runService(); } finally { await unlink(paths.approval).catch((error) => { if (error.code !== "ENOENT") throw error; }); }
    if (!started.ok) throw new Error("The fixed Keel production promotion service failed");
    return readResult(input);
  }

  async function recoverInterrupted() {
    const active = await metadata(paths.active);
    const approval = await metadata(paths.approval);
    if (!active && !approval) return { recovered: false, active: false, previousProductionRestored: false };
    const service = await inspectService();
    if (service.active) return { recovered: false, active: true, previousProductionRestored: false };
    if (active) {
      const started = await runService();
      if (!started.ok) throw new Error("The interrupted Keel promotion could not restore previous production");
      if (await metadata(paths.active)) throw new Error("The interrupted Keel promotion left its active marker after recovery");
      const installation = await installHelper.inspect();
      if (installation.state !== "installed" || installation.installed !== true || installation.healthy !== true
        || !validUuid(installation.installId) || installation.releaseVersion !== keelPromotionIdentity.releaseVersion) throw new Error("The previous Keel production state was restored without a healthy managed installation");
      await unlink(paths.approval).catch((error) => { if (error.code !== "ENOENT") throw error; });
      return { recovered: true, active: false, previousProductionRestored: true };
    }
    if (!approval?.isFile() || approval.isSymbolicLink() || approval.nlink !== 1 || approval.uid !== expectedRootUid || approval.gid !== expectedRootGid || (approval.mode & 0o7777) !== 0o600) throw new Error("The interrupted Keel promotion approval marker is unsafe");
    await unlink(paths.approval);
    return { recovered: true, active: false, previousProductionRestored: false };
  }

  return { inspect, create, readResult, recoverInterrupted };
}

export const keelPromotionHelperInternals = { exactResult };
