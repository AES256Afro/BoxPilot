# @boxpilot/harness

An agent harness: one contract for talking to models, providers for a local model server and for
Claude, a router between them, the run loop with its check, the safety around what a model reads
and does, and a command line host. BoxPilot is its first host; the design is
[`docs/HARNESS.md`](../../docs/HARNESS.md).

It imports nothing from BoxPilot: `test/boundary.test.mjs` holds every import to Node's own
modules, the package's own files and the dependencies `package.json` declares.

## The command line

`boxpilot-harness` runs an agent in one folder. In this repository: `npm run harness -- …`.

```sh
# A local model server that speaks the OpenAI chat API (llama-server, Unsloth, Ollama, vLLM)
boxpilot-harness "Which of these notes mention the boiler?" --endpoint http://127.0.0.1:8080

# Claude, the key read from a file; this machine's names go as stand-ins
boxpilot-harness "Tidy todo.md into sections" --route remote --claude-key-file ~/.config/claude.key

# Local first, Claude when the local model fails or the work outgrows its context
boxpilot-harness "Summarise the logs folder" --route auto --endpoint http://127.0.0.1:8080 --context 8192 --claude-key-file key

boxpilot-harness runs                # the latest runs
boxpilot-harness show 3f2a91c0       # one run's trace and answer
boxpilot-harness notes boiler        # what the agent saved for later runs
boxpilot-harness eval cases.json     # cases run on copies of the folder and graded
```

Its tools: `files_list`, `files_read`, `files_write`, `shell_run` (programs from an allowlist,
`--allow` to change it, no shell), `web_fetch` (public pages, with `--web`), `notes_save`,
`notes_search`. Every path stays inside the folder. Each write and command is asked at the
terminal; `--yes` approves all, `--read-only` none. Once a run has read something that looks like
an instruction, it changes nothing and fetches nothing. Runs, traces, notes and each model's
measured speed are kept in `.harness/harness.db`.

`--fake turns.json` replaces the model with scripted turns, for trying it out and for tests:

```json
[
  { "toolCalls": [{ "name": "files_read", "arguments": { "path": "todo.md" } }] },
  { "content": "There are three items [T1]." }
]
```

## Running an agent in your own program

```js
import { createOpenAiClient, createOpenAiCompatibleProvider, createToolbox, defineTool, runTask } from "@boxpilot/harness";

const clock = defineTool({
  name: "clock_now", kind: "read", description: "The time now.",
  run: () => new Date().toISOString(),
});
const local = createOpenAiCompatibleProvider({ client: createOpenAiClient(), endpoint: "http://127.0.0.1:8080" });
const result = await runTask({
  task: "What time is it?",
  system: "Answer from your tools and cite them like [T1].",
  toolbox: createToolbox({ tools: [clock], approve: async (request) => askSomeone(request.summary) }),
  models: { local: { provider: local, model: "qwen" } },
});
// result: { outcome, answer, route, model, usage, taint, citations, ... }
```

- `runTask` is a whole run: the route, the loop, the fallback answer when the model cannot finish.
- `act` is the loop on its own, for a host with its own planner or tools (BoxPilot's runner).
- `createModelSession` paces each call from the model's measured speed, within what the run has
  left, and can move a run to another model.
- `createToolbox` runs a host's own tools: input checked against each schema, output redacted,
  boxed and numbered, a `write` or `operation` asked of `approve`, nothing changed after taint.

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
| Local, any OpenAI-compatible server | `local` | `createOpenAiCompatibleProvider({ client, endpoint, apiKey })`, the client from `createOpenAiClient()` or the host's own |
| Fake, scripted for tests | `local` or `remote` | `createFakeProvider({ script })` |
| Claude, through the official SDK | `remote` | `createAnthropicProvider({ client })` or `({ apiKey })`, from `@boxpilot/harness/anthropic` |

A provider is made with `defineProvider`, which refuses a missing part when the provider is made
rather than on a run's first call. The local client talks only to this machine or the owner's
network (`local-endpoint.mjs`), streams, and bounds everything it reads.

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

## The router

`router.mjs` is plain functions of what the host knows: `startRoute` (where a run starts),
`moveAfterPlan` (when a local run moves to the remote model), `secondOpinion` (when a finished local
answer is worth asking again), `fallsBack` (when a remote failure means going on locally). Each
answer that changes the model carries a reason a person can read.

## Safety

- `guard.mjs`: what a tool returns is data, never instructions. `sanitizeUntrusted` neutralises
  template tokens and wrapper tags as a model would read them; `detectInjection` finds text that
  reads like an instruction; `wrapToolOutput` boxes and numbers it.
- `redaction.mjs`: secrets taken out before a model reads anything: private keys, secret
  assignments and headers, secrets in URLs, secret fields of a structure.
- `stand-ins.mjs`: `createStandIns({ hosts, domains, users })` replaces what identifies a house
  before a conversation leaves for a remote model, and `showResult` turns the answer back.
- `check/verify.mjs`: every claim in an answer held to the tool output it cites, with no model.

## Claude without Claude

`@boxpilot/harness/anthropic/fake` gives the SDK a `fetch` that answers from a function:
`fakeAnthropicFetch(answer)`. `standInClaude(provider)` makes that answer come from any other
provider, so a demo's local stand-in model can play Claude through the real SDK and provider.
