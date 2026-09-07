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
