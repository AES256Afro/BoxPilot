import type { RiskTier } from "./types";

/**
 * The risk tier of each operation a rebuilt page starts, so its button can show the tier before
 * the click (ADR-004). The server's registry is the source of truth: server/ops/ui-risk.test.mjs
 * fails when an entry here disagrees with it, so a tier cannot drift silently. Add an entry when
 * a page built on src/ui starts a new operation.
 */
export const operationRisk = {
  "app.action": "low",
  "app.backup": "medium",
  "app.reconfigure": "medium",
  "app.update": "medium",
  "app.vpn.killswitch.drill": "medium",
  "apt.autoremove": "medium",
  "apt.install": "medium",
  "apt.refresh": "low",
  "apt.remove": "medium",
  "apt.unattended.set": "medium",
  "apt.upgrade": "medium",
  "backup.cloud.sync": "medium",
  "backup.remote.sync": "medium",
  "backup.sync": "medium",
  "controller.backup.create": "low",
  "prerequisite.drive-tools.install": "medium",
  "samba.discovery.set": "medium",
  "service.action": "medium",
  "share.reconnect": "medium",
  "storage.backup.relocate": "medium",
  "storage.check": "medium",
  "storage.dirty-mark.clear": "medium",
  "storage.docker-order.apply": "medium",
  "storage.lvm.snapshot.create": "medium",
  "storage.remount": "medium",
  "system.manager.reexec": "medium",
  "system.reboot": "high",
} as const satisfies Record<string, RiskTier>;

export type KnownOperation = keyof typeof operationRisk;

/**
 * Operations whose registry entry says `minimumRole: "owner"`: an operator may not stage them
 * whatever their tier. The same test holds this list to the registry.
 */
export const ownerOnlyOperations: ReadonlySet<string> = new Set<KnownOperation>(["backup.cloud.sync"]);

/** The tier for an operation. An id missing from the table is high, as it is on the server. */
export function riskOf(operationId: string): RiskTier {
  return (operationRisk as Record<string, RiskTier>)[operationId] ?? "high";
}

/**
 * Whether someone in this role may start an operation, as jobs.mjs decides it: a viewer never
 * stages anything, an operator stages anything but high-risk and owner-only operations. Pages
 * leave out the buttons a role cannot use rather than offering a refusal.
 */
export function mayStart(role: string | null | undefined, operationId: string): boolean {
  if (role === "owner") return true;
  if (role !== "operator") return false;
  return riskOf(operationId) !== "high" && !ownerOnlyOperations.has(operationId);
}
