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
import { hashPassword, renderAutoinstall, validateAutoinstallInput } from "../autoinstall.mjs";
import { readTlsStatus } from "../tls-status.mjs";
import { readFile } from "node:fs/promises";
import path from "node:path";

/**
 * The ports an installed app is already holding, as `port/protocol`, so reconfiguring it does not
 * report the app conflicting with itself.
 *
 * This used to read `own.urls`, which is not the app's ports: `urls` is the list of links worth
 * offering to open in a browser, so it keeps only TCP ports that Tailscale Serve can front. Pi-hole's
 * 53/tcp and 53/udp are left out of it on purpose, which meant Pi-hole was told its own DNS ports
 * were already in use, by itself, and could not be reconfigured at all. The stored values are the
 * real inventory, and the protocol has to come from the manifest rather than be assumed to be TCP.
 */
export function portsHeldByApp(manifest, own) {
  if (!own?.installed) return new Set();
  const stored = own.state?.values?.ports ?? {};
  return new Set((manifest.ports ?? [])
    .map((port) => ({ host: stored[port.id] ?? port.host, protocol: port.protocol }))
    .filter((port) => Number.isInteger(port.host))
    .map((port) => `${port.host}/${port.protocol}`));
}

/**
 * Every way to reach the control plane, from the bind, the local certificate, and whether Tailscale
 * Serve publishes us. Pure so it can be checked directly. `encrypted` is whether the link is HTTPS;
 * `trusted` is whether the certificate is trusted without installing anything (loopback and the real
 * ts.net certificate are; the local-CA LAN certificate is not until the CA is installed).
 */
export function buildReachability({ webHost, webPort, lanIp, dnsName, tls, servePublished }) {
  const onLan = webHost === "0.0.0.0";
  const ways = [
    { id: "loopback", label: "On this server", url: `http://127.0.0.1:${webPort}`, scope: "Only from the server itself", encrypted: false, trusted: true },
  ];
  if (onLan && lanIp) ways.push({ id: "lan", label: "On your home network", url: `http://${lanIp}:${webPort}`, scope: "Any device on your network", encrypted: false, trusted: false });
  if (onLan && tls?.provisioned) {
    for (const host of [...(tls.names ?? []), ...(tls.ipAddresses ?? [])]) {
      ways.push({ id: `lan-https:${host}`, label: "On your home network, encrypted", url: `https://${host}:${tls.port}`, scope: "Any device on your network, after installing the certificate", encrypted: true, trusted: false });
    }
  }
  if (servePublished && dnsName) ways.push({ id: "tailnet", label: "Over Tailscale, from anywhere", url: `https://${dnsName}`, scope: "Any device on your tailnet", encrypted: true, trusted: true });
  return { ways, onLan, tlsProvisioned: Boolean(tls?.provisioned), servePublished: Boolean(servePublished) };
}

export function createHostRouter({ state, helper, catalogService, inventory, network, controllerProtection, controllerRetention, githubProvenance, releaseUpdates, setup, supportBundle, audit, auth, identity = null, webHost = "127.0.0.1", webPort = 8787, tlsDir = process.env.BOXPILOT_TLS_DIR ?? "/etc/boxpilot/tls" }) {
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
    // Verdicts from the last restore rehearsal, recorded per app so they outlive job pruning.
    // Carried on the card because that is where the app's backups already are.
    const verifications = state.getSetting("appBackupVerifications", {}) ?? {};
    // Likewise the kill-switch drill. Recording that an app leaked outside its VPN and then showing
    // nobody is worse than not drilling: the owner believes it is covered because a drill ran.
    const drills = state.getSetting("killSwitchDrills", {}) ?? {};
    const applications = manifests.map((manifest) => {
      const entry = live?.applications?.find((row) => row.id === manifest.id) ?? null;
      return { manifest, live: entry ? { ...entry, backupVerification: verifications[manifest.id] ?? null, killSwitchDrill: drills[manifest.id] ?? null } : null };
    });
    response.json({ applications, // The catalog is read on both sides, so the same file would otherwise be reported twice.
      problems: [...new Map([...problems, ...(live?.problems ?? [])].map((problem) => [problem.file, problem])).values()], liveError, host });
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
      // The ports this app is already holding are not conflicts with itself.
      const ownPorts = portsHeldByApp(manifest, own);
      conflicts = findPortConflicts(requested, listeners).filter((conflict) => !ownPorts.has(`${conflict.port}/${conflict.protocol}`));
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
  /**
   * The certificate authority BoxPilot signs its own HTTPS certificate with, so a browser on
   * another machine can be told to trust it. Only ever ca.crt: the filename is fixed here, the
   * matching ca.key is 0600 and root-owned, and nothing in this process reads it. Installing this
   * concerns reaching BoxPilot's own web interface over HTTPS - file shares use SMB and no
   * certificate is involved in opening one.
   */
  router.get("/tls/ca.crt", async (_request, response) => {
    const certificate = await readFile(path.join(tlsDir, "ca.crt"), "utf8").catch(() => null);
    if (certificate === null) return response.status(404).json({ error: "No certificate has been issued for this server yet", code: "tls_not_provisioned" });
    response.setHeader("Content-Type", "application/x-x509-ca-cert");
    response.setHeader("Content-Disposition", 'attachment; filename="boxpilot-ca.crt"');
    return response.send(certificate);
  });

  router.get("/capabilities", async (_request, response) => {
    const has = (id) => registry.has(id);
    const catalogApps = await catalogService.all().then(({ manifests }) => manifests.length).catch(() => 0);
    const tls = await readTlsStatus({ dir: tlsDir });
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
      identity: { password: true, tailscale: true, github: true, passkeys: true, roles: ["owner", "operator", "viewer"] },
      network: { bind: webHost, port: webPort, lan: webHost === "0.0.0.0", canSet: has("system.web.lan.set") },
      tls: { ...tls, canProvision: has("system.web.tls.provision") },
    });
  });

  router.get("/integrations/github", async (_request, response) => {
    response.json(await githubProvenance.inspect());
  });

  // Self-update: the running version against the latest published GitHub release (cached 15 min).
  router.get("/system/update", async (request, response) => {
    response.json(await releaseUpdates.inspect({ refresh: request.query.refresh === "1" }));
  });

  // First-run setup profiles resolved against live state (M4.2).
  router.get("/setup", async (_request, response) => {
    response.json(await setup.describe());
  });

  // Ubuntu autoinstall user-data for a *new* server (M4.3). Nothing on this host changes; the
  // new account's password is hashed here with openssl and never stored.
  router.post("/setup/autoinstall", auth.requireCsrf, async (request, response) => {
    const input = request.body ?? {};
    const errors = validateAutoinstallInput(input);
    if (errors.length) return response.status(400).json({ error: errors.join("; "), code: "invalid_autoinstall" });
    try {
      const passwordHash = await hashPassword(input.password);
      const rendered = renderAutoinstall(input, { passwordHash });
      state.recordAudit("setup.autoinstall.generated", { actorId: request.boxpilotSession.owner.id, subjectId: input.hostname, details: { hostname: input.hostname, username: input.username, network: input.network?.mode, disk: input.disk?.layout, ref: rendered.ref } });
      return response.json(rendered);
    } catch (error) {
      return response.status(503).json({ error: error.message, code: "autoinstall_failed" });
    }
  });

  // The bundle includes journal excerpts, so it needs the same role as reading the journal directly.
  router.get("/support-bundle", auth.requireRole("owner", "operator"), async (_request, response) => {
    response.json(await supportBundle.inspect());
  });

  router.get("/inventory", async (_request, response) => {
    response.json(await inventory.inspect());
  });

  router.get("/network/topology", async (_request, response) => {
    response.json(await network.inspect());
  });

  // Every device on the owner's tailnet (M24.1): names, addresses, roles, and reachability, so the
  // Network page shows the tailnet the way it shows the LAN. Read-only; nothing here mutates.
  router.get("/network/tailnet", async (_request, response) => {
    response.json(await network.tailnet());
  });

  // Every way to reach the BoxPilot control plane, so "which URL do I use" has one honest answer
  // (M18.3). Assembled from the bind, the local certificate, and whether Tailscale Serve publishes us.
  router.get("/network/reachability", async (_request, response) => {
    const [topology, tls, servePublished] = await Promise.all([
      network.inspect().catch(() => ({})),
      readTlsStatus({ dir: tlsDir }),
      identity?.servePublishesControlPlane ? identity.servePublishesControlPlane().catch(() => false) : Promise.resolve(false),
    ]);
    response.json(buildReachability({
      webHost, webPort,
      lanIp: topology.eligibleLanAddresses?.[0]?.address ?? null,
      dnsName: topology.tailscale?.dnsName ?? null,
      tls, servePublished,
    }));
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
