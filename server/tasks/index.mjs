/**
 * Root-side task table for boxpilot-run@.service. Keys are task ids written into the
 * approval spec by the helper; values run as root with network access.
 * Keep this list explicit — it is the only thing the template unit will execute.
 */
import { aptAutoremove, aptInstall, aptRemove, aptRepair, aptUnattendedSet, aptUpdate, aptUpgrade } from "./apt.mjs";
import { dockerLoggingDefaults, setHostname, setLocale, setSwappiness, setTimezone, systemReboot } from "./system.mjs";
import { sshPasswordAuthSet, userAdd, userKeysImport, userSudoSet } from "./users.mjs";
import { firewallProfileApply, firewallRuleAdd, firewallRuleDelete, firewallSet } from "./firewall.mjs";
import { storageCheck, storageClearMark, storageFormat, storageLvmExtend, storageLvmSnapshotCreate, storageLvmSnapshotDelete, storageLvmSnapshotRollback, storageMount, storageRemount, storageUnmount, swapFileSet } from "./storage.mjs";
import { storageDockerOrder, storageVolumeState } from "./drive-shutdown.mjs";
import { storageWritable } from "./drive-writable.mjs";
import { shareMount, shareReconnect, shareUnmount } from "./shares.mjs";
import { moveBackupMount } from "./backup-mount-move.mjs";
import { housekeepingRemoveTrees } from "./housekeeping.mjs";
import { aptClean, journalVacuum } from "./space.mjs";
import { routerConnect, routerInspect, routerLeases } from "./router.mjs";
import { dnsBlockerVerify } from "./dns-check.mjs";
import { sambaApply, sambaDiscoverySet, sambaRecycleEmpty, sambaShareWritable, sambaUserRemove, sambaUserSet } from "./samba.mjs";
import { fsSnapshotCreate, fsSnapshotDelete } from "./fs-snapshots.mjs";
import { nfsApply } from "./nfs.mjs";
import { upsSetup } from "./ups.mjs";
import { fail2banApply } from "./fail2ban.mjs";
import { backupCloudSetup, backupCloudSync, backupCloudTest } from "./backup-cloud.mjs";
import { tailscaleSet } from "./tailscale.mjs";
import { ensureCloudImage } from "./cloud-images.mjs";
import { systemUpdate } from "./update.mjs";
import { backupRemoteKeygen, backupRemoteSync, backupRemoteTest } from "./backup-remote.mjs";
import { networkWake } from "./network.mjs";
import { webBindSet } from "./web-bind.mjs";
import { webTlsProvision } from "./web-tls.mjs";
import { probeAddresses } from "./reachability.mjs";
import { httpRequest } from "./http-request.mjs";
import { agentsConnectorSync, agentsDisable, agentsEnable, agentsInstall, agentsModelDownload, agentsModelRemove } from "./agents.mjs";
import { hostListeners } from "./listeners.mjs";
import { zulipCheck, zulipEvents, zulipPoll, zulipPost } from "./zulip.mjs";
import { dnsFallbackRehearse } from "./dns-rehearsal.mjs";
import { heartbeatConfigure, heartbeatPing } from "./heartbeat.mjs";
import { cloudflareCheck, cloudflareConnect, cloudflarePublish, cloudflareUnpublish } from "./cloudflare.mjs";
import { modelGatewayCap, modelGatewayConnect, modelGatewayDisconnect } from "./model-gateway.mjs";

export const tasks = Object.freeze({
  "apt.update": aptUpdate,
  "apt.repair": aptRepair,
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
  "storage.remount": storageRemount,
  "storage.writable": storageWritable,
  "storage.check": storageCheck,
  "storage.clear-mark": storageClearMark,
  "storage.docker-order": storageDockerOrder,
  "storage.volume-state": storageVolumeState,
  "storage.backup-relocate": moveBackupMount,
  "storage.format": storageFormat,
  "storage.swapfile": swapFileSet,
  "storage.lvm-extend": storageLvmExtend,
  "storage.lvm-snapshot-create": storageLvmSnapshotCreate,
  "storage.lvm-snapshot-delete": storageLvmSnapshotDelete,
  "storage.lvm-snapshot-rollback": storageLvmSnapshotRollback,
  "housekeeping.remove-trees": housekeepingRemoveTrees,
  "journal.vacuum": journalVacuum,
  "apt.clean": aptClean,
  "router.connect": routerConnect,
  "router.inspect": routerInspect,
  "dns.blocker.verify": (parameters) => dnsBlockerVerify(parameters),
  "app.reachability.probe": (parameters) => probeAddresses(parameters),
  "host.listeners": (parameters, context) => hostListeners(parameters, context),
  "http.request": (parameters) => httpRequest(parameters),
  "web.bind.set": (parameters) => webBindSet(parameters),
  "web.tls.provision": (parameters) => webTlsProvision(parameters),
  "router.leases": routerLeases,
  "share.mount": shareMount,
  "share.unmount": shareUnmount,
  "share.reconnect": shareReconnect,
  "storage.fs-snapshot.create": fsSnapshotCreate,
  "storage.fs-snapshot.delete": fsSnapshotDelete,
  "samba.apply": sambaApply,
  "samba.recycle.empty": sambaRecycleEmpty,
  "samba.discovery.set": sambaDiscoverySet,
  "samba.share.writable": sambaShareWritable,
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
  // The agents runtime (M37): Unsloth, the capped runner unit, and its models.
  "agents.install": (parameters, context) => agentsInstall(parameters, context),
  "agents.enable": (parameters, context) => agentsEnable(parameters, context),
  "agents.disable": (parameters, context) => agentsDisable(parameters, context),
  "agents.model.download": (parameters, context) => agentsModelDownload(parameters, context),
  "agents.connector.sync": (parameters, context) => agentsConnectorSync(parameters, context),
  "agents.model.remove": (parameters, context) => agentsModelRemove(parameters, context),
  // The model gateway (M45.3): the Claude key root-only, the monthly cap, the gateway on and off.
  "model-gateway.connect": (parameters, context) => modelGatewayConnect(parameters, context),
  "model-gateway.cap": (parameters, context) => modelGatewayCap(parameters, context),
  "model-gateway.disconnect": (parameters, context) => modelGatewayDisconnect(parameters, context),
  "agents.zulip.check": (parameters, context) => zulipCheck(parameters, context),
  "agents.zulip.post": (parameters, context) => zulipPost(parameters, context),
  "agents.zulip.poll": (parameters, context) => zulipPoll(parameters, context),
  "agents.zulip.events": (parameters, context) => zulipEvents(parameters, context),
  // M39: whether the router falls back when the DNS app here is away, and the heartbeat's timer.
  "dns.fallback.rehearse": (parameters, context) => dnsFallbackRehearse(parameters, context),
  "heartbeat.configure": (parameters, context) => heartbeatConfigure(parameters, context),
  "heartbeat.ping": (parameters, context) => heartbeatPing(parameters, context),
  // M42: Cloudflare's API, for publishing an app through the tunnel. Each reads the API token itself.
  "cloudflare.connect": (parameters, context) => cloudflareConnect(parameters, { log: context?.log }),
  "cloudflare.publish": (parameters, context) => cloudflarePublish(parameters, { log: context?.log }),
  "cloudflare.unpublish": (parameters, context) => cloudflareUnpublish(parameters, { log: context?.log }),
  "cloudflare.check": (parameters, context) => cloudflareCheck(parameters, { log: context?.log }),
});

export function taskIds() {
  return Object.keys(tasks);
}
