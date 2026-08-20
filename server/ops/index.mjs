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
import { vmOperations } from "./vms.mjs";

/** The default registry used by the helper and the web service. Add new operation modules here. */
export const operationModules = [prerequisiteOperations, aptOperations, systemOperations, appOperations, serviceOperations, userOperations, firewallOperations, storageOperations, vmOperations];
export const registry = createRegistry(operationModules);
setRegistryLookup((id) => registry.get(id));
export { createRegistry, defineOperation, validateParameters, riskTiers } from "./registry.mjs";
