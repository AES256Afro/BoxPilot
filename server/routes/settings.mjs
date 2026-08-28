/**
 * Settings routes: notification target and the approval-mode toggle. Both changes
 * require the owner password. Mounted at /api/v1 behind the session.
 */
import { Router } from "express";
import { approvalModes, defaultApprovalMode, elevationTtlMs, normalizeApprovalMode } from "../ops/risk.mjs";
import { normalizeDestination } from "../backup-destination.mjs";
import { healthConditions } from "../health-alerts.mjs";

export function createSettingsRouter({ state, notifications, auth }) {
  const router = Router();
  // Belt and braces with the policy middleware: only the owner changes settings, whatever the path casing.
  router.use("/settings", (request, response, next) => (["GET", "HEAD", "OPTIONS"].includes(request.method) ? next() : auth.requireRole("owner")(request, response, next)));

  async function ownerWithPassword(request, response, message) {
    const owner = state.findOwnerById(request.boxpilotSession.owner.id);
    const verdict = await auth.checkPassword(request, owner, request.body?.password);
    if (verdict.blocked) { auth.rejectThrottled(response, verdict); return null; }
    if (!verdict.ok) {
      response.status(401).json({ error: message, code: "reauthentication_required" });
      return null;
    }
    return owner;
  }

  // Failed-job push notifications (M8.4): where alerts go.
  router.get("/settings/notifications", (_request, response) => {
    response.json(notifications.describe());
  });

  // What BoxPilot watches for on its own, and which conditions are live right now. The active set is
  // the health-alert watcher's own persisted state, grouped back to its condition families.
  router.get("/settings/watch", (_request, response) => {
    const active = state.getSetting("healthAlertsState", {}) ?? {};
    const byFamily = {};
    for (const [key, entry] of Object.entries(active)) {
      if (!entry || entry.notified === false) continue; // recorded but not yet announced
      const family = key.split(":")[0];
      (byFamily[family] ??= []).push({ title: entry.title ?? key, since: entry.since ?? null });
    }
    const conditions = Object.entries(healthConditions).map(([key, label]) => ({ key, label, active: Boolean(byFamily[key]?.length), details: byFamily[key] ?? [] }));
    response.json({ targetConfigured: notifications.describe().configured === true, activeCount: Object.values(byFamily).reduce((sum, list) => sum + list.length, 0), conditions });
  });

  router.put("/settings/notifications", auth.requireCsrf, async (request, response) => {
    const owner = await ownerWithPassword(request, response, "Owner password required to change the notification target");
    if (!owner) return;
    try {
      notifications.setTarget(request.body?.target ?? null, { updatedBy: owner.id });
      response.json(notifications.describe());
    } catch (error) {
      response.status(400).json({ error: error.message, code: "invalid_setting" });
    }
  });

  router.post("/settings/notifications/test", auth.requireCsrf, async (_request, response) => {
    try {
      response.json(await notifications.send({ title: "BoxPilot test notification", message: "Notifications are working. Failed jobs, new releases, and health alerts (disk space, SMART, UPS, failed services) arrive like this." }));
    } catch (error) {
      response.status(502).json({ error: error.message, code: "notification_test_failed" });
    }
  });

  router.get("/settings/approval-mode", (_request, response) => {
    response.json({ approvalMode: normalizeApprovalMode(state.getSetting("approvalMode", null) ?? process.env.BOXPILOT_APPROVAL_MODE ?? defaultApprovalMode), modes: approvalModes, elevationTtlMs });
  });

  router.put("/settings/approval-mode", auth.requireCsrf, async (request, response) => {
    const mode = request.body?.approvalMode;
    if (!approvalModes.includes(mode)) return response.status(400).json({ error: `approvalMode must be one of ${approvalModes.join(", ")}`, code: "invalid_setting" });
    const owner = await ownerWithPassword(request, response, "Owner password required to change the approval mode");
    if (!owner) return undefined;
    state.setSetting("approvalMode", mode, { updatedBy: owner.id });
    state.recordAudit("settings.approval-mode.changed", { actorId: owner.id, subjectId: owner.id, details: { approvalMode: mode } });
    return response.json({ approvalMode: mode, modes: approvalModes, elevationTtlMs });
  });

  // Cloud (rclone) destination: the non-secret description saved by backup.cloud.setup, plus the last mirror.
  router.get("/settings/cloud-destination", (_request, response) => {
    response.json({ destination: state.getSetting("cloudDestination", null), lastSync: state.getSetting("cloudDestinationLastSync", null) });
  });

  // Off-box SSH backup destination (M6.2). Not secret — the key stays root-only on the server.
  router.get("/settings/backup-destination", (_request, response) => {
    response.json({ destination: state.getSetting("backupDestination", null), lastSync: state.getSetting("backupDestinationLastSync", null) });
  });

  router.put("/settings/backup-destination", auth.requireCsrf, async (request, response) => {
    const owner = await ownerWithPassword(request, response, "Owner password required to change the backup destination");
    if (!owner) return undefined;
    if (request.body?.destination === null) {
      state.setSetting("backupDestination", null, { updatedBy: owner.id });
      return response.json({ destination: null, lastSync: null });
    }
    try {
      const destination = normalizeDestination(request.body?.destination ?? {});
      state.setSetting("backupDestination", destination, { updatedBy: owner.id });
      state.recordAudit("settings.backup-destination.changed", { actorId: owner.id, subjectId: owner.id, details: { host: destination.host, user: destination.user, path: destination.path, port: destination.port } });
      return response.json({ destination, lastSync: state.getSetting("backupDestinationLastSync", null) });
    } catch (error) {
      return response.status(400).json({ error: error.message, code: "invalid_setting" });
    }
  });

  return router;
}
