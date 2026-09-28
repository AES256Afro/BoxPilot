/**
 * The weekly self-report (M30.4): one push a week to the notification target saying what ran, what
 * failed, what did not run and why, and what is not covered yet. The morning glance M25.3 promised,
 * from the server side.
 *
 * Everything in it is already recorded: the jobs table, the schedule and automation records, the
 * health-alert ledger, and the backups table. The one extra read is "not covered yet", which asks
 * the same setup checklist the Overview shows and the helper's list of apps with backups; if either
 * cannot answer, that line is left out rather than guessed.
 *
 * It is on by default, like every other push BoxPilot sends once a target is set, and goes out on
 * Sunday at 09:00 server time: after the nightly backup window, at an hour a phone may buzz. The
 * time comes from the scheduler's own computeNextRun, so a daylight-saving change does not move it.
 * With no target it becomes one "not announced" entry in the ledger, replaced each week.
 */
import { registry as defaultRegistry } from "./ops/index.mjs";
import { computeNextRun, describeCadence, scheduleOutcome } from "./scheduler.mjs";
import { overdueScheduleIds } from "./schedule-freshness.mjs";
import { isNotice } from "./health-alerts.mjs";

export const reportCadence = Object.freeze({ frequency: "weekly", weekday: 0, hour: 9, minute: 0 });
export const reportKey = "report.weekly";
const settingKey = "weeklyReport";
const weekMs = 7 * 24 * 60 * 60_000;
// A report the server was off for is dropped once it is this late, rather than pushed at whatever
// hour the machine came back (an unattended-upgrades reboot at 03:00 is the usual one).
const lateLimitMs = 6 * 60 * 60_000;
const jobWindow = 200; // the most the jobs table hands back at once; more than that says "200+"

/** "A, B and 3 more", for a line that has to fit on a phone. */
function some(names, shown = 3, separator = ", ") {
  const list = [...new Set(names)].filter(Boolean);
  if (list.length <= shown) return list.join(separator);
  return `${list.slice(0, shown).join(separator)} and ${list.length - shown} more`;
}
const short = (text, limit = 80) => (text.length > limit ? `${text.slice(0, limit - 1).trimEnd()}…` : text);
const plural = (count, word, words = `${word}s`) => `${count} ${count === 1 ? word : words}`;
const labelOf = (title, parameters) => {
  const subject = parameters?.id ?? parameters?.name ?? parameters?.subject ?? null;
  return `${title}${typeof subject === "string" && subject ? ` (${subject})` : ""}`;
};
const day = (date) => date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
function age(iso, at) {
  const days = Math.floor((at.getTime() - Date.parse(iso)) / (24 * 60 * 60_000));
  if (!Number.isFinite(days)) return null;
  return days < 1 ? "today" : `${plural(days, "day")} ago`;
}

/** The essentials the setup checklist still has open, in a phrase each. Unknown items are left out. */
const gapPhrases = {
  tailscale: "not reachable away from home",
  firewall: "firewall not set up with a profile",
  updates: "security updates do not install automatically",
  notifications: "no notification target",
  backups: "no second copy of the backups",
  // M26.3's item. Open and known only while smartctl or fsck.exfat is missing.
  "drive-checks": "the drive check tools are not installed",
};

/** What is not covered yet, from the checklist and the apps with data worth backing up. */
export function uncovered({ checklist = null, protection = null, schedules = [] } = {}) {
  const gaps = [];
  for (const item of checklist?.items ?? []) {
    if (item.optional || item.done || item.known === false) continue;
    gaps.push(gapPhrases[item.id] ?? item.title);
  }
  if (protection?.available && Array.isArray(protection.apps)) {
    const scheduled = new Set(schedules.filter((schedule) => schedule.operationId === "app.backup" && schedule.enabled !== false).map((schedule) => schedule.parameters?.id));
    const bare = protection.apps.filter((app) => app.protectable && !scheduled.has(app.id)).map((app) => app.name ?? app.id);
    if (bare.length) gaps.push(`no backup schedule for ${some(bare)}`);
  }
  return gaps;
}

/** Read the week out of what BoxPilot recorded. `coverage` may fail; its line is then left out. */
export async function gatherWeek({ store, registry = defaultRegistry, now = () => new Date(), coverage = async () => null }) {
  const to = now();
  const from = new Date(to.getTime() - weekMs);
  const inWeek = (iso) => { const at = Date.parse(iso ?? ""); return Number.isFinite(at) && at > from.getTime() && at <= to.getTime(); };

  // What ran: every job started in the week, by hand, by a schedule or by an automation.
  const recent = store.listJobs(jobWindow);
  const week = recent.filter((job) => inWeek(job.createdAt));
  const finished = week.filter((job) => ["completed", "failed"].includes(job.state));
  const failedJobs = week.filter((job) => job.state === "failed");

  // What did not run, and why: schedules and automations that were due and did not start.
  const schedules = store.listSchedules();
  const behind = overdueScheduleIds(schedules, { now: to });
  const skipped = [];
  let paused = 0;
  for (const schedule of schedules) {
    const name = labelOf(registry.get(schedule.operationId)?.title ?? schedule.operationId, schedule.parameters);
    if (!schedule.enabled) { paused += 1; continue; }
    if (behind.has(schedule.id)) { skipped.push({ name, why: "it has fallen behind; the server may have been off" }); continue; }
    if (!inWeek(schedule.lastRunAt)) continue;
    const { outcome, reason } = scheduleOutcome(schedule, schedule.lastResult === "started" && schedule.lastJobId ? store.getJob(schedule.lastJobId) : null);
    if (outcome === "did-not-run") skipped.push({ name, why: reason });
  }
  const stopped = [];
  for (const flow of store.listFlows?.() ?? []) {
    // Anything that starts it without a person: a clock, another flow, a webhook, a drive dropping.
    const unattended = Boolean(flow.frequency || flow.triggerFlowId || flow.webhookEnabled || flow.triggerDrive);
    if (!flow.enabled && unattended) { paused += 1; continue; }
    if (!inWeek(flow.lastRunAt) || !flow.lastResult) continue;
    if (flow.lastResult.startsWith("skipped:")) skipped.push({ name: flow.name, why: flow.lastResult.slice("skipped:".length).trim() });
    else if (/^(stopped at|failed at|lost sight|interrupted|completed with problems)/.test(flow.lastResult)) stopped.push(flow.name);
  }

  // What is wrong right now, and what reached no one: the ledger the Overview reads.
  const ledger = Object.entries(store.getSetting("healthAlertsState", {}) ?? {}).filter(([key, entry]) => entry && key !== reportKey);
  const open = ledger.filter(([key]) => !isNotice(key)).map(([key, entry]) => entry.title ?? key);
  const unannounced = ledger.filter(([, entry]) => entry.notified === false).length;

  // Backups: the database's own, from the backups table, and the apps' from their jobs.
  const database = store.listBackups(jobWindow).find((backup) => backup.applicationId === "boxpilot-controller") ?? null;
  const appBackups = finished.filter((job) => job.type === "op:app.backup" && job.state === "completed").length;

  let gaps = null;
  try {
    const evidence = await coverage();
    if (evidence) gaps = uncovered({ ...evidence, schedules });
  } catch { gaps = null; }

  return {
    from, to,
    jobs: { ran: finished.length, failed: failedJobs.length, failedNames: failedJobs.map((job) => labelOf(job.title, job.parameters)), more: recent.length === jobWindow && inWeek(recent.at(-1)?.createdAt) },
    skipped, paused, stopped, open, unannounced,
    backups: { appBackups, databaseAt: database?.createdAt ?? null },
    gaps,
  };
}

/** The push itself: a title that says the verdict, and a few short lines. Pure. */
export function composeWeeklyReport(week) {
  const { from, to, jobs, skipped = [], paused = 0, stopped = [], open = [], unannounced = 0, backups = {}, gaps = null } = week;
  const verdict = [jobs.failed ? `${jobs.failed} failed` : null, skipped.length ? `${skipped.length} did not run` : null].filter(Boolean);
  const title = verdict.length ? `Weekly report, ${verdict.join(" and ")}` : "Weekly report, nothing failed";
  const ran = `${jobs.more ? `${jobWindow}+` : jobs.ran} ${jobs.ran === 1 && !jobs.more ? "job" : "jobs"} ran`;
  const lines = [
    `${day(from)} to ${day(to)}: ${ran}, ${jobs.failed ? `${jobs.failed} failed: ${some(jobs.failedNames)}` : "none failed"}.`,
  ];
  if (skipped.length) lines.push(`Did not run: ${some(skipped.map(({ name, why }) => (why ? `${name} (${short(why)})` : name)), 2, "; ")}.${paused ? ` ${plural(paused, "schedule or automation", "schedules or automations")} paused.` : ""}`);
  else if (paused) lines.push(`Paused: ${plural(paused, "schedule or automation", "schedules or automations")}.`);
  if (stopped.length) lines.push(`Automations that stopped: ${some(stopped)}.`);
  if (open.length || unannounced) {
    lines.push([
      open.length ? `Still open: ${some(open.map((title) => short(title)), 1)}` : null,
      unannounced ? `${plural(unannounced, "thing")} not announced, listed on the Overview` : null,
    ].filter(Boolean).join("; ") + ".");
  }
  const database = backups.databaseAt ? `database backed up ${age(backups.databaseAt, to)}` : "no database backup yet";
  lines.push(`Backups: ${backups.appBackups ? `${plural(backups.appBackups, "app backup")} this week` : "no app backups this week"}; ${database}.`);
  if (gaps?.length) lines.push(`Not covered yet: ${some(gaps, 3, "; ")}.`);
  return { title, message: lines.join("\n").slice(0, 1000) };
}

export function createWeeklyReport({ store, alerts, notifications, registry = defaultRegistry, coverage = async () => null, now = () => new Date(), intervalMs = 60_000, setInterval: schedule = globalThis.setInterval, clearInterval: unschedule = globalThis.clearInterval }) {
  const read = () => ({ enabled: true, nextDueAt: null, lastSentAt: null, lastResult: null, ...(store.getSetting(settingKey, null) ?? {}) });
  const write = (changes, updatedBy = null) => store.setSetting(settingKey, { ...read(), ...changes }, { updatedBy });

  async function preview() {
    return composeWeeklyReport(await gatherWeek({ store, registry, now, coverage }));
  }

  function status() {
    const settings = read();
    const enabled = settings.enabled !== false;
    return {
      enabled,
      cadence: describeCadence(reportCadence),
      nextDueAt: enabled ? settings.nextDueAt ?? computeNextRun(reportCadence, now()).toISOString() : null,
      lastSentAt: settings.lastSentAt,
      lastResult: settings.lastResult,
      targetConfigured: Boolean(notifications.getTarget()),
    };
  }

  function setEnabled(enabled, { updatedBy = null } = {}) {
    // Switched on, it waits for the next Sunday rather than sending the one it missed.
    write({ enabled: Boolean(enabled), nextDueAt: enabled ? computeNextRun(reportCadence, now()).toISOString() : null }, updatedBy);
    store.recordAudit("settings.weekly-report.changed", { actorId: updatedBy, subjectId: updatedBy, details: { enabled: Boolean(enabled) } });
    return status();
  }

  /** Send when due. The next time is written before sending, so a slow send cannot send twice. */
  let busy = false;
  async function tick() {
    if (busy) return { sent: false, reason: "busy" };
    busy = true;
    try {
      const settings = read();
      if (settings.enabled === false) return { sent: false, reason: "off" };
      const at = now();
      const due = Date.parse(settings.nextDueAt ?? "");
      const next = computeNextRun(reportCadence, at).toISOString();
      if (!Number.isFinite(due)) { write({ nextDueAt: next }); return { sent: false, reason: "scheduled" }; }
      if (at.getTime() < due) return { sent: false, reason: "not-due" };
      if (at.getTime() - due > lateLimitMs) {
        write({ nextDueAt: next, lastResult: "missed" });
        store.recordAudit("report.weekly.missed", { actorId: null, subjectId: reportKey, details: { due: settings.nextDueAt, at: at.toISOString() } });
        return { sent: false, reason: "missed" };
      }
      write({ nextDueAt: next });
      const report = await preview();
      // Through the ledger: delivered, or kept as the one not-announced report, replacing last week's.
      const { notified } = await alerts.tell({ key: reportKey, title: report.title, message: report.message, priority: "default" });
      write({ lastSentAt: notified ? at.toISOString() : settings.lastSentAt, lastResult: notified ? "sent" : "not-announced" });
      return { sent: notified, reason: notified ? "sent" : "not-announced", ...report };
    } finally {
      busy = false;
    }
  }

  /** "Send now" from Settings: the person is looking, so a failure is theirs to see, not the ledger's. */
  async function sendNow({ actorId = null } = {}) {
    const report = await preview();
    await notifications.send({ title: `BoxPilot: ${report.title}`, message: report.message, priority: "default" });
    // The newest report reached the target; an older one still waiting has nothing left to say.
    await alerts.clear(reportKey, { quietly: true });
    write({ lastSentAt: now().toISOString(), lastResult: "sent" }, actorId);
    store.recordAudit("report.weekly.sent", { actorId, subjectId: reportKey, details: { manual: true } });
    return { sent: true, ...report };
  }

  function start() {
    const timer = schedule(() => { tick().catch(() => {}); }, intervalMs);
    timer.unref?.();
    return () => unschedule(timer);
  }

  return { status, preview, setEnabled, tick, sendNow, start };
}
