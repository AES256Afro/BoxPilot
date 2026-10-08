import { Fragment, useState } from "react";
import { Button, Facts, KeyValue, Notice, StatusChip, Tag } from "../../ui";
import type { AgentPlan, AgentPlanStep, Run, RunCheck, RunStep } from "./api";
import { kindWords, runState, seconds, usd } from "./format";
import { Prose, inline } from "./Prose";

/*
 * A run's trace (M37): every step as it happened - how the request was understood (the intent)
 * and the plan made from it, what the agent recalled from memory, the model starting, each call to
 * it with its tokens and time, each tool with what it was asked and what it gave back (redacted, as
 * the model saw it), each hand-off, note, card and notice - then the answer, with the tool outputs
 * it cites numbered T1, T2 as the model was shown them. Nothing is hidden from the person reading
 * it: this is how an owner checks what an agent looked at before trusting what it says.
 */

const stepKindWords: Record<RunStep["kind"], string> = {
  intent: "intent", plan: "plan", recall: "memory", memory: "memory", model: "model", tool: "tool", handoff: "hand-off", proposal: "card", note: "note", notify: "notice", system: "runner", finding: "finding", action: "job",
};
const ago = (value: unknown) => (typeof value === "string" && value ? value : null);
const citable = new Set<RunStep["kind"]>(["tool", "memory", "handoff", "proposal", "note", "notify", "action"]);

interface Intent { goal?: string; subject?: string; constraints?: string[]; tools?: string[]; confidence?: number | null; clarify?: string | null }

function stepTitle(step: RunStep): string {
  if (step.kind === "model") {
    const calls = Array.isArray(step.input) ? step.input.map((call: { name?: string }) => String(call?.name ?? "").replace(/_/g, ".")).filter(Boolean) : [];
    return calls.length ? `Asked for ${calls.join(", ")}` : "Wrote its answer";
  }
  if (step.kind === "system") return typeof step.flags?.detail === "string" && step.flags.detail ? step.flags.detail : step.name ?? "The runner";
  if (step.kind === "intent") return step.state === "failed" ? "Could not say how it understood the request" : `Understood: ${(step.input as Intent | null)?.goal ?? step.output ?? ""}`;
  if (step.kind === "plan") return `Planned ${Array.isArray(step.input) ? step.input.length : 0} ${Array.isArray(step.input) && step.input.length === 1 ? "step" : "steps"}`;
  if (step.kind === "recall") return `Recalled ${Number(step.flags?.read ?? 0)} ${Number(step.flags?.read ?? 0) === 1 ? "memory" : "memories"}`;
  if (step.kind === "memory") return `Searched memory for “${String((step.input as { query?: string } | null)?.query ?? "")}”`;
  // M44: another agent's finding offered before planning, and a hand-off answered from one.
  if (step.kind === "finding") return `Offered ${step.name ?? "another agent"}'s finding`;
  if (step.kind === "handoff" && step.flags?.reused) return `Used ${String((step.input as { agent?: string } | null)?.agent ?? "a specialist")}'s finding from ${ago(step.flags.age) ?? "earlier"} instead of running it again`;
  if (step.kind === "handoff") return `Handed to ${String((step.input as { agent?: string } | null)?.agent ?? "a specialist")}`;
  if (step.kind === "tool" && step.name === "agents.handoff") return `${String((step.input as { agent?: string } | null)?.agent ?? "A specialist")}${step.flags?.reused ? "'s finding" : " answered"}`;
  return step.name ?? stepKindWords[step.kind];
}

function IntentDetail({ step }: { step: RunStep }) {
  const intent = (step.input ?? {}) as Intent;
  return (
    <KeyValue layout="rows" className="agents-step__intent" items={[
      { id: "goal", label: "Goal", value: intent.goal ?? "—" },
      { id: "subject", label: "About", value: intent.subject || "—" },
      ...(intent.constraints?.length ? [{ id: "constraints", label: "Limits", value: intent.constraints.join("; ") }] : []),
      { id: "tools", label: "Tools it needs", value: intent.tools?.length ? intent.tools.map((tool) => tool.replace(/_/g, ".")).join(", ") : "none", mono: true },
      { id: "confidence", label: "Confidence", value: typeof intent.confidence === "number" ? `${Math.round(intent.confidence * 100)}%` : "not said", mono: true, status: typeof intent.confidence === "number" && intent.confidence < 0.5 ? "warning" : undefined },
    ]} />
  );
}

/** Another agent's finding, as it was offered (M44): who found it, when, until when it is fresh, and its words. */
function FindingDetail({ step }: { step: RunStep }) {
  const input = (step.input ?? {}) as { agent?: string; writtenAt?: string; freshUntil?: string; unsure?: boolean; partial?: boolean };
  const when = (iso: string | undefined) => (iso ? new Date(iso).toLocaleString([], { dateStyle: "medium", timeStyle: "short" }) : "—");
  return (
    <div className="agents-step__detail">
      <KeyValue layout="rows" className="agents-step__intent" items={[
        { id: "from", label: "Found by", value: input.agent ?? step.name ?? "another agent" },
        { id: "written", label: "Written", value: when(input.writtenAt) },
        { id: "fresh", label: "Fresh until", value: when(input.freshUntil) },
        ...(input.unsure ? [{ id: "unsure", label: "Its check", value: "not sure of all of it", status: "warning" as const }] : []),
        ...(input.partial ? [{ id: "partial", label: "Its run", value: "reached a limit, so it may be incomplete", status: "warning" as const }] : []),
      ]} />
      {step.output && <><span className="agents-step__label">What it found</span><pre className="agents-step__text">{step.output}</pre></>}
    </div>
  );
}

function StepDetail({ step }: { step: RunStep }) {
  if (step.kind === "intent" && step.state === "done") return <IntentDetail step={step} />;
  if (step.kind === "finding") return <FindingDetail step={step} />;
  if (step.kind === "plan") {
    const plan = Array.isArray(step.input) ? step.input as Array<{ step: string; tool: string | null }> : [];
    return <ol className="agents-step__plan">{plan.map((entry, index) => <li key={index}>{entry.step}{entry.tool ? <code> {entry.tool.replace(/_/g, ".")}</code> : null}</li>)}</ol>;
  }
  const input = step.input === null || step.input === undefined ? null : typeof step.input === "string" ? step.input : JSON.stringify(step.input, null, 2);
  return (
    <div className="agents-step__detail">
      {input && input !== "{}" && <><span className="agents-step__label">Asked</span><pre className="agents-step__text">{input}</pre></>}
      {step.output && step.kind !== "system" && <><span className="agents-step__label">{step.kind === "model" ? "Said" : step.kind === "recall" ? "Recalled" : "Gave back"}</span><pre className="agents-step__text">{step.output}</pre></>}
    </div>
  );
}

export function TraceView({ steps }: { steps: RunStep[] }) {
  // The intent and the plan start open, as they arrive; everything else starts closed.
  const [toggled, setToggled] = useState<Set<number>>(new Set());
  const toggle = (seq: number) => setToggled((current) => { const next = new Set(current); if (next.has(seq)) next.delete(seq); else next.add(seq); return next; });
  const isOpen = (step: RunStep) => (step.kind === "intent" || step.kind === "plan") !== toggled.has(step.seq);
  let toolIndex = 0;
  return (
    <ol className="agents-trace" aria-label="What the agent did">
      {steps.map((step) => {
        const numbered = citable.has(step.kind) && step.state === "done";
        if (numbered) toolIndex += 1;
        // Another agent's finding is numbered F1, F2 in the order it was offered (M44).
        const findingId = step.kind === "finding" && typeof step.flags?.finding === "string" ? step.flags.finding : null;
        const expandable = ["intent", "plan"].includes(step.kind) || (step.input !== null && step.input !== undefined && JSON.stringify(step.input) !== "{}") || (Boolean(step.output) && step.kind !== "system");
        const status = step.state === "failed" ? "danger" : step.state === "refused" ? "warning" : "good";
        return (
          <li key={step.seq} className="agents-step ui-marked" data-kind={step.kind} data-status={status}>
            <span className="ui-mark" aria-hidden="true" />
            <span className="agents-step__main">
              <span className="agents-step__head">
                <Tag tone={step.kind === "intent" || step.kind === "plan" ? "accent" : step.kind === "recall" || step.kind === "memory" || step.kind === "finding" ? "info" : "neutral"}>{stepKindWords[step.kind]}</Tag>
                {numbered && <code className="agents-step__cite">T{toolIndex}</code>}
                {findingId && <code className="agents-step__cite">{findingId}</code>}
                <span className="agents-step__title">{stepTitle(step)}</span>
                {step.state !== "done" && <StatusChip status={status}>{step.state}</StatusChip>}
                {Boolean(step.flags?.injection) && <StatusChip status="warning">looked like an instruction</StatusChip>}
                <Facts as="span" className="agents-step__facts">
                  {step.durationMs !== null && step.durationMs > 0 ? seconds(step.durationMs) : ""}
                  {step.tokensIn || step.tokensOut ? ` · ${step.tokensIn ?? 0} in / ${step.tokensOut ?? 0} out` : ""}
                </Facts>
                {expandable && <Button variant="ghost" className="agents-step__toggle" aria-expanded={isOpen(step)} onClick={() => toggle(step.seq)}>{isOpen(step) ? "Hide" : "Show"}</Button>}
              </span>
              {isOpen(step) && <StepDetail step={step} />}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

/**
 * The answer: its markdown drawn as safe prose (M44, Prose.tsx), [T1] and [F1] citations as marks;
 * a JSON answer as its fields.
 */
export function AnswerText({ text }: { text: string }) {
  let fields: Record<string, unknown> | null = null;
  if (/^\s*\{/.test(text)) { try { const parsed = JSON.parse(text); if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) fields = parsed; } catch { fields = null; } }
  if (fields) {
    return (
      <dl className="agents-answer agents-answer--fields">
        {Object.entries(fields).map(([name, value]) => <Fragment key={name}><dt>{name}</dt><dd>{inline(String(value), name)}</dd></Fragment>)}
      </dl>
    );
  }
  return <Prose text={text} className="agents-answer" />;
}

/**
 * The check before answering (M40): what the answer states, held to the tool output it cites. Said
 * in a line under the answer: all matched, the model corrected what did not, or the answer says
 * what it is not sure of.
 */
function CheckLine({ check }: { check: RunCheck }) {
  const statements = (count: number) => `${count} ${count === 1 ? "statement" : "statements"}`;
  const [status, words] = check.unsure
    ? ["warning", `${statements(check.mismatches)} did not match what its tools said${check.corrected ? " even after a correction" : ""}; the answer says so under it.`] as const
    : check.corrected
      ? ["good", `${statements(check.found)} did not match what its tools said at first; the model corrected ${check.found === 1 ? "it" : "them"}.`] as const
      : ["good", `every fact in ${statements(check.checked)} matches the tool output it cites.`] as const;
  return (
    <p className="agents-run__check">
      <StatusChip status={status}>{check.unsure ? "not sure" : "checked"}</StatusChip>
      <span>Checked against its tools: {words}</span>
    </p>
  );
}

const planStateWords: Record<AgentPlan["state"], { label: string; status: "good" | "warning" | "danger" | "neutral" }> = {
  running: { label: "carrying out", status: "neutral" }, waiting: { label: "waiting", status: "neutral" }, done: { label: "finished", status: "good" },
  failed: { label: "stopped", status: "danger" }, expired: { label: "ran out of time", status: "warning" }, cancelled: { label: "stopped by a person", status: "neutral" },
};
const planStepWords: Record<AgentPlanStep["state"], string> = { pending: "to do", running: "running", waiting: "waiting for a person", checking: "checking", done: "done", failed: "failed" };

/**
 * A plan the run made (M45.6): its steps, where it is and how each went, and a way to stop it while
 * it is going. Each operation's job is in Activity like any other.
 */
export function PlanView({ plan, onStop }: { plan: AgentPlan; onStop?: (planId: string) => void }) {
  const going = plan.state === "running" || plan.state === "waiting";
  const shown = planStateWords[plan.state];
  return (
    <div className="agents-plan" aria-label={`The plan: ${plan.title}`}>
      <div className="agents-plan__head">
        <StatusChip status={shown.status}>{shown.label}</StatusChip>
        <span className="agents-plan__title">{plan.title}</span>
        {going && onStop && <Button variant="ghost" onClick={() => onStop(plan.id)}>Stop the plan</Button>}
      </div>
      <ol className="agents-plan__steps">
        {plan.steps.map((step, index) => (
          <li key={index} className={`agents-plan__step agents-plan__step--${step.state}`}>
            <span>{step.title}</span>{" "}
            <Tag tone={step.state === "done" ? "good" : step.state === "failed" ? "danger" : "neutral"}>{planStepWords[step.state]}</Tag>
            {step.grant === "run" && <Tag>ran under its leave</Tag>}
            {step.note && <span className="agents-plan__note">{step.note}</span>}
          </li>
        ))}
      </ol>
      {plan.reason && <p className="agents-run__reason">{plan.reason}</p>}
    </div>
  );
}

/** A run's outcome, its facts, its answer and its trace. */
export function RunView({ run, onStopPlan }: { run: Run; onStopPlan?: (planId: string) => void }) {
  const state = runState(run.state);
  const usage = run.usage ?? {};
  return (
    <div className="agents-run">
      <div className="agents-run__head">
        <StatusChip status={state.status}>{run.outputKind === "question" ? "asked back" : state.label}</StatusChip>
        <span className="agents-run__what">{run.question ?? run.trigger?.title ?? kindWords[run.kind]}</span>
        {run.trigger?.secondOpinionOf && <Tag tone="accent">second opinion</Tag>}
      </div>
      {run.outputKind === "question" && <Notice tone="info" title="It asked rather than guess">Its question is below, and on a card on the Agents tab. Ask again with the answer.</Notice>}
      {run.flags?.degraded && (
        <Notice tone="warning" title="Facts only">
          {run.flags.degraded === "budget" ? "The agent had used its model time for today, so this is what its tools found, without the model's words."
            : run.flags.degraded === "timeout" ? "The model took too long, so this is what the tools found."
              : "The model could not be reached, so this is what the tools found. The Usage tab says why."}
        </Notice>
      )}
      {run.flags?.injection && <Notice tone="warning" title="Something it read looked like an instruction">The agent was told to treat it as data. The step is marked in the trace.</Notice>}
      {run.reason && run.state !== "completed" && <p className="agents-run__reason">{run.reason}</p>}
      {run.answer && <AnswerText text={run.answer} />}
      {run.plan && <PlanView plan={run.plan} onStop={onStopPlan} />}
      {run.flags?.check && <CheckLine check={run.flags.check} />}
      {(run.flags?.citations?.unknown?.length ?? 0) > 0 && <p className="agents-run__reason">It cited {run.flags.citations?.unknown.join(", ")}, which it was never shown.</p>}
      {usage.routeReason && <p className="agents-run__reason">Moved to Claude: {usage.routeReason}.</p>}
      {run.flags?.secondOpinion && <Notice tone="info" title="Asked again on Claude">{run.flags.secondOpinion.reason}. Claude answers it as a run of its own, marked second opinion in the list.</Notice>}
      <KeyValue layout="strip" className="agents-run__facts" items={[
        { id: "kind", label: "Started by", value: kindWords[run.kind] },
        { id: "read", label: "Read as", value: run.readRole, mono: true },
        ...(usage.route ? [
          { id: "on", label: "Answered by", value: usage.route === "both" ? `local, then ${usage.model ?? "Claude"}` : usage.model ?? "Claude", mono: true },
          { id: "cost", label: "Cost", value: usd(usage.costUsd ?? null), mono: true },
        ] : []),
        { id: "model", label: "Model", value: seconds(usage.modelMs ?? null), mono: true },
        { id: "load", label: "Load", value: seconds(usage.loadMs ?? null), mono: true },
        { id: "tokens", label: "Tokens", value: String((usage.promptTokens ?? 0) + (usage.completionTokens ?? 0)), mono: true },
        { id: "tools", label: "Tools", value: String(usage.toolCalls ?? 0), mono: true },
        { id: "version", label: "Version", value: `v${run.version}`, mono: true },
      ]} />
      {run.steps && run.steps.length > 0 && <TraceView steps={run.steps} />}
    </div>
  );
}
