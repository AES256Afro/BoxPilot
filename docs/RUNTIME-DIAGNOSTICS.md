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

Job output also has independent bounds: each writer limits lines to 64 KiB and its accumulated output to 4 MiB, while a read of a damaged or old oversized file allocates at most 4 MiB plus three UTF-8 boundary bytes. This is not a shared inter-process file-size lock; separate producers can overlap. The fixed canary replaces its previous output and reports failure if a new probe cannot be written.

After a successful job, BoxPilot saves its output in SQLite and asks the helper to release the live cache. The helper opens the existing database read-only and compares the entire bounded log with the saved bytes. Only a completed job with an identical copy is eligible. Missing copies, failed jobs, oversized or changed logs, symlinks and unexpected ownership retain the file. Root producers flush pending output before reporting completion. The web account gains no directory write permission, and cleanup uses a separate helper lane so it does not wait behind a long package operation. Existing housekeeping remains responsible for old retained logs; this is not a bulk deletion of historical output.
