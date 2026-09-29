import { Fragment, useState } from "react";
import { Button, Facts, KeyValue, Notice, StatusChip, Tag } from "../../ui";
import type { Run, RunStep } from "./api";
import { kindWords, runState, seconds } from "./format";

/*
 * A run's trace (M37): every step as it happened - how the request was understood (the intent)
 * and the plan made from it, what the agent recalled from memory, the model starting, each call to
 * it with its tokens and time, each tool with what it was asked and what it gave back (redacted, as
 * the model saw it), each hand-off, note, card and notice - then the answer, with the tool outputs
 * it cites numbered T1, T2 as the model was shown them. Nothing is hidden from the person reading
 * it: this is how an owner checks what an agent looked at before trusting what it says.
 */

const stepKindWords: Record<RunStep["kind"], string> = {
  intent: "intent", plan: "plan", recall: "memory", memory: "memory", model: "model", tool: "tool", handoff: "hand-off", proposal: "card", note: "note", notify: "notice", system: "runner",
};
const citable = new Set<RunStep["kind"]>(["tool", "memory", "handoff", "proposal", "note", "notify"]);

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
  if (step.kind === "handoff") return `Handed to ${String((step.input as { agent?: string } | null)?.agent ?? "a specialist")}`;
  if (step.kind === "tool" && step.name === "agents.handoff") return `${String((step.input as { agent?: string } | null)?.agent ?? "A specialist")} answered`;
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

function StepDetail({ step }: { step: RunStep }) {
  if (step.kind === "intent" && step.state === "done") return <IntentDetail step={step} />;
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
        const expandable = ["intent", "plan"].includes(step.kind) || (step.input !== null && step.input !== undefined && JSON.stringify(step.input) !== "{}") || (Boolean(step.output) && step.kind !== "system");
        const status = step.state === "failed" ? "danger" : step.state === "refused" ? "warning" : "good";
        return (
          <li key={step.seq} className="agents-step ui-marked" data-kind={step.kind} data-status={status}>
            <span className="ui-mark" aria-hidden="true" />
            <span className="agents-step__main">
              <span className="agents-step__head">
                <Tag tone={step.kind === "intent" || step.kind === "plan" ? "accent" : step.kind === "recall" || step.kind === "memory" ? "info" : "neutral"}>{stepKindWords[step.kind]}</Tag>
                {numbered && <code className="agents-step__cite">T{toolIndex}</code>}
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

/** The answer, with [T1]-style citations drawn as marks; a JSON answer as its fields. */
export function AnswerText({ text }: { text: string }) {
  let fields: Record<string, unknown> | null = null;
  if (/^\s*\{/.test(text)) { try { const parsed = JSON.parse(text); if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) fields = parsed; } catch { fields = null; } }
  const cited = (value: string) => value.split(/(\[T\d+\])/g).map((part, index) => (/^\[T\d+\]$/.test(part)
    ? <code key={index} className="agents-answer__cite" title="The tool output this comes from, numbered as in the trace">{part.slice(1, -1)}</code>
    : <Fragment key={index}>{part}</Fragment>));
  if (fields) {
    return (
      <dl className="agents-answer agents-answer--fields">
        {Object.entries(fields).map(([name, value]) => <Fragment key={name}><dt>{name}</dt><dd>{cited(String(value))}</dd></Fragment>)}
      </dl>
    );
  }
  return <div className="agents-answer">{cited(text)}</div>;
}

/** A run's outcome, its facts, its answer and its trace. */
export function RunView({ run }: { run: Run }) {
  const state = runState(run.state);
  const usage = run.usage ?? {};
  return (
    <div className="agents-run">
      <div className="agents-run__head">
        <StatusChip status={state.status}>{run.outputKind === "question" ? "asked back" : state.label}</StatusChip>
        <span className="agents-run__what">{run.question ?? run.trigger?.title ?? kindWords[run.kind]}</span>
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
      {(run.flags?.citations?.unknown?.length ?? 0) > 0 && <p className="agents-run__reason">It cited {run.flags.citations?.unknown.join(", ")}, which it was never shown.</p>}
      <KeyValue layout="strip" className="agents-run__facts" items={[
        { id: "kind", label: "Started by", value: kindWords[run.kind] },
        { id: "read", label: "Read as", value: run.readRole, mono: true },
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
