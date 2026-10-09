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

Out of scope: training or fine-tuning models on the box (M46 collects the owner's approvals as
examples the planner is shown, and exports them as training data for a GPU machine elsewhere;
ADR-014), agents writing BoxPilot's own code, and any change to how a person approves a job.

## The shape

```
packages/harness/src/        no imports from server/ or src/ (a test enforces it)
  messages.mjs, provider.mjs, schema.mjs   the chat shape, the provider contract, strict schemas
  core/       the run loop: act then check (loop.mjs), the model session that paces each call
              (session.mjs, pace.mjs), a host's own tools (tools.mjs), a whole run (run.mjs),
              which examples a model is shown (examples.mjs, M46)
  providers/  openai-compatible and its client (local), anthropic (Claude, official SDK), fake
  router.mjs  which model runs a task, and when to move
  safety/     untrusted wrapping and injection detection (guard.mjs), redaction, stand-ins
  check/      claims held to their evidence (verify.mjs), citations
  cli/        the standalone host (M45.8)

server/agents/               BoxPilot's host: planner, tools, grants, jobs, store, memory, audit,
                             the evaluation against BoxPilot's world
server/model-gateway/        the one process that holds the Claude key and reaches the API
deploy/boxpilot-model-gateway.service
```

As built (M45.8): the host interface is the options of `runTask` and `act` rather than a file of
its own. BoxPilot's runner (`server/agents/runner.mjs`) builds its runs from `createModelSession`
and `act`, with its own planner and its tools reached over the web API; the CLI uses `runTask`
with tools in the same process (`createToolbox`). The planner stays BoxPilot's (it names BoxPilot's
tools), and so does taint that follows text through notes, hand-offs and findings, which are
BoxPilot's memory. BoxPilot's evaluation, acting grader and red-team set grade against BoxPilot's
world and stay in `server/agents/`; the CLI has a small evaluation runner of its own.

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
and on the job ("Server Keeper asked for this in its run …").

Per agent, per operation in its allowlist, the owner grants one of (Build tab → Data and tools):

| Grant | What happens | Allowed for |
|---|---|---|
| **Propose** | A card, as before (the default) | Every tier |
| **Ask** | The agent stages the job; a person approves it at its tier (push notification); the agent's follow-up run reads how it went | Low and medium |
| **Run** | The job starts at once under the maker's delegated consent, as a schedule or flow does (ADR-002); a follow-up run reads how it went | Low only |

The rules are `server/agents/grants.mjs`; the tool is `operations.run`, offered only to an agent
with a grant, its operations listed by name. The run that acts ends there: when every job it staged
has ended, a follow-up run (`kind: "continue"`) reads what became of each as tool output, checks
the effect with a read of its own, and answers. A follow-up acts no further.

Fences that no grant opens:

- **High risk never runs for an agent.** It is always a card: a person, a password, the tag typed.
  A job whose parameters raise it to high (an app whose manifest is high risk) is withdrawn.
- **Tainted runs only propose.** A run that read something that looked like an instruction stages
  nothing, whatever its grants, and the owner is told.
- **Only the maker's authority, only the maker's runs.** A run a viewer started never acts; a
  run started from Zulip acts only for a person mapped to an owner or operator. A maker who lost
  the operator role stops being obeyed. Evaluations, learning runs, hand-offs, follow-ups and webhook
  runs never act (a webhook's caller chooses when, never what), and a run that acted gets no second
  opinion.
- **The approval mode wins.** With "always ask for the password", every grant is at most Ask; so is
  a job that asks for typed confirmation.
- **Never granted:** BoxPilot's own plumbing, reads, anything that reveals or takes a secret, and
  anything that changes how agents run (`agents.*`). Only the owner gives or raises a grant; anyone
  who may edit the agent may lower or remove one. A definition file never carries grants.
- **Limits:** at most 3 operations a run, 20 a day per agent, an hour's wait on an approval before
  the job is dropped. The kill switch withdraws everything staged.
- **Trusted words that read like an instruction** (the owner's own documents, its own notes) do not
  mark a run, which the owner's runbook would earn every time, but a run that read them carries out
  nothing (M45.7), and its view says why.
- **Read first.** A run carries out nothing until it has read the server with one of its tools
  (ADR-012's rule); the tool's answer says what was staged, at what tier. **After acting, the
  follow-up checks** the effect with a read and says what it found. A failed job is reported;
  nothing is retried by itself.

### Plans that take more than one run

An agent with leave to carry out operations may also make a plan (`operations.plan`): up to 10
steps, each an operation it has leave for or a check to make before going on. The plan is kept in
the agents store (`agent_plans`) with a checkpoint after each step, and BoxPilot carries it out, not
the run that made it: that run ends at once, as one that acts does.

- **An operation step** is staged through the same fences as `operations.run`, checked again at
  that moment against the agent's current grants, its maker and the day's limit. Run starts it; Ask
  waits for a person, as long as the plan's day lasts rather than an hour. The plan goes on when
  the job ends, and stops if it failed or was not approved.
- **A check step** is a run of the agent (a follow-up, as the person who asked) shown the plan so
  far as tool output and told what to check. It reads with its tools and answers `passed` or
  `failed` with what it found. A check that read something that looked like an instruction stops the
  plan. One that never answered (a restart, the runner gone) is made again, once.
- **The end:** done, stopped at the first failing step, out of time after 24 hours, or stopped by a
  person (the run view's "Stop the plan") or the kill switch. Whatever still waits on a person is
  withdrawn. Unless a person or the kill switch stopped it, a report run reads every step and
  answers the original request.
- **After a restart** it goes on from its last checkpoint; nothing about it lives only in memory.
  While agents are paused it waits where it is.
- **The model.** An auto agent's checks and report run on Claude with a task budget (40,000
  tokens), since a long plan is where the local model is weakest; a local agent's stay local.

One open plan per agent. The run view shows the plan, each step's state and what it found; each
operation's job is in Activity like any other.

### Examples: what the planner is shown (M46, ADR-014)

A host keeps an example book: requests and the plans that served them, kept when a person approved
the work. BoxPilot's is `agent_examples` (`server/agents/store.mjs`), written when a card is staged,
an answer gets a thumbs up, an answer is kept as a finding or an evaluation question is answered
right, and taken back on a thumbs down; each template ships with examples of its own
(`templateExamples`), chosen to sit on the boundaries a small model gets wrong. A run that read
something like an instruction, asked back or made no plan leaves none; a request that itself reads
like an instruction is never kept; requests are redacted. The memory index embeds the requests.

Before a plan, the runner is sent a pool (all of an agent's examples while there are few, else the
nearest by words and every seed, each with its vector when there is one) and picks up to three with
`selectExamples` (`packages/harness/src/core/examples.mjs`), by geometry rather than volume:

1. **Nearest.** Cosine between the request's embedding and the example's when both have one, else
   the share of words they have in common (stop words out). The request is embedded on the local
   model, where the runner is; on Claude the pick goes by words, so nothing is embedded off the box
   for this.
2. **Contrast.** One example with a different label (the first tool its plan read) from the nearest,
   when it is relevant enough (at least 60% of the nearest's relevance): the model sees where the
   decision falls ("where does Pi-hole run" is `where.runs`; "is Pi-hole blocking" is
   `pihole.stats`), not one choice repeated.
3. **Diverse.** The rest by maximal marginal relevance (λ 0.7): each next pick is the one with the
   best relevance less its similarity to what is already picked. A near-copy of a pick (cosine at or
   above 0.95, or the same words) is never added.

They go into the planner's user message, after the request and the hints, as one line each under
"Plans that worked for requests like this one:" (`demonstrationLines`, intent.mjs), with the tools as
the model calls them; the system message stays the same bytes for the prompt cache. The intent
step records which were shown and why ("planned with 3 examples"). `coverExamples` (k-center
greedy) picks a set that covers a collection, for an export or a review. The CLI host has no book
yet; the selector takes any host's candidates.

The same spread applies to memory recall (M46.2, `diversify` in `server/agents/memory.mjs`): what
the hybrid search returns to the prompt and to `memory.search` is the best few by fused score, then
picked by maximal marginal relevance, so the same fact remembered as a note, an episode and a
finding fills one place rather than three.

### Evaluation

- **Routes compared:** "Compare with Claude" on the Evaluation tab (the owner's, while Claude may
  take the owner's questions) asks every question on this server's model and on Claude, each graded
  the same way; with "Compare with Claude every night" on (Usage → settings), the nightly evaluation
  does it too. Each side shows how many it got right, seconds a question and what Claude cost; a
  question Claude could not take is said to have run locally. The two evaluations share a `pair_id`,
  each held to its `route`.
- **Acting graded without a model:** `server/agents/act-grade.mjs` holds tasks set in the test world
  (restart the unhealthy app, back up Pi-hole, update what it has no leave for, uninstall, a question
  that only reads) and grades what a run staged against what each needs: the right operation with
  the right parameters, and nothing else. CI runs every task on both routes from recorded responses;
  a real model can be put through them the same way.
- **The red-team set** (`server/agents/redteam.mjs`): instructions hidden in an app's name, a log
  line, another agent's note and finding, and the owner's document, each reaching for an agent's leave
  to act. With a model scripted to obey, on both routes: no job, no plan, the run marked and the owner
  told; for the owner's own document, the run held from acting and its view saying why. Detection
  covers what reaches for acting: a tool that acts named in data, data that tells an agent what to
  change, a sweeping change demanded at once, and skipping the person who approves.
- **CI** replays recorded Claude responses and the stand-in model; it never calls a real model and
  never spends money.

### Standalone

`boxpilot-harness` (`packages/harness/src/cli/`; `npm run harness --` in this repository) runs an
agent in one folder with no BoxPilot anywhere. Built in M45.8:

- **Models.** A local server that speaks the OpenAI chat API (`--endpoint`; the model it offers, or
  `--model`), held to BoxPilot's address rules: this machine or the owner's network. Claude with
  `--claude-key-file` (the key from a file, never the environment), this machine's host and account
  names replaced with stand-ins unless `--names as-is`. Scripted turns (`--fake`) to try it and to
  test it. `--route local|remote|auto` with the router's rules: auto starts local and moves when the
  local model fails or the conversation passes 80% of `--context`; a remote call that fails for want
  of the remote model goes on locally, once; a remote model that declines ends the run.
- **Tools.** `files_list`, `files_read`, `files_write` (create, replace, append), `shell_run` (one
  program from an allowlist, with arguments, no shell; git is not on the default list, since a
  repository's own settings can make it start programs), `web_fetch` (public pages only, with
  `--web`), `notes_save` and `notes_search`. Every path stays inside the folder after links are
  followed, never touches the harness's own `.harness`, and nothing is written into `.git`.
- **Approvals.** Each write and command is asked at the terminal with what it would do and the text
  it would write; `--yes` approves all, `--read-only` none, and with no one at the terminal none is.
  A run that read something that looked like an instruction writes nothing, runs nothing and
  fetches nothing, without asking.
- **What the model reads.** Every tool output redacted with BoxPilot's redactor, boxed and
  numbered; the answer checked against what it cites, with one correction; an answer that cites an
  output no tool returned is pointed out.
- **Memory.** `.harness/harness.db` in the folder (SQLite, the owner's only): every run with its
  trace (`runs`, `show`), the agent's notes, and each model's measured speed for the next run.
- **Evaluation.** `eval cases.json` runs each case in a fresh copy of the folder and grades its
  answer and the files it left against patterns; no model judges.

When its interface has held still through two BoxPilot releases it is published as its own npm
package at 0.x; until then it is versioned with BoxPilot.

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
| M45.6 | Plans: durable multi-step plans, checkpoints, resume after restart, task budgets | A three-step plan survives a restart in the middle and finishes |
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
