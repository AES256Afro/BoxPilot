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
