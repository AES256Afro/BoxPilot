import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { approveJob, followJobOutput, getJobApproval, retryWithMoreTime, stageOperation, waitForJob, type ApprovalPolicy, type Job, type RiskTier, cancelJob } from "./operations";
import { useDialogFocus } from "./useDialogFocus";
import { jobOutputText } from "./jobOutputText";
import { JobWarnings, jobWarnings } from "./JobWarnings";
import { JobTimeoutNotice, errorIsTheTimeout, formatDuration, jobTimeout } from "./JobTimeout";

/**
 * The one approval surface for registered operations (ADR-001 risk tiers):
 *   low    → "Run"    (one click)
 *   medium → "Confirm" after a preview
 *   high   → password (unless the session is elevated) + "Approve"
 * Stages the job, approves it, then waits for the result and shows it.
 */

const tierLabel: Record<RiskTier, string> = { low: "Low risk", medium: "Medium risk", high: "High risk" };
const tierTone: Record<RiskTier, string> = { low: "status-good", medium: "status-warning", high: "status-danger" };

export interface PendingOperation {
  operationId: string;
  title: string;
  parameters: Record<string, unknown>;
  preview?: ReactNode;
  /** When set, the exact text must be typed before the operation can be approved (destructive actions). */
  confirmText?: string;
}

interface Props extends PendingOperation {
  csrfToken: string;
  onClose: () => void;
  onFinished?: (job: Job) => void;
  /**
   * Stage "Try again with more time" for this timed-out job instead of staging `operationId` with
   * `parameters` (M30.3). Activity opens the dialog this way; the dialog does it for itself when a
   * job it ran out of time.
   */
  moreTimeFor?: string;
}

type Phase = "staging" | "ready" | "approving" | "running" | "done" | "error";

export function ApproveDialog({ operationId, title, parameters, preview, confirmText, csrfToken, onClose, onFinished, moreTimeFor }: Props) {
  const [phase, setPhase] = useState<Phase>("staging");
  const [job, setJob] = useState<Job | null>(null);
  const [policy, setPolicy] = useState<ApprovalPolicy | null>(null);
  const [password, setPassword] = useState("");
  const [typedConfirm, setTypedConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [output, setOutput] = useState("");
  const [showOutput, setShowOutput] = useState(true);
  const outputRef = useRef<HTMLPreElement | null>(null);
  const busyRef = useRef(false);
  const stopFollowing = useRef<(() => void) | null>(null);
  const dialogRef = useRef<HTMLElement | null>(null);
  const observation = useRef<AbortController | null>(null);
  const mounted = useRef(false);
  const stagedRef = useRef<{ jobId: string | null; approvalStarted: boolean; withdrawn: boolean } | null>(null);
  // The timed-out job being tried again with more time, if that is what is staged.
  const [retryFrom, setRetryFrom] = useState<string | null>(moreTimeFor ?? null);
  useDialogFocus(dialogRef);

  useEffect(() => { if (outputRef.current) outputRef.current.scrollTop = outputRef.current.scrollHeight; }, [output]);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; observation.current?.abort(); stopFollowing.current?.(); };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const stagedState = { jobId: null as string | null, approvalStarted: false, withdrawn: false };
    stagedRef.current = stagedState;
    const withdraw = () => {
      if (!stagedState.jobId || stagedState.approvalStarted || stagedState.withdrawn) return;
      stagedState.withdrawn = true;
      void cancelJob(stagedState.jobId, csrfToken).catch(() => undefined);
    };
    setPhase("staging"); setJob(null); setPolicy(null); setError(null); setPassword(""); setTypedConfirm(""); setOutput("");
    // A retry with more time is staged by the server from the timed-out job, and then approved
    // here exactly like anything else: same tier, same password or typed confirmation.
    (retryFrom ? retryWithMoreTime(retryFrom, csrfToken) : stageOperation(operationId, parameters, csrfToken))
      .then((staged) => { stagedState.jobId = staged.job.id; if (cancelled) { withdraw(); return; } setJob(staged.job); setPolicy(staged.approval); setPhase("ready"); })
      .catch((stageError: unknown) => { if (cancelled) return; setError(stageError instanceof Error ? stageError.message : "Could not prepare this action"); setPhase("error"); });
    return () => { cancelled = true; withdraw(); };
  }, [operationId, parameters, csrfToken, retryFrom]);

  // Dismissing a staged-but-unapproved job withdraws it so Activity does not fill with orphans.
  const dismiss = useCallback(() => {
    if (job && phase === "ready" && stagedRef.current && !stagedRef.current.withdrawn) {
      stagedRef.current.withdrawn = true;
      void cancelJob(job.id, csrfToken).catch(() => undefined);
    }
    onClose();
  }, [job, phase, csrfToken, onClose]);

  // Escape closes the dialog (and withdraws the staged job) like Cancel does.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape" && !busyRef.current) dismiss(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [dismiss]);

  const approve = useCallback(async () => {
    if (!job || busyRef.current) return;
    busyRef.current = true;
    if (stagedRef.current) stagedRef.current.approvalStarted = true;
    const tracking = new AbortController();
    observation.current = tracking;
    let accepted = false;
    setPhase("approving");
    setError(null);
    try {
      await approveJob(job.id, csrfToken, password || undefined, typedConfirm || undefined);
      accepted = true;
      if (!mounted.current || tracking.signal.aborted) return;
      if (password) window.dispatchEvent(new Event("boxpilot:auth-changed"));
      setPassword("");
      setPhase("running");
      setOutput("");
      stopFollowing.current?.();
      stopFollowing.current = followJobOutput(job.id, {
        // The stream sends fragments to append; asking returns the whole log, which replaces.
        onOutput: (text, append) => { if (!tracking.signal.aborted) setOutput((current) => jobOutputText(current, text, append)); },
        onState: () => {},
      });
      const finished = await waitForJob(job.id, { signal: tracking.signal });
      if (!mounted.current || tracking.signal.aborted) return;
      stopFollowing.current?.(); stopFollowing.current = null;
      setJob(finished);
      setPhase(finished.state === "completed" ? "done" : "error");
      if (finished.state !== "completed") setError(finished.error ?? "The operation did not complete");
      onFinished?.(finished);
    } catch (approveError) {
      if (!mounted.current || tracking.signal.aborted) return;
      if (!accepted && stagedRef.current) stagedRef.current.approvalStarted = false;
      const detail = approveError instanceof Error ? approveError.message : "Could not follow this job";
      setError(accepted ? `${detail}. The job may still be running. Check Activity for its current state.` : detail);
      setPhase(accepted ? "error" : "ready");
      if (!accepted) {
        // The policy was read when the job was staged. If the elevated session lapsed since, the
        // server now wants the password: show the field at once, then re-read the real policy.
        if (/owner password/i.test(detail)) setPolicy((current) => current ? { ...current, passwordRequired: true, elevated: false } : current);
        const jobId = job.id;
        void getJobApproval(jobId).then((fresh) => {
          if (mounted.current && stagedRef.current?.jobId === jobId) setPolicy((current) => current ? { ...current, ...fresh } : fresh);
        }).catch(() => undefined);
      }
    } finally {
      stopFollowing.current?.(); stopFollowing.current = null;
      if (observation.current === tracking) observation.current = null;
    }
  }, [job, csrfToken, password, typedConfirm, onFinished]);

  const [approvalExpired, setApprovalExpired] = useState(false);
  useEffect(() => {
    const remaining = policy?.expiresAt ? Date.parse(policy.expiresAt) - Date.now() : null;
    setApprovalExpired(Boolean(policy?.expired || (remaining !== null && remaining <= 0)));
    if (remaining === null || remaining <= 0 || !Number.isFinite(remaining)) return;
    const timer = window.setTimeout(() => setApprovalExpired(true), remaining);
    return () => window.clearTimeout(timer);
  }, [policy?.expiresAt, policy?.expired]);

  const tier = policy?.tier ?? "high";
  const hasWarnings = jobWarnings(job?.result).length > 0;
  const ranOut = phase === "error" && jobTimeout(job) !== null;
  const passwordRequired = policy ? policy.passwordRequired : true;
  const confirmRequired = confirmText ?? policy?.confirmText ?? null;
  const busy = phase === "staging" || phase === "approving" || phase === "running";
  busyRef.current = busy;
  const actionLabel = phase === "running" ? "Running..." : phase === "approving" ? "Approving..." : passwordRequired ? "Approve and run" : tier === "low" ? "Run" : "Confirm and run";

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={busy ? undefined : dismiss}>
      <section ref={dialogRef} tabIndex={-1} className="modal" role="dialog" aria-modal="true" aria-labelledby="approve-title" onMouseDown={(event) => event.stopPropagation()}>
        <header className="modal-header">
          <div>
            <span className="eyebrow">{phase === "done" ? "Finished" : ranOut ? "Ran out of time" : phase === "error" ? "Needs attention" : retryFrom && phase === "ready" ? "Approval · more time" : "Approval"}</span>
            <h2 id="approve-title">{title}</h2>
          </div>
          <button className="icon-button" type="button" onClick={dismiss} aria-label="Close dialog" disabled={busy}>X</button>
        </header>
        <div className="modal-copy">
          {policy && <p><span className={`status-pill ${tierTone[tier]}`}>{tierLabel[tier]}</span>{policy.elevated && tier === "high" ? <span className="good-text"> Session elevated, no password needed right now.</span> : null}</p>}
          {preview && <div className="notice">{preview}</div>}
          {/* What "more time" changes, before it is approved: the same job, with a larger budget. */}
          {retryFrom && job?.recovery?.budgetMs ? <div className="notice">Runs it again with the same settings and gives it {formatDuration(job.recovery.budgetMs)} to finish.</div> : null}
          {phase === "ready" && policy?.expiresAt && <p role="status">{approvalExpired ? "This approval expired. Close it and stage the operation again with its credentials." : `Credentials are held temporarily. Approve before ${new Date(policy.expiresAt).toLocaleTimeString()}, or stage the operation again.`}</p>}
          {phase === "staging" && <p>Preparing...</p>}
          {phase === "ready" && confirmRequired && (
            <label>Type <code>{confirmRequired}</code> to confirm<input aria-label="Typed confirmation" autoComplete="off" spellCheck="false" value={typedConfirm} onChange={(event) => setTypedConfirm(event.target.value)} /></label>
          )}
          {phase === "ready" && passwordRequired && (
            <label>Owner password<input aria-label="Approval password" type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} /></label>
          )}
          {phase === "running" && <p>Working. Output from the server appears below as it happens.</p>}
          {(phase === "running" || ((phase === "done" || phase === "error") && output)) && (
            <div className="job-terminal">
              <div className="job-terminal-bar"><span>{phase === "running" ? "Live output" : "Output"}</span><button className="text-button" type="button" onClick={() => setShowOutput((value) => !value)}>{showOutput ? "Hide" : "Show"}</button></div>
              {showOutput && <pre ref={outputRef} aria-label="Job output">{output || (phase === "running" ? "Waiting for output..." : "")}</pre>}
            </div>
          )}
          {phase === "done" && job && <p className={hasWarnings ? undefined : "good-text"}>{hasWarnings ? "Completed with follow-up needed." : "Completed."} {job.steps.filter((step) => step.name === "verify").at(-1)?.detail ?? ""}</p>}
          {job && (phase === "done" || phase === "error") && <JobWarnings result={job.result} />}
          {/* A whole-job timeout's error says what the notice below says better, so it is said once. */}
          {error && !(ranOut && errorIsTheTimeout(job) && error === job?.error) && <div className="auth-error" role="alert">{error}</div>}
          {job && ranOut && <JobTimeoutNotice job={job} onMoreTime={() => setRetryFrom(job.id)} />}
          {job && (phase === "done" || phase === "error") && (
            <details><summary>Job log</summary><ul>{job.steps.map((step, index) => <li key={`${step.name}-${index}`}><strong>{step.name}</strong> · {step.state} · {step.detail}</li>)}</ul></details>
          )}
        </div>
        <footer className="recovery-actions">
          {phase === "done" || phase === "error" ? (
            <button className="primary-button" type="button" onClick={dismiss}>Close</button>
          ) : (
            <>
              <button className="secondary-button" type="button" onClick={dismiss} disabled={busy}>Cancel</button>
              <button className="primary-button" type="button" onClick={() => void approve()} disabled={approvalExpired || busy || phase !== "ready" || (passwordRequired && password.length < 12) || (Boolean(confirmRequired) && typedConfirm !== confirmRequired)}>{actionLabel}</button>
            </>
          )}
        </footer>
      </section>
    </div>
  );
}

/** Hook: `const { start, dialog } = useOperation(csrfToken, onFinished)`; render `{dialog}` once in the page. */
export function useOperation(csrfToken: string, onFinished?: (job: Job) => void) {
  const [pending, setPending] = useState<PendingOperation | null>(null);
  const start = useCallback((operation: PendingOperation) => setPending(operation), []);
  const close = useCallback(() => setPending(null), []);
  const dialog = pending ? <ApproveDialog {...pending} csrfToken={csrfToken} onClose={close} onFinished={onFinished} /> : null;
  return { start, close, dialog, active: pending !== null };
}
