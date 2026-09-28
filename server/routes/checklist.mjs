/**
 * GET /api/v1/setup/checklist — the Overview's "Set up your server" list, computed from
 * evidence the web process already has. Read-only; mounted at /api/v1 behind the session.
 *
 * Every role reads it. Two of its sources are operator reads (samba.inspect and
 * host.snapshot.inspect), and what reaches the page from them is whether shares are served and
 * the day the backup drive was last written - never a listing or a size - which is the summary
 * M29.4 keeps open to viewers.
 */
import { Router } from "express";
import { buildChecklist, gatherChecklistEvidence } from "../setup-checklist.mjs";

export function createChecklistRouter({ state, helper, notifications, inventory, network, driveChecks = undefined, storage = null }) {
  const router = Router();
  router.get("/setup/checklist", async (_request, response) => {
    try {
      response.json(buildChecklist(await gatherChecklistEvidence({ state, helper, notifications, inventory, network, driveChecks, storage })));
    } catch (error) {
      response.status(503).json({ error: error.message, code: "checklist_unavailable" });
    }
  });
  return router;
}
