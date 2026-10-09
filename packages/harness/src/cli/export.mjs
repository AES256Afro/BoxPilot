/**
 * The command-line host's example book as training data (M47.8). The server's book exports the
 * planner's records and the acting conversations (BoxPilot's M46.3, M46.7); this host has no
 * planner, so each good run is one acting conversation: the rules it was given, the task, each
 * model turn with its tool calls, each tool's output boxed as the model read it (T1, T2 ...), and
 * the answer. Rebuilt from the trace the run kept, so a run whose calls and outputs do not pair,
 * or that did not answer, makes no record.
 *
 * What the run was shown before its task - the demonstrations (M47.5) - is not kept with it and is
 * left out; `meta.context` says so. The tools the rules name are this host's, with web_fetch when
 * the run read the web. This machine's names go through the same stand-ins Claude is given.
 */
import os from "node:os";
import { createStandIns } from "../safety/stand-ins.mjs";
import { wrapToolOutput } from "../safety/guard.mjs";
import { cliRules } from "./prompt.mjs";

const baseTools = ["files_list", "files_read", "files_write", "shell_run", "notes_save", "notes_search"];

/** One run's conversation, or null when its trace does not line up. */
export function conversationOf(run, { tools = baseTools } = {}) {
  if (!run?.answer || !["completed", "degraded"].includes(run.outcome)) return null;
  const steps = [...(run.steps ?? [])].sort((a, b) => a.seq - b.seq);
  const web = steps.some((step) => step.kind === "tool" && step.name === "web_fetch");
  const named = web && !tools.includes("web_fetch") ? [...tools.slice(0, 4), "web_fetch", ...tools.slice(4)] : tools;
  const messages = [
    { role: "system", content: cliRules({ folder: run.folder, today: String(run.startedAt ?? "").slice(0, 10), tools: named, web }) },
    { role: "user", content: String(run.task) },
  ];
  let pending = [];
  let outputs = 0;
  for (const step of steps) {
    if (step.kind === "model") {
      if (pending.length) return null;
      const calls = Array.isArray(step.toolCalls) ? step.toolCalls : [];
      if (!calls.length) continue;
      const turn = { role: "assistant", content: step.text || null, tool_calls: calls.map((call, position) => ({ id: String(call.id ?? `call_${step.seq}_${position}`), type: "function", function: { name: String(call.name ?? ""), arguments: String(call.arguments ?? "{}") } })) };
      messages.push(turn);
      pending = turn.tool_calls.map((call) => call.id);
      continue;
    }
    if (step.kind !== "tool") continue;
    const callId = pending.shift();
    if (!callId) return null;
    if (step.state === "done") {
      outputs += 1;
      messages.push({ role: "tool", tool_call_id: callId, content: wrapToolOutput({ index: step.index ?? outputs, tool: String(step.name), text: step.output ?? "", flags: step.flags ?? {} }) });
    } else {
      messages.push({ role: "tool", tool_call_id: callId, content: step.output || `${step.name} was ${step.state ?? "not run"}.` });
    }
  }
  if (pending.length) return null;
  messages.push({ role: "assistant", content: String(run.answer) });
  return { messages, toolOutputs: outputs };
}

/**
 * Records for the book: each example's run as one conversation, this machine's names hidden.
 * `names` adds to the host's own name and the account running this.
 */
export function exportRecords(store, { names = {}, limit = 1_000 } = {}) {
  const standIns = createStandIns({ hosts: [os.hostname(), ...(names.hosts ?? [])], users: [os.userInfo().username, ...(names.users ?? [])], domains: names.domains ?? [] });
  const hide = (text) => standIns.hide(String(text ?? ""));
  const records = [];
  for (const example of store.listExamples(limit)) {
    const run = store.getRun(example.runId);
    const built = run ? conversationOf(run) : null;
    if (!built) continue;
    records.push({
      messages: built.messages.map((message) => ({
        ...message,
        content: message.content === null ? null : hide(message.content),
        ...(message.tool_calls ? { tool_calls: message.tool_calls.map((call) => ({ ...call, function: { ...call.function, arguments: hide(call.function.arguments) } })) } : {}),
      })),
      meta: { runId: run.id, signal: example.signal, route: run.route ?? null, model: run.model ?? null, outcome: run.outcome, toolOutputs: built.toolOutputs, context: "omitted: the demonstrations shown before the task are not kept with the run" },
    });
  }
  return records;
}

/** Records as JSON Lines, one a line, ending with a newline. */
export const toJsonl = (records) => records.map((record) => JSON.stringify(record)).join("\n") + (records.length ? "\n" : "");
