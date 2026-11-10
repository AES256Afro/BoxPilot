import type { Status } from "../../ui/types";
import type { AgentSummary, ModuleState, Run } from "../agents/api";
import type { Flow } from "./flows";
import type { Schedule } from "./SchedulesPanel";

/*
 * Tonight: what this server will do by itself between 20:00 and 08:00, laid on a time axis of
 * half-hour cells, with the jobs that will run into each other named. Pure: the schedules, the
 * length of each one's last run, the quiet hours and the time are handed in, and what comes back
 * is the rows, their cells and the overlaps, for TonightPanel to draw.
 *
 * What is true here and what is not claimed:
 * - Every row is something the server has scheduled, placed at the instant the server gave for its
 *   next run. A job that runs more than once a night (hourly, or an agent every six hours) is
 *   repeated by adding whole hours to that instant, which is how the scheduler itself moves an
 *   hourly job on.
 * - A job's length is what its last finished run took. Nothing else is estimated. A job with no
 *   run to measure is drawn `defaultRunMs` long, the same allowance the overlap rule gives it.
 * - Daylight saving is not worked out here. Instants from the server are placed on an axis of
 *   twelve elapsed hours from 20:00, and every label is read off the clock for its own instant, so
 *   the labels stay true on the two nights a year the clocks change: the axis then ends at 07:00
 *   or 09:00, and a six-hourly agent's later run can sit an hour from where the server will put it.
 */

export const cellMinutes = 30;
export const cellMs = cellMinutes * 60_000;
export const cellCount = 24;
/** The night: from 20:00 to 08:00 on the clock the axis is drawn in. */
export const nightFrom = 20 * 60;
export const nightUntil = 8 * 60;
/** The room a job is given when its last run was shorter, or there is none to measure. */
export const defaultRunMs = 10 * 60_000;

const dayMinutes = 24 * 60;
const two = (value: number) => String(value).padStart(2, "0");

/** Minutes past midnight at an instant, on the clock the axis is drawn in. */
export type Clock = (instant: number) => number;

/** The clock of a time zone by name (the server's), or null when the browser does not know the zone. */
export function clockIn(timeZone: string | null | undefined): Clock | null {
  if (!timeZone) return null;
  try {
    const format = new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
    return (instant) => {
      const parts = Object.fromEntries(format.formatToParts(new Date(instant)).map((part) => [part.type, part.value]));
      return (Number(parts.hour) % 24) * 60 + Number(parts.minute);
    };
  } catch {
    return null;
  }
}

/** The clock of whoever is looking, for when the server's zone could not be read. */
export const browserClock: Clock = (instant) => {
  const date = new Date(instant);
  return date.getHours() * 60 + date.getMinutes();
};

/** "02:30" for minutes past midnight. */
export const clockWords = (minutes: number) => `${two(Math.floor((((minutes % dayMinutes) + dayMinutes) % dayMinutes) / 60))}:${two(((minutes % 60) + 60) % 60)}`;

/** "under a minute", "41 min", "1 h 12 min". */
export function durationWords(ms: number): string {
  if (ms < 60_000) return "under a minute";
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes} min`;
  return minutes % 60 ? `${Math.floor(minutes / 60)} h ${minutes % 60} min` : `${Math.floor(minutes / 60)} h`;
}

/**
 * The night `now` belongs to: the one under way between 20:00 and 08:00, the coming one otherwise.
 * Twelve elapsed hours from its 20:00 (see the note on daylight saving at the top).
 */
export function nightOf(now: number, clock: Clock): { start: number; end: number } {
  const minute = Math.floor(now / 60_000) * 60_000;
  const at = clock(now);
  // Before 08:00 the night began yesterday evening; from 08:00 to 20:00 it has yet to begin (a negative "since").
  const sinceStart = at < nightUntil ? at + dayMinutes - nightFrom : at - nightFrom;
  const start = minute - sinceStart * 60_000;
  return { start, end: start + cellCount * cellMs };
}

/** How long a job's last run took, as far as it could be told. */
export type LastRun =
  | { known: "took"; ms: number; failed: boolean }
  | { known: "never" }
  | { known: "running" }
  /** It has run, but the run is not among the jobs that were read (older than the history, or another account's). */
  | { known: "unknown" }
  /** The history could not be read at all. */
  | { known: "unread" };

export type JobKind = "schedule" | "automation" | "agent";

/** One thing the server will do by itself, from whichever list it came. */
export interface PlannedJob {
  id: string;
  kind: JobKind;
  name: string;
  /** What it acts on, or what kind of thing it is: an app's name, "automation", "agent". */
  detail?: string | null;
  /** A condition on its start, said under its name and with its cell: an agent that waits for its quiet hours. */
  note?: string | null;
  enabled: boolean;
  /** The instant of its next run, as the server gave it. */
  nextAt: string | null;
  /** Minutes between runs, for one that runs more than once a night. */
  everyMinutes?: number | null;
  last: LastRun;
}

/** What is drawn in one half-hour cell. `from` and `to` are the part of the cell it covers, 0 to 1. */
export interface Fill {
  /** planned: it starts here. queued: an agent's run joins the queue here. spill: its last run was still going here. */
  kind: "planned" | "queued" | "spill";
  from: number;
  to: number;
  /** The cell in words, for whoever cannot see it. */
  label: string;
  /** This is the start that lands inside another job's run. */
  clash?: boolean;
}

export interface TonightRow {
  id: string;
  kind: JobKind;
  name: string;
  detail: string | null;
  note: string | null;
  /** Each start inside the night, earliest first. */
  starts: number[];
  /** "02:30", or "20:17, then hourly". */
  startsLabel: string;
  last: LastRun;
  /** One entry per column; null where the job is not running. */
  cells: Array<Fill | null>;
  /** Its last run went on past the half hour it started in. */
  ranLong: boolean;
  /** It is one of a pair that will run into each other. */
  clashes: boolean;
}

export interface Overlap {
  earlier: { id: string; kind: JobKind; name: string };
  later: { id: string; kind: JobKind; name: string };
  /** When the later one starts, inside the earlier one's run. */
  at: number;
  atLabel: string;
  /** When the earlier one started, and how long its last run took (null when there is none to measure). */
  earlierAt: number;
  earlierAtLabel: string;
  earlierTookMs: number | null;
  /** How many times tonight the same two meet (an hourly job meets a long one more than once). */
  times: number;
  /** The first free half hour after the earlier one is done, when the later one runs once a night. */
  move: { at: number; label: string; deltaMinutes: number } | null;
}

export interface QuietHours { enabled: boolean; start: string; end: string; holdHigh?: boolean; held?: number; quietNow?: boolean }

export interface QuietRow {
  start: string;
  end: string;
  holdHigh: boolean;
  held: number;
  cells: Array<{ from: number; to: number; label: string | null } | null>;
}

export interface TonightPlan {
  start: number;
  end: number;
  /** The half-hour columns, each with the time its instant reads on the clock. */
  columns: Array<{ at: number; label: string }>;
  /** The hour headings, each over two columns. */
  hours: Array<{ at: number; label: string }>;
  rows: TonightRow[];
  quiet: QuietRow | null;
  /** Each pair once, earliest first. */
  overlaps: Overlap[];
  /** The first and last start of the night, on the clock; null when nothing is due. */
  first: string | null;
  last: string | null;
}

export interface TonightInput {
  jobs: PlannedJob[];
  /** The quiet hours as the server keeps them, or null when they are off or were not read. */
  quiet: QuietHours | null;
  now: number;
  clock: Clock;
}

interface Occurrence { row: number; at: number; until: number }

/** Every start a job has inside [start, end). */
function startsOf(job: PlannedJob, start: number, end: number): number[] {
  const next = job.nextAt ? Date.parse(job.nextAt) : Number.NaN;
  if (!Number.isFinite(next)) return [];
  const every = job.everyMinutes && job.everyMinutes > 0 ? job.everyMinutes * 60_000 : null;
  if (!every) return next >= start && next < end ? [next] : [];
  const found: number[] = [];
  for (let at = next < start ? next + Math.ceil((start - next) / every) * every : next; at < end; at += every) found.push(at);
  return found;
}

/** The length to draw and to reckon with: a real one, or none. A length that is not a time (never from this file's own readers) is none. */
const tookOf = (last: LastRun) => (last.known === "took" && Number.isFinite(last.ms) && last.ms >= 0 ? last.ms : null);

function cellsOf(job: PlannedJob, starts: number[], start: number, clock: Clock): { cells: Array<Fill | null>; ranLong: boolean } {
  const cells: Array<Fill | null> = Array.from({ length: cellCount }, () => null);
  const took = tookOf(job.last);
  let ranLong = false;
  for (const at of starts) {
    const index = Math.floor((at - start) / cellMs);
    if (index < 0 || index >= cellCount) continue;
    const cellStart = start + index * cellMs;
    const until = at + (took ?? defaultRunMs);
    const from = (at - cellStart) / cellMs;
    const startWords = clockWords(clock(at));
    const condition = job.note ? `, ${job.note}` : "";
    cells[index] = {
      kind: job.kind === "agent" ? "queued" : "planned",
      from,
      to: Math.min(1, (until - cellStart) / cellMs),
      label: took === null
        ? `${job.kind === "agent" ? "queued at" : "starts"} ${startWords}${condition}`
        : `${startWords} to ${clockWords(clock(until))}${job.kind === "agent" ? ", queued then" : ""}${condition}`,
    };
    // Past its own half hour only when a real run did that: a job with nothing to measure is not hatched.
    if (took === null) continue;
    for (let next = index + 1; next < cellCount && start + next * cellMs < until; next += 1) {
      ranLong = true;
      // A later start in the same cell (an hourly job longer than its hour) keeps the cell.
      if (cells[next]) continue;
      cells[next] = { kind: "spill", from: 0, to: Math.min(1, (until - (start + next * cellMs)) / cellMs), label: `its last run went on until ${clockWords(clock(until))}` };
    }
  }
  return { cells, ranLong };
}

const minutesOf = (time: string) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));
/** A time of day as the server keeps quiet hours (server/quiet-hours.mjs). */
const timeOfDay = /^([01]\d|2[0-3]):([0-5]\d)$/;

function quietRowOf(quiet: QuietHours | null, columns: TonightPlan["columns"], clock: Clock): QuietRow | null {
  if (!quiet?.enabled || typeof quiet.start !== "string" || typeof quiet.end !== "string" || !timeOfDay.test(quiet.start) || !timeOfDay.test(quiet.end) || quiet.start === quiet.end) return null;
  const from = minutesOf(quiet.start);
  const to = minutesOf(quiet.end);
  // A window that passes midnight is two stretches of the day.
  const stretches: Array<[number, number]> = from < to ? [[from, to]] : [[from, dayMinutes], [0, to]];
  let labelled = false;
  const cells = columns.map((column) => {
    const cellFrom = clock(column.at);
    for (const [low, high] of stretches) {
      const covered: [number, number] = [Math.max(cellFrom, low), Math.min(cellFrom + cellMinutes, high)];
      if (covered[0] >= covered[1]) continue;
      const label = labelled ? null : `quiet from ${quiet.start} to ${quiet.end}`;
      labelled = true;
      return { from: (covered[0] - cellFrom) / cellMinutes, to: (covered[1] - cellFrom) / cellMinutes, label };
    }
    return null;
  });
  return { start: quiet.start, end: quiet.end, holdHigh: quiet.holdHigh === true, held: Number.isFinite(quiet.held) ? Number(quiet.held) : 0, cells };
}

/**
 * The night's plan. Two jobs overlap when one starts while the other is still inside
 * [its start, its start + the longer of its last run and `defaultRunMs`].
 */
export function planTonight({ jobs, quiet, now, clock }: TonightInput): TonightPlan {
  const { start, end } = nightOf(now, clock);
  const columns = Array.from({ length: cellCount }, (_value, index) => {
    const at = start + index * cellMs;
    return { at, label: clockWords(clock(at)) };
  });
  const hours = columns.filter((_column, index) => index % 2 === 0).map((column) => ({ at: column.at, label: column.label.slice(0, 2) }));

  const due = jobs
    .filter((job) => job.enabled)
    .map((job) => ({ job, starts: startsOf(job, start, end) }))
    .filter((entry) => entry.starts.length > 0)
    .sort((left, right) => left.starts[0] - right.starts[0] || left.job.name.localeCompare(right.job.name));

  const rows: TonightRow[] = due.map(({ job, starts }) => {
    const first = clockWords(clock(starts[0]));
    const every = job.everyMinutes ?? 0;
    const cadence = starts.length < 2 ? "" : every === 60 ? ", then hourly" : every % 60 === 0 ? `, then every ${every / 60} hours` : `, then every ${every} min`;
    return { id: job.id, kind: job.kind, name: job.name, detail: job.detail ?? null, note: job.note ?? null, starts, startsLabel: `${first}${cadence}`, last: job.last, ...cellsOf(job, starts, start, clock), clashes: false };
  });

  const occurrences: Occurrence[] = rows
    .flatMap((row, index) => row.starts.map((at) => ({ row: index, at, until: at + Math.max(tookOf(row.last) ?? 0, defaultRunMs) })))
    .sort((left, right) => left.at - right.at || left.row - right.row);

  const pairs = new Map<string, Overlap>();
  for (let earlier = 0; earlier < occurrences.length; earlier += 1) {
    for (let later = earlier + 1; later < occurrences.length; later += 1) {
      const first = occurrences[earlier];
      const second = occurrences[later];
      if (second.at > first.until) break; // sorted by start: nothing further on starts inside this run
      if (second.row === first.row) continue; // the scheduler skips a run whose last one is still going
      const key = [rows[first.row].id, rows[second.row].id].sort().join("\n");
      const known = pairs.get(key);
      if (known) { known.times += 1; continue; }
      const one = rows[first.row];
      const other = rows[second.row];
      pairs.set(key, {
        earlier: { id: one.id, kind: one.kind, name: one.name },
        later: { id: other.id, kind: other.kind, name: other.name },
        at: second.at, atLabel: clockWords(clock(second.at)),
        earlierAt: first.at, earlierAtLabel: clockWords(clock(first.at)), earlierTookMs: tookOf(one.last),
        times: 1,
        move: other.starts.length === 1 ? freeSlot(occurrences, second, first.until, columns, clock) : null,
      });
      one.clashes = true;
      other.clashes = true;
      const cell = other.cells[Math.floor((second.at - start) / cellMs)];
      if (cell && cell.kind !== "spill") { cell.clash = true; cell.label = `${cell.label}, while ${one.name} is still running`; }
    }
  }

  const all = occurrences.map((occurrence) => occurrence.at);
  return {
    start, end, columns, hours, rows,
    quiet: quietRowOf(quiet, columns, clock),
    overlaps: [...pairs.values()].sort((left, right) => left.at - right.at),
    first: all.length ? clockWords(clock(Math.min(...all))) : null,
    last: all.length ? clockWords(clock(Math.max(...all))) : null,
  };
}

/**
 * The first half hour after `after` where the job would neither start inside another's run nor
 * have another start inside its own. Null when the rest of the night has no such half hour.
 */
function freeSlot(occurrences: Occurrence[], moving: Occurrence, after: number, columns: TonightPlan["columns"], clock: Clock): Overlap["move"] {
  const length = moving.until - moving.at;
  const others = occurrences.filter((occurrence) => occurrence.row !== moving.row);
  for (const column of columns) {
    const at = column.at;
    if (at <= after || at <= moving.at) continue;
    if (others.some((other) => (other.at <= at && at <= other.until) || (at <= other.at && other.at <= at + length))) continue;
    return { at, label: clockWords(clock(at)), deltaMinutes: Math.round((at - moving.at) / 60_000) };
  }
  return null;
}

/** The view's verdict. Anything that could not be read is "Not read", never green. */
export function verdictOf(plan: TonightPlan | null, unread: boolean): { status: Status; label: string } {
  if (unread || !plan) return { status: "unknown", label: "Not read" };
  if (plan.overlaps.length === 1) return { status: "warning", label: `Two jobs will run into each other at ${plan.overlaps[0].atLabel}` };
  if (plan.overlaps.length > 1) return { status: "warning", label: `${plan.overlaps.length} pairs of jobs will run into each other, the first at ${plan.overlaps[0].atLabel}` };
  if (plan.rows.length === 0) return { status: "neutral", label: "Nothing is due tonight" };
  return { status: "good", label: "Nothing overlaps tonight" };
}

/** The "Last run" column. */
export function lastRunWords(last: LastRun): string {
  switch (last.known) {
    case "took": return tookOf(last) === null ? "length not known" : last.failed ? `failed after ${durationWords(last.ms)}` : durationWords(last.ms);
    case "never": return "not run yet";
    case "running": return "running now";
    case "unknown": return "length not known";
    default: return "not read";
  }
}

/**
 * A daily or weekly cadence moved by some minutes, in the cadence's own terms: the hour and minute
 * a schedule is kept in are the server's clock, so the move is added to them and never read off
 * the browser's. Past midnight a weekly one moves to the next weekday.
 */
export function movedCadence(cadence: { frequency: "daily" | "weekly"; minute: number | null; hour: number | null; weekday: number | null }, deltaMinutes: number) {
  const total = (cadence.hour ?? 3) * 60 + (cadence.minute ?? 0) + deltaMinutes;
  const days = Math.floor(total / dayMinutes);
  const within = ((total % dayMinutes) + dayMinutes) % dayMinutes;
  return {
    frequency: cadence.frequency,
    minute: within % 60,
    hour: Math.floor(within / 60),
    weekday: cadence.frequency === "weekly" ? ((((cadence.weekday ?? 0) + days) % 7) + 7) % 7 : null,
  };
}

// ── From the lists the page already reads to planned jobs ──

/** The part of a job the lengths are read from. */
export interface JobTimes { id: string; state: string; createdAt?: string; updatedAt?: string }
/** The jobs that were read, by id; null when the history could not be read. */
export type JobHistory = ReadonlyMap<string, JobTimes> | null;

const finished = new Set(["completed", "failed"]);
const underWay = new Set(["applying", "verifying"]);

/**
 * How long a run of one or more jobs took: from the first being staged to the last ending. A
 * scheduled run is approved the moment it is staged, so that is its start; time spent waiting
 * behind another job counts, as it did on the night.
 */
function tookFrom(jobs: Array<JobTimes | undefined>): LastRun {
  if (jobs.length === 0 || jobs.some((job) => !job)) return { known: "unknown" };
  const found = jobs as JobTimes[];
  if (found.some((job) => underWay.has(job.state))) return { known: "running" };
  if (found.some((job) => !finished.has(job.state))) return { known: "unknown" };
  const from = Math.min(...found.map((job) => Date.parse(job.createdAt ?? "")));
  const to = Math.max(...found.map((job) => Date.parse(job.updatedAt ?? "")));
  if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) return { known: "unknown" };
  return { known: "took", ms: to - from, failed: found.some((job) => job.state === "failed") };
}

export function jobsFromSchedules(schedules: Schedule[], history: JobHistory): PlannedJob[] {
  return schedules.map((schedule) => {
    const subject = typeof schedule.parameters?.subject === "string" ? schedule.parameters.subject : typeof schedule.parameters?.id === "string" ? schedule.parameters.id : null;
    const last: LastRun = schedule.lastOutcome === "running" ? { known: "running" }
      : !schedule.lastJobId ? (schedule.lastRunAt ? { known: "unknown" } : { known: "never" })
        : !history ? { known: "unread" }
          : tookFrom([history.get(schedule.lastJobId)]);
    return { id: `schedule:${schedule.id}`, kind: "schedule", name: schedule.title, detail: subject, enabled: schedule.enabled, nextAt: schedule.nextDueAt, everyMinutes: schedule.frequency === "hourly" ? 60 : null, last };
  });
}

/** Automations that run on a cadence. One started by a webhook, a drive or another flow has no time to show. */
export function jobsFromFlows(flows: Flow[], history: JobHistory): PlannedJob[] {
  return flows.filter((flow) => flow.frequency && flow.nextDueAt).map((flow) => {
    const ids = flow.lastJobIds.filter((id): id is string => typeof id === "string");
    const last: LastRun = flow.running ? { known: "running" }
      : !flow.lastRunAt ? { known: "never" }
        : flow.lastRunElsewhere || ids.length === 0 ? { known: "unknown" }
          : !history ? { known: "unread" }
            : tookFrom(ids.map((id) => history.get(id)));
    return { id: `automation:${flow.id}`, kind: "automation", name: flow.name, detail: "automation", enabled: flow.enabled, nextAt: flow.nextDueAt, everyMinutes: flow.frequency === "hourly" ? 60 : null, last };
  });
}

const agentRan = new Set(["completed", "degraded"]);
const agentFailed = new Set(["failed", "timeout", "killed", "interrupted"]);

/**
 * Agents with a schedule. A run joins the runner's queue at its time and starts when the runner
 * is free, so its cell says "queued"; one that waits for the agents' quiet hours says so.
 * `runs` holds each agent's recent runs, null for one whose runs could not be read.
 */
export function jobsFromAgents(agents: AgentSummary[], agentsModule: Pick<ModuleState, "enabled" | "paused" | "pausedUntil" | "quietHours">, runs: Record<string, Run[] | null | undefined>): PlannedJob[] {
  const before = (until: string | null, next: string) => until !== null && Date.parse(until) <= Date.parse(next);
  return agents.filter((agent) => agent.triggers?.schedule && agent.nextRunAt).map((agent) => {
    const next = agent.nextRunAt as string;
    const schedule = agent.triggers.schedule;
    const recent = runs[agent.id];
    const scheduled = (recent ?? []).filter((run) => run.kind === "schedule");
    const measured = scheduled.find((run) => run.startedAt && run.finishedAt && (agentRan.has(run.state) || agentFailed.has(run.state)));
    const took = measured ? Date.parse(measured.finishedAt as string) - Date.parse(measured.startedAt as string) : Number.NaN;
    const last: LastRun = recent === null || recent === undefined ? { known: "unread" }
      : scheduled.some((run) => run.state === "running") ? { known: "running" }
        : measured && Number.isFinite(took) && took >= 0 ? { known: "took", ms: took, failed: agentFailed.has(measured.state) }
          : scheduled.length ? { known: "unknown" } : { known: "never" };
    return {
      id: `agent:${agent.id}`, kind: "agent", name: agent.name, detail: "agent",
      note: agent.waitsForQuietHours ? `waits for the agents' quiet hours, ${agentsModule.quietHours.start} to ${agentsModule.quietHours.end}` : null,
      // Off or paused past its time, it will not run: only what will is on the chart.
      enabled: agentsModule.enabled && (!agentsModule.paused || before(agentsModule.pausedUntil, next)) && (!agent.paused || before(agent.pausedUntil, next)),
      nextAt: next,
      everyMinutes: schedule?.every === "hourly" ? 60 : schedule?.every === "every-6-hours" ? 360 : null,
      last,
    };
  });
}
