/**
 * Firewall overview for the Firewall page: live ufw state (from the helper), protected
 * ports, profiles, service presets, the stored profile, and advice computed from what is
 * actually listening (the web process shares the host network namespace, so `ss` works here).
 * Mounted at /api/v1 behind the session. Read-only; changes go through registry ops.
 */
import { Router } from "express";
import { listListeners } from "../ports.mjs";
import { adviseFirewall, buildPlan, profiles, protectedRules, riskyPorts, services } from "../firewall-profiles.mjs";

export function createFirewallRouter({ state, helper, catalogService, webPort, webHost, listeners = listListeners }) {
  const router = Router();
  const lanExposed = webHost === "0.0.0.0" || webHost === "::";

  async function installedApps() {
    const live = await helper.request("app.inspect", {}, { timeoutMs: 15_000 });
    const apps = [];
    for (const application of live?.applications ?? []) {
      if (!application.installed) continue;
      const manifest = await catalogService.get(application.id).catch(() => null);
      apps.push({
        id: application.id,
        name: manifest?.name ?? application.id,
        ports: (application.urls ?? []).filter((url) => url.exposure === "lan").map((url) => ({ port: url.host, protocol: "tcp", label: url.label })),
      });
    }
    return apps;
  }

  router.get("/firewall/overview", async (_request, response) => {
    let report = null; let reportError = null;
    try { report = await helper.request("firewall.inspect", {}, { timeoutMs: 30_000 }); } catch (error) { reportError = error.message; }
    const [listening, apps, fail2ban] = await Promise.all([listeners().catch(() => []), installedApps().catch(() => []), helper.request("fail2ban.inspect", {}, { timeoutMs: 15_000 }).catch(() => null)]);
    const current = state.getSetting("firewallProfile", null);
    response.json({
      report, reportError,
      web: { port: webPort, lanExposed },
      protected: protectedRules({ webPort, webHost }),
      profiles, services, riskyPorts, current,
      advice: adviseFirewall({ report, listeners: listening, apps, current, fail2ban, webPort, webHost }),
    });
  });

  // Pure preview of what applying a profile would run, so the approval dialog shows the exact commands.
  router.get("/firewall/plan", (request, response) => {
    try {
      const chosen = typeof request.query.services === "string" && request.query.services ? request.query.services.split(",") : [];
      const plan = buildPlan({ profileId: request.query.profile, serviceIds: chosen, replace: request.query.replace === "true", sshRateLimit: request.query.sshRateLimit === "true", webPort, webHost });
      response.json(plan);
    } catch (error) {
      response.status(400).json({ error: error.message, code: "invalid_plan" });
    }
  });

  return router;
}
