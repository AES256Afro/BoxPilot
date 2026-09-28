import type { AppProtection } from "../backupProtection";
import { behindBackupSchedules, judgeProtection, protectionWarning } from "../backupProtection";
import { countOf, sentenceList, type ViewName } from "../data";
import { jobTimeout } from "../JobTimeout";
import { ranAgain } from "../jobStatus";
import { mirrorOperations, offBoxWarning } from "../offBox";
import type { Job } from "../operations";
import { mayStart, riskOf } from "../ui/operationRisk";
import type { RiskTier, Status } from "../ui/types";
import type { AppFact, FactValues, Facts } from "./facts";
import { relativeTime } from "./format";

/*
 * "What needs you" (M33.2): everything BoxPilot knows that the owner should look at or act on,
 * as one ordered list that Home shows as it is and Ops groups by risk tier (M33.3). Pure: the
 * facts and the clock come in, the list comes out. It carries over every attention item the
 * Classic overview raised, so Home says at least what that page said.
 */

export type NeedKind = "alert" | "repair" | "approval" | "updates" | "backup" | "job" | "setup";
export type NeedSeverity = "danger" | "warning" | "neutral";

/** A fix that can be started from the list itself, through the ordinary approval dialog. */
export interface NeedAction {
  operationId: string;
  /** The button's word: "Install", "Start". */
  label: string;
  /** The approval dialog's title: "Install all updates". */
  title: string;
  parameters: Record<string, unknown>;
  preview: string;
  risk: RiskTier;
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
  /** The tier of something already staged (a job waiting for approval), shown beside it. */
  risk?: RiskTier;
}

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

const backupOperation = /^(app\.backup|backup\.|controller\.backup|host\.snapshot|vm\.backup|vm\.export)/;

/** Docker's state for a container that is not serving, as a sentence. */
function containerWords(status: string): string {
  if (status === "restarting") return "Its container keeps restarting";
  if (status === "absent") return "Its container is missing";
  return "Its container is stopped";
}
const tierOf = (value: string): RiskTier | undefined => (value === "low" || value === "medium" || value === "high" ? value : undefined);

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
  // Listed as installed, with no container at all: most often removed outside BoxPilot. One item for
  // all of them rather than a problem each; the App catalog reinstalls or uninstalls each one.
  if (missing.length > 0) {
    const one = missing.length === 1;
    const named = missing.length <= 2 ? missing.map((app) => app.name).join(" and ") : `${missing.slice(0, 2).map((app) => app.name).join(", ")} and ${missing.length - 2} more`;
    needs.push({ id: "apps-missing", kind: "alert", severity: "warning", view: "catalog", ...(one ? { appId: missing[0].id } : {}),
      title: `${named} ${one ? "has" : "have"} no container`,
      detail: `BoxPilot lists ${one ? "it" : "them"} as installed, but Docker has no container for ${one ? "it" : "them"}. Reinstall or uninstall ${one ? "it" : "each"} from the App catalog.`, action: null });
  }

  if ((facts.services?.failed ?? 0) > 0) {
    const failed = facts.services!.failed;
    needs.push({ id: "services", kind: "alert", severity: "danger", title: `${countOf(failed, "system service")} failed`, detail: "Services lists them with their journal", view: "services", action: null });
  }

  // ── Repair's findings, each with its fix when it has one. ──
  for (const finding of facts.repairs?.findings ?? []) {
    const fix = finding.fix;
    needs.push({
      id: `repair:${finding.id}`, kind: "repair",
      severity: finding.severity === "critical" ? "danger" : finding.severity === "warning" ? "warning" : "neutral",
      title: finding.title, detail: finding.evidence?.[0] ?? null, view: "repairs",
      action: fix ? act(fix.operationId, fix.label, fix.label, fix.parameters ?? {}, fix.preview) : null,
    });
  }

  // ── Jobs someone staged and nobody has approved yet. Repair holds the approval. ──
  const jobs = facts.jobs ?? [];
  for (const job of jobs.filter((entry) => entry.state === "awaiting_approval")) {
    needs.push({ id: `approval:${job.id}`, kind: "approval", severity: "warning", title: `Waiting for approval: ${job.title}`,
      detail: job.createdAt ? `Staged ${relativeTime(job.createdAt, now)}` : null, view: "repairs", action: null, risk: tierOf(job.risk) });
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
  for (const [id, job] of newestBackup) {
    if (job.state !== "failed" || ranAgain(job)) continue;
    failedBackupApps.add(id);
    needs.push({ id: `backup-failed:${id}`, kind: "backup", severity: "danger", title: `The last backup of ${appName(id)} failed`, detail: job.error ?? null, view: "backups", appId: id,
      action: act("app.backup", "Back up again", `Back up ${appName(id)}`, { id }, `Stops ${appName(id)} briefly, archives its data and configuration, restarts it, and keeps the newest 5 copies.`) });
  }
  const schedules = facts.schedules ?? [];
  for (const schedule of schedules) {
    if (!backupOperation.test(schedule.operationId) || !schedule.enabled) continue;
    if (schedule.lastOutcome !== "failed" && schedule.lastOutcome !== "did-not-run") continue;
    const subject = typeof schedule.parameters?.subject === "string" ? schedule.parameters.subject : null;
    if (subject && failedBackupApps.has(subject)) continue;
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
  if (facts.protection) {
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

  // ── The latest job that failed on its own (a backup's failure is said above). ──
  const failedJob = jobs.find((job) => job.state === "failed" && !ranAgain(job) && job.type !== "op:app.backup");
  if (failedJob) {
    needs.push({ id: `job:${failedJob.id}`, kind: "job", severity: "warning", title: `${jobTimeout(failedJob) ? "Ran out of time" : "Failed"}: ${failedJob.title}`,
      detail: failedJob.error ?? null, view: "repairs", action: null });
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

/** Ops' action inbox: what can be run from here, by tier; and the rest, which is only looked at. */
export function groupByTier(needs: Need[]): { high: Need[]; medium: Need[]; low: Need[]; look: Need[] } {
  return {
    high: needs.filter((need) => need.action?.risk === "high"),
    medium: needs.filter((need) => need.action?.risk === "medium"),
    low: needs.filter((need) => need.action?.risk === "low"),
    look: needs.filter((need) => !need.action),
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
