import { readFileSync } from "node:fs";
import { createAnthropicClient } from "../src/providers/anthropic.mjs";

/**
 * Claude's side of the wire, for tests: the real SDK client, with a `fetch` that answers from a
 * script instead of the network. Each turn is a Messages API response (sent as the event stream
 * the API streams) or `{ status, type, message }` for an error. Every request is kept, as the SDK
 * sent it: its address, its headers and its body.
 *
 * The fixtures are written to the documented response shape. They are not recordings.
 */

export const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/anthropic/${name}.json`, import.meta.url), "utf8"));

/** A Messages API response as the event stream the API sends for it. */
export function eventStream(message) {
  const events = [];
  const send = (type, data = {}) => events.push(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  const { content = [], stop_reason: stopReason, stop_details: stopDetails = null, usage = {}, ...rest } = message;
  send("message_start", {
    message: { ...rest, content: [], stop_reason: null, stop_sequence: null, stop_details: null, usage: { input_tokens: usage.input_tokens ?? 0, output_tokens: 1, cache_creation_input_tokens: usage.cache_creation_input_tokens ?? 0, cache_read_input_tokens: usage.cache_read_input_tokens ?? 0 } },
  });
  content.forEach((block, index) => {
    if (block.type === "text") {
      send("content_block_start", { index, content_block: { type: "text", text: "" } });
      send("content_block_delta", { index, delta: { type: "text_delta", text: block.text } });
    } else if (block.type === "thinking") {
      send("content_block_start", { index, content_block: { type: "thinking", thinking: "", signature: "" } });
      if (block.thinking) send("content_block_delta", { index, delta: { type: "thinking_delta", thinking: block.thinking } });
      send("content_block_delta", { index, delta: { type: "signature_delta", signature: block.signature } });
    } else if (block.type === "tool_use") {
      send("content_block_start", { index, content_block: { type: "tool_use", id: block.id, name: block.name, input: {} } });
      send("content_block_delta", { index, delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input) } });
    } else {
      send("content_block_start", { index, content_block: block });
    }
    send("content_block_stop", { index });
  });
  send("message_delta", { delta: { stop_reason: stopReason, stop_sequence: null, stop_details: stopDetails }, usage: { output_tokens: usage.output_tokens ?? 0, ...(usage.iterations ? { iterations: usage.iterations } : {}) } });
  send("message_stop");
  return events.join("");
}

export function fakeClaude(script = []) {
  const requests = [];
  let turn = 0;
  const fetch = async (url, init = {}) => {
    requests.push({ url: String(url), headers: Object.fromEntries(new Headers(init.headers).entries()), body: JSON.parse(String(init.body ?? "null")), redirect: init.redirect ?? null });
    if (init.signal?.aborted) throw init.signal.reason ?? new DOMException("aborted", "AbortError");
    const step = script[turn];
    turn += 1;
    if (!step) throw new Error(`The fake Claude has no turn ${turn}`);
    if (step.status) {
      return new Response(JSON.stringify({ type: "error", error: { type: step.type ?? "api_error", message: step.message ?? "error" } }), { status: step.status, headers: { "content-type": "application/json", "request-id": `req_${turn}` } });
    }
    return new Response(eventStream(step), { status: 200, headers: { "content-type": "text/event-stream", "request-id": `req_${turn}` } });
  };
  return { client: createAnthropicClient({ apiKey: "sk-ant-test-key", fetch, maxRetries: 0 }), requests };
}
