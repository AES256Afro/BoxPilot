# @boxpilot/harness

An agent harness: one contract for talking to models, providers for a local model server and for
Claude, and (as M45 goes on) the router, the checks and the evaluation runner around them. BoxPilot
is its first host; the design is [`docs/HARNESS.md`](../../docs/HARNESS.md).

It imports nothing from BoxPilot: `test/boundary.test.mjs` holds every import to Node's own
modules, the package's own files and the dependencies `package.json` declares.

## The model contract

A request is the chat shape local model servers already speak:

```js
{ model, messages, tools, toolChoice: "auto" | "none", maxTokens, temperature, extra }
```

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
| Claude | `remote` | M45.2 |

A provider is made with `defineProvider`, which refuses a missing part when the provider is made
rather than on a run's first call.
