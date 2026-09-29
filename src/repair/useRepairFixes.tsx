import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { ApproveDialog } from "../shell/ApproveDialog";
import { readJson } from "../http";
import { approveJob, cancelJob, stageOperation, waitForJob, type Job } from "../operations";
import { riskOf } from "../ui/operationRisk";
import type { RiskTier } from "../ui/types";
import { BatchDialog, DismissDialog, ScheduleDialog, type DismissTarget, type FindingTarget } from "./RepairDialogs";
import { nextStep, whatChanged } from "./outcome";
import type { Finding, RepairFix, RepairScan } from "./types";

/*
 * Running Repair's fixes (M35), the same way from Repair, Home and Ops.
 *
 * A fix is an ordinary job, staged and approved in the ordinary dialog at its own tier: nothing here
 * approves anything the dialog would not. What is added is what happens around it. The job is
 * recorded against the finding it was started from, the dialog hands the running job to the page
 * (whose card streams its log), and when it ends the scan is read again so the card can say "Fixed",
 * with what changed, or "Still there", with the job's own error and the next step.
 *
 * "Fix the safe ones" runs every low-risk fix in turn after one confirmation that lists them all.
 * Low risk is one click on the server too, so the confirmation is the click; each job is still
 * staged, approved and audited on its own, and the batch stops at the first job the server wants
 * more than a click for (a password under "always ask", or a typed confirmation), which then waits
 * for its own dialog.
 */

export type FixRun =
  | { phase: "queued"; label: string }
  | { phase: "running"; jobId: string; label: string }
  | { phase: "checking"; jobId: string; label: string }
  | { phase: "fixed"; jobId: string | null; label: string; changed: string }
  | { phase: "still"; jobId: string | null; label: string; error: string | null; next: string }
  | { phase: "scheduled"; label: string; message: string };

const noParameters: Record<string, unknown> = {};

export const tierOf = (fix: Pick<RepairFix, "risk" | "operationId">): RiskTier => fix.risk ?? riskOf(fix.operationId);

export interface BatchEntry { finding: Finding; fix: RepairFix }

/** Which finding a job fixes, so a failure shows on the finding and drops away once it is gone. Best-effort. */
export function recordAttempt(findingId: string, jobId: string, csrfToken: string): Promise<void> {
  return fetch("/api/v1/remediations/attempts", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-BoxPilot-CSRF": csrfToken },
    body: JSON.stringify({ findingId, jobId }),
  }).then(() => undefined, () => undefined);
}

export interface RepairFixes {
  runs: Record<string, FixRun>;
  /** Findings as they were when last fixed from here: a fixed one is gone from the scan but still worth showing. */
  remembered: Record<string, Finding>;
  start: (finding: Finding, fix: RepairFix) => void;
  startBatch: (entries: BatchEntry[]) => void;
  dismiss: (target: DismissTarget) => void;
  restore: (key: string) => Promise<void>;
  busy: boolean;
  notice: string | null;
  dialog: ReactNode;
}

export function useRepairFixes({ csrfToken, recheck }: { csrfToken: string; recheck: () => Promise<RepairScan | null> }): RepairFixes {
  const [runs, setRuns] = useState<Record<string, FixRun>>({});
  const [remembered, setRemembered] = useState<Record<string, Finding>>({});
  const [approving, setApproving] = useState<BatchEntry | null>(null);
  const [scheduling, setScheduling] = useState<BatchEntry | null>(null);
  const [batching, setBatching] = useState<BatchEntry[] | null>(null);
  const [dismissing, setDismissing] = useState<FindingTarget | null>(null);
  const [batchBusy, setBatchBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const live = useRef(true);
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  const recheckRef = useRef(recheck);
  recheckRef.current = recheck;

  const set = useCallback((id: string, run: FixRun) => { if (live.current) setRuns((current) => ({ ...current, [id]: run })); }, []);
  const remember = useCallback((finding: Finding) => { if (live.current) setRemembered((current) => ({ ...current, [finding.id]: finding })); }, []);

  /** The verdict for each finished job, from one fresh read of the scan. */
  const settle = useCallback(async (done: Array<{ finding: Finding; fix: RepairFix; job: Job }>) => {
    for (const { finding, fix, job } of done) set(finding.id, { phase: "checking", jobId: job.id, label: fix.label });
    const scan = await recheckRef.current().catch(() => null);
    for (const { finding, fix, job } of done) {
      const now = scan ? scan.findings.find((entry) => entry.id === finding.id) ?? null : finding;
      if (job.state === "completed" && scan && !now) { set(finding.id, { phase: "fixed", jobId: job.id, label: fix.label, changed: whatChanged(job) }); continue; }
      const error = job.state === "completed" ? (scan ? null : "The scan could not be read again, so whether this is fixed is not known yet. Check again in a moment.") : job.error ?? `The job ended ${job.state}.`;
      set(finding.id, { phase: "still", jobId: job.id, label: fix.label, error, next: nextStep(now ?? finding, job.state !== "completed") });
    }
  }, [set]);

  const follow = useCallback(async (finding: Finding, fix: RepairFix, jobId: string) => {
    remember(finding);
    set(finding.id, { phase: "running", jobId, label: fix.label });
    try {
      const finished = await waitForJob(jobId);
      await settle([{ finding, fix, job: finished }]);
    } catch (error) {
      set(finding.id, { phase: "still", jobId, label: fix.label, error: `${error instanceof Error ? error.message : "Lost sight of the job"}. It may still be running; Activity shows it.`, next: "Check again once it has finished." });
    }
  }, [remember, set, settle]);

  const start = useCallback((finding: Finding, fix: RepairFix) => {
    setNotice(null);
    if (fix.kind === "schedule") setScheduling({ finding, fix }); else setApproving({ finding, fix });
  }, []);

  const runBatch = useCallback(async (entries: BatchEntry[]) => {
    setBatchBusy(true);
    setNotice(null);
    for (const { finding, fix } of entries) { remember(finding); set(finding.id, { phase: "queued", label: fix.label }); }
    const done: Array<{ finding: Finding; fix: RepairFix; job: Job }> = [];
    let stopped: string | null = null;
    for (const { finding, fix } of entries) {
      if (stopped) { set(finding.id, { phase: "still", jobId: null, label: fix.label, error: stopped, next: "Use its own button: it asks for what the server wants." }); continue; }
      try {
        const staged = await stageOperation(fix.operationId, fix.parameters ?? {}, csrfToken);
        // One click is what the server asks of a low-risk job, and all the batch may give. Anything
        // more - a password under "always ask", a typed confirmation - waits for its own dialog.
        if (staged.approval.passwordRequired || staged.approval.tier !== "low" || staged.approval.confirmText) {
          await cancelJob(staged.job.id, csrfToken).catch(() => undefined);
          stopped = staged.approval.passwordRequired ? "Approvals ask for your password on every job right now, so the batch stopped before this one." : "The server wants more than one click for this one, so the batch left it.";
          set(finding.id, { phase: "still", jobId: null, label: fix.label, error: stopped, next: "Use its own button: it asks for what the server wants." });
          continue;
        }
        void recordAttempt(finding.id, staged.job.id, csrfToken);
        await approveJob(staged.job.id, csrfToken);
        set(finding.id, { phase: "running", jobId: staged.job.id, label: fix.label });
        const finished = await waitForJob(staged.job.id);
        done.push({ finding, fix, job: finished });
        // Shown as it ends, with the verdict from the one scan read after the last.
        set(finding.id, finished.state === "completed"
          ? { phase: "checking", jobId: finished.id, label: fix.label }
          : { phase: "still", jobId: finished.id, label: fix.label, error: finished.error ?? `The job ended ${finished.state}.`, next: nextStep(finding, true) });
      } catch (error) {
        set(finding.id, { phase: "still", jobId: null, label: fix.label, error: error instanceof Error ? error.message : "Could not run it", next: nextStep(finding, true) });
      }
      if (!live.current) return;
    }
    if (done.length) await settle(done);
    if (live.current) {
      setBatchBusy(false);
      const fixed = done.filter(({ job }) => job.state === "completed").length;
      setNotice(`Ran ${done.length} of ${entries.length} low-risk fix${entries.length === 1 ? "" : "es"}; ${fixed} finished. Each card says what changed.`);
    }
  }, [csrfToken, remember, set, settle]);

  const startBatch = useCallback((entries: BatchEntry[]) => { if (entries.length) setBatching(entries); }, []);

  const schedule = useCallback(async ({ finding, fix }: BatchEntry) => {
    const failures: string[] = [];
    let created = 0;
    for (const spec of fix.schedules ?? []) {
      try {
        const response = await fetch("/api/v1/schedules", {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-BoxPilot-CSRF": csrfToken },
          body: JSON.stringify({ operationId: fix.operationId, parameters: spec.parameters, frequency: spec.frequency, minute: spec.minute, hour: spec.hour ?? null, weekday: spec.weekday ?? null }),
        });
        await readJson(response);
        created += 1;
      } catch (error) {
        failures.push(`${String(spec.parameters.id ?? spec.parameters.subject ?? "one")}: ${error instanceof Error ? error.message : "refused"}`);
      }
    }
    remember(finding);
    set(finding.id, failures.length
      ? { phase: "still", jobId: null, label: fix.label, error: `Scheduled ${created} of ${(fix.schedules ?? []).length}. ${failures.join("; ")}`, next: "The schedules that were refused say why; the Backups page lists every schedule." }
      : { phase: "scheduled", label: fix.label, message: `Scheduled ${created === 1 ? "a nightly backup" : `${created} nightly backups`}; the first runs tonight. Back up now as well to be covered until then.` });
    await recheckRef.current().catch(() => null);
  }, [csrfToken, remember, set]);

  const restore = useCallback(async (key: string) => {
    try {
      await readJson(await fetch(`/api/v1/remediations/dismissals/${encodeURIComponent(key)}`, { method: "DELETE", headers: { "X-BoxPilot-CSRF": csrfToken } }));
      await recheckRef.current().catch(() => null);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Could not bring it back");
    }
  }, [csrfToken]);

  // A finding is set aside with a reason; a failed job is let go on the job itself, with M36's own
  // mark (POST /jobs/:id/dismiss) that Activity, Home and Ops all read, so the two never disagree.
  const [jobProblem, setJobProblem] = useState<string | null>(null);
  const dismiss = useCallback((target: DismissTarget) => {
    if (target.kind === "finding") { setDismissing(target); return; }
    setJobProblem(null);
    void fetch(`/api/v1/jobs/${encodeURIComponent(target.jobId)}/dismiss`, { method: "POST", headers: { "X-BoxPilot-CSRF": csrfToken } })
      .then((response) => readJson(response))
      .then(() => recheckRef.current().catch(() => null))
      .catch((error: unknown) => setJobProblem(`Could not dismiss "${target.title}": ${error instanceof Error ? error.message : "that did not work"}`));
  }, [csrfToken]);

  let dialog: ReactNode = null;
  if (approving) {
    const { finding, fix } = approving;
    dialog = (
      <ApproveDialog
        operationId={fix.operationId}
        title={fix.label}
        parameters={fix.parameters ?? noParameters}
        preview={<span>{fix.preview}</span>}
        csrfToken={csrfToken}
        onClose={() => setApproving(null)}
        onStaged={(job) => { void recordAttempt(finding.id, job.id, csrfToken); }}
        handoff={(job) => { setApproving(null); void follow(finding, fix, job.id); }}
      />
    );
  } else if (scheduling) {
    dialog = <ScheduleDialog fix={scheduling.fix} onClose={() => setScheduling(null)} onConfirm={() => { const entry = scheduling; setScheduling(null); void schedule(entry); }} />;
  } else if (batching) {
    dialog = <BatchDialog entries={batching} onClose={() => setBatching(null)} onConfirm={() => { const entries = batching; setBatching(null); void runBatch(entries); }} />;
  } else if (dismissing) {
    dialog = <DismissDialog target={dismissing} csrfToken={csrfToken} onClose={() => setDismissing(null)} onDone={() => { setDismissing(null); void recheckRef.current().catch(() => null); }} />;
  }
  if (jobProblem) dialog = <>{dialog}<p className="rp-dialog__error" role="alert">{jobProblem}</p></>;

  return { runs, remembered, start, startBatch, dismiss, restore, busy: batchBusy, notice, dialog };
}
