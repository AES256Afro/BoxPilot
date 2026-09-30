/**
 * How the Agents section says things (M37): a run's state, an agent's status and its triggers in
 * words, with the status a chip draws. Kept here so the list, the console and the glance on Home
 * and Ops all say the same thing.
 */
import type { Status } from "../../ui";
import type { AgentStatus, AgentSummary, ModuleState, RunKind, RunState, Schedule } from "./api";

export const finishedRunStates: ReadonlySet<RunState> = new Set<RunState>(["completed", "degraded", "failed", "cancelled", "killed", "interrupted", "refused", "timeout"]);

const runWords: Record<RunState, { status: Status; label: string }> = {
  queued: { status: "neutral", label: "waiting" },
  running: { status: "warning", label: "running" },
  completed: { status: "good", label: "answered" },
  degraded: { status: "warning", label: "facts only" },
  failed: { status: "danger", label: "failed" },
  cancelled: { status: "neutral", label: "cancelled" },
  killed: { status: "danger", label: "stopped" },
  interrupted: { status: "warning", label: "interrupted" },
  refused: { status: "neutral", label: "not run" },
  timeout: { status: "danger", label: "ran out of time" },
};
export const runState = (state: RunState) => runWords[state] ?? { status: "unknown" as Status, label: state };

const agentWords: Record<AgentStatus, { status: Status; label: string }> = {
  off: { status: "neutral", label: "Agents off" },
  "module-paused": { status: "warning", label: "all paused" },
  paused: { status: "warning", label: "paused" },
  running: { status: "warning", label: "running" },
  queued: { status: "neutral", label: "waiting" },
  idle: { status: "good", label: "ready" },
};
export const agentState = (status: AgentStatus) => agentWords[status] ?? { status: "unknown" as Status, label: status };

export const kindWords: Record<RunKind, string> = { ask: "asked", manual: "test", schedule: "schedule", event: "event", learn: "learning", eval: "evaluation", webhook: "webhook", handoff: "hand-off", continue: "follow-up", index: "indexing", describe: "describing an image" };

const cadenceWords: Record<Schedule["every"], string> = { hourly: "hourly", "every-6-hours": "every 6 hours", daily: "daily", weekly: "weekly" };
const weekdays = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const two = (value: number) => String(value).padStart(2, "0");

/** "daily at 05:30", "hourly at :15", "weekly on Monday at 05:00". */
export function scheduleWords(schedule: Schedule | null): string | null {
  if (!schedule) return null;
  if (schedule.every === "hourly" || schedule.every === "every-6-hours") return `${cadenceWords[schedule.every]} at :${two(schedule.minute)}`;
  const time = `${two(schedule.hour ?? 0)}:${two(schedule.minute)}`;
  if (schedule.every === "weekly") return `weekly on ${weekdays[schedule.weekday ?? 1]} at ${time}`;
  return `daily at ${time}`;
}

/** How an agent starts, in a few words: "asked · daily at 05:30 · 2 events". */
export function triggerWords(agent: Pick<AgentSummary, "triggers">): string {
  const parts = [agent.triggers.ask ? "asked" : null, scheduleWords(agent.triggers.schedule), agent.triggers.events.length ? `${agent.triggers.events.length} ${agent.triggers.events.length === 1 ? "event" : "events"}` : null];
  return parts.filter(Boolean).join(" · ") || "never";
}

/** The clock time of an ISO date, in the browser's zone: "07:00". */
export const clockTime = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false }) : "");

/** What is missing before an agent can run, as the sentence under the verdict says it. */
export type SetupStepId = "install" | "download" | "enable";
const untilWords: Record<SetupStepId, string> = { install: "Unsloth is installed", download: "the model is downloaded", enable: "the runner is started" };

/** "a", "a and b", "a, b and c". */
export function joinWords(parts: string[]): string {
  return parts.length <= 1 ? parts.join("") : `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;
}

/**
 * Where the runner is, when Agents are on and it is not answering: known only to the owner and
 * operators, who read its unit. `silent` is a unit that runs but a runner that has not answered;
 * `missing` the steps still to take, in order, when they are known.
 */
export interface RunnerDetail { silent?: boolean; missing?: SetupStepId[] | null }

/** The module's verdict for the page header and the glance on Home and Ops. */
export function moduleVerdict(module: ModuleState, runnerOnline: boolean, running: number, runner: RunnerDetail = {}): { status: Status; label: string; sentence: string | null } {
  if (!module.enabled) return { status: "neutral", label: "Off", sentence: "Agents are off: nothing runs, and the runner and its model are stopped." };
  if (module.killedAt && module.paused) return { status: "danger", label: "Stopped", sentence: "The kill switch stopped every agent. Only the owner starts them again." };
  if (module.paused) return { status: "warning", label: module.pausedUntil ? `Paused until ${clockTime(module.pausedUntil)}` : "Paused", sentence: "Every agent is paused: nothing new starts until they are resumed." };
  if (!runnerOnline) {
    const until = runner.missing?.length ? joinWords(runner.missing.map((step) => untilWords[step])) : null;
    if (runner.silent) return { status: "warning", label: "Runner not answering", sentence: until ? `Its service is running but has not answered, and nothing runs until ${until}.` : "Its service is running, but the runner has not answered yet, so nothing runs until it does." };
    return { status: "warning", label: "Runner stopped", sentence: until ? `Agents are on, but nothing runs until ${until}.` : "Agents are on, but the runner is stopped, so nothing runs." };
  }
  if (running > 0) return { status: "good", label: "Working", sentence: null };
  return { status: "good", label: "Running cool", sentence: null };
}

/** Why a run in the queue has not started, in words. */
export function waitingWords(runnerOnline: boolean, runner: RunnerDetail = {}): string {
  if (runnerOnline) return "Waiting for the runner: one run goes at a time, and a question goes before scheduled work.";
  return runner.silent ? "Waiting for the runner, which is not answering" : "Waiting for the runner, which is stopped";
}

const countWords = ["no", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve"];
/**
 * A CPUQuota as the processors it adds up to: 100% is "one processor", 400% "four processors",
 * 150% "1.5 processors". From the caps the server reports, never assumed.
 */
export function processorWords(quotaPercent: number): string {
  const count = quotaPercent / 100;
  if (count === 1) return "one processor";
  if (Number.isInteger(count) && count > 1 && count < countWords.length) return `${countWords[count]} processors`;
  return `${Math.round(count * 10) / 10} processors`;
}

/**
 * The runner's caps in words, from what the server reports ("four processors at most, idle
 * priority, 8 GiB"), or in general terms while they have not been read.
 */
export function capsWords(caps: { cpuQuotaPercent?: number | null; memoryMaxBytes?: number | null } | null | undefined): string {
  if (!caps?.cpuQuotaPercent) return "capped processors and memory, idle priority";
  return `${processorWords(caps.cpuQuotaPercent)} at most, idle priority${caps.memoryMaxBytes ? `, ${gibibytes(caps.memoryMaxBytes)}` : ""}`;
}

/** "8 GB", "650 MB": sizes as the owner reads them, in powers of 1000 like a disk's label. */
export function bytes(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  if (value >= 1e9) return `${(value / 1e9).toFixed(value >= 10e9 ? 0 : 1)} GB`;
  if (value >= 1e6) return `${Math.round(value / 1e6)} MB`;
  return `${Math.max(0, Math.round(value / 1e3))} kB`;
}

/** Binary sizes, as a cgroup's memory limit is set: "8 GiB". */
export function gibibytes(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  const gib = value / 1024 ** 3;
  return gib >= 1 ? `${Number.isInteger(gib) ? gib : gib.toFixed(1)} GiB` : `${Math.round(value / 1024 ** 2)} MiB`;
}

/** "42 s", "3 min 5 s". */
export function seconds(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return "—";
  const total = Math.round(ms / 1000);
  if (total < 60) return `${total} s`;
  const minutes = Math.floor(total / 60);
  return total % 60 ? `${minutes} min ${total % 60} s` : `${minutes} min`;
}

export const errorText = (error: unknown, fallback: string) => (error instanceof Error && error.message ? error.message : fallback);
