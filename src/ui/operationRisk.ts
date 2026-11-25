import type { RiskTier } from "./types";

/**
 * The risk tier of each operation a rebuilt page starts, so its button can show the tier before
 * the click (ADR-004). The server's registry is the source of truth: server/ops/ui-risk.test.mjs
 * fails when an entry here disagrees with it, so a tier cannot drift silently, and when the UI's
 * source names a changing operation this lacks. Add an entry when a page built on src/ui starts a
 * new operation.
 */
export const operationRisk = {
  "agents.cloud.cap": "medium",
  "agents.cloud.connect": "high",
  "agents.cloud.disconnect": "medium",
  "agents.connector.sync": "low",
  "agents.model.download": "medium",
  "agents.model.remove": "medium",
  "agents.model.switch": "medium",
  "agents.runtime.cpu": "low",
  "agents.runtime.disable": "low",
  "agents.runtime.enable": "medium",
  "agents.runtime.install": "medium",
  "agents.zulip.connect": "medium",
  "agents.zulip.disconnect": "low",
  "app.action": "low",
  "app.backup": "medium",
  "app.backup.delete": "medium",
  "app.backup.many": "medium",
  "app.backup.restore": "high",
  "app.backup.restore-path": "medium",
  "app.backup.verify": "medium",
  "app.compose.edit": "high",
  "app.exposure.set": "medium",
  "app.financialauthority.backups.check": "low",
  "app.financialauthority.restorepoint.make": "low",
  "app.install": "medium",
  "app.model.pull": "medium",
  "app.model.remove": "medium",
  "app.password.set": "medium",
  "app.purge": "high",
  "app.reconfigure": "medium",
  "app.reinstall": "medium",
  "app.rollback": "medium",
  "app.serve.set": "medium",
  "app.serve.withdraw": "medium",
  "app.uninstall": "medium",
  "app.update": "medium",
  "app.update.many": "medium",
  "app.update.available": "medium",
  "app.vpn.killswitch.drill": "medium",
  "app.zulip.organization.link": "medium",
  "apt.autoremove": "medium",
  "apt.install": "medium",
  "apt.refresh": "low",
  "apt.remove": "medium",
  "apt.repair": "medium",
  "apt.unattended.set": "medium",
  "apt.upgrade": "medium",
  "backup.cloud.fetch": "medium",
  "backup.cloud.setup": "medium",
  "backup.cloud.sync": "medium",
  "backup.cloud.test": "medium",
  "backup.remote.setup": "medium",
  "backup.remote.sync": "medium",
  "backup.remote.test": "medium",
  "backup.sync": "medium",
  "catalog.private.remove": "high",
  "catalog.private.save": "high",
  "cloudflare.connect": "high",
  "cloudflare.disconnect": "medium",
  "cloudflare.publish": "high",
  "cloudflare.unpublish": "medium",
  "compose.project.action": "medium",
  "controller.backup.create": "low",
  "controller.backup.protect": "medium",
  "controller.backup.retention.apply": "medium",
  "credentials.remove": "medium",
  "credentials.set": "medium",
  "dns.fallback.rehearse": "medium",
  "dns.lookups.restore": "medium",
  "dns.names.apply": "medium",
  "dns.names.clear": "medium",
  "docker.logging.set": "medium",
  "docker.prune": "medium",
  "fail2ban.apply": "medium",
  "fail2ban.unban": "medium",
  "firewall.profile.apply": "high",
  "firewall.rule.add": "medium",
  "firewall.rule.delete": "medium",
  "firewall.set": "high",
  "heartbeat.set": "medium",
  "heartbeat.test": "low",
  "homepage.sync": "low",
  "host.database.restore": "high",
  "host.snapshot.create": "medium",
  "host.snapshot.restore": "high",
  "host.snapshot.restores.discard": "medium",
  "housekeeping.database-copies.remove": "medium",
  "housekeeping.database-copies.restore": "high",
  "housekeeping.reclaim": "medium",
  "housekeeping.unreadable-snapshot.remove": "medium",
  "network.wake": "low",
  "nfs.apply": "medium",
  "notifications.ntfy.connect": "high",
  "power.wake-on-lan.set": "medium",
  "power.watchdog.disable": "low",
  "power.watchdog.enable": "medium",
  "prerequisite.apt-metadata.refresh": "low",
  "prerequisite.docker.install": "medium",
  "prerequisite.drive-tools.install": "medium",
  "prerequisite.restic.install": "medium",
  "prerequisite.smartmontools.install": "medium",
  "prerequisite.virtualization.install": "medium",
  "registry.signin": "high",
  "registry.signout": "medium",
  "router.connect": "medium",
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
  "space.cleanup": "medium",
  "ssh.password-auth.set": "high",
  "storage.backup.relocate": "medium",
  "storage.check": "medium",
  "storage.dirty-mark.clear": "medium",
  "storage.boot-mark.clear": "medium",
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
  "storage.swapfile.set": "medium",
  "storage.unmount": "medium",
  "storage.writable": "medium",
  "system.hostname.set": "medium",
  "system.locale.set": "medium",
  "system.manager.reexec": "medium",
  "system.reboot": "high",
  "system.swappiness.set": "medium",
  "system.timezone.set": "medium",
  "system.update": "high",
  "system.update.signer.set": "high",
  "system.web.lan.set": "medium",
  "system.web.tls.provision": "medium",
  "tailscale.serve.socket": "medium",
  "tailscale.set": "medium",
  "ups.setup": "medium",
  "users.add": "medium",
  "users.keys.import": "high",
  "users.lock": "medium",
  "users.remove": "high",
  "users.sudo.set": "high",
  "users.unlock": "medium",
  "vm.action": "medium",
  "vm.backup.restore-drill": "medium",
  "vm.backup.retention.apply": "medium",
  "vm.backup.snapshot.forget": "high",
  "vm.cloud.create": "medium",
  "vm.create": "high",
  "vm.delete": "high",
  "vm.export.create": "medium",
  "vm.export.protect": "medium",
  "vm.force-off": "medium",
  "vm.foundation.initialize": "medium",
  "vm.media.import": "medium",
  "vm.recovery.create": "medium",
  "vm.snapshot.create": "medium",
  "vm.snapshot.delete": "medium",
  "vm.snapshot.revert": "high",
  "vpn.profile.clear": "medium",
  "vpn.profile.set": "medium",
} as const satisfies Record<string, RiskTier>;

export type KnownOperation = keyof typeof operationRisk;

/** Whether an id read from data (a job's type, a manifest's action) is one the table knows. */
export function isKnownOperation(operationId: string): operationId is KnownOperation {
  return Object.hasOwn(operationRisk, operationId);
}

/**
 * The id a helper below takes (M84). A literal must be a KnownOperation, so a mistyped id in a page
 * fails tsc instead of drawing its button as high; an id that arrives as data is typed `string` and
 * still passes, because the server decides what Repair, setup steps and manifests name, and an id
 * this table lacks is high, as it is on the server. A page's own `may(...)` wrapper takes
 * KnownOperation for the same reason: one typed `string` would let every literal through it unchecked.
 */
type OperationIdArgument<T extends string> = T & (string extends T ? string : KnownOperation);

/**
 * Operations whose registry entry says `minimumRole: "owner"`: an operator may not stage them
 * whatever their tier. The same test holds this list to the registry.
 */
export const ownerOnlyOperations: ReadonlySet<string> = new Set<KnownOperation>(["agents.cloud.cap", "agents.cloud.connect", "agents.cloud.disconnect", "agents.connector.sync", "agents.model.download", "agents.model.remove", "agents.model.switch", "agents.runtime.cpu", "agents.runtime.enable", "agents.runtime.install", "agents.zulip.connect", "agents.zulip.disconnect", "app.backup.delete", "app.zulip.organization.link", "backup.cloud.fetch", "backup.cloud.setup", "backup.cloud.sync", "backup.cloud.test", "catalog.private.remove", "catalog.private.save", "cloudflare.connect", "cloudflare.disconnect", "cloudflare.publish", "cloudflare.unpublish", "credentials.remove", "credentials.set", "heartbeat.set", "heartbeat.test", "host.database.restore", "housekeeping.database-copies.remove", "housekeeping.database-copies.restore", "housekeeping.unreadable-snapshot.remove", "notifications.ntfy.connect", "registry.signin", "registry.signout", "router.connect", "storage.fs-snapshot.delete", "storage.lvm.snapshot.delete", "system.update.signer.set", "system.web.lan.set", "system.web.tls.provision", "tailscale.serve.socket", "vm.backup.snapshot.forget", "vm.snapshot.delete", "vpn.profile.clear", "vpn.profile.set"]);

/** The tier for an operation. An id missing from the table is high, as it is on the server. */
export function riskOf<T extends string>(operationId: OperationIdArgument<T>): RiskTier {
  return isKnownOperation(operationId) ? operationRisk[operationId] : "high";
}

/**
 * Whether someone in this role may start an operation, as jobs.mjs decides it: a viewer never
 * stages anything, an operator stages anything but high-risk and owner-only operations. Pages
 * leave out the buttons a role cannot use rather than offering a refusal.
 */
export function mayStart<T extends string>(role: string | null | undefined, operationId: OperationIdArgument<T>): boolean {
  if (role === "owner") return true;
  if (role !== "operator") return false;
  return riskOf(operationId) !== "high" && !ownerOnlyOperations.has(operationId);
}
