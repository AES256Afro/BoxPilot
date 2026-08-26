import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { approveJob, followJobOutput, stageOperation, waitForJob, type ApprovalPolicy, type Job, type RiskTier, cancelJob } from "./operations";

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

  useEffect(() => { if (outputRef.current) outputRef.current.scrollTop = outputRef.current.scrollHeight; }, [output]);
  useEffect(() => () => { stopFollowing.current?.(); }, []);

  useEffect(() => {
    let cancelled = false;
    stageOperation(operationId, parameters, csrfToken)
      .then((staged) => { if (cancelled) return; setJob(staged.job); setPolicy(staged.approval); setPhase("ready"); })
      .catch((stageError: unknown) => { if (cancelled) return; setError(stageError instanceof Error ? stageError.message : "Could not stage the operation"); setPhase("error"); });
    return () => { cancelled = true; };
  }, [operationId, parameters, csrfToken]);

  // Dismissing a staged-but-unapproved job withdraws it so Activity does not fill with orphans.
  const dismiss = useCallback(() => {
    if (job && phase === "ready") void cancelJob(job.id, csrfToken).catch(() => undefined);
    onClose();
  }, [job, phase, csrfToken, onClose]);

  // Escape closes the dialog (and withdraws the staged job) like Cancel does.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape" && !busyRef.current) dismiss(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [dismiss]);

  const approve = useCallback(async () => {
    if (!job) return;
    setPhase("approving");
    setError(null);
    try {
      await approveJob(job.id, csrfToken, password || undefined, typedConfirm || undefined);
      if (password) window.dispatchEvent(new Event("boxpilot:auth-changed"));
      setPassword("");
      setPhase("running");
      setOutput("");
      stopFollowing.current?.();
      stopFollowing.current = followJobOutput(job.id, {
        // The stream sends fragments to append; asking returns the whole log, which replaces.
        onOutput: (text, append) => setOutput((current) => (append ? current + text : text)),
        onState: () => {},
      });
      const finished = await waitForJob(job.id);
      stopFollowing.current?.(); stopFollowing.current = null;
      setJob(finished);
      setPhase(finished.state === "completed" ? "done" : "error");
      if (finished.state !== "completed") setError(finished.error ?? "The operation did not complete");
      onFinished?.(finished);
    } catch (approveError) {
      setError(approveError instanceof Error ? approveError.message : "Approval failed");
      setPhase("ready");
    }
  }, [job, csrfToken, password, typedConfirm, onFinished]);

  const tier = policy?.tier ?? "high";
  const passwordRequired = policy ? policy.passwordRequired : true;
  const confirmRequired = confirmText ?? policy?.confirmText ?? null;
  const busy = phase === "staging" || phase === "approving" || phase === "running";
  busyRef.current = busy;
  const actionLabel = phase === "running" ? "Running..." : phase === "approving" ? "Approving..." : passwordRequired ? "Approve and run" : tier === "low" ? "Run" : "Confirm and run";

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={busy ? undefined : dismiss}>
      <section className="modal" role="dialog" aria-modal="true" aria-labelledby="approve-title" onMouseDown={(event) => event.stopPropagation()}>
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
              <button className="primary-button" type="button" onClick={() => void approve()} disabled={busy || phase !== "ready" || (passwordRequired && password.length < 12) || (Boolean(confirmRequired) && typedConfirm !== confirmRequired)}>{actionLabel}</button>
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
