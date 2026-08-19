import { createRegistry } from "./registry.mjs";
import { prerequisiteOperations } from "./prerequisites.mjs";

/** The default registry used by the helper and the web service. Add new operation modules here. */
export const operationModules = [prerequisiteOperations];
export const registry = createRegistry(operationModules);
export { createRegistry, defineOperation, validateParameters, riskTiers } from "./registry.mjs";
