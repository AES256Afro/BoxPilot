import { describe, expect, it } from "vitest";
import { escalationRiskHooks } from "./escalation.mjs";
import { registry } from "./index.mjs";

/**
 * Every operation an operator may approve alone that takes a path, a name, a list or free text, and
 * why it cannot reach what a high operation guards (ADR-015). A new one fails this test until
 * someone has looked: give it a hook in escalation.mjs, make it high or owner-only, or say here why
 * it needs neither. The reasons are the 2026-10 reviews' findings, kept short.
 */
const reviewed = {
  "prerequisite.smartmontools.install": "installs one pinned package version the web side approved",
  "prerequisite.drive-tools.install": "installs a fixed package set, versions pinned",
  "prerequisite.restic.install": "installs one pinned package version",
  "prerequisite.docker.install": "installs one pinned package version",
  "prerequisite.virtualization.install": "installs a fixed package set, versions pinned",
  "prerequisite.apt-metadata.refresh": "apt-get update; the parameter is a freshness stamp",
  "apt.upgrade": "--no-remove, and `upgrade` never removes; routine security updates stay one approval",
  "apt.install": "--no-remove: a trailing \"-\" or a Conflicts is refused by apt; removals are apt.remove's",
  "system.locale.set": "strict pattern, must already be generated, passed as one argument",
  "system.hostname.set": "strict hostname pattern, passed as one argument",
  "system.timezone.set": "timedatectl validates the zone, passed as one argument",
  "compose.project.action": "strict project-name pattern, fixed actions",
  "app.serve.set": "refuses a tailnet port whose Serve entry is not this app's (servesThisApp)",
  "app.rollback": "the version comes from the app's own recorded history, limited to its catalog image",
  "homepage.sync": "host is a strict hostname pattern written into the dashboard's links",
  "app.backup.verify": "backup name pattern; reads an archive BoxPilot wrote",
  "app.backup.restore-path": "relative-path validation, staged extraction, links refused, compose and boxpilot.json reviewed",
  "app.uninstall": "keeps the app's data folder",
  "app.reinstall": "rebuilds from the saved compose project or the catalog",
  "app.vpn.killswitch.drill": "fixed drill against the app's own VPN sidecar",
  "app.update": "moves to the catalog's image for the app",
  "app.update.many": "app.update for each named app: the catalog's image, nothing the caller chooses",
  "app.update.available": "app.update for each installed app the catalog has a newer image for; the caller only chooses apps to leave out",
  "app.exposure.set": "fixed modes; never serves or withdraws a tailnet port whose Serve entry is not this app's",
  "app.password.set": "newlines refused; the app's own admin password",
  "app.model.pull": "model-name pattern, passed as one argument to the app's own runtime",
  "app.model.remove": "model-name pattern; a model can be pulled again",
  "app.action": "fixed actions on the app's own containers",
  "app.financialauthority.restorepoint.make": "its one field is an enum of the app's own id; the app copies its database beside its other copies",
  "app.financialauthority.backups.check": "its one field is an enum of the app's own id; SQLite reads that database and its newest copies",
  "firewall.rule.add": "SSH, Tailscale and BoxPilot's own ports are refused in the task",
  "firewall.rule.delete": "the same protected ports are refused",
  "storage.fs-snapshot.create": "creates a snapshot; nothing is removed",
  "storage.check": "a managed drive by name; fsck after the holders are stopped",
  "storage.dirty-mark.clear": "a managed drive by name, after a clean check",
  "storage.remount": "a managed drive by name",
  "storage.writable": "a managed drive by name; ownership to the apps user",
  "storage.unmount": "a managed drive by name; a disk that is in use is refused",
  "storage.lvm.extend": "grows a volume into free space; no data loss",
  "storage.lvm.snapshot.create": "creates a snapshot; name patterns",
  "storage.lvm.snapshot.delete": "pattern limited to BoxPilot's own snapshot volumes (owner-only with #489)",
  "storage.fs-snapshot.delete": "btrfs limited to .boxpilot-snapshots (owner-only with #489)",
  "controller.backup.protect": "backup id pinned by the prepare hook; copies, never prunes",
  "controller.backup.retention.apply": "snapshot set pinned by the prepare hook; never prunes",
  "vm.cloud.create": "allow-listed keys, YAML.stringify, user/package/key patterns, fixed runcmd; root only inside the guest",
  "vm.media.import": "candidates from a listing that skips links, fixed roots, hashes pinned",
  "vm.export.create": "VM name pattern; writes under the export root",
  "vm.export.protect": "export id pinned; copies off the box to the destination the owner set",
  "vm.backup.retention.apply": "snapshot set pinned by the prepare hook; never prunes",
  "vm.backup.restore-drill": "isolated transient guest with no network; disks refused with a backing file",
  "vm.recovery.create": "parameters pinned by the prepare hook; no network interface",
  "vm.foundation.initialize": "fixed libvirt layout",
  "vm.action": "VM name pattern, fixed actions",
  "vm.force-off": "power-off of a guest; it can be started again",
  "vm.snapshot.create": "creates a snapshot; name patterns",
  "host.snapshot.create": "writes a snapshot to the snapshot root",
  "host.snapshot.restores.discard": "timestamp pattern; deletes only review copies under the snapshot root",
  "backup.remote.test": "the destination the owner saved replaces the request's (prepare hook)",
  "backup.remote.sync": "the destination the owner saved replaces the request's (prepare hook)",
  "network.wake": "MAC pattern; sends a wake packet",
  "share.unmount": "a managed share by name",
  "share.reconnect": "a managed share by name",
  "samba.share.writable": "a configured share by name; ownership to the apps user",
  "samba.user.set": "refuses root and accounts below uid 1000 it did not create; password on stdin",
  "samba.user.remove": "only accounts BoxPilot created",
  "ups.setup": "enum- or pattern-bound fields, no quotes or newlines; password generated",
  "power.wake-on-lan.set": "interface must be one listed from /sys/class/net",
  "housekeeping.reclaim": "category enum; keeps 3 backups per app; unreadable snapshots refused",
  "dns.fallback.rehearse": "IPv4 patterns, app from an enum; a safety timer restarts DNS",
};

describe("every free-form operation an operator approves alone has been looked at", () => {
  const unattended = registry.ids().map((id) => registry.get(id))
    .filter((operation) => !operation.readOnly && !operation.internal && operation.risk !== "high" && operation.minimumRole !== "owner")
    .filter((operation) => Object.values(operation.parameters?.fields ?? {}).some((field) => ["string", "array", "object"].includes(field.type)));

  it("has a hook in escalation.mjs or a reason here", () => {
    const unlooked = unattended.map((operation) => operation.id).filter((id) => !(id in escalationRiskHooks) && !(id in reviewed));
    expect(unlooked, "add a hook in escalation.mjs, raise the tier, or give the reason in reviewed").toEqual([]);
  });

  it("names no operation that has gone or now has a hook", () => {
    expect(Object.keys(reviewed).filter((id) => !registry.get(id) || id in escalationRiskHooks)).toEqual([]);
  });
});
