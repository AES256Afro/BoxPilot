/**
 * A run's model session (M45.8, from BoxPilot's runner): the model the run is on, which may change
 * while it runs, and one way to call it that counts every call against the run's time.
 *
 * Each call's time is worked out first (pace.mjs): the tokens it will read (what the conversation
 * grew by since its last call, or all of it) and the tokens it may write, at the model's speed. A
 * call that cannot fit in what the run has left is not started, and the run says why. A call that
 * fails may be tried once more on another model, when the host says which (`recover`).
 *
 * The host keeps what only it knows: which provider serves a model, the fields its server wants,
 * what to do after a call, and how the run's time is measured.
 */
import { readChatResult } from "../provider.mjs";
import { createSpeed, paceDefaults, promptChars } from "./pace.mjs";

/**
 * @typedef {{ tools: object[] | null, messages: object[], last: { chars: number, promptTokens: number, completionTokens: number } | null }} Conversation
 * @typedef {{ degraded: string | null, limitReached: boolean }} RunState
 */

/**
 * @param {{
 *   signal: AbortSignal,
 *   timeLeft: () => { ms: number, binding: "budget" | "timeout" },
 *   run: RunState,
 *   used: { modelMs: number, modelCalls: number, promptTokens: number, completionTokens: number, cachedTokens: number, readTokens: number },
 *   now?: () => number,
 *   pace?: typeof paceDefaults,
 *   note?: (name: string, detail: string, state?: string) => Promise<unknown>,
 *   providerOf?: (model: object) => import("../provider.mjs").Provider,
 *   fieldsFor?: (model: object) => { fields?: object, cancelId?: string | null },
 *   called?: (model: object) => void,
 *   recover?: (error: Error) => Promise<boolean>,
 * }} options
 *   `run` is the run's state, shared with the host: a call that cannot be made sets `degraded`.
 *   `recover` puts the run on another model (with `use`) and answers true to try the call there.
 */
export function createModelSession({
  signal, timeLeft, run, used, now = () => Date.now(), pace = paceDefaults, note = async () => {},
  providerOf = (model) => model.provider, fieldsFor = () => ({}), called = () => {}, recover = async () => false,
}) {
  let model = null;
  let settings = {};
  let speed = createSpeed(pace);
  let charsPerToken = pace.charsPerToken;

  /**
   * One call to the model, counted against the run. `optional`: a call the run can do without (a
   * correction): one that does not fit, or fails, leaves the run as it was instead of degrading it.
   * `extra` may be a function of the model's settings, so a call tried again on another model gets
   * that model's.
   *
   * @param {Conversation} conversation
   * @returns {Promise<{ result: import("../provider.mjs").ChatResult, took: number, cached: number | null, read: number, maxTokens: number, model: object } | null>}
   */
  async function ask(conversation, options) {
    const { maxTokens, toolChoice = "auto", extra: asked = null, purpose = "call", optional = false, minTokens = pace.minAnswerTokens } = options;
    const extra = typeof asked === "function" ? asked(settings) : asked ?? settings.extra ?? {};
    const chars = promptChars(conversation);
    const newChars = conversation.last ? Math.max(0, chars - conversation.last.chars) : chars;
    const readTokens = Math.max(1, Math.ceil(newChars / charsPerToken));
    const paced = speed.get();
    const readMs = (readTokens / paced.promptPerSecond) * 1000;
    const writeMsPerToken = 1000 / paced.generatePerSecond;
    const left = timeLeft();
    const needed = readMs * pace.fitMargin + minTokens * writeMsPerToken;
    if (left.ms <= 0 || needed > left.ms) {
      if (!optional) {
        run.degraded = left.binding;
        run.limitReached = true;
      }
      const seconds = (ms) => Math.max(0, Math.round(ms / 1000));
      await note("model", left.binding === "budget"
        ? `Not starting the ${purpose}: it needs about ${seconds(needed)} s of model time (${readTokens} tokens to read at ${paced.promptPerSecond} a second, then a short answer) and ${seconds(left.ms)} s are left today.`
        : `Not starting the ${purpose}: it needs about ${seconds(needed)} s (${readTokens} tokens to read at ${paced.promptPerSecond} a second, then a short answer) and the run has ${seconds(left.ms)} s left.`, optional ? "done" : "failed");
      return null;
    }
    const fitTokens = Math.floor((left.ms - readMs * pace.fitMargin) / writeMsPerToken);
    const tokens = Math.max(minTokens, Math.min(maxTokens, fitTokens));
    const calling = model;
    const { fields = {}, cancelId = null } = fieldsFor(calling) ?? {};
    const provider = providerOf(calling);
    const started = now();
    try {
      const result = readChatResult(await provider.chat({
        model: calling.model, temperature: settings.temperature ?? 0.2, messages: conversation.messages, tools: conversation.tools, toolChoice, maxTokens: tokens, extra: { ...extra, ...fields },
      }, { signal, timeoutMs: Math.max(1_000, left.ms) }));
      const took = now() - started;
      used.modelMs += took;
      used.modelCalls += 1;
      const promptTokens = result.usage?.promptTokens ?? 0;
      const completionTokens = result.usage?.completionTokens ?? 0;
      const cached = result.timings?.cachedTokens ?? result.usage?.cachedTokens ?? null;
      const read = result.timings?.promptTokens ?? (cached !== null ? Math.max(0, promptTokens - cached) : promptTokens);
      used.promptTokens += promptTokens;
      used.completionTokens += completionTokens;
      used.cachedTokens += cached ?? 0;
      used.readTokens += read;
      if (promptTokens >= 100) charsPerToken = Math.min(8, Math.max(2, Math.round(((charsPerToken + chars / promptTokens) / 2) * 100) / 100));
      // The server's own timings when it passes them on; else the clock, when it knows what was read.
      if (result.timings?.promptMs || result.timings?.predictedMs) {
        speed.learn({ readTokens: result.timings.promptTokens ?? 0, readMs: result.timings.promptMs ?? 0, writtenTokens: result.timings.predictedTokens ?? 0, writeMs: result.timings.predictedMs ?? 0, from: "server" });
      } else if (result.firstTokenMs !== null && result.firstTokenMs !== undefined) {
        speed.learn({ readTokens: cached !== null || !conversation.last ? read : 0, readMs: result.firstTokenMs, writtenTokens: Math.max(0, completionTokens - 1), writeMs: Math.max(0, (result.elapsedMs ?? took) - result.firstTokenMs), from: "runner" });
      }
      conversation.last = { chars, promptTokens, completionTokens };
      called(calling);
      return { result, took, cached, read, maxTokens: tokens, model: calling };
    } catch (error) {
      used.modelMs += now() - started;
      // Closing the connection stops a llama-server at its next batch; Unsloth is also asked to stop.
      if (cancelId) void provider.cancel?.(cancelId);
      if (signal?.aborted) throw error;
      // The host has another model that can take the same call (a remote model stopped answering).
      if (await recover(error)) { conversation.last = null; return ask(conversation, options); }
      if (!optional) run.degraded = /timed? ?out|aborted|TimeoutError/i.test(`${error?.name} ${error?.message}`) ? "timeout" : "model-error";
      await note("model", `The model stopped${optional ? ` during the ${purpose}` : ""}: ${String(error?.message ?? error).slice(0, 200)}`, "failed");
      return null;
    }
  }

  return {
    get model() { return model; },
    get settings() { return settings; },
    get speed() { return speed; },
    get charsPerToken() { return charsPerToken; },
    /** About how many tokens a conversation is, at this run's measured characters a token. */
    tokensOf: (conversation) => Math.ceil(promptChars(conversation) / charsPerToken),
    /** How many characters of a tool's output the model can read in `seconds` at its speed. */
    readChars: (seconds = pace.toolReadSeconds) => Math.max(1_200, Math.round(seconds * speed.get().promptPerSecond * charsPerToken)),
    /** Put the run on a model: its settings (temperature, maxTokens, extra) and its pace. */
    use(next, { settings: nextSettings = {}, speed: nextSpeed = speed } = {}) {
      model = next;
      settings = nextSettings ?? {};
      speed = nextSpeed;
    },
    ask,
  };
}
