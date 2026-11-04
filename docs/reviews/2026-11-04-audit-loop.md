# The audit loop — started 2026-11-04

Asked for 2026-11-04: rolling code, bug and security sweeps, each category retiring itself from the
loop once it goes **three consecutive sweeps with nothing found**; then readability, usability,
visual, quality-of-life, platform-feature and optimization sweeps, at least three each, on the same
retirement rule. This file is the ledger: it says which sweep each category is on, so a later
session can pick the loop up without re-reading the whole repo.

Findings that turn into work go to the milestone (M52 in `docs/ROADMAP-V2.md`). Findings that turn
out to be nothing are written down anyway, with why, so the next sweep does not spend itself there
again. The same rule as `swept-and-verified-clean`: a cleared area is not re-audited.

## Ledger

| Category | Sweeps run | Consecutive empty | State |
| --- | --- | --- | --- |
| Code | 1 | 0 | active — 4 findings, all fixed (M52.3-M52.7) |
| Bug | 1 | 0 | active — 3 findings, all fixed (M52.1, M52.2) |
| Security | 1 | 1 | active — nothing found |
| Readability | 0 | — | queued |
| Usability | 0 | n/a | queued — retires on coverage, see below |
| Visual | 0 | n/a | queued — retires on coverage, see below |
| Quality of life | 0 | n/a | queued — retires on coverage, see below |
| Platform features | 0 | — | queued |
| Optimization | 0 | — | queued |

Code, bug, security, readability, platform features and optimization leave the loop at three in the
"consecutive empty" column: for those, "nothing found" is a state the thing can genuinely be in.

Usability, visual and quality of life do not, because they never run out — M50.1 found thirty items
on its own, and three empty sweeps there would say the sweeper stopped looking. Those three retire
on **coverage** (M52.8): `docs/reviews/sweep-coverage.json` holds a row per page and per shell
surface per category, with the date it was reviewed, the sweep number and how many findings that
pass raised. A category retires when every surface has been reviewed in this loop and the last pass
over all of them found nothing. A review goes stale after eight weeks and then counts as unreviewed.
`npm run check:sweeps` checks the rows against `navItems` in `src/data.ts`, so a page added to the
dock cannot go missing from the ledger, and a row for a page that is gone fails too. Staleness is
reported, never red: a check that turns red while nobody has touched the code gets ignored.

Every row in the coverage ledger starts unreviewed. That is the honest state — none of those three
sweeps has run yet — and it is why the next sweep has somewhere to start.

## Out of scope, already cleared

Not re-audited (see `swept-and-verified-clean`): JWT and OIDC, cookie and address parsing, restore
path traversal, GNU tar behaviour, the agents' ADR-015 propagation, ReDoS, the readability verdict
on the server modules swept in M50.

---

## Sweep 1 — code audit

**C1. 25 exports nothing reads, 12 of them dead test hatches.** The `*Internals` objects exist to
let a test reach a module's private helpers; twelve of them are read by no test and by nothing else:
`server/state.mjs:268` (`stateInternals`), `server/inventory.mjs:181`, `server/maintenance.mjs`,
`server/ups.mjs:94`, `server/tasks/ups.mjs`, `server/support-bundle.mjs`,
`server/storage-evidence.mjs`, `server/recovery-kit.mjs`, `server/prerequisite-helper.mjs`,
`server/controller-retention-helper.mjs`, `server/vm-helper.mjs`, `server/vm-media.mjs`,
`server/vm-protection-helper.mjs`, `server/vm-retention-helper.mjs`,
`scripts/boxpilot-storage-scan.mjs`, `server/action-center.mjs`. Each one widens a module's public
surface and reads as "a test depends on this" when none does. The other thirteen are ordinary dead
values: `server/agents/intent.mjs` (`understandingFormat`), `server/agents/models.mjs`
(`modelIdPattern`), `server/agents/orchestrator.mjs` (`findSpecialist`), `server/agents/runner.mjs`
(`actToolsFor`), `server/agents/store.mjs` (`runStates`), `server/catalog/schema.mjs`
(`serverVariableNames`), `server/tasks/cloud-images.mjs` (`cloudImageIds`),
`packages/harness/src/providers/anthropic-prices.mjs` (`pricesListedOn`), `src/operations.ts`
(`listOperations`).

**C2. A dead API route, and an information leak inside it.** `GET /api/v1/operations`
(`server/routes/operations.mjs:14`) is reachable only through `listOperations()` in
`src/operations.ts:65`, which nothing calls. It is also the one place `registry.describe()` goes out
over the wire, and `describe()` does not filter `internal` operations
(`server/ops/registry.mjs:237`), so it hands every role the ids, titles, risk tiers and parameter
names of BoxPilot's own plumbing — which every other path refuses to run for them. Deleting the
route and the client function closes both.

**C3. 277 exports used only inside their own file.** `export` on a module-private helper is noise:
it says "somebody else depends on this shape" where nobody does, and it stops the type checker and
the bundler from telling the truth about reach. Worth a mechanical pass, not a hand edit — the list
is reproducible (declared-and-exported names with no word-boundary match in any other file).

**C4. Three root-level handoff files, at the repo root where a newcomer meets them before
`CLAUDE.md` points them at the roadmap.** All three moved into `docs/`.

This finding was first written as "`HANDOFF-UI-REDESIGN.md` is superseded, delete it", on the
strength of its own second paragraph: "a proposal to fold into `docs/ROADMAP-V2.md`, not part of it
yet", with the decision it asks for taken on 2026-09-28 as ADR-004 and M33. That was wrong, and
checking the citations before deleting is what caught it: ADR-004 and M33 both still point at the
file as the record of the eight design directions, and M33 says it takes B1-B4 and leaves B5-B7
there. Deleting it would have thrown away the directions nobody has decided on. It moved.

The move also closed a mismatch nobody had noticed: `internalDocuments` in
`server/agents/tools.mjs` matches `docs/HANDOFF*.md`, so while these three sat at the root the
agents read them as documents for the owner running BoxPilot rather than for the people building
it.

### Looked at, nothing found

- No unreferenced source modules: every file under `server/`, `src/`, `scripts/` and `packages/` is
  reached from another file or from a `package.json` script. The only candidate,
  `scripts/make-app-icons.mjs`, is a one-shot asset generator — kept deliberately, not dead.
- No `forEach(async …)`, no `parseInt` without a radix, no empty `catch {}` anywhere in `server/`.

---

## Sweep 2 — bug audit

**B1. `scanRemediations` takes an injected clock and then ignores it.**
`server/remediations-scan.mjs:29` sets `facts.now = Date.now()` while the same function's `now`
parameter (line 28) is used only for `checkedAt` (line 216). `facts.now` is what
`backupsDue({ now })` ages every app's newest backup against
(`server/remediations.mjs:1006`, `:1011`), so the one finding in the scan that depends on the clock
— "these apps have no recent backup" — is computed off the wall clock while the answer's timestamp
comes from the injected one. In production both are the same number, so nothing is wrong today; a
test that fixes the clock to a fixture's date gets a 14-day window measured from the real now, which
is exactly the failure mode `CLAUDE.md` names ("inject clocks and never rely on the wall clock
against dated fixtures"). One-line fix: `facts.now = now()`.

**B2. `server/remediations-scan.mjs` has no test at all.** 218 lines, the single function both
`GET /remediations` and the agents' `repair.findings` tool go through, and the only module of its
size in `server/` with nothing testing it (`remediations.mjs`, the detectors it calls, has 960
lines of tests). B1 is the kind of thing that test would have caught.

**B3. The nightly-cleanup attribution misses by a minute and by a day.**
`server/remediations-scan.mjs:134-137` decides whether a `docker.prune` job was started by a
schedule by matching the job's local hour to `schedule.hour` and its minute to within five minutes
after `schedule.minute`. Two gaps: a schedule at :58 whose job started at :01 the next hour fails
the hour comparison, so the app it removed is told nobody's story instead of "removed by the nightly
clean-up"; and the branch covers weekly schedules (`frequency !== "hourly"`) without comparing the
weekday, so a prune anybody ran by hand at the same clock time on a different day is attributed to
the weekly schedule. Both are misattribution in one sentence of copy, not data loss. Comparing
against the schedule's own computed run time (`computeNextRun`) answers both.

### Looked at, nothing found

- `server/scheduler.mjs` and the scan agree on local time throughout — `setHours` on one side,
  `getHours()` on the other. No timezone mismatch.
- `Promise.race` with an unref'd timer (`remediations-scan.mjs:191`), the two `Promise.all`
  fan-outs, and the shared `reading` promise awaited from two places are all correct.

---

## Sweep 3 — security audit

Nothing found. What was checked, so sweep 2 starts elsewhere:

- **The 99 read-only operations against ADR-003.** Every one that reads past the caller's own
  permissions carries `minimumRole: "operator"` or `"owner"`. The viewer-level ones that look wrong
  at a glance — `container.docker.inventory`, `hosted-domains.sources`, `virtualization.media.inspect`,
  the export and backup inspections — are all `internal: true`, which is refused on the operations
  route (`server/routes/operations.mjs:22`), as a staged job, as a schedule and in a flow
  (`server/jobs.mjs:233`, `:482`, `:606`). The role on an internal operation is unreachable, not
  wrong. The one place an internal operation's existence does escape is C2, above.
- **The `/api/v1` role policy** (`server/routes/access.mjs:37`). Default-deny by role, viewers
  confined to reads plus a named list (`/operations/:id/run`, asking an agent, their own feedback and
  thread, sign-out and elevation), operators blocked from `/settings` and `/people`. The
  path is lower-cased and stripped of trailing slashes before it is judged, so
  `/Operations/x/run/` is judged as the route it is.
- **`refuseRead`** (`server/routes/operations.mjs:20`): owner gate, operator gate, elevation gate
  with a real expiry check, and an audit record that logs parameter *names* only, capped at 20.
- **The OIDC admin routes** (`server/routes/oidc.mjs:152`): `requireRole("owner")` plus CSRF on all
  three mutating routes; the public endpoints are rate-limited.
- **The agents' own authority** (`server/agents/agent-admin.mjs:88`, `server/agents/service.mjs:328`):
  an operator may edit only agents they made, and raising any agent to carry out operations is
  owner-only. Minting a webhook requires edit rights on the agent and a webhook trigger already on;
  only the token's digest is kept, and a wrong token, a missing agent and a paused one answer alike.
- **The agent runner's key** (`server/routes/access.mjs:71`): loopback peer *and* no proxy header
  *and* a digest-compared bearer token *and* a well-formed runner id.
- **`escalation-inventory.test.mjs`** already fails on any new operation an operator could approve
  alone that takes a path, a name, a list or free text until someone has written down why it cannot
  reach what a high operation guards. There is no gap for a sweep to find here that the test does
  not find first.

---

## What may be worth more than any of the above

Said plainly, because the sweeps above are small and these are not:

1. **The scan that feeds Repair and the agents has no test.** B2 is a finding, but the shape behind
   it is the real one: `server/remediations-scan.mjs` is the join between every helper read and every
   detector, and it is the only module of its size with nothing holding it. The detectors are tested
   to 960 lines; the thing that assembles their input is not. That asymmetry is where the next real
   bug lives, and B1 is already an instance of it.

2. **277 unnecessary exports is a measurement, not a mess.** It says the codebase has no tool that
   tells it when a module's surface grows. The fix worth having is not the 277 edits; it is one
   check in `npm run check` that fails on a new export nothing outside the file reads. Same shape as
   `escalation-inventory.test.mjs`: the invariant, written down once, enforced forever. That test is
   the best thing in this repo and the pattern deserves a second use.

3. **The "actually running" predicate is written out six times.**
   `Boolean(app.container?.running) && app.container?.status !== "paused"` appears at
   `server/app-glances.mjs:58`, `server/remediations-scan.mjs:25` and `:114`,
   `server/hosted-domains.mjs:225` and `:419`, and `server/ops/cloudflare.mjs:97`. They agree today.
   The day "restarting" or "unhealthy" should also not count as running, five of the six get missed.
   One exported helper, six call sites.

4. **Three sweeps of a category that finds nothing was the wrong stopping rule for the queued ones.**
   Settled as M52.8, above: those three retire on coverage, in a ledger a check holds to the real
   page list. Of the three candidates, a fixed count of passes and the owner's verdict after a week
   both rely on somebody remembering how many passes have happened, which is exactly what does not
   survive a session boundary; the checklist is the only one that does.

---

## What sweep 1 changed (M52.1-M52.7, 2026-11-04)

`npm run check` green afterwards: build, types, 516 test files / 5629 tests, syntax, lint, shell,
and the new export check.

- `server/remediations-scan.mjs` uses the clock it is given, for the detectors (`facts.now`) and for
  the ledger's attempt timeouts, and attributes a `docker.prune` job to a schedule by that
  schedule's own computed run time. `server/remediations-scan.test.mjs` is new, 14 tests; each of
  the two bug fixes was checked by putting the old code back and watching the right test fail.
- `GET /api/v1/operations`, `listOperations()`, the `OperationDescription` type and
  `registry.describe()` are gone, with the route-matrix and registry tests updated.
- Twenty-five exports nothing read are gone. Removing them stranded three imports
  (`digest` and `parseJson` in `server/state.mjs`, `formatPowerEvent` in `server/tasks/ups.mjs`)
  that existed only to fill a dead `*Internals` object; eslint found them, and they are gone too.
- `server/app-run-state.mjs` holds `containerRunning`, which the six former copies now call.
- `scripts/check-export-surface.mjs` and `scripts/export-surface-allowed.json` are in
  `npm run check` as `check:exports`. 275 reviewed entries to start; a new unread export fails, and
  so does an allowlist line whose name has gained a reader or gone. Both directions were tested by
  hand. The first version of the check passed on everything, because the allowlist it writes names
  every entry and the check was reading it as part of the corpus — the file is excluded now.
- The three handoff notes are in `docs/`, citations updated.

M52.8 is settled too: `docs/reviews/sweep-coverage.json` and `scripts/check-sweep-coverage.mjs`,
wired into `npm run check` as `check:sweeps`, with the rule written at the top of this file. Both
checks added in this sweep were tested in both directions by hand — a new unread export and a stale
allowlist line, a page with no row and a row with no page.

Nothing is open from sweep 1. The next thing the loop does is sweep 2 of code and bug (security has
one empty sweep of three), and the first usability, visual and quality-of-life passes, which now
have a ledger to write into.
