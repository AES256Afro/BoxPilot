# BoxPilot 1.115.0 reliability and recovery review

This review covers source inspection, focused failure fixtures, disposable Ubuntu checks, browser use with fictional data, and read-only observation of the existing 1.114.0 deployment. The requested work window is 7 September 2026, 12:29:10-16:29:10 UTC. The implementation log is [four-hour-progress](2026-09-07-four-hour-progress.md); the [initial review](2026-09-07-reliability-review.md) records the starting findings, some of which are now resolved below.

## Outcome

The update fixes the invalid systemd-manager restart and adds recovery tools that work through the existing operation registry. It also addresses source-confirmed unbounded buffers, stale diagnostics, secret exposure, unsafe cleanup assumptions and misleading status displays. It does not establish that every possible bug or memory leak has been eliminated. Source publication, hosted installation tests and production deployment are separate outcomes; production was observed without being upgraded or repaired.

## Changes that matter

| Area | Problem found | Result in 1.115.0 |
| --- | --- | --- |
| Update recovery | `systemd-manager` was treated as a service unit | A fixed, parameter-free manager refresh uses `systemctl daemon-reexec`, with its own reviewed operation and accurate UI wording |
| Repair evidence | Failed collectors could produce an apparently healthy empty result; reads begun before a change could refill the cache | Partial checks name missing evidence, successful sections survive, shared caches track generations, and relevant evidence is invalidated before completion events |
| Package recovery | Interrupted package configuration needed a diagnosis and usable repair path | Manual audit, dependency simulation and actual kernel-lock inspection precede a reviewed no-remove repair and fresh verification |
| BoxPilot recovery | UI-only checks cannot explain a failed web service | Independent installation and database doctor modes work from the console; manual UI inspectors cover service/socket/assets/capacity and isolated database health |
| Configuration privacy | Normal app configuration returned raw Compose and undeclared environment values; edited Compose could be saved in job parameters | Unknown values are masked, raw files require elevated owner access and bounded fixed-file reads, and new edits use temporary secret parameters |
| Authentication | Damaged SSO keys could be replaced; pending grants and saturated throttle state lacked reliable ceilings | Existing identity is preserved on damage, ordinary login remains usable, pending grants expire within explicit capacity limits, and active login blocks survive saturation |
| Memory and concurrency | Helper reply strings, waiting readers, event streams and job logs could retain unbounded work or data | Incremental parsing, byte/deadline limits, helper admission and cancellation, stream backpressure, bounded browser/server logs and physical secret expiry |
| Restoration and cleanup | Cleanup could lose track of image aliases or previous restore evidence; failures could overstate rollback or retention success | Complete inventory is required, restore originals survive until health/backup checks pass, failed cleanup remains visible, and only verified saved logs can be released |
| Diagnostic workload | Repeated folder scans and overlapping requests added avoidable work; app statistics had a Set/array error | Coalesced reads, supported idle IO/nice priority, pressure-aware scheduling, shared-folder measurements, and restored installed-app statistics |
| Usability | Activity depended on its event stream, warnings were hard to read, and keyboard focus escaped important dialogs | Bounded sequential polling fallback, honest stale/loading/error states, clearer warnings and evidence, focus/Escape handling in approval, Activity and configuration dialogs, clipboard-denial feedback and inline passkey renaming |
| Backup truthfulness | Historical records looked like current files; failed retention could claim removal | Backup history explains the age of its evidence, completed jobs retain follow-up notices, and cleanup results report successful removals accurately |

The package recovery, systemd manager refresh and cleanup controls are reviewable actions. They do not enable unattended restarts or repairs by default.

## Validation

- The 1.115.0 full check passes: TypeScript/build, 1,627 tests across 234 files, JavaScript syntax, ESLint and shell syntax.
- The retained-memory workload exercises shared helper sockets, stream close/abort, SSO exchange and throttle churn. The local 3,500-cycle workload retained approximately 78 KiB additional heap after warmup and garbage collection, within the stated 8 MiB regression budget. Outstanding helper work, stream reservations and pending grants returned to zero. This is a synthetic regression test, not an application-wide leak proof.
- Disposable Ubuntu 24.04 checks exercise deliberately interrupted package configuration, fresh/idempotent recovery, refusal while a real package lock is held, root-owned log release, independent database ownership and low-priority filesystem measurements.
- Hosted native install tests exercise the real services and authenticated helper paths, including independent diagnosis with the web service stopped and database checks with both services stopped.
- The final deep browser sweep reported zero problems across 3 scenarios and 18 pages (54 combinations), after opening 558 controls. Browser checks use the compiled UI and fictional scenarios. They cover actual rendered flows and selected keyboard behavior. They are distinct from production authorization tests, which are covered by HTTP and unit fixtures.
- The dependency update removed the two reported qs advisories; the dependency audit returned zero known vulnerabilities at review time. No penetration-test certification is implied.

The final application source is `1329fe15949d18d72de8324ac32f8ceb00790669`: [hosted CI](https://github.com/AES256Afro/BoxPilot/actions/runs/34142543904) and [native installation](https://github.com/AES256Afro/BoxPilot/actions/runs/34142543882) both passed. The release tag uses this tested application tree; subsequent review-document changes do not change the application. The existing deployment's heap has not been profiled, no production load test was run, and no live database, package state, service or application was mutated.

## Browser memory follow-up

A separate same-document experiment ran 400 cycles, each switching through App catalog, Storage and Repair, then opening and closing Activity. After garbage collection every checkpoint retained one document, 688 DOM nodes, 323 JavaScript event listeners and no open dialogs. There were no runtime errors. After two warmup batches, peak retained JavaScript heap growth was 276,204 bytes (about 270 KiB); the last 100 cycles added about 7 KiB. The browser-native `embedderHeapUsedSize` counter increased by approximately 3.7 MiB over the measured interval.

The stable object counts and slowing JavaScript heap increase are useful evidence for these paths. The native-counter increase remains unexplained and is carried into M32.5 for allocation profiling and a longer run. It is not identified as a production BoxPilot leak, nor is it dismissed as harmless. The experiment used headless Chrome and fictional demo data; it did not exercise every workflow or production data volume.

## What the resource evidence can establish

The minute sampler records service identity, CPU accounting, process RSS/anonymous memory, cgroup anonymous/file memory, OOM and restart counters. A separate before/after read captures cgroup IO and kernel pressure near the end of the window. Raw operational data stays outside the public source tree.

Large cgroup file-memory accounting is not JavaScript heap. The [kernel accounting reference](https://docs.kernel.org/admin-guide/cgroup-v2.html) defines file memory as cached filesystem data including shared memory, which was checked separately in the live snapshot. A short stable anonymous-memory trend argues against a fast idle leak in the observed workload, but does not rule out slow retention or growth triggered by backups, restores, browsing or heavy app churn. There is no basis here for flushing Linux caches, imposing a small blanket helper memory limit, or repeatedly restarting a healthy service. New resource budgets target identified data/work queues and expensive scans instead.

## Remaining milestones, ordered by value

| Priority and owner | Next deliverable | Acceptance evidence |
| --- | --- | --- |
| P1, M29.1/3/4/6 | Complete composite-route/private-data audit and review historical raw-configuration job copies | Every route has a role test; new raw values stay out of durable controller job records; any historical credential cleanup preserves audit and recovery requirements |
| P1, M30.5 | Known-good BoxPilot release repair and rollback independent of the UI | Disposable failed-upgrade fixture restores both services, preserves configuration and checks database compatibility before rollback |
| P1, M30.7 | Offline database recovery and a complete restore rehearsal | Preserve the database and WAL, validate the chosen backup/schema, stop the writer, restore and verify service; original evidence remains recoverable |
| P1, M27.5 and M32.2 | Detector-specific post-repair verification and cache visibility | Each repair reports resolved, still failing or could not verify from new evidence; collector age/cost/cache hits are visible without extra scans |
| P1, M30.6 | Bind the package repair preview to execution | Detect a changed dependency plan and competing BoxPilot package work before proceeding; retain the real-lock and no-remove protections |
| P2, M30.8 | Low-space recovery with current backup availability | Reconcile history with files and repository copies; distinguish missing from unknown; show real byte/inode gains without deleting active logs or the last good backup |
| P2, M32.3/5 | Representative IO contention and 24-72 hour disposable-host soak | Measure retained heap, listeners/timers, child processes, read/write counts and pressure across backup, scan, failed-helper and browser churn; define budgets from the baseline |
| P2, M28.5 and M30.9 | Unified repair recipes and broader keyboard/reading review | Group symptoms by root cause; explicit detect/action/verify/recovery steps; opt-in automation has cooldown, attempt limit and stop conditions |

M20/M22/M26/M31 retain ownership of existing backup, app repair, mount recovery and selective restore behavior. New recipes should call those operations rather than create competing implementations. The detailed dependency and acceptance plan remains [ROADMAP-V2](../ROADMAP-V2.md).

## Publication

The application is versioned as [BoxPilot v1.115.0](https://github.com/AES256Afro/BoxPilot/releases/tag/v1.115.0), using the tested application commit `1329fe1`. The workflow builds and tests the tag before publishing. The review and milestone documents on main may be newer than that application commit. The observed production installation remains 1.114.0; publishing this update does not deploy it.
