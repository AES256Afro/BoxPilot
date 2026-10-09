import { readFileSync } from "node:fs";
import { createAnthropicClient } from "../src/providers/anthropic.mjs";
import { eventStream, fakeAnthropicFetch } from "../src/providers/anthropic-fake.mjs";

export { eventStream };

/**
 * Claude's side of the wire, for tests: the real SDK client, with a `fetch` that answers from a
 * script instead of the network. Each turn is a Messages API response (sent as the event stream
 * the API streams) or `{ status, type, message }` for an error. Every request is kept, as the SDK
 * sent it: its address, its headers and its body.
 *
 * The fixtures are written to the documented response shape. They are not recordings.
 */

export const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/anthropic/${name}.json`, import.meta.url), "utf8"));

export function fakeClaude(script = []) {
  const fetch = fakeAnthropicFetch((_body, { turn }) => script[turn - 1]);
  return { client: createAnthropicClient({ apiKey: "sk-ant-test-key", fetch, maxRetries: 0 }), requests: fetch.requests };
}
