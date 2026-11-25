import { backupGlance, type BackupGlance } from "../../home/backupGlance";
import type { FactValues, Facts } from "../../home/facts";
import type { HistoryState } from "../../home/jobHistory";
import { buildNeeds, backupOperation, verdictFor, verdictSources, type Need, type Verdict } from "../../home/needs";
import { jobState, jobTarget } from "../../home/opsFacts";
import { dismissedFailure, failureSettled, jobWork } from "../../jobStatus";
import type { Job } from "../../operations";
import type { Status } from "../../ui/types";

/*
 * Today (M25.3): the morning glance, one screen on a phone. What needs the owner (approvals first),
 * what ran overnight, and whether the backups are off this server and current. Every fact comes from
 * what Home and Ops already read (src/home/facts.tsx, buildNeeds, backupGlance); this file only says
 * which of it belongs on the glance, as one plain model the page draws and keeps for offline reads.
 */

export interface OvernightWindow { since: number; label: string }

/**
 * "Overnight", by the clock of the device reading it: from 18:00 yesterday until 18:00 today, then
 * from 06:00 today, so the evening's glance is of the day, not of the night before as well.
 */
export function overnightWindow(now: number): OvernightWindow {
  const evening = new Date(now);
  evening.setHours(18, 0, 0, 0);
  if (now >= evening.getTime()) {
    const morning = new Date(now);
    morning.setHours(6, 0, 0, 0);
    return { since: morning.getTime(), label: "since 06:00" };
  }
  const yesterday = new Date(evening);
  yesterday.setDate(yesterday.getDate() - 1);
  return { since: yesterday.getTime(), label: "since 18:00 yesterday" };
}

export type RanKind = "backup" | "update" | "other";
const updateOperation = /^(app\.update|app\.rollback|apt\.|system\.update|system\.reboot)/;

export function ranKind(job: Pick<Job, "type">): RanKind {
  const operation = job.type.replace(/^op:/, "");
  if (backupOperation.test(operation)) return "backup";
  if (updateOperation.test(operation)) return "update";
  return "other";
}

export interface RanJob { id: string; title: string; target: string; status: Status; label: string; at: string }
export interface RanGroup {
  kind: RanKind;
  label: string;
  completed: number;
  /** Failures nobody has dealt with: not dismissed, not run again, not since done by a later run (M88). */
  failed: number;
  /** Failures the owner dismissed: listed, not counted as failed. */
  dismissed?: number;
  running: number;
  jobs: RanJob[];
}

const groupLabels: Record<RanKind, string> = { backup: "Backups", update: "Updates", other: "Other jobs" };
const finishedOrRunning = new Set(["completed", "failed", "applying", "verifying"]);
/** What a later job of the same work must be to stand in a failure's place in the list. */
const listedInstead = new Set(["completed", "applying", "verifying"]);

/**
 * Jobs that ran, or are running, since the window opened, grouped as the owner thinks of them.
 * Staged jobs are the needs list's (they wait for a person); a cancelled one never ran. A failure
 * dealt with since (dismissed, run again, or done by a later run of the same work, as the needs list
 * judges it: jobStatus failureSettled) is not counted as failed nor listed first (M88). One a later
 * run that completed or is running covers is left out: that run is in the list; one only dismissed,
 * or tried again by a job still waiting for approval, stays.
 */
export function whatRan(jobs: Job[], since: number, { perGroup = 6 }: { perGroup?: number } = {}): RanGroup[] {
  const open = (job: Job) => job.state === "failed" && !failureSettled(job, jobs);
  // Covered by a later job this list shows in its place (M88 review): one that completed or is
  // running. A retry still waiting for approval is not listed here, so it does not hide the failure.
  const coveredByLater = (job: Job) => {
    if (job.state !== "failed") return false;
    const at = Date.parse(job.createdAt ?? "");
    const work = jobWork(job);
    return jobs.some((other) => other.id !== job.id && listedInstead.has(other.state) && (
      other.recovery?.retryOf === job.id || other.recovery?.rerunOf === job.id
      || (jobWork(other) === work && Date.parse(other.createdAt ?? "") > at)
    ));
  };
  const within = jobs.filter((job) => finishedOrRunning.has(job.state) && Date.parse(job.updatedAt ?? job.createdAt ?? "") >= since && !coveredByLater(job));
  const groups: RanGroup[] = [];
  for (const kind of ["backup", "update", "other"] as const) {
    const ofKind = within.filter((job) => ranKind(job) === kind);
    if (!ofKind.length) continue;
    groups.push({
      kind,
      label: groupLabels[kind],
      completed: ofKind.filter((job) => job.state === "completed").length,
      failed: ofKind.filter(open).length,
      dismissed: ofKind.filter(dismissedFailure).length,
      running: ofKind.filter((job) => job.state === "applying" || job.state === "verifying").length,
      // Failures still open first: they are what the glance is for.
      jobs: [...ofKind].sort((a, b) => Number(open(b)) - Number(open(a)) || (b.updatedAt ?? "").localeCompare(a.updatedAt ?? "")).slice(0, perGroup)
        .map((job) => {
          const state = jobState(job);
          const target = jobTarget(job);
          return { id: job.id, title: job.title, target: target === "—" ? "" : target, status: state.status, label: state.label, at: job.updatedAt ?? job.createdAt ?? "" };
        }),
    });
  }
  return groups;
}

/** Whether a panel's list has been read: none of them says "nothing" before it has (M88). */
type ReadState = "reading" | "ready" | "failed";

export interface TodayModel {
  verdict: Verdict;
  /** Some of what the verdict rests on is still being read. */
  checking: boolean;
  /** The sources that could not be read, in words, so "Needs a look" can say it may be missing something (M88). */
  unread?: string[];
  /** Jobs staged and waiting for a person, first; each opens the approval dialog at its own tier. */
  approvals: Need[];
  /** Whether the jobs that hold the approvals were read (absent in a copy kept before M88: ready). */
  approvalsState?: ReadState;
  /** Everything else that needs a look, worst first; what can wait is left to Home. */
  attention: Need[];
  /** How many more can wait (Home lists them). */
  canWait: number;
  window: OvernightWindow;
  ran: RanGroup[];
  /** Whether the jobs that ran were read (absent in a copy kept before M88: ready). */
  ranState?: ReadState;
  backups: BackupGlance;
}

/**
 * The header's verdict, with the approvals counted apart (M88): they are listed in their own panel,
 * so "One thing needs a look" above an empty "Needs a look" read as a contradiction. The rest is the
 * verdict Home gives; the approvals are said after it, in their own words.
 */
export function todayVerdict(needs: Need[], { hostname, checking, unread }: { hostname: string; checking: boolean; unread: string[] }): Verdict {
  const approvals = needs.filter((need) => need.kind === "approval").length;
  const rest = needs.filter((need) => need.kind !== "approval");
  const verdict = verdictFor(rest, { hostname, checking, unread });
  if (!approvals) return verdict;
  const waiting = approvals === 1 ? "One job waits for your approval." : `${approvals} jobs wait for your approval.`;
  const label = approvals === 1 ? "1 to approve" : `${approvals} to approve`;
  if (verdict.status === "danger" || verdict.status === "warning") return { ...verdict, sentence: `${verdict.sentence} ${waiting}` };
  if (verdict.status === "good") {
    const neutral = rest.filter((need) => need.severity === "neutral").length;
    return { status: "warning", label, sentence: `${hostname} is running. ${waiting}${neutral ? ` ${neutral === 1 ? "One more thing" : `${neutral} more`} can wait.` : ""}` };
  }
  // Still checking, or not all read: that stays said, and the approval is known all the same.
  return { status: "warning", label, sentence: `${verdict.sentence} ${waiting}` };
}

/** A panel's state from the sources its list is read from: ready once any has answered, failed when all have. */
const readState = (states: string[]): ReadState => (states.includes("ready") ? "ready" : states.every((state) => state === "failed") ? "failed" : "reading");

export function todayModel(facts: Facts, jobs: Job[], { now, role, history = "ready" }: { now: number; role: string; history?: HistoryState }): TodayModel {
  const values: FactValues = Object.fromEntries(Object.entries(facts).map(([key, source]) => [key, source.value])) as FactValues;
  // The live feed carries every approval; the merged history (which also does, M88) stands in for
  // it when the feed could not be read, and the failures are found in it.
  const needs = buildNeeds(values, { now, role, history: jobs });
  const checking = verdictSources.some(([key]) => facts[key].state === "idle" || facts[key].state === "loading");
  const unread = verdictSources.filter(([key]) => facts[key].state === "failed").map(([, words]) => words);
  const hostname = values.inventory?.hostname ?? "This server";
  const window = overnightWindow(now);
  const jobsState = readState([facts.jobs.state, history]);
  return {
    verdict: todayVerdict(needs, { hostname, checking, unread }),
    checking,
    unread,
    approvals: needs.filter((need) => need.kind === "approval"),
    approvalsState: jobsState,
    attention: needs.filter((need) => need.kind !== "approval" && need.severity !== "neutral"),
    canWait: needs.filter((need) => need.kind !== "approval" && need.severity === "neutral").length,
    window,
    ran: whatRan(jobs, window.since),
    ranState: jobsState,
    backups: backupGlance(values, { protection: facts.protection.state, offBox: facts.offBox.state, database: facts.database.state }, now),
  };
}

/**
 * What is kept for offline reads (src/pwa/lastKnown.ts): the model with every button taken off,
 * because nothing can be approved or run from a copy.
 */
export function offlineCopy(model: TodayModel): TodayModel {
  const bare = (need: Need): Need => ({ id: need.id, kind: need.kind, severity: need.severity, title: need.title, detail: need.detail, view: need.view, action: null, ...(need.risk ? { risk: need.risk } : need.action ? { risk: need.action.risk } : {}) });
  return { ...model, approvals: model.approvals.map(bare), attention: model.attention.map(bare) };
}
