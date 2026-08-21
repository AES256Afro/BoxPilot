/**
 * Host and evidence routes: the catalog listing/precheck, capability matrix, inventory,
 * network assessment, logs, controller backup evidence, audit, support bundle, and the
 * GitHub SSH-key proxy. Mounted at /api/v1 behind the session.
 */
import { Router } from "express";
import { productVersion } from "../version.mjs";
import { registry, riskTiers } from "../ops/index.mjs";
import { approvalModes, elevationTtlMs } from "../ops/risk.mjs";
import { findPortConflicts, listListeners } from "../ports.mjs";
import { resolveValues } from "../catalog/schema.mjs";

export function createHostRouter({ state, helper, catalogService, inventory, network, controllerProtection, controllerRetention, githubProvenance, releaseUpdates, supportBundle, audit, auth }) {
  const router = Router();

  // Catalog: manifests come from the working tree; live state comes from the helper (tolerated when unavailable).
  router.get("/catalog", async (_request, response) => {
    const { manifests, problems } = await catalogService.all();
    let live = null; let liveError = null;
    try { live = await helper.request("app.inspect", {}, { timeoutMs: 30_000 }); } catch (error) { liveError = error.message; }
    let host = { lanAddress: null, tailscaleDnsName: null };
    try {
      const snapshot = await inventory.inspect();
      host = { lanAddress: snapshot?.network?.addresses?.find((entry) => /^\d+\.\d+\.\d+\.\d+$/.test(entry.address))?.address ?? null, tailscaleDnsName: snapshot?.network?.tailscale?.dnsName ?? null };
    } catch { /* host addresses are a convenience only */ }
    const applications = manifests.map((manifest) => ({ manifest, live: live?.applications?.find((entry) => entry.id === manifest.id) ?? null }));
    response.json({ applications, problems: [...problems, ...(live?.problems ?? [])], liveError, host });
  });

  // Precheck an install/reconfigure: validates values against the manifest and reports host port conflicts.
  router.post("/catalog/:id/precheck", auth.requireCsrf, async (request, response) => {
    const manifest = await catalogService.get(request.params.id);
    if (!manifest) return response.status(404).json({ error: "Application not found", code: "application_not_found" });
    const { values, errors } = resolveValues(manifest, request.body?.values ?? {});
    if (errors.length) return response.status(400).json({ ok: false, errors, conflicts: [] });
    const requested = manifest.ports.map((port) => ({ id: port.id, label: port.label, host: values.ports[port.id], protocol: port.protocol, exposure: port.exposure }));
    let conflicts = [];
    try {
      const listeners = await listListeners();
      const live = await helper.request("app.inspect", {}, { timeoutMs: 15_000 }).catch(() => null);
      const own = live?.applications?.find((entry) => entry.id === manifest.id);
      // When reconfiguring a running app, its own current ports are not conflicts.
      const ownPorts = new Set((own?.urls ?? []).map((url) => `${url.host}/tcp`));
      conflicts = findPortConflicts(requested, listeners).filter((conflict) => !(own?.installed && ownPorts.has(`${conflict.port}/${conflict.protocol}`)));
    } catch { /* conflicts are advisory */ }
    return response.json({ ok: conflicts.length === 0, errors: [], conflicts: conflicts.map((conflict) => ({ ...conflict, label: requested.find((port) => port.id === conflict.id)?.label ?? conflict.id })) });
  });

  // Fetch a GitHub user's public SSH keys (server-side because github.com has no CORS for browsers).
  router.get("/ssh-keys/github/:user", async (request, response) => {
    const user = request.params.user;
    if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(user)) return response.status(400).json({ error: "Invalid GitHub user name", code: "invalid_user" });
    try {
      const upstream = await fetch(`https://github.com/${user}.keys`, { headers: { "User-Agent": `BoxPilot/${productVersion}` }, signal: AbortSignal.timeout(10_000) });
      if (upstream.status === 404) return response.status(404).json({ error: `GitHub user ${user} was not found`, code: "github_user_not_found" });
      if (!upstream.ok) return response.status(502).json({ error: `GitHub returned ${upstream.status}`, code: "github_unavailable" });
      const keys = (await upstream.text()).split("\n").map((line) => line.trim()).filter((line) => /^(ssh-|ecdsa-|sk-)/.test(line)).slice(0, 20);
      return response.json({ user, keys });
    } catch (error) {
      return response.status(502).json({ error: `Could not reach GitHub: ${error.message}`, code: "github_unavailable" });
    }
  });

  // Capability matrix: booleans, enums, and counts derived from the operation registry (M1.6).
  router.get("/capabilities", async (_request, response) => {
    const has = (id) => registry.has(id);
    const catalogApps = await catalogService.all().then(({ manifests }) => manifests.length).catch(() => 0);
    response.json({
      version: productVersion,
      approvals: { modes: approvalModes, riskTiers, elevationTtlMs },
      jobs: { durable: true, liveOutput: true, events: true },
      operations: registry.ids(),
      packages: { refresh: has("apt.refresh"), upgrade: has("apt.upgrade"), install: has("apt.install"), remove: has("apt.remove"), purge: has("apt.purge"), autoremove: has("apt.autoremove"), reboot: has("system.reboot") },
      services: { list: has("service.list"), control: has("service.action"), journal: has("service.journal") },
      catalog: { apps: catalogApps, install: has("app.install"), uninstall: has("app.uninstall"), purge: has("app.purge"), update: has("app.update"), reconfigure: has("app.reconfigure"), logs: has("app.logs"), secrets: has("app.secrets") },
      vms: { create: true, cloudImages: has("vm.cloud.create"), lifecycle: true, snapshots: true, exports: true, protection: true, restoreDrills: true, recovery: true, delete: false, console: false },
      backups: { controller: true, applications: true, vms: true, restic: true, restoreDrills: true, retention: true, schedules: true },
      identity: { password: true, tailscale: true, github: true, passkeys: false, roles: ["owner"] },
    });
  });

  router.get("/integrations/github", async (_request, response) => {
    response.json(await githubProvenance.inspect());
  });

  // Self-update: the running version against the latest published GitHub release (cached 15 min).
  router.get("/system/update", async (request, response) => {
    response.json(await releaseUpdates.inspect({ refresh: request.query.refresh === "1" }));
  });

  router.get("/support-bundle", async (_request, response) => {
    response.json(await supportBundle.inspect());
  });

  router.get("/inventory", async (_request, response) => {
    response.json(await inventory.inspect());
  });

  router.get("/network/topology", async (_request, response) => {
    response.json(await network.inspect());
  });

  router.post("/network/plans", async (request, response) => {
    try {
      const plan = await network.plan(request.body, request.boxpilotSession.owner.id);
      response.status(201).json({ plan });
    } catch (error) {
      response.status(400).json({ error: error.message, code: "network_plan_failed" });
    }
  });

  router.get("/backups", (_request, response) => {
    response.json({ backups: state.listBackups(50) });
  });

  router.get("/controller-backup-protection", async (_request, response) => {
    response.json(await controllerProtection.list());
  });

  router.get("/controller-backup-retention", async (_request, response) => {
    try {
      response.json(await controllerRetention.inspect());
    } catch (error) {
      response.status(503).json({ error: error.message, code: "controller_retention_inspection_failed" });
    }
  });

  router.get("/audit", async (request, response) => {
    const result = await audit.list(request.query.limit);
    response.status(result.available ? 200 : 503).json(result);
  });

  return router;
}
