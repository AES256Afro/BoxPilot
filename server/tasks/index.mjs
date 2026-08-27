/**
 * Root-side task table for boxpilot-run@.service. Keys are task ids written into the
 * approval spec by the helper; values run as root with network access.
 * Keep this list explicit — it is the only thing the template unit will execute.
 */
import { aptAutoremove, aptInstall, aptRemove, aptUnattendedSet, aptUpdate, aptUpgrade } from "./apt.mjs";
import { dockerLoggingDefaults, setHostname, setLocale, setSwappiness, setTimezone, systemReboot } from "./system.mjs";
import { sshPasswordAuthSet, userAdd, userKeysImport, userSudoSet } from "./users.mjs";
import { firewallProfileApply, firewallRuleAdd, firewallRuleDelete, firewallSet } from "./firewall.mjs";
import { storageFormat, storageLvmExtend, storageLvmSnapshotCreate, storageLvmSnapshotDelete, storageLvmSnapshotRollback, storageMount, storageUnmount, swapFileSet } from "./storage.mjs";
import { shareMount, shareUnmount } from "./shares.mjs";
import { housekeepingRemoveTrees } from "./housekeeping.mjs";
import { routerConnect, routerInspect, routerLeases } from "./router.mjs";
import { dnsBlockerVerify } from "./dns-check.mjs";
import { sambaApply, sambaUserRemove, sambaUserSet } from "./samba.mjs";
import { nfsApply } from "./nfs.mjs";
import { upsSetup } from "./ups.mjs";
import { fail2banApply } from "./fail2ban.mjs";
import { backupCloudSetup, backupCloudSync, backupCloudTest } from "./backup-cloud.mjs";
import { tailscaleSet } from "./tailscale.mjs";
import { ensureCloudImage } from "./cloud-images.mjs";
import { systemUpdate } from "./update.mjs";
import { backupRemoteKeygen, backupRemoteSync, backupRemoteTest } from "./backup-remote.mjs";
import { networkWake } from "./network.mjs";
import { probeAddresses } from "./reachability.mjs";

export const tasks = Object.freeze({
  "apt.update": aptUpdate,
  "apt.upgrade": aptUpgrade,
  "apt.install": aptInstall,
  "apt.remove": aptRemove,
  "apt.autoremove": aptAutoremove,
  "apt.unattended": aptUnattendedSet,
  "system.reboot": systemReboot,
  "system.hostname": setHostname,
  "system.timezone": setTimezone,
  "system.swappiness": setSwappiness,
  "system.locale": setLocale,
  "docker.logging": dockerLoggingDefaults,
  "users.add": userAdd,
  "users.keys-import": userKeysImport,
  "users.sudo": userSudoSet,
  "ssh.password-auth": sshPasswordAuthSet,
  "firewall.set": firewallSet,
  "firewall.rule-add": firewallRuleAdd,
  "firewall.rule-delete": firewallRuleDelete,
  "firewall.profile-apply": firewallProfileApply,
  "storage.mount": storageMount,
  "storage.unmount": storageUnmount,
  "storage.format": storageFormat,
  "storage.swapfile": swapFileSet,
  "storage.lvm-extend": storageLvmExtend,
  "storage.lvm-snapshot-create": storageLvmSnapshotCreate,
  "storage.lvm-snapshot-delete": storageLvmSnapshotDelete,
  "storage.lvm-snapshot-rollback": storageLvmSnapshotRollback,
  "housekeeping.remove-trees": housekeepingRemoveTrees,
  "router.connect": routerConnect,
  "router.inspect": routerInspect,
  "dns.blocker.verify": (parameters) => dnsBlockerVerify(parameters),
  "app.reachability.probe": (parameters) => probeAddresses(parameters),
  "router.leases": routerLeases,
  "share.mount": shareMount,
  "share.unmount": shareUnmount,
  "samba.apply": sambaApply,
  "samba.user.set": sambaUserSet,
  "samba.user.remove": sambaUserRemove,
  "nfs.apply": nfsApply,
  "ups.setup": upsSetup,
  "fail2ban.apply": fail2banApply,
  "backup.cloud.setup": backupCloudSetup,
  "backup.cloud.test": backupCloudTest,
  "backup.cloud.sync": backupCloudSync,
  "tailscale.set": tailscaleSet,
  "vm.cloud-image.ensure": ensureCloudImage,
  "system.update": systemUpdate,
  "backup.remote.keygen": backupRemoteKeygen,
  "backup.remote.test": backupRemoteTest,
  "backup.remote.sync": backupRemoteSync,
  "network.wake": networkWake,
});

export function taskIds() {
  return Object.keys(tasks);
}
