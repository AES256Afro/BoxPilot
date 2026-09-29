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
  "app.backup.many": "medium",
  "app.install": "medium",
  "app.reconfigure": "medium",
  "app.reinstall": "medium",
  "app.uninstall": "medium",
  "app.update": "medium",
  "app.vpn.killswitch.drill": "medium",
  "apt.autoremove": "medium",
  "apt.install": "medium",
  "apt.refresh": "low",
  "apt.remove": "medium",
  "apt.repair": "medium",
  "apt.unattended.set": "medium",
  "apt.upgrade": "medium",
  "backup.cloud.setup": "medium",
  "backup.cloud.sync": "medium",
  "backup.cloud.test": "medium",
  "backup.remote.setup": "medium",
  "backup.remote.sync": "medium",
  "backup.remote.test": "medium",
  "backup.sync": "medium",
  "controller.backup.create": "low",
  "controller.backup.protect": "medium",
  "controller.backup.retention.apply": "medium",
  "host.snapshot.create": "medium",
  "host.snapshot.restore": "high",
  "host.snapshot.restores.discard": "medium",
  "housekeeping.database-copies.remove": "medium",
  "housekeeping.reclaim": "medium",
  "nfs.apply": "medium",
  "notifications.ntfy.connect": "high",
  "prerequisite.apt-metadata.refresh": "low",
  "prerequisite.docker.install": "medium",
  "prerequisite.drive-tools.install": "medium",
  "prerequisite.restic.install": "medium",
  "prerequisite.virtualization.install": "medium",
  "samba.apply": "medium",
  "samba.discovery.set": "medium",
  "samba.recycle.empty": "medium",
  "samba.share.writable": "medium",
  "samba.user.remove": "medium",
  "samba.user.set": "medium",
  "service.action": "medium",
  "share.mount": "medium",
  "share.reconnect": "medium",
  "share.unmount": "medium",
  "storage.backup.relocate": "medium",
  "storage.check": "medium",
  "storage.dirty-mark.clear": "medium",
  "storage.docker-order.apply": "medium",
  "storage.format": "high",
  "storage.fs-snapshot.create": "medium",
  "storage.fs-snapshot.delete": "medium",
  "storage.lvm.extend": "medium",
  "storage.lvm.snapshot.create": "medium",
  "storage.lvm.snapshot.delete": "medium",
  "storage.lvm.snapshot.rollback": "high",
  "storage.mount": "medium",
  "storage.remount": "medium",
  "storage.unmount": "medium",
  "storage.writable": "medium",
  "system.manager.reexec": "medium",
  "system.reboot": "high",
  "system.update": "high",
} as const satisfies Record<string, RiskTier>;

export type KnownOperation = keyof typeof operationRisk;

/**
 * Operations whose registry entry says `minimumRole: "owner"`: an operator may not stage them
 * whatever their tier. The same test holds this list to the registry.
 */
export const ownerOnlyOperations: ReadonlySet<string> = new Set<KnownOperation>(["backup.cloud.setup", "backup.cloud.sync", "backup.cloud.test", "housekeeping.database-copies.remove", "notifications.ntfy.connect"]);

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
