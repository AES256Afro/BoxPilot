import express from "express";
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
const auth = createAuthService(state);
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
const jobLogReader = createJobLogReader();
function pinnedBackupDestination() {
  const destination = state.getSetting("backupDestination", null);
  if (!destination) throw new Error("Save an off-box destination on the Backups page first");
  return { host: destination.host, port: destination.port ?? 22, user: destination.user, path: destination.path };
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
    "backup.remote.sync": (job, result) => state.setSetting("backupDestinationLastSync", { completedAt: result.completedAt, filesTransferred: result.filesTransferred, bytesTransferred: result.bytesTransferred, destination: result.destination }, { updatedBy: job.createdBy }),
  },
  // Prepare hooks pin server-derived expectations into the staged parameters.
  operationPrepareHooks: {
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
    "vm.backup.restore-drill": (parameters) => vmRestoreDrills.prepareOperation(parameters),
    "vm.recovery.create": (parameters) => vmRecoveries.prepareOperation(parameters),
    // The browser names nothing: the saved destination is pinned into the job.
    "backup.remote.test": () => pinnedBackupDestination(),
    "backup.remote.sync": () => pinnedBackupDestination(),
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
  const readOnlyRun = /^\/operations\/[^/]+\/run$/.test(request.path);
  const selfService = request.path === "/auth/logout" || request.path === "/auth/elevate";
  if (role === "disabled") return response.status(403).json({ error: "This account is disabled", code: "forbidden" });
  if (role === "viewer" && !reading && !readOnlyRun && !selfService) return response.status(403).json({ error: "Viewers can look but not change anything", code: "forbidden" });
  if (role === "operator" && !reading && (request.path.startsWith("/settings") || request.path.startsWith("/people"))) return response.status(403).json({ error: "Only the owner can change settings or people", code: "forbidden" });
  return next();
});
app.use("/api/v1/people", auth.requireRole("owner"));
app.use("/api/v1", createPeopleRouter({ state, auth }));
app.use("/api/v1", createOperationsRouter({ state, helper, jobs, prerequisites, recoveryKit, actionCenter, auth }));
app.use("/api/v1", createJobsRouter({ state, jobs, scheduler, jobLogReader, auth }));
app.use("/api/v1", createVirtualizationRouter({ libvirt, libvirtFoundation, vmPlanner, vmMedia, vmCreation, vmExports, vmProtection, vmRetention, vmRecoveries, audit }));
app.use("/api/v1", createSettingsRouter({ state, notifications, auth }));
app.use("/api/v1", createHostRouter({ state, helper, catalogService, inventory, network, controllerProtection, controllerRetention, githubProvenance, releaseUpdates, setup, supportBundle, audit, auth }));

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

app.listen(port, host, () => {
  console.log(`BoxPilot ${productVersion} listening on http://${host}:${port}`);
  if (interruptedJobs) console.warn(`${interruptedJobs} interrupted job(s) marked failed for operator review.`);
  console.log("Safe mode: host mutations require durable plans, password approval, and typed helper operations.");
});
