import { useRef, useState } from "react";
import { cancelJob, type Job } from "../../operations";
import type { PendingOperation } from "../../shell/ApproveDialog";
import { Button, Notice, RiskTag, StatusChip, Tag } from "../../ui";
import { agentsApi, type PlanStep, type Proposal } from "./api";
import { errorText } from "./format";

/*
 * An agent's card (M37). Agents propose and never act; a card is how they hand something to a
 * person, in three kinds:
 * - plan: registered operations, each step staged by a person through the ordinary approval dialog
 *   at the step's tier, exactly as if they had chosen it on its page;
 * - question: the agent asked rather than guess what was meant;
 * - escalation: it hands a matter to the owner - low confidence, a limit reached, something risky.
 * A card proposed after tool output that read like an instruction says that first.
 *
 * Which job each step was staged as is the server's to keep, not the card's (sweep 3): the card is
 * drawn from it, so another tab, the page left and come back to, or a reload still knows a step
 * waits or was approved, and never offers it again. The server decides the card once every step's
 * job is approved, wherever that was - this card's dialog, a push, Activity or Today.
 */

export interface ProposalCardProps {
  proposal: Proposal;
  csrfToken: string;
  role: string;
  /** Opens the approval dialog for one step (useOperation's start). */
  onStage: (operation: PendingOperation) => void;
  /** The card as the server now has it: a step staged or approved, or the card decided. */
  onDecided: (proposal: Proposal) => void;
  /** Opens the run the card came from, in the console. */
  onOpenRun?: (agentId: string, runId: string) => void;
}

/** Whether this role may stage a step of this tier: the server checks again. */
const mayStage = (role: string, step: PlanStep) => role === "owner" || (role === "operator" && step.risk !== "high");
const kindWords = { plan: "plan", question: "question", escalation: "needs you" } as const;

/**
 * What a step offers, from its job as the server has it: Stage while it has none (or that one was
 * cancelled, or never started), Review while it waits for approval, and once approved, or failed
 * after it started, only how it stands: Stage offered beside a job that waits or ran is how an
 * operation ran twice.
 */
function StepState({ step, open, may, onStage, onReview }: { step: PlanStep; open: boolean; may: boolean; onStage: () => void; onReview: (jobId: string) => void }) {
  const status = step.status ?? "ready";
  if (status === "ready") return open && may ? <Button risk={step.risk} onClick={onStage} aria-label={`Stage ${step.title}`}>Stage</Button> : null;
  if (status === "waiting") {
    const jobId = step.jobId;
    return (
      <>
        <Tag tone="warning">waiting for approval</Tag>
        {open && may && jobId && <Button variant="ghost" onClick={() => onReview(jobId)} aria-label={`Review ${step.title}`}>Review</Button>}
      </>
    );
  }
  return <Tag tone={status === "approved" ? "good" : "danger"}>{status}</Tag>;
}

export function ProposalCard({ proposal, csrfToken, role, onStage, onDecided, onOpenRun }: ProposalCardProps) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const open = proposal.state === "open";
  const kind = proposal.kind ?? "plan";
  // The card as last drawn, for a dialog's callbacks that arrive after it changed.
  const latest = useRef(proposal);
  latest.current = proposal;

  const decide = async (decision: "dismissed") => {
    setBusy(true);
    try {
      onDecided(await agentsApi.decide(csrfToken, proposal.id, decision));
      setError(null);
    } catch (requestError) {
      setError(errorText(requestError, "The card could not be changed"));
    } finally {
      setBusy(false);
    }
  };

  // The card as the server has it now. Nothing to say when it cannot be read: the page reads again.
  const reread = () => agentsApi.proposal(proposal.id).then(onDecided, () => undefined);

  /**
   * Tell the server which job this step was staged as; it answers with the card as it now stands.
   * Told again once approved (the same job changes nothing) so a first word lost on the way still
   * counts. A job staged while another already holds the step would run it twice: it is withdrawn.
   */
  const record = async (index: number, job: Job, { staged }: { staged: boolean }) => {
    if (latest.current.state !== "open") return;
    try {
      onDecided(await agentsApi.stageStep(csrfToken, proposal.id, index, job.id));
      setError(null);
    } catch (requestError) {
      setError(errorText(requestError, "The card could not keep which job this step was staged as"));
      if (!staged) return;
      const now = await agentsApi.proposal(proposal.id).catch(() => null);
      const holder = now?.steps[index];
      if (holder && (holder.status === "waiting" || holder.status === "approved") && holder.jobId !== job.id) void cancelJob(job.id, csrfToken).catch(() => undefined);
      if (now) onDecided(now);
    }
  };

  const operation = (step: PlanStep): PendingOperation => ({
    operationId: step.operationId,
    title: step.title,
    parameters: step.parameters,
    preview: <span>{step.why || proposal.reason}</span>,
    // A card from BoxPilot itself (source "runtime") carries no model's words.
    ...(proposal.source === "runtime" ? {} : { proposedBy: proposal.agentName }),
  });

  const stage = (step: PlanStep, index: number) => onStage({
    ...operation(step),
    onStaged: (job) => { void record(index, job, { staged: true }); },
    onApproved: (job) => { void record(index, job, { staged: false }); },
    // Cancelled (or refused, because it was approved meanwhile from a push, Activity or Today):
    // read the card once the server has the job as it ended, not before.
    onWithdrawn: () => { void reread(); },
  });

  // The job already waiting for this step, opened as it is: closing it leaves it waiting.
  const review = (step: PlanStep, jobId: string) => onStage({
    ...operation(step),
    existingJobId: jobId,
    onApproved: () => { void reread(); },
    onClosed: () => { void reread(); },
  });

  return (
    <article className="agents-card" data-kind={kind} data-state={proposal.state} aria-label={`Card: ${proposal.title}`}>
      <header className="agents-card__head">
        <Tag tone={kind === "plan" ? "accent" : kind === "question" ? "info" : "warning"}>{kindWords[kind]}</Tag>
        <h3 className="agents-card__title">{proposal.title}</h3>
        <span className="agents-card__from">{proposal.source === "runtime" ? "from BoxPilot" : `from ${proposal.agentName}`}</span>
        {!open && <StatusChip status={proposal.state === "staged" ? "good" : "neutral"}>{proposal.state}</StatusChip>}
      </header>
      {proposal.flags?.afterSuspiciousOutput && (
        <Notice tone="warning" title="Proposed after suspicious tool output">Something the agent read looked like an instruction. Check each step before you stage it.</Notice>
      )}
      {kind === "question" && proposal.question && <p className="agents-card__question">{proposal.question}</p>}
      <p className="agents-card__reason">{proposal.reason}</p>
      {proposal.steps.length > 0 && (
        <ol className="agents-card__steps">
          {proposal.steps.map((step, index) => (
            <li key={`${step.operationId}-${index}`} className="agents-card__step">
              <span className="agents-card__step-words">
                <span className="agents-card__step-title">{step.title}</span>
                <code className="agents-card__op">{step.operationId}</code>
                {step.why && <span className="agents-card__why">{step.why}</span>}
                {/* What it would be given is what runs; the words above are the agent's. */}
                {Object.keys(step.parameters ?? {}).length > 0 && (
                  <span className="agents-card__params">
                    {Object.entries(step.parameters).map(([name, value]) => (
                      <span key={name} className="agents-card__param"><code>{name}</code> <span>{typeof value === "string" || typeof value === "number" || typeof value === "boolean" ? String(value) : JSON.stringify(value)}</span></span>
                    ))}
                  </span>
                )}
              </span>
              <RiskTag risk={step.risk} />
              <StepState step={step} open={open} may={mayStage(role, step)} onStage={() => stage(step, index)} onReview={(jobId) => review(step, jobId)} />
            </li>
          ))}
        </ol>
      )}
      {proposal.dropped.length > 0 && (
        <p className="agents-card__dropped">Left out: {proposal.dropped.map((entry) => `${entry.operationId ?? "a step"} (${entry.reason})`).join("; ")}</p>
      )}
      {error && <Notice tone="danger" live>{error}</Notice>}
      {open && (
        <footer className="agents-card__foot">
          {proposal.runId && proposal.agentId && onOpenRun && <Button variant="ghost" onClick={() => onOpenRun(proposal.agentId!, proposal.runId!)}>Open the run</Button>}
          <Button variant="ghost" busy={busy} onClick={() => void decide("dismissed")}>{kind === "plan" ? "Dismiss" : "Done"}</Button>
        </footer>
      )}
    </article>
  );
}
