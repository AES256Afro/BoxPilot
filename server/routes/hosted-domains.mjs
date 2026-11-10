/**
 * Hosted domains routes (M42.2): what the page reads, the owner's cadence, and the names added by
 * hand. Mounted at /api/v1 behind the session. Reading is everyone's: a public name and whether it
 * answers is what the internet already knows. What only the helper could read is an operator's
 * (ADR-003): where each name is answered on this server, which comes out of config files under
 * root's folders, and the tunnel app's last complaint, which is a line of its log. Who added a name
 * is the owner's to see, and the account's own. Adding or removing a name is an operator's (the
 * policy refuses a viewer any change); the cadence is a setting, so the owner's.
 */
import { Router } from "express";
import { callerId, readsThroughHelper, seesEveryAccount } from "./access.mjs";

/** The names added by hand as this caller may see them: who added one is theirs if it was them, and otherwise the owner's. */
function manualFor(request, manual) {
  if (seesEveryAccount(request) || !Array.isArray(manual)) return manual;
  const self = callerId(request);
  return manual.map((entry) => (entry && typeof entry === "object" && typeof entry.addedBy === "string" && entry.addedBy !== self ? { ...entry, addedBy: null } : entry));
}

/** The page's read as this caller may see it: a viewer gets the names and their verdicts, without the local addresses or the tunnel's log line. */
function statusFor(request, status) {
  const manual = manualFor(request, status.manual);
  if (readsThroughHelper(request)) return { ...status, manual };
  return {
    ...status,
    manual: Array.isArray(manual) ? manual.map((entry) => (entry && typeof entry === "object" ? { ...entry, service: null } : entry)) : manual,
    // The advice names the local address it asked; a viewer reads the same sentence without it.
    domains: Array.isArray(status.domains) ? status.domains.map((domain) => (domain && typeof domain === "object" ? { ...domain, service: null, advice: typeof domain.service === "string" && domain.service && typeof domain.advice === "string" ? domain.advice.split(domain.service).join("the app's own address") : domain.advice ?? null } : domain)) : status.domains,
    tunnel: status.tunnel && typeof status.tunnel === "object" ? { ...status.tunnel, lastProblem: null } : status.tunnel,
  };
}

/** @param {{ hostedDomains: ReturnType<typeof import("../hosted-domains.mjs").createHostedDomainsService>, auth: any }} options */
export function createHostedDomainsRouter({ hostedDomains, auth }) {
  const router = Router();

  // The last round's verdicts; ?fresh=1 runs a round first, for anyone who may change the box (the
  // service keeps a pause between such rounds, and answers with the kept one inside it).
  router.get("/hosted-domains", async (request, response) => {
    const role = request.boxpilotSession?.owner?.role ?? "disabled";
    const fresh = request.query?.fresh === "1" && role !== "viewer";
    try {
      response.json(statusFor(request, await hostedDomains.status({ fresh })));
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
      const added = hostedDomains.addManual(request.body ?? {}, { updatedBy: request.boxpilotSession.owner.id });
      return response.status(201).json({ ...added, manual: manualFor(request, added.manual) });
    } catch (error) {
      return response.status(400).json({ error: error.message, code: error.code ?? "invalid_domain" });
    }
  });

  router.delete("/hosted-domains/manual/:hostname", auth.requireCsrf, async (request, response) => {
    try {
      const removed = await hostedDomains.removeManual(String(request.params.hostname), { updatedBy: request.boxpilotSession.owner.id });
      return response.json({ ...removed, manual: manualFor(request, removed.manual) });
    } catch (error) {
      return response.status(error.code === "not_found" ? 404 : 400).json({ error: error.message, code: error.code ?? "invalid_domain" });
    }
  });

  return router;
}
