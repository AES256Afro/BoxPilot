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

export interface ApprovalPolicy { confirmText?: string | null; minimumRole?: string | null;
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

export function getJob(jobId: string): Promise<{ job: Job }> {
  return fetch(`/api/v1/jobs/${encodeURIComponent(jobId)}`).then((response) => readJson(response));
}

export const terminalJobStates = new Set(["completed", "failed", "cancelled"]);

/** Poll until the job reaches a terminal state. */
/** Poll until the job finishes, tolerating a few failed polls (a restart, a sleeping laptop). */
export async function waitForJob(jobId: string, { intervalMs = 2000, timeoutMs = 2 * 60 * 60 * 1000, sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)) } = {}): Promise<Job> {
  const started = Date.now();
  let failures = 0;
  for (;;) {
    let job: Job;
    try {
      ({ job } = await getJob(jobId));
      failures = 0;
    } catch (error) {
      failures += 1;
      if (failures >= 5) throw error;
      await sleep(intervalMs);
      continue;
    }
    if (terminalJobStates.has(job.state)) return job;
    if (Date.now() - started > timeoutMs) throw new Error("Timed out waiting for the job to finish");
    await sleep(intervalMs);
  }
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

  const stopPolling = () => { if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; } if (startTimer) { clearTimeout(startTimer); startTimer = null; } };

  const poll = async () => {
    if (stopped || streamWon()) return;
    try {
      const response = await fetch(`/api/v1/jobs/${encoded}/output`);
      if (!response.ok) return;
      const body = (await response.json()) as { output?: string; state?: string; error?: string | null };
      if (stopped || streamWon()) return;
      if (typeof body.output === "string" && body.output.length > 0) {
        race.winner = "poll";
        onOutput(body.output, false);  // the whole log so far, so the dialog replaces rather than appends
      }
      if (body.state && ["completed", "failed", "cancelled"].includes(body.state)) {
        onState({ state: body.state, error: body.error ?? null });
        stopPolling();
      }
    } catch { /* the job poller still finishes the job; output is best-effort */ }
  };

  if (typeof EventSource !== "undefined") {
    source = new EventSource(`/api/v1/jobs/${encoded}/stream`);
    source.addEventListener("output", (event) => {
      if (race.winner === "poll") return;
      race.winner = "stream";
      stopPolling();
      try { onOutput((JSON.parse((event as MessageEvent).data) as { text: string }).text, true); } catch { /* ignore malformed */ }
    });
    source.addEventListener("state", (event) => {
      try { onState(JSON.parse((event as MessageEvent).data) as { state: string; error: string | null }); } catch { /* ignore */ }
      source?.close();
    });
    source.onerror = () => { /* the poller below and waitForJob both still finish the job */ };
  }

  // Each ask returns the whole log, so a long operation asking every second would fetch the same
  // growing file thousands of times. The gap widens towards a ceiling: quick while the owner is
  // watching the first lines appear, unhurried once an install has been running for a while.
  const scheduleNextPoll = (delay: number) => {
    if (stopped || streamWon()) return;
    pollTimer = setTimeout(async () => {
      await poll();
      scheduleNextPoll(Math.min(Math.round(delay * 1.4), maxPollEveryMs));
    }, delay);
  };
  startTimer = setTimeout(() => { void poll(); scheduleNextPoll(pollEveryMs); }, pollAfterMs);

  return () => { stopped = true; stopPolling(); source?.close(); };
}

