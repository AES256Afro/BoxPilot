import { Fragment, useState } from "react";
import { Button, KeyValue, Notice, StatusChip, Tag } from "../../ui";
import type { Run, RunStep } from "./api";
import { kindWords, runState, seconds } from "./format";

/*
 * A run's trace (M37): every step as it happened - the model starting, each call to it with its
 * tokens and time, each tool with what it was asked and what it gave back (redacted, as the model
 * saw it), each note, card and notice - then the answer, with the tool outputs it cites numbered
 * T1, T2 as the model was shown them. Nothing is hidden from the person reading it: this is how an
 * owner checks what an agent looked at before trusting what it says.
 */

const stepKindWords: Record<RunStep["kind"], string> = { model: "model", tool: "tool", proposal: "card", note: "note", notify: "notice", system: "runner" };

function stepTitle(step: RunStep): string {
  if (step.kind === "model") {
    const calls = Array.isArray(step.input) ? step.input.map((call: { name?: string }) => String(call?.name ?? "").replace(/_/g, ".")).filter(Boolean) : [];
    return calls.length ? `Asked for ${calls.join(", ")}` : "Wrote its answer";
  }
  if (step.kind === "system") return typeof step.flags?.detail === "string" && step.flags.detail ? step.flags.detail : step.name ?? "The runner";
  return step.name ?? stepKindWords[step.kind];
}

function StepDetail({ step }: { step: RunStep }) {
  const input = step.input === null || step.input === undefined ? null : typeof step.input === "string" ? step.input : JSON.stringify(step.input, null, 2);
  return (
    <div className="agents-step__detail">
      {input && input !== "{}" && <><span className="agents-step__label">Asked</span><pre className="agents-step__text">{input}</pre></>}
      {step.output && step.kind !== "system" && <><span className="agents-step__label">{step.kind === "model" ? "Said" : "Gave back"}</span><pre className="agents-step__text">{step.output}</pre></>}
    </div>
  );
}

export function TraceView({ steps }: { steps: RunStep[] }) {
  const [open, setOpen] = useState<Set<number>>(new Set());
  const toggle = (seq: number) => setOpen((current) => { const next = new Set(current); if (next.has(seq)) next.delete(seq); else next.add(seq); return next; });
  let toolIndex = 0;
  return (
    <ol className="agents-trace" aria-label="What the agent did">
      {steps.map((step) => {
        const numbered = ["tool", "proposal", "note", "notify"].includes(step.kind) && step.state === "done";
        if (numbered) toolIndex += 1;
        const expandable = (step.input !== null && step.input !== undefined && JSON.stringify(step.input) !== "{}") || (Boolean(step.output) && step.kind !== "system");
        const status = step.state === "failed" ? "danger" : step.state === "refused" ? "warning" : "good";
        return (
          <li key={step.seq} className="agents-step ui-marked" data-kind={step.kind} data-status={status}>
            <span className="ui-mark" aria-hidden="true" />
            <span className="agents-step__main">
              <span className="agents-step__head">
                <Tag>{stepKindWords[step.kind]}</Tag>
                {numbered && <code className="agents-step__cite">T{toolIndex}</code>}
                <span className="agents-step__title">{stepTitle(step)}</span>
                {step.state !== "done" && <StatusChip status={status}>{step.state}</StatusChip>}
                {Boolean(step.flags?.injection) && <StatusChip status="warning">looked like an instruction</StatusChip>}
                <span className="agents-step__facts">
                  {step.durationMs !== null && step.durationMs > 0 ? seconds(step.durationMs) : ""}
                  {step.tokensIn || step.tokensOut ? ` · ${step.tokensIn ?? 0} in / ${step.tokensOut ?? 0} out` : ""}
                </span>
                {expandable && <Button variant="ghost" className="agents-step__toggle" aria-expanded={open.has(step.seq)} onClick={() => toggle(step.seq)}>{open.has(step.seq) ? "Hide" : "Show"}</Button>}
              </span>
              {open.has(step.seq) && <StepDetail step={step} />}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

/** The answer, with [T1]-style citations drawn as marks that name the step they come from. */
export function AnswerText({ text }: { text: string }) {
  const parts = text.split(/(\[T\d+\])/g);
  return (
    <div className="agents-answer">
      {parts.map((part, index) => (/^\[T\d+\]$/.test(part)
        ? <code key={index} className="agents-answer__cite" title="The tool output this comes from, numbered as in the trace">{part.slice(1, -1)}</code>
        : <Fragment key={index}>{part}</Fragment>))}
    </div>
  );
}

/** A run's outcome, its facts, its answer and its trace. */
export function RunView({ run }: { run: Run }) {
  const state = runState(run.state);
  const usage = run.usage ?? {};
  return (
    <div className="agents-run">
      <div className="agents-run__head">
        <StatusChip status={state.status}>{state.label}</StatusChip>
        <span className="agents-run__what">{run.question ?? run.trigger?.title ?? kindWords[run.kind]}</span>
      </div>
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
