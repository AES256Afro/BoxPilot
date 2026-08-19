import { useCallback, useEffect, useState, type ReactNode } from "react";
import { approveJob, stageOperation, waitForJob, type ApprovalPolicy, type Job, type RiskTier } from "./operations";

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
}

interface Props extends PendingOperation {
  csrfToken: string;
  onClose: () => void;
  onFinished?: (job: Job) => void;
}

type Phase = "staging" | "ready" | "approving" | "running" | "done" | "error";

export function ApproveDialog({ operationId, title, parameters, preview, csrfToken, onClose, onFinished }: Props) {
  const [phase, setPhase] = useState<Phase>("staging");
  const [job, setJob] = useState<Job | null>(null);
  const [policy, setPolicy] = useState<ApprovalPolicy | null>(null);
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    stageOperation(operationId, parameters, csrfToken)
      .then((staged) => { if (cancelled) return; setJob(staged.job); setPolicy(staged.approval); setPhase("ready"); })
      .catch((stageError: unknown) => { if (cancelled) return; setError(stageError instanceof Error ? stageError.message : "Could not stage the operation"); setPhase("error"); });
    return () => { cancelled = true; };
  }, [operationId, parameters, csrfToken]);

  const approve = useCallback(async () => {
    if (!job) return;
    setPhase("approving");
    setError(null);
    try {
      await approveJob(job.id, csrfToken, password || undefined);
      if (password) window.dispatchEvent(new Event("boxpilot:auth-changed"));
      setPassword("");
      setPhase("running");
      const finished = await waitForJob(job.id);
      setJob(finished);
      setPhase(finished.state === "completed" ? "done" : "error");
      if (finished.state !== "completed") setError(finished.error ?? "The operation did not complete");
      onFinished?.(finished);
    } catch (approveError) {
      setError(approveError instanceof Error ? approveError.message : "Approval failed");
      setPhase("ready");
    }
  }, [job, csrfToken, password, onFinished]);

  const tier = policy?.tier ?? "high";
  const passwordRequired = policy ? policy.passwordRequired : true;
  const busy = phase === "staging" || phase === "approving" || phase === "running";
  const actionLabel = phase === "running" ? "Running..." : phase === "approving" ? "Approving..." : passwordRequired ? "Approve and run" : tier === "low" ? "Run" : "Confirm and run";

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={busy ? undefined : onClose}>
      <section className="modal" role="dialog" aria-modal="true" aria-labelledby="approve-title" onMouseDown={(event) => event.stopPropagation()}>
        <header className="modal-header">
          <div>
            <span className="eyebrow">{phase === "done" ? "Finished" : phase === "error" ? "Needs attention" : "Approval"}</span>
            <h2 id="approve-title">{title}</h2>
          </div>
          <button className="icon-button" type="button" onClick={onClose} aria-label="Close dialog" disabled={busy}>X</button>
        </header>
        <div className="modal-copy">
          {policy && <p><span className={`status-pill ${tierTone[tier]}`}>{tierLabel[tier]}</span>{policy.elevated && tier === "high" ? <span className="good-text"> Session elevated — no password needed right now.</span> : null}</p>}
          {preview && <div className="notice">{preview}</div>}
          {phase === "staging" && <p>Preparing...</p>}
          {phase === "ready" && passwordRequired && (
            <label>Owner password<input aria-label="Approval password" type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} /></label>
          )}
          {phase === "running" && <p>Working. This dialog follows the job and will show the result here.</p>}
          {phase === "done" && job && <p className="good-text">Completed. {job.steps.filter((step) => step.name === "verify").at(-1)?.detail ?? ""}</p>}
          {error && <div className="auth-error" role="alert">{error}</div>}
          {job && (phase === "done" || phase === "error") && (
            <details><summary>Job log</summary><ul>{job.steps.map((step, index) => <li key={`${step.name}-${index}`}><strong>{step.name}</strong> · {step.state} · {step.detail}</li>)}</ul></details>
          )}
        </div>
        <footer className="recovery-actions">
          {phase === "done" || phase === "error" ? (
            <button className="primary-button" type="button" onClick={onClose}>Close</button>
          ) : (
            <>
              <button className="secondary-button" type="button" onClick={onClose} disabled={busy}>Cancel</button>
              <button className="primary-button" type="button" onClick={() => void approve()} disabled={busy || phase !== "ready" || (passwordRequired && password.length < 12)}>{actionLabel}</button>
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
