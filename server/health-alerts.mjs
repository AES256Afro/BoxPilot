import { shared } from "./cache.mjs";
/**
 * Health alerts: watches the sanitized inventory and pushes one notification per condition
 * when it turns bad (and one when it clears), through the same target failed jobs use.
 * Conditions come only from evidence the inventory already collects: disk space, SMART,
 * UPS state, failed services, reboot-required, unhealthy containers. State lives in a
 * setting so a restart does not re-send everything. A scheduled backup that quietly stopped is
 * treated the same way (M20.1), read from the schedule table rather than the inventory snapshot.
 * The same setting is the ledger of what could not be told (M27.2): BoxPilot's own failures, and
 * one-off news (a release, a new sign-in, the weekly report) kept only until it is delivered.
 */
import { evaluateScheduleFreshness } from "./schedule-freshness.mjs";
import { evaluateDiskForecast } from "./disk-forecast.mjs";
import { evaluateSmartTrends } from "./smart-trends.mjs";

export const healthConditions = Object.freeze({
  "storage.root.full": "Root disk nearly full",
  "storage.mount.full": "A mounted filesystem is nearly full",
  "storage.smart": "A disk reports SMART problems",
  "storage.mount.detached": "A drive was disconnected and its folder is now empty",
  "storage.mount.readonly": "A filesystem hit errors and has gone read-only",
  "power.ups": "UPS on battery or low",
  "system.services": "System services have failed",
  "system.reboot": "A reboot is required",
  "docker.unhealthy": "A container is unhealthy",
  "docker.restarting": "A container keeps restarting (crash-looping)",
  "schedule.overdue": "A scheduled task (such as a backup) has stopped running",
  "storage.forecast": "A filesystem is on track to fill soon",
  "smart.errors": "A disk's error count is climbing",
  "smart.wear": "An SSD is nearing its write-endurance limit",
  ...reportedConditions(),
});

/**
 * Failures of BoxPilot's own unattended work (M27.2). A scheduled task that failed, an automation
 * that stopped, a job whose result could not be saved: each was known to BoxPilot and, without a
 * notification target, told to no one. They are conditions like the ones above and live in the same
 * state, but nothing re-evaluates them every round: whoever sees the failure raises it, and whoever
 * sees the next success clears it.
 */
function reportedConditions() {
  return {
    "schedule.failed": "A scheduled task failed or did not run",
    "flow.failed": "An automation stopped or did not run",
    "record.failed": "A job ran but its result was not saved",
    // M30.1: one condition for the server, not one per job. The helper writes every job's log, so
    // when BoxPilot cannot open one it is usually every one (the umask of M27.4).
    "joblog.unreadable": "BoxPilot could not read a job's output",
  };
}
const reportedFamilies = new Set(Object.keys(reportedConditions()));
export const isReported = (key) => reportedFamilies.has(String(key).split(":")[0]);

/**
 * One-off news that used to be pushed straight to the target and forgotten when nothing took it: a
 * job a restart cut off that no schedule or automation owns, a new release, a sign-in from a new
 * address, the weekly report. They are not conditions - nothing turns them good again - so the
 * ledger holds one only while it has not been announced: a round that delivers it drops it. The
 * same key again is the same news (one entry, newest words), and at most `noticeLimit` are kept,
 * none longer than `noticeMaxAgeMs`, so a server with no target never grows a pile.
 */
export const noticeKinds = Object.freeze({
  "job.interrupted": "A job was cut off by a restart",
  "release.available": "A new BoxPilot release",
  "signin.new": "A sign-in from a new address",
  "report.weekly": "The weekly report",
  "drive.reconnected": "A drive was reconnected automatically",
});
export const isNotice = (key) => Object.hasOwn(noticeKinds, String(key).split(":")[0]);
export const noticeLimit = 20;
export const noticeMaxAgeMs = 30 * 24 * 60 * 60_000;

/** One notice per operation and subject: the same backup cut off twice is one entry, not two. */
export function jobNoticeKey(kind, job) {
  const operation = String(job?.type ?? "").replace(/^op:/, "") || "job";
  const subject = job?.parameters?.id ?? job?.parameters?.name ?? null;
  return `${kind}:${operation}${typeof subject === "string" && subject ? `:${subject.slice(0, 64)}` : ""}`;
}

/**
 * Jobs a BoxPilot restart cut off, told at startup. A scheduled run is its schedule's to announce
 * (`owned`, from scheduler.recover), and an automation's step is the automation's: flows.recover()
 * rewrites every flow still "running step" and raises its condition, so those steps are skipped
 * here too. What is left was started by hand, and nobody watched it end - the page that followed it
 * lost its connection with the restart - so it goes through the ledger and is kept if unheard.
 */
export function tellInterrupted({ alerts, store, interrupted = [], owned = new Set() }) {
  const flowSteps = new Set((store.listFlows?.() ?? []).filter((flow) => flow.lastResult?.startsWith("running step")).flatMap((flow) => flow.lastJobIds ?? []));
  const told = interrupted.filter((job) => !owned.has(job.id) && !flowSteps.has(job.id)).map((interruptedJob) => {
    const job = store.getJob?.(interruptedJob.id) ?? interruptedJob;
    const subject = job.parameters?.id ?? job.parameters?.name ?? null;
    return alerts.tell({
      key: jobNoticeKey("job.interrupted", job),
      title: `${job.title ?? "A job"}${typeof subject === "string" && subject ? ` (${subject.slice(0, 64)})` : ""} was interrupted`,
      message: "BoxPilot restarted while it was running, so it is marked failed. The operation may still have finished on its own; check what it changed before retrying.",
      priority: "high",
    }).catch(() => ({ notified: false }));
  });
  return Promise.all(told);
}

/** An error message as the end of a sentence in an alert: trimmed, with one full stop. */
export const asSentence = (text) => {
  const trimmed = String(text ?? "").trim();
  return !trimmed || /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
};

/** Derive the current set of bad conditions from an inventory snapshot. Pure. */
export function evaluateHealth(inventory) {
  const alerts = [];
  const root = inventory?.storage?.root;
  if (root && Number.isFinite(root.usedPercent) && root.usedPercent >= 90) {
    alerts.push({ key: "storage.root.full", priority: root.usedPercent >= 95 ? "high" : "default", title: `Root disk is ${root.usedPercent}% full`, message: "Free space on / is running out. Remove old app backups or snapshots on the Storage page, or use the rest of the disk." });
  }
  for (const mount of inventory?.storage?.filesystems?.mounts ?? []) {
    if (mount.target === "/" || !["warning", "critical"].includes(mount.capacityState)) continue;
    alerts.push({ key: `storage.mount.full:${mount.target}`, priority: mount.capacityState === "critical" ? "high" : "default", title: `${mount.target} is ${mount.usedPercent}% full`, message: `The filesystem mounted at ${mount.target} is nearly full.` });
  }
  // A mount whose device has gone. A drive that drops off the bus for a moment comes back under a
  // different kernel name and the old mount stays, pointing at nothing: findmnt still lists it, df
  // still prints the size it cached, and only a real read fails. Shares and bind mounts then serve
  // an empty folder with nothing anywhere reporting a fault, so this has to announce itself.
  const blockDevices = inventory?.storage?.blockDevices;
  if (blockDevices?.available && Array.isArray(blockDevices.devices) && blockDevices.devices.length > 0) {
    const present = new Set(blockDevices.devices.map((device) => device.name).filter((name) => name?.startsWith("/dev/")));
    // Only compare when there is something real to compare against. If the device names ever stop
    // being full paths, an empty set here would report every drive on the server as detached at once.
    for (const mount of present.size === 0 ? [] : inventory?.storage?.filesystems?.mounts ?? []) {
      if (!mount.source?.startsWith("/dev/") || present.has(mount.source)) continue;
      alerts.push({ key: `storage.mount.detached:${mount.target}`, priority: "high", title: `${mount.target} lost its drive`, message: `It is still mounted from ${mount.source}, which is no longer a device on this server — the drive was disconnected, and may have come back under a different name. Anything reading that folder now sees it empty, including network shares. Reconnect it from the Repair page.` });
    }
  }
  // A filesystem the kernel turned read-only after I/O errors. exFAT and ext4 mounted with
  // errors=remount-ro do this when the device stumbles - a drive dropping off USB for a moment is
  // the usual cause - and from then on every write from a share or a container fails while the
  // folder still appears in every listing. The owner learns of it as an I/O error on another
  // computer. Limited to mounts carrying errors=remount-ro, so a filesystem fstab deliberately
  // mounted read-only (which would not normally carry that policy) is not reported as a fault.
  for (const mount of inventory?.storage?.filesystems?.mounts ?? []) {
    if (!mount.readOnly || !mount.source?.startsWith("/dev/") || !(mount.optionNames ?? []).includes("errors=remount-ro")) continue;
    alerts.push({ key: `storage.mount.readonly:${mount.target}`, priority: "high", title: `${mount.target} has gone read-only`, message: `The filesystem on ${mount.source} hit errors and is refusing every write since. Saving to it from another computer fails with an I/O error. Open Repair to reconnect it; if it keeps happening, the cable, port or enclosure is the thing to change.` });
  }
  for (const disk of inventory?.storage?.smart?.disks ?? []) {
    if (["healthy", "unavailable"].includes(disk.health)) continue;
    alerts.push({ key: `storage.smart:${disk.device}`, priority: "high", title: `Disk ${disk.device} reports SMART problems`, message: `Health: ${disk.health}${disk.mediaErrors ? `, ${disk.mediaErrors} media errors` : ""}${disk.temperatureCelsius !== null && disk.temperatureCelsius !== undefined ? `, ${disk.temperatureCelsius} °C` : ""}. Back up what matters and plan a replacement.` });
  }
  const ups = inventory?.power?.ups;
  if (ups?.available && ["on-battery", "low-battery", "forced-shutdown"].includes(ups.state)) {
    alerts.push({ key: "power.ups", priority: ups.state === "on-battery" ? "default" : "high", title: ups.state === "on-battery" ? "Power is out: server on UPS battery" : "UPS battery is low", message: `${ups.batteryChargePercent !== null && ups.batteryChargePercent !== undefined ? `${ups.batteryChargePercent}% charge` : "Charge unknown"}${ups.estimatedRuntimeSeconds ? `, about ${Math.round(ups.estimatedRuntimeSeconds / 60)} min left` : ""}. ${ups.state === "on-battery" ? "The server shuts down cleanly if the battery runs low." : "A clean shutdown is imminent."}` });
  }
  const maintenance = inventory?.maintenance;
  if ((maintenance?.system?.failedServiceCount ?? 0) > 0) {
    alerts.push({ key: "system.services", priority: "default", title: `${maintenance.system.failedServiceCount} system service${maintenance.system.failedServiceCount === 1 ? "" : "s"} failed`, message: "Open Services in BoxPilot to see which units failed and restart them." });
  }
  if (maintenance?.reboot?.required) {
    alerts.push({ key: "system.reboot", priority: "default", title: "A reboot is required", message: "Updates were installed that need a restart. Reboot from the System page when convenient." });
  }
  for (const container of inventory?.docker?.containers ?? []) {
    // Crash-looping is worse than unhealthy and unambiguous: a running container is "running", so
    // "restarting"/"dead" means Docker keeps trying to start something that keeps dying. A stopped
    // container is "exited", not "restarting", so an intentional stop does not trip this.
    if (container.state === "restarting" || container.state === "dead") {
      alerts.push({ key: `docker.restarting:${container.name}`, priority: "default", title: `Container ${container.name} keeps restarting`, message: `It is crash-looping${container.status ? ` (${container.status})` : ""}. Open the app's Logs on the App catalog page to see why it will not stay up.` });
      continue; // one alert per container; a crash-looping one is not also reported as unhealthy
    }
    if (container.health === "unhealthy") {
      alerts.push({ key: `docker.unhealthy:${container.name}`, priority: "default", title: `Container ${container.name} is unhealthy`, message: "Its health check is failing. Open the app's Logs on the App catalog page." });
    }
  }
  return alerts;
}

/** Which condition families have live evidence in this snapshot; absent evidence must not read as "cleared". */
export function collectorAvailability(inventory) {
  const storage = inventory?.storage;
  const maintenance = inventory?.maintenance;
  return {
    "storage.root.full": Boolean(storage?.root && Number.isFinite(storage.root.usedPercent)),
    "storage.mount.full": storage?.filesystems?.available !== false && Array.isArray(storage?.filesystems?.mounts),
    "storage.mount.readonly": storage?.filesystems?.available !== false && Array.isArray(storage?.filesystems?.mounts),
    "storage.smart": storage?.smart?.available !== false && Array.isArray(storage?.smart?.disks) && storage.smart.disks.length > 0,
    // Needs both halves: without the device list every mount would look detached.
    "storage.mount.detached": storage?.filesystems?.available !== false && Array.isArray(storage?.filesystems?.mounts) && storage?.blockDevices?.available === true && (storage.blockDevices.devices?.length ?? 0) > 0,
    "power.ups": inventory?.power?.ups?.available === true,
    "system.services": maintenance?.available !== false && Number.isFinite(maintenance?.system?.failedServiceCount),
    "system.reboot": maintenance?.available !== false && typeof maintenance?.reboot?.required === "boolean",
    "docker.unhealthy": inventory?.docker?.available !== false && Array.isArray(inventory?.docker?.containers),
    "docker.restarting": inventory?.docker?.available !== false && Array.isArray(inventory?.docker?.containers),
  };
}

export function createHealthAlerts({ inventory, notifications, store, resolveScheduleTitle = (operationId) => operationId, intervalMs = 15 * 60 * 1000, initialDelayMs = 3 * 60 * 1000, now = () => new Date(), setInterval: schedule = globalThis.setInterval, setTimeout: delay = globalThis.setTimeout, clearInterval: unschedule = globalThis.clearInterval, clearTimeout: cancel = globalThis.clearTimeout } = {}) {
  const settingKey = "healthAlertsState";
  // The round below and raise()/clear() each read the state, may wait on a send, and write it back.
  // One at a time, or a round that started before a schedule failed would write over its entry.
  let queue = Promise.resolve();
  const exclusive = (work) => {
    const next = queue.then(work);
    queue = next.catch(() => {});
    return next;
  };
  const readState = () => ({ ...(store.getSetting(settingKey, {}) ?? {}) });
  const writeState = (value) => store.setSetting(settingKey, value, { updatedBy: null });
  // Whatever acts on what a round found (M26.5's drive reconnect). Told after the round has
  // announced and saved, and never waited for: a reconnect takes minutes, a round must not.
  const listeners = new Set();
  function afterRound(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  /** Send one announcement: true when the target took it, false when there is none or it failed. */
  async function announce(key, { title, message, priority = "default" }) {
    if (!notifications.getTarget()) return false;
    try {
      await notifications.send({ title: `BoxPilot: ${title}`, message, priority });
      store.recordAudit("health.alert.sent", { actorId: null, subjectId: key, details: { title, at: now().toISOString() } });
      return true;
    } catch (error) {
      store.recordAudit("health.alert.failed", { actorId: null, subjectId: key, details: { error: error.message } });
      return false;
    }
  }

  /** One pass: evaluate, send for new conditions and for cleared ones, persist the active set. */
  const check = shared(async () => {
    const snapshot = await inventory.inspect();
    // A stopped backup is a health condition too, but it comes from the schedule and flow tables,
    // not the host. Both an operation schedule (how BoxPilot's own nightly backups run) and a
    // scheduled flow can quietly fall behind.
    const schedules = typeof store.listSchedules === "function" ? store.listSchedules() : [];
    const flows = (typeof store.listFlows === "function" ? store.listFlows() : [])
      .map((flow) => ({ id: `flow:${flow.id}`, title: flow.name, operationId: flow.name, frequency: flow.frequency, enabled: flow.enabled, nextDueAt: flow.nextDueAt }));
    const scheduleAlerts = evaluateScheduleFreshness([...schedules, ...flows], { now: now(), titleFor: (s) => s.title ?? resolveScheduleTitle(s.operationId) });
    // A filesystem projected to fill soon, from the free-space history the sampler keeps (M23.1).
    const forecastAlerts = evaluateDiskForecast(store.getSetting?.("diskUsageHistory", {}) ?? {}, { now: now() });
    // A drive going bad shows in its SMART numbers before it fails outright (M23.3).
    const smartAlerts = evaluateSmartTrends(store.getSetting?.("smartHistory", {}) ?? {}, { now: now() });
    const active = [...evaluateHealth(snapshot), ...scheduleAlerts, ...forecastAlerts, ...smartAlerts];
    const round = await exclusive(async () => {
      const previous = readState();
      const nextState = {};
      const sent = [];
      const target = notifications.getTarget();
      for (const alert of active) {
        const seen = previous[alert.key];
        // Remember a condition only once it has actually been announced, or the owner who configures
        // notifications tomorrow would never hear about what broke today.
        // Entries written before this flag existed count as announced, so upgrading does not replay them.
        if (seen && seen.notified !== false) { nextState[alert.key] = seen; continue; }
        // A send that fails is kept as not announced, the same as having no target: the owner can
        // see it, and the next round tries again.
        const notified = await announce(alert.key, alert);
        nextState[alert.key] = { since: seen?.since ?? now().toISOString(), title: alert.title, notified };
        if (notified) sent.push(alert.key);
      }
      // The schedule table is always readable, so an overdue alert can clear the moment it catches up.
      const availability = { ...collectorAvailability(snapshot), "schedule.overdue": true, "storage.forecast": true, "smart.errors": true, "smart.wear": true };
      for (const [key, entry] of Object.entries(previous)) {
        if (nextState[key]) continue;
        // News nobody has heard yet: sent now if a target answers, then forgotten; kept otherwise,
        // until it is a month old and no longer news.
        if (isNotice(key)) {
          if (now().getTime() - Date.parse(entry?.since ?? "") > noticeMaxAgeMs) continue;
          const delivered = target ? await announce(key, { title: entry.title ?? key, message: entry.message ?? entry.title ?? key, priority: entry.priority ?? "default" }) : false;
          if (delivered) sent.push(key); else nextState[key] = entry;
          continue;
        }
        // Raised by whatever saw the failure, not by this round, and kept until that code clears it.
        // One not yet announced gets another try, so a target set today still hears about yesterday.
        if (isReported(key)) {
          const retry = entry?.notified === false && target
            ? await announce(key, { title: entry.title ?? key, message: entry.message ?? entry.title ?? key, priority: entry.priority ?? "high" })
            : false;
          nextState[key] = retry ? { since: entry.since ?? null, title: entry.title ?? key, notified: true } : entry;
          if (retry) sent.push(key);
          continue;
        }
        // Evidence that is temporarily missing (stale SMART file, systemctl timeout) carries the alert forward unchanged.
        if (availability[key.split(":")[0]] === false) { nextState[key] = entry; continue; }
        if (entry?.notified === false) continue; // never announced, so there is nothing to say it cleared
        if (!target) continue;
        try {
          await notifications.send({ title: `BoxPilot: resolved. ${entry.title ?? key}`, message: `This condition cleared at ${now().toLocaleString()}.`, priority: "default" });
          sent.push(`resolved:${key}`);
          store.recordAudit("health.alert.resolved", { actorId: null, subjectId: key, details: { since: entry.since, at: now().toISOString() } });
        } catch (error) {
          store.recordAudit("health.alert.failed", { actorId: null, subjectId: key, details: { error: error.message } });
          nextState[key] = entry; // keep it so the resolution is announced next time
        }
      }
      writeState(nextState);
      return { active: active.map((alert) => alert.key), sent, target: Boolean(target) };
    });
    // Which evidence this round actually had, so a listener never reads missing evidence as "fine".
    const seen = { active: round.active, availability: collectorAvailability(snapshot) };
    for (const listener of listeners) {
      try { Promise.resolve(listener(seen)).catch(() => {}); } catch { /* the round's own work stands */ }
    }
    return round;
  });

  /**
   * A reported condition turned bad: announce it once, or keep it as not announced. Raising it again
   * while it stands announced does nothing, so a schedule failing every hour is one push, not one an
   * hour. Not announced keeps the words, so the round that finds a target later can send them.
   */
  function raise({ key, title, message, priority = "high" }) {
    return exclusive(async () => {
      const state = readState();
      const seen = state[key];
      if (seen && seen.notified !== false) return { key, notified: true, sent: false };
      const since = seen?.since ?? now().toISOString();
      const text = String(message ?? title).slice(0, 500);
      const notified = await announce(key, { title, message: text, priority });
      state[key] = notified ? { since, title, notified } : { since, title, message: text, priority, notified };
      writeState(state);
      return { key, notified, sent: notified };
    });
  }

  /**
   * The same work succeeded again: say so once if the failure was announced, and drop it either way.
   * `quietly` is for a schedule or automation that was deleted rather than fixed.
   */
  function clear(key, { quietly = false } = {}) {
    return exclusive(async () => {
      const state = readState();
      const entry = state[key];
      if (!entry) return { key, cleared: false, sent: false };
      delete state[key];
      writeState(state);
      if (quietly || entry.notified === false || !notifications.getTarget()) return { key, cleared: true, sent: false };
      try {
        await notifications.send({ title: `BoxPilot: resolved. ${entry.title ?? key}`, message: `Its next run succeeded, at ${now().toLocaleString()}.`, priority: "default" });
        store.recordAudit("health.alert.resolved", { actorId: null, subjectId: key, details: { since: entry.since, at: now().toISOString() } });
        return { key, cleared: true, sent: true };
      } catch (error) {
        // Good news that did not arrive is not worth holding the condition open for: nothing
        // re-evaluates this one, so keeping it would show a fixed failure as live.
        store.recordAudit("health.alert.failed", { actorId: null, subjectId: key, details: { error: error.message } });
        return { key, cleared: true, sent: false };
      }
    });
  }

  /**
   * One-off news (a notice, above): pushed now, or kept as not announced for a round to send once a
   * target answers. Kept again under the same key, it keeps the day it was first kept and takes the
   * newer words; delivered, it leaves the ledger, including an older undelivered copy.
   */
  function tell({ key, title, message, priority = "default" }) {
    return exclusive(async () => {
      const text = String(message ?? title).slice(0, 1000);
      const notified = await announce(key, { title, message: text, priority });
      const state = readState();
      if (notified) {
        if (state[key]) { delete state[key]; writeState(state); }
        return { key, notified: true };
      }
      state[key] = { since: state[key]?.since ?? now().toISOString(), title, message: text, priority, notified: false };
      // Bounded: past the limit the oldest news goes first. Conditions are never touched here.
      const notices = Object.entries(state).filter(([name]) => isNotice(name)).sort(([, left], [, right]) => String(left?.since).localeCompare(String(right?.since)));
      for (const [name] of notices.slice(0, Math.max(0, notices.length - noticeLimit))) delete state[name];
      writeState(state);
      return { key, notified: false };
    });
  }

  function start() {
    const safeCheck = () => check().catch(() => {});
    const first = delay(safeCheck, initialDelayMs);
    first.unref?.();
    const timer = schedule(safeCheck, intervalMs);
    timer.unref?.();
    return () => { cancel(first); unschedule(timer); };
  }

  return { check, start, raise, clear, tell, afterRound, evaluate: () => inventory.inspect().then(evaluateHealth) };
}
