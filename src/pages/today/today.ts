import { backupGlance, type BackupGlance } from "../../home/backupGlance";
import type { FactValues, Facts } from "../../home/facts";
import { buildNeeds, backupOperation, verdictFor, verdictSources, type Need, type Verdict } from "../../home/needs";
import { jobState, jobTarget } from "../../home/opsFacts";
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
export interface RanGroup { kind: RanKind; label: string; completed: number; failed: number; running: number; jobs: RanJob[] }

const groupLabels: Record<RanKind, string> = { backup: "Backups", update: "Updates", other: "Other jobs" };
const finishedOrRunning = new Set(["completed", "failed", "applying", "verifying"]);

/**
 * Jobs that ran, or are running, since the window opened, grouped as the owner thinks of them.
 * Staged jobs are the needs list's (they wait for a person); a cancelled one never ran.
 */
export function whatRan(jobs: Job[], since: number, { perGroup = 6 }: { perGroup?: number } = {}): RanGroup[] {
  const within = jobs.filter((job) => finishedOrRunning.has(job.state) && Date.parse(job.updatedAt ?? job.createdAt ?? "") >= since);
  const groups: RanGroup[] = [];
  for (const kind of ["backup", "update", "other"] as const) {
    const ofKind = within.filter((job) => ranKind(job) === kind);
    if (!ofKind.length) continue;
    groups.push({
      kind,
      label: groupLabels[kind],
      completed: ofKind.filter((job) => job.state === "completed").length,
      failed: ofKind.filter((job) => job.state === "failed").length,
      running: ofKind.filter((job) => job.state === "applying" || job.state === "verifying").length,
      // Failures first: they are what the glance is for.
      jobs: [...ofKind].sort((a, b) => Number(b.state === "failed") - Number(a.state === "failed") || (b.updatedAt ?? "").localeCompare(a.updatedAt ?? "")).slice(0, perGroup)
        .map((job) => {
          const state = jobState(job);
          const target = jobTarget(job);
          return { id: job.id, title: job.title, target: target === "—" ? "" : target, status: state.status, label: state.label, at: job.updatedAt ?? job.createdAt ?? "" };
        }),
    });
  }
  return groups;
}

export interface TodayModel {
  verdict: Verdict;
  /** Some of what the verdict rests on is still being read. */
  checking: boolean;
  /** Jobs staged and waiting for a person, first; each opens the approval dialog at its own tier. */
  approvals: Need[];
  /** Everything else that needs a look, worst first; what can wait is left to Home. */
  attention: Need[];
  /** How many more can wait (Home lists them). */
  canWait: number;
  window: OvernightWindow;
  ran: RanGroup[];
  backups: BackupGlance;
}

export function todayModel(facts: Facts, jobs: Job[], { now, role }: { now: number; role: string }): TodayModel {
  const values: FactValues = Object.fromEntries(Object.entries(facts).map(([key, source]) => [key, source.value])) as FactValues;
  const needs = buildNeeds(values, { now, role });
  const checking = verdictSources.some(([key]) => facts[key].state === "idle" || facts[key].state === "loading");
  const unread = verdictSources.filter(([key]) => facts[key].state === "failed").map(([, words]) => words);
  const hostname = values.inventory?.hostname ?? "This server";
  const window = overnightWindow(now);
  return {
    verdict: verdictFor(needs, { hostname, checking, unread }),
    checking,
    approvals: needs.filter((need) => need.kind === "approval"),
    attention: needs.filter((need) => need.kind !== "approval" && need.severity !== "neutral"),
    canWait: needs.filter((need) => need.kind !== "approval" && need.severity === "neutral").length,
    window,
    ran: whatRan(jobs, window.since),
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
