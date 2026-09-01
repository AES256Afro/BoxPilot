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
