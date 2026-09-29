import { useCallback, useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { approveJob, getJob, getJobApproval, oneTimeFields, retryWithMoreTime, stageOperation, waitForJob, type ApprovalPolicy, type Job, type RiskTier, cancelJob } from "../operations";
import { OneTimeResult } from "./OneTimeResult";
import { useDialogFocus } from "../useDialogFocus";
import { jobWarnings } from "../JobWarnings";
import { formatDuration, jobTimeout } from "../JobTimeout";
import { JobLogView } from "../JobLogView";
import { Button, Facts, Field, JobProgress, Notice, Progress, SecretInput, TextInput, riskOf } from "../ui";
import { CloseIcon, LockIcon } from "../ui/icons";
import "./look.css";
import "./approve.css";

/**
 * The one approval surface for registered operations (ADR-001 risk tiers), in the console's look
 * (M33.13):
 *   low    → "Run"    (one click)
 *   medium → "Confirm and run" after a preview
 *   high   → password (unless the session is elevated) + typed confirmation where the operation
 *            asks for one, then "Approve and run"
 * The tier leads the dialog, in words and with its colour, before what the operation will do.
 * Stages the job (or reads one already staged), approves it, then follows it with the kit's
 * JobProgress and shows how it ended with the job log.
 */

const tierName: Record<RiskTier, string> = { low: "Low risk", medium: "Medium risk", high: "High risk" };

/** What approving asks of the owner, said beside the tier. */
function tierAsks(tier: RiskTier, policy: ApprovalPolicy | null, confirm: boolean): string {
  if (!policy) return "Reading what approving it needs…";
  if (tier === "high" && policy.elevated && !policy.passwordRequired) return confirm ? "Session elevated, no password needed right now. Type the confirmation to go ahead." : "Session elevated, no password needed right now.";
  if (policy.passwordRequired) {
    const always = policy.mode === "always-password" && tier !== "high" ? " Approvals are set to always ask for it." : "";
    return `${confirm ? "Your password and the typed confirmation." : "Your password."}${always}`;
  }
  if (confirm) return "Check what it will do, then type the confirmation.";
  return tier === "low" ? "One click: nothing more is asked." : "Check what it will do, then confirm.";
}

export interface PendingOperation {
  operationId: string;
  title: string;
  parameters: Record<string, unknown>;
  preview?: ReactNode;
  /** When set, the exact text must be typed before the operation can be approved (destructive actions). */
  confirmText?: string;
  /** Told the job once it is staged, before anything is approved (Repair records which finding it fixes). */
  onStaged?: (job: Job) => void;
  /**
   * Once the job is approved and running, hand it over rather than following it here: Repair streams
   * its log in the finding's card and re-checks the finding when it ends (M35). The approval itself is
   * exactly the same; only who watches the run changes. The caller closes the dialog.
   */
  handoff?: (job: Job) => void;
  /**
   * Stage "Try again with more time" for this timed-out job instead of staging `operationId` with
   * `parameters` (M30.3). Activity opens the dialog this way, and so does a timed-out job on Home;
   * the dialog does it for itself when a job it ran out of time.
   */
  moreTimeFor?: string;
  /**
   * Approve a job someone already staged instead of staging a new one (M36: Home, Ops, Activity).
   * The dialog reads its current approval policy; closing it leaves the job waiting, as it found it.
   */
  existingJobId?: string;
  /**
   * The operation that comes after this one, offered as "Next" once this one has completed (Agents:
   * install Unsloth, then download the model, then start the runner). Nothing is staged until the
   * person presses it, and it opens in its own dialog, approved at its own tier like any other.
   */
  next?: PendingOperation;
}

interface Props extends PendingOperation {
  csrfToken: string;
  onClose: () => void;
  onFinished?: (job: Job) => void;
  /** Opens `next` in place of this dialog; without it, no Next is offered. */
  onNext?: (operation: PendingOperation) => void;
}

type Phase = "staging" | "ready" | "approving" | "running" | "done" | "error";

/** A staged parameter, as the job records it (secrets are placeholders there). */
function parameterText(value: unknown): string {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean" ? String(value) : JSON.stringify(value);
}

function ParameterList({ parameters }: { parameters: Record<string, unknown> }) {
  return (
    <ul className="approve-params">
      {Object.entries(parameters).map(([name, value]) => <li key={name}><code>{name}</code> <span>{parameterText(value)}</span></li>)}
    </ul>
  );
}

export function ApproveDialog({ operationId, title, parameters, preview, confirmText, csrfToken, onClose, onFinished, onStaged, handoff, moreTimeFor, existingJobId, next, onNext }: Props) {
  const [phase, setPhase] = useState<Phase>("staging");
  const [job, setJob] = useState<Job | null>(null);
  const [finished, setFinished] = useState<Job | null>(null);
  const [policy, setPolicy] = useState<ApprovalPolicy | null>(null);
  const [password, setPassword] = useState("");
  const [typedConfirm, setTypedConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const busyRef = useRef(false);
  const dialogRef = useRef<HTMLElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const observation = useRef<AbortController | null>(null);
  const mounted = useRef(false);
  const stagedRef = useRef<{ jobId: string | null; approvalStarted: boolean; withdrawn: boolean; owned: boolean } | null>(null);
  const titleId = useId();
  const formId = useId();
  // The timed-out job being tried again with more time, if that is what is staged.
  const [retryFrom, setRetryFrom] = useState<string | null>(moreTimeFor ?? null);
  // Read through refs so a caller's new callback does not stage the job again.
  const onStagedRef = useRef(onStaged);
  onStagedRef.current = onStaged;
  const handoffRef = useRef(handoff);
  handoffRef.current = handoff;
  useDialogFocus(dialogRef);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; observation.current?.abort(); };
  }, []);

  useEffect(() => {
    let cancelled = false;
    // A job this dialog did not stage is not its to withdraw: closing leaves it waiting.
    const owned = !(existingJobId && !retryFrom);
    const stagedState = { jobId: null as string | null, approvalStarted: false, withdrawn: false, owned };
    stagedRef.current = stagedState;
    const withdraw = () => {
      if (!stagedState.owned || !stagedState.jobId || stagedState.approvalStarted || stagedState.withdrawn) return;
      stagedState.withdrawn = true;
      void cancelJob(stagedState.jobId, csrfToken).catch(() => undefined);
    };
    setPhase("staging"); setJob(null); setFinished(null); setPolicy(null); setError(null); setPassword(""); setTypedConfirm("");
    // A retry with more time is staged by the server from the timed-out job, and then approved
    // here exactly like anything else: same tier, same password or typed confirmation.
    const existing = async () => {
      const [{ job: current }, approval] = await Promise.all([getJob(existingJobId!), getJobApproval(existingJobId!)]);
      if (current.state !== "awaiting_approval") throw new Error(`This job is no longer waiting for approval (${current.state.replaceAll("_", " ")}). Activity shows how it ended.`);
      return { job: current, approval };
    };
    (retryFrom ? retryWithMoreTime(retryFrom, csrfToken) : owned ? stageOperation(operationId, parameters, csrfToken) : existing())
      .then((staged) => { stagedState.jobId = staged.job.id; if (cancelled) { withdraw(); return; } setJob(staged.job); setPolicy(staged.approval); setPhase("ready"); onStagedRef.current?.(staged.job); })
      .catch((stageError: unknown) => { if (cancelled) return; setError(stageError instanceof Error ? stageError.message : "Could not prepare this action"); setPhase("error"); });
    return () => { cancelled = true; withdraw(); };
  }, [operationId, parameters, csrfToken, retryFrom, existingJobId]);

  // Dismissing a staged-but-unapproved job withdraws it so Activity does not fill with orphans.
  const dismiss = useCallback(() => {
    if (job && phase === "ready" && stagedRef.current?.owned && !stagedRef.current.withdrawn) {
      stagedRef.current.withdrawn = true;
      void cancelJob(job.id, csrfToken).catch(() => undefined);
    }
    onClose();
  }, [job, phase, csrfToken, onClose]);

  // Escape closes the dialog (and withdraws the staged job) like Cancel does, unless something
  // opened over it has Escape first.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || busyRef.current) return;
      const dialogs = document.querySelectorAll('[aria-modal="true"]');
      if (dialogRef.current && dialogs.length && dialogs[dialogs.length - 1] !== dialogRef.current) return;
      dismiss();
    };
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
      if (handoffRef.current) { handoffRef.current(job); return; }
      // JobProgress shows the run as it happens; this waits for the end, so the dialog can say how
      // it went and hand the finished job to the page.
      setPhase("running");
      const ended = await waitForJob(job.id, { signal: tracking.signal });
      if (!mounted.current || tracking.signal.aborted) return;
      setJob(ended);
      setFinished(ended);
      setPhase(ended.state === "completed" ? "done" : "error");
      if (ended.state !== "completed") setError(ended.error ?? "The operation did not complete");
      onFinished?.(ended);
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

  const tier: RiskTier = policy?.tier ?? "high";
  const hasWarnings = jobWarnings(finished?.result).length > 0;
  const ranOut = phase === "error" && jobTimeout(finished) !== null;
  const passwordRequired = policy ? policy.passwordRequired : true;
  const confirmRequired = confirmText ?? policy?.confirmText ?? null;
  const busy = phase === "staging" || phase === "approving" || phase === "running";
  busyRef.current = busy;
  const ended = phase === "done" || phase === "error";
  const actionLabel = phase === "running" ? "Running..." : phase === "approving" ? "Approving..." : passwordRequired ? "Approve and run" : tier === "low" ? "Run" : "Confirm and run";
  const canApprove = !approvalExpired && !busy && phase === "ready" && !(passwordRequired && password.length < 12) && !(Boolean(confirmRequired) && typedConfirm !== confirmRequired);
  const kicker = phase === "done" ? "Finished" : ranOut ? "Ran out of time" : phase === "error" ? "Needs attention" : retryFrom && phase === "ready" ? "Approval · more time" : "Approval";
  const operation = job?.type?.startsWith("op:") ? job.type.slice(3) : operationId;
  // What the job was given, which the approver may not have chosen themselves.
  const staged = job?.parameters ?? null;
  const stagedCount = staged ? Object.keys(staged).length : 0;
  const reason = !preview && job?.recovery?.reason ? job.recovery.reason : null;
  const retryNote = retryFrom && job?.recovery?.budgetMs ? job.recovery.budgetMs : null;
  const showParameters = !existingJobId && stagedCount > 0 && !ended;
  const explained = Boolean(preview || reason || retryNote || (existingJobId && job) || showParameters);
  // The job's own error is said by the job log below; the dialog says only what the log cannot.
  const ownError = error && !(finished && error === finished.error) ? error : null;
  const errorTitle = phase === "ready" ? "Not approved"
    : finished ? "It did not complete"
      : job && stagedRef.current?.approvalStarted ? "BoxPilot lost track of it"
        : "It could not be prepared";

  // Once it has finished, the way out is the next thing the keyboard reaches.
  useEffect(() => { if (ended) closeRef.current?.focus(); }, [ended]);

  const submit = (event: FormEvent) => { event.preventDefault(); if (canApprove) void approve(); };

  return createPortal(
    <div className="approve-backdrop" role="presentation" onMouseDown={busy ? undefined : dismiss}>
      <section ref={dialogRef} tabIndex={-1} className="approve-dialog look-console" role="dialog" aria-modal="true" aria-labelledby={titleId} data-phase={phase} data-tier={policy ? tier : undefined} onMouseDown={(event) => event.stopPropagation()}>
        <header className="approve-head">
          <div className="approve-heading">
            <span className="approve-kicker">{kicker}</span>
            <h2 id={titleId} className="approve-title">{title}</h2>
            <Facts className="approve-facts"><code>{operation}</code>{job && <> · job <code>{job.id.slice(0, 8)}</code></>}</Facts>
          </div>
          <button ref={closeRef} className="approve-close" type="button" onClick={dismiss} aria-label="Close dialog" disabled={busy}><CloseIcon /></button>
        </header>

        <div className="approve-tier" data-tier={policy ? tier : "unknown"}>
          <span className="approve-tier__name">
            {policy && tier === "high" && <LockIcon className="approve-tier__lock" />}
            {policy ? tierName[tier] : "Risk tier"}
          </span>
          <span className="approve-tier__asks">{tierAsks(tier, policy, Boolean(confirmRequired))}</span>
        </div>

        <div className="approve-body">
          {phase === "staging" && <Progress label={retryFrom ? "Staging it again with more time…" : existingJobId ? "Reading the staged job…" : "Preparing…"} />}

          {explained && (
            <section className="approve-section" aria-labelledby={`${titleId}-what`}>
              <h3 id={`${titleId}-what`} className="approve-section__title">What it will do</h3>
              {preview && <div className="approve-preview">{preview}</div>}
              {reason && <p className="approve-preview">{reason}</p>}
              {/* What "more time" changes, before it is approved: the same job, with a larger budget. */}
              {retryNote ? <p className="approve-preview">Runs it again with the same settings and gives it {formatDuration(retryNote)} to finish.</p> : null}
              {/* Approving what someone else staged (M36): say what it was staged with, and when. */}
              {existingJobId && job && (
                <div className="approve-staged">
                  <strong>Staged {job.createdAt ? new Date(job.createdAt).toLocaleString() : ""}</strong>
                  {stagedCount > 0 ? <ParameterList parameters={staged!} /> : <span> with no settings.</span>}
                </div>
              )}
              {showParameters && (
                <details className="approve-more">
                  <summary>Exactly what it is given ({stagedCount})</summary>
                  <ParameterList parameters={staged!} />
                </details>
              )}
            </section>
          )}

          {phase === "error" && !finished && ownError && <Notice tone="danger" live title={errorTitle}>{ownError}</Notice>}

          {phase === "ready" && (
            <form id={formId} className="approve-section approve-form" aria-labelledby={`${titleId}-how`} onSubmit={submit}>
              <h3 id={`${titleId}-how`} className="approve-section__title">To approve</h3>
              {ownError && <Notice tone="danger" live title={errorTitle}>{ownError}</Notice>}
              {policy?.expiresAt && (approvalExpired
                ? <Notice tone="warning" live title="This approval expired.">Close it and stage the operation again with its credentials.</Notice>
                : <p className="approve-note" role="status">Credentials are held temporarily. Approve before {new Date(policy.expiresAt).toLocaleTimeString()}, or stage the operation again.</p>)}
              {confirmRequired && (
                <Field label="Typed confirmation" hint={<>Type <code>{confirmRequired}</code> exactly as shown.</>}>
                  <TextInput mono autoComplete="off" spellCheck={false} autoCapitalize="off" value={typedConfirm} onValueChange={setTypedConfirm} />
                </Field>
              )}
              {passwordRequired && (
                <Field label="Approval password" hint={policy?.mode === "always-password" ? "Your BoxPilot password. Approvals are set to ask for it every time." : "Your BoxPilot password. It also unlocks high-risk approvals for a short while."}>
                  <SecretInput autoComplete="current-password" value={password} onValueChange={setPassword} revealLabel="Show" />
                </Field>
              )}
              {!confirmRequired && !passwordRequired && <p className="approve-note">{tier === "low" ? "Nothing runs until you press Run." : "Nothing runs until you confirm."}</p>}
            </form>
          )}

          {job && (phase === "approving" || phase === "running") && (
            <section className="approve-section" aria-labelledby={`${titleId}-run`}>
              <h3 id={`${titleId}-run`} className="approve-section__title">Progress</h3>
              {phase === "approving" ? <Progress label="Sending the approval…" /> : <JobProgress jobId={job.id} title={title} showOutput />}
            </section>
          )}

          {ended && (
            <section className="approve-section" aria-labelledby={`${titleId}-end`}>
              <h3 id={`${titleId}-end`} className="approve-section__title">{phase === "done" ? "Result" : "What happened"}</h3>
              {phase === "done" && finished && (
                <Notice tone={hasWarnings ? "warning" : "success"} title={hasWarnings ? "Completed with follow-up needed." : "Completed."}>
                  {finished.steps.filter((step) => step.name === "verify").at(-1)?.detail ?? undefined}
                </Notice>
              )}
              {phase === "done" && finished && oneTimeFields(finished.result).length > 0 && <OneTimeResult jobId={finished.id} fields={oneTimeFields(finished.result)} csrfToken={csrfToken} />}
              {finished && ownError && <Notice tone="danger" live title={errorTitle}>{ownError}</Notice>}
              {finished && <JobLogView job={finished} title={title} onMoreTime={(timedOut) => setRetryFrom(timedOut.id)} />}
            </section>
          )}
        </div>

        <footer className="approve-foot">
          {ended ? (
            phase === "done" && next && onNext
              ? <>
                  <Button onClick={dismiss}>Close</Button>
                  <Button variant="primary" risk={riskOf(next.operationId)} onClick={() => onNext(next)}>Next: {next.title}</Button>
                </>
              : <Button variant="primary" onClick={dismiss}>Close</Button>
          ) : (
            <>
              <Button onClick={dismiss} disabled={busy}>Cancel</Button>
              <Button variant="primary" type="submit" form={formId} className="approve-go" data-tier={policy ? tier : undefined} busy={phase === "approving" || phase === "running"} disabled={!canApprove}>{actionLabel}</Button>
            </>
          )}
        </footer>
      </section>
    </div>,
    document.body,
  );
}

/** Hook: `const { start, dialog } = useOperation(csrfToken, onFinished)`; render `{dialog}` once in the page. */
export function useOperation(csrfToken: string, onFinished?: (job: Job) => void) {
  // Each start is a dialog of its own (keyed), so an operation's `next` opens fresh in its place.
  const [pending, setPending] = useState<{ operation: PendingOperation; key: number } | null>(null);
  const start = useCallback((operation: PendingOperation) => setPending((current) => ({ operation, key: (current?.key ?? 0) + 1 })), []);
  const close = useCallback(() => setPending(null), []);
  const dialog = pending ? <ApproveDialog key={pending.key} {...pending.operation} csrfToken={csrfToken} onClose={close} onFinished={onFinished} onNext={start} /> : null;
  return { start, close, dialog, active: pending !== null };
}
