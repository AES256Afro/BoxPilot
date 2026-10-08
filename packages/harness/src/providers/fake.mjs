/**
 * A scripted provider for tests (M45.1). Each call takes the next turn from the script, or asks a
 * function for one; every request is kept so a test can read what the model was sent. It never
 * reaches a network and never takes time.
 *
 * A turn is a partial ChatResult: `{ content, toolCalls, usage, providerBlocks, ... }`, or an
 * Error, which the call throws.
 */
import { defineProvider } from "../provider.mjs";

/**
 * @param {{
 *   script?: Array<Partial<import("../provider.mjs").ChatResult> | Error>
 *     | ((request: import("../provider.mjs").ChatRequest, index: number) => Partial<import("../provider.mjs").ChatResult> | Error),
 *   id?: string,
 *   kind?: "local" | "remote",
 * }} options
 */
export function createFakeProvider({ script = [], id = "fake", kind = "local" } = {}) {
  const calls = [];
  const provider = defineProvider({
    id,
    kind,
    async chat(request, options = {}) {
      if (options.signal?.aborted) throw Object.assign(new Error("The run was stopped"), { name: "AbortError" });
      const index = calls.length;
      calls.push(structuredClone(request));
      const turn = typeof script === "function" ? script(request, index) : script[index];
      if (turn === undefined) throw new Error(`The fake provider has no turn ${index + 1}`);
      if (turn instanceof Error) throw turn;
      return {
        content: "",
        toolCalls: [],
        reason: (turn.toolCalls?.length ?? 0) > 0 ? "tool_calls" : "stop",
        usage: { promptTokens: 0, completionTokens: 0 },
        timings: null,
        firstTokenMs: 0,
        elapsedMs: 0,
        ...turn,
      };
    },
  });
  return { provider, calls };
}
