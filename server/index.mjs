import express from "express";
import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createDeviceResolver } from "./catalog/devices.mjs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startTlsListener } from "./tls-listener.mjs";
import { productVersion } from "./version.mjs";
import { createCatalogService } from "./catalog/index.mjs";
import { createJobLogReader } from "./job-log.mjs";
import { createActionCenterService } from "./action-center.mjs";
import { createAuditLog } from "./audit.mjs";
import { createControllerProtectionService } from "./controller-protection.mjs";
import { createControllerRetentionService } from "./controller-retention.mjs";
import { createGithubProvenanceService } from "./github-provenance.mjs";
import { createAuthService } from "./security.mjs";
import { createIdentityService } from "./identity.mjs";
import { createPasskeyService } from "./passkeys.mjs";
import { createOidcService } from "./oidc.mjs";
import { createIdentityRouter } from "./routes/identity.mjs";
import { createPasskeyRouter } from "./routes/passkeys.mjs";
import { createOidcRouter, createOidcAdminRouter } from "./routes/oidc.mjs";
import { createOperationsRouter } from "./routes/operations.mjs";
import { createJobsRouter } from "./routes/jobs.mjs";
import { createVirtualizationRouter } from "./routes/virtualization.mjs";
import { createSettingsRouter } from "./routes/settings.mjs";
import { createHostRouter } from "./routes/host.mjs";
import { createFirewallRouter } from "./routes/firewall.mjs";
import { createStorageRouter } from "./routes/storage.mjs";
import { createPowerRouter } from "./routes/power.mjs";
import { createChecklistRouter } from "./routes/checklist.mjs";
import { createPeopleRouter } from "./routes/people.mjs";
import { createHelperClient } from "./helper-client.mjs";
import { createHelperLibvirtService } from "./helper-libvirt.mjs";
import { createInventoryService } from "./inventory.mjs";
import { createJobService } from "./jobs.mjs";
import { createLibvirtFoundationService } from "./libvirt-foundation.mjs";
import { createMaintenanceService } from "./maintenance.mjs";
import { createNetworkService } from "./network.mjs";
import { createPrerequisiteService } from "./prerequisites.mjs";
import { createRecoveryKitService } from "./recovery-kit.mjs";
import { createReleaseUpdateService } from "./release-updates.mjs";
import { createSetupService } from "./setup-profiles.mjs";
import { createUpdateNotifier } from "./update-notifier.mjs";
import { createHealthAlerts } from "./health-alerts.mjs";
import { createTlsRenewal } from "./tls-renewal.mjs";
import { createDiskSampler } from "./disk-forecast.mjs";
import { createSmartSampler } from "./smart-trends.mjs";
import { registry } from "./ops/index.mjs";
import { createNotificationService } from "./notifications.mjs";
import { createSchedulerService } from "./scheduler.mjs";
import { createFlowService } from "./flows.mjs";
import { loadFlowLibrary } from "./flow-library.mjs";
import { createStateStore } from "./state.mjs";
import { createSupportBundleService } from "./support-bundle.mjs";
import { createVmCreationService } from "./vm-creation.mjs";
import { createVmExportService } from "./vm-export.mjs";
import { createVmMediaService } from "./vm-media.mjs";
import { createVmPlanner } from "./vm-plan.mjs";
import { createVmProtectionService } from "./vm-protection.mjs";
import { createVmRecoveryService } from "./vm-recovery.mjs";
import { createVmRetentionService } from "./vm-retention.mjs";
import { createVmRestoreDrillService } from "./vm-restore-drill.mjs";

const app = express();
const host = process.env.BOXPILOT_HOST ?? "127.0.0.1";
const port = Number.parseInt(process.env.BOXPILOT_PORT ?? "8787", 10);
const tlsDir = process.env.BOXPILOT_TLS_DIR ?? "/etc/boxpilot/tls";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(root, "dist");

// Services. Everything that mutates the host does so through registry operations
// executed by the root helper; the web process stays unprivileged.
const vmPlanner = createVmPlanner();
const audit = createAuditLog();
const state = createStateStore();
// The identity service is created below; the throttle asks it who the caller is, lazily, so the
// two can be wired without ordering them.
// notify is called only at sign-in time, long after the notifications service below is constructed.
const auth = createAuthService(state, { resolveClientAddress: (request) => identity.clientAddress(request), notify: (payload) => notifications.send(payload) });
const helper = createHelperClient({ timeoutMs: 180000 });
const maintenance = createMaintenanceService();
const libvirt = createHelperLibvirtService({ helper });
const libvirtFoundation = createLibvirtFoundationService({ store: state, helper });
const prerequisites = createPrerequisiteService({
  stateDirectory: process.env.BOXPILOT_STATE_DIRECTORY ?? path.dirname(state.databasePath),
  helper,
});
const network = createNetworkService({ store: state });
const githubProvenance = createGithubProvenanceService();
const releaseUpdates = createReleaseUpdateService();
const controllerProtection = createControllerProtectionService({ store: state, helper });
const controllerRetention = createControllerRetentionService({ store: state, helper });
const inventory = createInventoryService({ helper, maintenance });
const vmCreation = createVmCreationService({ store: state, planner: vmPlanner, libvirt });
const vmMedia = createVmMediaService({ store: state, helper });
const vmExports = createVmExportService({ store: state, libvirt, helper });
const vmProtection = createVmProtectionService({ store: state, helper });
const vmRecoveries = createVmRecoveryService({ store: state, helper });
const vmRetention = createVmRetentionService({ store: state, helper });
const vmRestoreDrills = createVmRestoreDrillService({ store: state, helper });
const recoveryKit = createRecoveryKitService({ store: state, prerequisites, helper, libvirt });
const actionCenter = createActionCenterService({ recoveryKit, inventory });
const supportBundle = createSupportBundleService({ inventory, prerequisites, actionCenter, audit, helper, store: state });
const catalogService = createCatalogService();
// Device globs in manifests are resolved by this process: the helper's sandbox has no real /dev.
const withResolvedDevices = createDeviceResolver({ catalog: catalogService });
const jobLogReader = createJobLogReader();
function pinnedBackupDestination() {
  const destination = state.getSetting("backupDestination", null);
  if (!destination) throw new Error("Save an off-box destination on the Backups page first");
  return { host: destination.host, port: destination.port ?? 22, user: destination.user, path: destination.path };
}
function pinnedCloudDestination() {
  const destination = state.getSetting("cloudDestination", null);
  if (!destination) throw new Error("Save a cloud destination on the Backups page first");
  return destination;
}
/** Note that the rules have moved on from the profile, so the page stops naming a stale one. */
function markProfileEdited(job) {
  const current = state.getSetting("firewallProfile", null);
  if (!current || current.editedAt) return;
  state.setSetting("firewallProfile", { ...current, editedAt: new Date().toISOString() }, { updatedBy: job.createdBy });
}

const jobs = createJobService(state, helper, {
  jobLog: jobLogReader,
  // Registry ops whose results become durable evidence rows.
  operationRecordHooks: {
    "controller.backup.create": (job, result) => {
      state.recordBackup({ id: result.backupId, applicationId: "boxpilot-controller", destination: result.destination ?? "local-managed", artifactPath: result.artifactPath, checksumSha256: result.checksumSha256, sizeBytes: result.sizeBytes, downtimeMs: result.downtimeMs ?? 0, restoreDrill: result.restoreDrill ?? {}, createdBy: job.createdBy });
    },
    // Every machine snapshot embeds a fresh verified controller backup; record it too.
    "host.snapshot.create": (job, result) => {
      const backup = result.controllerBackup;
      if (backup?.backupId) state.recordBackup({ id: backup.backupId, applicationId: "boxpilot-controller", destination: backup.destination ?? "local-managed", artifactPath: backup.artifactPath, checksumSha256: backup.checksumSha256, sizeBytes: backup.sizeBytes, downtimeMs: backup.downtimeMs ?? 0, restoreDrill: backup.restoreDrill ?? {}, createdBy: job.createdBy });
    },
    "controller.backup.protect": (job, result) => controllerProtection.recordOperation(job, result),
    "controller.backup.retention.apply": (job, result) => controllerRetention.recordOperation(job, result),
    "vm.export.create": (job, result) => vmExports.recordOperation(job, result),
    "vm.export.protect": (job, result) => vmProtection.recordOperation(job, result),
    "vm.backup.retention.apply": (job, result) => vmRetention.recordOperation(job, result),
    "vm.backup.restore-drill": (job, result) => vmRestoreDrills.recordOperation(job, result),
    "vm.recovery.create": (job, result) => vmRecoveries.recordOperation(job, result),
    // The drill's verdict outlives job pruning: per app, the latest proof (or leak) with when.
    "app.vpn.killswitch.drill": (job, result) => state.updateSetting("killSwitchDrills", {}, (entries) => ({ value: { ...(entries ?? {}), [result.id]: { held: result.held, leaked: result.leaked, downForMs: result.downForMs, exitAfter: result.exitAfter ?? null, at: new Date().toISOString(), by: job.createdBy } } }), job.createdBy),
    // Snapshot metadata (origin, size, time) lives here because lvs needs root; the Storage page merges it with lsblk.
    "storage.lvm.snapshot.create": (job, result) => state.updateSetting("lvmSnapshots", [], (entries) => ({ value: [...(entries ?? []).filter((entry) => entry.path !== result.path), { path: result.path, name: result.name, origin: result.origin, volumeGroup: result.volumeGroup, sizeGiB: result.sizeGiB, createdAt: result.createdAt, createdBy: job.createdBy, suffix: job.parameters?.suffix ?? null }] }), job.createdBy),
    // Read and write in one transaction rather than two statements that happen not to interleave.
    "storage.lvm.snapshot.delete": (job, result) => state.updateSetting("lvmSnapshots", [], (entries) => ({ value: (entries ?? []).filter((entry) => entry.path !== result.path) }), job.createdBy),
    "storage.lvm.snapshot.rollback": (job, result) => state.updateSetting("lvmSnapshots", [], (entries) => ({ value: (entries ?? []).filter((entry) => entry.path !== result.path) }), job.createdBy),
    // The Firewall page shows which profile is in force and when it was applied.
    "firewall.profile.apply": (job, result) => state.setSetting("firewallProfile", { id: result.profile, services: result.services ?? [], sshRateLimit: result.sshRateLimit ?? false, appliedAt: result.appliedAt, appliedBy: job.createdBy }, { updatedBy: job.createdBy }),
    // Editing rules by hand moves the box away from the profile, so the page stops claiming one is
    // in force rather than naming a profile whose rules are no longer what is loaded.
    "firewall.rule.set": (job) => markProfileEdited(job),
    "firewall.rule.delete": (job) => markProfileEdited(job),
    "backup.cloud.setup": (job, result) => state.setSetting("cloudDestination", result.destination, { updatedBy: job.createdBy }),
    "backup.cloud.sync": (job, result) => state.setSetting("cloudDestinationLastSync", { completedAt: result.completedAt, filesTransferred: result.filesTransferred, bytesTransferred: result.bytesTransferred, destination: result.destination, errors: result.errors ?? 0 }, { updatedBy: job.createdBy }),
    "backup.remote.sync": (job, result) => state.setSetting("backupDestinationLastSync", { completedAt: result.completedAt, filesTransferred: result.filesTransferred, bytesTransferred: result.bytesTransferred, destination: result.destination }, { updatedBy: job.createdBy }),
    // The VPN section reads this non-secret description; the profile's secrets stay in the root file.
    "vpn.profile.set": (job, result) => state.setSetting("vpnProfile", result, { updatedBy: job.createdBy }),
    "vpn.profile.clear": (job) => state.setSetting("vpnProfile", null, { updatedBy: job.createdBy }),
  },
  // Prepare hooks pin server-derived expectations into the staged parameters.
  operationPrepareHooks: {
    // Device globs (/dev/sd?, /dev/ttyUSB?) resolve here against the real /dev; the helper runs with PrivateDevices.
    "app.install": (parameters) => withResolvedDevices(parameters),
    "app.update": (parameters) => withResolvedDevices(parameters),
    "app.reconfigure": (parameters) => withResolvedDevices(parameters),
    "controller.backup.protect": (parameters) => controllerProtection.prepareOperation(parameters),
    "system.update": (parameters) => releaseUpdates.prepareOperation(parameters),
    // Dashboard links need the address the browser uses; fall back to the LAN address for scheduled runs.
    "homepage.sync": async (parameters) => ({ host: parameters.host ?? (await inventory.inspect().catch(() => null))?.network?.addresses?.find((entry) => /^\d+\.\d+\.\d+\.\d+$/.test(entry.address))?.address ?? "127.0.0.1" }),
    "controller.backup.retention.apply": () => controllerRetention.prepareOperation(),
    "vm.foundation.initialize": () => libvirtFoundation.prepareOperation(),
    "vm.media.import": (parameters) => vmMedia.prepareOperation(parameters),
    "vm.create": (parameters) => vmCreation.prepareOperation(parameters),
    "vm.export.create": (parameters) => vmExports.prepareOperation(parameters),
    "vm.export.protect": (parameters) => vmProtection.prepareOperation(parameters),
    "vm.backup.retention.apply": () => vmRetention.prepareOperation(),
    // The hook's own list goes last, so a browser cannot widen what may be forgotten.
    "vm.backup.snapshot.forget": (parameters) => ({ snapshotId: parameters?.snapshotId, ...vmRetention.prepareForget() }),
    "vm.backup.restore-drill": (parameters) => vmRestoreDrills.prepareOperation(parameters),
    "vm.recovery.create": (parameters) => vmRecoveries.prepareOperation(parameters),
    // The browser names nothing: the saved destination is pinned into the job.
    "backup.remote.test": () => pinnedBackupDestination(),
    "backup.remote.sync": () => pinnedBackupDestination(),
    "backup.cloud.test": () => pinnedCloudDestination(),
    "backup.cloud.sync": () => pinnedCloudDestination(),
  },
});
state.deleteExpiredSessions();
const interruptedJobs = state.recoverInterruptedJobs();
const scheduler = createSchedulerService({ store: state, jobs });
const notifications = createNotificationService({ store: state });
notifications.start();
// A flow failure that never produced a job has no failed-job push to carry the news; the flow
// sends its own. Failed step jobs stay covered by the ordinary failed-job notifications.
const { library: flowLibrary, problems: flowLibraryProblems } = await loadFlowLibrary().catch(() => ({ library: [], problems: [] }));
if (flowLibraryProblems.length) console.warn(`[boxpilot] flow library problems: ${flowLibraryProblems.map((problem) => `${problem.file}: ${problem.errors.join("; ")}`).join(" | ")}`);
const flows = createFlowService({ store: state, jobs, library: flowLibrary, notify: (message) => { notifications.send({ title: "Automation", message, priority: "high" }).catch(() => {}); } });
flows.start();
scheduler.start();
const setup = createSetupService({ helper, scheduler });
createUpdateNotifier({ releaseUpdates, notifications, store: state }).start();
createHealthAlerts({ inventory, notifications, store: state, resolveScheduleTitle: (operationId) => registry.get(operationId)?.title ?? operationId }).start();
// Reissue the LAN certificate before it expires, reusing its CA so trusted devices stay trusted (M18.2).
createTlsRenewal({ helper, store: state }).start();
// Sample free space daily so the disk-fill forecast (M23.1) has a trend to project.
createDiskSampler({ inventory, store: state }).start();
// Sample SMART numbers daily so a drive going bad is caught before it fails (M23.3).
createSmartSampler({ inventory, store: state }).start();

app.disable("x-powered-by");
app.use(express.json({ limit: "256kb", strict: true }));
app.use((request, response, next) => {
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "DENY");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  response.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; base-uri 'none'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; img-src 'self' data:; object-src 'none'; script-src 'self'; style-src 'self'",
  );
  if (request.path.startsWith("/api/")) response.setHeader("Cache-Control", "no-store");
  next();
});

app.get("/api/v1/health", (_request, response) => {
  response.json({
    status: "ok",
    product: "BoxPilot",
    version: productVersion,
    mode: "host-aware",
    safeMode: true,
    hostMutationsEnabled: true,
    mutationPolicy: "durable-approved-helper-only",
    ownerBootstrapRequired: state.ownerCount() === 0,
    timestamp: new Date().toISOString(),
  });
});

// The local CA's public certificate, so a device can install it and trust HTTPS on the LAN (M18.2).
// Public on purpose: a browser must fetch it before it can trust the sign-in page, and it is a
// public certificate, never a key. Only ever serves ca.crt from the TLS directory.
app.get("/ca.crt", async (_request, response) => {
  const caPath = path.join(tlsDir, "ca.crt");
  try {
    await stat(caPath);
  } catch {
    return response.status(404).type("text/plain").send("No BoxPilot certificate authority has been set up yet.");
  }
  response.setHeader("Content-Type", "application/x-x509-ca-cert");
  response.setHeader("Content-Disposition", 'attachment; filename="boxpilot-ca.crt"');
  response.setHeader("Cache-Control", "no-store");
  createReadStream(caPath).on("error", () => response.destroy()).pipe(response);
});

const identity = createIdentityService({ store: state });
const passkeys = createPasskeyService({ store: state });
const oidc = createOidcService({ store: state });
// The one token-gated door (ADR-002 addendum): fire a flow by webhook. Before the session wall
// on purpose; the token is the auth, a wrong one is indistinguishable from a missing flow, and
// nothing from the request reaches any step.
app.post("/api/v1/hooks/flows/:id/:token", (request, response) => {
  const outcome = flows.fireWebhook(request.params.id, request.params.token, { source: request.ip });
  if (outcome === "accepted") return response.status(202).json({ accepted: true });
  if (outcome === "rate-limited") return response.status(429).json({ error: "This flow's webhook is being fired too often; wait a minute" });
  return response.status(404).json({ error: "Not found" });
});

app.use("/api/v1", createIdentityRouter({ store: state, auth, identity }));
app.use("/api/v1", createPasskeyRouter({ store: state, auth, passkeys, identity }));
app.get("/api/v1/auth/status", auth.status);
app.post("/api/v1/auth/bootstrap", auth.bootstrap);
app.post("/api/v1/auth/login", auth.login);
app.post("/api/v1/auth/logout", auth.requireSession, auth.requireCsrf, auth.logout);
app.post("/api/v1/auth/elevate", auth.requireSession, auth.requireCsrf, auth.elevate);
app.delete("/api/v1/auth/elevate", auth.requireSession, auth.requireCsrf, auth.dropElevation);
app.post("/api/v1/auth/password", auth.requireSession, auth.requireCsrf, auth.changePassword);
app.get("/api/v1/auth/sessions", auth.requireSession, auth.listSessions);
app.delete("/api/v1/auth/sessions/:id", auth.requireSession, auth.requireCsrf, auth.revokeSession);
app.post("/api/v1/auth/sessions/revoke-others", auth.requireSession, auth.requireCsrf, auth.revokeOtherSessions);

app.use("/api/v1", auth.requireSession);
app.use("/api/v1", (request, response, next) => {
  if (["GET", "HEAD", "OPTIONS"].includes(request.method)) {
    next();
    return;
  }
  auth.requireCsrf(request, response, next);
});

// Roles (M5.4): viewers may only look (plus read-only operation runs); operators may not change
// settings or manage people; disabled accounts get nothing. High-risk staging/approval is
// enforced in jobs.mjs. Owners pass through.
app.use("/api/v1", (request, response, next) => {
  const role = request.boxpilotSession?.owner?.role ?? "owner";
  const reading = ["GET", "HEAD", "OPTIONS"].includes(request.method);
  const pathname = request.path.toLowerCase(); // Express routes case-insensitively, so the policy must too
  const readOnlyRun = /^\/operations\/[^/]+\/run$/.test(pathname);
  const selfService = pathname === "/auth/logout" || pathname === "/auth/elevate" || pathname === "/auth/password";
  if (role === "disabled") return response.status(403).json({ error: "This account is disabled", code: "forbidden" });
  if (role === "viewer" && !reading && !readOnlyRun && !selfService) return response.status(403).json({ error: "Viewers can look but not change anything", code: "forbidden" });
  if (role === "operator" && !reading && (pathname.startsWith("/settings") || pathname.startsWith("/people"))) return response.status(403).json({ error: "Only the owner can change settings or people", code: "forbidden" });
  return next();
});
app.use("/api/v1/people", auth.requireRole("owner"));
app.use("/api/v1", createPeopleRouter({ state, auth }));
app.use("/api/v1", createOperationsRouter({ state, helper, jobs, prerequisites, recoveryKit, actionCenter, auth }));
app.use("/api/v1", createJobsRouter({ state, jobs, scheduler, flows, jobLogReader, auth }));
app.use("/api/v1", createVirtualizationRouter({ libvirt, libvirtFoundation, vmPlanner, vmMedia, vmCreation, vmExports, vmProtection, vmRetention, vmRecoveries, audit }));
app.use("/api/v1", createSettingsRouter({ state, notifications, auth }));
app.use("/api/v1", createFirewallRouter({ state, helper, catalogService, webPort: port, webHost: host }));
app.use("/api/v1", createStorageRouter({ auth, helper, inventory, state }));
app.use("/api/v1", createPowerRouter());
app.use("/api/v1", createChecklistRouter({ state, helper, notifications, inventory, network }));
app.use("/api/v1", createHostRouter({ state, helper, catalogService, inventory, network, controllerProtection, controllerRetention, githubProvenance, releaseUpdates, setup, supportBundle, audit, auth, identity, webHost: host, webPort: port }));
app.use("/api/v1", createOidcAdminRouter({ oidc, auth }));

// OIDC provider endpoints (M19.3) live at the site root, not under /api/v1: discovery, JWKS, token
// and userinfo are public by design, and /oidc/authorize reads the owner's session itself.
app.use(createOidcRouter({ oidc, auth, store: state }));

app.use("/assets", express.static(path.join(dist, "assets"), { index: false, maxAge: "365d", immutable: true }));
app.use(express.static(dist, { index: false }));
app.use((request, response, next) => {
  if (request.method !== "GET" || request.path.startsWith("/api/")) {
    next();
    return;
  }

  response.sendFile(path.join(dist, "index.html"));
});

app.use((_request, response) => {
  response.status(404).json({ error: "Not found" });
});

// Anything that throws past a route lands here. Without this Express answers with an HTML page,
// which reaches the browser as "Unexpected token '<'" instead of something the page can show.
app.use((error, request, response, _next) => {
  if (response.headersSent) { response.destroy(); return; }
  // Body-parser failures are the caller's mistake, not a fault in BoxPilot: answer as such.
  const status = Number.isInteger(error?.status) ? error.status : Number.isInteger(error?.statusCode) ? error.statusCode : 500;
  if (status >= 400 && status < 500) {
    response.status(status).json({ error: error.type === "entity.too.large" ? "That request was too large." : "That request could not be read.", code: error.type === "entity.too.large" ? "request_too_large" : "invalid_request" });
    return;
  }
  const reference = randomUUID().slice(0, 8);
  console.error(`Unhandled error ${reference} on ${request.method} ${request.path}: ${error?.stack ?? error}`);
  response.status(500).json({ error: `Something went wrong in BoxPilot (reference ${reference}). The Logs page has the details.`, code: "internal_error", reference });
});

// Keep history bounded: finished jobs older than 90 days beyond the newest 500, audit beyond the newest 20,000 rows.
const pruneHistory = () => { try { state.pruneHistory(); } catch (error) { console.warn(`History pruning failed: ${error.message}`); } };
setTimeout(pruneHistory, 2 * 60_000).unref?.();
setInterval(pruneHistory, 24 * 3600_000).unref?.();

app.listen(port, host, () => {
  console.log(`BoxPilot ${productVersion} listening on http://${host}:${port}`);
  if (interruptedJobs) console.warn(`${interruptedJobs} interrupted job(s) marked failed for operator review.`);
});

// The encrypted LAN listener (M18.2), if a certificate has been provisioned. Never fatal: the HTTP
// listener and the Tailscale Serve path above keep working regardless.
startTlsListener(app, { host });
