import path from "node:path";
import { validUuid } from "./keel-artifact-spec.mjs";

export const keelPromotionPaths = Object.freeze({
  root: "/var/lib/boxpilot-managed/keel-promotions",
  rollbackRoot: "/var/lib/boxpilot-managed/keel-promotion-rollbacks",
  approval: "/run/boxpilot/keel-promotion-approval.json",
  active: "/var/lib/boxpilot-managed/keel-promotions/.active.json",
});

export const keelPromotionIdentity = Object.freeze({
  schemaVersion: 1,
  applicationId: "keel",
  releaseVersion: "1.2.6",
  unitName: "boxpilot-keel-promotion.service",
  serviceUnitName: "keel.service",
  network: "host-loopback-only",
  port: 3000,
});

export function pathsForKeelPromotion(promotionId, paths = keelPromotionPaths) {
  if (!validUuid(promotionId)) throw new Error("Keel promotion id must be a UUID");
  const root = path.resolve(paths.root);
  const rollbackRoot = path.resolve(paths.rollbackRoot);
  const candidate = path.join(root, `.${promotionId}.candidate`);
  const result = path.join(root, `${promotionId}.result.json`);
  const activePartial = `${path.resolve(paths.active)}.${promotionId}.partial`;
  const rollbackPartial = path.join(rollbackRoot, `.${promotionId}.partial`);
  const rollbackFinal = path.join(rollbackRoot, promotionId);
  for (const target of [candidate, result]) if (path.dirname(target) !== root) throw new Error("Keel promotion path escaped its fixed root");
  for (const target of [rollbackPartial, rollbackFinal]) if (path.dirname(target) !== rollbackRoot) throw new Error("Keel rollback path escaped its fixed root");
  if (path.dirname(activePartial) !== path.dirname(path.resolve(paths.active))) throw new Error("Keel promotion marker path escaped its fixed root");
  return {
    root,
    rollbackRoot,
    candidate,
    result,
    activePartial,
    rollbackPartial,
    rollbackPartialState: path.join(rollbackPartial, "state"),
    rollbackPartialEvidence: path.join(rollbackPartial, "rollback.json"),
    rollbackFinal,
    rollbackFinalState: path.join(rollbackFinal, "state"),
    rollbackFinalEvidence: path.join(rollbackFinal, "rollback.json"),
  };
}
