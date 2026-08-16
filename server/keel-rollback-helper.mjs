import { chmod, lstat, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { validUuid } from "./keel-artifact-spec.mjs";
import { createKeelInstallHelper } from "./keel-install-helper.mjs";
import { keelRollbackIdentity, keelRollbackPaths, pathsForKeelRollback } from "./keel-rollback-spec.mjs";
import { inspectKeelPromotionRollbackState } from "./keel-rollback-state.mjs";

const shaPattern = /^[a-f0-9]{64}$/;
const inspectKeys = ["expectedPreviousStateTreeDigestSha256", "promotionId"];
const createKeys = [...inspectKeys, "expectedInstallId", "expectedRollbackEvidenceChecksumSha256", "rollbackId"].sort();

export function validateKeelRollbackInspectInput(input) {
  const keys = input && typeof input === "object" && !Array.isArray(input) ? Object.keys(input).sort() : [];
  const errors = [];
  if (keys.length !== inspectKeys.length || keys.some((key, index) => key !== [...inspectKeys].sort()[index])) errors.push("Keel rollback inspection accepts only the fixed promotion and state digest fields");
  if (!validUuid(input?.promotionId)) errors.push("Promotion id must be a UUID");
  if (!shaPattern.test(input?.expectedPreviousStateTreeDigestSha256 ?? "")) errors.push("Previous state tree digest must be a SHA-256 digest");
  return errors;
}

export function validateKeelRollbackCreateInput(input) {
  const errors = validateKeelRollbackInspectInput({ promotionId: input?.promotionId, expectedPreviousStateTreeDigestSha256: input?.expectedPreviousStateTreeDigestSha256 });
  const keys = input && typeof input === "object" && !Array.isArray(input) ? Object.keys(input).sort() : [];
  if (keys.length !== createKeys.length || keys.some((key, index) => key !== createKeys[index])) errors.push("Keel rollback accepts only the fixed rollback, installation, promotion, and checkpoint evidence fields");
  if (!validUuid(input?.rollbackId)) errors.push("Rollback id must be a UUID");
  if (!validUuid(input?.expectedInstallId)) errors.push("Managed installation id must be a UUID");
  if (!shaPattern.test(input?.expectedRollbackEvidenceChecksumSha256 ?? "")) errors.push("Rollback evidence checksum must be a SHA-256 digest");
  return [...new Set(errors)];
}

async function metadata(target) {
  try { return await lstat(target); } catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

function exactResult(result, input, targets) {
  return result?.schemaVersion === 1 && result?.passed === true && result?.rollbackId === input.rollbackId
    && result?.promotionId === input.promotionId && result?.applicationId === "keel" && result?.releaseVersion === keelRollbackIdentity.releaseVersion
    && result?.installId === input.expectedInstallId && result?.sourceRollbackEvidenceChecksumSha256 === input.expectedRollbackEvidenceChecksumSha256
    && result?.sourcePreviousStateTreeDigestSha256 === input.expectedPreviousStateTreeDigestSha256
    && result?.restoredStateTreeDigestSha256 === input.expectedPreviousStateTreeDigestSha256
    && shaPattern.test(result?.displacedStateTreeDigestSha256 ?? "")
    && result?.displacedStatePath === targets.displacedFinalState && result?.displacedEvidencePath === targets.displacedFinalEvidence
    && result?.displacedStateRetained === true && result?.sourceRollbackCheckpointUnchanged === true
    && result?.rollbackRequested === true && result?.productionStateReplaced === true && result?.healthIdentityVerified === true
    && result?.databaseIntegrity === "ok" && result?.foreignKeyIssues === 0 && result?.schemaVerified === true
    && result?.automaticFailureRecoveryTested === false
    && result?.ownerLoginTested === false && result?.network === keelRollbackIdentity.network && result?.publishedPortsChanged === false
    && result?.tailscaleChanged === false && result?.firewallChanged === false && result?.routerChanged === false
    && result?.browserPathAccepted === false && result?.browserCommandAccepted === false && result?.browserTokenAccepted === false;
}

export function createKeelRollbackHelper({
  paths = keelRollbackPaths,
  inspectSource = (promotionId, options) => inspectKeelPromotionRollbackState(promotionId, options),
  installHelper = createKeelInstallHelper(),
  runService = async () => {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    try { await promisify(execFile)("/usr/bin/systemctl", ["start", keelRollbackIdentity.unitName], { timeout: 20 * 60 * 1000, maxBuffer: 256 * 1024, encoding: "utf8" }); return { ok: true }; } catch (error) { return { ok: false, stderr: String(error.stderr ?? "") }; }
  },
  inspectService = async () => {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    try { await promisify(execFile)("/usr/bin/systemctl", ["is-active", "--quiet", keelRollbackIdentity.unitName], { timeout: 5000 }); return { active: true }; } catch { return { active: false }; }
  },
  now = () => new Date(),
  expectedRootUid = 0,
  expectedRootGid = 0,
} = {}) {
  async function inspect(input) {
    const errors = validateKeelRollbackInspectInput(input);
    if (errors.length) throw new Error(errors.join(" | "));
    const blockers = [];
    let source = null;
    let installation = null;
    try { source = await inspectSource(input.promotionId, { expectedPreviousStateTreeDigestSha256: input.expectedPreviousStateTreeDigestSha256, expectedRootUid, expectedRootGid }); } catch { blockers.push("The exact retained Keel promotion rollback checkpoint is unavailable or changed"); }
    try { installation = await installHelper.inspect(); } catch { blockers.push("The managed Keel production installation could not be inspected safely"); }
    if (!installation || installation.state !== "installed" || installation.installed !== true || installation.healthy !== true
      || !validUuid(installation.installId) || installation.releaseVersion !== keelRollbackIdentity.releaseVersion) blockers.push("The exact managed Keel 1.2.6 production service must be healthy before rollback");
    if (source && installation?.installId !== source.previousInstallId) blockers.push("The managed Keel installation identity does not match the retained promotion checkpoint");
    if (await metadata(paths.active) || await metadata(paths.approval)) blockers.push("A previous Keel operator rollback requires reconciliation");
    return {
      ready: blockers.length === 0,
      promotionId: input.promotionId,
      installId: installation?.installId ?? null,
      rollbackEvidenceChecksumSha256: source?.evidenceChecksumSha256 ?? null,
      previousStateTreeDigestSha256: source?.stateTreeDigestSha256 ?? null,
      releaseVersion: keelRollbackIdentity.releaseVersion,
      network: keelRollbackIdentity.network,
      displacedDestination: "managed-keel-rollback-checkpoint",
      sourceCheckpointPreserved: true,
      blockers,
    };
  }

  async function readResult(input) {
    const targets = pathsForKeelRollback(input.rollbackId, paths);
    const value = await metadata(targets.result);
    if (!value?.isFile() || value.isSymbolicLink() || value.nlink !== 1 || value.uid !== expectedRootUid || value.gid !== expectedRootGid
      || (value.mode & 0o7777) !== 0o600 || value.size > 64 * 1024) throw new Error("The fixed Keel rollback result is missing or unsafe");
    let result;
    try { result = JSON.parse(await readFile(targets.result, "utf8")); } catch { throw new Error("The fixed Keel rollback result is invalid"); }
    if (!exactResult(result, input, targets)) throw new Error("The fixed Keel rollback result changed or failed its evidence contract");
    const displacedContainer = await metadata(targets.displacedFinal);
    const displacedState = await metadata(targets.displacedFinalState);
    const displacedEvidence = await metadata(targets.displacedFinalEvidence);
    if (!displacedContainer?.isDirectory() || displacedContainer.isSymbolicLink() || displacedContainer.uid !== expectedRootUid
      || displacedContainer.gid !== expectedRootGid || (displacedContainer.mode & 0o7777) !== 0o700
      || !displacedState?.isDirectory() || displacedState.isSymbolicLink() || (displacedState.mode & 0o7777) !== 0o700
      || !displacedEvidence?.isFile() || displacedEvidence.isSymbolicLink()
      || displacedEvidence.nlink !== 1 || displacedEvidence.uid !== expectedRootUid || displacedEvidence.gid !== expectedRootGid
      || (displacedEvidence.mode & 0o7777) !== 0o600) throw new Error("The displaced Keel state checkpoint is missing or unsafe");
    return result;
  }

  async function create(input) {
    const errors = validateKeelRollbackCreateInput(input);
    if (errors.length) throw new Error(errors.join(" | "));
    await recoverInterrupted();
    const before = await inspect({ promotionId: input.promotionId, expectedPreviousStateTreeDigestSha256: input.expectedPreviousStateTreeDigestSha256 });
    if (!before.ready || before.installId !== input.expectedInstallId || before.rollbackEvidenceChecksumSha256 !== input.expectedRollbackEvidenceChecksumSha256) throw new Error(before.blockers.join(" | ") || "The selected Keel rollback evidence changed");
    const targets = pathsForKeelRollback(input.rollbackId, paths);
    await mkdir(targets.root, { recursive: true, mode: 0o700 });
    await mkdir(targets.displacedRoot, { recursive: true, mode: 0o700 });
    for (const target of [targets.candidate, targets.result, targets.activePartial, targets.displacedPartial, targets.displacedFinal]) if (await metadata(target)) throw new Error("The generated Keel rollback target already exists");
    const approval = { ...input, approvedAt: now().toISOString(), releaseVersion: keelRollbackIdentity.releaseVersion, unitName: keelRollbackIdentity.unitName };
    await writeFile(paths.approval, `${JSON.stringify(approval)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
    await chmod(paths.approval, 0o600);
    let started;
    try { started = await runService(); } finally { await unlink(paths.approval).catch((error) => { if (error.code !== "ENOENT") throw error; }); }
    if (!started.ok) throw new Error("The fixed Keel operator rollback service failed");
    return readResult(input);
  }

  async function recoverInterrupted() {
    const active = await metadata(paths.active);
    const approval = await metadata(paths.approval);
    if (!active && !approval) return { recovered: false, active: false, currentProductionRestored: false };
    const service = await inspectService();
    if (service.active) return { recovered: false, active: true, currentProductionRestored: false };
    if (active) {
      const started = await runService();
      if (!started.ok) throw new Error("The interrupted Keel operator rollback could not restore current production");
      if (await metadata(paths.active)) throw new Error("The interrupted Keel operator rollback left its active marker after recovery");
      const installation = await installHelper.inspect();
      if (installation.state !== "installed" || installation.installed !== true || installation.healthy !== true
        || !validUuid(installation.installId) || installation.releaseVersion !== keelRollbackIdentity.releaseVersion) throw new Error("The current Keel production state was restored without a healthy managed installation");
      await unlink(paths.approval).catch((error) => { if (error.code !== "ENOENT") throw error; });
      return { recovered: true, active: false, currentProductionRestored: true };
    }
    if (!approval?.isFile() || approval.isSymbolicLink() || approval.nlink !== 1 || approval.uid !== expectedRootUid || approval.gid !== expectedRootGid || (approval.mode & 0o7777) !== 0o600) throw new Error("The interrupted Keel rollback approval marker is unsafe");
    await unlink(paths.approval);
    return { recovered: true, active: false, currentProductionRestored: false };
  }

  return { inspect, create, readResult, recoverInterrupted };
}

export const keelRollbackHelperInternals = { exactResult };
