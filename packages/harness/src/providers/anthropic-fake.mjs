/**
 * Claude's side of the wire, without Claude (M45.3): a `fetch` for the official SDK that answers
 * from a function instead of the network. For tests and demos, so a host can run its whole path to
 * Claude - the SDK, the provider, the gateway - with nothing billed and nothing sent.
 *
 * - `fakeAnthropicFetch(answer)`: `answer(body)` returns a Messages API response (sent as the event
 *   stream the API streams) or `{ status, type, message }` for an error.
 * - `standInClaude(provider)`: an `answer` that asks any harness provider instead, translating the
 *   request to the chat shape and the answer back: a demo's local stand-in model can play Claude.
 */

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

/** A `fetch` for the SDK that answers every request with `answer(body)`, and keeps each request. */
export function fakeAnthropicFetch(answer, { requests = [] } = {}) {
  let turn = 0;
  const fetch = async (url, init = {}) => {
    const body = JSON.parse(String(init.body ?? "null"));
    requests.push({ url: String(url), headers: Object.fromEntries(new Headers(init.headers).entries()), body, redirect: init.redirect ?? null });
    if (init.signal?.aborted) throw init.signal.reason ?? new DOMException("aborted", "AbortError");
    turn += 1;
    const step = await answer(body, { turn });
    if (!step) throw new Error(`The fake Claude has no turn ${turn}`);
    if (step.status) {
      return new Response(JSON.stringify({ type: "error", error: { type: step.type ?? "api_error", message: step.message ?? "error" } }), { status: step.status, headers: { "content-type": "application/json", "request-id": `req_${turn}` } });
    }
    return new Response(eventStream(step), { status: 200, headers: { "content-type": "text/event-stream", "request-id": `req_${turn}` } });
  };
  return Object.assign(fetch, { requests });
}

const textOf = (content) => (typeof content === "string" ? content : (content ?? []).filter((block) => block?.type === "text").map((block) => block.text).join(""));

/** A Messages API request in the chat shape: what a local provider is asked instead. */
export function chatRequestFromAnthropic(body) {
  const messages = [];
  const system = textOf(body.system);
  if (system) messages.push({ role: "system", content: system });
  for (const message of body.messages ?? []) {
    if (message.role === "system") { messages.push({ role: "system", content: textOf(message.content) }); continue; }
    const blocks = typeof message.content === "string" ? [{ type: "text", text: message.content }] : message.content ?? [];
    if (message.role === "assistant") {
      const calls = blocks.filter((block) => block.type === "tool_use").map((block) => ({ id: block.id, type: "function", function: { name: block.name, arguments: JSON.stringify(block.input ?? {}) } }));
      messages.push({ role: "assistant", content: textOf(blocks) || null, ...(calls.length ? { tool_calls: calls } : {}) });
      continue;
    }
    for (const block of blocks.filter((entry) => entry.type === "tool_result")) messages.push({ role: "tool", tool_call_id: block.tool_use_id, content: typeof block.content === "string" ? block.content : textOf(block.content) });
    const words = textOf(blocks);
    if (words) messages.push({ role: "user", content: words });
  }
  const schema = body.output_config?.format?.type === "json_schema" ? body.output_config.format.schema : null;
  // The format's name is not sent to Claude; a planner's understanding is known by its fields.
  const name = schema?.properties?.goal && schema?.properties?.plan ? "understanding" : "answer";
  return {
    model: body.model,
    messages,
    tools: (body.tools ?? []).map((tool) => ({ type: "function", function: { name: tool.name, description: tool.description, parameters: tool.input_schema } })),
    toolChoice: body.tool_choice?.type === "none" ? "none" : "auto",
    maxTokens: body.max_tokens,
    ...(schema ? { extra: { response_format: { type: "json_schema", json_schema: { name, strict: true, schema } } } } : {}),
  };
}

const stopReasons = { tool_calls: "tool_use", length: "max_tokens", stop: "end_turn" };

/** A chat-shaped answer as a Messages API response from `model`. */
export function anthropicMessageFrom(result, model, { id = `msg_fake_${Date.now().toString(36)}` } = {}) {
  const calls = result.toolCalls ?? [];
  const input = (text) => { try { return JSON.parse(text || "{}"); } catch { return {}; } };
  return {
    id,
    type: "message",
    role: "assistant",
    model,
    content: [
      ...(result.content ? [{ type: "text", text: result.content }] : []),
      ...calls.map((call) => ({ type: "tool_use", id: call.id?.startsWith("toolu_") ? call.id : `toolu_${String(call.id ?? "").replace(/[^A-Za-z0-9_-]/g, "")}`, name: call.name, input: input(call.arguments) })),
    ],
    stop_reason: calls.length ? "tool_use" : stopReasons[result.reason] ?? "end_turn",
    stop_details: null,
    usage: { input_tokens: result.usage?.promptTokens ?? 0, output_tokens: result.usage?.completionTokens ?? 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
  };
}

/** An `answer` for fakeAnthropicFetch that asks a harness provider in Claude's place. */
export function standInClaude(provider) {
  return async (body) => anthropicMessageFrom(await provider.chat(chatRequestFromAnthropic(body)), body.model);
}
