# The agent harness (M45, ADR-013)

The owner asked, 2026-10-08: build an AI harness. It should work well with BoxPilot first and be
usable on its own later. Agents should carry out multi-step jobs on the server through BoxPilot's
approval tiers, not only propose them, and run on the local model or on Claude, routed per task.

This page is the design. ADR-013 records the decisions and M45 in `docs/ROADMAP-V2.md` tracks the
work. Where this page and the code disagree, the code and its tests win, and this page is fixed.

## What exists (M37 to M44)

BoxPilot already has most of a harness. It does not have a name, it is woven into
`server/agents/`, and it has two walls this work takes down on purpose.

- **Two processes (ADR-005).** The web service holds the agents, their store and every tool. A
  capped runner (`boxpilot-agents.service`, 400% CPU, 8 GB, no network but loopback) runs the model
  and the loop, and claims queued runs over a token-authenticated loopback API.
- **A loop:** plan (`intent.mjs`, a schema-bound plan with a confidence) → act (one growing
  conversation, 3 tool calls a step, 12 steps) → check (`verify.mjs`, every claim held to the tool
  output it cites, one correction) → finish. Time per call comes from measured tokens a second.
- **25 tools** (`tool-catalog.mjs`): reads mapped onto read-only registry operations under ADR-003,
  exact tools (calculator, units, regex), and four writes that never touch the host: notes, a card,
  a notification, a hand-off. Strict input checks, a 35 s timeout, output boxed and numbered.
- **Safety:** prompt-injection defence (`guard.mjs`), taint that follows suspicious text through
  hand-offs, notes and findings, budgets and quiet hours (`budget.mjs`), per-run limits, one run at
  a time, a kill switch.
- **Memory:** notes, episodes, pinned documents, hybrid vector and keyword recall, shared findings
  (ADR-012).
- **Evaluation:** deterministic grading against live facts, a nightly run, an accuracy history
  that flags a drop.
- **Teams:** a supervisor hands sub-tasks to specialists, up to three deep.

The two walls:

1. **Local only.** No path reaches a model off the box: `local-endpoint.mjs`, the runner's
   `loopbackOnly`, the `external` driver's loopback check and the runner unit's
   `IPAddressDeny=any` all refuse it (ADR-005 §9).
2. **Propose, never act.** An agent's plan becomes a card. A person creates every job through the
   approval dialog. No code path lets an agent create or approve one.

## Goals

1. **Claude where it helps, the local model everywhere else.** A run uses one model, chosen by
   policy: privacy, difficulty, budget and whether Claude can be reached at all.
2. **Agents that do the work.** An agent can carry out a multi-step job, operation by operation,
   inside the same risk tiers a person meets, under grants the owner gives per operation.
3. **A core that stands on its own.** The loop, the model providers, the router, the safety
   machinery and the evaluation runner live in `packages/harness/` and import nothing from
   BoxPilot. BoxPilot is the first host. A small CLI is the second, and proves the boundary.
4. **Nothing gets worse.** Every M37 to M44 test passes at every step, and the local model's
   evaluation stays at 6/6.

Out of scope: training or fine-tuning models, agents writing BoxPilot's own code, and any change to
how a person approves a job.

## The shape

```
packages/harness/            no imports from server/ or src/ (a test enforces it)
  core/       messages, tools, the run loop, limits, traces
  providers/  openai-compatible (local), anthropic (Claude, official SDK), fake (tests)
  router/     which provider runs a task, and when to ask the other one
  safety/     untrusted wrapping, injection detection, taint, redaction, pseudonyms
  check/      claims held to their evidence (from verify.mjs)
  eval/       datasets, deterministic graders, route comparison, recorded fixtures
  host.mjs    the interface a host implements
  cli/        the standalone host (M45.8)

server/agents/               BoxPilot's host: tools, approvals, store, memory, audit
server/model-gateway/        the one process that holds the Claude key and reaches the API
deploy/boxpilot-model-gateway.service
```

### The host interface

A host gives the harness what only it can know. BoxPilot's implementation wraps what exists.

| Part | BoxPilot's implementation |
|---|---|
| `tools` | The catalog, plus registry operations the owner granted (below) |
| `approvals` | `jobs.createOperationJob` / `approveAndStart`, push approvals, the tiers |
| `store` | The agents tables in BoxPilot's SQLite |
| `memory` | `memory.mjs`, notes, episodes, findings |
| `audit` | BoxPilot's audit log and the run trace |
| `policy` | Per-agent settings: route, data policy, grants, budgets |
| `clock` | Injected, as every BoxPilot test requires |

### Messages and tools

Messages use the chat shape every local model server already speaks: system, user, assistant (with
`tool_calls`) and tool messages, tools as function schemas. A provider that speaks something else
translates both ways. One addition: an assistant message may carry `providerBlocks`, what the
provider sent that the chat shape has no room for. Claude's thinking blocks must go back exactly as
they came, and only to the model that wrote them, so a conversation never changes model halfway
(below); every other provider gets the message without them.

A tool declares: an id, plain-text description, a strict parameter schema, its kind (`read`,
`write`, or `operation` with the registry's risk tier), and `run`. Reads may run in parallel; an
operation never runs except through the host's approvals.

### Providers

- **openai-compatible:** the existing client (`server/assistant/model-client.mjs`) moved behind the
  interface. Local, loopback only for agents, unchanged behaviour, still streamed, still cache
  friendly (ADR-006).
- **anthropic:** the official `@anthropic-ai/sdk`, never an OpenAI-compatible shim.
  - Model: the owner's choice in Settings. The default is Claude Opus 5.5 (`claude-opus-5-5`);
    Sonnet 5.5 and Haiku 5.5 are offered with their prices, and the choice is the owner's.
  - Thinking: adaptive, the model's default. Depth through `output_config.effort`: `low` for
    routine and scheduled runs, `medium` for questions, `high` for jobs that act.
  - Tools: `strict: true` on every schema that can take it without changing what it allows
    (`strictSchema`: type lists become `anyOf`, length and number limits move into the description;
    an object left open stays as it is, not strict), `tool_choice: auto` or `none` (forced tool
    choice is refused on current models), `stop_reason` checked for `refusal` and `max_tokens`
    before any tool call runs. A call the loop chose not to run (it keeps three a step) is answered
    "not run", so Claude's own turn goes back unchanged and its thinking stays valid.
  - Refusals: server-side fallbacks on (`fallbacks: "default"`, beta
    `server-side-fallback-2026-07-01`); a refusal that survives them ends the run as declined, never
    retried on the local model.
  - Prompt caching: the system message and tool list are stable and cached; per-run facts go after
    the breakpoint. Conversations are append-only.
  - Long jobs: task budgets (beta) so the model paces itself; one model for the whole job.
  - Cost: every response's usage (input, output, cache write, cache read) priced from a table in
    one file, per attempt when a fallback model finished the answer, recorded per run, summed per
    agent and per month.
  - The client: the key, the address and the log level come from the host, never the environment
    (the SDK would read `ANTHROPIC_API_KEY`, `ANTHROPIC_BASE_URL` and `ANTHROPIC_LOG`), and a
    redirect is an error. Failures carry a code the router acts on (`auth`, `rate-limited`,
    `overloaded`, `timeout`, `unreachable`).
- **fake:** deterministic, scripted turns, for every test. CI never calls a real model.

### The gateway: where the key lives

The runner keeps its sandbox: no network but loopback. The web service keeps holding no secrets. A
third, small process holds the key and nothing else.

- `boxpilot-model-gateway.service` (`server/model-gateway/`): its own user in the web service's
  group, no capabilities, `ProtectSystem=strict`, kept out of the web service's data, the helper's
  credential store and every other root secret (`InaccessiblePaths`). The key is handed in by
  systemd `LoadCredential` from `/etc/boxpilot/secrets/anthropic-api-key` (root, 0600); the unit runs
  only while that file exists. It listens on `/run/boxpilot-model-gateway/gateway.sock` (0660, the
  web service's group), one JSON line asked and one answered: `status`, `check` and `chat`.
- It sends to one host, `api.anthropic.com`, and refuses redirects. It calls only the offered models
  (Opus 5.5, Sonnet 5.5, Haiku 5.5), at most four at once, and logs nothing that was asked or
  answered.
- It enforces the monthly dollar cap a second time, from its own ledger, so a bug in the web service
  cannot spend past it. Before a call it writes down the most the call could cost (every prompt
  token at the dearer input rate, every token it may write, a fallback model's share); after, what
  it did cost. A gateway stopped partway reads the month high, never low.
- The owner sets the key with `agents.cloud.connect` (high, owner, password, the cap typed as
  "$20 a month"), a root task that writes the key and the cap, starts the gateway, and proves the key
  by reading one model's details, which costs nothing; a key Claude refuses is not kept, and the one
  before comes back. `agents.cloud.cap` (medium) changes the cap, read on the next call;
  `agents.cloud.disconnect` (medium) stops the gateway and deletes the key. An Anthropic key turns
  up redacted anywhere else (`server/redaction.mjs`).
- A model call goes: runner → web service (`POST /api/v1/agent-runner/runs/:id/model`, lease
  checked) → policy, budget and the data policy applied → gateway → Claude → the same way back.

### What may leave the box: the data policy

Per agent, chosen by the owner, shown in the agent's settings and in every Claude run's trace:

- **The local model** (every agent's default, and every agent made before M45): nothing leaves the
  box.
- **Claude, names replaced** (the default once an agent is put on Claude): secrets and credentials
  are removed as today, and names that identify the house are replaced with stable stand-ins for the
  run (`packages/harness/src/safety/stand-ins.mjs`): this server's host name and accounts
  (`host-1`, `user-1`), its own domain and any tailnet, `.local`, `.lan`, `.home.arpa` or
  `.internal` name (`site-1.example`), private addresses (from the documentation ranges,
  `192.0.2.x`), and MAC addresses (locally administered, `02:00:00:00:00:01`). Stand-ins come from
  ranges no real house uses, so turning them back cannot mistake a real value for one. The map
  stays on the box; the answer and the tool calls are turned back before anything reads them.
- **Claude, as it is:** what the run reads goes unchanged, still without secrets.

The owner's documents (the library, connector imports and Zulip files) are never sent unless the
agent's settings say so by name ("Claude may read your documents"). A run a viewer started goes to
Claude only if the agent allows Claude for viewers; otherwise it runs on the local model and its
trace says why. Every run on Claude says so in its trace: the model, the effort, the data policy,
whether documents may go, and at the end what it cost and how many names were replaced.

### The router

Where a run starts and when it changes model, decided by plain rules in
`packages/harness/src/router.mjs` and written into the trace with the reason:

- **Agent route:** `local`, `claude` or `auto`. New agents start `auto` once Claude is connected,
  `local` before. Agents that already exist keep their route.
- **Auto** plans on the local model, then moves to Claude for the acting when the local model could
  not start or stopped while it planned, the conversation is past 80% of the local context (checked
  again before each step), the plan could not be read, the plan's confidence is under 0.5, or the
  plan proposes a change. Otherwise the run stays local. What an auto run reads is held to Claude's
  rules from the start (documents stay home unless named), since any of its runs may move.
- **Second opinion:** a run of an auto agent that stayed local and ended cut short, or with part of
  its answer not matching its tools, is asked again on Claude, once, as a run of its own that names
  the first (`trigger.secondOpinionOf`), when Claude may take it and the agent has runs left today.
  Not for a run that read something that looked like an instruction.
- **Fallback:** a run on Claude whose call fails because Claude is not there (the gateway down, not
  connected, the cap spent, Anthropic unreachable, overloaded or rate-limiting, the key refused)
  goes on with the local model from the same conversation, once. For a minute after the gateway
  stops answering, new runs are not given Claude, so none waits on it in turn.
- **Always local** when Claude is not connected, a viewer asked and the agent keeps viewers' words
  on the box, or the month's cap is spent.

The plan and the acting are separate conversations, so moving between them throws nothing away.
Moving partway through acting (the context rule) carries the local model's conversation to Claude,
which reads it fresh; falling back drops Claude's thinking blocks, which only Claude could read.
The run records `usage.route` (`claude`, or `both` when the local model answered part of it), the
reason it moved, the model and the cost; the run view shows them.

### Agents that act: grants and tiers

ADR-013 replaces "agents propose, never act" with "agents act only through the approval tiers,
under grants". The person a job runs for stays the agent's maker, with the agent named in the audit
("Server Keeper, for alex").

Per agent, per operation in its allowlist, the owner grants one of:

| Grant | What happens | Allowed for |
|---|---|---|
| **Propose** | A card, as today | Every tier |
| **Ask** | The agent stages the job; a person approves it at its tier (push notification); the agent waits, then carries on | Low and medium |
| **Run** | The job runs under the maker's delegated consent, as a schedule or flow does (ADR-002) | Low only |

Fences that no grant opens:

- **High risk never runs for an agent.** It is always a card: a person, a password, the tag typed.
- **Tainted runs only propose.** A run that read something that looked like an instruction stages
  nothing, whatever its grants, and the owner is told.
- **Only the maker's authority, only the maker's runs.** A run a viewer started never acts; a
  run started from Zulip acts only for a person mapped to an owner or operator.
- **The approval mode wins.** With "always ask for the password", every grant is at most Ask.
- **Limits:** at most 3 operations a run, 20 a day per agent, an hour's wait on an approval before
  the job is dropped and the run ends. The kill switch cancels everything staged.
- **Before acting, live facts are read again** (ADR-012's rule), and the operation's preview is
  shown to the model. **After acting, the agent checks** the effect with a read and says what it
  found. A failed step stops the job and is reported; nothing is retried by itself.

### Jobs that take more than one run

A job is a plan of steps (read, operation, check) kept in the store with a checkpoint after each,
so it survives a restart and can wait hours on an approval. At most 10 steps and 24 hours. It runs
on one model from start to end, Claude by default with a task budget, because a long plan is where
the local model is weakest. The trace shows each step, its job and its outcome.

### Evaluation

- **Routes compared:** the same question set on the local model and on Claude, nightly when the
  owner allows the cost: accuracy, seconds and dollars side by side on the agent's page.
- **Acting evaluated in the demo world:** given a task, did the agent stage the right operation
  with the right parameters, and never one it was not granted? Graded without a model.
- **A red-team set:** instructions hidden in logs, app names, notes and findings. Pass means
  nothing staged and the owner warned, on both routes.
- **CI** replays recorded Claude responses (fixtures) and the fake model; it never calls a real
  model and never spends money.

### Standalone

`packages/harness` ships a CLI host (M45.8): a working folder, a small toolset (read and write
files inside it, an allowlisted shell, fetch a URL), approvals asked in the terminal, a SQLite file
for runs and memory, the same router, providers, checks and evaluation runner. When its interface
has held still through two BoxPilot releases it is published as its own npm package at 0.x;
until then it is versioned with BoxPilot.

## Milestones

Each is its own pull request, merged only with `npm run check` green. Every one keeps the local
model's evaluation at 6/6 and every existing agent test passing.

| | What | Done when |
|---|---|---|
| M45.1 | The core package: messages, tool contract, provider interface, the local provider moved behind it, the fake provider, the boundary test | The runner calls models through the core; agent tests unchanged |
| M45.2 | The Claude provider: translation both ways, strict tools, caching, refusal handling, cost meter, recorded fixtures | Contract tests pass for both real providers on the same scripted conversations |
| M45.3 | The gateway, `agents.cloud.connect`, the monthly cap, the data policy with stand-ins, Settings | A run on Claude end to end in the demo with a fake upstream; no key ever in the web process |
| M45.4 | The router: per-agent route, auto rules, second opinion, offline fallback, route and cost in the trace | Router decisions tested for every rule; trace shows route, reason and cost |
| M45.5 | Acting: grants, the fences, staging through `createOperationJob`, waiting on approval, check after acting | Granted low runs, Ask waits, high never runs, tainted only proposes, all tested |
| M45.6 | Jobs: durable multi-step plans, checkpoints, resume after restart, task budgets | A three-step job survives a restart in the middle and finishes |
| M45.7 | Evaluation: route comparison, acting tasks, the red-team set, CI on fixtures | Red-team set stages nothing on both routes |
| M45.8 | Standalone: the loop, check and safety moved fully into the core; the CLI host; docs | The CLI runs a task with the fake and local providers, without BoxPilot |

## Risks and how they are held

| Risk | Hold |
|---|---|
| A bill the owner did not expect | A monthly cap in two places (web service and gateway), 80% warning, runs fall back to local at the cap |
| Private data leaving the house | Never by default for old agents, Redacted with stand-ins by default for new ones, shown in every trace |
| An agent doing harm | Grants per operation, high risk never, taint only proposes, limits per run and day, kill switch, every job in the audit |
| The key leaking | Only the gateway holds it, by `LoadCredential`, root-owned file, one destination host |
| Claude unreachable | Router falls back to local: mid-run on the call that failed, and before a run starts for a minute after the gateway stops answering |
| Local agents getting worse during the refactor | Every step keeps the local evaluation at 6/6 and all agent tests green |
