/**
 * The Agents section's client (M37): typed calls to /api/v1/agents and /api/v1/settings/agents.
 * The server decides who may do what; these only ask. Nothing here stages or runs an operation: a
 * card's steps go through the ordinary approval dialog (useOperation), like any other.
 */
import { readJson } from "../../http";
import type { RiskTier } from "../../ui";

export type ToolPermission = "auto" | "ask" | "off";
export type AgentStatus = "off" | "module-paused" | "paused" | "running" | "queued" | "idle";
export type RunState = "queued" | "running" | "completed" | "degraded" | "failed" | "cancelled" | "killed" | "interrupted" | "refused" | "timeout";
export type RunKind = "ask" | "manual" | "schedule" | "event" | "learn" | "eval" | "webhook" | "handoff" | "continue" | "index";
export type Cadence = "hourly" | "every-6-hours" | "daily" | "weekly";

export interface ModuleBudget { runsUsed: number; runsPerDay: number; modelMsUsed: number; modelSecondsPerDay: number; modelMsLeft: number; refusal: string | null }
export interface Connectors { notion: { enabled: boolean; credential: string | null }; slack: { enabled: boolean; credential: string | null; channels: string[] } }
export interface ModuleState {
  enabled: boolean; paused: boolean; pausedUntil: string | null; killedAt: string | null; quietHours: { start: string; end: string }; inQuietHours: boolean; notify: boolean;
  budget?: ModuleBudget; embeddings?: boolean; webSearch?: { enabled: boolean; endpoint: string | null }; folder?: { enabled: boolean; path: string | null }; connectors?: Connectors;
}
export interface RunnerUsage { state: string; cpuPercent: number; memoryBytes: number; memoryPeakBytes: number | null; cpuQuotaPercent: number | null; memoryMaxBytes: number | null; throttledMs: number; modelLoaded: boolean; model: string | null; cgroup: boolean; readAt: string }
export interface RunnerStatus { online: boolean; lastSeenAt: string | null; version: string | null; startedAt: string | null; hostBusy: boolean; usage: RunnerUsage | null }
export interface Schedule { every: Cadence; minute: number; hour: number | null; weekday: number | null; quietHours: boolean }

export interface OutputField { name: string; description: string }
export interface AgentSpec {
  name: string;
  purpose: string;
  job: string;
  successCriteria: string[];
  prompt: { rules: string[]; steps: string[]; output: { format: "text" | "json"; fields: OutputField[]; style: string }; escalate: string[] };
  instructions: string;
  audience: Array<"owner" | "operator" | "viewer">;
  knowledge: Record<"docs" | "registry" | "catalog" | "notes" | "documents", boolean>;
  tools: Record<string, ToolPermission>;
  triggers: { ask: boolean; schedule: Schedule | null; events: string[]; webhook: boolean };
  budget: { runsPerDay: number; modelSecondsPerDay: number; stepsPerRun: number; tokensPerRun: number; runSeconds: number };
  outputs: { notes: boolean; digest: boolean; notify: "important" | "never"; proposals: boolean };
  memory: { enabled: boolean; freshDays: number; maxNotes: number; share: boolean; threads: boolean; turns: number };
  escalation: { lowConfidence: boolean; limits: boolean; actions: boolean; risk: boolean };
  allow: { apps: "*" | string[]; operations: "*" | string[] };
  model: { thinking: boolean };
  orchestration: { supervisor: boolean; delegates: "*" | string[]; maxDepth: number };
}

export interface AgentSummary {
  id: string;
  name: string;
  template: string | null;
  version: number;
  purpose: string;
  paused: boolean;
  pausedUntil: string | null;
  status: AgentStatus;
  canEdit: boolean;
  canAsk: boolean;
  createdAt: string;
  updatedAt: string;
  lastRun: { id: string; kind: RunKind; state: RunState; finishedAt: string | null } | null;
  nextRunAt: string | null;
  waitsForQuietHours: boolean;
  budgetToday: { runsUsed: number; runsPerDay: number; modelSecondsUsed: number; modelSecondsPerDay: number; tokensUsed: number };
  toolsOn: number;
  triggers: AgentSpec["triggers"];
  audience: AgentSpec["audience"];
}

export interface AgentVersion { version: number; note: string | null; createdBy: string | null; createdAt: string }
export interface AgentDetail extends AgentSummary { spec: AgentSpec; versions: AgentVersion[]; createdBy: string | null; prompt: string; warnings: string[]; webhook: { enabled: boolean; minted: boolean }; specialists: Array<{ id: string; name: string }> }
export type SpecChange = { field: string; before?: unknown; after?: unknown; lines?: Array<{ op: "keep" | "add" | "remove"; text: string }> };
export interface VersionDetail { version: AgentVersion & { spec: AgentSpec }; changes: SpecChange[]; againstCurrent: SpecChange[] }

export interface Overview {
  module: ModuleState;
  runner: RunnerStatus;
  agents: AgentSummary[];
  queue: { queued: number; running: number; dropped: number };
  cardsWaiting: number;
  can: { create: boolean; configure: boolean; pause: boolean };
}

export interface ToolInfo { id: string; fn: string; title: string; description: string; category: string; categoryTitle: string; role: "viewer" | "operator"; cost: "cheap" | "moderate" | "heavy"; writes: string | null; defaultOff: boolean; params: Array<{ name: string; type: string; required: boolean; description: string }> }
export interface Question { id: string; question: string; expect: { fact?: string; includes?: string[] } }
export interface Template { id: string; title: string; summary: string; spec: AgentSpec; questions: Question[] }
export interface Catalog {
  templates: Template[]; tools: ToolInfo[]; events: Array<{ id: string; title: string }>;
  limits: { budget: Record<keyof AgentSpec["budget"], { min: number; max: number; default: number }>; module: Record<"runsPerDay" | "modelSecondsPerDay", { min: number; max: number }> };
  categories: Record<string, string>; outputFormats: Array<"text" | "json">; memoryTiers: Record<string, string>;
}

export interface RunStep { seq: number; kind: "model" | "tool" | "proposal" | "note" | "notify" | "system" | "intent" | "plan" | "recall" | "memory" | "handoff"; name: string | null; state: "done" | "failed" | "refused"; input: unknown; output: string | null; flags: Record<string, unknown>; startedAt: string; durationMs: number | null; tokensIn: number | null; tokensOut: number | null }
export interface PlanStep { operationId: string; title: string; risk: RiskTier; readOnly: boolean; approval: string; typedConfirmation: boolean; parameters: Record<string, unknown>; why: string }
export interface Proposal {
  id: string;
  kind: "plan" | "question" | "escalation";
  question: string | null;
  agentId: string | null;
  agentName: string;
  runId: string | null;
  source: "agent" | "runtime";
  title: string;
  reason: string;
  steps: PlanStep[];
  dropped: Array<{ index: number | null; operationId: string | null; reason: string }>;
  flags: { afterSuspiciousOutput?: boolean };
  state: "open" | "dismissed" | "staged" | "expired";
  forRole: string;
  createdAt: string;
  expiresAt: string;
  jobIds: string[];
}
export interface RunUsage { modelMs?: number; loadMs?: number; promptTokens?: number; completionTokens?: number; modelCalls?: number; toolCalls?: number; wallMs?: number }
export interface Run {
  id: string;
  agentId: string;
  agentName: string;
  version: number;
  kind: RunKind;
  trigger: { title?: string; event?: string; quietHours?: boolean };
  question: string | null;
  state: RunState;
  reason: string | null;
  readRole: string;
  queuedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  answer: string | null;
  outputKind: string | null;
  usage: RunUsage;
  flags: { injection?: boolean; degraded?: string; citations?: { cited: number; unknown: string[] } };
  eval?: { evalId: string; questionId: string } | null;
  parentRunId?: string | null;
  rootRunId?: string;
  depth?: number;
  feedback?: { verdict: "up" | "down"; note: string | null; mine: boolean } | null;
  tree?: Array<{ id: string; parentRunId: string | null; depth: number; agentId: string; agentName: string; kind: RunKind; state: RunState; question: string | null; finishedAt: string | null }>;
  proposals: Proposal[];
  steps?: RunStep[];
}

export interface Caps { cpuQuotaPercent: number; cpuWeight: string; nice: number; ioSchedulingClass: string; memoryMaxBytes: number; memorySwapMaxBytes: number; tasksMax: number; modelThreads: number; unit: string }
export interface Usage {
  runner: RunnerStatus;
  caps: Caps;
  today: { runs: number; modelSeconds: number; tokens: number; perAgent: Array<{ agentId: string; name: string; runs: number; runsPerDay: number; modelSeconds: number; modelSecondsPerDay: number; tokens: number }> };
  queue: { queued: number; running: number; dropped: number };
  module: ModuleState;
}

export type RuntimeDriver = "unsloth" | "llama-server" | "external" | "fake";
export interface LibraryModel { id: string; title: string; repo: string; file: string; projector: string | null; quant: string; parameters: number; memoryBytes: number; contextTokens: number; tokensPerSecond: number; vision: boolean; recommended: boolean; note: string; preview: { bytes: number; fastMinutes: number; slowMinutes: number; memoryBytes: number }; fitsCap: boolean; downloaded: boolean; current: boolean }
export interface RuntimeSettings { driver: RuntimeDriver; repo: string; file: string; projector?: string | null; quant?: string; endpoint?: string | null; contextTokens?: number; idleStopMinutes?: number; maxTokens?: number; temperature?: number }
export interface RuntimeState {
  settings: RuntimeSettings;
  library: LibraryModel[];
  installed: { runtime: { installed: boolean; path: string } | null; service: { unit: string; loaded: boolean; active: string; sub: string; enabled: string } | null; models: Array<{ repo: string; file: string; bytes: number; complete: boolean; projector: boolean }>; diskFreeBytes: number | null } | null;
  unsloth: { version: string | null; installerSha256: string | null; installedAt: string | null; testedVersion: string };
  newer: { repo: string; version: number; parameters: number; file: string; projector: string | null } | null;
  checkedAt: string | null;
  runner: RunnerStatus;
  caps: Caps;
}

export interface KnowledgeSource { id: "docs" | "registry" | "catalog" | "notes" | "documents"; title: string; enabled: boolean; items: number | null; size: number | null; unit: string; indexedAt: string | null }
export interface OwnerDocument { id: string; title: string; enabled: boolean; createdAt: string; characters: number; source: string; externalId: string | null; pinned: boolean }
export interface Knowledge {
  sources: KnowledgeSource[]; documents: OwnerDocument[];
  search: { kind: string; embeddings: string; pending?: number; vectors?: number; enabled?: boolean };
  learning: { quietHours: { start: string; end: string }; agents: Array<{ agentId: string; name: string; state: RunState | null; at: string | null }> };
  canChange: boolean;
  connectors?: Connectors; folder?: { enabled: boolean; path: string | null }; webSearch?: { enabled: boolean; endpoint: string | null };
}
export interface MemoryNote { id: string; title: string; body: string; source: Note["source"]; createdAt: string; updatedAt: string; freshUntil: string | null; stale: boolean; pinned: boolean; shared: boolean; readRole: string; indexed: boolean }
export interface Memory {
  facts: MemoryNote[];
  shared: Array<{ id: string; title: string; body: string; from: string; updatedAt: string; stale: boolean }>;
  episodes: Array<{ id: string; runId: string | null; text: string; createdAt: string; indexed: boolean }>;
  thread: { summary: string; turns: Array<{ role: "user" | "agent"; text: string; at?: string }>; updatedAt: string } | null;
  settings: { enabled: boolean; share: boolean; threads: boolean; turns: number; freshDays: number; maxNotes: number };
  search: { byMeaning: boolean; model: string; pending: number; vectors: number };
}
export interface Accuracy { version: number; model: string | null; evaluations: number; score: number | null; up: number; down: number; since: string | null }
export interface Note { id: string; title: string; body: string; source: { runId?: string; by?: string; tools?: string[]; injection?: boolean }; createdAt: string; updatedAt: string; freshUntil: string | null; stale: boolean }
export interface EvalResult { questionId: string; question: string; expected: { fact?: string; value?: unknown; includes?: string[] }; runId: string | null; passed: boolean | null; found: string | null }
export interface EvalRun { id: string; version: number; model?: string | null; state: "running" | "done"; results: EvalResult[]; score: number | null; createdAt: string; finishedAt: string | null }
export interface Evaluation { questions: Question[]; runs: EvalRun[]; canEdit: boolean; successCriteria?: string[]; accuracy?: Accuracy[] }
export interface Glance { enabled: boolean; paused: boolean; runnerOnline: boolean; digest: { agentId: string; agentName: string; runId: string; at: string; excerpt: string; state: RunState } | null; cardsWaiting: number }

const base = "/api/v1/agents";
const get = <T>(path: string) => fetch(`${base}${path}`).then((response) => readJson<T>(response));
const send = <T>(method: string, path: string, csrfToken: string, body?: unknown) => fetch(path.startsWith("/api/") ? path : `${base}${path}`, {
  method,
  headers: { "Content-Type": "application/json", "X-BoxPilot-CSRF": csrfToken },
  body: body === undefined ? undefined : JSON.stringify(body),
}).then((response) => readJson<T>(response));

/** The overview the whole page is drawn from: an answer of another shape (an older server, a proxy's page) is an error to say, not a page to crash. */
function checkedOverview(body: Overview): Overview {
  if (!body || !Array.isArray(body.agents) || !body.queue || !body.module || !body.runner) throw new Error("The server's answer about Agents was not the expected shape. Check that both services run the same BoxPilot release.");
  return body;
}

export const agentsApi = {
  overview: () => get<Overview>("").then(checkedOverview),
  catalog: () => get<Catalog>("/catalog"),
  usage: () => get<Usage>("/usage"),
  runtime: () => get<RuntimeState>("/runtime"),
  glance: () => get<Glance>("/glance"),
  proposals: () => get<{ proposals: Proposal[] }>("/proposals"),
  knowledge: () => get<Knowledge>("/knowledge"),
  agent: (id: string) => get<AgentDetail>(`/${encodeURIComponent(id)}`),
  version: (id: string, version: number) => get<VersionDetail>(`/${encodeURIComponent(id)}/versions/${version}`),
  runs: (id: string) => get<{ runs: Run[] }>(`/${encodeURIComponent(id)}/runs?limit=30`),
  run: (runId: string) => get<Run>(`/runs/${encodeURIComponent(runId)}`),
  notes: (id: string) => get<{ notes: Note[] }>(`/${encodeURIComponent(id)}/notes`),
  evaluation: (id: string) => get<Evaluation>(`/${encodeURIComponent(id)}/evaluation`),

  create: (csrf: string, body: { template?: string; spec?: AgentSpec }) => send<AgentDetail>("POST", "", csrf, body),
  update: (csrf: string, id: string, spec: AgentSpec, note?: string) => send<AgentDetail & { unchanged?: boolean }>("PUT", `/${encodeURIComponent(id)}`, csrf, { spec, note }),
  remove: (csrf: string, id: string) => send<{ deleted: boolean }>("DELETE", `/${encodeURIComponent(id)}`, csrf),
  rollback: (csrf: string, id: string, version: number) => send<AgentDetail>("POST", `/${encodeURIComponent(id)}/rollback`, csrf, { version }),
  pause: (csrf: string, id: string, until: string | null) => send<AgentSummary>("POST", `/${encodeURIComponent(id)}/pause`, csrf, { until }),
  resume: (csrf: string, id: string) => send<AgentSummary>("POST", `/${encodeURIComponent(id)}/resume`, csrf),
  test: (csrf: string, id: string, question: string | null) => send<Run>("POST", `/${encodeURIComponent(id)}/runs`, csrf, { question }),
  ask: (csrf: string, id: string, question: string) => send<Run>("POST", `/${encodeURIComponent(id)}/ask`, csrf, { question }),
  cancel: (csrf: string, runId: string) => send<Run>("POST", `/runs/${encodeURIComponent(runId)}/cancel`, csrf),
  deleteNote: (csrf: string, id: string, noteId: string) => send<{ deleted: boolean }>("DELETE", `/${encodeURIComponent(id)}/notes/${encodeURIComponent(noteId)}`, csrf),
  saveEvaluation: (csrf: string, id: string, questions: Question[]) => send<Evaluation>("PUT", `/${encodeURIComponent(id)}/evaluation`, csrf, { questions }),
  runEvaluation: (csrf: string, id: string) => send<EvalRun>("POST", `/${encodeURIComponent(id)}/evaluation/run`, csrf),
  decide: (csrf: string, proposalId: string, decision: "dismissed" | "staged", jobIds: string[] = []) => send<Proposal>("POST", `/proposals/${encodeURIComponent(proposalId)}/decide`, csrf, { decision, jobIds }),
  memory: (id: string) => get<Memory>(`/${encodeURIComponent(id)}/memory`),
  editMemory: (csrf: string, id: string, noteId: string, patch: { title?: string; body?: string; freshDays?: number | null; pinned?: boolean; shared?: boolean }) => send<MemoryNote>("PUT", `/${encodeURIComponent(id)}/memory/notes/${encodeURIComponent(noteId)}`, csrf, patch),
  forget: (csrf: string, id: string, kind: "notes" | "episodes", itemId: string) => send<{ forgotten: boolean }>("DELETE", `/${encodeURIComponent(id)}/memory/${kind}/${encodeURIComponent(itemId)}`, csrf),
  forgetThread: (csrf: string, id: string) => send<{ forgotten: boolean }>("DELETE", `/${encodeURIComponent(id)}/memory/thread`, csrf),
  feedback: (csrf: string, runId: string, verdict: "up" | "down", note?: string) => send<{ verdict: "up" | "down"; note: string | null; mine: boolean }>("POST", `/runs/${encodeURIComponent(runId)}/feedback`, csrf, { verdict, note: note || null }),
  exportAgent: (id: string) => get<Record<string, unknown>>(`/${encodeURIComponent(id)}/export`),
  importAgent: (csrf: string, definition: string) => send<AgentDetail>("POST", "/import", csrf, { definition }),
  mintWebhook: (csrf: string, id: string) => send<{ token: string; path: string }>("POST", `/${encodeURIComponent(id)}/webhook`, csrf),
  clearWebhook: (csrf: string, id: string) => send<{ removed: boolean }>("DELETE", `/${encodeURIComponent(id)}/webhook`, csrf),
  pinDocument: (csrf: string, documentId: string, pinned: boolean) => send<{ pinned: boolean }>("PUT", `/knowledge/documents/${encodeURIComponent(documentId)}/pin`, csrf, { pinned }),
  syncFolder: (csrf: string) => send<{ files?: number; changed?: number; removed?: number; skipped?: string[] | string; error?: string }>("POST", "/knowledge/folder/sync", csrf),
  reindex: (csrf: string) => send<{ queued: boolean; pending: number }>("POST", "/knowledge/reindex", csrf),
  /** A PDF, Markdown or text file, sent as it is. */
  upload: (csrf: string, file: File) => fetch(`${base}/knowledge/upload?name=${encodeURIComponent(file.name)}`, { method: "POST", headers: { "Content-Type": "application/octet-stream", "X-BoxPilot-CSRF": csrf }, body: file }).then((response) => readJson<OwnerDocument & { detail: string | null }>(response)),
  pauseAll: (csrf: string, until: string | null) => send<ModuleState>("POST", "/module/pause", csrf, { until }),
  resumeAll: (csrf: string) => send<ModuleState>("POST", "/module/resume", csrf),
  kill: (csrf: string) => send<{ module: ModuleState; cancelled: number; stopped: number }>("POST", "/module/kill", csrf),
  addDocument: (csrf: string, title: string, text: string) => send<OwnerDocument>("POST", "/knowledge/documents", csrf, { title, text }),
  toggleDocument: (csrf: string, documentId: string, enabled: boolean) => send<{ enabled: boolean }>("PUT", `/knowledge/documents/${encodeURIComponent(documentId)}`, csrf, { enabled }),
  removeDocument: (csrf: string, documentId: string) => send<{ deleted: boolean }>("DELETE", `/knowledge/documents/${encodeURIComponent(documentId)}`, csrf),
  relearn: (csrf: string, agentId: string | null) => send<{ queued: number }>("POST", "/knowledge/relearn", csrf, { agentId }),
  /** The owner's switch, quiet hours, sources and runtime; always with the owner's password. */
  saveSettings: (csrf: string, body: {
    password: string; enabled?: boolean; quietHours?: { start: string; end: string }; notify?: boolean; knowledge?: Partial<Record<KnowledgeSource["id"], boolean>>; runtime?: Partial<RuntimeSettings>;
    budget?: { runsPerDay?: number; modelSecondsPerDay?: number }; embeddings?: boolean; webSearch?: { enabled: boolean; endpoint: string | null }; folder?: { enabled: boolean; path: string | null };
    connectors?: { notion?: { enabled: boolean; credential: string | null }; slack?: { enabled: boolean; credential: string | null; channels?: string[] } };
  }) =>
    send<{ module: ModuleState }>("PUT", "/api/v1/settings/agents", csrf, body),
};

export type RunEvent = { event: "snapshot"; data: Run } | { event: "step"; data: RunStep } | { event: "state"; data: { state: RunState } };

/**
 * Follow a run as it happens: the snapshot, each step, its end. Falls back to reading the run every
 * two seconds where the stream does not arrive (a proxy that buffers). Returns a function that stops.
 */
export function followRun(runId: string, onEvent: (event: RunEvent) => void): () => void {
  let stopped = false;
  let source: EventSource | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let streamed = false;
  const finished = new Set<RunState>(["completed", "degraded", "failed", "cancelled", "killed", "interrupted", "refused", "timeout"]);
  const poll = async () => {
    if (stopped || streamed) return;
    try {
      const run = await agentsApi.run(runId);
      if (stopped || streamed) return;
      onEvent({ event: "snapshot", data: run });
      if (finished.has(run.state)) return;
    } catch { /* try again */ }
    timer = setTimeout(() => void poll(), 2_000);
  };
  if (typeof EventSource !== "undefined") {
    source = new EventSource(`${base}/runs/${encodeURIComponent(runId)}/stream`);
    const handle = (name: RunEvent["event"]) => (event: Event) => {
      if (stopped) return;
      streamed = true;
      if (timer) clearTimeout(timer);
      try { onEvent({ event: name, data: JSON.parse((event as MessageEvent).data) } as RunEvent); } catch { /* ignore a malformed frame */ }
    };
    source.addEventListener("snapshot", handle("snapshot"));
    source.addEventListener("step", handle("step"));
    source.addEventListener("state", handle("state"));
    source.onerror = () => { source?.close(); if (!stopped) { streamed = false; void poll(); } };
    timer = setTimeout(() => void poll(), 2_500);
  } else {
    void poll();
  }
  return () => { stopped = true; source?.close(); if (timer) clearTimeout(timer); };
}
