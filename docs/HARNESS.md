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

The harness has its own message format: a role, then blocks (text, tool call, tool result) plus,
on assistant turns, the provider's own blocks kept untouched. Each provider translates both ways.
Claude's thinking blocks must go back exactly as they came, and only to the model that wrote them,
so a conversation never changes model halfway (below).

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
  - Tools: `strict: true` on every schema, `tool_choice: auto` (forced tool choice is refused on
    current models), inputs parsed as JSON and checked against the schema before anything runs,
    `stop_reason` checked for `refusal` and `max_tokens` before any tool call runs.
  - Refusals: server-side fallbacks on (`fallbacks: "default"`, beta
    `server-side-fallback-2026-07-01`); a refusal that survives them ends the run as declined, never
    retried on the local model.
  - Prompt caching: the system message and tool list are stable and cached; per-run facts go after
    the breakpoint. Conversations are append-only.
  - Long jobs: task budgets (beta) so the model paces itself; one model for the whole job.
  - Cost: every response's usage (input, output, cache write, cache read) priced from a table in
    one file, recorded per run, summed per agent and per month.
- **fake:** deterministic, scripted turns, for every test. CI never calls a real model.

### The gateway: where the key lives

The runner keeps its sandbox: no network but loopback. The web service keeps holding no secrets. A
third, small process holds the key and nothing else.

- `boxpilot-model-gateway.service`: its own user, no capabilities, `ProtectSystem=strict`, the key
  handed in by systemd `LoadCredential` from a root-owned 0600 file, listening on a Unix socket only
  the web service's user may open.
- It sends to one host, `api.anthropic.com`, and refuses redirects. It enforces the monthly dollar
  cap a second time, so a bug in the web service cannot spend past it.
- The owner sets the key with `agents.cloud.connect` (high, owner, password, typed confirmation),
  which writes the file and restarts the gateway; `agents.cloud.disconnect` (medium) removes it.
- A model call goes: runner → web service (`POST /api/v1/agent-runner/runs/:id/model`, lease
  checked) → policy, budget and the data policy applied → gateway → Claude → the same way back.

### What may leave the box: the data policy

Per agent, chosen by the owner, shown in the agent's settings and in every Claude run's trace:

- **Never** (the default for an agent made before M45): the agent runs on the local model only.
- **Redacted** (the default once the owner connects Claude): secrets and credentials are removed
  as today, and names that identify the house (hostnames, addresses, MAC addresses, user names,
  paths under home folders, app domains) are replaced with stable stand-ins for the run
  (`host-1`, `10.0.0.x`, `user-1`). The map stays on the box; the answer is translated back before
  anyone reads it.
- **As is:** the tool output goes unchanged, still without secrets.

Owner documents, connector imports and Zulip files are never sent unless the agent's settings say
so by name. A run a viewer started goes to Claude only if the agent allows Claude for viewers.

### The router

One model per run, chosen before the run starts, recorded in the trace with the reason:

- **Agent route:** `local`, `claude` or `auto`. New agents start `auto` once Claude is connected,
  `local` before.
- **Auto** picks Claude when the planner's confidence is under 0.5, when the run will act (a job
  with operations), or when the question needs more than the local context holds. Otherwise local.
- **Second opinion:** a local run whose check ended unsure, mismatched or degraded is run again, from
  the start, on Claude, if the policy and budget allow. The trace shows both runs.
- **Always local** when the data policy is Never, Claude is not connected, the gateway does not
  answer, or the month's budget is spent. A run never waits on an unreachable model.

Per run, not per turn: Claude's caches and thinking blocks belong to one model and one conversation,
and switching mid-conversation would throw both away.

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
| Claude unreachable | Router falls back to local before the run starts; a run never waits on it |
| Local agents getting worse during the refactor | Every step keeps the local evaluation at 6/6 and all agent tests green |
