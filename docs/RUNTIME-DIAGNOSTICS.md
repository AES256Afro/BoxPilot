# BoxPilot resource checks and connection limits

Repair Center includes **Check resource use**. It reads web/helper process counters and small Linux accounting files on demand. It starts no child processes, recursive directory walks, disk benchmarks or heap snapshots. Each process holds a reading for five seconds and shares concurrent reads. CPU percentages require two readings at least five seconds apart.

The table separates RSS, JavaScript heap, external buffers, anonymous memory and Linux file cache. Values overlap; do not add the columns or memory categories. Cgroup values include work charged to the service group. Linux may reclaim file cache when other work needs RAM. Missing Linux files produce Unavailable, not zero. A short sample cannot establish a memory leak.

`GET /api/v1/diagnostics/runtime` requires the normal signed-in session. It contains web/helper snapshots, version, uptime, CPU accounting, event-loop utilization, resource-type counts, cgroup memory and OOM counts, Linux pressure, helper request counters and shared-read statistics. It includes no process command lines, environment, logs, credential values or arbitrary filesystem paths. The helper snapshot also has a registered parameter-free read, `system.runtime.inspect`.

## Helper replies

Replies use incremental newline-delimited JSON. Queue heartbeat frames are validated and discarded. A single response frame is limited to 32 MiB in UTF-8, and an overall request deadline cannot be extended by heartbeat traffic. Existing socket inactivity deadlines remain. Exceeding the bound fails the request and closes the connection. The helper already skips abandoned queued mutations before starting them; a mutation that has started may continue, so a client timeout does not prove the command was cancelled.

## Live job streams

Activity and job-log streams have a shared budget: eight streams per account and 32 total. Extra connections receive HTTP 429 and Retry-After. A response retains at most eight MiB of buffered data and disconnects after 15 seconds without draining. Large log output is sent in chunks while yielding to backpressure. Stream listeners, timers and budget entries are released when the response finishes or closes, including failed and disconnected clients. An ending response holds its budget until its remaining output flushes.

The browser also cancels observation when an approval dialog is removed, including in-flight job and output reads. The server job continues after approval. A staging reply arriving after dismissal is withdrawn instead of leaving an unapproved job behind. Waiting has an overall deadline that also interrupts stalled requests. Output polling is sequential and backs off; if a working stream disconnects, the browser closes it and uses full-output replacement so reconnects do not append the same log again. Malformed events cannot disable polling, and terminal state stops both transports.

Approval and Activity terminals retain at most 256 Ki UTF-16 code units plus a short truncation notice. Earlier text is hidden in that view, while server-side output retention keeps its separate limits. Completed-log and individual-job reads have 15-second deadlines and abort on unmount. A failed read offers retry and does not claim the job recorded no output.

## Credentials awaiting approval

An operation staged with credentials receives a 30-minute approval deadline, stored as non-secret recovery metadata. The actual secret stays in memory. Approval checks the deadline even if the periodic sweep has not run or the service has restarted. A minute sweep removes expired secret records and cancels their pending jobs; expiry is enforced at exactly the deadline, and physical cleanup occurs on the next sweep, at most about a minute later while the process is responsive. Operations without staged secrets do not acquire this deadline.

The approval dialog shows the deadline and disables expired approvals. Close the expired dialog and stage the operation again to re-enter credentials. A service restart forgets all staged credentials, as before. No secret is added to SQLite, audit records or backups by this expiry mechanism.

## Verification

Tests cover 10,000 queue heartbeats without retained frame growth, oversized and malformed replies, an overall deadline while queue heartbeats arrive, slow-reader disconnects, connection-budget cleanup, Unicode log chunking, clock-controlled secret expiry and restart refusal, missing cgroup data, and separation of heap from file cache. These checks establish bounded behavior for the tested paths, not a production soak-test pass.

### Repeatable runtime retention check

Run `npm run check:retention` with Node 24 or newer. It starts temporary local Unix and HTTP sockets and uses synthetic accounts and signing keys. It never contacts or changes an installed BoxPilot host. The default runs two warmup batches followed by 12 measured batches of 250 cycles each. Each cycle shares a helper read between two callers, closes or abandons an event stream, exchanges an SSO grant and churns the bounded login throttle.

After each batch it collects garbage and verifies that helper requests, helper connections, event-stream reservations and pending authorization grants have returned to zero. The throttle must remain within 64 entries. JSON output includes heap, external buffers, RSS and active resource counts. The largest retained-heap increase after warmup must stay within an 8 MiB regression budget under a 128 MiB V8 heap limit. RSS is recorded, not judged as a leak by itself. Hosted CI runs six measured batches of 100 cycles; `--batches` and `--iterations` can increase the local workload.

This is a short synthetic regression test. It does not cover browser mount/unmount, representative disk contention, production load or a 24-72 hour soak, and a pass is not proof that the whole application has no memory leaks.

Job output also has independent bounds: each writer limits lines to 64 KiB and its accumulated output to 4 MiB, while a read of a damaged or old oversized file allocates at most 4 MiB plus three UTF-8 boundary bytes. This is not a shared inter-process file-size lock; separate producers can overlap. The fixed canary replaces its previous output and reports failure if a new probe cannot be written.

After a successful job, BoxPilot saves its output in SQLite and asks the helper to release the live cache. The helper opens the existing database read-only and compares the entire bounded log with the saved bytes. Only a completed job with an identical copy is eligible. Missing copies, failed jobs, oversized or changed logs, symlinks and unexpected ownership retain the file. Root producers flush pending output before reporting completion. The web account gains no directory write permission, and cleanup uses a separate helper lane so it does not wait behind a long package operation. Existing housekeeping remains responsible for old retained logs; this is not a bulk deletion of historical output.

## Scheduled scan cost

Application data measurements retain the existing sequential folder walk, filesystem boundary, per-folder timeout, 25-minute overall budget and persisted minimum gap. Concurrent calls now share one in-flight scan, and the background sampler persists one result for overlapping requests. Housekeeping reads also share concurrent work.

On Linux, folder scans request idle IO scheduling with `ionice -c 3 -t` and CPU nice level 10 when those tools are installed. `-t` allows the measurement to run when the kernel cannot apply that IO priority. The reported priority describes the request, not a guarantee that a particular storage scheduler honors it. A missing tool falls back to the supported portion of the command. See the [util-linux ionice manual](https://man7.org/linux/man-pages/man1/ionice.1.html).

Before a scheduled scan, three small `/proc/pressure` reads check the kernel's 60-second averages. The initial BoxPilot policy defers at memory full-stall 1%, IO full-stall 10%, or CPU some-stall 80%. These are scheduling thresholds, not hardware-failure diagnoses. Missing PSI does not become a zero reading or block measurement. The scheduler retains previous size history, records the reason, and retries after 30 minutes. An explicit manual measurement can bypass deferral. The Storage page distinguishes deferred work, failed work and measured data. The [kernel PSI documentation](https://docs.kernel.org/accounting/psi.html) defines these counters.

These changes were checked with injected pressure and overlapping calls, plus a disposable Ubuntu measurement using the actual priority wrapper. They have not yet been benchmarked under representative production IO contention. Per-device coordination and a 24-72 hour disposable-host soak remain milestone work.

Housekeeping filesystem inventories share a 100,000-entry and 60-second cooperative work budget, with depth capped at 64. Directory entries are streamed rather than loaded without a bound. Links and different filesystem devices are skipped. Reaching a limit produces an unavailable category, not a partial size advertised as complete. Other categories can still return useful results. A blocked kernel filesystem operation may outlast the cooperative deadline until it returns; this is not a hard subprocess timeout.

The helper permits eight active inspections, at most 32 waiting reads and 64 total connections. Excess work fails with retry guidance. Disconnecting releases a queued read before it starts; already-running approved host mutations continue under their existing lifecycle. A one-request socket does not retain extra input after parsing.
