/**
 * GET /api/v1/setup/checklist — the Overview's "Set up your server" list, computed from
 * evidence the web process already has. Read-only; mounted at /api/v1 behind the session.
 */
import { Router } from "express";
import { buildChecklist, gatherChecklistEvidence } from "../setup-checklist.mjs";

export function createChecklistRouter({ state, helper, notifications, inventory, network }) {
  const router = Router();
  router.get("/setup/checklist", async (_request, response) => {
    try {
      response.json(buildChecklist(await gatherChecklistEvidence({ state, helper, notifications, inventory, network })));
    } catch (error) {
      response.status(503).json({ error: error.message, code: "checklist_unavailable" });
    }
  });
  return router;
}
