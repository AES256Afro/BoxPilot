import path from "node:path";
import { validUuid } from "./keel-artifact-spec.mjs";

export const keelRollbackPaths = Object.freeze({
  root: "/var/lib/boxpilot-managed/keel-rollbacks",
  displacedRoot: "/var/lib/boxpilot-managed/keel-rollback-checkpoints",
  approval: "/run/boxpilot/keel-rollback-approval.json",
  active: "/var/lib/boxpilot-managed/keel-rollbacks/.active.json",
});

export const keelRollbackIdentity = Object.freeze({
  schemaVersion: 1,
  applicationId: "keel",
  releaseVersion: "1.2.6",
  unitName: "boxpilot-keel-rollback.service",
  serviceUnitName: "keel.service",
  network: "host-loopback-only",
  port: 3000,
});

export function pathsForKeelRollback(rollbackId, paths = keelRollbackPaths) {
  if (!validUuid(rollbackId)) throw new Error("Keel rollback id must be a UUID");
  const root = path.resolve(paths.root);
  const displacedRoot = path.resolve(paths.displacedRoot);
  const candidate = path.join(root, `.${rollbackId}.candidate`);
  const result = path.join(root, `${rollbackId}.result.json`);
  const activePartial = `${path.resolve(paths.active)}.${rollbackId}.partial`;
  const displacedPartial = path.join(displacedRoot, `.${rollbackId}.partial`);
  const displacedFinal = path.join(displacedRoot, rollbackId);
  for (const target of [candidate, result]) if (path.dirname(target) !== root) throw new Error("Keel rollback path escaped its fixed root");
  if (path.dirname(activePartial) !== path.dirname(path.resolve(paths.active))) throw new Error("Keel rollback marker path escaped its fixed root");
  for (const target of [displacedPartial, displacedFinal]) if (path.dirname(target) !== displacedRoot) throw new Error("Keel displaced-state path escaped its fixed root");
  return {
    root,
    displacedRoot,
    candidate,
    result,
    activePartial,
    displacedPartial,
    displacedPartialState: path.join(displacedPartial, "state"),
    displacedPartialEvidence: path.join(displacedPartial, "checkpoint.json"),
    displacedFinal,
    displacedFinalState: path.join(displacedFinal, "state"),
    displacedFinalEvidence: path.join(displacedFinal, "checkpoint.json"),
  };
}
