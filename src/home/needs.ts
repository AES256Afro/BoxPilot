import type { AppProtection } from "../backupProtection";
import { behindBackupSchedules, judgeProtection, protectionWarning } from "../backupProtection";
import { countOf, sentenceList, type ViewName } from "../data";
import { jobTimeout, mayStillBeRunning } from "../JobTimeout";
import { dismissedFailure, failureSettled, jobSubject, ranAgain } from "../jobStatus";
import { mirrorOperations, offBoxWarning } from "../offBox";
import type { Job } from "../operations";
import { fixesOf, type Finding, type RepairFix } from "../repair/types";
import { mayStart, riskOf } from "../ui/operationRisk";
import type { RiskTier, Status } from "../ui/types";
import type { AppFact, FactValues, Facts } from "./facts";
import { relativeTime } from "./format";
import { adviseRetry, failureLine, type RetryAdvice } from "../retryAdvice";

/*
 * "What needs you" (M33.2): everything BoxPilot knows that the owner should look at or act on,
 * as one ordered list that Home shows as it is and Ops groups by risk tier (M33.3). Pure: the
 * facts and the clock come in, the list comes out. It carries over every attention item the
 * Classic overview raised, so Home says at least what that page said.
 */

export type NeedKind = "alert" | "repair" | "approval" | "updates" | "backup" | "job" | "setup";
export type NeedSeverity = "danger" | "warning" | "neutral";

/**
 * A fix that can be started from the list itself, through the ordinary approval dialog. A Repair
 * finding's fixes carry the finding's own `fix`, so Home and Ops run them exactly as Repair does
 * (M35): recorded against the finding, and the finding checked again when the job ends. `dismiss`
 * sets a failed job aside; it runs nothing. `open` goes to the page where the fix is, when a failure
 * names one: running the same thing again would only fail the same way.
 */
export interface NeedAction {
  kind?: "operation" | "schedule" | "dismiss" | "open";
  /** For `open`: the page, and its tab, where the fix is. */
  open?: { view: ViewName; tab?: string };
  fix?: RepairFix;
  /** Stage this timed-out job again with more time, rather than `operationId` afresh (M30.3). */
  moreTimeFor?: string;
  operationId: string;
  /** The button's word: "Install", "Start". */
  label: string;
  /** The approval dialog's title: "Install all updates". */
  title: string;
  parameters: Record<string, unknown>;
  preview: string;
  risk: RiskTier;
  /** A job already staged: the dialog approves that one, at the tier it was staged at (M36). */
  existingJobId?: string;
}

export interface Need {
  id: string;
  kind: NeedKind;
  severity: NeedSeverity;
  title: string;
  detail: string | null;
  /** The page with this fact's detail. */
  view: ViewName;
  /** The app it is about, so the catalog can open at its card. */
  appId?: string;
  /** Null when there is nothing to run from here, or the role may not run it. */
  action: NeedAction | null;
  /** Every button, `action` first; more than one when a finding has several fixes, or a failure can be dismissed. */
  actions?: NeedAction[];
  /** The Repair finding this is, so its fix runs as Repair runs it. */
  finding?: Finding;
  /** The tier of something already staged (a job waiting for approval), shown beside it. */
  risk?: RiskTier;
  /** The job it is about: its title opens that job in Activity, where it can be approved, cancelled or dismissed (M36). */
  jobId?: string;
}

/** How long a failed job stays on the list if nobody deals with it; Activity keeps it after that (M36). */
export const failureShownForMs = 7 * 86_400_000;

/** Where the owner goes about a watched condition: schedules live on System, flows on Automations. */
export function watchView(family: string): ViewName {
  if (family === "schedule.failed") return "system";
  if (family === "flow.failed") return "automations";
  if (family === "release.available") return "system";
  if (family === "drive.reconnected") return "storage";
  if (family === "signin.new" || family === "report.weekly") return "settings";
  return "repairs";
}

/** Conditions that mean something is failing now, rather than drifting towards it. */
const dangerFamilies = new Set(["storage.root.full", "storage.mount.full", "storage.smart", "smart.errors", "power.ups", "docker.restarting"]);

const kindRank: Record<NeedKind, number> = { alert: 0, repair: 1, approval: 2, updates: 3, backup: 4, job: 5, setup: 6 };
const severityRank: Record<NeedSeverity, number> = { danger: 0, warning: 1, neutral: 2 };

/**
 * Worst first; among equals in the order the owner asked for: health alerts, Repair's findings,
 * jobs awaiting approval, updates, backups, then failed jobs and setup. The sort is stable, so
 * items of one kind keep the order they were found in.
 */
export function sortNeeds(needs: Need[]): Need[] {
  return [...needs].sort((a, b) => severityRank[a.severity] - severityRank[b.severity] || kindRank[a.kind] - kindRank[b.kind]);
}

/** Operations that make or copy a backup, by id: the needs list's backup rules, and Today's "what ran" (M25.3). */
export const backupOperation = /^(app\.backup|backup\.|controller\.backup|host\.snapshot|vm\.backup|vm\.export)/;

/** Docker's state for a container that is not serving, as a sentence. */
function containerWords(status: string): string {
  if (status === "restarting") return "Its container keeps restarting";
  if (status === "absent") return "Its container is missing";
  return "Its container is stopped";
}
const tierOf = (value: string): RiskTier | undefined => (value === "low" || value === "medium" || value === "high" ? value : undefined);
/** At most `limit` characters, cut at a word with an ellipsis. */
export const brief = (text: string, limit = 110): string => (text.length <= limit ? text : `${text.slice(0, limit).replace(/\s+\S*$/, "").replace(/[\s,:;.]+$/, "")}…`);
/** The button that goes where a failure's fix is, in place of a Try again that would fail the same way. */
const openAction = (next: NonNullable<RetryAdvice["next"]>): NeedAction => ({ kind: "open", open: { view: next.view, ...(next.tab ? { tab: next.tab } : {}) }, operationId: "", label: next.label, title: next.label, parameters: {}, preview: "", risk: "low" });
/** When something last happened, for comparing a failure with what came after it. */
const timeOf = (iso: string | null | undefined): number => { const at = Date.parse(iso ?? ""); return Number.isFinite(at) ? at : Number.NaN; };

export function buildNeeds(facts: FactValues, { now, role }: { now: number; role: string | null | undefined }): Need[] {
  const needs: Need[] = [];
  const act = (operationId: string, label: string, title: string, parameters: Record<string, unknown>, preview: string): NeedAction | null =>
    (mayStart(role, operationId) ? { operationId, label, title, parameters, preview, risk: riskOf(operationId) } : null);
  const apps = facts.catalog?.apps ?? [];
  const appName = (id: string) => apps.find((app) => app.id === id)?.name ?? facts.protection?.find((app) => app.id === id)?.name ?? id;

  // ── Health: what the watcher sees, and whatever BoxPilot could not tell anybody (M27.2). ──
  const watch = facts.watch;
  if (watch) {
    const unannounced = watch.alerts.filter((alert) => !alert.announced).length + watch.notices.length;
    if (unannounced > 0) {
      needs.push({ id: "unannounced", kind: "alert", severity: "warning", title: `BoxPilot could not tell you about ${countOf(unannounced, "thing")}`,
        detail: watch.targetConfigured ? "They have not reached your notification target yet" : "No notification target is set", view: "settings", action: null });
    }
    watch.alerts.forEach((alert, index) => needs.push({
      id: `alert:${alert.family}:${index}`, kind: "alert", severity: dangerFamilies.has(alert.family) ? "danger" : "warning", title: alert.title,
      detail: alert.since ? `Since ${relativeTime(alert.since, now)}` : null, view: watchView(alert.family), action: null,
    }));
  }

  // ── Apps: stopped, leaking, unwell. A pause is a choice, so it is said, not alarmed about. ──
  const findingIds = new Set((facts.repairs?.findings ?? []).map((finding) => finding.id));
  const missing: AppFact[] = [];
  for (const app of apps) {
    const base = { kind: "alert" as const, view: "catalog" as const, appId: app.id };
    if (app.vpnLeaked) needs.push({ ...base, id: `app-vpn:${app.id}`, severity: "danger", title: `${app.name} sent traffic outside its VPN`, detail: "The last kill-switch drill saw it leave the tunnel", action: null });
    if (!app.running && !app.paused) {
      // No container at all is said once for every such app, below. An app the owner stopped
      // from BoxPilot is a choice, like a pause; one that stopped by itself is a problem.
      if (app.status === "absent") missing.push(app);
      else if (app.stoppedOnPurpose && app.status !== "restarting") {
        needs.push({ ...base, id: `app-stopped:${app.id}`, severity: "neutral", title: `${app.name} is stopped`, detail: "Stopped on purpose from BoxPilot: it stays off until you start it",
          action: act("app.action", "Start", `Start ${app.name}`, { id: app.id, action: "start" }, `Starts ${app.name}.`) });
      } else {
        needs.push({ ...base, id: `app-down:${app.id}`, severity: "danger", title: `${app.name} is not running`, detail: containerWords(app.status),
          action: act("app.action", "Start", `Start ${app.name}`, { id: app.id, action: "start" }, `Starts ${app.name}.`) });
      }
    } else if (app.paused) {
      needs.push({ ...base, id: `app-paused:${app.id}`, severity: "neutral", title: `${app.name} is paused`, detail: "Paused on purpose: it keeps its memory and uses no CPU",
        action: act("app.action", "Resume", `Resume ${app.name}`, { id: app.id, action: "unpause" }, `Thaws ${app.name} exactly where it left off.`) });
    } else if (app.troubledSidecar || app.health === "unhealthy") {
      const what = app.troubledSidecar ? `Its ${app.troubledSidecar.id} container is ${app.troubledSidecar.status === "restarting" ? "restarting over and over" : "down"}` : "Docker's health check is failing";
      needs.push({ ...base, id: `app-unwell:${app.id}`, severity: "warning", title: `${app.name} is not healthy`, detail: what,
        action: act("app.action", "Restart", `Restart ${app.name}`, { id: app.id, action: "restart" }, `Restarts ${app.name}. Its data and settings are untouched.`) });
    }
    // Repair raises the same problem with its fix; when its scan answered, that is the one shown.
    if (app.running && app.folderProblems > 0 && !findingIds.has(`app-folder:${app.id}`)) {
      needs.push({ ...base, id: `app-folder:${app.id}`, severity: "warning", title: `${app.name} cannot write to its data folder`, detail: "Anything it saves there fails without saying why", action: null });
    }
    if (app.updateAvailable) {
      needs.push({ ...base, id: `app-update:${app.id}`, kind: "updates", severity: "neutral", title: `An update for ${app.name}`, detail: "Pulls the new image; the old one comes back if the new one is not healthy",
        action: act("app.update", "Update", `Update ${app.name}`, { id: app.id }, "Pulls the image and recreates the container. The previous image is restored if the new one fails to become healthy.") });
    }
  }
  // Listed as installed, with no container at all: on the owner's server, every app they had stopped,
  // deleted by the nightly clean-up's `docker system prune`. One item for all of them rather than a
  // problem each, said by what happened; Repair puts each back in one click (M35), and without its
  // scan the App catalog's Start builds the container again.
  const repairFindings = facts.repairs?.findings ?? [];
  const missingFindings = repairFindings.filter((finding) => finding.id.startsWith("app-missing:"));
  const listedOnRepair = missingFindings.length > 0;
  if (missing.length > 0) {
    const one = missing.length === 1;
    const named = missing.length <= 2 ? missing.map((app) => app.name).join(" and ") : `${missing.slice(0, 2).map((app) => app.name).join(", ")} and ${missing.length - 2} more`;
    // The clean-up that removed them, in the findings' own words ("the nightly clean-up").
    const cleanup = missingFindings.map((finding) => /removed by (.+?); your data is intact$/.exec(finding.title)?.[1]?.replace(/^most likely /, "")).find(Boolean) ?? null;
    needs.push({ id: "apps-missing", kind: "alert", severity: "warning", view: listedOnRepair ? "repairs" : "catalog", ...(one && !listedOnRepair ? { appId: missing[0].id } : {}),
      title: cleanup ? `${named} ${one ? "was" : "were"} removed by ${cleanup}` : `${named} ${one ? "has" : "have"} lost ${one ? "its container" : "their containers"}`,
      detail: listedOnRepair
        ? `Your data is intact. Repair puts ${one ? "it" : "each"} back in one click; ${one ? "an app" : "apps"} you had stopped come${one ? "s" : ""} back stopped.`
        : `${one ? "Its" : "Their"} data is still here. Start ${one ? "it" : "each"} from the App catalog to build ${one ? "its container" : "their containers"} again, or uninstall ${one ? "it" : "the ones"} you no longer want.`, action: null });
  }

  if ((facts.services?.failed ?? 0) > 0) {
    const failed = facts.services!.failed;
    needs.push({ id: "services", kind: "alert", severity: "danger", title: `${countOf(failed, "system service")} failed`, detail: "Services lists them with their journal", view: "services", action: null });
  }

  // ── Repair's findings, each with its fixes, run as Repair runs them (M35). Apps with no
  //    container are said once above; each one's Reinstall and Uninstall are on Repair. ──
  for (const finding of repairFindings) {
    if (finding.id.startsWith("app-missing:")) continue;
    const failedBefore = finding.lastAttempt?.state === "failed";
    // "Try again" only when the same fix can work again; a failure that names another place opens it.
    const advice: RetryAdvice = failedBefore ? adviseRetry(finding.lastAttempt?.error) : { retry: true };
    // A try that may still be running on the server is not offered again beside itself (sweep 4).
    const fixes = mayStillBeRunning(finding.lastAttempt) ? [] : fixesOf(finding)
      .filter((fix) => mayStart(role, fix.operationId))
      .map((fix, index): NeedAction => ({ kind: fix.kind === "schedule" ? "schedule" : "operation", fix, operationId: fix.operationId, label: index === 0 && failedBefore && advice.retry ? "Try again" : fix.label, title: fix.label, parameters: fix.parameters ?? {}, preview: fix.preview, risk: fix.risk ?? riskOf(fix.operationId) }));
    const actions = [...(advice.next && fixes.length ? [openAction(advice.next)] : []), ...fixes];
    needs.push({
      id: `repair:${finding.id}`, kind: "repair", finding,
      severity: finding.severity === "critical" ? "danger" : finding.severity === "warning" ? "warning" : "neutral",
      title: finding.title,
      // A row holds a line or two; the whole error is on Repair's card, with the job's log. What the
      // error says to do first is kept, even when the start of it has to be cut.
      detail: failedBefore ? failureLine("Last try failed: ", finding.lastAttempt?.error) : finding.evidence?.[0] ?? null,
      view: finding.view ?? "repairs", action: actions[0] ?? null, ...(actions.length > 1 ? { actions } : {}),
    });
  }

  // ── Jobs someone staged and nobody has approved yet. Repair holds the approval. ──
  const jobs = facts.jobs ?? [];
  for (const job of jobs.filter((entry) => entry.state === "awaiting_approval")) {
    // Reviewed and approved from the list itself (M36), through the dialog, at the tier it was staged at.
    const operationId = job.type.startsWith("op:") ? job.type.slice(3) : null;
    const tier = tierOf(job.risk);
    const review: NeedAction | null = operationId && tier && mayStart(role, operationId)
      ? { operationId, label: "Review", title: job.title, parameters: {}, preview: job.recovery?.reason ?? "", risk: tier, existingJobId: job.id } : null;
    needs.push({ id: `approval:${job.id}`, kind: "approval", severity: "warning", title: `Waiting for approval: ${job.title}`,
      detail: job.createdAt ? `Staged ${relativeTime(job.createdAt, now)}` : null, view: "repairs", action: review, risk: tier, jobId: job.id });
  }

  // ── Updates. ──
  const updates = facts.updates;
  if (updates?.rebootRequired) {
    needs.push({ id: "reboot", kind: "updates", severity: "warning", title: "A reboot is pending", detail: "A kernel or core library changed", view: "updates",
      action: act("system.reboot", "Reboot", "Reboot the server", {}, "First stops the apps using BoxPilot's drives and unmounts the drives, saying in the log which let go cleanly, then reboots 5 seconds later. Running VMs and containers stop and the apps start again by themselves; reconnect when this server is back.") });
  }
  if (updates && updates.count > 0) {
    needs.push({ id: "updates", kind: "updates", severity: updates.security > 0 ? "warning" : "neutral", title: `${countOf(updates.count, "update")} available`,
      detail: updates.security > 0 ? `${countOf(updates.security, "security fix", "security fixes")} among them` : "None of them are security fixes", view: "updates",
      action: act("apt.upgrade", "Install", "Install all updates", {}, `Upgrades ${countOf(updates.count, "package")} with apt-get upgrade --with-new-pkgs after refreshing the lists.`) });
  }
  if (facts.unattended && !facts.unattended.enabled) {
    needs.push({ id: "unattended", kind: "updates", severity: "neutral", title: "Security fixes wait for you", detail: "Automatic security updates are off", view: "updates",
      action: act("apt.unattended.set", "Turn on", "Turn on automatic updates", { enabled: true }, "Sets APT::Periodic::Unattended-Upgrade \"1\" so security updates install nightly.") });
  }

  // ── Backups: failed runs first, then what is not covered. ──
  const failedBackupApps = new Set<string>();
  const newestBackup = new Map<string, Job>();
  for (const job of jobs) {
    const id = job.parameters?.id;
    if (job.type === "op:app.backup" && typeof id === "string" && !newestBackup.has(id)) newestBackup.set(id, job);
  }
  // Backed up since, however it happened: Repair's "Back up now" for several apps runs one
  // app.backup.many, and the backups list knows the newest copy whoever made it. A failure followed
  // by a good copy is not a failure the owner still has to deal with.
  const backedUpSince = (id: string, since: number): boolean => {
    const newest = timeOf(facts.protection?.find((entry) => entry.id === id)?.newestAt);
    if (newest > since) return true;
    return jobs.some((other) => other.type === "op:app.backup.many" && other.state === "completed" && timeOf(other.createdAt) > since
      && Array.isArray(other.parameters?.ids) && (other.parameters.ids as unknown[]).includes(id));
  };
  for (const [id, job] of newestBackup) {
    if (job.state !== "failed" || ranAgain(job) || dismissedFailure(job)) continue;
    // "The backup succeeded, but the app did not start again": the copy is made; the app being down
    // is said with its own Start above.
    if (/^The backup succeeded\b/.test(job.error ?? "") || backedUpSince(id, timeOf(job.createdAt))) continue;
    failedBackupApps.add(id);
    // No space left on the device fails the same way every time: the button frees space instead.
    const advice = adviseRetry(job.error);
    const action = advice.retry
      ? act("app.backup", "Back up again", `Back up ${appName(id)}`, { id }, `Stops ${appName(id)} briefly, archives its data and configuration, restarts it, and keeps the newest 5 copies.`)
      : advice.next && mayStart(role, "app.backup") ? openAction(advice.next) : null;
    needs.push({ id: `backup-failed:${id}`, kind: "backup", severity: "danger", title: `The last backup of ${appName(id)} failed`, detail: job.error ? failureLine("", job.error) : null, view: "backups", appId: id, action });
  }
  const schedules = facts.schedules ?? [];
  for (const schedule of schedules) {
    if (!backupOperation.test(schedule.operationId) || !schedule.enabled) continue;
    if (schedule.lastOutcome !== "failed" && schedule.lastOutcome !== "did-not-run") continue;
    const subject = typeof schedule.parameters?.subject === "string" ? schedule.parameters.subject : null;
    if (subject && failedBackupApps.has(subject)) continue;
    // A run that failed at 03:00 is dealt with when the same thing worked since, by hand or otherwise:
    // it used to stay until the next night's run, beside a backup that had long since succeeded.
    const lastRun = timeOf(schedule.lastRunAt);
    if (Number.isFinite(lastRun) && ((subject && schedule.operationId === "app.backup" && backedUpSince(subject, lastRun))
      || jobs.some((other) => other.type === `op:${schedule.operationId}` && other.state === "completed" && timeOf(other.createdAt) > lastRun
        && (!subject || jobSubject(other).endsWith(`:${subject}`))))) continue;
    const what = subject ? `${schedule.title} (${appName(subject)})` : schedule.title;
    needs.push({ id: `schedule:${schedule.id}`, kind: "backup", severity: schedule.lastOutcome === "failed" ? "danger" : "warning",
      title: schedule.lastOutcome === "failed" ? `Scheduled backup failed: ${what}` : `Scheduled backup did not run: ${what}`,
      detail: schedule.lastReason, view: "backups", appId: subject ?? undefined, action: null });
  }
  const behind = behindBackupSchedules(schedules.map((schedule) => ({ ...schedule, parameters: schedule.parameters ?? undefined })));
  if (behind.length > 0) {
    needs.push({ id: "schedules-behind", kind: "backup", severity: "warning", title: "Scheduled backups have stopped running",
      detail: sentenceList(behind.map((schedule) => schedule.title ?? schedule.operationId)), view: "backups", action: null });
  }
  // Repair says the same with Back up now and Back up nightly (M35); when its scan answered, that is the one shown.
  if (facts.protection && !repairFindings.some((finding) => finding.id === "backups-due")) {
    const warning = protectionWarning(judgeProtection(facts.protection, schedules.map((schedule) => ({ ...schedule, parameters: schedule.parameters ?? undefined })), { now }));
    if (warning) needs.push({ id: "unprotected", kind: "backup", severity: "warning", title: warning, detail: "Back each one up from its card, or schedule it", view: "backups", action: null });
  }
  if (facts.offBox) {
    const warning = offBoxWarning(facts.offBox.verdict);
    const sync = mirrorOperations(facts.offBox.inputs)[0];
    if (warning) {
      needs.push({ id: "off-box", kind: "backup", severity: "warning", title: warning,
        detail: facts.offBox.verdict.where.length ? `Set up: ${sentenceList(facts.offBox.verdict.where)}` : "Add a drive, another machine or cloud storage on Backups", view: "backups",
        action: sync && facts.offBox.verdict.state !== "none" ? act(sync, "Copy now", "Copy the backups off this server", {}, "Copies the database backups, app backups and machine snapshots to the destination and checks each file. Nothing already there is deleted.") : null });
    }
  }
  if (facts.database) {
    const at = facts.database.lastBackupAt ? Date.parse(facts.database.lastBackupAt) : Number.NaN;
    const days = Number.isFinite(at) ? Math.floor((now - at) / 86_400_000) : null;
    if (days === null || days > 7) {
      needs.push({ id: "database", kind: "backup", severity: "warning", title: days === null ? "BoxPilot's own database has no backup yet" : `BoxPilot's database was last backed up ${countOf(days, "day")} ago`,
        detail: "It holds your schedules, jobs, people and settings", view: "backups",
        action: act("controller.backup.create", "Back up now", "Back up the BoxPilot database", {}, "Snapshots the live database with VACUUM INTO (no downtime) and restore-drills the copy before recording it.") });
    }
  }

  // ── The latest job that failed on its own (a backup's failure is said above), unless it has been
  //    dealt with since: dismissed (M36's mark on the job, which Dismiss here sets too), run again, or
  //    tried again (M36), or shown by Repair on the finding it was fixing, or that finding gone since
  //    (M35). A week on, Activity keeps it. It can be tried again, or dismissed. ──
  const repairSettled = new Set([...(facts.repairs?.jobs?.attached ?? []), ...(facts.repairs?.jobs?.resolved ?? [])]);
  const failures = jobs.filter((job) => job.state === "failed" && job.type !== "op:app.backup" && !failureSettled(job, jobs) && !repairSettled.has(job.id)
    && !(now - Date.parse(job.createdAt ?? "") > failureShownForMs));
  const failedJob = failures[0];
  if (failedJob) {
    const more = failures.length - 1;
    const operationId = failedJob.type.replace(/^op:/, "");
    const parameters = failedJob.parameters ?? {};
    // A run that ran out of time is offered the more time it can have, as Activity offers it.
    const moreTime = jobTimeout(failedJob)?.moreTimeMs ? failedJob.id : null;
    // Run again only when that can work: a failure that names another fix (install a tool first, free
    // space, a port someone else holds) opens where that fix is instead. Pressing Try again on those
    // repeated the same refusal; the owner did it three times on "Reconnect a drive".
    // One that may still be running on the server is not run again beside itself (sweep 4): the row
    // opens it in Activity, where its log says how far it has got, and Dismiss lets it go.
    const advice = moreTime ? { retry: true } : mayStillBeRunning(failedJob) ? { retry: false } : adviseRetry(failedJob.error);
    const retry = advice.retry && failedJob.type.startsWith("op:") && !JSON.stringify(parameters).includes("[secret]")
      ? act(operationId, moreTime ? "Try again with more time" : "Try again", failedJob.title, parameters, `Runs ${failedJob.title} again with the same settings${moreTime ? " and a larger time budget" : ""}. The last run failed: ${failedJob.error ?? "no error was recorded"}`)
      : null;
    const again = retry && moreTime ? { ...retry, moreTimeFor: moreTime } : retry;
    const mayAct = role === "owner" || role === "operator";
    const elsewhere = !advice.retry && advice.next && mayAct ? openAction(advice.next) : null;
    const dismiss: NeedAction | null = mayAct ? { kind: "dismiss", operationId: "", label: "Dismiss", title: `Dismiss: ${failedJob.title}`, parameters: {}, preview: "", risk: "low" } : null;
    const actions = [again ?? elsewhere, dismiss].filter((entry): entry is NeedAction => Boolean(entry));
    needs.push({ id: `job:${failedJob.id}`, kind: "job", severity: "warning", title: `${jobTimeout(failedJob) ? "Ran out of time" : "Failed"}: ${failedJob.title}`, jobId: failedJob.id,
      detail: [failedJob.error ? failureLine("", failedJob.error, 180) : null, more > 0 ? `${countOf(more, "more failed job")} in Activity` : null].filter(Boolean).join(" · ") || null,
      view: "repairs", action: again ?? elsewhere, ...(actions.length ? { actions } : {}) });
  }

  // ── Setting up: a rebuild found, a fresh box, the essentials not yet done. ──
  if (facts.rebuild) {
    needs.push({ id: "rebuild", kind: "setup", severity: "warning", title: "Rebuilding this server?",
      detail: `Found ${facts.rebuild.count === 1 ? "a machine snapshot" : `${facts.rebuild.count} machine snapshots`} on ${facts.rebuild.source}. Restoring one reinstalls your apps and their data`, view: "backups", action: null });
  }
  if (facts.setup?.firstRun) {
    needs.push({ id: "setup", kind: "setup", severity: "neutral", title: "Set up this server", detail: "Pick what it should be; BoxPilot installs the rest in order", view: "setup", action: null });
  }
  // Two essentials are already said above when their facts were read.
  const covered = new Set([...(facts.unattended ? ["updates"] : []), ...(facts.offBox ? ["backups"] : [])]);
  for (const item of facts.checklist?.items ?? []) {
    if (item.done || item.optional || item.known === false || covered.has(item.id)) continue;
    needs.push({ id: `checklist:${item.id}`, kind: "setup", severity: "neutral", title: item.title, detail: item.detail || null, view: item.view, action: null });
  }

  return sortNeeds(needs);
}

/** The buttons a need shows, `action` first. */
export const actionsOf = (need: Need): NeedAction[] => need.actions ?? (need.action ? [need.action] : []);

/**
 * The first button that runs something, and so has a tier. One that only opens another page, or sets
 * a failure aside, runs nothing: a row with only those is looked at, not approved.
 */
export const runs = (need: Need): NeedAction | null => actionsOf(need).find((action) => action.kind !== "open" && action.kind !== "dismiss") ?? null;

/** Ops' action inbox: what can be run from here, by tier; and the rest, which is only looked at. */
export function groupByTier(needs: Need[]): { high: Need[]; medium: Need[]; low: Need[]; look: Need[] } {
  return {
    high: needs.filter((need) => runs(need)?.risk === "high"),
    medium: needs.filter((need) => runs(need)?.risk === "medium"),
    low: needs.filter((need) => runs(need)?.risk === "low"),
    look: needs.filter((need) => !runs(need)),
  };
}

export const severityStatus: Record<NeedSeverity, Status> = { danger: "danger", warning: "warning", neutral: "neutral" };

/** A tile's health: the one status and the few words under its name. */
export function appHealth(app: AppFact, protection: AppProtection | undefined, now: number): { status: Status; label: string; detail: string } {
  if (app.vpnLeaked) return { status: "danger", label: "Left its VPN", detail: "Left its VPN" };
  if (!app.running && !app.paused) {
    if (app.status === "absent") return { status: "warning", label: "No container", detail: "No container" };
    if (app.stoppedOnPurpose && app.status !== "restarting") return { status: "neutral", label: "Stopped", detail: "Stopped" };
    return { status: "danger", label: "Not running", detail: app.status === "restarting" ? "Restarting" : "Not running" };
  }
  if (app.paused) return { status: "neutral", label: "Paused", detail: "Paused" };
  if (app.troubledSidecar) return { status: "warning", label: `${app.troubledSidecar.id} ${app.troubledSidecar.status === "restarting" ? "restarting" : "down"}`, detail: `${app.troubledSidecar.id} ${app.troubledSidecar.status === "restarting" ? "restarting" : "down"}` };
  if (app.health === "unhealthy") return { status: "warning", label: "Unhealthy", detail: "Unhealthy" };
  if (app.folderProblems > 0) return { status: "warning", label: "Cannot save data", detail: "Cannot save data" };
  if (protection?.protectable) {
    const newest = protection.newestAt ? Date.parse(protection.newestAt) : Number.NaN;
    if (protection.backups === 0 || !Number.isFinite(newest)) return { status: "warning", label: "Never backed up", detail: "Never backed up" };
    const days = Math.floor((now - newest) / 86_400_000);
    if (days > 14) return { status: "warning", label: `Last backup ${days} days ago`, detail: `Backup ${days}d old` };
  }
  if (app.updateAvailable) return { status: "good", label: "Healthy, update ready", detail: "Update ready" };
  return { status: "good", label: app.health === "healthy" ? "Healthy" : "Running", detail: reachOf(app) };
}

/** Who can open it, in the words the catalog uses. */
export function reachOf(app: Pick<AppFact, "exposure" | "served" | "port">): string {
  if (app.port === null) return "No web page";
  if (app.served) return "On your tailnet";
  if (app.exposure === "loopback") return "This server only";
  return "On your network";
}

export interface Verdict { status: Status; label: string; sentence: string }

/**
 * The one line that answers "is everything OK?". It never says healthy about something it could
 * not read: sources that failed make the answer "not fully checked", naming them (M28.5).
 */
export function verdictFor(needs: Need[], { hostname, checking, unread }: { hostname: string; checking: boolean; unread: string[] }): Verdict {
  const danger = needs.filter((need) => need.severity === "danger").length;
  const warning = needs.filter((need) => need.severity === "warning").length;
  const neutral = needs.filter((need) => need.severity === "neutral").length;
  // The rest of "What needs you", counted in the same sentence, so its number adds up to the
  // list's: two to look at and two more that can wait is the list of four below it.
  const canWait = neutral ? ` ${neutral === 1 ? "One more thing" : `${neutral} more`} can wait.` : "";
  if (danger > 0) {
    return { status: "danger", label: countOf(danger, "problem"), sentence: `${hostname} needs you: ${countOf(danger, "problem")}${warning ? ` and ${countOf(warning, "thing")} to look at` : ""}.${canWait}` };
  }
  if (warning > 0) return { status: "warning", label: `${warning} to look at`, sentence: `${hostname} is running. ${warning === 1 ? "One thing needs" : `${warning} things need`} a look.${canWait}` };
  if (checking) return { status: "unknown", label: "Checking", sentence: `Checking ${hostname}…` };
  if (unread.length > 0) return { status: "unknown", label: "Not fully checked", sentence: `Nothing wrong found, but BoxPilot could not read ${sentenceList(unread)}.` };
  return { status: "good", label: "Healthy", sentence: `${hostname} is healthy.${neutral ? ` ${neutral === 1 ? "One small thing" : `${neutral} small things`} can wait.` : " Nothing needs you."}` };
}

/** The label for "What needs you": the headline's count when something needs a look, so the two agree. */
export function needsLabel(needs: Need[], verdict: Verdict): string {
  const urgent = needs.filter((need) => need.severity !== "neutral").length;
  return urgent > 0 ? verdict.label : `${needs.length} can wait`;
}

/** The sources whose answer the verdict rests on, with the words used when one could not be read. */
export const verdictSources: Array<[keyof Facts, string]> = [
  ["catalog", "the apps"],
  ["watch", "the health alerts"],
  ["repairs", "Repair's problem scan"],
  ["updates", "the updates"],
  ["services", "the system services"],
  ["protection", "the app backups"],
];
