/**
 * Host and evidence routes: the catalog listing/precheck, capability matrix, inventory,
 * network assessment, logs, controller backup evidence, audit, support bundle, and the
 * GitHub SSH-key proxy. Mounted at /api/v1 behind the session.
 */
import { Router } from "express";
import { productVersion } from "../version.mjs";
import { runtimeDiagnostics } from "../runtime-diagnostics.mjs";
import { registry, riskTiers } from "../ops/index.mjs";
import { approvalModes, elevationTtlMs } from "../ops/risk.mjs";
import { findPortConflicts, listListeners } from "../ports.mjs";
import { keepsBackupData, resolveValues } from "../catalog/schema.mjs";
import { optionalPortsIn } from "../catalog/compose.mjs";
import { hashPassword, renderAutoinstall, validateAutoinstallInput } from "../autoinstall.mjs";
import { readTlsStatus } from "../tls-status.mjs";
import { collectStorage } from "../storage-inventory.mjs";
import { scanRemediations } from "../remediations-scan.mjs";
import { latestOutageCheck } from "../outage-dns.mjs";
import { attemptsKey, dismissalFrom, dismissalsKey, findingIdPattern, jobIdPattern, withAttempt, withDismissal } from "../repair-ledger.mjs";
import { callerId, readsThroughHelper, seesEveryAccount, withOwnActors } from "./access.mjs";
import { access, readFile } from "node:fs/promises";
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
  // On the host's own network an app holds its container ports, which its record lists as published.
  return new Set([...(manifest.ports ?? []).map((port) => ({ host: stored[port.id] ?? port.host, protocol: port.protocol })), ...(own.published ?? [])]
    .filter((port) => Number.isInteger(port.host))
    .map((port) => `${port.host}/${port.protocol === "udp" ? "udp" : "tcp"}`));
}

/**
 * The values to precheck an installed app's settings with: each required secret the form left blank
 * stands in as given. Saved settings never hold a secret (only the app's .env does), so the Settings
 * form for the Cloudflare Tunnel or Cloudflare DDNS sends its token blank; the change itself takes it
 * from .env (app-helper withSavedSecrets), and the precheck refused it with "is required". For the
 * check only: these values go nowhere else.
 */
export function withSavedSecretsAssumed(manifest, raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
  if (raw.env !== undefined && (!raw.env || typeof raw.env !== "object" || Array.isArray(raw.env))) return raw;
  const env = { ...(raw.env ?? {}) };
  for (const entry of manifest.env ?? []) {
    if (!entry.secret || !entry.required || entry.fixed || entry.generate || (entry.default !== null && entry.default !== undefined)) continue;
    if (env[entry.name] === undefined || env[entry.name] === null || env[entry.name] === "") env[entry.name] = entry.options?.[0] ?? "saved";
  }
  return { ...raw, env };
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

export function createHostRouter({ state, helper, catalogService, inventory, network, dnsResilience = null, notifications = null, controllerProtection, controllerRetention, githubProvenance, releaseUpdates, setup, supportBundle, audit, auth, identity = null, webHost = "127.0.0.1", webPort = 8787, tlsDir = process.env.BOXPILOT_TLS_DIR ?? "/etc/boxpilot/tls", collect = collectStorage, fileExists = (file) => access(file).then(() => true, () => false), readListeners = listListeners }) {
  const router = Router();
  router.get("/diagnostics/runtime", async (_request, response) => {
    const [web, worker] = await Promise.allSettled([
      runtimeDiagnostics.inspect(),
      helper.request("system.runtime.inspect", {}, { timeoutMs: 10_000 }),
    ]);
    response.json({
      web: web.status === "fulfilled" ? web.value : null,
      helper: worker.status === "fulfilled" ? worker.value : null,
      helperAvailable: worker.status === "fulfilled",
      transport: helper.diagnostics?.() ?? null,
      cache: runtimeDiagnostics.cacheStats(),
    });
  });


  // Catalog: manifests come from the working tree; live state comes from the helper (tolerated when unavailable).
  router.get("/catalog", async (request, response) => {
    // Three unrelated questions - what is in the catalog, what is running, and how to reach this
    // box - so they are asked at once. Only the first is required; the other two degrade.
    const [catalog, liveResult, snapshotResult] = await Promise.all([
      catalogService.all(),
      helper.request("app.inspect", {}, { timeoutMs: 30_000 }).then((value) => ({ value }), (error) => ({ error: error.message })),
      inventory.inspect().catch(() => null),
    ]);
    const { manifests, problems } = catalog;
    const live = liveResult.error ? null : liveResult.value;
    const liveError = liveResult.error ?? null;
    const host = { lanAddress: snapshotResult?.network?.addresses?.find((entry) => /^\d+\.\d+\.\d+\.\d+$/.test(entry.address))?.address ?? null, tailscaleDnsName: snapshotResult?.network?.tailscale?.dnsName ?? null };
    // Verdicts from the last restore rehearsal, recorded per app so they outlive job pruning.
    // Carried on the card because that is where the app's backups already are.
    const verifications = state.getSetting("appBackupVerifications", {}) ?? {};
    // Likewise the kill-switch drill. Recording that an app leaked outside its VPN and then showing
    // nobody is worse than not drilling: the owner believes it is covered because a drill ran.
    const drills = state.getSetting("killSwitchDrills", {}) ?? {};
    // Apps the owner stopped from BoxPilot, so Home can say "Stopped" rather than calling them down.
    const stops = state.getSetting("appStops", {}) ?? {};
    // Six pages fetch this and five of them read id, name, category, icon and the volumes' host
    // paths - of 442 KB, most of it env definitions, notes and install steps only the catalog page
    // itself shows. ?view=summary hands those five what they use: about a tenth of the bytes, on
    // every Overview and Storage load. The catalog page keeps the whole manifest.
    const summary = request.query.view === "summary";
    const project = (manifest) => (summary ? {
      id: manifest.id, name: manifest.name, category: manifest.category, icon: manifest.icon ?? null, website: manifest.website ?? null,
      description: manifest.description, image: { version: manifest.image?.version ?? null },
      ports: (manifest.ports ?? []).map((port) => ({ id: port.id, label: port.label, host: port.host, protocol: port.protocol, exposure: port.exposure })),
      volumes: (manifest.volumes ?? []).map((volume) => ({ id: volume.id, label: volume.label ?? null, hostPath: volume.hostPath ?? null, configurable: Boolean(volume.configurable), readOnly: Boolean(volume.readOnly) })),
      // Whether an app backup archives anything of it, sidecars included, so the command bar offers
      // a quick "Back up X" (M36) only where it means something.
      keepsBackup: keepsBackupData(manifest),
    } : manifest);
    // The verdicts say who ran the drill; only the owner is told when that was another account.
    const applications = manifests.map((manifest) => {
      const entry = live?.applications?.find((row) => row.id === manifest.id) ?? null;
      return { manifest: project(manifest), live: entry ? { ...entry, backupVerification: withOwnActors(request, verifications[manifest.id] ?? null), killSwitchDrill: withOwnActors(request, drills[manifest.id] ?? null), stoppedOnPurpose: stops[manifest.id] ? { at: stops[manifest.id].at ?? null } : null } : null };
    });
    response.json({ applications, // The catalog is read on both sides, so the same file would otherwise be reported twice.
      problems: [...new Map([...problems, ...(live?.problems ?? [])].map((problem) => [problem.file, problem])).values()], liveError, host });
  });

  // Precheck an install/reconfigure: validates values against the manifest and reports host port conflicts.
  router.post("/catalog/:id/precheck", auth.requireCsrf, async (request, response) => {
    const manifest = await catalogService.get(request.params.id);
    if (!manifest) return response.status(404).json({ error: "Application not found", code: "application_not_found" });
    // Whether the app is installed decides what its blank secrets mean, so it is asked first.
    const [listeners, live, docker] = await Promise.all([
      Promise.resolve().then(() => readListeners()).catch(() => null),
      helper.request("app.inspect", {}, { timeoutMs: 15_000 }).catch(() => null),
      // Names the container behind a docker-proxy listener; optional, so a failure just omits it.
      helper.request("container.docker.inventory", {}, { timeoutMs: 15_000 }).catch(() => null),
    ]);
    const own = live?.applications?.find((entry) => entry.id === manifest.id) ?? null;
    const given = request.body?.values ?? {};
    const { values, errors } = resolveValues(manifest, own?.installed ? withSavedSecretsAssumed(manifest, given) : given);
    if (errors.length) return response.status(400).json({ ok: false, errors, conflicts: [] });
    // On the host's own network the app binds its container ports itself, and one its own settings
    // let it start without (Pi-hole's admin page, `80o`) is warned about by the install, not refused.
    const hostNetwork = (values.networkMode ?? manifest.network) === "host";
    const optional = hostNetwork ? optionalPortsIn(Object.values(values.env ?? {})) : new Set();
    const requested = manifest.ports
      .filter((port) => !(hostNetwork && optional.has(port.container)))
      .map((port) => ({ id: port.id, label: port.label, host: hostNetwork ? port.container : values.ports[port.id], protocol: port.protocol, exposure: port.exposure }));
    let conflicts = [];
    try {
      // The ports this app is already holding are not conflicts with itself.
      const ownPorts = portsHeldByApp(manifest, own);
      conflicts = findPortConflicts(requested, listeners ?? [], docker?.containers ?? null).filter((conflict) => !ownPorts.has(`${conflict.port}/${conflict.protocol}`));
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
   * Everything wrong with this server right now that BoxPilot knows how to fix, gathered from both
   * sides: the filesystem facts this process can read, the per-app state the helper reports, and the
   * verdicts recorded from earlier drills. Read-only — it finds problems and names the operation
   * that fixes each one; nothing runs until the owner approves it.
   */
  router.get("/remediations", async (request, response) => {
    // The scan is shared with the agents' repair.findings tool (M47): the same findings on the Repair page and in an agent's answer.
    const visibleJobs = typeof state.listJobs === "function" ? state.listJobs(200, seesEveryAccount(request) ? {} : { createdBy: callerId(request) }) : [];
    const scanned = await scanRemediations({ helper, state, catalogService, inventory, collect, fileExists, readListeners, notifications, dnsResilience, operatorReadsWanted: readsThroughHelper(request), visibleJobsGiven: visibleJobs });
    response.json(withOwnActors(request, scanned));
  });

  /**
   * Set a finding aside (M35): "not now", with the reason in the owner's words. It comes back by
   * itself when what it says changes, and a critical one is never set aside. A failed job is let go
   * on the job itself (M36, POST /jobs/:id/dismiss). Viewers are refused by the role policy before
   * this runs; operators may, as they may fix.
   */
  router.post("/remediations/dismissals", auth.requireCsrf, (request, response) => {
    const made = dismissalFrom(request.body, { by: callerId(request) });
    if (made.error) return response.status(400).json({ error: made.error, code: "dismissal_rejected" });
    state.updateSetting(dismissalsKey, {}, (entries) => ({ value: withDismissal(entries, made.key, made.entry) }), callerId(request));
    state.recordAudit?.("repair.dismissed", { actorId: callerId(request), subjectId: made.key, details: { reason: made.entry.reason } });
    return response.status(201).json({ dismissed: made.key });
  });

  /** Bring a set-aside finding back. */
  router.delete("/remediations/dismissals/:id", auth.requireCsrf, (request, response) => {
    const key = String(request.params.id ?? "");
    const entries = state.getSetting(dismissalsKey, {}) ?? {};
    if (!Object.hasOwn(entries, key)) return response.status(404).json({ error: "Nothing is set aside under that name", code: "dismissal_not_found" });
    state.updateSetting(dismissalsKey, {}, (current) => { const { [key]: _gone, ...rest } = current ?? {}; return { value: rest }; }, callerId(request));
    state.recordAudit?.("repair.restored", { actorId: callerId(request), subjectId: key });
    return response.json({ restored: key });
  });

  /**
   * Which finding a job was started from (M35), so its outcome is shown on that finding and a failure
   * drops away once the finding is gone. Only a job the caller may read, and only an operation's.
   */
  router.post("/remediations/attempts", auth.requireCsrf, (request, response) => {
    const { findingId, jobId } = request.body ?? {};
    if (typeof findingId !== "string" || !findingIdPattern.test(findingId) || typeof jobId !== "string" || !jobIdPattern.test(jobId)) return response.status(400).json({ error: "Name the finding and the job", code: "attempt_rejected" });
    const job = state.getJob?.(jobId);
    if (!job || (!seesEveryAccount(request) && job.createdBy !== callerId(request))) return response.status(404).json({ error: "Job not found", code: "job_not_found" });
    if (!String(job.type).startsWith("op:")) return response.status(400).json({ error: "Only an operation's job fixes a finding", code: "attempt_rejected" });
    state.updateSetting(attemptsKey, {}, (entries) => ({ value: withAttempt(entries, jobId, findingId) }), callerId(request));
    return response.status(201).json({ recorded: jobId });
  });

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
  // An operator's bundle carries their own audit trail and job failures, not every account's (M29.4).
  router.get("/support-bundle", auth.requireRole("owner", "operator"), async (request, response) => {
    response.json(await supportBundle.inspect(seesEveryAccount(request) ? {} : { actorId: callerId(request) }));
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

  // Whether the house keeps its DNS while this server is off (M39.2): what the router hands out, each
  // server asked directly, the last rehearsal, and the last check after a power cut. Open to every
  // role like the topology it is read from; `?fresh=1` reads it again rather than the kept answer.
  router.get("/network/dns-resilience", async (request, response) => {
    if (!dnsResilience) return response.status(404).json({ error: "Not found", code: "not_found" });
    try {
      const verdict = await dnsResilience.check({ fresh: request.query?.fresh === "1" });
      return response.json({ ...verdict, afterOutage: latestOutageCheck(state) });
    } catch (error) {
      return response.status(500).json({ error: `The DNS check could not run: ${error.message}`, code: "dns_resilience_failed" });
    }
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

  // Backup evidence is the server's, open to every role; who took each one is the owner's to see.
  router.get("/backups", (request, response) => {
    response.json({ backups: withOwnActors(request, state.listBackups(50)) });
  });

  router.get("/controller-backup-protection", async (request, response) => {
    response.json(withOwnActors(request, await controllerProtection.list()));
  });

  router.get("/controller-backup-retention", async (request, response) => {
    try {
      response.json(withOwnActors(request, await controllerRetention.inspect()));
    } catch (error) {
      response.status(503).json({ error: error.message, code: "controller_retention_inspection_failed" });
    }
  });

  // An audit trail is who did what: everyone but the owner reads only their own entries.
  router.get("/audit", async (request, response) => {
    const result = await audit.list(request.query.limit);
    const self = callerId(request);
    const visible = seesEveryAccount(request) ? result : { ...result, events: (result.events ?? []).filter((event) => self && event.actorId === self) };
    response.status(result.available ? 200 : 503).json(visible);
  });

  return router;
}
