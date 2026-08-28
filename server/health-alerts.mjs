/**
 * Health alerts: watches the sanitized inventory and pushes one notification per condition
 * when it turns bad (and one when it clears), through the same target failed jobs use.
 * Conditions come only from evidence the inventory already collects: disk space, SMART,
 * UPS state, failed services, reboot-required, unhealthy containers. State lives in a
 * setting so a restart does not re-send everything. A scheduled backup that quietly stopped is
 * treated the same way (M20.1), read from the schedule table rather than the inventory snapshot.
 */
import { evaluateScheduleFreshness } from "./schedule-freshness.mjs";

export const healthConditions = Object.freeze({
  "storage.root.full": "Root disk nearly full",
  "storage.mount.full": "A mounted filesystem is nearly full",
  "storage.smart": "A disk reports SMART problems",
  "power.ups": "UPS on battery or low",
  "system.services": "System services have failed",
  "system.reboot": "A reboot is required",
  "docker.unhealthy": "A container is unhealthy",
  "schedule.overdue": "A scheduled task (such as a backup) has stopped running",
});

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
    if (container.health !== "unhealthy") continue;
    alerts.push({ key: `docker.unhealthy:${container.name}`, priority: "default", title: `Container ${container.name} is unhealthy`, message: "Its health check is failing. Open the app's Logs on the App catalog page." });
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
    "storage.smart": storage?.smart?.available !== false && Array.isArray(storage?.smart?.disks) && storage.smart.disks.length > 0,
    "power.ups": inventory?.power?.ups?.available === true,
    "system.services": maintenance?.available !== false && Number.isFinite(maintenance?.system?.failedServiceCount),
    "system.reboot": maintenance?.available !== false && typeof maintenance?.reboot?.required === "boolean",
    "docker.unhealthy": inventory?.docker?.available !== false && Array.isArray(inventory?.docker?.containers),
  };
}

export function createHealthAlerts({ inventory, notifications, store, resolveScheduleTitle = (operationId) => operationId, intervalMs = 15 * 60 * 1000, initialDelayMs = 3 * 60 * 1000, now = () => new Date(), setInterval: schedule = globalThis.setInterval, setTimeout: delay = globalThis.setTimeout, clearInterval: unschedule = globalThis.clearInterval, clearTimeout: cancel = globalThis.clearTimeout } = {}) {
  const settingKey = "healthAlertsState";

  /** One pass: evaluate, send for new conditions and for cleared ones, persist the active set. */
  async function check() {
    const snapshot = await inventory.inspect();
    // A stopped backup is a health condition too, but it comes from the schedule and flow tables,
    // not the host. Both an operation schedule (how BoxPilot's own nightly backups run) and a
    // scheduled flow can quietly fall behind.
    const schedules = typeof store.listSchedules === "function" ? store.listSchedules() : [];
    const flows = (typeof store.listFlows === "function" ? store.listFlows() : [])
      .map((flow) => ({ id: `flow:${flow.id}`, title: flow.name, operationId: flow.name, frequency: flow.frequency, enabled: flow.enabled, nextDueAt: flow.nextDueAt }));
    const scheduleAlerts = evaluateScheduleFreshness([...schedules, ...flows], { now: now(), titleFor: (s) => s.title ?? resolveScheduleTitle(s.operationId) });
    const active = [...evaluateHealth(snapshot), ...scheduleAlerts];
    const previous = store.getSetting(settingKey, {}) ?? {};
    const nextState = {};
    const sent = [];
    const target = notifications.getTarget();
    for (const alert of active) {
      const seen = previous[alert.key];
      // Remember a condition only once it has actually been announced, or the owner who configures
      // notifications tomorrow would never hear about what broke today.
      // Entries written before this flag existed count as announced, so upgrading does not replay them.
      if (seen && seen.notified !== false) { nextState[alert.key] = seen; continue; }
      if (!target) { nextState[alert.key] = { since: seen?.since ?? now().toISOString(), title: alert.title, notified: false }; continue; }
      try {
        await notifications.send({ title: `BoxPilot: ${alert.title}`, message: alert.message, priority: alert.priority });
        nextState[alert.key] = { since: seen?.since ?? now().toISOString(), title: alert.title, notified: true };
        sent.push(alert.key);
        store.recordAudit("health.alert.sent", { actorId: null, subjectId: alert.key, details: { title: alert.title, at: now().toISOString() } });
      } catch (error) {
        store.recordAudit("health.alert.failed", { actorId: null, subjectId: alert.key, details: { error: error.message } });
        delete nextState[alert.key]; // try again next round
      }
    }
    // The schedule table is always readable, so an overdue alert can clear the moment it catches up.
    const availability = { ...collectorAvailability(snapshot), "schedule.overdue": true };
    for (const [key, entry] of Object.entries(previous)) {
      if (nextState[key]) continue;
      if (entry?.notified === false) continue; // never announced, so there is nothing to say it cleared
      // Evidence that is temporarily missing (stale SMART file, systemctl timeout) carries the alert forward unchanged.
      if (availability[key.split(":")[0]] === false) { nextState[key] = entry; continue; }
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
    store.setSetting(settingKey, nextState, { updatedBy: null });
    return { active: active.map((alert) => alert.key), sent, target: Boolean(target) };
  }

  function start() {
    const safeCheck = () => check().catch(() => {});
    const first = delay(safeCheck, initialDelayMs);
    first.unref?.();
    const timer = schedule(safeCheck, intervalMs);
    timer.unref?.();
    return () => { cancel(first); unschedule(timer); };
  }

  return { check, start, evaluate: () => inventory.inspect().then(evaluateHealth) };
}
