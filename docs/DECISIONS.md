# Architecture decision records

Short, dated records of decisions that change the product's direction. Newer entries supersede older ones where they conflict. Add a new entry rather than editing an accepted one.

---

## ADR-001: BoxPilot is a point-and-click server setup tool; risk tiers replace universal password approval

**Date:** 2026-08-19 · **Status:** Accepted · **Supersedes:** the "safety-first control plane" framing in the pre-0.62 `README.md` and `docs/ROADMAP.md` phases 0–9 where they conflict.

### Context

Through `0.61.0` every host mutation, including low-impact actions such as restarting a managed container, followed the same path: create an immutable plan, stage it, navigate to Repair Center, re-enter the owner password, approve, verify. Each operation was a fixed, argument-less helper call with hand-written boundary prose and a bespoke systemd unit. The result:

- ~550–650 LOC across ~13 files per new privileged operation; ~700–900 LOC per new application.
- Three applications and five package repairs after ~39k LOC.
- No uninstall, no configuration editing, no updates, no general package or service management, no installer, no first-run wizard.
- Operator copy and API values written as disclaimers about what the product refuses to do.

The owner's goal for the product is the opposite: open the app on a fresh Ubuntu Server and point-and-click through updates, dependencies, application and platform installs (Pi-hole, dashboards, VMs for projects), uninstalls, configuration changes, backup, and fast redeploy, with GitHub and Tailscale identity. See `docs/ROADMAP-V2.md`.

### Decision

1. **Product goal.** BoxPilot is an all-in-one, point-and-click setup and management tool for a fresh Ubuntu Server. Capability breadth and low friction are first-class goals. Safety is delivered through *previews, audit, checkpoints, and undo*, not through refusing to act.
2. **Risk tiers replace password-per-action.** Every operation declares a risk tier:
   - `low`. Read, start/stop/restart, refresh, view config: one click, audited.
   - `medium`. Install/uninstall-keep-data, apt install/upgrade, create VM, edit config: one confirmation showing a plain-English preview of what will change.
   - `high`. Uninstall with data purge, DNS cutover, disk format, VM delete, firewall/SSH changes, restore over live data: password (or passkey) plus typed confirmation.
   A successful password unlocks a short **elevated session** (default 10 minutes) so batch setup does not re-prompt. An "always ask" setting restores today's behaviour for operators who want it.
3. **One operation registry.** Operations are declared once (`id, title, risk, params schema, privileged, readOnly, timeout, run, verify, rollback`). The helper allowlist, read-only set, timeouts, parameter validation, job execution, and UI affordances derive from the registry. The three hand-synced allowlists and the per-type ternary chain in `server/jobs.mjs` are retired.
4. **General primitives are in scope.** apt, dpkg, systemd, reboot, docker/compose, ufw, users/SSH keys, netplan (validated), tailscale, and managed-path file edits are legitimate helper operations, each parameter-validated and audited.
5. **Data-driven catalog.** Applications are YAML manifests plus a compose template and optional hooks, deployed by one generic deployer with install / uninstall / update / reconfigure. App-specific JavaScript is the exception, not the rule.
6. **Copy describes what happens, not what is refused.** Operator-facing text names the action and its effect. Boundary disclaimers move to `docs/SAFETY.md` if they are needed at all.
7. **No personal host data in the repository.** Hostnames, MACs, LAN layouts, and router models belong in placeholders or ignored `*.local.md` files.

### Left to the owner

- **Connectors' tokens** live in the root-owned credential store (M13.7) and are read only inside the
  `agents.connector.sync` task; each sync is a low-risk job the owner approves or schedules.

- **Studio or llama.cpp's server alone.** The `llama-server` Unsloth installs can serve the model by
  itself: MIT, no Python, 0.00% idle, a second to start, but without Studio's tool-call healing,
  per-model settings and idle unload, and measured for embeddings rather than chat. The runtime has a
  `llama-server` driver so the choice is a setting, not a rewrite; Unsloth stays the default.
- **Pinning.** Unsloth's installer always takes the newest release, and the spike found the docs
  lagging the code. BoxPilot keeps the installer's SHA-256 and the release it installed and says
  when that is not 2026.9.12; a pinned install, or the spike's slim image built from a known release,
  with the spike's workflow rerun before moving, is the owner's call.
- **How many processors.** Four since the first real run (the owner's choice, ADR-006): one read a
  prompt at about 20 tokens a second on the home server. Fewer slow it in proportion (the spike: half
  a processor halves the speed). The 9B would need about 12 GB.

### Consequences

- Existing guarded workflows keep working during the transition; they are ported to the registry and re-tiered rather than rewritten from scratch.
- `README.md` was rewritten around the new goal; `docs/ROADMAP-V2.md` is the authoritative plan, and the pre-pivot roadmap moved to `docs/legacy/ROADMAP.md`.
- Anyone (human or agent) adding a feature should add a registry entry or a catalog manifest, not a new named systemd unit, a new per-workflow SQLite ledger, or a new paragraph of boundary prose.

## ADR-002: Flows compose registered operations; a chain answers for its riskiest step

**Status: accepted (v1.33.0). Scope deliberately v1: manual runs only; triggers and standing consent are M13.5 and get their own decision.**

### Context

BoxPilot already has 146 registered operations with typed parameters, a job machine that stages,
approves, applies, verifies and records, and a scheduler that runs low and medium operations
unattended under their creator's stored authority. What it lacks is everything between one
operation and the next: run these three in order, stop if one fails. Risk tiers answer what a
single operation may do and say nothing about a chain, and five low-risk steps can compose into
an effect no single step has.

### Decision

- A flow is an ordered list of registered operations with fixed parameters, stored like schedules
  are stored. It contains nothing that is not already a registry entry.
- Each step runs as an ordinary job: created, approved, executed and recorded exactly as if the
  owner had pressed the buttons in order. The audit trail shows the steps, not a blur.
- A flow answers for its riskiest step: its displayed risk is the highest tier it contains.
- High-risk operations cannot be put in a flow at all, the same line the scheduler draws. Not
  "high needs approval mid-flow": a chain that stops to ask defeats the point, and one that does
  not is an unattended high operation.
- A flow runs under the authority of the signed-in person who starts it, and only an operator or
  owner may start one. Always-ask approval mode blocks flow runs the same way it blocks
  scheduled runs, and for the same reason: it is a standing instruction to be asked every time.
- A step that fails stops the flow. What ran stays run, each step's job record says what
  happened, and nothing attempts an automatic unwind: a half-done flow the owner can read beats
  a rollback that guesses.

### Consequences

- No new branch in the approval chain, no new execution path: flows drive `createOperationJob`
  and `approveAndStart`, the same doors the scheduler uses. The `flows` table is feature-level
  storage like `schedules`, not the per-workflow tables ADR-001 retired.
- **Addendum (v1.34.0): the clock is admitted.** A cadence on a flow is not a new consent
  question; it is the contract schedules have carried since M6.1, extended to a chain that already
  obeys the scheduler's own limits. The creator consents by writing the cadence, the consent is
  visible on the Automations page, disabling the flow revokes it, a creator who loses the operator
  role stops being obeyed, and always-ask approval mode blocks scheduled flows exactly as it
  blocks schedules. What stays deferred is any trigger a third party can fire.
- **Addendum (v1.45.0): one flow finishing is admitted as a trigger for another.** "Run B after
  A completes" raises no new consent question, because every element is already inside the fence:
  the triggering fact is recorded by BoxPilot itself (a flow run completing), not supplied by any
  third party; the consent is the creator of B writing the link, exactly as a cadence is written;
  the link is visible on B's row and disabling B revokes it; B runs under B's creator's stored
  authority with the same refusals as a scheduled run (role lost, always-ask mode, already
  running), and a refusal is recorded and notified. Only completion triggers, not failure: a
  failed A already stops and tells; chaining repairs onto failure is a different consent shape.
  Cycles are refused at save time. Everything third-party stays deferred as below.
- **Addendum (v1.50.0): the webhook is admitted, as delegated consent with a fence.** The deferred
  question was: who approved the run a trigger fires at 3am? Answer: the flow's creator did, by
  minting a token for exactly that flow. The token is the creator's own authority, delegated for
  one action ("run this flow"), the way an API key is; minting it is the consent, the armed state
  is visible on the flow's row, and regenerating or removing the token (or disabling the flow)
  revokes it. What keeps this consent simple is the fence: the caller chooses only WHEN, never
  WHAT. No parameter from the request reaches any step, so a webhook cannot make a flow do
  anything its creator did not already write down. The token is shown once and only its hash is
  stored (a hash is not a secret); presentation is compared in constant time; a wrong token is
  indistinguishable from a missing flow; fires are rate-limited per flow and audited with their
  source; the run itself goes through the same door as a scheduled one, with the same refusals
  (creator demoted, always-ask mode, already running), recorded and notified the same way.
  Health alerts and device events as triggers remain future work, but they now have a template.
- **Addendum (unreleased, M26.5): one health condition is admitted as a trigger, a managed drive
  going dead or read-only.** The webhook's template holds. The fact is BoxPilot's own: the health
  round's finding about /mnt/<name>, not anything a third party supplies. The consent is arming:
  whoever clicks creates a flow for exactly that drive, and its one step (reconnect it) is written
  at that moment. The trigger chooses only WHEN; nothing from the finding reaches the step, which is
  why arming is per drive rather than one switch for every drive, since a global switch would need
  the finding to name the drive to the step. The armed state shows on the drive's row, on its Repair
  notice and on Automations; disarming, pausing or removing the flow revokes it. The run goes
  through the same door as a scheduled one, under the creator's stored authority with the same
  refusals, each step an ordinary job. What an event needs and a clock never did is a bound on how
  often it fires, so this trigger carries its own: a cooldown between runs, a cap per day, a hold
  after any run that failed or was interrupted until a person has reconnected the drive, and no run
  while the drive is being checked or after a check found errors. Each outcome goes through the
  health-alert ledger once. Other health conditions and device events remain future work, and each
  needs its bounds argued as well as its consent.

## ADR-003: a read that sees past the caller's own permissions needs an operator

**Status:** accepted (v1.107.0).

Risk tiers (ADR-001) decide what it takes to *change* the machine. They say nothing about reading,
and the assumption that reading is free is where this went wrong: five read-only operations were
gated by role and fifty were not, with no principle separating them. `storage.folders` had required
an operator since it shipped, with the reasoning written in its own comment. `app.backup.files` --
which lists every filename inside an application's backup, config and data alike -- did not.
`compose.project.logs` did not, while `app.logs` and `logs.read` next to it did. And
`app.data.usage` shipped in v1.105.0 with no gate at all.

The rule, applied to all of them:

> A read-only operation needs `minimumRole: "operator"` when it runs in the root helper **and**
> returns something the caller could not have read themselves -- a directory listing, the contents
> of an archive, a log, the size of somebody else's data.

Everything else stays open to a viewer, which is most of it, and deliberately: a viewer is a
person who is allowed to look at the server. `app.config.inspect` stays open on exactly this
basis -- it masks every value the manifest marks secret, and revealing them is a separate
operation with its own gate.

Two things fall out of it. The refusal must name what was refused; it used to say "not read raw
system logs" whatever had been asked for, which is baffling when what you asked for was a backup's
contents. And these reads are also the slowest ones -- inflating an archive, walking a folder tree,
minutes rather than milliseconds -- against a helper that serves reads eight at a time. Leaving one
open to anyone signed in is a way to stop the product reading anything at all, so the gate is a
throughput protection as much as a disclosure one.

`server/routes/authorization.test.mjs` holds the four together, because shipping one without the
gate is precisely what happened.

**Addendum (v1.108.0): a second pass over every read-only operation found five more.**
`system.update.status` returned up to eighty raw journal lines while every other journal read was
operator-gated; `users.inspect` read every account's `~/.ssh/authorized_keys` and `sshd -T`;
`samba.inspect` sized each share's 0770 recycle bin; `dns.blocker.clients` returned which device
asked for what; `host.snapshot.discover` walked every mounted filesystem on a two-minute budget. All
five are operator now, and the test holds nine. The lesson of the first four had been applied to
the four, not to the rule: the audit that should have followed writing the rule down came a release
late.

**Addendum (2026-09-07): raw configuration and remaining private inventories.** The configuration
inspector's raw Compose text could contain credentials from a manual edit, and an undeclared `.env`
entry could be a secret removed from the current manifest. Masked environment settings remain
viewer-readable; unknown entries are now masked. Raw Compose is a separate `app.compose.inspect`
read requiring an elevated owner session and an audit event, like secret revelation. Compose edits
use temporary secret parameters so inline credentials are not persisted in job metadata. Password
fields remain secret even if their manifest mistakenly says `secret: false`.

`app.backups.inspect`, `host.snapshot.inspect` and `host.snapshot.sources` enumerate private backup
directories; `app.models.inspect` returns an application's model names and data sizes through root
Docker access. These now require an operator. Aggregate backup counts and declared public app
settings remain available to viewers. HTTP tests cover both run and inspect routes.

**Addendum (2026-09-28, unreleased): composite routes answer to the same rule.** A route that
assembles its answer from several sources - the Overview, the catalog, Repair, the evidence lists,
the support bundle - never asks an operation's question, so it asks it on the operation's behalf
(M29.4). An operator read is not run for a viewer through such a route, or the fields it is gated
for are removed: Repair leaves File sharing and USB history to an operator and names them as not
checked, and the Storage page's per-app data sizes and each share's recycle-bin size and owner are
left out. A summary - whether shares are served, the day a drive was last written - stays open.
Another account's work is the owner's to see: anyone else gets their own jobs' traces, and the
records jobs left behind name no other account. `server/routes/access.mjs` holds both rules and
the role policy; `server/routes/route-matrix.test.mjs` fails on any route without an entry.

**Addendum (2026-09-28): banned addresses stay visible to everyone.** The M29.4 audit flagged
`fail2ban.inspect` as a direct read open to viewers that reads root-only state. The owner decided
that every account should see which addresses are banned, so it stays open to all roles as an
explicit exception to this rule. `firewall.inspect` was not changed either; gating it needs the
owner's say.

## ADR-004: one interface, Home and Ops

### Context

About fifteen top-level pages each act as a dashboard; panels open with paragraphs before the
status; risk tiers appear only once a dialog opens. The owner reviewed ten directions
(`docs/design-directions/04-eight-directions.html`, `HANDOFF-UI-REDESIGN.md`) and liked two:
the Launcher and the Command Center.

### Decision

One design system with two views of the same data, switched in the top bar:

- **Home** is the Launcher: apps as tiles with live health, what needs the owner, and the admin
  areas in a dock. It answers "is everything OK?" on one screen, at a comfortable density.
- **Ops** is the Command Center: a metric strip, what needs the owner by tier, containers, the
  job queue and a backup matrix, at a compact density.

Both work in light and dark, follow the device's setting by default, and can be overridden. Every
action button carries its risk tier before it is clicked. Current pages stay reachable as
"Classic" until each area's replacement is done (M33).

### Consequences

Colors and type move into tokens with light and dark values; components gain a density. A page
is not replaced until its new version shows the same facts. The command bar is where the local
assistant (M34) is asked; the phone layout and recipes stay with M25 and M22.

**Addendum (2026-09-29, unreleased, M33.7): the look.** v1.137.0 gave Home and Ops the study's
layouts in the old skin, and the owner found that "the bones look the same". The two views now
wear the study's own look, and every Classic page shares its type and surfaces:

- **Type.** Figtree for the interface, IBM Plex Sans Condensed for Ops, JetBrains Mono for every
  number, id and path in Ops (and for code everywhere). All three are OFL-1.1, self-hosted from the
  `@fontsource` packages (Latin and Latin Extended, upright; Figtree and JetBrains Mono variable,
  Plex at 400 and 600), bundled into `dist/assets` and served by BoxPilot itself under
  `font-src 'self'`. No font is fetched from any other origin; the build writes the licences to
  `dist/licenses/`.
- **Home's wallpaper and glass.** Three radial glows (sea teal, a warm sun, deep navy) over a
  two-stop base, drawn once as a fixed layer behind Home only; nothing blurs the page as a whole.
  Panels are frosted glass (a white fill at 9% in dark, 50% in light, a hairline edge, a 20px
  radius, `backdrop-filter: blur(20px) saturate(140%)` on the panels alone), drawn solid where
  `backdrop-filter` is missing or `prefers-reduced-transparency` asks. Dark ink is white; light
  is a daylight wallpaper (pale sky, peach, cream) with dark ink. Buttons are pills that keep the
  tier's marks. Apps are colour squares, one of fifteen deep hues per app (`src/ui/appColor.ts`:
  the known colour for well-known apps, otherwise stable from the id), with a health badge that
  has its own shape. The study's glows were a shade too bright to hold secondary text on glass at
  4.5:1 at their brightest point, so they are deeper; the checker judges every ink at each base
  end bare and under each glow at full strength, on the wallpaper and on glass.
- **Ops' Command Center.** A near-black page (`#0A0D10`), a `#0C1014` bar, `#1C232B` hairlines,
  amber `#FFB547` for what to act on and cyan `#56C8E0` for what is measured, panels
  with small mono capitals and a count, a 56px rail of the dock's areas, and sparklines. Light is
  paper: an off-white page, white panels, dark ink, the amber and cyan darkened to `#9A5B00` and
  `#0B7489` so they read at 4.5:1. The study's greys for secondary text sat under 4.5:1 and are
  lifted to `#8A95A1`.
- **Honest sparklines.** BoxPilot keeps no history of its live figures, so Ops keeps its own while
  it is open: each five-second read joins a sixty-read rolling buffer, and the lines start when the
  page does. The study's 1h/6h/24h/7d control is left out until there is history to choose from.
- **Tokens, not literals.** Home and Ops point the Classic token names at their own on the shell
  (`.app-shell[data-view]`), so every component inside them takes the look without per-component
  colours, and a Classic page's layout is untouched (M33.5 moves them).

**Addendum (2026-09-29, unreleased, M33.8): the console.** The owner, after v1.138.0: "when I go
under Ops and I tap on any icon, it just reverts me back to the old box pilot... I want it gone."
So there are two shells now, not a Classic one beside them:

- **Home is the Launcher; every other page is the console.** The rail (the dock on a phone), the
  compact bar with the page's name after the server's (`homebox / services`), and the Command
  Center's tokens, set as `data-shell="console"` on `<html>` as well as on `.app-shell`, so a
  sheet, the approval dialog, Activity or the command bar opened over a page is drawn like it.
  The old header (an eyebrow, a large title, a paragraph) and the "What you can do" strip are gone.
  The rail is led by Ops, the console's overview.
- **Facts first.** A page opens with its verdict (one status chip), then its facts in mono, then
  its panels. What a page is for sits behind an info toggle in its header; a longer explanation is
  the assistant's (M34), never a paragraph above the facts. Every action still carries its tier.
- **One kit, one sheet per page.** `src/ui` gains the page kit (PageHeader, Panel, the form
  controls, Tabs, KeyValue, Notice, EmptyState, Toolbar, Sheet, CodeBlock, Progress, JobProgress,
  Tag); a page's own layout lives in `src/pages/<area>/<area>.css`, tokens only and scoped to the
  area, so the pages rebuilt in parallel (wave 2) cannot collide. `docs/UI-PAGES.md` is the how-to;
  Services and Logs are the reference pages.
- **A stopgap for the rest.** Until each page is rebuilt, the Classic pages' own classes (panels,
  stat cards, buttons, pills, notices, tables, inputs, modals) are restyled to the console in one
  block of `src/styles.css`, so none of them reads as the old app.
- **The Classic overview is retired.** What it showed that Home and Ops did not (each drive's SMART
  health, the UPS, the key services, the setup checklist) is on Ops, with drive health and the UPS
  as figures on Home; `?view=overview` opens Home.
- **Light amber and green, a shade darker.** Checking the main pairs under the console's tokens
  found a chip's amber or green on its own tint over the paper page at 4.37:1; they are now
  `#935700` and `#147447`.

## ADR-005: agents run in a capped service of their own, read through the web service, and only propose

**Date:** 2026-09-29 · **Status:** Accepted (M37, unreleased) · **Refines:** ADR-001's "no new named systemd unit" for one long-running service, and M34's local-model rule.

### Context

The owner asked for agents: named, instructed, scheduled or asked, that learn the server, watch
Pi-hole or the backups, write a daily digest and suggest fixes, built in a section of their own. The
owner set four conditions before anything else. Agents must never make the server run hot ("I don't
want to wake up and find this module running at 60% CPU"): the limits must be ones the kernel
enforces, not ones the code promises. Everything must pause, one agent or all of them. Agents may
propose but never act. And the model must be local, served by Unsloth rather than Ollama: the newest
small Qwen that reads text and images, on a CPU-only server (8 cores, 16 threads, about 29 GB).

A model on a CPU is the heaviest thing BoxPilot would ever run. The web process cannot host it (it
must stay responsive and unprivileged), and the root helper must never host anything that reads
untrusted text and decides what to do next.

### Decision

1. **Two processes.** The web process keeps everything about agents - their versioned specs, the run
   queue, budgets, triggers, traces, notes, cards, the learning library - in BoxPilot's own
   database, and runs every tool. The runner (`deploy/boxpilot-agents.service`,
   `server/agents/runner-main.mjs`) runs the model and the agent loop, and nothing else.
2. **Hard caps on a unit of its own.** The runner and the model server it starts share one cgroup
   with `CPUQuota=400%` (four processors, the owner's choice after the first real run - ADR-006; it
   was one, the spike's number), `CPUWeight=idle`, `Nice=19`, `IOSchedulingClass=idle`, `MemoryMax=8G`, no
   swap, `TasksMax=256`, its own user, no capabilities and `IPAddressDeny=any` but loopback. This is
   a long-running service with its own trust level, not a per-operation oneshot unit, which is what
   ADR-001 retired; it is installed with the others and enabled only when the owner turns Agents on.
   `caps.mjs` holds the values the Usage panel shows and a test holds them to the unit; a
   real-systemd test proves the kernel enforces the quota (on a runner with fewer processors than
   the shipped quota, a lowered one) under a model that wants more, and that it idles under 2%.
3. **Unsloth as the runner's child, not a container.** The spike
   (`docs/spikes/2026-09-unsloth-headless.md`) recommends a BoxPilot-built 2 GB image run with
   `docker run --cpus 1.0`. BoxPilot takes its flags, caps and security findings and not its
   packaging: a container would sit outside the runner's cgroup, so the caps would be two sets to keep
   equal; starting and stopping it would need Docker, which is root, from an unprivileged runner; and
   it would run when nothing needs it. As the runner's child, `unsloth run` is started when a run
   needs a model and stopped when idle with no privilege at all, under the one cgroup the kernel
   caps, and idle is then no process. It is installed by Unsloth's own installer (GGUF-only), as the
   runner's user, into the runner's state; root never runs or writes anything there.
   It runs as the spike found it must: `--api-only --disable-tools` (Studio's server-side Python,
   shell and web search are otherwise on), bound to 127.0.0.1, one thread for each processor in the
   quota (four), `--context-length 8192`
   and `-c 8192` (Unsloth's idle reload forgets the first and would relaunch at 262,144 tokens),
   `--ctx-checkpoints 4`, `UNSLOTH_MODEL_IDLE_TTL=900`, offline, the public-port check off, and
   Studio's admin password set to a secret the runner keeps rather than one Studio prints. Its key
   is read once per start and sent on every request, and every request names the model. Installing
   Unsloth, the downloads, starting the unit and switching models are registered operations,
   approved at their tiers.
   **Licence:** `unsloth run` starts Unsloth Studio's backend, which is AGPL-3.0 (llama.cpp, which
   does the inference, is MIT). BoxPilot talks to it only over HTTP, as a separate, unmodified
   process installed from Unsloth's own installer on the owner's server; BoxPilot ships none of its
   code. That reading should be confirmed before M37 ships; it is not legal advice.
4. **A scoped identity, not a session.** The runner reaches the web service on
   `/api/v1/agent-runner/*` with one key, handed to it by systemd (`LoadCredential`) from a file
   only the web service and root can read, accepted only from loopback and never through a proxy.
   The key opens nothing else; every other route asks for a session. On its own routes the runner
   can take work, report steps, ask for a read-only tool by name on a run whose lease it holds, and
   finish. It never talks to the root helper.
5. **Tools read as a person.** A run reads as the person who asked, or for a schedule or an event as
   the person who made the agent; the tools apply the rules the pages apply (jobs, alerts, ADR-003's
   operator reads). Tool output is data: redacted, neutralised, boxed as untrusted, and flagged when
   it reads like an instruction.
6. **Propose, never act.** The only way an agent affects the server is a card: registered operations
   checked against the registry and the person (`assistant/plan.mjs`), each staged and approved by a
   person through the ordinary job path at its own tier. Notes and notices are the only other writes.
7. **One OpenAI-compatible client.** The agents and the assistant share
   `assistant/model-client.mjs` under M34's local-only rules (loopback only for agents); Ollama's own
   API stays as a legacy provider for assistant settings saved before this.
8. **Bounded everywhere.** One run at a time for the server, one question at a time per person,
   budgets a day, limits a run, a bounded queue that drops unattended work, rate limits, timeouts,
   quiet hours for heavy work, a self-throttle when the server is busy; an interrupted run is marked,
   never retried.
9. **A small engine of its own, not a framework.** BoxPilot does not embed LangChain, CrewAI,
   AutoGen or the like; the agent engine is a few thousand lines of its own (`server/agents/`), with
   the pieces those frameworks offer built to BoxPilot's rules:
   - *Footprint.* The web process runs on Node with four dependencies. A framework brings a Python
     runtime or hundreds of packages, its own HTTP clients and its own threads, all outside the
     runner's cgroup and so outside the caps the owner asked for first.
   - *Caps.* Everything an agent does happens either inside `boxpilot-agents.service` (the model,
     embeddings) or as a bounded read in the web process (tools, memory search). A framework decides
     for itself when to call a model and how often, which is exactly what the caps and budgets exist
     to decide.
   - *Local only.* Frameworks default to cloud models, cloud vector stores and tracing services, and
     some send telemetry unless told not to. Here the model is on loopback, the vector store is
     SQLite, web search is the owner's SearXNG or nothing, and nothing leaves the machine unless the
     owner approves an operation that says it will.
   - *The approval model.* In a framework an agent's tool runs when the model calls it. Here a tool
     only reads, and every change is a card of registered operations a person approves at each step's
     tier. Retrofitting that onto a framework means taking out most of what it is for.
   - *Reviewable and portable.* Every step is in the trace, every rule has a test, and an agent is a
     JSON definition that can be read, kept, and brought to another BoxPilot (export and import go
     through the same gate as the Builder).
   What the owner asked a builder and an orchestrator to have is built in that shape: intent, plan,
   act with a structured understanding; short- and long-term memory with hybrid search; a typed tool
   registry with exact tools, opt-in web search and connectors; escalation instead of action; and a
   supervisor that hands subtasks to specialists on the one queue (ROADMAP-V2, M37.7).

### Consequences

- Idle costs nothing measurable: a long poll every half minute and, after the owner's idle time,
  no model server at all. While Studio is up but unused it costs about 0.5% of one processor.
- A model that is missing, slow or broken degrades an answer to the tools' facts instead of failing.
- The web process runs every tool, so a tool's cost lands there; tools are cheap reads, bounded in
  number and size per run, and one run goes at a time.
- The spike's measurements set the first defaults (one processor, one thread, 8,192 tokens of
  context, the 4B model at about 4 tokens a second): slow for chat, fine for digests, triage and
  routing. They are settings of the runtime, not of the architecture, and the home server's own
  numbers moved them: four processors and four threads since the first real run (ADR-006).
- Agent tables are a product area's records, like flows and schedules, not an operation's ledger;
  every change to the host still goes through the registry.

## ADR-006: agents' prompts are built for the model server's cache, and a call's time is measured

**Date:** 2026-09-29 · **Status:** Accepted (M37, unreleased) · **Refines:** ADR-005's caps and its runner.

### Context

The first run on the owner's server (Ryzen 7 7800X3D, one thread under `CPUQuota=100%`) asked the
Server Keeper for the most important issue to focus on. Qwen 3.5 4B read its prompt at about 20
tokens a second and wrote at about 4. The plan took 110 s; the next call, carrying all 22 tools'
schemas behind a changed start, was cut off by the fixed 300 s per-call limit before it had read its
prompt; the run ended degraded after 416 s, and its fallback searched BoxPilot's own roadmap.

### Decision

1. **Four processors, four threads, 15 minutes.** The owner raised the runner's quota to 400% and the
   model's threads to four (a quarter of the 16-thread server at most, only while a run goes;
   everything else in ADR-005's caps stays), and the default longest run to 15 minutes, with a day's
   model time defaulting to two such runs (an hour for the Server Keeper, whose half hour ran out
   after three questions on a small machine). Agents saved with the old 10-minute default were moved
   to it once, as a version BoxPilot made and said so.
2. **Prompts that only grow.** llama-server reuses the longest common start of the last prompt it
   read, and Qwen's template puts the tools first. So the planner is a small conversation of its own
   whose system message is the same for every run of an agent; and the calls that act are one
   conversation that only grows at its end, carrying the same tools in the same order every time (a
   forced last answer and a JSON rewrite too: `tool_choice: "none"` keeps the tools in the prompt),
   with nothing inserted before the end. A call after the first to act reads only what it added.
3. **Only the tools the plan names**, plus the always-on ones (memory, propose, tell, hand off), at
   most ten, instead of every tool the agent may use.
4. **A call's time comes from measured speed.** llama-server's timings (Unsloth passes them on), or
   the runner's own clock, give this server's reading and writing speed; a call is started only when
   it can read its prompt and write an answer in what the run and the day's model time have left,
   and the trace says so when it cannot. There is no fixed per-call limit: a call may use what the
   run has left. The speed is kept and shown on the Usage tab.
5. **A call given up on is stopped**: the connection is closed (llama-server checks between batches,
   now of 512 tokens), and Unsloth is asked to cancel it by the `cancel_id` it carried.

### Consequences

- Unsloth drops `cache_prompt` and `id_slot`; llama-server caches prompts by default and there is one
  slot, so reuse depends on the bytes staying the same, which the tests hold (`runner.test.mjs`, with
  a stand-in model that renders Qwen's template and keeps one slot's cache, checkpoints and all).
- The planner's prompt and the first call to act do not share a start (the tools differ): that is
  paid once a run. A later run of the same agent with the same tools reuses both, from llama-server's
  prompt cache (`--cache-ram 1024`, which also keeps it inside the memory cap).
- `test/agents-bench.mjs` replays the owner's question at the measured speed in CI;
  `.github/workflows/agents-bench.yml` runs it on the real model.

## ADR-007: Zulip is the agents' team chat, reached through Tailscale, set up by its own owner

**Date:** 2026-09-29 · **Status:** Accepted (M38, unreleased) · **Builds on:** ADR-001 (the catalog), ADR-005 (agents propose, never act).

### Context

The owner asked for a chat where agents report: "Install Zulip... Setup the rooms for the agents so
all future agents know they can report their findings, detail logs, knowledge, a channel for
dumping images, documents, files for training." Three were weighed, all self-hosted and two
already in the catalog: Mattermost, Matrix (Tuwunel with Element) and Zulip. The owner chose Zulip,
for three reasons of their own: it is fully open source (Apache-2.0), it puts no cap on history, and
its channel-and-topic model fits agents - one channel per kind of output, one topic per agent. A
Matrix room has no topics, and end-to-end encryption makes a bot that reads files and posts traces
harder to run. The server is private (Tailscale; the owner and an IT helper), so nothing about this
may open a port to the internet or send data out without the owner saying so.

### Decision

1. **A catalog app, not a service of BoxPilot's.** `catalog/zulip.yaml` runs the image docker-zulip
   ships (`ghcr.io/zulip/zulip-server`, Zulip Server 12.3) with its PostgreSQL, memcached, RabbitMQ
   and Redis as sidecars, every image pinned (docker-zulip's PostgreSQL by digest, since it is only
   published as "14"), every internal secret generated and passed by reference from the app's
   `.env`. Its database and `/data` are in app backups; the cache, queue and Redis are not. Zulip's
   own nightly dump is off, because it never deletes one and BoxPilot's backup already covers it.
2. **Tailnet only by default, at the Serve address.** A manifest may now say `defaultExposure:
   tailnet`: installed without a choice, its web port binds 127.0.0.1 (never every address, #323)
   and the install publishes it with Tailscale Serve, which gives a valid `*.ts.net` certificate —
   what Zulip's phone apps need. Zulip must know that address (`EXTERNAL_HOST`), so env values may
   name `${TAILNET_HOST}`, this server's tailnet machine name, filled in at every deploy; an app
   that needs it is not deployed without one. Serve's requests arrive through Docker's gateway,
   which Zulip is told to trust for the forwarded HTTPS headers (`TRUST_GATEWAY_IP`).
3. **BoxPilot creates no account with a password.** The first organization and its owner come
   from Zulip's own single-use link (`manage.py generate_realm_creation_link`, run as the zulip user
   inside the container), behind "Create your organization" on the app's sheet: a medium-risk,
   owner-only operation. The link is a registry `oneTimeFields` result: the job never stores it,
   the person who ran it is handed it once, and asking again gets nothing. It is refused once an
   organization exists. Zulip lets that link skip email confirmation, so no mail server is needed
   to start.
4. **Email and push are the owner's to turn on.** Without SMTP Zulip sends nothing, and the sheet
   says so; the SMTP settings are optional values. Mobile push goes through Zulip's own push
   service (free up to 10 users), which means accepting its terms and sending data out: a setting
   that is off, with the exact steps, and BoxPilot never registers.
5. **Agents reach Zulip as a bot the owner's organization owns, made by Zulip itself.** Connecting
   (owner-only, medium) runs one fixed script through `manage.py shell` as the zulip user: it makes
   a generic bot with Zulip's own `do_create_user`, owned by the organization's owner (so Zulip's
   audit log shows the owner made it), creates the four private channels and subscribes the owner
   and the bot, and is safe to run again. Chosen over a key the owner pastes: the key never passes
   through a browser or the web process, the owner makes nothing by hand, and running it again
   repairs what is missing. The key goes straight into the root-owned credential store (M13.7) and
   is read only inside the root tasks that post and read; it is never shown or logged.
6. **The runtime posts, the model does not.** Findings, traces and notes are posted from a run's
   outcome, redacted as the runner redacts, bounded in number and size, and every card links back
   to BoxPilot, where approvals happen; nothing is approved in chat. Files in `#agent-files` come in
   by polling Zulip's message history with the bot's key (no inbound exposure), under the
   connectors' limits, as data, never instructions.

### Consequences

- Zulip costs about 2.6 GB of memory with its sidecars, measured on a GitHub runner by
  `zulip-host.yml` a minute after it came up (Zulip 2.4 GB, RabbitMQ 150 MB, PostgreSQL 60 MB,
  Redis and memcached 17 MB; threaded queue workers already save about 1.5 GB over Zulip's
  default for a server this size), and 3.5 GB of disk for its images, before the database and
  uploads. Its first start builds the database: about two and a half minutes there.
- Anything BoxPilot does inside Zulip is a management command in its container, so a Zulip
  release that renames one breaks it loudly; the image is pinned and moves only with the catalog.
- A second organization is Zulip's business, from its own settings; BoxPilot refuses to make a
  creation link once one exists.
- Two-way chat - asking an agent from a DM or an @mention - needs each Zulip user mapped to a
  BoxPilot account and runs as that person; it is specified in M38 and not built yet.
