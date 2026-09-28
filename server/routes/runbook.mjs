/**
 * The server runbook (M34.4): a preview, a download, and whether the downloaded copy is out of date.
 * Mounted at /api/v1 behind the session.
 *
 * Who may do what:
 * - Generating it - the preview and the out-of-date check - needs an operator (ADR-003). The
 *   document lays out private paths, addresses and the backup folders, and it is assembled from
 *   operator reads (each app's backup folder, the snapshot store, the Samba shares). An operator can
 *   open every one of those pages already; a viewer cannot, so a viewer is not handed the lot.
 * - Downloading the full document is the owner's, like the recovery kit. The owner's copy names
 *   where every second copy is kept (the SSH host and path, the cloud bucket, the backup drive's
 *   mirror), which with the rest of the document is the map to every copy of the data. It also
 *   carries every account's schedules and alerts, which M29.4 leaves to the owner. An operator's
 *   preview is the same document without those, and says so.
 */
import { Router } from "express";
import { callerId } from "./access.mjs";

export function createRunbookRouter({ runbook, auth }) {
  const router = Router();
  const roleOf = (request) => request.boxpilotSession?.owner?.role ?? "owner";
  const unavailable = (response) => response.status(503).json({ error: "The runbook could not be put together. Try again in a moment.", code: "runbook_unavailable" });

  // Cheap: BoxPilot's own records only, so the Repair page can ask on every load.
  router.get("/runbook/status", auth.requireRole("owner", "operator"), async (request, response) => {
    try {
      response.json(await runbook.status({ role: roleOf(request), callerId: callerId(request) }));
    } catch {
      unavailable(response);
    }
  });

  router.get("/runbook", auth.requireRole("owner", "operator"), async (request, response) => {
    try {
      response.json(await runbook.preview({ role: roleOf(request), callerId: callerId(request) }));
    } catch {
      unavailable(response);
    }
  });

  router.get("/runbook/download", auth.requireRole("owner"), async (request, response) => {
    try {
      const document = await runbook.download({ callerId: callerId(request) });
      response.setHeader("Content-Type", "text/markdown; charset=utf-8");
      response.setHeader("Content-Disposition", `attachment; filename="${document.filename}"`);
      response.setHeader("X-BoxPilot-Runbook-Fingerprint", document.fingerprint);
      response.send(document.markdown);
    } catch {
      unavailable(response);
    }
  });

  return router;
}
