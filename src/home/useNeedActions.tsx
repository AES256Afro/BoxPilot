import { useCallback, type ReactNode } from "react";
import { useOperation } from "../shell/ApproveDialog";
import { useRepairFixes, type FixRun } from "../repair/useRepairFixes";
import type { Finding } from "../repair/types";
import { loadRepairs, type Facts } from "./facts";
import type { Need, NeedAction } from "./needs";

/*
 * What a button in "What needs you" does, for Home and Ops alike (M35). A Repair finding's fix runs
 * the way Repair runs it - recorded against the finding, followed, and the finding checked again
 * when it ends - so the three places that offer the same fix offer the same thing. A failed job can
 * be tried again or set aside. Anything else goes straight to the approval dialog, as before.
 */
export function useNeedActions({ csrfToken, refresh, accept }: { csrfToken: string; refresh: (keys?: Array<keyof Facts>) => void; accept: <K extends keyof Facts>(key: K, value: NonNullable<Facts[K]["value"]>) => void }): {
  act: (need: Need, action?: NeedAction | null) => void;
  runs: Record<string, FixRun>;
  remembered: Record<string, Finding>;
  dialog: ReactNode;
} {
  const { start, dialog: operationDialog } = useOperation(csrfToken, () => refresh());
  // A fix's ending reads Repair's scan once, hands it to Home and Ops, and freshens what a fix moves.
  const recheck = useCallback(async () => {
    try {
      const scan = await loadRepairs();
      accept("repairs", scan);
      // A failure dismissed or tried again drops off by its own mark (M36), which the job event
      // stream brings in; nothing to read again for it.
      refresh(["catalog", "protection", "schedules", "watch"]);
      return scan;
    } catch {
      refresh(["repairs"]);
      return null;
    }
  }, [accept, refresh]);
  const repair = useRepairFixes({ csrfToken, recheck });
  const act = useCallback((need: Need, action: NeedAction | null = need.action) => {
    if (!action) return;
    if (action.kind === "dismiss") { if (need.jobId) repair.dismiss({ kind: "job", jobId: need.jobId, title: need.title }); return; }
    if (need.finding && action.fix) { repair.start(need.finding, action.fix); return; }
    // A job already staged is reviewed and approved as it is (M36's Review); nothing new is staged.
    start({ operationId: action.operationId, title: action.title, parameters: action.parameters, preview: action.preview ? <span>{action.preview}</span> : undefined,
      ...(action.moreTimeFor ? { moreTimeFor: action.moreTimeFor } : {}), ...(action.existingJobId ? { existingJobId: action.existingJobId } : {}) });
  }, [repair, start]);
  return { act, runs: repair.runs, remembered: repair.remembered, dialog: <>{operationDialog}{repair.dialog}</> };
}

/** A fix's progress in a word or a sentence, for a row too narrow for its log. */
export function runWords(run: FixRun): string {
  if (run.phase === "queued") return "Waiting its turn";
  if (run.phase === "running") return "Running; its log is on Repair";
  if (run.phase === "checking") return "Finished; checking again";
  if (run.phase === "fixed") return `Fixed. ${run.changed}`;
  if (run.phase === "scheduled") return run.message;
  return `Still there. ${run.error ?? "The fix ran, but the scan still finds it."} ${run.next}`;
}
