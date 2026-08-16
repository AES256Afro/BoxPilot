import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createActionCenterService } from "./action-center.mjs";
import { createAuditLog } from "./audit.mjs";
import { createApplicationService } from "./applications.mjs";
import { createBackupService } from "./backups.mjs";
import { createDnsAcceptanceService } from "./dns-acceptance.mjs";
import { createFleetService } from "./fleet.mjs";
import { createGithubProvenanceService } from "./github-provenance.mjs";
import { createAuthService } from "./security.mjs";
import { createHelperClient } from "./helper-client.mjs";
import { buildConsoleGuidanceResponse, createHelperLibvirtService } from "./helper-libvirt.mjs";
import { createInventoryService } from "./inventory.mjs";
import { createJobService } from "./jobs.mjs";
import { getSetupPlan } from "./libvirt.mjs";
import { createMigrationService } from "./migrations.mjs";
import { createNetworkService } from "./network.mjs";
import { createPrerequisiteService } from "./prerequisites.mjs";
import { createPrerequisiteRepairService } from "./prerequisite-repairs.mjs";
import { createRouterCheckpointService } from "./router-checkpoints.mjs";
import { createRecoveryKitService } from "./recovery-kit.mjs";
import { createStateStore } from "./state.mjs";
import { createSupportBundleService } from "./support-bundle.mjs";
import { createVmCreationService } from "./vm-creation.mjs";
import { createVmExportService } from "./vm-export.mjs";
import { createVmLifecycleService } from "./vm-lifecycle.mjs";
import { createVmPlanner, validateVmPlanInput } from "./vm-plan.mjs";
import { createVmProtectionService } from "./vm-protection.mjs";
import { createVmRecoveryService } from "./vm-recovery.mjs";
import { createVmRetentionService } from "./vm-retention.mjs";
import { createVmRestoreDrillService } from "./vm-restore-drill.mjs";
import { createVmSnapshotService } from "./vm-snapshot.mjs";

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
const libvirt = createHelperLibvirtService({ helper });
const prerequisites = createPrerequisiteService({
  stateDirectory: process.env.BOXPILOT_STATE_DIRECTORY ?? path.dirname(state.databasePath),
  helper,
});
const prerequisiteRepairs = createPrerequisiteRepairService({ store: state, helper });
const network = createNetworkService({ store: state });
const githubProvenance = createGithubProvenanceService();
const applications = createApplicationService({ store: state, prerequisites, helper, network, githubProvenance });
const backups = createBackupService({ store: state, prerequisites, helper });
const dnsAcceptance = createDnsAcceptanceService({ store: state, helper, network });
const fleet = createFleetService({ store: state });
const routerCheckpoints = createRouterCheckpointService({ store: state });
const inventory = createInventoryService({ helper });
const migrations = createMigrationService({ store: state, inventory, helper });
const vmCreation = createVmCreationService({ store: state, planner: vmPlanner, libvirt });
const vmExports = createVmExportService({ store: state, libvirt, helper });
const vmLifecycle = createVmLifecycleService({ store: state, libvirt });
const vmSnapshots = createVmSnapshotService({ store: state, libvirt });
const vmProtection = createVmProtectionService({ store: state, helper });
const vmRecoveries = createVmRecoveryService({ store: state, helper });
const vmRetention = createVmRetentionService({ store: state, helper });
const recoveryKit = createRecoveryKitService({ store: state, prerequisites, applications, libvirt });
const actionCenter = createActionCenterService({ recoveryKit, inventory });
const supportBundle = createSupportBundleService({ inventory, prerequisites, actionCenter, audit, helper });
const vmRestoreDrills = createVmRestoreDrillService({ store: state, helper });
const jobs = createJobService(state, helper, {
  validatePrerequisiteRepairJob: prerequisiteRepairs.validateJob,
  validateApplicationJob: applications.validateJob,
  validateBackupJob: backups.validateJob,
  recordBackupResult: backups.recordResult,
  validateDnsAcceptanceJob: dnsAcceptance.validateJob,
  executeDnsAcceptanceJob: dnsAcceptance.executeJob,
  recordDnsAcceptanceResult: dnsAcceptance.recordResult,
  validateMigrationTransferJob: migrations.validateTransferJob,
  recordMigrationTransferResult: migrations.recordTransferResult,
  validateVmCreationJob: vmCreation.validateJob,
  validateVmExportJob: vmExports.validateJob,
  recordVmExportResult: vmExports.recordResult,
  validateVmProtectionJob: vmProtection.validateJob,
  recordVmProtectionResult: vmProtection.recordResult,
  validateVmRetentionJob: vmRetention.validateJob,
  recordVmRetentionResult: vmRetention.recordResult,
  validateVmRestoreDrillJob: vmRestoreDrills.validateJob,
  recordVmRestoreDrillResult: vmRestoreDrills.recordResult,
  validateVmRecoveryJob: vmRecoveries.validateJob,
  recordVmRecoveryResult: vmRecoveries.recordResult,
  validateVmLifecycleJob: vmLifecycle.validateJob,
  validateVmSnapshotJob: vmSnapshots.validateJob,
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
    version: "0.33.0",
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

app.post("/api/v1/agent/enroll", (request, response) => {
  try {
    response.status(201).json({ agent: fleet.enroll(request.body) });
  } catch (error) {
    response.status(401).json({ error: error.message, code: "agent_enrollment_rejected" });
  }
});

function agentHeaders(request) {
  return {
    agentId: request.get("x-boxpilot-agent-id"),
    sequence: request.get("x-boxpilot-agent-sequence"),
    timestamp: request.get("x-boxpilot-agent-timestamp"),
    signature: request.get("x-boxpilot-agent-signature"),
  };
}

app.get("/api/v1/agent/tasks/next", (request, response) => {
  try {
    const task = fleet.nextTask({ headers: agentHeaders(request) });
    if (!task) {
      response.status(204).end();
      return;
    }
    response.json({ task });
  } catch (error) {
    response.status(401).json({ error: error.message, code: "agent_request_rejected" });
  }
});

app.post("/api/v1/agent/evidence", (request, response) => {
  try {
    response.status(201).json({ evidence: fleet.submitEvidence({ headers: agentHeaders(request) }, request.body) });
  } catch (error) {
    response.status(409).json({ error: error.message, code: "agent_evidence_rejected" });
  }
});

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
    inventory: "sanitized-host-storage-ext4-error-counters-filesystem-smart-local-ups-docker-services-network-and-dns-topology",
    composeInspection: "browser-only",
    applications: "curated-uptime-kuma-and-no-cutover-pi-hole-staging-recovery-and-direct-dns-acceptance",
    supportBundle: "authenticated-server-generated-fixed-source-configurably-redacted",
    backups: "uptime-kuma-local-restore-drill-and-vm-independent-restic-copy-with-isolated-boot-validation-recovery-clones-and-guarded-retention",
    migrations: "sanitized-manifests-compatibility-plans-and-checksummed-local-bundle-staging",
    network: "read-only-topology-and-approved-fixed-pi-hole-direct-dns-acceptance",
    privilegedHelper: "typed-canary-exact-smartmontools-repair-curated-applications-backups-migration-staging-inventory-logs-vm-creation-lifecycle-snapshots-exports-mounted-restic-isolated-restore-drills-recovery-clones-and-retention",
    identity: "owner-password-foundation",
    durableJobs: "sqlite-approved-prerequisite-application-backup-dns-acceptance-migration-transfer-vm-creation-lifecycle-snapshot-export-protection-restore-drill-recovery-and-retention-workflows",
    virtualization: "live-libvirt-via-restricted-helper",
    vmCreationPlanning: "validated-durable-approved",
    audit: "redacted-jsonl-foundation",
    vmActions: { enabled: true, mode: "durable-approved-helper-jobs" },
    vmSnapshots: { create: "offline-stopped-managed-qcow2-only", revert: false, delete: false, countsAsBackup: false },
    vmExports: { create: "offline-stopped-managed-qcow2-only", destination: "local-managed", integrityVerified: true, encrypted: false, protectedBackup: false, restoreDrill: false },
    vmProtection: { destination: "fixed-independent-mounted-restic", encrypted: true, repositoryReadVerified: true, isolatedRestoreDrill: "transient-no-network-guest-agent", protectedBackup: "after-passing-restore-drill", retentionMutation: "exact-protected-old-snapshot-forget-without-prune" },
    vmRecovery: { create: "protected-snapshot-to-new-stopped-persistent-domain", network: "none", autostart: false, inPlaceRestore: false, sourceDeletion: false },
    vmConsole: { nativeProxy: false, cockpitHandoff: "detect-existing-only" },
    fleet: { enrollment: "one-time-digest-stored-token", identity: "ed25519-signed-replay-protected", execution: "node-local-allowlisted-dns-probe-only", scheduling: "password-approved-one-shot-fixed-delay-only", recurrence: false, controllerShellAccess: false },
    routers: { checkpoints: "browser-local-sha256-metadata-only", guidance: "fixed-model-operator-checklists-with-live-gateway-address-correlation", gatewayIdentityVerified: false, configurationUpload: false, credentials: false, discovery: false, mutations: false },
    github: { repositories: "fixed-public-read-only-allowlist", authentication: false, writes: false, cloneOrDownload: false, localDigestVerification: false },
    recoveryKit: { generation: "authenticated-read-only", formats: ["json", "markdown"], mutations: false, secretsIncluded: false, backupPayloadIncluded: false },
    actionCenter: { generation: "authenticated-read-only", guidance: "fixed-local-destinations", automaticRepair: false, persistence: false, externalDelivery: false },
    filesystemErrors: { ext4: "mounted-kernel-errors-count-read-only", unsupportedFilesystems: "explicit", filesystemCheck: false, repair: false },
    upsEvidence: { source: "fixed-upsc-localhost-only", devices: "single-locally-enumerated", powerCommands: false, shutdownPolicyMutation: false, remoteTargets: false },
    prerequisiteRepairs: { smartmontools: "exact-version-durable-approved-fixed-package-service", arbitraryPackages: false, aptUpdate: false, automaticRemoval: false },
  });
});

app.get("/api/v1/fleet", (_request, response) => {
  response.json(fleet.inspect());
});

app.get("/api/v1/integrations/github", async (_request, response) => {
  response.json(await githubProvenance.inspect());
});

app.post("/api/v1/fleet/enrollments", async (request, response) => {
  try {
    const enrollment = await fleet.createEnrollment(request.boxpilotSession.owner.id, request.body);
    response.status(201).json({ enrollment });
  } catch (error) {
    response.status(401).json({ error: error.message, code: "fleet_enrollment_creation_rejected" });
  }
});

app.post("/api/v1/fleet/agents/:id/revoke", async (request, response) => {
  try {
    response.json({ agent: await fleet.revoke(request.boxpilotSession.owner.id, request.params.id, request.body) });
  } catch (error) {
    response.status(error.message.includes("not found") ? 404 : 401).json({ error: error.message, code: "fleet_agent_revocation_rejected" });
  }
});

app.post("/api/v1/fleet/dns-probe-tasks", async (request, response) => {
  try {
    response.status(201).json({ task: await fleet.createDnsProbeTask(request.boxpilotSession.owner.id, request.body) });
  } catch (error) {
    response.status(409).json({ error: error.message, code: "fleet_dns_probe_task_rejected" });
  }
});

app.get("/api/v1/operations/prerequisites", async (_request, response) => {
  response.json(await prerequisites.inspect());
});

app.post("/api/v1/prerequisite-repairs/smartmontools/plans", async (request, response) => {
  try {
    const plan = await prerequisiteRepairs.planSmartmontools(request.boxpilotSession.owner.id, request.body);
    response.status(201).json({ plan });
  } catch (error) {
    response.status(409).json({ error: error.message, code: "smartmontools_repair_plan_failed" });
  }
});

app.post("/api/v1/prerequisite-repair-plans/:id/stage", async (request, response) => {
  try {
    if (!request.body || typeof request.body !== "object" || Array.isArray(request.body) || Object.keys(request.body).length !== 1 || typeof request.body.revision !== "string") throw new Error("Prerequisite repair staging accepts only the immutable revision");
    const job = await prerequisiteRepairs.stage(request.params.id, request.body.revision, request.boxpilotSession.owner.id);
    response.status(201).json({ job });
  } catch (error) {
    response.status(409).json({ error: error.message, code: "smartmontools_repair_stage_failed" });
  }
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

app.get("/api/v1/network/router-checkpoints", (_request, response) => {
  response.json(routerCheckpoints.inspect());
});

app.get("/api/v1/network/router-readiness", async (_request, response) => {
  response.json(await network.routerReadiness(routerCheckpoints.inspect()));
});

app.post("/api/v1/network/router-checkpoints", (request, response) => {
  try {
    response.status(201).json({ checkpoint: routerCheckpoints.record(request.body, request.boxpilotSession.owner.id) });
  } catch (error) {
    response.status(400).json({ error: error.message, code: "router_checkpoint_rejected" });
  }
});

app.post("/api/v1/network/plans", async (request, response) => {
  try {
    const plan = await network.plan(request.body, request.boxpilotSession.owner.id);
    response.status(201).json({ plan });
  } catch (error) {
    response.status(400).json({ error: error.message, code: "network_plan_failed" });
  }
});

app.get("/api/v1/network/dns-acceptance", async (_request, response) => {
  response.json(await dnsAcceptance.inspect());
});

app.post("/api/v1/network/dns-acceptance/plans", async (request, response) => {
  try {
    if (!request.body || typeof request.body !== "object" || Array.isArray(request.body) || Object.keys(request.body).length > 0) throw new Error("DNS acceptance planning accepts only an empty object and no operator-selected target or query");
    const plan = await dnsAcceptance.plan(request.boxpilotSession.owner.id);
    response.status(201).json({ plan });
  } catch (error) {
    response.status(409).json({ error: error.message, code: "dns_acceptance_plan_failed" });
  }
});

app.post("/api/v1/network/dns-acceptance-plans/:id/stage", async (request, response) => {
  try {
    if (!request.body || typeof request.body !== "object" || Array.isArray(request.body) || Object.keys(request.body).length !== 1 || typeof request.body.revision !== "string") throw new Error("DNS acceptance staging accepts only the immutable revision");
    const job = await dnsAcceptance.stage(request.params.id, request.body?.revision, request.boxpilotSession.owner.id);
    response.status(201).json({ job });
  } catch (error) {
    response.status(409).json({ error: error.message, code: "dns_acceptance_stage_failed" });
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

app.get("/api/v1/migrations/bundles", async (_request, response) => {
  try {
    response.json(await migrations.inspectBundles());
  } catch (error) {
    response.status(503).json({ error: error.message, code: "migration_bundles_unavailable" });
  }
});

app.get("/api/v1/migrations/transfers", (_request, response) => {
  response.json(migrations.listTransfers());
});

app.post("/api/v1/migrations/bundles/:id/transfer-plans", async (request, response) => {
  try {
    const plan = await migrations.planTransfer(request.params.id, request.boxpilotSession.owner.id);
    response.status(201).json({ plan });
  } catch (error) {
    const status = error.message.includes("not found") ? 404 : error.message.includes("unavailable") ? 503 : 409;
    response.status(status).json({ error: error.message, code: "migration_transfer_plan_failed" });
  }
});

app.post("/api/v1/migration-transfer-plans/:id/stage", async (request, response) => {
  try {
    const job = await migrations.stageTransfer(request.params.id, request.body?.revision, request.boxpilotSession.owner.id);
    response.status(201).json({ job });
  } catch (error) {
    response.status(409).json({ error: error.message, code: "migration_transfer_stage_failed" });
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
    const candidate = state.getJob(request.params.id);
    const background = ["prerequisite.smartmontools.install", "application.pi-hole.deploy", "application.pi-hole.backup", "network.dns.acceptance.run", "migration.bundle.transfer", "virtualization.domain.export.create", "virtualization.export.backup.create", "virtualization.export.backup.retention.apply", "virtualization.export.backup.restore-drill", "virtualization.backup.recovery.create"].includes(candidate?.type);
    const job = background
      ? await jobs.approveAndStart(request.params.id, request.boxpilotSession.owner.id, request.body?.password)
      : await jobs.approveAndRun(request.params.id, request.boxpilotSession.owner.id, request.body?.password);
    response.status(background ? 202 : 200).json({ job });
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

app.get("/api/v1/virtualization/console-guidance", async (_request, response) => {
  response.json(buildConsoleGuidanceResponse(await libvirt.getConsoleGuidance()));
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
    const status = error.message.includes("unavailable") ? 503 : error.message.includes("not found") ? 404 : 409;
    response.status(status).json({ error: error.message, code: "vm_plan_stage_failed" });
  }
});

app.post("/api/v1/virtualization/domains/:name/action-plans", async (request, response) => {
  try {
    const plan = await vmLifecycle.plan(request.params.name, request.body?.action, request.boxpilotSession.owner.id);
    response.status(201).json({ plan });
  } catch (error) {
    const status = error.message.includes("unavailable") ? 503 : error.message.includes("not found") ? 404 : 409;
    response.status(status).json({ error: error.message, code: "vm_lifecycle_plan_failed" });
  }
});

app.post("/api/v1/virtualization/action-plans/:id/stage", async (request, response) => {
  try {
    const job = await vmLifecycle.stage(request.params.id, request.body?.revision, request.boxpilotSession.owner.id);
    response.status(201).json({ job });
  } catch (error) {
    const status = error.message.includes("unavailable") ? 503 : error.message.includes("not found") ? 404 : 409;
    response.status(status).json({ error: error.message, code: "vm_lifecycle_stage_failed" });
  }
});

app.post("/api/v1/virtualization/domains/:name/snapshot-plans", async (request, response) => {
  try {
    const plan = await vmSnapshots.plan(request.params.name, request.body?.snapshotName, request.boxpilotSession.owner.id);
    response.status(201).json({ plan });
  } catch (error) {
    const status = error.message.includes("unavailable") ? 503 : error.message.includes("not found") ? 404 : 409;
    response.status(status).json({ error: error.message, code: "vm_snapshot_plan_failed" });
  }
});

app.post("/api/v1/virtualization/snapshot-plans/:id/stage", async (request, response) => {
  try {
    const job = await vmSnapshots.stage(request.params.id, request.body?.revision, request.boxpilotSession.owner.id);
    response.status(201).json({ job });
  } catch (error) {
    const status = error.message.includes("unavailable") ? 503 : error.message.includes("not found") ? 404 : 409;
    response.status(status).json({ error: error.message, code: "vm_snapshot_stage_failed" });
  }
});

app.get("/api/v1/virtualization/exports", (_request, response) => {
  response.json(vmExports.list());
});

app.post("/api/v1/virtualization/domains/:name/export-plans", async (request, response) => {
  try {
    const plan = await vmExports.plan(request.params.name, request.boxpilotSession.owner.id);
    response.status(201).json({ plan });
  } catch (error) {
    const status = error.message.includes("unavailable") ? 503 : error.message.includes("not found") ? 404 : 409;
    response.status(status).json({ error: error.message, code: "vm_export_plan_failed" });
  }
});

app.post("/api/v1/virtualization/export-plans/:id/stage", async (request, response) => {
  try {
    const job = await vmExports.stage(request.params.id, request.body?.revision, request.boxpilotSession.owner.id);
    response.status(201).json({ job });
  } catch (error) {
    const status = error.message.includes("unavailable") ? 503 : error.message.includes("not found") ? 404 : 409;
    response.status(status).json({ error: error.message, code: "vm_export_stage_failed" });
  }
});

app.get("/api/v1/virtualization/protection", async (_request, response) => {
  response.json(await vmProtection.list());
});

app.post("/api/v1/virtualization/exports/:id/protection-plans", async (request, response) => {
  try {
    const plan = await vmProtection.plan(request.params.id, request.boxpilotSession.owner.id);
    response.status(201).json({ plan });
  } catch (error) {
    const status = error.message.includes("not found") ? 404 : error.message.includes("unavailable") ? 503 : 409;
    response.status(status).json({ error: error.message, code: "vm_protection_plan_failed" });
  }
});

app.post("/api/v1/virtualization/protection-plans/:id/stage", async (request, response) => {
  try {
    const job = await vmProtection.stage(request.params.id, request.body?.revision, request.boxpilotSession.owner.id);
    response.status(201).json({ job });
  } catch (error) {
    const status = error.message.includes("not found") ? 404 : error.message.includes("unavailable") ? 503 : 409;
    response.status(status).json({ error: error.message, code: "vm_protection_stage_failed" });
  }
});

app.get("/api/v1/virtualization/retention", async (_request, response) => {
  try {
    response.json(await vmRetention.inspect());
  } catch (error) {
    response.status(503).json({ error: error.message, code: "vm_retention_inspection_failed" });
  }
});

app.post("/api/v1/virtualization/retention-plans", async (request, response) => {
  try {
    const plan = await vmRetention.plan(request.boxpilotSession.owner.id);
    response.status(201).json({ plan });
  } catch (error) {
    response.status(503).json({ error: error.message, code: "vm_retention_plan_failed" });
  }
});

app.post("/api/v1/virtualization/retention-plans/:id/stage", async (request, response) => {
  try {
    const job = await vmRetention.stage(request.params.id, request.body?.revision, request.boxpilotSession.owner.id);
    response.status(201).json({ job });
  } catch (error) {
    const status = error.message.includes("not found") ? 404 : error.message.includes("unavailable") ? 503 : 409;
    response.status(status).json({ error: error.message, code: "vm_retention_stage_failed" });
  }
});

app.post("/api/v1/virtualization/backups/:id/restore-drill-plans", async (request, response) => {
  try {
    const plan = await vmRestoreDrills.plan(request.params.id, request.boxpilotSession.owner.id);
    response.status(201).json({ plan });
  } catch (error) {
    const status = error.message.includes("not found") ? 404 : error.message.includes("unavailable") ? 503 : 409;
    response.status(status).json({ error: error.message, code: "vm_restore_drill_plan_failed" });
  }
});

app.post("/api/v1/virtualization/restore-drill-plans/:id/stage", async (request, response) => {
  try {
    const job = await vmRestoreDrills.stage(request.params.id, request.body?.revision, request.boxpilotSession.owner.id);
    response.status(201).json({ job });
  } catch (error) {
    const status = error.message.includes("not found") ? 404 : error.message.includes("unavailable") ? 503 : 409;
    response.status(status).json({ error: error.message, code: "vm_restore_drill_stage_failed" });
  }
});

app.get("/api/v1/virtualization/recoveries", (_request, response) => {
  response.json({ recoveries: vmRecoveries.list() });
});

app.post("/api/v1/virtualization/backups/:id/recovery-plans", async (request, response) => {
  try {
    const plan = await vmRecoveries.plan(request.params.id, request.body?.targetDomainName, request.boxpilotSession.owner.id);
    response.status(201).json({ plan });
  } catch (error) {
    const status = error.message.includes("not found") ? 404 : error.message.includes("unavailable") ? 503 : 409;
    response.status(status).json({ error: error.message, code: "vm_recovery_plan_failed" });
  }
});

app.post("/api/v1/virtualization/recovery-plans/:id/stage", async (request, response) => {
  try {
    const job = await vmRecoveries.stage(request.params.id, request.body?.revision, request.boxpilotSession.owner.id);
    response.status(201).json({ job });
  } catch (error) {
    const status = error.message.includes("not found") ? 404 : error.message.includes("unavailable") ? 503 : 409;
    response.status(status).json({ error: error.message, code: "vm_recovery_stage_failed" });
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
  console.log(`BoxPilot 0.33.0 listening on http://${host}:${port}`);
  if (interruptedJobs) console.warn(`${interruptedJobs} interrupted job(s) marked failed for operator review.`);
  console.log("Safe mode: host mutations require durable plans, password approval, and typed helper operations.");
});
