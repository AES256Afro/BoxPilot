import express from "express";
import { randomUUID } from "node:crypto";
import { createDeviceResolver } from "./catalog/devices.mjs";
import path from "node:path";
import { fileURLToPath } from "node:url";
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
import { createIdentityRouter } from "./routes/identity.mjs";
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
import { createNotificationService } from "./notifications.mjs";
import { createSchedulerService } from "./scheduler.mjs";
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
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(root, "dist");

// Services. Everything that mutates the host does so through registry operations
// executed by the root helper; the web process stays unprivileged.
const vmPlanner = createVmPlanner();
const audit = createAuditLog();
const state = createStateStore();
// The identity service is created below; the throttle asks it who the caller is, lazily, so the
// two can be wired without ordering them.
const auth = createAuthService(state, { resolveClientAddress: (request) => identity.clientAddress(request) });
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
const supportBundle = createSupportBundleService({ inventory, prerequisites, actionCenter, audit, helper });
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
    // Snapshot metadata (origin, size, time) lives here because lvs needs root; the Storage page merges it with lsblk.
    "storage.lvm.snapshot.create": (job, result) => state.setSetting("lvmSnapshots", [...(state.getSetting("lvmSnapshots", []) ?? []).filter((entry) => entry.path !== result.path), { path: result.path, name: result.name, origin: result.origin, volumeGroup: result.volumeGroup, sizeGiB: result.sizeGiB, createdAt: result.createdAt, createdBy: job.createdBy, suffix: job.parameters?.suffix ?? null }], { updatedBy: job.createdBy }),
    "storage.lvm.snapshot.delete": (job, result) => state.setSetting("lvmSnapshots", (state.getSetting("lvmSnapshots", []) ?? []).filter((entry) => entry.path !== result.path), { updatedBy: job.createdBy }),
    "storage.lvm.snapshot.rollback": (job, result) => state.setSetting("lvmSnapshots", (state.getSetting("lvmSnapshots", []) ?? []).filter((entry) => entry.path !== result.path), { updatedBy: job.createdBy }),
    // The Firewall page shows which profile is in force and when it was applied.
    "firewall.profile.apply": (job, result) => state.setSetting("firewallProfile", { id: result.profile, services: result.services ?? [], sshRateLimit: result.sshRateLimit ?? false, appliedAt: result.appliedAt, appliedBy: job.createdBy }, { updatedBy: job.createdBy }),
    // Editing rules by hand moves the box away from the profile, so the page stops claiming one is
    // in force rather than naming a profile whose rules are no longer what is loaded.
    "firewall.rule.set": (job) => markProfileEdited(job),
    "firewall.rule.delete": (job) => markProfileEdited(job),
    "backup.cloud.setup": (job, result) => state.setSetting("cloudDestination", result.destination, { updatedBy: job.createdBy }),
    "backup.cloud.sync": (job, result) => state.setSetting("cloudDestinationLastSync", { completedAt: result.completedAt, filesTransferred: result.filesTransferred, bytesTransferred: result.bytesTransferred, destination: result.destination, errors: result.errors ?? 0 }, { updatedBy: job.createdBy }),
    "backup.remote.sync": (job, result) => state.setSetting("backupDestinationLastSync", { completedAt: result.completedAt, filesTransferred: result.filesTransferred, bytesTransferred: result.bytesTransferred, destination: result.destination }, { updatedBy: job.createdBy }),
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
    "vm.backup.snapshot.forget": () => vmRetention.prepareForget(),
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
scheduler.start();
const setup = createSetupService({ helper, scheduler });
const notifications = createNotificationService({ store: state });
notifications.start();
createUpdateNotifier({ releaseUpdates, notifications, store: state }).start();
createHealthAlerts({ inventory, notifications, store: state }).start();

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

const identity = createIdentityService({ store: state });
app.use("/api/v1", createIdentityRouter({ store: state, auth, identity }));
app.get("/api/v1/auth/status", auth.status);
app.post("/api/v1/auth/bootstrap", auth.bootstrap);
app.post("/api/v1/auth/login", auth.login);
app.post("/api/v1/auth/logout", auth.requireSession, auth.requireCsrf, auth.logout);
app.post("/api/v1/auth/elevate", auth.requireSession, auth.requireCsrf, auth.elevate);
app.delete("/api/v1/auth/elevate", auth.requireSession, auth.requireCsrf, auth.dropElevation);
app.post("/api/v1/auth/password", auth.requireSession, auth.requireCsrf, auth.changePassword);

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
app.use("/api/v1", createJobsRouter({ state, jobs, scheduler, jobLogReader, auth }));
app.use("/api/v1", createVirtualizationRouter({ libvirt, libvirtFoundation, vmPlanner, vmMedia, vmCreation, vmExports, vmProtection, vmRetention, vmRecoveries, audit }));
app.use("/api/v1", createSettingsRouter({ state, notifications, auth }));
app.use("/api/v1", createFirewallRouter({ state, helper, catalogService, webPort: port, webHost: host }));
app.use("/api/v1", createStorageRouter({ auth, helper, inventory, state }));
app.use("/api/v1", createPowerRouter());
app.use("/api/v1", createChecklistRouter({ state, helper, notifications, inventory, network }));
app.use("/api/v1", createHostRouter({ state, helper, catalogService, inventory, network, controllerProtection, controllerRetention, githubProvenance, releaseUpdates, setup, supportBundle, audit, auth }));

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
