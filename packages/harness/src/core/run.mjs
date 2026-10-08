/**
 * One run, start to finish, for a host whose tools run in-process (M45.8): the CLI, or any other.
 * BoxPilot's runner builds its runs from the same parts with its own planner and tools
 * (server/agents/runner.mjs).
 *
 * The person's words and the host's rules start the conversation; the router picks the model; the
 * loop acts with the toolbox and checks the answer; a run whose model could not finish still gives
 * the person what its tools found. Every step goes to `trace` as it happens.
 *
 * Models: `local` (on this machine or the owner's network) and `remote` (paid, off the machine),
 * either or both. The route says which starts (router.mjs): `local`, `remote`, or `auto` - local,
 * moving to the remote model when the local one fails or the conversation outgrows its context. A
 * remote call that fails because the remote model is not there goes on with the local model, once.
 * A remote model that declines the request ends the run as declined: it is never asked of the local
 * model instead.
 */
import { fallsBack, moveAfterPlan, routerDefaults, startRoute } from "../router.mjs";
import { act, answerNowNote } from "./loop.mjs";
import { createSpeed, paceDefaults } from "./pace.mjs";
import { createModelSession } from "./session.mjs";

export const runDefaults = Object.freeze({ steps: 8, tokens: 24_000, maxToolCalls: 12, toolCallsPerStep: 3, seconds: 600 });

/** The answer when the model could not write one: what the tools said, each with its id. */
export function toolsAnswer(reason, outputs) {
  const lead = {
    timeout: "The model took too long, so this is what the tools found rather than an answer.",
    budget: "The run's model time is used up, so this is what the tools found rather than an answer.",
    "model-unavailable": "No model could be reached, so this is what the tools found rather than an answer.",
  }[reason] ?? "The model did not finish, so this is what the tools found rather than an answer.";
  if (!outputs.length) return `${lead} The tools returned nothing.`;
  const lines = outputs.slice(0, 8).map((output) => {
    const first = String(output.text ?? "").split("\n").map((line) => line.trim()).filter(Boolean).slice(0, 3).join(" ");
    return `- [${output.id}] ${output.title}: ${first.length > 240 ? `${first.slice(0, 239)}…` : first}`;
  });
  return `${lead}\n\n${lines.join("\n")}`;
}

const codeOf = (error) => String(error?.code ?? "").replace(/^model_/, "");

/**
 * @typedef {{ provider: import("../provider.mjs").Provider, model: string, settings?: { temperature?: number, maxTokens?: number, extra?: object }, contextTokens?: number | null, speed?: { promptPerSecond: number, generatePerSecond: number } | null }} RunModel
 *
 * @param {{
 *   task: string,
 *   system: string,
 *   toolbox: ReturnType<typeof import("./tools.mjs").createToolbox>,
 *   models: { local?: RunModel | null, remote?: RunModel | null },
 *   route?: "local" | "remote" | "auto",
 *   limits?: Partial<typeof runDefaults>,
 *   history?: object[],
 *   fields?: Array<{ name: string, description?: string }> | null,
 *   now?: () => number,
 *   signal?: AbortSignal | null,
 *   trace?: (step: object) => unknown,
 *   pace?: typeof paceDefaults,
 *   contextShare?: number,
 * }} options `history`: messages of an earlier conversation, between the rules and the task.
 */
export async function runTask({
  task, system, toolbox, models, route = "local", limits = {}, history = [], fields = null, now = () => Date.now(), signal = null,
  trace = () => {}, pace = paceDefaults, contextShare = routerDefaults.contextShare,
}) {
  const limit = { ...runDefaults, ...limits };
  const deadline = now() + limit.seconds * 1000;
  const controller = new AbortController();
  const stopped = () => controller.abort(new Error("stopped"));
  signal?.addEventListener?.("abort", stopped, { once: true });
  const timer = setTimeout(() => controller.abort(new Error("timeout")), Math.max(1_000, deadline - now()));
  timer.unref?.();

  const run = { degraded: null, limitReached: false, limitKind: null };
  const used = { modelMs: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0, readTokens: 0, modelCalls: 0, costUsd: 0 };
  const note = async (name, detail, state = "done") => { await trace({ kind: "system", name, detail, state }); };
  const record = async (step) => { await trace(step); };

  const start = startRoute({ route, remote: models.remote ? { ok: true } : { ok: false, reason: "No remote model is set up, so the run stays on the local model" } });
  const speeds = Object.fromEntries(["local", "remote"].map((side) => [side, createSpeed(models[side]?.speed?.promptPerSecond > 0 ? { ...models[side].speed, source: "stored" } : pace)]));
  let on = null;
  let moved = false;
  let fellBack = false;
  let declined = null;
  // A remote model's refusal is the run's answer: it ends the run, and no other model is asked.
  const watched = (provider) => ({
    ...provider,
    async chat(request, options) {
      const result = await provider.chat(request, options);
      if (Number.isFinite(result?.costUsd)) used.costUsd = Math.round((used.costUsd + result.costUsd) * 1e6) / 1e6;
      if (result?.reason === "refusal") { declined = result.refusal ?? { category: null }; throw Object.assign(new Error("The model declined the request"), { code: "refusal" }); }
      return result;
    },
  });
  const providers = Object.fromEntries(["local", "remote"].filter((side) => models[side]).map((side) => [side, watched(models[side].provider)]));

  const session = createModelSession({
    signal: controller.signal, now, run, used, pace, note,
    timeLeft: () => ({ ms: deadline - now() - Math.min(pace.reserveMs, limit.seconds * 100), binding: "timeout" }),
    providerOf: (model) => model.provider,
    recover: async (error) => {
      if (declined) return false;
      if (on === "remote" && models.local && !fellBack && fallsBack(codeOf(error))) {
        fellBack = true;
        await note("model", `The remote model did not answer (${String(error?.message ?? error).slice(0, 160)}): going on with the local model.`, "failed");
        use("local");
        return true;
      }
      if (on === "local" && start.mayMove && !moved && !fellBack) {
        const decided = moveAfterPlan({ localProblem: "model-error" });
        moved = true;
        await note("model", `Moved to ${models.remote.model}: ${decided.reason}.`);
        use("remote");
        return true;
      }
      return false;
    },
  });
  function use(side) {
    on = side;
    session.use({ provider: providers[side], model: models[side].model }, { settings: models[side].settings ?? {}, speed: speeds[side] });
  }

  let answer = null;
  let acted = { answer: null, toolCalls: 0, boxes: [], check: null };
  let failed = null;
  const messages = [{ role: "system", content: system }, ...history, { role: "user", content: task }];
  const conversation = { tools: toolbox.schemas.length ? toolbox.schemas : null, messages, last: null };
  try {
    if (start.reason) await note("route", start.reason);
    if (start.start === "local" && !models.local) throw new Error("No model is set up for this run");
    use(start.start);
    await note("model", `On ${models[on].model} (${on})`);
    acted = await act({
      session, run, conversation, limits: limit, signal: controller.signal, fields,
      tokensUsed: () => used.readTokens + used.completionTokens,
      answerNow: answerNowNote,
      callTool: async (call) => {
        const reply = await toolbox.call(call);
        if (reply.flags?.limit) { run.limitReached = true; run.limitKind ??= "toolCalls"; }
        return reply;
      },
      sources: () => toolbox.outputs(),
      record, note, pace,
      beforeStep: async () => {
        if (on !== "local" || !start.mayMove || moved || fellBack) return;
        const decided = moveAfterPlan({ promptTokens: session.tokensOf(conversation), contextTokens: models.local.contextTokens ?? null, contextShare });
        if (!decided.move) return;
        moved = true;
        await note("model", `Moved to ${models.remote.model}: ${decided.reason}.`);
        use("remote");
      },
    });
    answer = acted.answer;
  } catch (error) {
    if (!controller.signal.aborted) failed = error;
    else if (String(controller.signal.reason?.message) === "timeout") run.degraded = "timeout";
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener?.("abort", stopped);
  }

  const routeUsed = moved || fellBack ? "both" : on;
  const result = (outcome, extra = {}) => ({
    outcome, answer: null, degradedReason: null, route: routeUsed, model: on ? models[on].model : null,
    usage: { ...used, ...(acted.check ? { check: acted.check } : {}) }, speeds: Object.fromEntries(Object.entries(speeds).map(([side, speed]) => [side, speed.get()])),
    limitReached: run.limitReached, limitKind: run.limitKind, taint: toolbox.taint(), boxes: acted.boxes, toolCalls: toolbox.calls(), ...extra,
  });
  if (declined) return result("declined", { answer: "The model declined this request.", refusal: declined });
  if (failed) return result("failed", { error: String(failed?.message ?? failed).slice(0, 300) });
  if (controller.signal.aborted && String(controller.signal.reason?.message) !== "timeout") return result("stopped", { answer: answer ?? null });
  if (run.degraded || !answer) {
    const reason = run.degraded ?? "model-error";
    const outputs = toolbox.outputs();
    return result("degraded", { degradedReason: reason, answer: answer ? `${answer}\n\n(${reason === "timeout" ? "The model took too long, so this may stop short." : "The model did not finish."})` : toolsAnswer(reason, outputs) });
  }
  return result("completed", { answer });
}
