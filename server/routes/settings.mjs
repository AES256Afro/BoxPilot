/**
 * Settings routes: notification target and the approval-mode toggle. Both changes
 * require the owner password. Mounted at /api/v1 behind the session.
 */
import { Router } from "express";
import { approvalModes, defaultApprovalMode, elevationTtlMs, normalizeApprovalMode } from "../ops/risk.mjs";
import { verifyPassword } from "../security.mjs";

export function createSettingsRouter({ state, notifications, auth }) {
  const router = Router();

  async function ownerWithPassword(request, response, message) {
    const owner = state.findOwnerById(request.boxpilotSession.owner.id);
    if (!owner || typeof request.body?.password !== "string" || !(await verifyPassword(request.body.password, owner.passwordHash))) {
      response.status(401).json({ error: message, code: "reauthentication_required" });
      return null;
    }
    return owner;
  }

  // Failed-job push notifications (M8.4): where alerts go.
  router.get("/settings/notifications", (_request, response) => {
    response.json(notifications.describe());
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
      response.json(await notifications.send({ title: "BoxPilot test notification", message: "Notifications are working. Failed jobs will arrive like this." }));
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

  return router;
}
