# BoxPilot reliability, security, performance, and repair review

Date: 2026-09-07. Source baseline: 1.114.0, commit b1a012b, plus the local systemd-manager fix a0a2bbe. This is a focused engineering review with live read-only measurements, not a penetration-test certificate or a long-duration leak test. Production was not changed.

## Decision

Prioritize truthful diagnostics and recovery that works when BoxPilot itself is damaged. Instrument resource use before imposing limits or adding aggressive automatic cleanup. Extend M27, M28, M29, and M30; add M32 only for workload and resource accounting, which has no existing complete owner.

## Corrections implemented in this review

| Finding | Impact | Correction | Verification |
| --- | --- | --- | --- |
| A failed remediation request became null, then zero findings rendered as healthy | Repair could reassure the owner when it had not checked the server | Failed and partial scans say Checks incomplete; source failures are named; other successful page sections remain available | Failed/partial React regression cases and full checks |
| The remediation route swallowed four collector failures | HTTP success with an empty findings array was indistinguishable from a complete scan | Response now includes sourceStatus and unavailableChecks | HTTP route regression exercises collector failures; UI covers partial state |
| shared.forget only cleared the held value | A read begun before a mutation could repopulate the cache afterward; new callers could join the old request | Generation-aware invalidation; old callers still receive their result, but it cannot refill or clear the newer generation | Deterministic overlapping-read regression; latent utility bug, no production forget caller found in this sweep |
| Synchronous shared reads could throw before a promise existed | Promise callers could miss their error path | Read invocation is scheduled inside the promise | Synchronous failure/retry regression |
| API no-store check was case-sensitive while Express routes are not | Uppercase API paths omitted the privacy cache header | Normalize path casing for header classification | Real HTTP test for /API/v1/thing |
| Recovery export included all users' job metadata despite scoped /jobs access | A viewer/operator could retrieve cross-account job titles, IDs and timestamps, plus the full recovery inventory | Full recovery export is owner-only; general Repair findings remain available | Owner/operator/viewer HTTP tests, alternate path casing |
| qs 6.15.3 affected by two moderate advisories | Dependency-level denial-of-service exposure; application exploitability was not demonstrated | Lockfile updated to 6.16.0 | Clean install, build/test suite, npm audit |

Dependency references: [isBuffer advisory](https://github.com/advisories/GHSA-4mjr-xmp4-gh2g), [array-limit advisory](https://github.com/advisories/GHSA-x5fp-wj9c-mxmx). Audit initially reported one vulnerable package with two advisories; after the update, the full dependency audit reported zero known vulnerabilities. This does not prove absence of application vulnerabilities.

## Live resource findings

Read-only observations were collected around 12:18-12:20 UTC from the running 1.114.0 deployment. Host identifiers and raw logs are deliberately omitted from this committed report.

| Measurement | Observation | Interpretation |
| --- | --- | --- |
| Service uptime | About 35.3 hours for both BoxPilot processes | Long enough to inspect accumulated accounting, not to establish a leak slope |
| Host uptime/load | About 17 days; load 0.15 / 0.08 / 0.08 | Little runnable work at the sampled moment |
| RAM | 30 GiB total; about 27.3 GiB available | No current host memory shortage |
| Swap | About 203 MiB used | Allocation alone does not establish active swapping or memory pressure |
| Web cgroup memory | About 60.5 MiB current; 57 MiB anonymous | Modest current charge |
| Helper cgroup memory | About 4.44 GiB current; 4.25 GiB file cache; 102 MiB anonymous | Most of the apparent usage is file cache, not JavaScript heap |
| Process RSS | Web about 120 MiB; helper about 156 MiB | RSS and cgroup accounting measure different things and must not be added together |
| OOM/restarts | Zero cgroup OOM kills and zero service restarts | No evidence of this failure mode in the current service lifetime |
| CPU time since start | Web about 11 seconds; helper about 145 seconds | Roughly 0.009% and 0.114% of one CPU averaged over uptime; includes cgroup work, not just JS |
| Pressure | Memory avg10/60/300 zero; CPU averages zero; IO some/full avg10 about 0.39% | No sustained pressure shown by this short observation |
| Root filesystem | 20% used | No immediate capacity incident |
| Cgroup IO | Web about 17 MiB written; helper about 1.13 GiB read / 3.14 GiB written | Lifetime totals include executed work. Underlying and device-mapper counters duplicate the same traffic; never sum both |
| Logs | No warning-or-higher entries in the selected service journals over 24 hours; one successful 20-folder data scan observed | Narrow journal evidence, not a claim that every job or service was healthy |

Two RSS observations roughly 95 seconds apart were almost unchanged. That is not a soak test and cannot rule out a slow or workload-specific leak. A monitoring container appeared at roughly 5.9% lifetime CPU in ps, higher than BoxPilot's processes; this is a candidate for measurement, not evidence of a fault or authorization to disable it.

Do not drop Linux file caches as a repair. The live helper figure is precisely why the UI should distinguish anonymous memory, file cache, RSS, heap used, external buffers, and actual memory pressure. Avoid a low fixed MemoryMax that mistakes cached backup reads for a runaway process.

## Remaining findings and confidence

1. **High priority: helper response buffering and stream backpressure.** helper-client.mjs concatenates socket data into an unrestricted string. Heartbeat lines are retained until completion; request timeout is socket inactivity, so progress can keep a connection alive. routes/jobs.mjs writes SSE frames without reacting to slow-consumer backpressure. These are source-confirmed unbounded-buffer paths, not demonstrated production leaks. Add explicit byte budgets, parse/discard heartbeat frames incrementally, retain a hard overall deadline, cap per-session stream count, and disconnect a slow consumer cleanly. Test a stalled client and a continuously heartbeating helper locally.
2. **High priority: staged secret lifetime.** jobs.mjs retains entries while their job remains awaiting approval. The daily prune does not impose a 30-minute expiry. This is confirmed retention, already owned by M29.2. Expire both the secret and the approval state together; require re-entry on re-stage. Do not silently run without a dropped secret.
3. **Medium priority: authorization-code capacity.** oidc.mjs prunes expired codes when issuing codes but has no hard cardinality limit. Issuance is after consent, so this is not an established unauthenticated exploit. Add a per-account and global bound without evicting an active security throttle. Existing whois, passkey, and container-existence caches already have bounds; do not replace those unnecessarily.
4. **Medium priority: expensive scans still lack cost visibility.** Repair fans out into storage, applications, Samba, USB history, prerequisites, and recovery. Shared helper reads, batched service inspection, and 10-second inventory caches already reduce work. needrestart holds results for ten minutes but has separate cache logic; measure concurrent calls and invalidation after ordinary service restarts. Give all expensive checks age, duration, cache-hit and in-flight metrics before tuning TTLs.
5. **Medium priority: scan scheduling can be gentler.** App data usage is already sequential, filesystem-limited, has a 25-minute global deadline, and persists a minimum gap across restarts. Those are valuable protections. It still invokes du without explicit nice/ionice in the inspected path. Add pressure-aware deferral, idle IO priority where available, and a visible paused/partial state. Preserve manual override. Do not replace this with frequent recursive walks.
6. **Medium priority: alert checks can overlap.** health-alerts.mjs uses asynchronous interval callbacks without an in-flight guard. Normal timeouts make overlap unlikely, but slow notifications or a custom interval can race persisted state. Coalesce checks and persist the reason a scheduled run was skipped. Test with injected timers and deferred notifications.
7. **High value: controller-down recovery.** A helper canary inside the web UI cannot repair the web UI when it is unavailable. The existing doctor script is the right foundation for an independent recovery command. It must inspect service/socket/log permissions, free bytes and inodes, deployed build/version agreement, DB readability and backup availability without depending on Express.
8. **High value: verify repairs from new evidence.** Current findings generally stage ordinary operations, which is good. A job completing does not always establish that the original fault is gone. Store before/after evidence, invalidate the relevant cached checks, run only affected detectors, and report resolved/still broken/could not verify. Group mount and bound-container faults into one root-cause repair under M26.1.
9. **Usability: certainty and disclosure.** Some existing drive copy diagnoses cable/USB causes from symptoms that can have multiple causes. Separate observed facts from likely explanations. The recovery export's assertion that it has no credentials should not imply it is public: names, paths, versions, topology, and job titles are still private operational information. Use a short finding with expandable evidence, impact, estimated duration and recovery steps.
10. **Scope gap: restore behavior under failure.** A dedicated database restore rehearsal, helper-down recovery, version rollback, low-space recovery, and interrupted package recovery need local fault-injection tests and eventually disposable Ubuntu VM checks. None was performed against the live server in this review.

## Proposed repair tools

| Tool | Detect first | Reviewable action | Completion evidence / limits | Milestone owner |
| --- | --- | --- | --- | --- |
| Repair BoxPilot itself | Service, helper socket, log access, runtime/build mismatch | Reinstall known service files or known-good release; restart only required services | Fresh health endpoint and helper canary; retain prior release; independent CLI works while UI is down | M30.5 |
| Recover interrupted package installation | dpkg audit, active apt/dpkg process and real lock ownership | Configure pending packages, then dependency repair with an exact preview | Clean dpkg audit; never delete lock files or kill apt just because a job is slow | M30.6 |
| Recover database safely | Disk/inode capacity, DB open/quick-check, journal and schema status | Create recovery copy, validate backup, restore while writer is stopped | Compatible schema, restart and read verification; preserve original; no live WAL deletion | M30.7 |
| Restore known-good BoxPilot release | Failed update or version/build disagreement | Roll back immutable release after DB compatibility check | Web/helper version match and smoke test; schema migration may require paired restore | M30.5 |
| Relieve full disk without losing app data | Root bytes/inodes, journal, cache and managed job-log usage | Select categories to reclaim with sizes/retention preview | Recheck available space; preserve active logs, latest good backups and application volumes | M30.8 |
| Repair stale status | Detector age, failed collectors, relevant completed mutation | Retry affected collector and invalidate the corresponding cache | Fresh timestamp and resolved/still failing result; never equate cache clearing with host repair | M27.5 / M32.2 |
| Repair app deployment | Unhealthy managed app, config validation, mounts, image availability | Restart, recreate from saved config, or revert image as distinct choices | Healthcheck and reachability; persistent volumes remain; detect database downgrade incompatibility | Existing M22, linked from M30.9 |
| Restore selected data | Verified backup catalog and target path | Browse, restore to alternate location, compare, then replace after approval | Checksums/content comparison, app stop window and retained original | Existing M20/M31, linked from M30.9 |

Automatic remediation should be opt-in per recipe with a cooldown, maximum attempts, fresh preconditions, an audit record and a stop condition. Repeatedly restarting an app or remounting a failing drive is not recovery. Irreversible work needs its existing high-risk approval.

## Browser readability observations

The built desktop demo rendered the updated Repair summary without a crash. The default fixture showed 6 of 7 prerequisites ready, while the prerequisite rows appeared below two large recovery sections. The page repeats a feature banner, an introduction, a scan summary and a prerequisite summary before reaching much of the evidence. These are specific opportunities for M28.5: put counts next to their rows, shorten the introduction, and make uncertainty visually distinct from healthy status. Export copy now calls the download private recovery information and asks for a protected second copy.

## Validation boundaries

Local automated build, TypeScript, 1,451 tests across 213 files, syntax, lint, shell checks and dependency audit passed. Live checks were observational only. Browser review uses the real built UI with fictional demo data; it does not validate the live authenticated page, actual repair execution, mobile layout, or VoiceOver. No production load test, heap snapshot, disk benchmark, destructive repair, reboot, filesystem check, restore drill, or deployment was run.
