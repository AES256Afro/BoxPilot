/**
 * The server's facts at question time (M34.1), read as the person asking (M29.4, ADR-003):
 *
 * - Jobs: the owner's context holds every account's; anyone else's holds only their own, exactly
 *   what GET /jobs shows them. A job's parameters are masked by its operation's `secretPaths`
 *   (M29.1), and a job whose operation is not registered carries none at all.
 * - Health alerts and news nobody heard: every role sees what is live, but the words and key of an
 *   entry about another account's work are cut back to its kind, as on the Settings page.
 * - Operator reads (ADR-003): an app's container log is read only for an operator or the owner; a
 *   viewer is told it was left out.
 * - Everything else here is what every role already reads on the Overview, Apps, Storage and
 *   Backups pages, less the fields that name who did something.
 *
 * Nothing here has been through the final redaction pass yet; the prompt builder does that last.
 */
import { healthConditions, isNotice, noticeKinds } from "../health-alerts.mjs";
import { maskSecrets, secretPaths } from "../ops/registry.mjs";
import { flowRunnerFrom, readsThroughHelper, seesEveryAccount, watchEntryFor } from "../routes/access.mjs";

/** The caller as the access rules read it, so the assistant asks the same questions the routes do. */
export const asRequest = (caller) => ({ boxpilotSession: { owner: { id: caller?.id ?? null, role: caller?.role ?? "viewer" } } });

const clip = (text, max) => {
  const value = String(text ?? "");
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
};
const lastLines = (text, count, maxChars) => {
  const lines = String(text ?? "").split("\n").map((line) => line.trimEnd()).filter((line) => line.trim());
  const tail = lines.slice(-count).join("\n");
  return tail.length > maxChars ? tail.slice(tail.length - maxChars) : tail;
};
const gigabytes = (bytes) => (Number.isFinite(bytes) ? `${(bytes / 1e9).toFixed(bytes >= 100e9 ? 0 : 1)} GB` : "unknown");
const operationOf = (job) => (typeof job?.type === "string" && job.type.startsWith("op:") ? job.type.slice(3) : null);

/** A job's parameters as they may be shown: every declared secret masked, nothing for an unknown operation. */
export async function maskedParameters(job, { registry, secretEnvNamesFor = null }) {
  const operation = registry.get(operationOf(job) ?? "");
  const parameters = job?.parameters;
  if (!operation || !parameters || typeof parameters !== "object" || Array.isArray(parameters)) return null;
  return maskSecrets(parameters, await secretPaths(operation, parameters, { secretEnvNamesFor }));
}

export async function jobSources(job, { registry, secretEnvNamesFor, state, logLines, sourceChars, focus }) {
  const operationId = operationOf(job);
  const parameters = await maskedParameters(job, { registry, secretEnvNamesFor });
  const lines = [
    `Job ${job.id}: ${job.title ?? "untitled"}${operationId ? ` (operation ${operationId})` : ""}, ${job.state}, last changed ${job.updatedAt ?? job.createdAt ?? "at an unknown time"}.`,
    job.error ? `Error: ${clip(job.error, 600)}` : null,
    job.timeout ? "It ran out of time." : null,
    parameters && Object.keys(parameters).length ? `Parameters: ${clip(JSON.stringify(parameters), 400)}` : null,
  ].filter(Boolean);
  const sources = [{ key: `job:${job.id}`, kind: "job", title: `Job ${job.title ?? job.id} (${job.state})`, ref: { jobId: job.id }, text: clip(lines.join("\n"), sourceChars), focus }];
  const output = state.getJobOutput?.(job.id) ?? null;
  const tail = output ? lastLines(output, logLines, sourceChars) : "";
  if (tail) sources.push({ key: `log:${job.id}`, kind: "log", title: `Last lines of the log of job ${job.title ?? job.id}`, ref: { jobId: job.id }, text: tail, focus });
  return sources;
}

export function alertSources({ caller, state, focusKey, limit }) {
  const request = asRequest(caller);
  const ledger = state.getSetting?.("healthAlertsState", {}) ?? {};
  const scheduleOwner = (id) => state.getSchedule?.(id)?.createdBy ?? null;
  const flowRunner = flowRunnerFrom(state);
  const sources = [];
  for (const [key, entry] of Object.entries(ledger)) {
    if (!entry) continue;
    const family = key.split(":")[0];
    const notice = isNotice(key);
    const label = notice ? noticeKinds[family] : healthConditions[family] ?? family;
    const visible = watchEntryFor(request, key, entry, label, scheduleOwner, flowRunner);
    const heard = !notice && entry.notified !== false;
    const focus = Boolean(focusKey) && (focusKey === visible.key || focusKey === family);
    sources.push({
      key: `alert:${visible.key}:${sources.length}`,
      kind: "alert",
      title: `${notice ? "Not announced" : "Health alert"}: ${visible.title}`,
      ref: { alertKey: visible.key },
      text: `${visible.title}. Kind: ${label}.${entry.since ? ` Since ${entry.since}.` : ""} ${notice ? "News that reached no one: no notification target took it." : heard ? "Live, and announced." : "Live, and not announced to anyone yet."}`,
      focus,
    });
  }
  // The one asked about first, then live conditions before news, most recent first within each.
  sources.sort((a, b) => Number(b.focus) - Number(a.focus) || Number(a.title.startsWith("Not")) - Number(b.title.startsWith("Not")));
  return sources.slice(0, limit);
}

export function appSummary(applications, { sourceChars }) {
  const installed = applications.filter((entry) => entry?.installed);
  if (!installed.length) return { key: "fact:apps", kind: "fact", title: "Installed apps", ref: { fact: "apps" }, text: "No catalog apps are installed." };
  const describe = (entry) => {
    const container = entry.container ?? {};
    const state = container.running ? "running" : container.status ?? (container.exists === false ? "no container" : "stopped");
    const parts = [state];
    if (container.health && container.health !== "none") parts.push(`health ${container.health}`);
    if (Number(container.restarts) > 0) parts.push(`${container.restarts} restarts`);
    const helpers = (entry.sidecars ?? []).filter((sidecar) => !sidecar.running);
    if (helpers.length) parts.push(`helper containers not running: ${helpers.map((sidecar) => sidecar.id).join(", ")}`);
    if (entry.updateAvailable) parts.push("update available");
    if ((entry.folderProblems ?? []).length) parts.push(`${entry.folderProblems.length} data folder(s) it cannot write to`);
    const troubled = !container.running || ["unhealthy", "starting"].includes(container.health) || Number(container.restarts) > 0 || helpers.length > 0;
    return { line: `${entry.id}: ${parts.join(", ")}`, troubled };
  };
  const lines = installed.map(describe).sort((a, b) => Number(b.troubled) - Number(a.troubled)).map((entry) => entry.line);
  return { key: "fact:apps", kind: "fact", title: "Installed apps and their containers", ref: { fact: "apps" }, text: clip(`${installed.length} catalog apps installed.\n${lines.slice(0, 40).join("\n")}`, sourceChars) };
}

function appDetail(entry, manifest) {
  const container = entry?.container ?? {};
  const ports = (entry?.urls ?? []).map((url) => `${url.label ?? url.id} on port ${url.host}`);
  return [
    `${manifest?.name ?? entry?.id ?? "This app"} (${entry?.id}) is ${entry?.installed ? "installed" : "not installed"}.`,
    entry?.installed ? `Container: ${container.running ? "running" : container.status ?? "stopped"}${container.health && container.health !== "none" ? `, health ${container.health}` : ""}, ${Number(container.restarts) || 0} restarts${container.startedAt ? `, started ${container.startedAt}` : ""}.` : null,
    ports.length ? `Web ports: ${ports.join(", ")}.` : null,
    entry?.updateAvailable ? `An update is available (installed image ${entry.installedImage ?? "unknown"}).` : null,
    ...(entry?.folderProblems ?? []).slice(0, 5).map((problem) => `Cannot write to ${problem.path}: ${problem.reason}`),
  ].filter(Boolean).join("\n");
}

export function storageSummary(snapshot, { sourceChars }) {
  if (!snapshot?.storage) return null;
  const { storage } = snapshot;
  const lines = [];
  if (storage.root) lines.push(`Root disk: ${storage.root.usedPercent}% used, ${gigabytes(storage.root.freeBytes)} free of ${gigabytes(storage.root.totalBytes)}.`);
  const mounts = storage.filesystems?.available ? storage.filesystems.mounts ?? [] : [];
  const worth = mounts.filter((mount) => mount.target !== "/" && (mount.capacityState !== "normal" || mount.readOnly)).concat(mounts.filter((mount) => mount.target !== "/" && mount.capacityState === "normal" && !mount.readOnly)).slice(0, 8);
  for (const mount of worth) lines.push(`${mount.target}: ${mount.usedPercent ?? "?"}% used${mount.capacityState && mount.capacityState !== "normal" ? ` (${mount.capacityState})` : ""}${mount.readOnly ? ", read-only" : ""}.`);
  if (!storage.filesystems?.available) lines.push("Mounted filesystems: not scanned recently, so unknown.");
  const smart = storage.smart;
  if (smart) {
    const summary = smart.summary ?? {};
    lines.push(`Drive health (SMART): ${smart.status}${smart.available ? ` - ${summary.healthy ?? 0} healthy, ${summary.warning ?? 0} warning, ${summary.critical ?? 0} critical, ${summary.unavailable ?? 0} unreadable` : ""}${smart.generatedAt ? `, checked ${smart.generatedAt}` : ""}.`);
    for (const disk of (smart.disks ?? []).filter((item) => item.health !== "healthy").slice(0, 6)) lines.push(`${disk.device}: ${disk.health}${disk.reason ? ` (${disk.reason})` : ""}${Number.isFinite(disk.mediaErrors) && disk.mediaErrors ? `, ${disk.mediaErrors} media errors` : ""}${Number.isFinite(disk.percentageUsed) ? `, ${disk.percentageUsed}% of rated wear used` : ""}.`);
  }
  if (!lines.length) return null;
  return { key: "fact:storage", kind: "fact", title: "Storage and drive health", ref: { fact: "storage" }, text: clip(lines.join("\n"), sourceChars) };
}

export function backupSummary(state, { sourceChars }) {
  const lines = [];
  const backups = state.listBackups?.(5) ?? [];
  if (backups.length) {
    lines.push("Most recent backups:");
    for (const backup of backups) lines.push(`${backup.applicationId}: ${backup.createdAt}, ${gigabytes(backup.sizeBytes)}, restore check ${backup.restoreDrill?.passed === true ? "passed" : backup.restoreDrill?.passed === false ? "failed" : "not run"}.`);
  } else {
    lines.push("No backups are recorded.");
  }
  const offBox = state.getSetting?.("backupDestinationLastSync", null);
  lines.push(offBox?.completedAt ? `Last copy to the off-box destination: ${offBox.completedAt}, ${offBox.filesTransferred ?? 0} files.` : state.getSetting?.("backupDestination", null) ? "An off-box destination is saved but has no recorded copy." : "No off-box destination is saved.");
  const cloud = state.getSetting?.("cloudDestinationLastSync", null);
  if (cloud?.completedAt) lines.push(`Last cloud copy: ${cloud.completedAt}, ${cloud.filesTransferred ?? 0} files${cloud.errors ? `, ${cloud.errors} errors` : ""}.`);
  const verdicts = state.getSetting?.("appBackupVerifications", {}) ?? {};
  for (const [appId, verdict] of Object.entries(verdicts).slice(0, 12)) {
    lines.push(`Restore rehearsal for ${appId}: ${verdict?.verified ? "restored cleanly" : "did not restore"}${verdict?.checkedAt ? ` on ${verdict.checkedAt}` : ""}${!verdict?.verified && verdict?.reason ? ` (${clip(verdict.reason, 120)})` : ""}.`);
  }
  return { key: "fact:backups", kind: "fact", title: "Backups", ref: { fact: "backups" }, text: clip(lines.join("\n"), sourceChars) };
}

/**
 * Every live fact for this caller, focused ones first. `focusJob` has already been checked as one
 * the caller may read. `readApps()` answers app.inspect (shared with the endpoint lookup).
 */
export async function gatherFacts({
  caller, context = {}, focusJob = null, state, registry, helper = null, inventory = null, catalog = null,
  secretEnvNamesFor = null, readApps = null, limits = {},
}) {
  const { failedJobs = 3, logLines = 20, focusLogLines = 40, alerts = 15, sourceChars = 1500 } = limits;
  const request = asRequest(caller);
  const notes = [];
  const sources = [];

  if (focusJob) sources.push(...await jobSources(focusJob, { registry, secretEnvNamesFor, state, logLines: focusLogLines, sourceChars, focus: true }));
  const scope = seesEveryAccount(request) ? {} : { createdBy: caller.id };
  const failed = (state.listJobs?.(50, scope) ?? []).filter((job) => job.state === "failed" && job.id !== focusJob?.id).slice(0, failedJobs);
  for (const job of failed) sources.push(...await jobSources(job, { registry, secretEnvNamesFor, state, logLines, sourceChars, focus: false }));

  sources.push(...alertSources({ caller, state, focusKey: typeof context.alertKey === "string" ? context.alertKey : null, limit: alerts }));

  const [apps, snapshot] = await Promise.all([
    readApps ? readApps().catch(() => null) : null,
    inventory ? inventory.inspect().catch(() => null) : null,
  ]);
  const applications = Array.isArray(apps?.applications) ? apps.applications : null;
  if (applications) sources.push(appSummary(applications, { sourceChars }));
  else notes.push("The state of installed apps could not be read.");

  if (context.appId) {
    const entry = applications?.find((row) => row?.id === context.appId) ?? null;
    const manifest = catalog ? await catalog.get(context.appId).catch(() => null) : null;
    if (entry || manifest) sources.push({ key: `fact:app:${context.appId}`, kind: "fact", title: `The app ${manifest?.name ?? context.appId}`, ref: { appId: context.appId }, text: clip(appDetail(entry ?? { id: context.appId, installed: false }, manifest), sourceChars), focus: true });
    if (entry?.installed && helper) {
      // app.logs is an operator read (ADR-003): it is not run for a viewer on the assistant's behalf.
      if (readsThroughHelper(request)) {
        const logs = await helper.request("app.logs", { id: context.appId, lines: focusLogLines }, { timeoutMs: 30_000 }).catch(() => null);
        const text = Array.isArray(logs?.lines) ? lastLines(logs.lines.join("\n"), focusLogLines, sourceChars) : "";
        if (text) sources.push({ key: `log:app:${context.appId}`, kind: "log", title: `Last lines of the ${manifest?.name ?? context.appId} container log`, ref: { appId: context.appId }, text, focus: true });
        else notes.push(`The ${context.appId} container log could not be read.`);
      } else {
        notes.push("Application logs need an operator, so they were not read for you.");
      }
    }
  }

  const storage = storageSummary(snapshot, { sourceChars });
  if (storage) sources.push(storage);
  else notes.push("Storage and drive health could not be read.");
  sources.push(backupSummary(state, { sourceChars }));
  return { sources, notes };
}
