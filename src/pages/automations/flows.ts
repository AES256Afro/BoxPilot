/**
 * Automations (M13.2, ADR-002): ordered lists of registered operations, run as ordinary jobs.
 * The shapes the flows API answers with, and the few words the page says about them.
 */

export interface FlowStep { operationId: string; parameters?: Record<string, unknown>; name?: string; onFailure?: "stop" | "continue"; when?: { value: string; equals?: unknown }; retry?: number }

export interface Flow {
  // createdBy is null for someone else's flow unless you are the owner; so is a run another account
  // started, which comes with lastRunElsewhere, its outcome, and none of its jobs (M29.4).
  id: string; name: string; steps: FlowStep[]; createdBy: string | null;
  risk: "low" | "medium" | "high"; running: boolean;
  lastRunAt: string | null; lastResult: string | null; lastJobIds: Array<string | null>; lastRunElsewhere?: boolean;
  frequency: "hourly" | "daily" | "weekly" | null; minute: number | null; hour: number | null; weekday: number | null;
  enabled: boolean; nextDueAt: string | null; triggerFlowId: string | null; webhookEnabled: boolean;
  // Armed from a drive's row or its Repair notice (M26.5): the managed drive whose loss runs it.
  triggerDrive?: string | null;
  // A step only the owner may run that someone else put in this flow and the owner has not kept:
  // the flow does not run until the owner keeps it (Keep this step).
  ownerToKeep?: { step: number; title: string } | null;
}

export interface PaletteField { name: string; type: "string" | "number" | "boolean"; optional: boolean; enum: string[] | null; default: string | number | boolean | null }
export interface PaletteStep { operationId: string; title: string; risk: string; description: string; fields: PaletteField[] }
export interface ShelfItem { slug: string; name: string; description: string; steps: FlowStep[] }

const weekdays = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const two = (value: number) => String(value).padStart(2, "0");

/** "every Sunday at 03:00", or null for a flow that runs only by hand or by trigger. */
export function cadenceLabel(flow: Pick<Flow, "frequency" | "minute" | "hour" | "weekday">): string | null {
  if (!flow.frequency) return null;
  if (flow.frequency === "hourly") return `every hour at :${two(flow.minute ?? 0)}`;
  if (flow.frequency === "daily") return `every day at ${two(flow.hour ?? 3)}:${two(flow.minute ?? 0)}`;
  return `every ${weekdays[flow.weekday ?? 0]} at ${two(flow.hour ?? 3)}:${two(flow.minute ?? 0)}`;
}

/** A field's name as words: "credentialName" is "Credential name". */
export const humanize = (name: string) => name.replace(/([A-Z])/g, " $1").replace(/[._]/g, " ").replace(/^./, (c) => c.toUpperCase()).trim().replace(/\s(\w)/g, (_, c: string) => ` ${c.toLowerCase()}`);

/** A last run that ended badly. One completed (even with skipped steps) or still running has not. */
export function flowFailed(flow: Pick<Flow, "lastResult">): boolean {
  const result = flow.lastResult;
  if (!result) return false;
  return !(result === "completed" || result.startsWith("completed (") || result.startsWith("running step"));
}

/** What each tier means for a flow, said beside its steps. */
export const flowTierWords: Record<Flow["risk"], string> = {
  low: "runs with one click",
  medium: "each step runs as its own recorded job",
  high: "each step runs as its own recorded job",
};
