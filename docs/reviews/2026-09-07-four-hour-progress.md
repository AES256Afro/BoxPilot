# Four-hour reliability implementation

Window: 2026-09-07 12:29:10-16:29:10 UTC. Continue accepted priorities, testing each slice. Production remains unchanged unless a later authorized release/deployment is performed. This log records implementation, not elapsed-time completion.

## First slice: connection bounds, secret expiry, resource inspection

- M32.4: incremental helper replies, 32 MiB frame ceiling, hard overall deadline, and queue heartbeat discard; account/global SSE budgets, buffered-byte/stall bounds, Unicode-preserving output chunks and cleanup after flush/close.
- M29.2: 30-minute deadline for secret-bearing approvals, persisted non-secret expiry metadata, minute cleanup, restart-safe approval refusal, and visible dialog expiry. Physical cleanup is on the next minute sweep; authorization expires at the deadline.
- M32.1 first slice: manual Repair Center resource check; web/helper heap, RSS, external and Linux file-cache/anonymous accounting; CPU interval, version, OOM, pressure and resource-type data in the API. No recurring disk scan or extra child process.
- M32.2 first slice: shared-cache counters and helper request counts, without cached values or credentials in diagnostic metadata.
- Documentation: RUNTIME-DIAGNOSTICS.md. The roadmap distinguishes local implementation from deployment and remaining trend/soak work.

Validation: npm run check passed with 1,468 tests across 217 files, including build, TypeScript, syntax, lint and shell checks. Built desktop demo: manually opened Repair, ran Check resource use, and verified distinct heap and Linux file-cache rows. Demo values are fictional. Production execution and long-duration soak remain unverified.

Next: finish partial source availability and coalescing/invalidation, then independent recovery/doctor tools. Also review the new paths for response cleanup and expiry edge cases before release. A heartbeat for this task resumes work if idle, and must stop starting new slices at 16:29:10 UTC.

## Second local slice: fresh and complete evidence

- Mount-command failures, unreadable fstab and missing application definitions now make Repair checks incomplete while preserving successful collectors.
- Inventory, prerequisites and needrestart use one generation-safe cache implementation. Needrestart shares concurrent expensive scans and reports the evidence timestamp; Updates says when the scan failed.
- Settled mutations invalidate relevant evidence before a terminal job event can prompt the browser to reload it. Read-only operations and unrelated disk-usage scans are left alone. Partial failures also invalidate evidence.
- Overlapping health checks share one evaluation, avoiding duplicate notifications before state is saved. Unknown evidence preserves previously detected, unannounced conditions.
- Regression coverage includes pending pre-repair reads, partial/malformed storage results, notification overlap and invalidation failures preserving the real job outcome.

Second-slice validation: full check passed with 1,482 tests across 219 files. Committed as 4a06809.

## Third local slice: interrupted package recovery

- Manual package health inspection and reviewed package repair in Repair Center, reusing the operation registry, approvals and generic runner.
- Kernel lock ownership distinguishes active work from normal persistent lock files. Busy or unknown evidence prevents a repair from starting.
- No-remove dependency repair, repeated execution-time diagnosis and final audit/simulation. Healthy state is a no-op; failed verification cannot claim repair succeeded.
- Fixed the existing dpkg configuration step to suppress needrestart consistently with the APT step.
- Live Linux read-only diagnosis returned healthy with both audit and simulation succeeding. No package mutation or service restart was performed.

Validation: full check passed with 1,499 tests across 221 files. Interrupted Ubuntu mutation and deployment remain unverified. See PACKAGE-RECOVERY.md.

Third slice committed as e746d2f. The built demo's package diagnosis and medium-risk approval preview were manually inspected in the browser.

## Fourth local slice: independent installation doctor

- Added manual operator installation diagnostics in Repair Center and independent `--control-plane` / `--json` doctor entry points over SSH or console.
- Reports service identity/state, protected directory/socket metadata, assets, installed release and free bytes/inodes. CLI additionally compares bounded web/helper responses with the installed release.
- Missing connectivity preserves the rest of the evidence. Unreadable protected metadata is unknown, not a permission fault. No database, configuration or log contents are read.
- Live ordinary-account Linux inspection: 15 checks passed, 2 protected paths unknown. Elevated inspection requires interactive sudo and was not performed.
- Follow-up review moved diagnostic invalidation after durable result hooks, before terminal events, and shared the new manual inspectors across concurrent callers.

The source is not yet deployed. M30.5 still needs known-good repair/rollback and disposable Ubuntu recovery testing. The read-only sampler at /tmp/boxpilot-resource-sampler.py writes /tmp/boxpilot-resource-samples-20260907.jsonl every minute until 16:29:10 UTC. It runs as exec session 70169. Do not start a duplicate sampler. Inspect the trend near the deadline and preserve the distinction between RSS, anonymous memory and Linux file cache; this is not a JavaScript heap profile.

Fourth slice committed as 5ae4de0 with 1,507 tests across 224 files passing. The built demo's installation warning and independent-console instructions were inspected visually and through the accessibility tree.

## Disposable Ubuntu validation

The local Ubuntu 24.04 container test passed all of: deliberately interrupted package configuration, diagnosis, repair, fresh verification, idempotent repeat, refusal while a real kernel lock is held, and final cleanup. The container runs with no network, a read-only checkout mount and bounded CPU/memory. Added it to CI and extended native install smoke to prove doctor evidence remains available with the web service stopped. Hosted results are separate from local success.

The Repair summary now says Problem scan complete instead of a broad No problems found when optional manual diagnostics have not run or have separate findings.

## Hosted validation and log follow-up

Source through df66b3e was pushed to main and its remote SHA verified. Native install smoke passed, including independent doctor operation while Express was stopped. General CI passed all 1,507 assertions but failed on an unhandled ECONNRESET in the helper-client test server. That fixture omitted the production helper's socket error handling and attempted to use HTTP's closeAllConnections on net.Server. The fix tracks/closes real sockets and awaits cleanup.

The job-log review added bounded UTF-8 lines, per-writer byte budgets and bounded reads of oversized old files. The fixed canary now replaces its previous probe and requires a successful fresh write. This avoids treating old capped evidence as proof of current write access. Regression coverage includes a sparse oversized file, concurrent writes, Unicode truncation and failed canary writes. Root-owned live-log cleanup/retention remains a separate investigation because the web account cannot unlink inside a 0750 root-owned log directory.

Both hosted workflows passed for 8d49cac: general CI 34127578182 and native install smoke 34127578277. This includes the disposable Ubuntu package fixture and the independent doctor while Express is stopped.

## Completed-job live-cache cleanup

Confirmed that web-side unlink could not work under the installed root-owned 0750 log directory. Successful jobs now save their output before requesting a registered owner-level helper cleanup. The helper uses a read-only database connection, verifies completed state and a full byte-for-byte copy, and refuses changed, oversized, unsafe or unsaved logs. Failed job logs remain available. Producers flush pending writes before returning their result, and cleanup has an independent helper lane. The housekeeping inspector now requires operator access because its root-side backup listing is private operational information.

Local full check passed with 1,523 tests across 225 files. Extended the disposable Ubuntu fixture to prove the unprivileged web identity can read but cannot unlink a root-owned log, followed by successful helper cleanup of the saved copy. That fixture passed on Ubuntu 24.04. Production remains unchanged.

## Repair Center readability and missing data

Prerequisite rows now follow their count directly. Technical evidence, protection steps and the rebuild inventory use native expandable details; download formats stay visible. Increased Repair text size, unified severity labels, removed the repeated feature strip and replaced unconditional green readiness styling with a neutral surface. Missing prerequisite data clears old readiness counts, missing activity does not say nothing has run, and incomplete collector objects preserve the rest of the page.

Full check passed with 1,525 tests across 225 files. Browser inspection covered desktop and 390 px width, expanded evidence and keyboard navigation into a repair preview. It exposed a separate modal focus bug: focus remained behind the approval dialog. That is the next slice. Also fixed the local demo's scenario selection: only the fictional demo now sends same-origin referrers, allowing its troubled-server fixtures to run; production retains no-referrer.

Hosted CI and native install smoke passed for ebf3e87 and b8bd23f.

## Modal focus and abandoned browser work

Approval now receives and contains keyboard focus and restores the opener on dismissal. Browser verification confirmed Tab/Shift-Tab wrapping and Escape returning to the repair action. A late staging reply is withdrawn if its dialog has gone. An accepted job continues on the host while unmount aborts its observer and output requests. The waiter deadline now covers stalled requests as well as successful polls. Lost observation explains that Activity may still show a running job.

Output fallback now waits for a slow poll before scheduling another. A disconnected stream switches to full-output replacement, avoiding repeated log replay; malformed events preserve fallback, and terminal events stop both transports. Regression tests also caught and corrected a zero-delay fallback rescheduling loop during implementation. Full check passed with 1,537 tests across 226 files. Production remains unchanged.

## Bounded browser output and truthful log errors

Approval and Activity log views retain a 256 Ki-character tail with a visible truncation notice, preserving Unicode pairs and replacing full snapshots correctly. Job lookup and saved-output reads now abort on unmount and have 15-second deadlines. Failed reads show a retry action instead of claiming that the job had no output or staying on Reading indefinitely. Changing job ids clears a previous missing-job state. Full check passed with 1,542 tests across 227 files.

Hosted CI and native install smoke passed for 650ae0e and 860184d.

## Independent database diagnostics

Added operator-only `controller.database.inspect`, a separate manual database action in Repair Center and independent doctor `--database`. Core SQLite checks run in a child with a 15-second deadline, bounded V8 heap/cache target/output and no inherited secret environment. It reads no account or job values into the report and runs no migration, checkpoint, database replacement or journal deletion. Root drops the child's identity to the database owner so normal SQLite coordination files cannot become root-owned.

Fixtures cover committed WAL records, corruption, missing database/tables, foreign-key violations, symlinks, new-install account absence and a real child deadline. The Ubuntu integration preserves source bytes and proves the web identity can reopen the offline database after inspection. Local full check passed with 1,553 tests across 228 files. The built browser demo's database result and backup navigation were inspected. Native smoke now calls the registry inspector and adds database evidence with both services stopped; its hosted result is pending. Production database inspection and deployment have not been performed.

## Authentication state and signing-key preservation

The login throttle previously exceeded its capacity when every entry was an active block, and could reset a counter merely by updating it at full capacity. It now holds its configured bound, preserves active blocks, and delays an unknown caller only until the earliest slot can be reclaimed if every slot is blocked. A saturation fixture exercises 10,000 additional keys without growth. This deliberately trades a temporary password-login pause for bounded memory during saturation; existing authenticated sessions do not use this throttle.

SSO startup previously replaced the signing key after any read or parse failure. It now creates a key only when absent, uses exclusive creation and bounded no-follow reads, validates private permissions and P-256, and preserves damaged or incompatible files. An unavailable SSO identity no longer prevents ordinary BoxPilot startup: SSO endpoints report temporary unavailability, while owner client administration and a Settings recovery message remain available. Full check passed with 1,562 tests across 229 files.

Native testing confirmed that the independent database doctor works while both services are stopped. The authenticated helper inspector currently fails to launch its child with EPERM inside the service sandbox. The report now distinguishes that failure from a timeout; native privilege diagnostics are being used to resolve it before declaring this slice complete.
