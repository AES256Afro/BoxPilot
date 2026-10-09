/**
 * The run loop (M45.8, from BoxPilot's runner): act with tools, then check the answer.
 *
 * Acting is one conversation that only grows at its end: the model's turn, then each tool's output,
 * then the next turn. Nothing is ever inserted before the end, so a model server that keeps its
 * prompt cache reads each part once. Limits on steps, tool calls and tokens hold throughout; on the
 * last step it may take, the model is told to answer with what it has, at the end of the last tool
 * round, and offered no tool.
 *
 * Then the check (check/verify.mjs): every claim in the draft is held to the tool output it cites,
 * with no model. When one does not match, the model is asked once to correct the draft, in a small
 * conversation of its own, if that fits in what the run has left; the correction is checked the
 * same way and kept only if it is better. Whatever still does not match is said under the answer.
 * A JSON answer is only checked: rewriting it could break the host's fields.
 *
 * The host gives the session (session.mjs), the tools to call and where the trace goes.
 */
import { correctionMessages, unsureNote, verifyAnswer } from "../check/verify.mjs";
import { assistantTurn } from "../messages.mjs";
import { thinkingOff } from "../providers/openai-compatible.mjs";
import { stripWrapperBlocks } from "../safety/guard.mjs";
import { answerFormat, readStructuredAnswer } from "./answer.mjs";
import { clipToolOutput, paceDefaults } from "./pace.mjs";

/** A small model sometimes writes its tool call as text: never part of an answer. */
export const stripToolMarkup = (text) => String(text ?? "").replace(/<tool_call>[\s\S]*?(<\/tool_call>|$)/g, "").trim();

/**
 * What is added to the end of the last tool round when the run has no tool calls left: at the end,
 * so everything the model already read stays the same, and outside the tool's box.
 */
export function answerNowNote(structured = false) {
  return `\n\nThis run has no tool calls left. Answer now with what you have${structured ? ", as the JSON fields" : ""}. Do not call more tools.`;
}

/** A model's turn as the trace keeps it. */
export const modelStep = (asked, text, toolCalls = []) => ({ kind: "model", name: asked.model?.model ?? null, text, toolCalls, durationMs: asked.took, tokensIn: asked.result.usage?.promptTokens, tokensOut: asked.result.usage?.completionTokens });

const words = (count) => `${count} ${count === 1 ? "statement" : "statements"}`;

/**
 * The check before answering. `sources` are what the answer may cite: `{ id, title, text }`.
 * Returns the answer to give, what the check found, and any boxes the correction wrote that only
 * the host writes (taken out of it).
 *
 * @param {{
 *   session: ReturnType<typeof import("./session.mjs").createModelSession>,
 *   draft: string,
 *   sources: Array<{ id: string, title?: string, text: string }>,
 *   structured?: boolean,
 *   record: (step: object) => Promise<unknown>,
 *   note: (name: string, detail: string, state?: string) => Promise<unknown>,
 *   pace?: typeof paceDefaults,
 * }} options
 */
export async function checkAnswer({ session, draft, sources, structured = false, record, note, pace = paceDefaults }) {
  const check = { claims: 0, checked: 0, found: 0, left: 0, corrected: false, unsure: false, checkMs: 0, correctionMs: 0 };
  const removed = [];
  const timed = (work) => { const started = performance.now(); const value = work(); check.checkMs += Math.round((performance.now() - started) * 100) / 100; return value; };
  const first = timed(() => verifyAnswer(draft, sources));
  Object.assign(check, { claims: first.claims, checked: first.checked, found: first.issues.length, left: first.issues.length });
  if (!first.issues.length) {
    await note("check", `Checked the answer against the tool output it cites: ${first.checked} ${first.checked === 1 ? "statement" : "statements"} with facts to check, all match.`);
    return { answer: draft, check, removed };
  }
  let answer = draft;
  let remaining = first.issues;
  if (!structured && session.model) {
    const fixer = { tools: null, messages: correctionMessages(draft, first.issues, sources), last: null };
    const draftTokens = Math.ceil(draft.length / session.charsPerToken);
    const asked = await session.ask(fixer, {
      maxTokens: Math.min(session.settings.maxTokens ?? 1024, draftTokens + pace.correctionExtraTokens),
      minTokens: Math.min(draftTokens, 256), extra: (settings) => thinkingOff(settings.extra ?? {}), purpose: "correction", optional: true,
    });
    if (asked?.result?.content) {
      check.correctionMs = asked.took;
      await record(modelStep(asked, asked.result.content));
      const corrected = stripWrapperBlocks(stripToolMarkup(asked.result.content));
      const candidate = corrected.text;
      const again = timed(() => verifyAnswer(candidate, sources));
      // Better means fewer mismatches while still an answer: as many statements that checked out,
      // at least half as long, and citing the tools if the draft did. "I cannot say anything" has
      // no mismatch either.
      const matched = (result) => result.checked - new Set(result.issues.map((issue) => issue.claim)).size;
      const cites = (text) => /\[[TF]\d+\]/.test(text);
      const better = again.issues.length < first.issues.length && matched(again) >= matched(first)
        && candidate.length * 2 >= draft.length && (!cites(draft) || cites(candidate));
      if (candidate && better) { answer = candidate; remaining = again.issues; check.corrected = true; removed.push(...corrected.removed); }
    }
  }
  check.left = remaining.length;
  if (remaining.length && !structured) { answer = `${answer}${unsureNote(remaining)}`; check.unsure = true; }
  await note("check", check.corrected
    ? `Checked the answer against the tool output it cites: ${words(first.issues.length)} did not match; the model corrected ${remaining.length ? `${first.issues.length - remaining.length} of them, and the answer says it is not sure of the rest` : "them"} (${Math.round(check.correctionMs / 100) / 10} s).`
    : `Checked the answer against the tool output it cites: ${words(first.issues.length)} did not match${structured ? "" : "; the answer says it is not sure of them"}.`, remaining.length ? "failed" : "done");
  return { answer, check, removed };
}

/**
 * Act, then check. `conversation` is `{ tools, messages, last }`: the tools the run offers (function
 * schemas, or null) and the messages so far. `run` is the run's state, shared with the session and
 * the host: `degraded` when a call could not be made or the model wrote nothing, `limitReached` and
 * `limitKind` when the run reached a limit.
 *
 * @param {{
 *   session: ReturnType<typeof import("./session.mjs").createModelSession>,
 *   run: { degraded: string | null, limitReached: boolean, limitKind?: string | null },
 *   conversation: { tools: object[] | null, messages: object[], last: object | null },
 *   callTool: (call: { id: string, name: string, arguments: string }) => Promise<{ content: string }>,
 *   sources: () => Array<{ id: string, title?: string, text: string }>,
 *   record: (step: object) => Promise<unknown>,
 *   note: (name: string, detail: string, state?: string) => Promise<unknown>,
 *   limits: { steps: number, tokens: number, maxToolCalls: number, toolCallsPerStep?: number },
 *   tokensUsed: () => number,
 *   signal?: AbortSignal,
 *   fields?: Array<{ name: string, description?: string }> | null,
 *   answerNow?: (structured: boolean) => string,
 *   beforeStep?: () => Promise<unknown>,
 *   pace?: typeof paceDefaults,
 * }} options
 *   `fields`: the answer is JSON with these fields. `beforeStep`: called before each step, where a
 *   host may move the run to another model (`session.use`).
 * @returns {Promise<{ answer: string | null, toolCalls: number, boxes: string[], check: object | null }>}
 */
export async function act({
  session, run, conversation, callTool, sources, record, note, limits, tokensUsed, signal = null, fields = null,
  answerNow = answerNowNote, beforeStep = async () => {}, pace = paceDefaults,
}) {
  const structured = Array.isArray(fields) && fields.length > 0;
  const answerExtra = (settings) => (structured ? { ...(settings.extra ?? {}), response_format: answerFormat(fields) } : settings.extra ?? {});
  // The boxes only the host writes that the model wrote into its answer: taken out before the
  // check, so what it made up is never checked as if it were the answer, and told to the host.
  const boxes = [];
  const unboxed = (text) => { const stripped = stripWrapperBlocks(text); boxes.push(...stripped.removed); return stripped.text; };
  const maxTokens = (floor) => Math.max(floor, Math.min(session.settings.maxTokens ?? 1024, limits.tokens - tokensUsed()));
  let answer = null;
  let toolCalls = 0;
  for (let step = 0; step < limits.steps && !answer; step += 1) {
    if (signal?.aborted) break;
    const byTokens = tokensUsed() >= limits.tokens * 0.85;
    const lastStep = step === limits.steps - 1 || byTokens || toolCalls >= limits.maxToolCalls;
    // The last step it may take: told to answer with what it has, which is a limit reached - its
    // steps, its tool calls, or its tokens nearly spent.
    if (lastStep) { run.limitReached = true; run.limitKind ??= step === limits.steps - 1 ? "steps" : toolCalls >= limits.maxToolCalls ? "toolCalls" : "tokens"; }
    const final = lastStep && step > 0 && Boolean(conversation.tools);
    if (final) {
      // Told at the end of the last tool round, so nothing before it changes.
      const last = conversation.messages.at(-1);
      if (last?.role === "tool") conversation.messages[conversation.messages.length - 1] = { ...last, content: `${last.content}${answerNow(structured)}` };
      else conversation.messages.push({ role: "user", content: answerNow(structured).trim() });
    }
    await beforeStep();
    const asked = await session.ask(conversation, {
      maxTokens: maxTokens(64),
      toolChoice: final ? "none" : "auto",
      ...(final && structured ? { extra: answerExtra } : {}),
      purpose: final ? "last answer" : "next step",
    });
    if (!asked) break;
    const { result } = asked;
    const calls = final ? [] : (result.toolCalls ?? []).slice(0, limits.toolCallsPerStep ?? 3);
    await record(modelStep(asked, result.content, calls));
    if (!calls.length) { answer = stripToolMarkup(result.content) || null; if (!answer) run.degraded = "model-error"; break; }
    conversation.messages.push(assistantTurn(result, calls));
    for (const call of calls) {
      if (signal?.aborted) break;
      toolCalls += 1;
      const reply = await callTool(call);
      conversation.messages.push({ role: "tool", tool_call_id: call.id, content: clipToolOutput(reply.content, session.readChars(pace.toolReadSeconds)) });
    }
  }
  // A structured answer that is not the host's JSON: the same prompt again, held to the JSON.
  if (answer && structured && readStructuredAnswer(answer, fields).problem && !run.degraded) {
    const asked = await session.ask(conversation, { maxTokens: maxTokens(128), toolChoice: "none", extra: answerExtra, purpose: "JSON answer" });
    if (asked?.result?.content) {
      await record(modelStep(asked, asked.result.content));
      answer = stripToolMarkup(asked.result.content);
    }
  }
  // Its scratch notes and any tool output it wrote itself are not its answer.
  if (answer) answer = unboxed(answer) || null;
  // The check before answering: each claim against the output it cites.
  let check = null;
  const cited = sources();
  if (answer && !run.degraded && !signal?.aborted && cited.length) {
    const checked = await checkAnswer({ session, draft: answer, sources: cited, structured, record, note, pace });
    answer = checked.answer;
    check = checked.check;
    boxes.push(...checked.removed);
  }
  if (!answer && !run.degraded && !signal?.aborted) run.degraded = "model-error";
  return { answer, toolCalls, boxes, check };
}
