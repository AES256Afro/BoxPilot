/**
 * Risk tiers and approval policy (ADR-001).
 *
 *   low    — one click, audited (reads, start/stop/restart, refresh, canary)
 *   medium — one confirmation with a preview, audited (install, create, edit, back up)
 *   high   — password (or passkey) + typed confirmation (purge, forget backups, replace production,
 *            network-critical deploys); a fresh password unlocks a short elevated session.
 *
 * `always-password` restores the pre-ADR behaviour: every approval re-enters the password.
 * Job types not listed here default to `high` so a new job type is never accidentally one-click.
 */

export const riskTiers = Object.freeze(["low", "medium", "high"]);
export const approvalModes = Object.freeze(["tiered", "always-password"]);
export const defaultApprovalMode = "tiered";
export const elevationTtlMs = 10 * 60 * 1000;

const jobRiskTiers = Object.freeze({
  "helper.canary.verify": "low",
  "prerequisite.apt-metadata.refresh": "low",
  "prerequisite.smartmontools.install": "medium",
  "prerequisite.restic.install": "medium",
  "prerequisite.docker.install": "medium",
  "prerequisite.virtualization.install": "medium",
  "virtualization.foundation.initialize": "medium",
  "application.uptime-kuma.deploy": "medium",
  "application.uptime-kuma.action": "low",
  "application.uptime-kuma.private-access": "medium",
  "application.uptime-kuma.backup": "medium",
  "application.pi-hole.deploy": "high",
  "application.pi-hole.action": "medium",
  "application.pi-hole.backup": "medium",
  "application.keel.artifact.acquire": "medium",
  "application.keel.stage": "medium",
  "application.keel.install": "medium",
  "application.keel.backup": "medium",
  "application.keel.recovery.create": "medium",
  "application.keel.recovery-drill.run": "medium",
  "application.keel.promotion": "high",
  "application.keel.rollback": "high",
  "controller.database.backup": "low",
  "controller.database.backup.protect": "medium",
  "controller.database.backup.retention.apply": "high",
  "application.backup.protect": "medium",
  "application.backup.retention.apply": "high",
  "network.dns.acceptance.run": "low",
  "migration.bundle.transfer": "medium",
  "virtualization.media.import": "medium",
  "virtualization.domain.create": "medium",
  "virtualization.domain.action": "low",
  "virtualization.domain.snapshot.create": "medium",
  "virtualization.domain.export.create": "medium",
  "virtualization.export.backup.create": "medium",
  "virtualization.export.backup.retention.apply": "high",
  "virtualization.export.backup.restore-drill": "medium",
  "virtualization.backup.recovery.create": "medium",
});

let registryLookup = null;
/** Lets the job layer resolve `op:<id>` job types from the operation registry without a circular import. */
export function setRegistryLookup(lookup) {
  registryLookup = typeof lookup === "function" ? lookup : null;
}

export function riskTierForJob(jobType) {
  if (typeof jobType === "string" && jobType.startsWith("op:")) {
    const operation = registryLookup?.(jobType.slice(3)) ?? null;
    return operation && riskTiers.includes(operation.risk) ? operation.risk : "high";
  }
  return jobRiskTiers[jobType] ?? "high";
}

export function knownJobTypes() {
  return Object.keys(jobRiskTiers);
}

export function normalizeApprovalMode(value) {
  return approvalModes.includes(value) ? value : defaultApprovalMode;
}

/**
 * Decide what an approval needs.
 * @returns {{ tier: string, passwordRequired: boolean, elevated: boolean, reason: string }}
 */
export function approvalRequirement({ jobType, mode = defaultApprovalMode, elevatedUntil = null, now = () => new Date() } = {}) {
  const tier = riskTierForJob(jobType);
  const elevatedTime = typeof elevatedUntil === "string" ? Date.parse(elevatedUntil) : Number.NaN;
  const elevated = Number.isFinite(elevatedTime) && elevatedTime > now().getTime();
  if (normalizeApprovalMode(mode) === "always-password") return { tier, passwordRequired: true, elevated, reason: "always-password mode" };
  if (tier === "high") return elevated ? { tier, passwordRequired: false, elevated, reason: "session elevated" } : { tier, passwordRequired: true, elevated, reason: "high risk" };
  return { tier, passwordRequired: false, elevated, reason: `${tier} risk` };
}
