import { useCallback, useEffect, useId, useRef, useState, type FormEvent, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { approveJob, getJob, getJobApproval, oneTimeFields, retryWithMoreTime, stageOperation, waitForJob, type ApprovalPolicy, type Job, type RiskTier, cancelJob } from "../operations";
import { OneTimeResult } from "./OneTimeResult";
import { useDialogFocus } from "../useDialogFocus";
import { jobWarnings } from "../JobWarnings";
import { formatDuration, jobTimeout } from "../JobTimeout";
import { elapsed } from "../home/format";
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
 *
 * On a phone (760 px and narrower, approve.css) it is a sheet that fills the screen: the body
 * scrolls, the actions stay at the bottom edge, and the sheet is sized to what an on-screen
 * keyboard leaves visible, so the password and the button that sends it are both above the keys.
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

/** "21:16", or "7 Nov 21:16" when that is not today: when it was asked, when the approval lapses. */
function clockTime(iso: string | null | undefined, now: number): string | null {
  const at = Date.parse(iso ?? "");
  if (!Number.isFinite(at)) return null;
  const when = new Date(at);
  const time = `${String(when.getHours()).padStart(2, "0")}:${String(when.getMinutes()).padStart(2, "0")}`;
  return when.toDateString() === new Date(now).toDateString() ? time : `${when.toLocaleDateString([], { day: "numeric", month: "short" })} ${time}`;
}

/**
 * How long the run took, counted from the approval as Ops' and Home's "Took" count it (a job an
 * agent staged and the owner approved six hours later ran for five seconds). Null without both
 * instants on the job: nothing is said rather than counted from the staging.
 */
function tookFromApproval(job: Job | null): string | null {
  const from = Date.parse(job?.approvals?.[0]?.createdAt ?? "");
  const to = Date.parse(job?.updatedAt ?? "");
  return Number.isFinite(from) && Number.isFinite(to) && to >= from ? elapsed(to - from) : null;
}

/** The agent a job was staged for, as the server recorded it on the job (recovery.agent, M45.5). */
function stagedByAgent(job: Job | null): string | null {
  const agent = (job?.recovery as { agent?: { agentName?: unknown } } | undefined)?.agent;
  return typeof agent?.agentName === "string" && agent.agentName ? agent.agentName : null;
}

/** Below this much visible height (a keyboard is up, or the phone is on its side) the whole sheet scrolls. */
const compactBelowPx = 520;

/**
 * What an on-screen keyboard leaves of the screen, given to the stylesheet as --approve-visible-top
 * and --approve-visible-height on the backdrop: a keyboard covers the bottom of a fixed sheet
 * without resizing it (iOS, and Android since Chrome 108), so the actions would sit under the keys.
 * Only the phone layout reads them. Says whether what is left is short.
 */
function useVisibleViewport(backdrop: RefObject<HTMLElement | null>): boolean {
  const [compact, setCompact] = useState(false);
  useEffect(() => {
    const view = window.visualViewport ?? null;
    const read = () => {
      const element = backdrop.current;
      if (!element) return;
      // Pinched in, the visual viewport is the magnified part of the page, not what a keyboard left.
      const zoomed = Boolean(view && view.scale > 1.01);
      if (view && !zoomed) {
        element.style.setProperty("--approve-visible-top", `${Math.round(view.offsetTop)}px`);
        element.style.setProperty("--approve-visible-height", `${Math.round(view.height)}px`);
      } else {
        element.style.removeProperty("--approve-visible-top");
        element.style.removeProperty("--approve-visible-height");
      }
      setCompact((zoomed || !view ? window.innerHeight : view.height) <= compactBelowPx);
    };
    read();
    view?.addEventListener("resize", read);
    view?.addEventListener("scroll", read);
    window.addEventListener("resize", read);
    return () => {
      view?.removeEventListener("resize", read);
      view?.removeEventListener("scroll", read);
      window.removeEventListener("resize", read);
    };
  }, [backdrop]);
  return compact;
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
   * Told the job once the server has accepted its approval, so it will run. A staged job can still be
   * withdrawn by cancelling; something that must only happen when the job runs (an agent's card
   * being decided) waits for this instead.
   */
  onApproved?: (job: Job) => void;
  /**
   * Told once a job this dialog staged and then withdrew (Cancel, Escape, the dialog going away) is
   * cancelled, or the cancel was refused because someone approved it meanwhile from another page or
   * a push: a page that shows the job's state reads it again then, not before the cancel landed.
   */
  onWithdrawn?: (jobId: string) => void;
  /**
   * Told when the dialog is closed, with the job as it ended here: null when it was cancelled, could
   * not be staged, or was not followed to its end. A form closes before its approval opens, so the
   * page puts it back, as it was filled in, unless the job completed.
   */
  onClosed?: (job: Job | null) => void;
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
  /**
   * Who suggested this step when it was not the person approving it: an agent's name, or the
   * assistant. Its `preview` is then the model's own words, which text the model read can steer, so
   * the dialog says whose words they are and shows everything the operation is given, unfolded.
   */
  proposedBy?: string;
}

interface Props extends PendingOperation {
  csrfToken: string;
  onClose: () => void;
  onFinished?: (job: Job) => void;
  /** Opens `next` in place of this dialog; without it, no Next is offered. */
  onNext?: (operation: PendingOperation) => void;
  /** The clock "Asked" and "Lapses" are read against, so a test can hold it still. */
  now?: () => number;
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

export function ApproveDialog({ operationId, title, parameters, preview, confirmText, csrfToken, onClose, onFinished, onStaged, onApproved, onWithdrawn, onClosed, handoff, moreTimeFor, existingJobId, next, onNext, proposedBy, now = Date.now }: Props) {
  const [phase, setPhase] = useState<Phase>("staging");
  const [job, setJob] = useState<Job | null>(null);
  const [finished, setFinished] = useState<Job | null>(null);
  const [policy, setPolicy] = useState<ApprovalPolicy | null>(null);
  const [password, setPassword] = useState("");
  const [typedConfirm, setTypedConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const busyRef = useRef(false);
  const dialogRef = useRef<HTMLElement | null>(null);
  const backdropRef = useRef<HTMLDivElement | null>(null);
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
  const onApprovedRef = useRef(onApproved);
  onApprovedRef.current = onApproved;
  const onWithdrawnRef = useRef(onWithdrawn);
  onWithdrawnRef.current = onWithdrawn;
  const onClosedRef = useRef(onClosed);
  onClosedRef.current = onClosed;
  const handoffRef = useRef(handoff);
  handoffRef.current = handoff;
  useDialogFocus(dialogRef);
  const compact = useVisibleViewport(backdropRef);

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
      const jobId = stagedState.jobId;
      void cancelJob(jobId, csrfToken).catch(() => undefined).then(() => onWithdrawnRef.current?.(jobId));
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
      const jobId = job.id;
      void cancelJob(jobId, csrfToken).catch(() => undefined).then(() => onWithdrawnRef.current?.(jobId));
    }
    onClose();
    onClosedRef.current?.(finished);
  }, [job, phase, finished, csrfToken, onClose]);

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
      // Accepted, so it runs whether or not this dialog is still here to follow it.
      onApprovedRef.current?.(job);
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
  const nowRef = useRef(now);
  nowRef.current = now;
  useEffect(() => {
    const remaining = policy?.expiresAt ? Date.parse(policy.expiresAt) - nowRef.current() : null;
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
  // Who asks, when it is not the person approving: the agent the page named, or the one the job records.
  const asker = proposedBy ?? stagedByAgent(job);
  const asking = phase === "staging" || phase === "ready";
  const kicker = phase === "done" ? "Finished" : ranOut ? "Ran out of time" : phase === "error" ? "Needs attention"
    : phase === "running" ? "Running"
      : retryFrom && phase === "ready" ? "Approval · more time"
        : asker && asking ? `${asker} asks` : "Approval";
  const operation = job?.type?.startsWith("op:") ? job.type.slice(3) : operationId;
  // What the job was given, which the approver may not have chosen themselves.
  const staged = job?.parameters ?? null;
  const stagedCount = staged ? Object.keys(staged).length : 0;
  const reason = !preview && job?.recovery?.reason ? job.recovery.reason : null;
  const retryNote = retryFrom && job?.recovery?.budgetMs ? job.recovery.budgetMs : null;
  const showParameters = !existingJobId && stagedCount > 0 && !ended;
  const explained = Boolean(preview || reason || retryNote || (existingJobId && job) || showParameters);
  // A finished job's error is said by the job log below, and that it did not complete by the result
  // line; the dialog's own notice says only what neither can: it was not approved, staged or followed.
  const ownError = finished ? null : error;
  const errorTitle = phase === "ready" ? "Not approved"
    : job && stagedRef.current?.approvalStarted ? "BoxPilot lost track of it"
      : "It could not be prepared";

  // When it was asked and when the approval lapses, from the job and its policy and nothing else.
  const today = now();
  const askedAt = phase === "ready" ? clockTime(job?.createdAt, today) : null;
  const lapsesAt = phase === "ready" ? clockTime(policy?.expiresAt, today) : null;
  // How it ended, in a line, and how long it ran once approved.
  const outcome = !finished ? null : phase === "done" ? (hasWarnings ? "warning" : "good") : "danger";
  const resultLine = !finished ? null
    : phase === "done" ? (hasWarnings ? "Completed with follow-up needed." : "Completed.")
      : ranOut ? `${title} ran out of time.`
        : finished.state === "cancelled" ? `${title} was cancelled.` : `${title} did not complete.`;
  const verified = phase === "done" && finished ? finished.steps.filter((step) => step.name === "verify").at(-1)?.detail ?? null : null;
  const took = tookFromApproval(finished);
  // The one polite announcement: that it waits for approval and at what tier, that it is running,
  // how it ended. A failure's reason is an alert of its own (the notices here and in the job log),
  // so it is not said twice. Worded apart from what is on screen, which is read where it stands.
  const tookWords = took ? ` Took ${took}, from your approval.` : "";
  const announcement = phase === "ready" && policy ? `Waiting for your approval: ${tier} risk.`
    : phase === "approving" ? "Sending your approval."
      : phase === "running" ? "Approved. It is running."
        : !resultLine ? ""
          : phase === "done" ? `${title} finished${hasWarnings ? ", with follow-up needed" : ""}.${tookWords}` : `${resultLine}${tookWords} ${finished?.error || ranOut ? "The job log says why." : "Its log is below."}`;

  // Once it has finished, the way out is the next thing the keyboard reaches.
  useEffect(() => { if (ended) closeRef.current?.focus(); }, [ended]);

  // The field or button that had focus goes when the form does (approving, running): focus fell
  // to the page behind, so it is put back on the dialog and the next Tab starts inside it.
  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && phase !== "staging" && (document.activeElement === document.body || document.activeElement === null)) dialog.focus({ preventScroll: true });
  }, [phase]);

  // The sheet changes its scrolling when a keyboard opens (compact): keep the focused field in view.
  useEffect(() => {
    const active = document.activeElement;
    if (active instanceof HTMLElement && active !== dialogRef.current && dialogRef.current?.contains(active)) active.scrollIntoView?.({ block: "nearest" });
  }, [compact]);

  const submit = (event: FormEvent) => { event.preventDefault(); if (canApprove) void approve(); };

  return createPortal(
    <div ref={backdropRef} className="approve-backdrop" role="presentation">
      {/* A click outside no longer dismisses (M50): it withdrew the staged job and lost the typed confirmation and password. Escape and Close do. */}
      <section ref={dialogRef} tabIndex={-1} className="approve-dialog look-console" role="dialog" aria-modal="true" aria-labelledby={titleId} data-phase={phase} data-tier={policy ? tier : undefined} data-compact={compact || undefined} onMouseDown={(event) => event.stopPropagation()}>
        <header className="approve-head">
          <div className="approve-heading">
            <span className="approve-kicker">{kicker}</span>
            <h2 id={titleId} className="approve-title">{title}</h2>
            {/* The job's short id, which Activity lists it by; the operation's id is with its parameters (M49). */}
            {job && <Facts className="approve-facts">job <code>{job.id.slice(0, 8)}</code></Facts>}
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

        {/* Always here, so a change of its words is announced: the dialog's one polite live region. */}
        <p className="ui-visually-hidden approve-status" role="status">{announcement}</p>

        <div className="approve-body">
          {phase === "staging" && <Progress label={retryFrom ? "Staging it again with more time…" : existingJobId ? "Reading the staged job…" : "Preparing…"} />}

          {explained && (
            <section className="approve-section" aria-labelledby={`${titleId}-what`}>
              <h3 id={`${titleId}-what`} className="approve-section__title">What it will do</h3>
              {preview && proposedBy && <p className="approve-note">{proposedBy}'s reason, in its own words. BoxPilot has not checked it; what runs is what it is given, below.</p>}
              {preview && <div className="approve-preview">{preview}</div>}
              {reason && <p className="approve-preview">{reason}</p>}
              {/* What "more time" changes, before it is approved: the same job, with a larger budget. */}
              {retryNote ? <p className="approve-preview">Runs it again with the same settings and gives it {formatDuration(retryNote)} to finish.</p> : null}
              {/* Approving what someone else staged (M36): say what it was staged with. When is "Asked", below. */}
              {existingJobId && job && (
                <div className="approve-staged">
                  {stagedCount > 0 ? <><strong>What it was staged with</strong><ParameterList parameters={staged!} /></> : <span>Staged with no settings.</span>}
                </div>
              )}
              {showParameters && proposedBy && (
                <div className="approve-staged">
                  <strong>Exactly what it is given ({stagedCount})</strong>
                  <p className="approve-operation">Operation <code>{operation}</code></p>
                  <ParameterList parameters={staged!} />
                </div>
              )}
              {showParameters && !proposedBy && (
                <details className="approve-more">
                  <summary>Exactly what it is given ({stagedCount})</summary>
                  <p className="approve-operation">Operation <code>{operation}</code></p>
                  <ParameterList parameters={staged!} />
                </details>
              )}
            </section>
          )}

          {/* When it was asked and when the approval lapses: only what the job and its policy say. */}
          {(askedAt || lapsesAt) && (
            <p className="approve-when">
              {askedAt && <span className="approve-when__item">Asked <time dateTime={job?.createdAt}>{askedAt}</time></span>}
              {lapsesAt && <span className="approve-when__item" data-lapsed={approvalExpired || undefined}>{approvalExpired ? "Lapsed" : "Lapses"} <time dateTime={policy?.expiresAt ?? undefined}>{lapsesAt}</time></span>}
            </p>
          )}

          {phase === "error" && !finished && ownError && <Notice tone="danger" live title={errorTitle}>{ownError}</Notice>}

          {phase === "ready" && (
            <form id={formId} className="approve-section approve-form" aria-labelledby={`${titleId}-how`} onSubmit={submit}>
              <h3 id={`${titleId}-how`} className="approve-section__title">To approve</h3>
              {ownError && <Notice tone="danger" live title={errorTitle}>{ownError}</Notice>}
              {policy?.expiresAt && (approvalExpired
                ? <Notice tone="warning" live title="This approval expired.">Close it and stage the operation again with its credentials.</Notice>
                : <p className="approve-note">Credentials are held temporarily. Approve before {lapsesAt ?? "it lapses"}, or stage the operation again.</p>)}
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
              {/* True of every job: the approval starts it on the server (jobs.mjs approveAndStart), and
                  this dialog only watches. "The phone" is said on a phone (approve.css). */}
              {phase === "running" && <p className="approve-note approve-away"><span className="approve-away__phone">You can put the phone down. </span>It finishes either way, and Activity will say how it went.</p>}
            </section>
          )}

          {ended && (
            <section className="approve-section" aria-labelledby={`${titleId}-end`}>
              <h3 id={`${titleId}-end`} className="approve-section__title">{phase === "done" ? "Result" : "What happened"}</h3>
              {/* How it ended, first and plainly; then how long it ran once approved. The reason for a
                  failure is the job log's to say, below. */}
              {finished && resultLine && outcome && (
                <div className="approve-result ui-marked" data-status={outcome}>
                  <span className="ui-mark approve-result__mark" aria-hidden="true" />
                  <p className="approve-result__line"><strong>{resultLine}</strong>{verified ? <span className="approve-result__detail"> {verified}</span> : null}</p>
                  {took && <p className="approve-result__took">Took <b>{took}</b>, from your approval</p>}
                </div>
              )}
              {phase === "done" && finished && oneTimeFields(finished.result).length > 0 && <OneTimeResult jobId={finished.id} fields={oneTimeFields(finished.result)} csrfToken={csrfToken} />}
              {finished && <JobLogView job={finished} title={title} onMoreTime={(timedOut) => setRetryFrom(timedOut.id)} />}
            </section>
          )}
        </div>

        <footer className="approve-foot">
          {ended ? (
            phase === "done" && next && onNext
              ? <>
                  <Button className="approve-act" onClick={dismiss}>Close</Button>
                  <Button variant="primary" className="approve-act approve-act--primary" risk={riskOf(next.operationId)} onClick={() => onNext(next)}>Next: {next.title}</Button>
                </>
              : <Button variant="primary" className="approve-act approve-act--primary" onClick={dismiss}>Close</Button>
          ) : (
            <>
              <Button className="approve-act" onClick={dismiss} disabled={busy}>Cancel</Button>
              <Button variant="primary" type="submit" form={formId} className="approve-act approve-act--primary approve-go" data-tier={policy ? tier : undefined} busy={phase === "approving" || phase === "running"} disabled={!canApprove}>{actionLabel}</Button>
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
