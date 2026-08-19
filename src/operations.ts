/** Client for the operation registry and the generic job path (ADR-001). */

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

export interface ApprovalPolicy {
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
  steps: JobStep[];
  approvals: Array<{ ownerId: string; method?: string; tier?: string; createdAt: string }>;
}

async function readJson<T>(response: Response): Promise<T> {
  const body = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) throw new Error(body.error ?? `Request failed (${response.status})`);
  return body;
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

export function approveJob(jobId: string, csrfToken: string, password?: string): Promise<{ job: Job; elevatedUntil: string | null }> {
  return fetch(`/api/v1/jobs/${encodeURIComponent(jobId)}/approve`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-BoxPilot-CSRF": csrfToken },
    body: JSON.stringify(password ? { password } : {}),
  }).then((response) => readJson(response));
}

export function getJob(jobId: string): Promise<{ job: Job }> {
  return fetch(`/api/v1/jobs/${encodeURIComponent(jobId)}`).then((response) => readJson(response));
}

export const terminalJobStates = new Set(["completed", "failed"]);

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
