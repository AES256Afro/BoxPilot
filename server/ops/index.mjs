import { createRegistry } from "./registry.mjs";
import { setRegistryLookup } from "./risk.mjs";
import { prerequisiteOperations } from "./prerequisites.mjs";
import { aptOperations } from "./apt.mjs";
import { systemOperations } from "./system.mjs";
import { housekeepingOperations } from "./housekeeping.mjs";
import { spaceOperations } from "./space.mjs";
import { performanceOperations } from "./performance.mjs";
import { localDnsOperations } from "./local-dns.mjs";
import { routerOperations } from "./router.mjs";
import { appOperations } from "./apps.mjs";
import { serviceOperations } from "./services.mjs";
import { userOperations } from "./users.mjs";
import { firewallOperations } from "./firewall.mjs";
import { storageOperations } from "./storage.mjs";
import { controllerOperations } from "./controller.mjs";
import { vmOperations } from "./vms.mjs";
import { hostBackupOperations } from "./host-backup.mjs";
import { logOperations } from "./logs.mjs";
import { updateOperations } from "./update.mjs";
import { networkOperations } from "./network.mjs";
import { shareOperations } from "./shares.mjs";
import { sambaOperations } from "./samba.mjs";
import { nfsOperations } from "./nfs.mjs";
import { upsOperations } from "./ups.mjs";
import { fail2banOperations } from "./fail2ban.mjs";
import { backupCloudOperations } from "./backup-cloud.mjs";
import { tailscaleOperations } from "./tailscale.mjs";
import { connectorOperations } from "./connectors.mjs";
import { vpnOperations } from "./vpn.mjs";
import { notificationOperations } from "./notifications.mjs";
import { agentsOperations } from "./agents.mjs";
import { zulipOperations } from "./zulip.mjs";
import { dnsResilienceOperations } from "./dns-resilience.mjs";
import { heartbeatOperations } from "./heartbeat.mjs";
import { cloudflareOperations } from "./cloudflare.mjs";
import { agentsCloudOperations } from "./agents-cloud.mjs";

/** The default registry used by the helper and the web service. Add new operation modules here. */
export const operationModules = [prerequisiteOperations, aptOperations, systemOperations, appOperations, serviceOperations, userOperations, firewallOperations, storageOperations, controllerOperations, vmOperations, hostBackupOperations, logOperations, updateOperations, networkOperations, shareOperations, sambaOperations, nfsOperations, upsOperations, fail2banOperations, backupCloudOperations, tailscaleOperations, housekeepingOperations, spaceOperations, performanceOperations, localDnsOperations, routerOperations, connectorOperations, vpnOperations, notificationOperations, agentsOperations, zulipOperations,
  // M39: DNS that survives this server being off, and the heartbeat that says it is up.
  dnsResilienceOperations, heartbeatOperations,
  // M42: publish an app to the internet through Cloudflare Tunnel.
  cloudflareOperations,
  // M45.3: Claude for the agents, through the model gateway.
  agentsCloudOperations];
export const registry = createRegistry(operationModules);
setRegistryLookup((id) => registry.get(id));
export { createRegistry, defineOperation, validateParameters, riskTiers } from "./registry.mjs";
