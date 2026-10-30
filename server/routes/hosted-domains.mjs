/**
 * Hosted domains routes (M42.2): what the page reads, the owner's cadence, and the names added by
 * hand. Mounted at /api/v1 behind the session. Reading is everyone's: a public name and whether it
 * answers is what the internet already knows, and the local address beside it is the same kind of
 * fact the Network page shows. Adding or removing a name is an operator's (the policy refuses a
 * viewer any change); the cadence is a setting, so the owner's.
 */
import { Router } from "express";

/** @param {{ hostedDomains: ReturnType<typeof import("../hosted-domains.mjs").createHostedDomainsService>, auth: any }} options */
export function createHostedDomainsRouter({ hostedDomains, auth }) {
  const router = Router();

  // The last round's verdicts; ?fresh=1 runs a round first, for anyone who may change the box.
  router.get("/hosted-domains", async (request, response) => {
    const role = request.boxpilotSession?.owner?.role ?? "disabled";
    const fresh = request.query?.fresh === "1" && role !== "viewer";
    try {
      response.json(await hostedDomains.status({ fresh }));
    } catch (error) {
      response.status(500).json({ error: `The hosted domains could not be checked: ${error.message}`, code: "hosted_domains_failed" });
    }
  });

  router.put("/hosted-domains/settings", auth.requireCsrf, auth.requireRole("owner"), (request, response) => {
    const minutes = request.body?.intervalMinutes;
    if (!Number.isInteger(minutes)) return response.status(400).json({ error: "intervalMinutes must be a whole number of minutes", code: "invalid_setting" });
    try {
      return response.json(hostedDomains.setIntervalMinutes(minutes, { updatedBy: request.boxpilotSession.owner.id }));
    } catch (error) {
      return response.status(400).json({ error: error.message, code: "invalid_setting" });
    }
  });

  router.post("/hosted-domains/manual", auth.requireCsrf, (request, response) => {
    try {
      return response.status(201).json(hostedDomains.addManual(request.body ?? {}, { updatedBy: request.boxpilotSession.owner.id }));
    } catch (error) {
      return response.status(400).json({ error: error.message, code: error.code ?? "invalid_domain" });
    }
  });

  router.delete("/hosted-domains/manual/:hostname", auth.requireCsrf, async (request, response) => {
    try {
      return response.json(await hostedDomains.removeManual(String(request.params.hostname), { updatedBy: request.boxpilotSession.owner.id }));
    } catch (error) {
      return response.status(error.code === "not_found" ? 404 : 400).json({ error: error.message, code: error.code ?? "invalid_domain" });
    }
  });

  return router;
}
