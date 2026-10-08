# @boxpilot/harness

An agent harness: one contract for talking to models, providers for a local model server and for
Claude, and (as M45 goes on) the router, the checks and the evaluation runner around them. BoxPilot
is its first host; the design is [`docs/HARNESS.md`](../../docs/HARNESS.md).

It imports nothing from BoxPilot: `test/boundary.test.mjs` holds every import to Node's own
modules, the package's own files and the dependencies `package.json` declares.

## The model contract

A request is the chat shape local model servers already speak:

```js
{ model, messages, tools, toolChoice: "auto" | "none", maxTokens, temperature, effort, taskBudget, extra }
```

`effort` and `taskBudget` are for a provider that thinks (Claude); the local provider ignores them,
and Claude ignores `temperature`.

Messages are `system`, `user`, `assistant` (with `tool_calls`) and `tool`; tools are function
schemas. An assistant message may also carry `providerBlocks`, what one provider needs back on its
next call (Claude's thinking blocks); `messagesFor` drops them for any other provider or model.

Every provider answers in one shape, and `readChatResult` holds it to that shape and its limits:

```js
{ content, toolCalls: [{ id, name, arguments }], reason, usage, timings, firstTokenMs, elapsedMs,
  costUsd, providerBlocks, refusal }
```

## Providers

| Provider | Kind | Made with |
|---|---|---|
| Local, any OpenAI-compatible server | `local` | `createOpenAiCompatibleProvider({ client, endpoint, apiKey })`, wrapping a chat client the host made |
| Fake, scripted for tests | `local` or `remote` | `createFakeProvider({ script })` |
| Claude, through the official SDK | `remote` | `createAnthropicProvider({ client })` or `({ apiKey })`, from `@boxpilot/harness/anthropic` |

A provider is made with `defineProvider`, which refuses a missing part when the provider is made
rather than on a run's first call.

## Claude

Imported on its own, so a host that never calls Claude never loads the SDK:

```js
import { createAnthropicClient, createAnthropicProvider } from "@boxpilot/harness/anthropic";
const claude = createAnthropicProvider({ client: createAnthropicClient({ apiKey }), effort: "low" });
```

It translates the chat shape to the Messages API and back: thinking blocks kept in
`providerBlocks` and sent back unchanged, tools strict where their schema allows it, a refusal
returned as `reason: "refusal"` with its category, a turn cut off at its token limit returned with
no tool calls, and each answer's cost priced from `anthropic-prices.mjs`. The key, the address and
the log level are never read from the environment.

The tests run the real SDK against a scripted `fetch` (`test/anthropic-wire.mjs`). The response
fixtures follow the documented shape; they are not recordings.
