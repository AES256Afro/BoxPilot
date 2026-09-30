import { useRef, useState } from "react";
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
 */

export interface ProposalCardProps {
  proposal: Proposal;
  csrfToken: string;
  role: string;
  /** Opens the approval dialog for one step (useOperation's start). */
  onStage: (operation: PendingOperation) => void;
  onDecided: (proposal: Proposal) => void;
  /** Opens the run the card came from, in the console. */
  onOpenRun?: (agentId: string, runId: string) => void;
}

/** Whether this role may stage a step of this tier: the server checks again. */
const mayStage = (role: string, step: PlanStep) => role === "owner" || (role === "operator" && step.risk !== "high");
const kindWords = { plan: "plan", question: "question", escalation: "needs you" } as const;

export function ProposalCard({ proposal, csrfToken, role, onStage, onDecided, onOpenRun }: ProposalCardProps) {
  const [staged, setStaged] = useState<Record<number, string>>({});
  const stagedRef = useRef<Record<number, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const open = proposal.state === "open";
  const kind = proposal.kind ?? "plan";

  const decide = async (decision: "dismissed" | "staged", jobIds: string[] = []) => {
    setBusy(true);
    try {
      onDecided(await agentsApi.decide(csrfToken, proposal.id, decision, jobIds));
      setError(null);
    } catch (requestError) {
      setError(errorText(requestError, "The card could not be changed"));
    } finally {
      setBusy(false);
    }
  };

  const stage = (step: PlanStep, index: number) => onStage({
    operationId: step.operationId,
    title: step.title,
    parameters: step.parameters,
    preview: <span>{step.why || proposal.reason}</span>,
    // A card from BoxPilot itself (source "runtime") carries no model's words.
    ...(proposal.source === "runtime" ? {} : { proposedBy: proposal.agentName }),
    onStaged: (job) => {
      stagedRef.current = { ...stagedRef.current, [index]: job.id };
      setStaged(stagedRef.current);
      // Every step staged: the card is done, and records which jobs came of it.
      if (Object.keys(stagedRef.current).length === proposal.steps.length) void decide("staged", Object.values(stagedRef.current));
    },
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
              {open && (staged[index]
                ? <Tag tone="good">staged</Tag>
                : mayStage(role, step) && <Button risk={step.risk} onClick={() => stage(step, index)} aria-label={`Stage ${step.title}`}>Stage</Button>)}
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
