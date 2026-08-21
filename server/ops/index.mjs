import { createRegistry } from "./registry.mjs";
import { setRegistryLookup } from "./risk.mjs";
import { prerequisiteOperations } from "./prerequisites.mjs";
import { aptOperations } from "./apt.mjs";
import { systemOperations } from "./system.mjs";
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

/** The default registry used by the helper and the web service. Add new operation modules here. */
export const operationModules = [prerequisiteOperations, aptOperations, systemOperations, appOperations, serviceOperations, userOperations, firewallOperations, storageOperations, controllerOperations, vmOperations, hostBackupOperations, logOperations, updateOperations, networkOperations, shareOperations, sambaOperations, nfsOperations, upsOperations, fail2banOperations, backupCloudOperations, tailscaleOperations];
export const registry = createRegistry(operationModules);
setRegistryLookup((id) => registry.get(id));
export { createRegistry, defineOperation, validateParameters, riskTiers } from "./registry.mjs";
