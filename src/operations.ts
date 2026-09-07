/** Client for the operation registry and the generic job path (ADR-001). */
import { readJson } from "./http";

export type RiskTier = "low" | "medium" | "high";

export interface OperationDescription {
  id: string;
  title: string;
  description: string;
  risk: RiskTier;
  readOnly: boolean;
  timeoutMs: number;
  parameterNames: string[];
}

export interface ApprovalPolicy { expiresAt?: string | null; expired?: boolean; confirmText?: string | null; minimumRole?: string | null;
  jobId?: string;
  tier: RiskTier;
  passwordRequired: boolean;
  elevated: boolean;
  mode: "tiered" | "always-password";
  reason: string;
}

export interface JobStep { name: string; state: string; detail: string; createdAt: string }

export interface Job {
  id: string;
  type: string;
  title: string;
  state: "awaiting_approval" | "applying" | "verifying" | "completed" | "failed" | string;
  risk: string;
  error: string | null;
  result: unknown;
  createdAt?: string;
  updatedAt?: string;
  steps: JobStep[];
  approvals: Array<{ ownerId: string; method?: string; tier?: string; createdAt: string }>;
}

export function listOperations(): Promise<{ operations: OperationDescription[] }> {
  return fetch("/api/v1/operations").then((response) => readJson(response));
}

/** Run a parameter-free read-only operation immediately. */
export function inspectOperation<T>(id: string): Promise<{ operation: string; result: T }> {
  return fetch(`/api/v1/operations/${encodeURIComponent(id)}/inspect`).then((response) => readJson(response));
}

/** Stage a mutating operation as a job; returns the job and what approving it will need. */
export function stageOperation(id: string, parameters: Record<string, unknown>, csrfToken: string): Promise<{ job: Job; approval: ApprovalPolicy }> {
  return fetch(`/api/v1/operations/${encodeURIComponent(id)}/jobs`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-BoxPilot-CSRF": csrfToken },
    body: JSON.stringify({ parameters }),
  }).then((response) => readJson(response));
}

export function approveJob(jobId: string, csrfToken: string, password?: string, confirmText?: string): Promise<{ job: Job; elevatedUntil: string | null }> {
  return fetch(`/api/v1/jobs/${encodeURIComponent(jobId)}/approve`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-BoxPilot-CSRF": csrfToken },
    body: JSON.stringify({ ...(password ? { password } : {}), ...(confirmText ? { confirmText } : {}) }),
  }).then((response) => readJson(response));
}

/** Withdraw a job that is still awaiting approval (the dialog was dismissed). */
export function cancelJob(jobId: string, csrfToken: string): Promise<{ job: Job }> {
  return fetch(`/api/v1/jobs/${encodeURIComponent(jobId)}`, { method: "DELETE", headers: { "X-BoxPilot-CSRF": csrfToken } }).then((response) => readJson(response));
}

export function getJob(jobId: string, { signal }: { signal?: AbortSignal } = {}): Promise<{ job: Job }> {
  return fetch(`/api/v1/jobs/${encodeURIComponent(jobId)}`, { signal }).then((response) => readJson(response));
}

export const terminalJobStates = new Set(["completed", "failed", "cancelled"]);

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(signal.reason); return; }
    const onAbort = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", onAbort); resolve(); }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** Wait for completion; abandoning the view cancels observation, not the host job. */
export async function waitForJob(jobId: string, { intervalMs = 2000, timeoutMs = 2 * 60 * 60 * 1000, sleep = abortableSleep, now = Date.now, signal }: { intervalMs?: number; timeoutMs?: number; sleep?: (ms: number, signal: AbortSignal) => Promise<void>; now?: () => number; signal?: AbortSignal } = {}): Promise<Job> {
  const started = now();
  const controller = new AbortController();
  const onAbort = () => controller.abort(signal?.reason);
  if (signal?.aborted) onAbort();
  else signal?.addEventListener("abort", onAbort, { once: true });
  const deadline = setTimeout(() => controller.abort(new Error("Timed out waiting for the job to finish")), timeoutMs);
  let failures = 0;
  try { for (;;) {
    controller.signal.throwIfAborted();
    if (now() - started >= timeoutMs) throw new Error("Timed out waiting for the job to finish");
    let job: Job;
    try {
      ({ job } = await getJob(jobId, { signal: controller.signal }));
      controller.signal.throwIfAborted();
      failures = 0;
    } catch (error) {
      controller.signal.throwIfAborted();
      failures += 1;
      if (failures >= 5) throw error;
      await sleep(intervalMs, controller.signal);
      continue;
    }
    if (terminalJobStates.has(job.state)) return job;
    await sleep(intervalMs, controller.signal);
  } } finally { clearTimeout(deadline); signal?.removeEventListener("abort", onAbort); }
}

/**
 * Follow all job activity for the Activity drawer: `onSnapshot` with recent jobs on (re)connect,
 * then `onJob` with a fresh snapshot of each job as it changes. Returns a function that stops.
 */
export function followJobs({ onSnapshot, onJob }: { onSnapshot: (jobs: Job[]) => void; onJob: (job: Job) => void }): () => void {
  if (typeof EventSource === "undefined") return () => {};
  const source = new EventSource("/api/v1/events");
  source.addEventListener("snapshot", (event) => { try { onSnapshot((JSON.parse((event as MessageEvent).data) as { jobs: Job[] }).jobs); } catch { /* ignore malformed */ } });
  source.addEventListener("job", (event) => { try { onJob((JSON.parse((event as MessageEvent).data) as { job: Job }).job); } catch { /* ignore malformed */ } });
  source.onerror = () => { /* EventSource reconnects on its own; each reconnect re-sends the snapshot */ };
  return () => source.close();
}

/**
 * Follow a job's live output, by stream if the stream reaches us and by asking repeatedly if not.
 *
 * The stream alone was not enough. Server-sent events travel fine over a direct connection and are
 * held back by proxies that buffer a response until it ends — Tailscale Serve fronts this server on
 * a tailnet, and reaching BoxPilot that way meant a medium-risk operation sat on "Waiting for
 * output..." for its whole run and then finished all at once. An operation that looks frozen is one
 * people cancel half way through, which is the moment you least want them to.
 *
 * So both are started. Whichever speaks first wins and the other is ignored, because the stream
 * appends fragments while asking returns the whole log, and mixing the two would duplicate every
 * line. Asking waits a moment first, so a working stream is the normal path and polling is the
 * exception rather than a second request on every job.
 */
export function followJobOutput(
  jobId: string,
  { onOutput, onState, pollAfterMs = 2500, pollEveryMs = 1200, maxPollEveryMs = 6000 }:
  { onOutput: (text: string, append: boolean) => void; onState: (state: { state: string; error: string | null }) => void; pollAfterMs?: number; pollEveryMs?: number; maxPollEveryMs?: number },
): () => void {
  const encoded = encodeURIComponent(jobId);
  let source: EventSource | null = null;
  const race: { winner: "stream" | "poll" | null } = { winner: null };
  // Read through a call: the checker narrows a plain field after the first guard and does not
  // account for the await in between, which can change it.
  const streamWon = () => race.winner === "stream";
  let pollTimer: ReturnType<typeof setTimeout> | null = null;
  let startTimer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  // Set when a poll sees the job finished. `stopped` belongs to the consumer; this belongs to the
  // job, and a timer that had already fired when the job finished used to re-arm the poll anyway.
  let finished = false;
  let polling = false;
  const controller = new AbortController();

  const stopPolling = () => { if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; } if (startTimer) { clearTimeout(startTimer); startTimer = null; } };

  const poll = async () => {
    if (stopped || finished || streamWon() || polling) return;
    polling = true;
    try {
      const response = await fetch(`/api/v1/jobs/${encoded}/output`, { signal: controller.signal });
      if (!response.ok) return;
      const body = (await response.json()) as { output?: string; state?: string; error?: string | null };
      if (stopped || finished || streamWon()) return;
      if (typeof body.output === "string" && body.output.length > 0) {
        race.winner = "poll";
        source?.close();
        onOutput(body.output, false);  // the whole log so far, so the dialog replaces rather than appends
      }
      if (body.state && ["completed", "failed", "cancelled"].includes(body.state)) {
        onState({ state: body.state, error: body.error ?? null });
        finished = true; stopPolling(); source?.close();
      }
    } catch { /* the job poller still finishes the job; output is best-effort */ }
    finally { polling = false; }
  };

  if (typeof EventSource !== "undefined") {
    source = new EventSource(`/api/v1/jobs/${encoded}/stream`);
    source.addEventListener("output", (event) => {
      if (stopped || finished || race.winner === "poll") return;
      try {
        const text = (JSON.parse((event as MessageEvent).data) as { text: unknown }).text;
        if (typeof text !== "string" || !text.length) return;
        race.winner = "stream"; stopPolling();
        onOutput(text, true);
      } catch { /* ignore malformed */ }
    });
    source.addEventListener("state", (event) => {
      if (stopped || finished) return;
      try {
        const state = JSON.parse((event as MessageEvent).data) as { state: string; error: string | null };
        if (!terminalJobStates.has(state.state)) return;
        finished = true; stopPolling(); source?.close(); controller.abort(); onState(state);
      } catch { /* ignore malformed */ }
    });
    source.onerror = () => {
      if (stopped || finished) return;
      // Reconnecting restarts a stream at byte zero. Use full-output replacement after a
      // disconnect so replayed lines cannot accumulate in the browser indefinitely.
      source?.close(); race.winner = "poll"; stopPolling(); scheduleNextPoll(0);
    };
  }

  // Each ask returns the whole log, so a long operation asking every second would fetch the same
  // growing file thousands of times. The gap widens towards a ceiling: quick while the owner is
  // watching the first lines appear, unhurried once an install has been running for a while.
  const scheduleNextPoll = (delay: number) => {
    if (stopped || finished || streamWon()) return;
    if (pollTimer) clearTimeout(pollTimer);
    pollTimer = setTimeout(async () => {
      pollTimer = null;
      await poll();
      scheduleNextPoll(Math.max(1, Math.min(Math.max(pollEveryMs, Math.round(delay * 1.4)), maxPollEveryMs)));
    }, delay);
  };
  startTimer = setTimeout(async () => { await poll(); scheduleNextPoll(pollEveryMs); }, pollAfterMs);

  return () => { stopped = true; stopPolling(); controller.abort(); source?.close(); };
}
