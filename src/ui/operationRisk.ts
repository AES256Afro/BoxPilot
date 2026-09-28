import type { RiskTier } from "./types";

/**
 * The risk tier of each operation a rebuilt page starts, so its button can show the tier before
 * the click (ADR-004). The server's registry is the source of truth: server/ops/ui-risk.test.mjs
 * fails when an entry here disagrees with it, so a tier cannot drift silently. Add an entry when
 * a page built on src/ui starts a new operation.
 */
export const operationRisk = {
  "apt.autoremove": "medium",
  "apt.install": "medium",
  "apt.refresh": "low",
  "apt.remove": "medium",
  "apt.unattended.set": "medium",
  "apt.upgrade": "medium",
  "service.action": "medium",
  "storage.lvm.snapshot.create": "medium",
  "system.manager.reexec": "medium",
  "system.reboot": "high",
} as const satisfies Record<string, RiskTier>;

export type KnownOperation = keyof typeof operationRisk;

/** The tier for an operation. An id missing from the table is high, as it is on the server. */
export function riskOf(operationId: string): RiskTier {
  return (operationRisk as Record<string, RiskTier>)[operationId] ?? "high";
}
