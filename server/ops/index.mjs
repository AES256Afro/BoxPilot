import { createRegistry } from "./registry.mjs";
import { setRegistryLookup } from "./risk.mjs";
import { prerequisiteOperations } from "./prerequisites.mjs";
import { aptOperations } from "./apt.mjs";

/** The default registry used by the helper and the web service. Add new operation modules here. */
export const operationModules = [prerequisiteOperations, aptOperations];
export const registry = createRegistry(operationModules);
setRegistryLookup((id) => registry.get(id));
export { createRegistry, defineOperation, validateParameters, riskTiers } from "./registry.mjs";
