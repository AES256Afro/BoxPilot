/**
 * Firewall overview for the Firewall page: live ufw state (from the helper), protected
 * ports, profiles, service presets, the stored profile, and advice computed from what is
 * actually listening (the web process shares the host network namespace, so `ss` works here).
 * Mounted at /api/v1 behind the session. Read-only; changes go through registry ops.
 */
import os from "node:os";
import { Router } from "express";
import { helperFailure } from "../helper-errors.mjs";
import { listListeners } from "../ports.mjs";
import { adviseFirewall, buildPlan, lanSubnets, profiles, protectedRules, riskyPorts, services, tailnetSources } from "../firewall-profiles.mjs";
import { tlsPortOf } from "../tls-listener.mjs";
import { withOwnActors } from "./access.mjs";

/**
 * `env` is this process's environment: BOXPILOT_TLS_CERT, _KEY and _PORT say whether, and on which
 * port, HTTPS is served (tls-listener.mjs reads the same), so the protected list and the profile
 * preview keep that port as the root task does (M90 review).
 * @param {{ state: any, helper: any, catalogService: any, webPort: number, webHost: string, listeners?: typeof listListeners, getNetworkInterfaces?: () => any, env?: Record<string, string | undefined> }} options
 */
export function createFirewallRouter({ state, helper, catalogService, webPort, webHost, listeners = listListeners, getNetworkInterfaces = os.networkInterfaces, env = process.env }) {
  const router = Router();
  const lanExposed = webHost === "0.0.0.0" || webHost === "::";
  const tlsPort = env.BOXPILOT_TLS_CERT && env.BOXPILOT_TLS_KEY ? tlsPortOf(env.BOXPILOT_TLS_PORT) : null;
  /** SSH's ports as firewall.inspect read them from sshd -T; null when it could not. */
  const sshPortsOf = (report) => (Array.isArray(report?.sshPorts) && report.sshPorts.every(Number.isInteger) ? report.sshPorts : null);

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

  router.get("/firewall/overview", async (request, response) => {
    let report = null; let reportError = null;
    try { report = await helper.request("firewall.inspect", {}, { timeoutMs: 30_000 }); } catch (error) { reportError = helperFailure(error)?.error ?? error.message; }
    const [listening, apps, fail2ban] = await Promise.all([listeners().catch(() => []), installedApps().catch(() => []), helper.request("fail2ban.inspect", {}, { timeoutMs: 15_000 }).catch(() => null)]);
    // Which profile is in force is the server's; who applied it is the owner's to see (M29.4).
    const current = withOwnActors(request, state.getSetting("firewallProfile", null));
    // M90: where a new rule may let traffic in from. The web process shares the host's network
    // namespace, so its interfaces are the server's; null when it sits on no private IPv4 network.
    let lan = null;
    try { lan = lanSubnets(getNetworkInterfaces())[0] ?? null; } catch { /* no LAN choice */ }
    response.json({
      report, reportError,
      web: { port: webPort, lanExposed },
      protected: protectedRules({ webPort, webHost, tlsPort, sshPorts: sshPortsOf(report) }),
      profiles, services, riskyPorts, current,
      sources: { lan, tailnet: tailnetSources },
      advice: adviseFirewall({ report, listeners: listening, apps, current, fail2ban, webPort, webHost, tlsPort, lan }),
    });
  });

  // Preview of what applying a profile would run, so the approval dialog shows the exact commands.
  // M90: built against the rules in place (the Rules tab's read), so it lists what the profile
  // closes too. Without that read it would show a plan that closes nothing, so it says so instead.
  router.get("/firewall/plan", async (request, response) => {
    const chosen = typeof request.query.services === "string" && request.query.services ? request.query.services.split(",") : [];
    const replace = request.query.replace === "true";
    // The read also gives SSH's ports (M90 review). Starting from scratch closes nothing, so it can
    // go on without the read; its plan then shows only 22 kept, and the task adds any other SSH port.
    let existing = [];
    let sshPorts = null;
    try {
      const report = await helper.request("firewall.inspect", {}, { timeoutMs: 30_000 });
      existing = replace ? [] : Array.isArray(report?.rules) ? report.rules : [];
      sshPorts = sshPortsOf(report);
    } catch (error) {
      if (!replace) {
        response.status(502).json({ error: `The current rules could not be read, so the plan cannot say what it would close: ${error.message}`, code: "rules_unread" });
        return;
      }
    }
    try {
      const plan = buildPlan({ profileId: typeof request.query.profile === "string" ? request.query.profile : undefined, serviceIds: chosen, replace, sshRateLimit: request.query.sshRateLimit === "true", webPort, webHost, tlsPort, sshPorts, existing });
      response.json(plan);
    } catch (error) {
      response.status(400).json({ error: error.message, code: "invalid_plan" });
    }
  });

  return router;
}
