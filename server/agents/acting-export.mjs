/**
 * The acting conversation as training data (M46.7, ADR-014). The example book trains the planner:
 * a request and the plan a person approved. The answer is the other half: given the system rules,
 * the task with its plan and each tool's boxed output, the model wrote an answer with its [T]
 * citations, and the check held every claim to the output it cites. For a run a person approved
 * (a thumbs up, a card staged, an evaluation question graded right) that conversation is rebuilt
 * from the steps the run kept - the system message as prompt.mjs words it, the task as the runner
 * was given it with the plan it carried, each model turn with its tool calls, each tool's output
 * boxed as the model read it (T1, T2 ...), and the answer - as one chat-shaped record.
 *
 * A record must be faithful, so a run that does not line up makes none: a run that did not
 * complete, a follow-up run (its prompt held specialists' answers), part of a conversation, a JSON
 * answer, an answer the check doubted or that cites a finding, a run that read something that
 * looked like an instruction, or steps whose tool calls and outputs do not pair. What the prompt
 * held beside the task - the agent's notes, what it recalled, the other agents' findings, the
 * specialists it could hand to - is not kept with the run and is left out; `meta.context` says so.
 * The house's names go through the same stand-ins as the book (`createStandIns`).
 */
import { createStandIns, wrapToolOutput } from "../../packages/harness/src/index.mjs";
import { planMessage } from "./intent.mjs";
import { systemMessage, taskMessage } from "./prompt.mjs";
import { toolById } from "./tool-catalog.mjs";

/** The step kinds that are a tool's answer to a call, as the service counts them (outputsSoFar). */
export const outputKinds = Object.freeze(["tool", "memory", "proposal", "note", "notify", "handoff", "action"]);
const answers = new Set(outputKinds);
const fnOf = (name) => toolById(name)?.fn ?? String(name ?? "").replace(/\./g, "_");

/** Why a run makes no record, or null when it may. */
export function actingSkipReason(run, spec = {}) {
  if (!run || run.state !== "completed") return "the run did not complete";
  if (!["ask", "manual", "schedule", "eval"].includes(run.kind)) return "a follow-up run";
  if (!run.answer) return "no answer";
  if (run.threadId) return "part of a conversation";
  if (spec?.prompt?.output?.format === "json") return "a JSON answer";
  if (/\[F\d+\]/.test(run.answer)) return "cites a finding";
  const check = run.flags?.check;
  if (check && ((check.mismatches ?? 0) > 0 || check.unsure)) return "the check doubted it";
  if (run.flags?.injection) return "read something that looked like an instruction";
  return null;
}

/**
 * The conversation one run held, rebuilt from its steps, or null when its tool calls and outputs do
 * not pair up. `understanding` is the planner's (the intent step's input) when the caller has it.
 */
export function actingConversation({ spec, run, steps, understanding = null }) {
  const ordered = [...steps].sort((a, b) => a.seq - b.seq);
  const plan = ordered.find((step) => step.kind === "plan")?.input;
  const intent = understanding ?? ordered.find((step) => step.kind === "intent" && step.state === "done")?.input ?? null;
  let task = taskMessage({ kind: run.kind, question: run.question, trigger: run.trigger, now: new Date(run.startedAt ?? run.queuedAt ?? Date.now()) });
  if (intent && Array.isArray(plan)) task += `\n\n${planMessage({ ...intent, plan }, { hinted: [] })}`;
  const messages = [
    { role: "system", content: systemMessage(spec, { specialists: [], chat: null, useFindings: spec?.sharing?.useFindings !== false }) },
    { role: "user", content: task },
  ];
  let index = 0;
  let pending = [];
  for (const step of ordered) {
    if (step.kind === "model") {
      if (step.state !== "done") return null;
      if (pending.length) return null;
      const calls = Array.isArray(step.input) ? step.input : [];
      // A model turn with no tool calls is the answer: written below as the run kept it.
      if (!calls.length) continue;
      const turn = { role: "assistant", content: step.output || null, tool_calls: calls.map((call, position) => ({ id: `call_${step.seq}_${position}`, type: "function", function: { name: String(call.name ?? ""), arguments: String(call.arguments ?? "{}") } })) };
      messages.push(turn);
      pending = turn.tool_calls.map((call) => call.id);
      continue;
    }
    if (!answers.has(step.kind)) continue;
    const callId = pending.shift();
    if (!callId) return null;
    if (step.state === "done") {
      index += 1;
      messages.push({ role: "tool", tool_call_id: callId, content: wrapToolOutput({ index, tool: fnOf(step.name), text: step.output ?? "", flags: step.flags ?? {} }) });
    } else {
      messages.push({ role: "tool", tool_call_id: callId, content: step.output || `${fnOf(step.name)} was ${step.state}.` });
    }
  }
  if (pending.length) return null;
  messages.push({ role: "assistant", content: String(run.answer) });
  return { messages, toolOutputs: index };
}

/**
 * Training records for one agent's approved runs. Each entry is { run, steps, spec?, understanding?,
 * signal? }: the spec is the version the run ran as (the agent's when not given). `names` are the
 * house's names for the stand-ins.
 */
export function actingRecords({ agent, runs, names = {} }) {
  const standIns = createStandIns(names);
  const hide = (text) => standIns.hide(String(text ?? ""));
  const records = [];
  for (const entry of runs) {
    const spec = entry.spec ?? agent.spec ?? {};
    if (actingSkipReason(entry.run, spec)) continue;
    const built = actingConversation({ spec, run: entry.run, steps: entry.steps ?? [], understanding: entry.understanding ?? null });
    if (!built) continue;
    records.push({
      messages: built.messages.map((message) => ({
        ...message,
        content: message.content === null ? null : hide(message.content),
        ...(message.tool_calls ? { tool_calls: message.tool_calls.map((call) => ({ ...call, function: { ...call.function, arguments: hide(call.function.arguments) } })) } : {}),
      })),
      meta: {
        agent: hide(spec.name ?? agent.name), runId: entry.run.id, kind: entry.run.kind, signal: entry.signal ?? null, toolOutputs: built.toolOutputs,
        route: entry.run.usage?.route ? "claude" : "local", model: entry.run.usage?.model ?? entry.run.flags?.model ?? null, checked: entry.run.flags?.check ?? null,
        context: "omitted: the notes, memories, findings and specialists the run was shown are not kept with it",
      },
    });
  }
  return records;
}
