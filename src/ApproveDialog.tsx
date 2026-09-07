import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { approveJob, followJobOutput, stageOperation, waitForJob, type ApprovalPolicy, type Job, type RiskTier, cancelJob } from "./operations";
import { useDialogFocus } from "./useDialogFocus";
import { jobOutputText } from "./jobOutputText";

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
}

type Phase = "staging" | "ready" | "approving" | "running" | "done" | "error";

export function ApproveDialog({ operationId, title, parameters, preview, confirmText, csrfToken, onClose, onFinished }: Props) {
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
    setPhase("staging"); setJob(null); setPolicy(null); setError(null); setPassword(""); setTypedConfirm("");
    stageOperation(operationId, parameters, csrfToken)
      .then((staged) => { stagedState.jobId = staged.job.id; if (cancelled) { withdraw(); return; } setJob(staged.job); setPolicy(staged.approval); setPhase("ready"); })
      .catch((stageError: unknown) => { if (cancelled) return; setError(stageError instanceof Error ? stageError.message : "Could not prepare this action"); setPhase("error"); });
    return () => { cancelled = true; withdraw(); };
  }, [operationId, parameters, csrfToken]);

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
            <span className="eyebrow">{phase === "done" ? "Finished" : phase === "error" ? "Needs attention" : "Approval"}</span>
            <h2 id="approve-title">{title}</h2>
          </div>
          <button className="icon-button" type="button" onClick={dismiss} aria-label="Close dialog" disabled={busy}>X</button>
        </header>
        <div className="modal-copy">
          {policy && <p><span className={`status-pill ${tierTone[tier]}`}>{tierLabel[tier]}</span>{policy.elevated && tier === "high" ? <span className="good-text"> Session elevated, no password needed right now.</span> : null}</p>}
          {preview && <div className="notice">{preview}</div>}
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
          {phase === "done" && job && <p className="good-text">Completed. {job.steps.filter((step) => step.name === "verify").at(-1)?.detail ?? ""}</p>}
          {error && <div className="auth-error" role="alert">{error}</div>}
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
