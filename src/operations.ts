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
export async function waitForJob(jobId: string, { intervalMs = 2000, timeoutMs = 2 * 60 * 60 * 1000, sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)) } = {}): Promise<Job> {
  const started = Date.now();
  for (;;) {
    const { job } = await getJob(jobId);
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
 * Follow a job's live output. Calls `onOutput` with appended text and `onState` once when the job
 * reaches a terminal state. Returns a function that stops following.
 */
export function followJobOutput(jobId: string, { onOutput, onState }: { onOutput: (text: string) => void; onState: (state: { state: string; error: string | null }) => void }): () => void {
  if (typeof EventSource === "undefined") return () => {};
  const source = new EventSource(`/api/v1/jobs/${encodeURIComponent(jobId)}/stream`);
  source.addEventListener("output", (event) => { try { onOutput((JSON.parse((event as MessageEvent).data) as { text: string }).text); } catch { /* ignore malformed */ } });
  source.addEventListener("state", (event) => { try { onState(JSON.parse((event as MessageEvent).data) as { state: string; error: string | null }); } catch { /* ignore */ } source.close(); });
  source.onerror = () => { /* the poller in waitForJob still finishes the job; the stream is best-effort */ };
  return () => source.close();
}
