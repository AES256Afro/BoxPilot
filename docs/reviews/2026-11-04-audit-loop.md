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
| Code | 4 | 0 | active — sweeps 1-3 fixed; sweep 4: 1, fixed (M56.2) |
| Bug | 4 | 0 | active — sweeps 1-3 fixed; sweep 4: 1, fixed (M56.1) |
| Security | 4 | **1** | active — sweep 4 found nothing; two more empty sweeps retires it |
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

---

## Sweep 2 — bug audit

**B4. The auth service takes an injected clock and reaches for the wall clock in five places.**
`createAuthService` (`server/security.mjs:108`) accepts `now = () => Date.now()` and uses it in
exactly one place, session renewal (`:260`). Everywhere else it reads the clock directly:

- `:531` the elevation window — `new Date(Date.now() + elevationTtlMs)`, the deadline that gates
  every high-risk approval and every secret read;
- `:179`, `:185`, `:186` the "your session ended because it came back from another address" memory;
- `:495` `createdAt` on a trusted-device record;
- `:162` the time inside the new-sign-in notification, which is written into the message precisely
  because the push may arrive hours later.

The same class as B1, in the module where it matters most. Nothing is wrong in production — both
clocks are the same number there — but of the six test files that build an auth service, only
`session-renewal.test.mjs` passes a `now`, and it is testing the one path that honours it. The
elevation window's expiry cannot be tested against a fixed clock at all, which is why it is not.

**B5. The hosted-domains file read bounds the number of files and nothing inside them.**
`readHostedSources` (`server/hosted-domains-sources.mjs:93`) caps proxy-host files at 200, so
somebody did think about bounds; `parseProxyHostConfig` then accepts any number of names in one
`server_name`, and `parseCloudflaredConfig` any number of `ingress` rules. Measured: 50,000 ingress
rules parse to 4.1 MB of JSON in 459 ms, and 200,000 `server_name` entries in a single file to
4.3 MB in 51 ms. The helper reply is capped at 32 MiB
(`server/helper-response.mjs:4`), so this does not run a server out of memory; what it does is fail
the whole `hosted-domains.sources` read with "Helper response exceeds the 33554432-byte limit" once
a configuration is big enough, and the Hosted domains page loses every file-derived name with an
error written in bytes. A cap per file, and a line saying the list was cut, is the fix.

### Looked at, nothing found

- **No ReDoS and no YAML bomb in the hosted-domains parsers.** A throwaway hostile-input script put
  junk, 1 MB of whitespace after `server_name`, a 1 MB unterminated directive, 250,000 repeated
  directives and a 9^7 YAML alias bomb through both parsers. Everything is linear, and the `yaml`
  package refuses the alias expansion itself (28 bytes out, 1.4 ms). The only thing the probe found
  is B5, which it found by measuring output size rather than time.
- **No orphaned settings keys.** All 42 literal `getSetting`/`setSetting` keys have both a reader
  and a writer in production. The seven that first looked one-sided (`githubLogins`,
  `lvmSnapshots`, `agentsKnownDomains` and four more) are read through a wrapper or through
  `getSetting?.()`, which the scan's pattern missed.

---

## Sweep 2 — code audit

**C5. The two retention paths are the same code twice, and have already drifted apart once.**
After renaming controller/VM and database/domain, `server/controller-retention-helper.mjs` and
`server/vm-retention-helper.mjs` share 136 of 164 lines, and `server/controller-retention.mjs` and
`server/vm-retention.mjs` 98 of 164. `server/vm-recovery-helper.mjs` and
`server/vm-restore-drill-helper.mjs` share their input validators the same way. This is
root-running code that decides which backups may be deleted.

The drift is not hypothetical. Both helpers validate restic's snapshot evidence on line 84, and the
lines are identical except for one clause:

- controller: `typeof snapshot.time !== "string" || !Number.isFinite(Date.parse(snapshot.time))`
- VM: `typeof snapshot.time !== "string"`

So a snapshot whose `time` is a string but not a date is refused on the controller path and accepted
on the VM path. Traced downstream, nothing breaks today — the VM page formats an unparseable date as
"missing" rather than NaN — so this is not a live bug. It is the evidence that one side got hardened
and the other did not, in the exact place where that is expensive, and it will happen again while
the code is two copies. `complete` is computed with a third term on the controller side
(`&& verifiedAfter !== null`, with a comment explaining what went wrong without it) that the VM side
reaches differently, through its own `after.ready` throw; worth reading together when they merge.

**C6. Nothing enforces the clock discipline, which is why B1 and B4 both exist.**
`AGENTS.md` has said to inject clocks since before either bug; both were written anyway, a month
apart, in different modules. Exports got a check in M52.5 for the same reason. This one is harder —
deciding whether a `Date.now()` is a forbidden dated value or a legitimate duration measurement
needs scope, and a naive rule produces 86 hits of which about 4 are real, which is worse than no
rule. Worth one attempt at the narrow version: inside a function that has an injected `now` in
scope, a `Date.now()` or `new Date()` whose value is stored or compared rather than subtracted.

---

## Sweep 2 — security audit

**S1. A security guard with a fail-open default.** `server/routes/virtualization.mjs:15`:

    const csrf = auth?.requireCsrf ?? ((_request, _response, next) => next());

`index.mjs` passes `auth`, so CSRF is enforced in production and this is not a live hole. But the
default on a missing dependency is "no CSRF check" rather than a refusal, so a future caller that
forgets `auth` loses the protection silently, on the two routes that take a multi-gigabyte upload
and a creation preview. No other router in `server/routes/` defaults a guard this way.

### Looked at, nothing found

- **CSRF coverage is complete.** A scan for mutating routes without `requireCsrf` on the same line
  returned 27, and every one is explained: the ten `agent-runner` routes are mounted ahead of
  `requireSession` and authenticated by the loopback-only bearer key, where there is no cookie to
  forge; the sign-in routes in `identity.mjs` and `passkeys.mjs` run before a session exists; and
  the rest reach CSRF through a spread guard array the scan could not see
  (`const manage = [auth.requireSession, auth.requireCsrf]`, `passkeys.mjs:57`,
  `identity.mjs:12`). The session cookie is `SameSite=Strict` on top of that.
- **Outbound requests are bounded and pinned.** The GitHub API read uses `redirect: "error"` with a
  15-second timeout; both `github.com/<user>.keys` reads go through `readBounded(…, 256 KiB)` and a
  strict username pattern (`server/routes/host.mjs:189`, `server/ops/users.mjs:39`); the Zulip task
  talks to `127.0.0.1` with an explicit `Host` header. M50 did this work and it holds.

---

## What sweep 2 changed (M53.1-M53.5, 2026-11-04)

`npm run check` green afterwards: 518 test files / 5647 tests, plus the export and sweep-coverage
checks and the new lint rule.

- **The auth service's clock** (`server/security.mjs`): all five wall-clock reads now go through the
  injected `now`. `server/session-clock.test.mjs` is new and tests what could not be tested before:
  that the elevated window ends on the service's clock and stops excusing a high-risk approval from
  its password, and that the "signed out because the address changed" memory lapses after the
  session's twelve hours. Four of its tests fail against the old code.

  A fifth test was written for the trusted-device `createdAt` and then deleted: `rememberDevice` is
  only reachable through identity sign-in, so the test asserted on a record it had written itself and
  passed against the wall-clock code too. A test that cannot fail is worse than none.

  Found on the way: `clientKeyFor` called `resolveClientAddress(request).catch(...)`, so a resolver
  that answers without a promise turned a rate-limit key into a 500 — while `clientDescriptor`, ten
  lines up, called the same dependency defensively. Both do now.

- **Per-file bounds on the hosted-domains read** (`server/hosted-domains-sources.mjs`): 500 names
  per file, 500 ingress rules per file, and nothing over 2 MiB parsed at all, since 50,000 rules
  cost 454 ms of the event loop before any rule cap could apply. The 4.1 MB and 4.3 MB answers
  measured in sweep 2 are now 40 KB and 9.4 KB. A file that was cut says so, and `hosted-domains.mjs`
  turns that into the page's existing `problem` line, naming the files.

- **One retention path** (`server/restic-retention.mjs`, new): the input validator, the snapshot
  inventory reader, the set digest, the restic runner and the dedicated-mount check, shared by both
  helpers, which drop from 175 and 199 lines to 119 and 143. `parseSnapshotInventory` carries the
  controller side's `Number.isFinite(Date.parse(snapshot.time))`, so the VM path now rejects the
  unparseable timestamp it used to accept. `server/restic-retention.test.mjs` holds both paths to
  the same answers for the same reasons. The VM path's "Retention accepts only fixed typed evidence
  fields" is now "VM retention accepts only…", which names which backups are meant.

  Not folded: the service layers (`controller-retention.mjs`, `vm-retention.mjs`, 98 of 164 lines
  shared) and the `vm-recovery-helper.mjs` / `vm-restore-drill-helper.mjs` input validators. The
  helpers were the half that validates what root deletes; the rest is sweep 3's.

- **A guard that refuses** (`server/routes/virtualization.mjs`): `auth?.requireCsrf` no longer
  defaults to a middleware that calls `next()`. A missing guard throws at startup, where it is one
  stack trace, instead of at request time, where it was nothing at all.

- **The clock rule** (`eslint-rules/use-the-injected-clock.mjs`): see M53.5 for what it reports and
  what it deliberately does not. Recorded there too: that the TypeScript compiler API is gone in
  TypeScript 7, and that the rule's first two versions reported 151 false positives before the
  parameter-default check looked at every enclosing function rather than the innermost one.

Still open: nothing from sweep 2. Sweep 3 of code, bug and security is next, with the retention
service layers already named as a starting point; the usability, visual and quality-of-life sweeps
have their coverage ledger and have not run.

---

## The export check was inert on a working copy (found by CI, 2026-11-04)

`check:exports` passed locally and failed on PR #640. The check was right in CI and wrong here, and
the reason is worth keeping: its corpus was built by walking the filesystem, and
`npm run demo:publish` leaves built bundles in `demo-site/public/assets/`, gitignored. A bundle
contains every name in the app, so every export looked read, and the check that was supposed to stop
the export surface from growing reported "275 of 275 reviewed" while seeing nothing.

The corpus now comes from `git ls-files`, which is the one list a checkout and CI agree on; a build
artifact in someone's working copy cannot decide the answer. Probed by putting an untracked bundle
naming a new unread export in place and confirming the check still reports it.

It had been hiding one real finding: `growableVolumes` in `src/looks/blend/StorageLead.tsx`, used
only inside its own file. The export is gone.

The lesson for the other two checks: `check:sweeps` reads two tracked files and has no corpus, and
the clock rule runs inside ESLint over an explicit file list, so neither can go inert this way. A
check whose input is "whatever is on disk" can; one whose input is "what is committed" cannot.

---

## The checks are checked now (M54)

The lesson from the two inert checks above is written into the repo rather than into this file only:
every `check:*` script of ours and every rule in `eslint-rules/` ships with a test that plants
something wrong and shows the check fails on it, and
`test/checks-have-self-tests.test.mjs` fails on one that does not. 68 new tests, including the two
bugs that shipped — the allowlist inside its own corpus, and the untracked bundle that named every
export — kept as cases so neither can come back.

Two things that turned up while writing them:

- `npm run lint` did not cover `eslint-rules/`, so the rule enforcing a convention was itself
  unlinted. It does now, and the meta-test asserts it.
- `check:syntax` and `check:shell` had no test either, and predate all of this. They now have eight
  cases. They were never at risk of going inert the way the export check did: a check that parses
  every file it can find errs towards checking too much. Worth saying out loud, because it is the
  distinction that matters — a check whose input is "whatever is on disk" is safe when extra input
  means more work and dangerous when extra input means more excuses.

### And one level up: an invariant test that passes over nothing

The same fault as the inert check, in the tests. "Every operator-approvable operation has been
looked at" is satisfied by an empty list without looking at anything, and a broken import or a
filter that stops matching would make it green. Four were in that state, `escalation-inventory`
among them. Each now asserts the size of its subject first, and the demonstration is worth keeping:
collapsing that filter to match nothing left both original assertions passing and failed only the
new floor.

About 200 other loops over computed collections have no size assertion. They were looked at and left:
nearly all are intermediate loops in tests that assert plenty else, where an empty collection is not
the test's whole claim. The distinction that matters is whether the breadth of the collection *is*
the thing being proved.

### The layers, finished

Four questions, each the same question one level further out, and each now held by something:

1. Does the check fail on a bad input? — self-tests, M54.1-3.
2. Does the invariant test cover anything? — size floors, M54.4.
3. Does the test file run at all? — `test/every-test-runs.test.mjs`, M54.5.
4. Does anything run the check? — the gate guard, M54.6, which also holds CI to running the gate
   whole rather than step by step.

Each was probed by making it fail on purpose, not by reasoning that it would. Three of the four were
real at the time of writing: the export check could not fail, `escalation-inventory` passed over an
empty list, and a test file sat outside every include pattern.

---

## Sweep 3 — security audit

**S2. BoxPilot raises a finding when nothing can reach the owner, and none when anyone who takes the
GitHub account can replace the whole server.** Signed releases are opt-in.
`server/release-signer.mjs` says what that means in its own second paragraph: "Without a key set, an
update builds whatever commit the GitHub tag points at, so whoever controls the GitHub account
controls every server." With a key set, the upgrade script refuses anything `git verify-tag` does not
attribute to it.

The verification itself is the most careful code I have read in this repo. `git verify-tag` with
`gpg.ssh.allowedSignersFile`, and `gpg.openpgp.program=/bin/false` and `gpg.x509.program=/bin/false`
beside it, so a PGP or X.509 signature block cannot satisfy the check by sending git to a different
program; and the tag is checked to point at the expected commit, because verify-tag checks the
signature and not the name. Nothing is wrong there.

What is missing is that the posture is only ever shown, never raised. System → BoxPilot update says
"Signed releases: not required". There is no finding, no health alert, no Today card. Compare
`nothingCanReachYou` (`server/remediations.mjs:651`), which is the same shape — a posture, not a
failure, with no notification target — raised as a warning with a fix attached. "Nobody checks that
an update is really yours" is the same kind of fact about the same box, with higher stakes.

The fix is the documented way to add one: a detector in `remediations.mjs`, the signer state passed
into the scan's facts. It is an operator-only read (`system.update.status` carries
`minimumRole: "operator"`), so it belongs with the scan's other operator reads under ADR-003.

### Looked at, nothing found

- **The support bundle redacts everything it collects**, at the end, in one pass
  (`server/support-bundle.mjs:62`), and ships `redactor.metadata()` so a reader knows the policy.
  Probed the redactor with a nested secret, an array of arrays, a secret split across a newline, a
  Basic header, a credential in a URL, a JWT, an AWS key and a private-key block: all redacted, and
  the kept prefixes (`ghp_[REDACTED]`, `AKIA[REDACTED]`) are deliberate.
- **Object keys are not walked** by the redactor, so a secret used as a key would survive. Left as a
  note, not a finding: every key in the bundle comes from code — fixed log sources, operation ids,
  app ids, audit detail names — and none is user-supplied.
- **A `Map`, an `Error` or a `Buffer` would redact to `{}` or to its bytes.** Unreachable:
  `settled()` turns a rejection into `{ status: "unavailable" }` and drops the reason, and
  everything else in the bundle is parsed JSON. Worth knowing that "unavailable" never says why,
  which is a usability question for that sweep rather than a security one.

---

## Sweep 3 — bug audit

**B6. `parseLsblkTree` hangs forever on a self-referential device-mapper parent, and it hangs the
whole web process.** `server/storage-inventory.mjs:63`:

    let parent = (row.pkname ? byKname.get(row.pkname) : null) ?? row.visitParent ?? null;
    while (parent && internal(parent)) parent = (parent.pkname ? byKname.get(parent.pkname) : null) ?? parent.visitParent ?? null;

The loop climbs past LVM's internal `-real` and `-cow` nodes to the first real parent, with no
visited set. A row whose `pkname` is its own `kname`, on a node whose name ends in `-real`, makes
`parent` resolve to itself for ever. Confirmed by probe: a 12-second timeout kills it.

This is synchronous and in the web process, so it is not a slow page — it is the event loop, and
every BoxPilot request with it. Against that: the input is always live `/usr/bin/lsblk --json`
output (the only caller is `storage-inventory.mjs:207`, plus a demo fixture); it is never read from a
file, a stored snapshot or a request, and the kernel does not report a device as its own parent. So
a latent hang, not a live fault. Worth the two lines anyway, because the failure mode is total and
the guard costs nothing.

The sibling loop is safe and was checked: `walk` follows the rebuilt `children` map, and two rows
that claim each other as parent end up in neither `roots` nor anybody's children, so they are
dropped rather than looped. Silently dropped, which is its own small untidiness.

---

## Sweep 3 — code audit

**C7. The two VM restore validators share 34 lines of restic evidence checking, and now have
somewhere to go.** `server/vm-recovery-helper.mjs:20` and `server/vm-restore-drill-helper.mjs:53`
validate the same fields the same way — `repositoryId`, `snapshotId`,
`expectedManifestChecksumSha256` against `shaPattern`, `expectedSizeBytes` as a positive safe
integer, `expectedDestinationRevision`. This is the family `server/restic-retention.mjs` was created
for in M53.3, which already holds `shaPattern` and the retention request validator. Folding it there
is the same move, with the home already built.

**C8. The retention service layers share less than the line count suggests, and the part worth
sharing is the dangerous part.** 98 of 164 lines match after renaming, but only 56 are substantive,
and most of those are domain wording that should stay apart: the policies differ
(`minimumCopies` against `minimumCopiesPerDomain`, `preserveActiveControllerOperations` against
`preserveRecoverySources`), the candidates differ (a protection record against a backup record), and
the claims each name what they keep unchanged. Unlike the helpers in M53.3, this is not drift.

What is worth sharing is the result-verification predicate — the compound condition that decides
whether a forget did exactly what was approved (`afterCount !== beforeCount - forgotten.length`, the
revision comparisons, every approved id absent and every other id present). Sweep 2 already found
the two sides computing `complete` differently. That predicate is where a one-sided change is
expensive; the wording is where sharing would cost readability.

### Looked at, little found

- Duplicated five-line blocks across files are down from 118 to 104 since M53.3.
- Three of the twelve look Homes repeat the "which needs to show, which were just fixed" logic, and
  four repeat `runOf`. Small, and `src/looks/` already has shared pieces (`LookHome.tsx`,
  `findingWords.ts`) for it to move into if anyone touches that code anyway. Not worth a change of
  its own.

## What sweep 3 changed (M55.1-M55.4, 2026-11-04)

`npm run check` green: 524 test files / 5743 tests, 22 of them new.

- **The unsigned-update posture is raised, not just displayed.** `releasesNotChecked` in
  `server/remediations.mjs`, fed by a new internal read (`system.update.signer`) rather than by
  `system.update.status`, which answers the same question with eighty journal lines and a systemctl
  listing beside it. An operator read, as that operation is (ADR-003), so a viewer's scan does not
  make it and says "Signed releases (needs an operator)" instead. No one-click fix: the owner has to
  paste the public half of a key only they hold, which is the point of it, so the finding carries
  `manual` advice naming the page and the `git tag -s` incantation. Four tests on the detector, four
  on the scan wiring.
- **The lsblk walk is bounded**, and a device BoxPilot cannot place is now listed rather than
  dropped. That second part cost a second fix: walking a row the tree had never reached followed the
  cycle the drop had been hiding, and recursed until the stack gave out. `walk` carries its own
  visited set now, and the test that caught it is in the file.
- **The VM restore validators share their restic evidence checks** through
  `restoreEvidenceErrors` in `server/restic-retention.mjs`, the module M53.3 built for this family.
  Both paths are held to the same answers for the same reasons in one test.
- **The retention result-verification predicate is shared** (`retentionEvidenceHolds`), with
  `sameArray` beside it, and each caller keeps its own message and its own candidate mapping. The
  domain wording, the policies and the records stay apart, as sweep 3 said they should. Seven cases,
  including the one that matters: an unverified repository is not held to what is left in it.

Four tests needed updating, all of them real contract changes rather than noise: the internal-read
count, two `unavailableChecks` lists, and the viewer's row in the route matrix, which now names one
more operator-gated check — the same thing it already said about the other four.

---

## Sweep 4 — the returns thinned, as expected

Two findings against four or five in each earlier sweep, and the security sweep came up empty for
the first time. Ground: concurrency, the escaping that carries an owner's settings into Docker,
credentials at rest, and how much of the operation registry any test has ever named.

### Bug

**B7. A setting value ending in a backslash escapes its own closing quote in the `.env` file.**
`envFileLine` (`server/catalog/compose.mjs:32`) writes `NAME='value'` and escapes `'` as `\'`,
with the comment that `\'` is "the one escape it recognises inside. (Verified against docker compose
config.)" If that is the model, then a value ending in `\` produces
`ADMIN_PASSWORD='abc\'` — where the trailing backslash and the closing quote together read as an
escaped quote, and the value never terminates. The next line of the file is then inside it.

Reachable: `resolveValues` rejects NULs and line breaks in an env value
(`server/catalog/schema.mjs:568`) and caps the length, but not a backslash. The existing test covers
a value with a dollar sign and a quote, and round-trips it; no case ends in a backslash.

**Verified on the box afterwards, and it is worse than this said: compose rejects the whole file.**
See M56.1 for the measured table of what each quoting form does in compose 2.40.3. The short of it:
single quotes have no backslash escape, so a value ending in one cannot be written at all; double
quotes escape `\\`, `\"` and `\$`, so every value can be. Fixed by writing the double-quoted form,
with the reader taking all three forms a box may have on it.

The original note, kept because being unable to check was the right thing to say at the time:
**I could not verify this.** Confirming it needs `docker compose config` against a
written `.env`, and the Docker socket is not reachable from here. The finding rests on the module's
own documented model of the parser, which it says was verified. The first thing to do is to check it
on the real box; if `\\` is in fact an escape, there is nothing here and the comment is what needs
correcting.

### Code

**C9. Ten of the 265 registry operations have never been named in any test.** Four of them change
the host: `backup.remote.setup`, `tailscale.serve.socket`, `dns.names.clear`, `vpn.profile.clear`.
Six are reads: `app.updates.inspect`, `app.stats.inspect`, `storage.fs-snapshots.inspect`,
`backup.remote.inspect`, `samba.diagnose`, `vpn.profile.inspect`. "Named in a test" is a floor, not
a measure of coverage — but an operation no test mentions is certainly not tested, and 96% of the
registry being named makes the ten stand out rather than look like a norm.

### Looked at, nothing found

- **Lost updates across an `await`.** A scan for `getSetting(K)` … `await` … `setSetting(K)` found
  four, and all four are handled: held notifications re-read the key after the send and remove only
  what went (`notifications.mjs:213`, with the comment saying why); the runner key serialises
  issuance through a promise chain; the power-loss record re-checks inside `updateSetting`'s
  transaction; and the runbook's two halves are different functions where last-writer-wins is the
  intended meaning. Three of the four carry a comment showing the author saw this coming.
- **Injection through compose generation.** `composeLiteral` doubles `$` so an owner's value cannot
  interpolate another setting, and the document goes through `YAML.stringify`, which quotes a value
  containing a newline — so there is no structural YAML injection even before the schema rejects
  line breaks. Probed with `${…}`, bare `$`, pre-doubled `$$`, an embedded `services:` block and a
  colon.
- **Credentials at rest, and the names BoxPilot keeps for itself.** The store is a root-owned 0600
  file in the helper's directory, the web process never holds a value, and the four managed names
  are refused at four places: the registry parameter field for `credentials.set`, `credentials.remove`
  and the agents' connector (which is also where a proposed agent or assistant step is checked), and
  again inside `tasks/http-request.mjs` and `tasks/agents.mjs`. `http.request` is owner-only on top
  of that. The guard the comment describes is complete, and deeper than the comment claims.

### Sweep 4's findings are both fixed

M56.1 verified on the box and fixed by writing `.env` values double-quoted; M56.2 fixed by testing
all ten operations and then making the measurement an invariant
(`server/ops/every-operation-is-named-by-a-test.test.mjs`).

That makes four sweeps where every finding was closed. The counters: code and bug are at four sweeps
with no empty one; security has one of the three empty sweeps it needs. The honest read is that the
two active categories are close to done — sweep 4 produced two findings against four or five, and
both were in places a sweep had to go looking for rather than things that fell out of reading the
code. Worth deciding on the evidence rather than grinding to three empties on principle.

Three guards now exist that did not when the loop started, each from a finding that would otherwise
recur: `check:exports`, `check:sweeps`, the clock lint rule, the self-tests that hold all of those
to failing on bad input, and this registry invariant. That is the loop's real output — the findings
were the occasion.

### A test of mine asserted a fact about my laptop

`storage.fs-snapshots.inspect` reads whether the btrfs and zfs tools are on the host before running
anything. The test I wrote for it asserted they were **absent** — true here, false on the Linux
runner, which has btrfs-progs. Green locally, red on CI.

`AGENTS.md` already says this ("a run on macOS should be green, so a failure there is a regression
worth chasing", and platform-gated tests come from `test/platform.mjs`). The rule I actually broke is
narrower and worth writing down as its own: **assert what the code does, not what the machine has.**
A `skipIf` would have been the wrong fix here — the operation's real property is that it answers with
a shape instead of failing, whatever tools are installed, and that is now what the test says.

Audited the rest of this session's new tests for the same mistake afterwards — and the audit was no
good. It grepped for the tokens of the bug I had just fixed (`toolPresent`, `existsSync`, absolute
paths) instead of asking the question the bug was an instance of. CI then failed again, on
`samba.diagnose`, where the host-dependent assertion was `expect(run).toHaveBeenCalled()`:
`sambaDiagnose` stops at its first check when `/usr/sbin/smbd` is absent, macOS ships it and the
Linux runner does not, so the runner is called here and not there. The same mistake in the opposite
direction, in the same batch of tests, missed by an audit I had just reported as done.

The second audit asked the real question — for each operation these tests drive, does its code probe
the host before it touches an injected dependency? — and went through them one at a time. Three more
places were host-dependent, two of them latent rather than failing:

- `samba.diagnose`: fixed to assert the shape of the checks it answers with.
- `tailscale.serve.socket`: the behaviour assertion is gone. It drove the real move, which stops when
  BoxPilot's socket is absent — true on a laptop and on CI, false on a real BoxPilot host, where that
  test would have behaved differently. The move has its own tests; what was untested here was the
  operation's shape.
- `app.stats.inspect`: asserted the docker binary's path, which comes from
  `BOXPILOT_DOCKER_BINARY`. Now asserts the arguments, which are the operation's own.

Written into `AGENTS.md` as a convention, because grepping for the last instance is not how this
gets caught: **assert what the code does, not what the machine has.** A `skipIf` is the wrong fix —
the property worth testing is that the read answers at all, whatever is installed.
