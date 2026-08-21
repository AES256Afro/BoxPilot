import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { productVersion } from "./version.mjs";
import { registry, riskTiers } from "./ops/index.mjs";
import { approvalModes, defaultApprovalMode, elevationTtlMs, normalizeApprovalMode } from "./ops/risk.mjs";
import { createCatalogService } from "./catalog/index.mjs";
import { createJobLogReader } from "./job-log.mjs";
import { findPortConflicts, listListeners } from "./ports.mjs";
import { resolveValues } from "./catalog/schema.mjs";
import { createActionCenterService } from "./action-center.mjs";
import { createAuditLog } from "./audit.mjs";
import { createControllerProtectionService } from "./controller-protection.mjs";
import { createControllerRetentionService } from "./controller-retention.mjs";
import { createGithubProvenanceService } from "./github-provenance.mjs";
import { createAuthService, verifyPassword } from "./security.mjs";
import { createIdentityService } from "./identity.mjs";
import { createIdentityRouter } from "./routes/identity.mjs";
import { createHelperClient } from "./helper-client.mjs";
import { buildConsoleGuidanceResponse, createHelperLibvirtService } from "./helper-libvirt.mjs";
import { createInventoryService } from "./inventory.mjs";
import { createJobService } from "./jobs.mjs";
import { getSetupPlan } from "./libvirt.mjs";
import { createLibvirtFoundationService } from "./libvirt-foundation.mjs";
import { createMaintenanceService } from "./maintenance.mjs";
import { createNetworkService } from "./network.mjs";
import { createPrerequisiteService } from "./prerequisites.mjs";
import { createRecoveryKitService } from "./recovery-kit.mjs";
import { createNotificationService } from "./notifications.mjs";
import { createSchedulerService } from "./scheduler.mjs";
import { createStateStore } from "./state.mjs";
import { createSupportBundleService } from "./support-bundle.mjs";
import { createVmCreationService } from "./vm-creation.mjs";
import { createVmExportService } from "./vm-export.mjs";
import { createVmMediaService } from "./vm-media.mjs";
import { createVmPlanner, validateVmPlanInput } from "./vm-plan.mjs";
import { createVmProtectionService } from "./vm-protection.mjs";
import { createVmRecoveryService } from "./vm-recovery.mjs";
import { createVmRetentionService } from "./vm-retention.mjs";
import { createVmRestoreDrillService } from "./vm-restore-drill.mjs";

const app = express();
const host = process.env.BOXPILOT_HOST ?? "127.0.0.1";
const port = Number.parseInt(process.env.BOXPILOT_PORT ?? "8787", 10);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(root, "dist");
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
const controllerProtection = createControllerProtectionService({ store: state, helper });
const controllerRetention = createControllerRetentionService({ store: state, helper });
const inventory = createInventoryService({ helper, maintenance });
const vmCreation = createVmCreationService({ store: state, planner: vmPlanner, libvirt });
const vmMedia = createVmMediaService({ store: state, helper });
const vmExports = createVmExportService({ store: state, libvirt, helper });
const vmProtection = createVmProtectionService({ store: state, helper });
const vmRecoveries = createVmRecoveryService({ store: state, helper });
const vmRetention = createVmRetentionService({ store: state, helper });
// The legacy application adapters are retired; the kit's application section reads empty until it is rebuilt around the catalog.
const legacyApplications = { list: async () => ({ applications: [] }) };
const recoveryKit = createRecoveryKitService({ store: state, prerequisites, applications: legacyApplications, libvirt });
const actionCenter = createActionCenterService({ recoveryKit, inventory });
const supportBundle = createSupportBundleService({ inventory, prerequisites, actionCenter, audit, helper });
const vmRestoreDrills = createVmRestoreDrillService({ store: state, helper });
const jobLogReader = createJobLogReader();
const jobs = createJobService(state, helper, {
  jobLog: jobLogReader,
  // Registry ops whose results become durable evidence rows.
  operationRecordHooks: {
    "controller.backup.create": (job, result) => {
      state.recordBackup({ id: result.backupId, applicationId: "boxpilot-controller", destination: result.destination ?? "local-managed", artifactPath: result.artifactPath, checksumSha256: result.checksumSha256, sizeBytes: result.sizeBytes, downtimeMs: result.downtimeMs ?? 0, restoreDrill: result.restoreDrill ?? {}, createdBy: job.createdBy });
    },
    "controller.backup.protect": (job, result) => controllerProtection.recordOperation(job, result),
    "controller.backup.retention.apply": (job, result) => controllerRetention.recordOperation(job, result),
    "vm.export.create": (job, result) => vmExports.recordOperation(job, result),
    "vm.export.protect": (job, result) => vmProtection.recordOperation(job, result),
    "vm.backup.retention.apply": (job, result) => vmRetention.recordOperation(job, result),
    "vm.backup.restore-drill": (job, result) => vmRestoreDrills.recordOperation(job, result),
    "vm.recovery.create": (job, result) => vmRecoveries.recordOperation(job, result),
  },
  // Prepare hooks pin server-derived expectations into the staged parameters.
  operationPrepareHooks: {
    "controller.backup.protect": (parameters) => controllerProtection.prepareOperation(parameters),
    "controller.backup.retention.apply": () => controllerRetention.prepareOperation(),
    "vm.foundation.initialize": () => libvirtFoundation.prepareOperation(),
    "vm.media.import": (parameters) => vmMedia.prepareOperation(parameters),
    "vm.create": (parameters) => vmCreation.prepareOperation(parameters),
    "vm.export.create": (parameters) => vmExports.prepareOperation(parameters),
    "vm.export.protect": (parameters) => vmProtection.prepareOperation(parameters),
    "vm.backup.retention.apply": () => vmRetention.prepareOperation(),
    "vm.backup.restore-drill": (parameters) => vmRestoreDrills.prepareOperation(parameters),
    "vm.recovery.create": (parameters) => vmRecoveries.prepareOperation(parameters),
  },
});
state.deleteExpiredSessions();
const interruptedJobs = state.recoverInterruptedJobs();
const scheduler = createSchedulerService({ store: state, jobs });
scheduler.start();
const notifications = createNotificationService({ store: state });
notifications.start();

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

app.get("/api/v1/operations", (_request, response) => {
  response.json({ operations: registry.describe(), riskTiers });
});

// Read-only registered operations run immediately (no job, no approval); parameter-free only for now.
app.get("/api/v1/operations/:id/inspect", async (request, response) => {
  const operation = registry.get(request.params.id);
  if (!operation) return response.status(404).json({ error: "Operation not found", code: "operation_not_found" });
  if (!operation.readOnly) return response.status(405).json({ error: "This operation changes the host; stage it as a job", code: "operation_not_read_only" });
  try {
    return response.json({ operation: operation.id, result: await helper.request(operation.id, {}, { timeoutMs: operation.timeoutMs }) });
  } catch (error) {
    return response.status(503).json({ error: error.message, code: "operation_failed" });
  }
});

// Read-only registered operations that take parameters (e.g. logs) run immediately via POST.
app.post("/api/v1/operations/:id/run", auth.requireCsrf, async (request, response) => {
  const operation = registry.get(request.params.id);
  if (!operation) return response.status(404).json({ error: "Operation not found", code: "operation_not_found" });
  if (!operation.readOnly) return response.status(405).json({ error: "This operation changes the host; stage it as a job", code: "operation_not_read_only" });
  const parameters = request.body?.parameters ?? {};
  const problem = registry.validate(operation.id, parameters);
  if (problem) return response.status(400).json({ error: problem, code: "invalid_parameters" });
  if (operation.elevatedOnly) {
    const elevatedUntil = request.boxpilotSession.elevatedUntil ? Date.parse(request.boxpilotSession.elevatedUntil) : Number.NaN;
    if (!(Number.isFinite(elevatedUntil) && elevatedUntil > Date.now())) return response.status(401).json({ error: "Enter your password to unlock this for 10 minutes", code: "elevation_required" });
    state.recordAudit("operation.elevated-read", { actorId: request.boxpilotSession.owner.id, subjectId: operation.id, details: { parameters } });
  }
  try {
    return response.json({ operation: operation.id, result: await helper.request(operation.id, parameters, { timeoutMs: operation.timeoutMs }) });
  } catch (error) {
    return response.status(503).json({ error: error.message, code: "operation_failed" });
  }
});

// Catalog: manifests come from the working tree; live state comes from the helper (tolerated when unavailable).
const catalogService = createCatalogService();
app.get("/api/v1/catalog", async (_request, response) => {
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

// Fetch a GitHub user's public SSH keys (server-side because github.com has no CORS for browsers).
app.get("/api/v1/ssh-keys/github/:user", async (request, response) => {
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

// Precheck an install/reconfigure: validates values against the manifest and reports host port conflicts.
app.post("/api/v1/catalog/:id/precheck", auth.requireCsrf, async (request, response) => {
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

// Mutating registered operations are staged as jobs and approved through /api/v1/jobs/:id/approve (risk-tiered).
app.post("/api/v1/operations/:id/jobs", auth.requireCsrf, async (request, response) => {
  try {
    const job = await jobs.createOperationJob(request.params.id, request.body?.parameters ?? {}, request.boxpilotSession.owner.id);
    return response.status(201).json({ job, approval: jobs.describeApproval(job.id, request.boxpilotSession) });
  } catch (error) {
    const status = error.message === "Operation not found" ? 404 : error.message.includes("Read-only") ? 405 : 400;
    return response.status(status).json({ error: error.message, code: "operation_job_rejected" });
  }
});

// Capability matrix: booleans, enums, and counts derived from the operation registry (M1.6).
app.get("/api/v1/capabilities", async (_request, response) => {
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

app.get("/api/v1/integrations/github", async (_request, response) => {
  response.json(await githubProvenance.inspect());
});

app.get("/api/v1/operations/prerequisites", async (_request, response) => {
  response.json(await prerequisites.inspect());
});

app.get("/api/v1/operations/recovery-kit", async (_request, response) => {
  try {
    response.json(await recoveryKit.inspect());
  } catch {
    response.status(503).json({ error: "Recovery evidence is temporarily unavailable", code: "recovery_kit_unavailable" });
  }
});

app.get("/api/v1/operations/action-center", async (_request, response) => {
  response.json(await actionCenter.inspect());
});

app.get("/api/v1/support-bundle", async (_request, response) => {
  response.json(await supportBundle.inspect());
});

app.get("/api/v1/inventory", async (_request, response) => {
  response.json(await inventory.inspect());
});

app.get("/api/v1/network/topology", async (_request, response) => {
  response.json(await network.inspect());
});

app.post("/api/v1/network/plans", async (request, response) => {
  try {
    const plan = await network.plan(request.body, request.boxpilotSession.owner.id);
    response.status(201).json({ plan });
  } catch (error) {
    response.status(400).json({ error: error.message, code: "network_plan_failed" });
  }
});

app.get("/api/v1/logs", async (request, response) => {
  const source = String(request.query.source ?? "boxpilot");
  const limit = Number.parseInt(String(request.query.limit ?? "100"), 10);
  if (!["boxpilot", "docker", "tailscale", "virtualization"].includes(source) || !Number.isInteger(limit) || limit < 1 || limit > 200) {
    response.status(400).json({ error: "Choose a supported log source and a limit from 1 to 200", code: "invalid_log_query" });
    return;
  }
  try {
    response.json(await helper.request("system.logs.inspect", { source, limit }));
  } catch {
    response.status(503).json({ error: "The selected redacted log source is unavailable", code: "logs_unavailable" });
  }
});

app.get("/api/v1/backups", (_request, response) => {
  response.json({ backups: state.listBackups(50) });
});

app.get("/api/v1/controller-backup-protection", async (_request, response) => {
  response.json(await controllerProtection.list());
});

app.get("/api/v1/controller-backup-retention", async (_request, response) => {
  try {
    response.json(await controllerRetention.inspect());
  } catch (error) {
    response.status(503).json({ error: error.message, code: "controller_retention_inspection_failed" });
  }
});

app.get("/api/v1/jobs", (request, response) => {
  response.json({ jobs: state.listJobs(request.query.limit) });
});

// Scheduled operations (M6.1): low/medium registered ops on an hourly/daily/weekly cadence,
// approved automatically as the schedule's creator. High-risk ops cannot be scheduled.
app.get("/api/v1/schedules", (_request, response) => {
  response.json({ schedules: scheduler.list() });
});

app.post("/api/v1/schedules", auth.requireCsrf, (request, response) => {
  try {
    const { operationId, parameters, frequency, minute, hour, weekday } = request.body ?? {};
    const schedule = scheduler.create({ operationId, parameters: parameters ?? {}, frequency, minute, hour: hour ?? null, weekday: weekday ?? null, createdBy: request.boxpilotSession.owner.id });
    response.status(201).json({ schedule });
  } catch (error) {
    response.status(400).json({ error: error.message, code: "schedule_rejected" });
  }
});

app.put("/api/v1/schedules/:id", auth.requireCsrf, (request, response) => {
  try {
    response.json({ schedule: scheduler.setEnabled(request.params.id, Boolean(request.body?.enabled), request.boxpilotSession.owner.id) });
  } catch (error) {
    response.status(error.message.includes("not found") ? 404 : 400).json({ error: error.message, code: "schedule_update_failed" });
  }
});

app.delete("/api/v1/schedules/:id", auth.requireCsrf, (request, response) => {
  try {
    scheduler.remove(request.params.id, request.boxpilotSession.owner.id);
    response.json({ ok: true });
  } catch (error) {
    response.status(error.message.includes("not found") ? 404 : 400).json({ error: error.message, code: "schedule_delete_failed" });
  }
});

// Server-sent events for the Activity drawer: recent jobs on connect, then a snapshot of each
// job as it is created, approved, stepped, or finished. Output text stays on /jobs/:id/stream.
app.get("/api/v1/events", (request, response) => {
  response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive", "X-Accel-Buffering": "no" });
  const send = (event, data) => response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  send("snapshot", { jobs: state.listJobs(30) });
  const unsubscribe = state.subscribeJobs((job) => send("job", { job }));
  const heartbeat = setInterval(() => response.write(": ping\n\n"), 25_000);
  request.on("close", () => { clearInterval(heartbeat); unsubscribe(); });
});

// Job output: persisted once the job is finished, otherwise the live file being written by the helper/runner.
app.get("/api/v1/jobs/:id/output", async (request, response) => {
  const job = state.getJob(request.params.id);
  if (!job || job.createdBy !== request.boxpilotSession.owner.id) return response.status(404).json({ error: "Job not found", code: "job_not_found" });
  const persisted = state.getJobOutput(job.id);
  if (persisted !== null) return response.json({ jobId: job.id, state: job.state, output: persisted, live: false });
  const live = await jobLogReader.read(job.id, 0).catch(() => ({ text: "", exists: false }));
  return response.json({ jobId: job.id, state: job.state, output: live.text, live: true });
});

// Server-sent events: streams new output as it is written, then a final `state` event when the job finishes.
app.get("/api/v1/jobs/:id/stream", async (request, response) => {
  const initial = state.getJob(request.params.id);
  if (!initial || initial.createdBy !== request.boxpilotSession.owner.id) return response.status(404).json({ error: "Job not found", code: "job_not_found" });
  response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive", "X-Accel-Buffering": "no" });
  response.write(": connected\n\n");
  let offset = 0; let closed = false;
  request.on("close", () => { closed = true; });
  const send = (event, data) => { if (!closed) response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); };
  const persisted = state.getJobOutput(initial.id);
  if (persisted !== null) { send("output", { text: persisted }); send("state", { state: initial.state, error: initial.error }); response.end(); return; }
  const started = Date.now();
  while (!closed && Date.now() - started < 3 * 60 * 60 * 1000) {
    const chunk = await jobLogReader.read(initial.id, offset).catch(() => ({ text: "", offset, exists: false }));
    if (chunk.text) { send("output", { text: chunk.text }); offset = chunk.offset; }
    const current = state.getJob(initial.id);
    if (!current || ["completed", "failed"].includes(current.state)) {
      const final = state.getJobOutput(initial.id);
      if (final !== null && final.length > offset) send("output", { text: final.slice(offset) });
      send("state", { state: current?.state ?? "unknown", error: current?.error ?? null });
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 700));
  }
  if (!closed) response.end();
  return undefined;
});

app.get("/api/v1/jobs/:id", (request, response) => {
  const job = state.getJob(request.params.id);
  if (!job || job.createdBy !== request.boxpilotSession.owner.id) return response.status(404).json({ error: "Job not found", code: "job_not_found" });
  return response.json({ job });
});

app.post("/api/v1/jobs/:id/approve", auth.requireCsrf, async (request, response) => {
  try {
    const candidate = state.getJob(request.params.id);
    const background = ["virtualization.foundation.initialize", "controller.database.backup", "controller.database.backup.protect", "controller.database.backup.retention.apply", "virtualization.domain.export.create", "virtualization.export.backup.create", "virtualization.export.backup.retention.apply", "virtualization.export.backup.restore-drill", "virtualization.backup.recovery.create"].includes(candidate?.type) || (typeof candidate?.type === "string" && candidate.type.startsWith("op:"));
    const approval = { password: typeof request.body?.password === "string" ? request.body.password : null, session: request.boxpilotSession };
    const job = background
      ? await jobs.approveAndStart(request.params.id, request.boxpilotSession.owner.id, approval)
      : await jobs.approveAndRun(request.params.id, request.boxpilotSession.owner.id, approval);
    const session = auth.requestSession(request);
    response.status(background ? 202 : 200).json({ job, elevatedUntil: session?.elevatedUntil ?? null });
  } catch (error) {
    const status = error.message === "Job not found" ? 404 : error.message.includes("reauthentication") ? 401 : 409;
    response.status(status).json({ error: error.message, code: "job_approval_failed" });
  }
});

app.get("/api/v1/jobs/:id/approval", (request, response) => {
  const policy = jobs.describeApproval(request.params.id, request.boxpilotSession);
  if (!policy) return response.status(404).json({ error: "Job not found", code: "job_not_found" });
  return response.json({ jobId: request.params.id, ...policy });
});

// Failed-job push notifications (M8.4): where alerts go. Changing it needs the owner password.
app.get("/api/v1/settings/notifications", (_request, response) => {
  response.json(notifications.describe());
});

app.put("/api/v1/settings/notifications", auth.requireCsrf, async (request, response) => {
  const owner = state.findOwnerById(request.boxpilotSession.owner.id);
  if (!owner || typeof request.body?.password !== "string" || !(await verifyPassword(request.body.password, owner.passwordHash))) {
    return response.status(401).json({ error: "Owner password required to change the notification target", code: "reauthentication_required" });
  }
  try {
    notifications.setTarget(request.body?.target ?? null, { updatedBy: owner.id });
    return response.json(notifications.describe());
  } catch (error) {
    return response.status(400).json({ error: error.message, code: "invalid_setting" });
  }
});

app.post("/api/v1/settings/notifications/test", auth.requireCsrf, async (_request, response) => {
  try {
    response.json(await notifications.send({ title: "BoxPilot test notification", message: "Notifications are working. Failed jobs will arrive like this." }));
  } catch (error) {
    response.status(502).json({ error: error.message, code: "notification_test_failed" });
  }
});

app.get("/api/v1/settings/approval-mode", (_request, response) => {
  response.json({ approvalMode: normalizeApprovalMode(state.getSetting("approvalMode", null) ?? process.env.BOXPILOT_APPROVAL_MODE ?? defaultApprovalMode), modes: approvalModes, elevationTtlMs });
});

app.put("/api/v1/settings/approval-mode", auth.requireCsrf, async (request, response) => {
  const mode = request.body?.approvalMode;
  if (!approvalModes.includes(mode)) return response.status(400).json({ error: `approvalMode must be one of ${approvalModes.join(", ")}`, code: "invalid_setting" });
  const owner = state.findOwnerById(request.boxpilotSession.owner.id);
  if (!owner || typeof request.body?.password !== "string" || !(await verifyPassword(request.body.password, owner.passwordHash))) {
    return response.status(401).json({ error: "Owner password required to change the approval mode", code: "reauthentication_required" });
  }
  state.setSetting("approvalMode", mode, { updatedBy: owner.id });
  state.recordAudit("settings.approval-mode.changed", { actorId: owner.id, subjectId: owner.id, details: { approvalMode: mode } });
  return response.json({ approvalMode: mode, modes: approvalModes, elevationTtlMs });
});

app.get("/api/v1/virtualization/status", async (_request, response) => {
  response.json({
    ...(await libvirt.getStatus()),
    actions: { enabled: true, reason: "Lifecycle actions use immutable plans, password approval, and the restricted helper" },
  });
});

app.get("/api/v1/virtualization/domains", async (_request, response) => {
  const result = await libvirt.listDomains();
  response.status(result.connected ? 200 : 503).json(result);
});

app.get("/api/v1/virtualization/setup-plan", (_request, response) => {
  response.json(getSetupPlan());
});

app.get("/api/v1/virtualization/resources", async (_request, response) => {
  const resources = await libvirt.listResources();
  response.status(resources.connected ? 200 : 503).json(resources);
});

app.get("/api/v1/virtualization/foundation", async (_request, response) => {
  const foundation = await libvirtFoundation.inspect();
  response.status(foundation.connectionReady ? 200 : 503).json(foundation);
});

app.get("/api/v1/virtualization/console-guidance", async (_request, response) => {
  response.json(buildConsoleGuidanceResponse(await libvirt.getConsoleGuidance()));
});

app.get("/api/v1/virtualization/planning-options", async (_request, response) => {
  response.json(await vmPlanner.getOptions());
});

app.get("/api/v1/virtualization/media", async (_request, response) => {
  try {
    response.json(await vmMedia.inspect());
  } catch (error) {
    response.status(503).json({ error: error.message, code: "vm_media_inspection_failed" });
  }
});

app.post("/api/v1/virtualization/media/uploads", async (request, response) => {
  try {
    request.setTimeout(12 * 60 * 60 * 1000);
    response.status(201).json({ upload: await vmMedia.upload(request) });
  } catch (error) {
    const status = error.message.includes("already exists") ? 409 : error.message.includes("space") ? 507 : 400;
    response.status(status).json({ error: error.message, code: "vm_media_upload_failed" });
  }
});

app.get("/api/v1/audit", async (request, response) => {
  const result = await audit.list(request.query.limit);
  response.status(result.available ? 200 : 503).json(result);
});

app.post("/api/v1/virtualization/plans", async (request, response) => {
  const inputErrors = validateVmPlanInput(request.body);
  if (inputErrors.length) {
    response.status(400).json({ ok: false, errors: inputErrors });
    return;
  }
  let result;
  try {
    result = await vmCreation.preview(request.body);
  } catch (error) {
    response.status(503).json({ ok: false, errors: [error.message] });
    return;
  }
  if (result.ok) {
    try {
      await audit.record("vm.plan.created", {
        domain: result.plan.input.name,
        revision: result.plan.revision,
        osProfile: result.plan.input.osProfile,
        vcpus: result.plan.input.vcpus,
        memoryMiB: result.plan.input.memoryMiB,
        diskGiB: result.plan.input.diskGiB,
        media: result.plan.media.name,
        warningCount: result.plan.warnings.length,
      });
    } catch {
      console.warn(JSON.stringify({ timestamp: new Date().toISOString(), event: "audit_write", result: "failed", type: "vm.plan.created" }));
    }
  }
  response.status(result.ok ? 200 : 400).json(result);
});

app.get("/api/v1/virtualization/exports", (_request, response) => {
  response.json(vmExports.list());
});

app.get("/api/v1/virtualization/protection", async (_request, response) => {
  response.json(await vmProtection.list());
});

app.get("/api/v1/virtualization/retention", async (_request, response) => {
  try {
    response.json(await vmRetention.inspect());
  } catch (error) {
    response.status(503).json({ error: error.message, code: "vm_retention_inspection_failed" });
  }
});

app.get("/api/v1/virtualization/recoveries", (_request, response) => {
  response.json({ recoveries: vmRecoveries.list() });
});

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
