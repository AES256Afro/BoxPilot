import path from "node:path";
import { validUuid } from "./keel-artifact-spec.mjs";

export const keelRecoveryPaths = Object.freeze({
  root: "/var/lib/boxpilot-managed/keel-recoveries",
});

export function pathsForKeelRecovery(recoveryId, paths = keelRecoveryPaths) {
  if (!validUuid(recoveryId)) throw new Error("Keel recovery id must be a UUID");
  const root = path.resolve(paths.root);
  const partial = path.join(root, `.${recoveryId}.partial`);
  const recovery = path.join(root, recoveryId);
  if (path.dirname(partial) !== root || path.dirname(recovery) !== root) throw new Error("Keel recovery paths escaped their fixed root");
  return {
    root,
    partial,
    extraction: path.join(partial, "extraction"),
    exportRoot: path.join(partial, "extraction", "keel-export"),
    state: path.join(partial, "state"),
    final: recovery,
    finalState: path.join(recovery, "state"),
    evidence: path.join(partial, "recovery.json"),
    finalEvidence: path.join(recovery, "recovery.json"),
  };
}
