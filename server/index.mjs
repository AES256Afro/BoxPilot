import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createAuditLog } from "./audit.mjs";
import { createApplicationService } from "./applications.mjs";
import { createBackupService } from "./backups.mjs";
import { createAuthService } from "./security.mjs";
import { createHelperClient } from "./helper-client.mjs";
import { createInventoryService } from "./inventory.mjs";
import { createJobService } from "./jobs.mjs";
import { createLibvirtService, getSetupPlan } from "./libvirt.mjs";
import { createMigrationService } from "./migrations.mjs";
import { createPrerequisiteService } from "./prerequisites.mjs";
import { createStateStore } from "./state.mjs";
import { createVmCreationService } from "./vm-creation.mjs";
import { createVmLifecycleService } from "./vm-lifecycle.mjs";
import { createVmPlanner, validateVmPlanInput } from "./vm-plan.mjs";

const app = express();
const host = process.env.BOXPILOT_HOST ?? "127.0.0.1";
const port = Number.parseInt(process.env.BOXPILOT_PORT ?? "8787", 10);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(root, "dist");
const libvirt = createLibvirtService();
const vmPlanner = createVmPlanner();
const audit = createAuditLog();
const state = createStateStore();
const auth = createAuthService(state);
const helper = createHelperClient({ timeoutMs: 180000 });
const prerequisites = createPrerequisiteService({
  stateDirectory: process.env.BOXPILOT_STATE_DIRECTORY ?? path.dirname(state.databasePath),
  helper,
});
const applications = createApplicationService({ store: state, prerequisites, helper });
const backups = createBackupService({ store: state, prerequisites, helper });
const inventory = createInventoryService({ helper });
const migrations = createMigrationService({ store: state, inventory });
const vmCreation = createVmCreationService({ store: state, planner: vmPlanner, libvirt });
const vmLifecycle = createVmLifecycleService({ store: state, libvirt });
const jobs = createJobService(state, helper, {
  validateApplicationJob: applications.validateJob,
  validateBackupJob: backups.validateJob,
  recordBackupResult: backups.recordResult,
  validateVmCreationJob: vmCreation.validateJob,
  validateVmLifecycleJob: vmLifecycle.validateJob,
});
state.deleteExpiredSessions();
const interruptedJobs = state.recoverInterruptedJobs();

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
    version: "0.10.0",
    mode: "host-aware",
    safeMode: true,
    hostMutationsEnabled: true,
    mutationPolicy: "durable-approved-helper-only",
    ownerBootstrapRequired: state.ownerCount() === 0,
    timestamp: new Date().toISOString(),
  });
});

app.get("/api/v1/auth/status", auth.status);
app.post("/api/v1/auth/bootstrap", auth.bootstrap);
app.post("/api/v1/auth/login", auth.login);
app.post("/api/v1/auth/logout", auth.requireSession, auth.requireCsrf, auth.logout);

app.use("/api/v1", auth.requireSession);
app.use("/api/v1", (request, response, next) => {
  if (["GET", "HEAD", "OPTIONS"].includes(request.method)) {
    next();
    return;
  }
  auth.requireCsrf(request, response, next);
});

app.get("/api/v1/capabilities", (_request, response) => {
  response.json({
    inventory: "sanitized-host-docker-services-and-network",
    composeInspection: "browser-only",
    applications: "curated-plans-and-uptime-kuma-adapter",
    supportBundle: "browser-only",
    backups: "uptime-kuma-local-with-restore-drill",
    migrations: "read-only-sanitized-manifests-and-compatibility-plans",
    privilegedHelper: "typed-canary-applications-backups-inventory-logs-vm-creation-and-lifecycle",
    identity: "owner-password-foundation",
    durableJobs: "sqlite-approved-application-backup-vm-creation-and-lifecycle-workflows",
    virtualization: "live-libvirt",
    vmCreationPlanning: "validated-durable-approved",
    audit: "redacted-jsonl-foundation",
    vmActions: { enabled: true, mode: "durable-approved-helper-jobs" },
  });
});

app.get("/api/v1/operations/prerequisites", async (_request, response) => {
  response.json(await prerequisites.inspect());
});

app.get("/api/v1/inventory", async (_request, response) => {
  response.json(await inventory.inspect());
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

app.get("/api/v1/migrations/export-manifest", async (_request, response) => {
  response.json(await migrations.exportManifest());
});

app.get("/api/v1/migrations/sources", (_request, response) => {
  response.json(migrations.listSources());
});

app.post("/api/v1/migrations/sources/import", (request, response) => {
  try {
    const source = migrations.importManifest(request.body, request.boxpilotSession.owner.id);
    response.status(201).json({ source });
  } catch (error) {
    response.status(400).json({ error: error.message, code: "migration_manifest_invalid" });
  }
});

app.post("/api/v1/migrations/sources/:id/plans", async (request, response) => {
  try {
    const plan = await migrations.plan(request.params.id, request.boxpilotSession.owner.id);
    response.status(201).json({ plan });
  } catch (error) {
    const status = error.message === "Migration source not found" ? 404 : 400;
    response.status(status).json({ error: error.message, code: "migration_plan_failed" });
  }
});

app.get("/api/v1/applications", async (_request, response) => {
  response.json(await applications.list());
});

app.post("/api/v1/applications/:id/plans", async (request, response) => {
  try {
    const plan = await applications.plan(request.params.id, request.body, request.boxpilotSession.owner.id);
    response.status(201).json({ plan });
  } catch (error) {
    const status = error.message === "Application adapter not found" ? 404 : 400;
    response.status(status).json({ error: error.message, code: "application_plan_failed" });
  }
});

app.post("/api/v1/application-plans/:id/stage", async (request, response) => {
  try {
    const job = await applications.stage(request.params.id, request.body?.revision, request.boxpilotSession.owner.id);
    response.status(201).json({ job });
  } catch (error) {
    response.status(409).json({ error: error.message, code: "application_stage_failed" });
  }
});

app.get("/api/v1/backups", async (_request, response) => {
  response.json(await backups.list());
});

app.post("/api/v1/backups/:applicationId/plans", async (request, response) => {
  try {
    const plan = await backups.plan(request.params.applicationId, request.boxpilotSession.owner.id);
    response.status(201).json({ plan });
  } catch (error) {
    const status = error.message === "Backup adapter not found" ? 404 : 400;
    response.status(status).json({ error: error.message, code: "backup_plan_failed" });
  }
});

app.post("/api/v1/backup-plans/:id/stage", async (request, response) => {
  try {
    const job = await backups.stage(request.params.id, request.body?.revision, request.boxpilotSession.owner.id);
    response.status(201).json({ job });
  } catch (error) {
    response.status(409).json({ error: error.message, code: "backup_stage_failed" });
  }
});

app.get("/api/v1/jobs", (request, response) => {
  response.json({ jobs: state.listJobs(request.query.limit) });
});

app.post("/api/v1/operations/canary", auth.requireCsrf, (request, response) => {
  const job = jobs.createCanary(request.boxpilotSession.owner.id);
  response.status(201).json({ job });
});

app.post("/api/v1/jobs/:id/approve", auth.requireCsrf, async (request, response) => {
  try {
    const job = await jobs.approveAndRun(request.params.id, request.boxpilotSession.owner.id, request.body?.password);
    response.json({ job });
  } catch (error) {
    const status = error.message === "Job not found" ? 404 : error.message.includes("reauthentication") ? 401 : 409;
    response.status(status).json({ error: error.message, code: "job_approval_failed" });
  }
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

app.get("/api/v1/virtualization/planning-options", async (_request, response) => {
  response.json(await vmPlanner.getOptions());
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
    result = await vmCreation.plan(request.body, request.boxpilotSession.owner.id);
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

app.post("/api/v1/virtualization/plans/:id/stage", async (request, response) => {
  try {
    const job = await vmCreation.stage(request.params.id, request.body?.revision, request.boxpilotSession.owner.id);
    response.status(201).json({ job });
  } catch (error) {
    const status = error.message.includes("not found") ? 404 : 409;
    response.status(status).json({ error: error.message, code: "vm_plan_stage_failed" });
  }
});

app.post("/api/v1/virtualization/domains/:name/action-plans", async (request, response) => {
  try {
    const plan = await vmLifecycle.plan(request.params.name, request.body?.action, request.boxpilotSession.owner.id);
    response.status(201).json({ plan });
  } catch (error) {
    const status = error.message.includes("not found") ? 404 : 409;
    response.status(status).json({ error: error.message, code: "vm_lifecycle_plan_failed" });
  }
});

app.post("/api/v1/virtualization/action-plans/:id/stage", async (request, response) => {
  try {
    const job = await vmLifecycle.stage(request.params.id, request.body?.revision, request.boxpilotSession.owner.id);
    response.status(201).json({ job });
  } catch (error) {
    const status = error.message.includes("not found") ? 404 : 409;
    response.status(status).json({ error: error.message, code: "vm_lifecycle_stage_failed" });
  }
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
  console.log(`BoxPilot 0.10.0 listening on http://${host}:${port}`);
  if (interruptedJobs) console.warn(`${interruptedJobs} interrupted job(s) marked failed for operator review.`);
  console.log("Safe mode: host mutations require durable plans, password approval, and typed helper operations.");
});
