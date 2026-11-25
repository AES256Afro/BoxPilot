/** Client for the operation registry and the generic job path (ADR-001). */
import { ApiError, isNetworkError, readJson } from "./http";
import { checkConnection, connected, connectionState, type ConnectionState } from "./pwa/connection";
import { pageIsFollowing, refreshAfterJob } from "./shell/refresh";

export type RiskTier = "low" | "medium" | "high";

export interface ApprovalPolicy { expiresAt?: string | null; expired?: boolean; confirmText?: string | null; minimumRole?: string | null;
  jobId?: string;
  tier: RiskTier;
  passwordRequired: boolean;
  elevated: boolean;
  mode: "tiered" | "always-password";
  reason: string;
}

export interface JobStep { name: string; state: string; detail: string; createdAt: string }

/**
 * A job that ran out of time (M30.3). `scope` says whose limit it was: the whole operation's, or
 * one step's inside it. `moreTimeMs` is the budget "Try again with more time" would give it, and
 * is null when that is not offered.
 */
export interface JobTimeout {
  scope: "operation" | "step";
  budgetMs: number;
  elapsedMs: number;
  phase: "queued" | "running";
  step: string | null;
  lastOutput: string | null;
  moreTimeMs: number | null;
  /** True when the step that ran out was left running on the server (a root task past its own limit). */
  stillRunning?: boolean;
  /** On a finding's last try: what it may have left running can no longer be (12 hours on, or let go). */
  settled?: boolean;
}

export interface Job {
  id: string;
  type: string;
  title: string;
  state: "awaiting_approval" | "applying" | "verifying" | "completed" | "failed" | string;
  risk: string;
  error: string | null;
  result: unknown;
  /** What it was staged with, secrets replaced by placeholders (app.backup's `id`, for instance). */
  parameters?: Record<string, unknown> | null;
  timeout?: JobTimeout | null;
  /** Where this run came from: a larger budget, or the run it repeats (M30.2/M30.3). */
  recovery?: {
    budgetMs?: number; rerunOf?: string; retryOf?: string; /** The operation's description, as staged. */ reason?: string;
    /** Set when it failed because BoxPilot's admin service did not answer (M89, server/jobs.mjs). */
    helperCode?: "helper_unavailable" | "helper_timeout" | "helper_closed" | "helper_restarting";
  };
  createdAt?: string;
  updatedAt?: string;
  steps: JobStep[];
  approvals: Array<{ ownerId: string; method?: string; tier?: string; createdAt: string }>;
}

/** Run a parameter-free read-only operation immediately. */
export function inspectOperation<T>(id: string): Promise<{ operation: string; result: T }> {
  return fetch(`/api/v1/operations/${encodeURIComponent(id)}/inspect`).then((response) => readJson(response));
}

/** Run a read-only operation that takes parameters, immediately (POST /operations/:id/run). */
export function runReadOperation<T>(id: string, parameters: Record<string, unknown>, csrfToken: string): Promise<{ operation: string; result: T }> {
  return fetch(`/api/v1/operations/${encodeURIComponent(id)}/run`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-BoxPilot-CSRF": csrfToken },
    body: JSON.stringify({ parameters }),
  }).then((response) => readJson(response));
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

/**
 * What a finished job showed once (its operation's oneTimeFields, M38: Zulip's organization link):
 * the server hands it to the person who ran the job the first time they ask, and never again.
 */
export function takeOneTimeResult(jobId: string, csrfToken: string): Promise<{ jobId: string; value: Record<string, unknown> }> {
  return fetch(`/api/v1/jobs/${encodeURIComponent(jobId)}/once`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-BoxPilot-CSRF": csrfToken },
    body: "{}",
  }).then((response) => readJson(response));
}

/** The result fields a finished job showed once, from its stored result. */
export function oneTimeFields(result: unknown): string[] {
  if (!result || typeof result !== "object" || !("oneTime" in result) || !Array.isArray(result.oneTime)) return [];
  return result.oneTime.filter((field): field is string => typeof field === "string").slice(0, 4);
}

/** What approving a staged job needs right now (elevation can lapse after staging). */
export function getJobApproval(jobId: string): Promise<ApprovalPolicy> {
  return fetch(`/api/v1/jobs/${encodeURIComponent(jobId)}/approval`).then((response) => readJson(response));
}

/**
 * "Try again with more time": stage the timed-out job's operation again with a larger budget. The
 * answer is the same as staging: a job awaiting approval, and what approving it needs.
 */
export function retryWithMoreTime(jobId: string, csrfToken: string): Promise<{ job: Job; approval: ApprovalPolicy }> {
  return fetch(`/api/v1/jobs/${encodeURIComponent(jobId)}/more-time`, { method: "POST", headers: { "X-BoxPilot-CSRF": csrfToken } }).then((response) => readJson(response));
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

/**
 * Whether BoxPilot answers right now, asked of the connection watcher (pwa/connection.ts): it asks
 * the health route at once, so a failed job read is judged by a fresh answer, not a minute-old one.
 */
async function boxPilotAnswers(): Promise<boolean> {
  return connected(await checkConnection());
}

/** How long the watcher waits between questions while BoxPilot is not answering. */
const lostPaceMs = 5000;

/**
 * Wait for completion; abandoning the view cancels observation, not the host job.
 *
 * A restart is not a failure (M89). While BoxPilot does not answer (a web or helper restart, a proxy's
 * 502, a phone between networks) the failed reads are not counted, and the gap between them widens to
 * the connection watcher's own pace. What ends the wait is the job ending, the server saying it has no
 * such job (404), the overall deadline, or five failed reads in a row while BoxPilot otherwise answers.
 */
export async function waitForJob(jobId: string, { intervalMs = 2000, timeoutMs = 2 * 60 * 60 * 1000, sleep = abortableSleep, now = Date.now, signal, answers = boxPilotAnswers, maxLostMs = lostPaceMs }: {
  intervalMs?: number;
  timeoutMs?: number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  now?: () => number;
  signal?: AbortSignal;
  /** Whether BoxPilot answers at all, asked after a failed read (the connection watcher, by default). */
  answers?: () => Promise<boolean>;
  /** The longest gap between reads while BoxPilot is not answering. */
  maxLostMs?: number;
} = {}): Promise<Job> {
  const started = now();
  const controller = new AbortController();
  const onAbort = () => controller.abort(signal?.reason);
  if (signal?.aborted) onAbort();
  else signal?.addEventListener("abort", onAbort, { once: true });
  const deadline = setTimeout(() => controller.abort(new Error("Timed out waiting for the job to finish")), timeoutMs);
  let failures = 0;
  let lost = 0;
  try { for (;;) {
    controller.signal.throwIfAborted();
    if (now() - started >= timeoutMs) throw new Error("Timed out waiting for the job to finish");
    let job: Job;
    try {
      ({ job } = await getJob(jobId, { signal: controller.signal }));
      controller.signal.throwIfAborted();
      failures = 0; lost = 0;
    } catch (error) {
      controller.signal.throwIfAborted();
      // The server answered that there is no such job: waiting longer will not change that.
      if (error instanceof ApiError && error.status === 404) throw error;
      const reachable = await answers().catch(() => false);
      controller.signal.throwIfAborted();
      if (reachable) {
        lost = 0;
        failures += 1;
        if (failures >= 5) throw error;
        await sleep(intervalMs, controller.signal);
      } else {
        // Not answering at all: not counted, and asked again at the watcher's pace.
        lost += 1;
        await sleep(Math.min(maxLostMs, Math.max(intervalMs, intervalMs * 2 ** (lost - 1))), controller.signal);
      }
      continue;
    }
    if (terminalJobStates.has(job.state)) return job;
    await sleep(intervalMs, controller.signal);
  } } finally { clearTimeout(deadline); signal?.removeEventListener("abort", onAbort); }
}

/**
 * True when an error from staging, approving or following a job means BoxPilot is not answering (no
 * reply, a proxy's 502/503/504, its admin service down, the connection watcher saying so) rather than
 * a refusal: a batch stops
 * there instead of sending the next job into a server that is not listening.
 */
export function lostConnection(error: unknown, connection: ConnectionState = connectionState()): boolean {
  if (isNetworkError(error)) return true;
  if (error instanceof ApiError && (error.status === 502 || error.status === 503 || error.status === 504)) return true;
  return !connected(connection);
}

/**
 * Follow all job activity for the Activity drawer: `onSnapshot` with recent jobs on (re)connect,
 * then `onJob` with a fresh snapshot of each job as it changes. Returns a function that stops.
 */
export type JobFeedStatus = "loading" | "live" | "polling" | "unavailable";

function readableJob(value: unknown): value is Job {
  return Boolean(value && typeof value === "object" && "id" in value && typeof value.id === "string" && "title" in value && typeof value.title === "string" && "state" in value && typeof value.state === "string" && "steps" in value && Array.isArray(value.steps));
}

interface JobFeedListener { onSnapshot: (jobs: Job[]) => void; onJob: (job: Job) => void; onStatus?: (status: JobFeedStatus) => void; pollAfterMs?: number; pollEveryMs?: number; /** The clock (the first follower's), for telling a job that has just ended from an old one. */ now?: () => number }

/*
 * One feed per tab (M50.2 left this for later): Activity follows jobs for the whole session and
 * Home's facts follow them while Home or Ops is open, and each opened its own /api/v1/events stream,
 * two of an account's eight. The first follower opens the feed; a later one is handed the last
 * snapshot, with every job event since folded in, and the status, at once; the last to leave closes it.
 */
const feed: { listeners: Set<JobFeedListener>; stop: (() => void) | null; jobs: Job[] | null; status: JobFeedStatus } = { listeners: new Set(), stop: null, jobs: null, status: "loading" };

/*
 * Which jobs the feed has already seen finished, so a page is told once when one ends (refresh.ts).
 * The first snapshot is history, not news. A job is news when it reaches a finished state after
 * that, by event or, where the stream is buffered, by turning up finished in a later snapshot.
 *
 * And only when it really has just ended: this tab saw it waiting or running, or its record was last
 * written in the last few seconds. A finished job older than the snapshot holds is not in
 * `seenFinished`, and anything said of it (a step added when its failure is dismissed, which does not
 * touch `updatedAt`) arrived looking like a job ending: "Dismiss all 40 failed" made the page
 * underneath read itself once a second for the whole run.
 */
let seenFinished: Set<string> | null = null;
const seenUnfinished = new Set<string>();
const justEndedMs = 10_000;
function noteFinished(jobs: Job[], snapshot: boolean, now: () => number): void {
  const finishedJobs = jobs.filter((job) => terminalJobStates.has(job.state));
  const finished = finishedJobs.map((job) => job.id);
  const unfinished = jobs.filter((job) => !terminalJobStates.has(job.state)).map((job) => job.id);
  if (!seenFinished) {
    if (snapshot) { seenFinished = new Set(finished); for (const id of unfinished) seenUnfinished.add(id); }
    return;
  }
  const fresh = finishedJobs.filter((job) => !seenFinished!.has(job.id));
  // A snapshot is the whole recent history: ids that have left it are forgotten with it.
  if (snapshot) seenFinished = new Set(finished);
  else for (const job of fresh) seenFinished.add(job.id);
  const news = fresh.filter((job) => {
    const ended = Date.parse(job.updatedAt ?? "");
    // A later snapshot holds only recent jobs, so one newly finished in it did end since the last.
    return snapshot || seenUnfinished.has(job.id) || (Number.isFinite(ended) && Math.abs(now() - ended) <= justEndedMs);
  });
  for (const id of finished) seenUnfinished.delete(id);
  for (const id of unfinished) seenUnfinished.add(id);
  // A job its own page is following to the end is that page's to read for (refresh.ts).
  if (news.some((job) => !pageIsFollowing(job.id))) refreshAfterJob();
}

const newestFirst = (jobs: Job[]) => [...jobs].sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? "")).slice(0, 50);

export function followJobs(listener: JobFeedListener): () => void {
  feed.listeners.add(listener);
  // A follower joining a feed that has given up starts it again: Activity's "Try refreshing" is a
  // stop and a follow, and with Home following too a stop alone no longer ends the feed.
  if (feed.stop && feed.status === "unavailable") { const stale = feed.stop; feed.stop = null; stale(); }
  if (!feed.stop) {
    feed.jobs = null;
    seenFinished = null;
    seenUnfinished.clear();
    feed.status = "loading";
    const now = listener.now ?? Date.now;
    const each = (call: (entry: JobFeedListener) => void) => { for (const entry of [...feed.listeners]) call(entry); };
    feed.stop = openJobFeed({
      onSnapshot: (jobs) => { feed.jobs = jobs; noteFinished(jobs, true, now); each((entry) => entry.onSnapshot(jobs)); },
      onJob: (job) => {
        if (feed.jobs) feed.jobs = newestFirst(feed.jobs.some((entry) => entry.id === job.id) ? feed.jobs.map((entry) => (entry.id === job.id ? job : entry)) : [job, ...feed.jobs]);
        noteFinished([job], false, now);
        each((entry) => entry.onJob(job));
      },
      onStatus: (status) => { feed.status = status; each((entry) => entry.onStatus?.(status)); },
      // The first follower's timings drive the shared feed; a later one's are not used.
      pollAfterMs: listener.pollAfterMs, pollEveryMs: listener.pollEveryMs,
    });
  } else {
    if (feed.jobs) listener.onSnapshot(feed.jobs);
    listener.onStatus?.(feed.status);
  }
  let left = false;
  return () => {
    if (left) return;
    left = true;
    feed.listeners.delete(listener);
    if (feed.listeners.size > 0) return;
    const stop = feed.stop;
    feed.stop = null;
    feed.jobs = null;
    seenFinished = null;
    seenUnfinished.clear();
    stop?.();
  };
}

/*
 * The feed's transport (M89). The stream is the normal path, and it is kept: when it drops (a
 * restart, a laptop waking, a phone changing networks) it is opened again, soon at first and then
 * less often, and its next snapshot carries on where it left off. Polling is only the fallback for a
 * path the stream has never worked on (a proxy that buffers it, or no EventSource at all), and asks
 * for the summary view; even then the stream is tried again now and then, and its first snapshot
 * ends the polling. Coming back to the tab tries the stream first.
 */
function openJobFeed({ onSnapshot, onJob, onStatus = () => {}, pollAfterMs = 2500, pollEveryMs = 5000 }: Omit<JobFeedListener, "now">): () => void {
  let stopped = false;
  // No more automatic requests once the server has refused the session.
  let refused = false;
  let polling = false;
  let source: EventSource | null = null;
  // A stream snapshot has arrived at least once: the stream works on this path.
  let streamed = false;
  let live = false;
  let streamFailures = 0;
  let pollFailures = 0;
  let pollTimer: ReturnType<typeof setTimeout> | null = null;
  let streamTimer: ReturnType<typeof setTimeout> | null = null;
  let request: AbortController | null = null;
  const canStream = typeof EventSource !== "undefined";
  const hidden = () => typeof document !== "undefined" && document.visibilityState === "hidden";
  onStatus("loading");
  const clearPollTimer = () => { if (pollTimer !== null) clearTimeout(pollTimer); pollTimer = null; };
  const clearStreamTimer = () => { if (streamTimer !== null) clearTimeout(streamTimer); streamTimer = null; };
  const validSnapshot = (value: unknown): Job[] => {
    if (!Array.isArray(value) || !value.every(readableJob)) throw new Error("Job history was incomplete");
    // The newest fifty, and every job waiting for approval the server sends besides them (M88).
    return value.filter((job, index) => index < 50 || job.state === "awaiting_approval");
  };
  const read = async () => {
    if (stopped || !polling || request) return;
    clearPollTimer();
    const controller = new AbortController(); request = controller;
    const deadline = setTimeout(() => controller.abort(), 15_000);
    try {
      // The summary view: what the rows and the state words read, without results and step logs.
      const response = await fetch("/api/v1/jobs?limit=50&view=summary", { signal: controller.signal });
      if (response.status === 401 || response.status === 403) refused = true;
      const body = await readJson<{ jobs: unknown }>(response);
      const snapshot = validSnapshot(body.jobs);
      if (stopped || !polling) return;
      pollFailures = 0; onSnapshot(snapshot); onStatus("polling");
    } catch {
      if (!stopped && polling) { pollFailures += 1; onStatus("unavailable"); }
    } finally {
      clearTimeout(deadline);
      if (request === controller) request = null;
      if (refused) { stopPolling(); clearStreamTimer(); }
      else if (!stopped && polling) {
        const interval = hidden() ? 30_000 : Math.min(30_000, pollEveryMs * 2 ** Math.min(pollFailures, 3));
        pollTimer = setTimeout(() => void read(), interval);
      }
    }
  };
  const startPolling = () => {
    if (stopped || polling || refused) return;
    polling = true;
    void read();
  };
  function stopPolling() {
    polling = false; clearPollTimer();
    request?.abort(); request = null;
  }
  const reopenIn = () => (streamed
    // It worked here: a restart or a network change, over in seconds.
    ? Math.min(30_000, 1000 * 2 ** Math.min(streamFailures - 1, 5))
    // It never has: most likely a buffering proxy, so ask it again rarely while polling carries on.
    : Math.min(300_000, 30_000 * 2 ** Math.min(streamFailures - 1, 4)));
  // The stream cannot say why it failed: a session that has ended looks like a restart, and was
  // asked again every 30 s for as long as the tab stayed open. After a few failures the session is
  // asked directly, and a refusal ends the feed as a refused poll does.
  let askingSession = false;
  const refuse = () => {
    refused = true;
    stopPolling(); clearStreamTimer();
    source?.close(); source = null; live = false;
    onStatus("unavailable");
  };
  const checkSession = async () => {
    if (askingSession || stopped || refused) return;
    askingSession = true;
    try {
      const response = await fetch("/api/v1/auth/status", { cache: "no-store" });
      const body = (await response.json().catch(() => null)) as { authenticated?: unknown } | null;
      if (!stopped && (response.status === 401 || response.status === 403 || (response.ok && body?.authenticated === false))) refuse();
    } catch { /* no answer: BoxPilot is restarting, so the stream is tried again */ } finally { askingSession = false; }
  };
  const dropStream = (dropped: EventSource) => {
    if (stopped || source !== dropped) return;
    dropped.close(); source = null; live = false;
    clearStreamTimer();
    streamFailures += 1;
    // Fall back to polling only on a path the stream has never worked on.
    if (!streamed) startPolling();
    else if (streamFailures >= 3) { onStatus("unavailable"); void checkSession(); }
    if (!refused) streamTimer = setTimeout(openStream, reopenIn());
  };
  function openStream() {
    if (stopped || refused || !canStream || source) return;
    clearStreamTimer();
    let opened: EventSource;
    try { opened = new EventSource("/api/v1/events"); }
    catch { if (!polling) startPolling(); return; }
    source = opened;
    live = false;
    opened.addEventListener("snapshot", (event) => {
      if (stopped || source !== opened) return;
      let snapshot: Job[];
      try { snapshot = validSnapshot((JSON.parse((event as MessageEvent).data) as { jobs: unknown }).jobs); }
      catch { dropStream(opened); return; }
      live = true; streamed = true; streamFailures = 0;
      clearStreamTimer(); stopPolling();
      onSnapshot(snapshot); onStatus("live");
    });
    opened.addEventListener("job", (event) => {
      if (stopped || source !== opened || !live) return;
      let job: unknown;
      try { job = (JSON.parse((event as MessageEvent).data) as { job: unknown }).job; } catch { job = null; }
      if (!readableJob(job)) { dropStream(opened); return; }
      onJob(job);
    });
    opened.onerror = () => dropStream(opened);
    // A stream a proxy holds back never sends its snapshot: give it a moment, then poll meanwhile.
    // One that has worked here is kept open while the polls carry the list (a slow first snapshot
    // after a restart is not a buffering proxy), and its snapshot ends the polling; dropping it
    // left nothing reading at all, and a list that never filled.
    streamTimer = setTimeout(() => {
      streamTimer = null;
      if (stopped || source !== opened) return;
      if (streamed) startPolling(); else dropStream(opened);
    }, pollAfterMs);
  }
  const visible = () => {
    if (stopped || hidden()) return;
    // The stream first; polling, if it is running, reads at once too.
    if (!source && canStream && !refused) { clearStreamTimer(); openStream(); }
    if (polling && pollTimer !== null) { clearPollTimer(); void read(); }
  };
  if (typeof document !== "undefined") document.addEventListener("visibilitychange", visible);
  if (canStream) openStream(); else startPolling();
  return () => {
    stopped = true; clearPollTimer(); clearStreamTimer(); request?.abort(); request = null;
    source?.close(); source = null;
    if (typeof document !== "undefined") document.removeEventListener("visibilitychange", visible);
  };
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
