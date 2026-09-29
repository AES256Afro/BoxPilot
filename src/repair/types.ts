import type { RiskTier } from "../ui/types";

/*
 * What Repair's scan answers (server/remediations.mjs, server/repair-ledger.mjs), shared by the
 * Repair page, Home and Ops so the three offer the same fixes the same way (M35).
 */

export type Severity = "critical" | "warning" | "info";

/** A schedule a "Back up nightly" fix creates, one per app. */
export interface ScheduleSpec {
  parameters: Record<string, unknown>;
  frequency: "hourly" | "daily" | "weekly";
  minute: number;
  hour?: number;
  weekday?: number;
}

/** One way to fix a finding: a registry operation run through the approval dialog, or schedules to create. */
export interface RepairFix {
  kind?: "operation" | "schedule";
  operationId: string;
  parameters?: Record<string, unknown>;
  label: string;
  preview: string;
  /** The registry's tier, from the scan; the UI's own table is the fallback. */
  risk?: RiskTier;
  schedules?: ScheduleSpec[];
}

/** The newest job that tried to fix a finding. */
export interface LastAttempt {
  jobId: string;
  state: string;
  error: string | null;
  at: string | null;
  title: string;
  operationId: string;
  label: string | null;
}

export interface Finding {
  id: string;
  severity: Severity;
  title: string;
  detail: string;
  evidence: string[];
  fix: RepairFix | null;
  /** Every fix, best first; `fix` is the first. Older servers send only `fix`. */
  fixes?: RepairFix[];
  manual: string | null;
  /** What the finding says, hashed; a dismissal holds only while it matches. */
  fingerprint?: string;
  lastAttempt?: LastAttempt | null;
  /** Dismissed before and back: it changed since, or it is critical. */
  returned?: { reason: string; at: string; why: "changed" | "critical" } | null;
  /** Set aside, with the owner's reason (only on the dismissed list). */
  dismissal?: { reason: string; at: string; by: string | null } | null;
}

export interface RepairScan {
  findings: Finding[];
  dismissed: Finding[];
  counts: { critical: number; warning: number; info: number };
  /** Failed jobs the pages must not show as failures of their own: shown on a finding, their finding gone, or set aside. */
  jobs: { attached: string[]; resolved: string[]; dismissed: string[] };
  checkedAt?: string;
  sourceStatus?: "ready" | "partial";
  unavailableChecks: string[];
}

export const fixesOf = (finding: Pick<Finding, "fix" | "fixes">): RepairFix[] => (finding.fixes?.length ? finding.fixes : finding.fix ? [finding.fix] : []);

/** A scan answer, checked for shape: a list that is not there is a failure, not "nothing wrong". */
export function scanFrom(body: unknown): RepairScan {
  const value = (body ?? {}) as Partial<RepairScan> & { findings?: unknown };
  if (!Array.isArray(value.findings)) throw new Error("The problem scan had no findings list");
  const valid = (list: unknown): Finding[] => (Array.isArray(list) ? list.filter((entry): entry is Finding => Boolean(entry && typeof (entry as Finding).id === "string" && typeof (entry as Finding).title === "string")) : []);
  const findings = valid(value.findings);
  const ids = (list: unknown) => (Array.isArray(list) ? list.filter((entry): entry is string => typeof entry === "string") : []);
  const counted = (severity: Severity) => findings.filter((entry) => entry.severity === severity).length;
  return {
    findings,
    dismissed: valid(value.dismissed),
    counts: value.counts && typeof value.counts === "object" ? value.counts : { critical: counted("critical"), warning: counted("warning"), info: counted("info") },
    jobs: { attached: ids(value.jobs?.attached), resolved: ids(value.jobs?.resolved), dismissed: ids(value.jobs?.dismissed) },
    checkedAt: value.checkedAt,
    sourceStatus: value.sourceStatus,
    unavailableChecks: ids(value.unavailableChecks),
  };
}
