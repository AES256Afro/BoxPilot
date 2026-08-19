import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { productVersion } from "./version.mjs";
import { registry } from "./ops/index.mjs";
import { approvalModes, defaultApprovalMode, elevationTtlMs, normalizeApprovalMode } from "./ops/risk.mjs";
import { createCatalogService } from "./catalog/index.mjs";
import { createJobLogReader } from "./job-log.mjs";
import { findPortConflicts, listListeners } from "./ports.mjs";
import { resolveValues } from "./catalog/schema.mjs";
import { createActionCenterService } from "./action-center.mjs";
import { createAuditLog } from "./audit.mjs";
import { createApplicationService } from "./applications.mjs";
import { createApplicationLifecycleService } from "./application-lifecycle.mjs";
import { createApplicationPrivateAccessService } from "./application-private-access.mjs";
import { createApplicationProtectionService } from "./application-protection.mjs";
import { createApplicationRetentionService } from "./application-retention.mjs";
import { createBackupService } from "./backups.mjs";
import { createControllerProtectionService } from "./controller-protection.mjs";
import { createControllerRetentionService } from "./controller-retention.mjs";
import { createDnsAcceptanceService } from "./dns-acceptance.mjs";
import { createFleetService } from "./fleet.mjs";
import { createFlint2AdguardService } from "./flint2-adguard.mjs";
import { createGithubProvenanceService } from "./github-provenance.mjs";
import { createAuthService, verifyPassword } from "./security.mjs";
import { createHelperClient } from "./helper-client.mjs";
import { buildConsoleGuidanceResponse, createHelperLibvirtService } from "./helper-libvirt.mjs";
import { createInventoryService } from "./inventory.mjs";
import { createJobService } from "./jobs.mjs";
import { createKeelArtifactService } from "./keel-artifacts.mjs";
import { createKeelRecoveryService } from "./keel-recovery.mjs";
import { createKeelRecoveryDrillService } from "./keel-recovery-drill.mjs";
import { createKeelPromotionService } from "./keel-promotion.mjs";
import { createKeelRollbackService } from "./keel-rollback.mjs";
import { getSetupPlan } from "./libvirt.mjs";
import { createLibvirtFoundationService } from "./libvirt-foundation.mjs";
import { createMigrationService } from "./migrations.mjs";
import { createMaintenanceService } from "./maintenance.mjs";
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
import { createVmMediaService } from "./vm-media.mjs";
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
const maintenance = createMaintenanceService();
const libvirt = createHelperLibvirtService({ helper });
const libvirtFoundation = createLibvirtFoundationService({ store: state, helper });
const prerequisites = createPrerequisiteService({
  stateDirectory: process.env.BOXPILOT_STATE_DIRECTORY ?? path.dirname(state.databasePath),
  helper,
});
const prerequisiteRepairs = createPrerequisiteRepairService({ store: state, helper });
const network = createNetworkService({ store: state });
const githubProvenance = createGithubProvenanceService();
const applications = createApplicationService({ store: state, prerequisites, helper, network, githubProvenance });
const applicationLifecycle = createApplicationLifecycleService({ store: state, helper });
const applicationPrivateAccess = createApplicationPrivateAccessService({ store: state, helper });
const keelArtifacts = createKeelArtifactService({ store: state, prerequisites, helper, githubProvenance });
const keelRecoveries = createKeelRecoveryService({ store: state, helper });
const keelRecoveryDrills = createKeelRecoveryDrillService({ store: state, helper });
const keelPromotions = createKeelPromotionService({ store: state, helper });
const keelRollbacks = createKeelRollbackService({ store: state, helper });
const backups = createBackupService({ store: state, prerequisites, helper });
const applicationProtection = createApplicationProtectionService({ store: state, helper });
const applicationRetention = createApplicationRetentionService({ store: state, helper });
const controllerProtection = createControllerProtectionService({ store: state, helper });
const controllerRetention = createControllerRetentionService({ store: state, helper });
const dnsAcceptance = createDnsAcceptanceService({ store: state, helper, network });
const fleet = createFleetService({ store: state });
const routerCheckpoints = createRouterCheckpointService({ store: state });
const flint2Adguard = createFlint2AdguardService({ store: state, network, routerCheckpoints });
const inventory = createInventoryService({ helper, maintenance });
const migrations = createMigrationService({ store: state, inventory, helper });
const vmCreation = createVmCreationService({ store: state, planner: vmPlanner, libvirt });
const vmMedia = createVmMediaService({ store: state, helper });
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
const jobLogReader = createJobLogReader();
const jobs = createJobService(state, helper, {
  jobLog: jobLogReader,
  validatePrerequisiteRepairJob: prerequisiteRepairs.validateJob,
  validateLibvirtFoundationJob: libvirtFoundation.validateJob,
  validateApplicationJob: applications.validateJob,
  validateApplicationLifecycleJob: applicationLifecycle.validateJob,
  validateApplicationPrivateAccessJob: applicationPrivateAccess.validateJob,
  validateKeelArtifactJob: keelArtifacts.validateJob,
  validateKeelRecoveryJob: keelRecoveries.validateJob,
  recordKeelRecoveryResult: keelRecoveries.recordResult,
  validateKeelRecoveryDrillJob: keelRecoveryDrills.validateJob,
  recordKeelRecoveryDrillResult: keelRecoveryDrills.recordResult,
  validateKeelPromotionJob: keelPromotions.validateJob,
  recordKeelPromotionResult: keelPromotions.recordResult,
  validateKeelRollbackJob: keelRollbacks.validateJob,
  recordKeelRollbackResult: keelRollbacks.recordResult,
  validateBackupJob: backups.validateJob,
  recordBackupResult: backups.recordResult,
  validateApplicationProtectionJob: applicationProtection.validateJob,
  recordApplicationProtectionResult: applicationProtection.recordResult,
  validateApplicationRetentionJob: applicationRetention.validateJob,
  recordApplicationRetentionResult: applicationRetention.recordResult,
  validateControllerProtectionJob: controllerProtection.validateJob,
  recordControllerProtectionResult: controllerProtection.recordResult,
  validateControllerRetentionJob: controllerRetention.validateJob,
  recordControllerRetentionResult: controllerRetention.recordResult,
  validateDnsAcceptanceJob: dnsAcceptance.validateJob,
  executeDnsAcceptanceJob: dnsAcceptance.executeJob,
  recordDnsAcceptanceResult: dnsAcceptance.recordResult,
  validateFlint2AdguardJob: flint2Adguard.validateJob,
  executeFlint2AdguardJob: flint2Adguard.executeJob,
  recordFlint2AdguardResult: flint2Adguard.recordResult,
  validateMigrationTransferJob: migrations.validateTransferJob,
  recordMigrationTransferResult: migrations.recordTransferResult,
  validateVmCreationJob: vmCreation.validateJob,
  validateVmMediaImportJob: vmMedia.validateJob,
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
    version: productVersion,
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
app.post("/api/v1/auth/elevate", auth.requireSession, auth.requireCsrf, auth.elevate);
app.delete("/api/v1/auth/elevate", auth.requireSession, auth.requireCsrf, auth.dropElevation);

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

app.get("/api/v1/operations", (_request, response) => {
  response.json({ operations: registry.describe(), riskTiers: ["low", "medium", "high"] });
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
app.post("/api/v1/operations/:id/jobs", auth.requireCsrf, (request, response) => {
  try {
    const job = jobs.createOperationJob(request.params.id, request.body?.parameters ?? {}, request.boxpilotSession.owner.id);
    return response.status(201).json({ job, approval: jobs.describeApproval(job.id, request.boxpilotSession) });
  } catch (error) {
    const status = error.message === "Operation not found" ? 404 : error.message.includes("Read-only") ? 405 : 400;
    return response.status(status).json({ error: error.message, code: "operation_job_rejected" });
  }
});

app.get("/api/v1/capabilities", (_request, response) => {
  response.json({
    inventory: "sanitized-host-maintenance-storage-ext4-error-counters-filesystem-smart-local-ups-docker-services-network-and-dns-topology",
    composeInspection: "browser-only",
    applications: "curated-uptime-kuma-deploy-start-stop-restart-backup-and-tailnet-only-private-access-plus-no-cutover-pi-hole-deploy-start-stop-restart-and-backup-plus-fixed-keel-artifact-stage-native-install-terminal-claim-consistent-backup-stopped-recovery-clone-isolated-startup-rehearsal-rollback-backed-promotion-and-operator-rollback",
    supportBundle: "authenticated-server-generated-fixed-source-configurably-redacted",
    backups: "wal-aware-controller-local-restore-plus-encrypted-independent-restic-copy-uptime-kuma-pi-hole-and-keel-local-restore-drills-stopped-keel-recovery-clones-isolated-keel-startup-rehearsals-rollback-backed-keel-promotion-operator-rollback-and-vm-protection",
    migrations: "sanitized-manifests-compatibility-plans-and-checksummed-local-bundle-staging",
    network: "read-only-topology-approved-fixed-pi-hole-and-observed-gateway-direct-dns-acceptance-plus-signed-second-device-evidence",
    privilegedHelper: "typed-canary-exact-smartmontools-restic-docker-and-virtualization-repairs-fixed-apt-metadata-refresh-fixed-libvirt-foundation-controller-local-backup-independent-restic-protection-curated-applications-fixed-keel-artifact-stage-install-backup-stopped-recovery-isolated-recovery-drill-rollback-backed-promotion-and-operator-rollback-migration-inventory-logs-and-vm-workflows",
    identity: "owner-password-foundation",
    durableJobs: "sqlite-approved-prerequisite-libvirt-foundation-controller-local-backup-controller-independent-protection-application-backup-keel-artifact-stage-install-backup-stopped-recovery-isolated-recovery-drill-rollback-backed-promotion-and-operator-rollback-dns-migration-and-vm-workflows",
    virtualization: "live-libvirt-via-restricted-helper",
    libvirtFoundation: { inspect: "parameter-free-canonical-default-only", initialize: "durable-approved-static-unit", network: "default-nat-192.168.122.0/24", pool: "default-dir-var-lib-libvirt-images", automaticRollback: "job-changes-only", browserResourceInput: false },
    vmCreationPlanning: "validated-durable-approved-with-authenticated-staged-iso-import",
    vmMedia: { upload: "authenticated-csrf-fixed-staging-only", import: "durable-approved-sha256-verified-atomic-non-overwrite", maximumIsoBytes: 17179869184, browserPath: false, arbitraryDestination: false, existingOverwrite: false },
    audit: "redacted-jsonl-foundation",
    vmActions: { enabled: true, mode: "durable-approved-helper-jobs" },
    applicationActions: { uptimeKuma: ["start", "stop", "restart"], pihole: ["start", "stop", "restart"], privateAccess: { uptimeKuma: ["publish", "unpublish"], mode: "tailscale-serve-tailnet-only", funnel: false, arbitraryTarget: false }, mode: "durable-approved-exact-managed-container-only", routerCutover: false, remove: false, arbitraryContainer: false },
    vmSnapshots: { create: "offline-stopped-managed-qcow2-only", revert: false, delete: false, countsAsBackup: false },
    vmExports: { create: "offline-stopped-managed-qcow2-only", destination: "local-managed", integrityVerified: true, encrypted: false, protectedBackup: false, restoreDrill: false },
    vmProtection: { destination: "fixed-independent-mounted-restic", encrypted: true, repositoryReadVerified: true, isolatedRestoreDrill: "transient-no-network-guest-agent", protectedBackup: "after-passing-restore-drill", retentionMutation: "exact-protected-old-snapshot-forget-without-prune" },
    vmRecovery: { create: "protected-snapshot-to-new-stopped-persistent-domain", network: "none", autostart: false, inPlaceRestore: false, sourceDeletion: false },
    keelRecovery: { create: "verified-local-archive-to-new-root-only-stopped-state", startupDrill: "disposable-copy-private-loopback-health-and-sqlite", network: "none-until-drill-private-namespace-then-existing-production-loopback", applicationStartedInSource: false, ownerLoginTested: false, productionRestore: "exact-passing-drill-only", promotion: "atomic-old-state-checkpoint-with-automatic-failure-rollback", operatorRequestedRollback: "exact-retained-checkpoint-with-displaced-state-preservation", rollbackRetention: false, sourceChanged: false },
    vmConsole: { nativeProxy: false, cockpitHandoff: "detect-existing-only" },
    controllerBackup: { source: "fixed-live-sqlite", snapshot: "vacuum-into-wal-aware", localDestination: "root-only-local-managed", independentDestination: "fixed-mounted-restic-controller", repositoryReadVerified: true, restoreDrill: "exact-snapshot-isolated-copy-open-integrity-foreign-key-schema", downtime: false, encrypted: true, independent: "after-passing-restic-restore-drill", retention: "exact-protected-old-snapshot-forget-without-prune", prune: false, browserPath: false, browserPassword: false },
    fleet: { enrollment: "one-time-digest-stored-token", identity: "ed25519-signed-replay-protected", execution: "node-local-allowlisted-pi-hole-or-default-gateway-dns-probe-only", scheduling: "password-approved-one-shot-fixed-delay-only", recurrence: false, controllerShellAccess: false, arbitraryTarget: false },
    routers: { checkpoints: "browser-local-sha256-metadata-only", guidance: "fixed-model-operator-checklists-with-live-gateway-address-correlation", directGatewayDnsAcceptance: "durable-approved-four-fixed-queries", signedSecondDeviceDnsAcceptance: "owner-approved-one-shot-agent-with-local-default-gateway-match", gatewayIdentityVerified: false, adguardConfigurationVerified: false, dhcpAdvertisementVerified: false, configurationUpload: false, credentials: false, discovery: false, mutations: false },
    github: { repositories: "fixed-public-read-only-allowlist", authentication: false, writes: false, clone: false, arbitraryDownload: false, keelFixedReleaseAcquisition: "approved-root-only-locally-verified-inert-archive", keelArchiveGate: "read-only-bounded-membership-validation", browserDownload: false, extraction: "separate-approved-exact-keel-release-only", installation: "separate-approved-exact-keel-native-service-only" },
    recoveryKit: { generation: "authenticated-read-only", formats: ["json", "markdown"], mutations: false, secretsIncluded: false, backupPayloadIncluded: false },
    actionCenter: { generation: "authenticated-read-only", guidance: "fixed-local-destinations", automaticRepair: false, persistence: false, externalDelivery: false },
    filesystemErrors: { ext4: "mounted-kernel-errors-count-read-only", unsupportedFilesystems: "explicit", filesystemCheck: false, repair: false },
    upsEvidence: { source: "fixed-upsc-localhost-only", devices: "single-locally-enumerated", powerCommands: false, shutdownPolicyMutation: false, remoteTargets: false },
    maintenanceEvidence: { source: "fixed-local-systemd-reboot-dpkg-apt-and-unattended-upgrades-state", namesIncluded: false, aptOperations: "fixed-approved-metadata-update-only", serviceControl: false, reboot: false },
    prerequisiteRepairs: { smartmontools: "exact-version-durable-approved-fixed-package-service", restic: "exact-version-durable-approved-fixed-package-service-without-repository-setup", aptMetadata: "durable-approved-static-update-only-service", arbitraryPackages: false, packageInstall: "smartmontools-or-restic-only", packageUpgrade: false, packageRemoval: false, browserCommands: false, automaticRemoval: false, repositorySetup: false },
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

app.post("/api/v1/fleet/flint2-dns-probe-tasks", async (request, response) => {
  try {
    response.status(201).json({ task: await fleet.createFlint2DnsProbeTask(request.boxpilotSession.owner.id, request.body) });
  } catch (error) {
    response.status(409).json({ error: error.message, code: "fleet_flint2_dns_probe_task_rejected" });
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

app.post("/api/v1/prerequisite-repairs/restic/plans", async (request, response) => {
  try {
    const plan = await prerequisiteRepairs.planRestic(request.boxpilotSession.owner.id, request.body);
    response.status(201).json({ plan });
  } catch (error) {
    response.status(409).json({ error: error.message, code: "restic_repair_plan_failed" });
  }
});

app.post("/api/v1/prerequisite-repairs/docker/plans", async (request, response) => {
  try {
    const plan = await prerequisiteRepairs.planDocker(request.boxpilotSession.owner.id, request.body);
    response.status(201).json({ plan });
  } catch (error) {
    response.status(409).json({ error: error.message, code: "docker_repair_plan_failed" });
  }
});

app.post("/api/v1/prerequisite-repairs/virtualization/plans", async (request, response) => {
  try {
    const plan = await prerequisiteRepairs.planVirtualization(request.boxpilotSession.owner.id, request.body);
    response.status(201).json({ plan });
  } catch (error) {
    response.status(409).json({ error: error.message, code: "virtualization_repair_plan_failed" });
  }
});

app.post("/api/v1/prerequisite-repairs/apt-metadata/plans", async (request, response) => {
  try {
    const plan = await prerequisiteRepairs.planAptMetadata(request.boxpilotSession.owner.id, request.body);
    response.status(201).json({ plan });
  } catch (error) {
    response.status(409).json({ error: error.message, code: "apt_metadata_refresh_plan_failed" });
  }
});

app.post("/api/v1/prerequisite-repair-plans/:id/stage", async (request, response) => {
  try {
    if (!request.body || typeof request.body !== "object" || Array.isArray(request.body) || Object.keys(request.body).length !== 1 || typeof request.body.revision !== "string") throw new Error("Prerequisite repair staging accepts only the immutable revision");
    const job = await prerequisiteRepairs.stage(request.params.id, request.body.revision, request.boxpilotSession.owner.id);
    response.status(201).json({ job });
  } catch (error) {
    response.status(409).json({ error: error.message, code: "prerequisite_repair_stage_failed" });
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

app.get("/api/v1/network/flint2-adguard-acceptance", async (_request, response) => {
  response.json(await flint2Adguard.inspect());
});

app.post("/api/v1/network/flint2-adguard-acceptance/plans", async (request, response) => {
  try {
    response.status(201).json({ plan: await flint2Adguard.plan(request.boxpilotSession.owner.id, request.body) });
  } catch (error) {
    response.status(409).json({ error: error.message, code: "flint2_adguard_plan_failed" });
  }
});

app.post("/api/v1/network/flint2-adguard-acceptance/plans/:id/stage", async (request, response) => {
  try {
    if (!request.body || typeof request.body !== "object" || Array.isArray(request.body) || Object.keys(request.body).length !== 1 || typeof request.body.revision !== "string") throw new Error("Flint 2 acceptance staging accepts only the immutable revision");
    response.status(201).json({ job: await flint2Adguard.stage(request.params.id, request.body.revision, request.boxpilotSession.owner.id) });
  } catch (error) {
    response.status(409).json({ error: error.message, code: "flint2_adguard_stage_failed" });
  }
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

app.get("/api/v1/applications/keel/artifact", async (_request, response) => {
  try {
    response.json({ artifact: await keelArtifacts.inspect() });
  } catch (error) {
    response.status(503).json({ error: error.message, code: "keel_artifact_inspection_failed" });
  }
});

app.get("/api/v1/applications/keel/archive", async (_request, response) => {
  try {
    response.json({ archive: await helper.request("application.keel.archive.inspect", {}) });
  } catch (error) {
    response.status(503).json({ error: error.message, code: "keel_archive_inspection_failed" });
  }
});

app.post("/api/v1/applications/keel/artifact-plans", async (request, response) => {
  try {
    response.status(201).json({ plan: await keelArtifacts.plan(request.boxpilotSession.owner.id, request.body) });
  } catch (error) {
    response.status(409).json({ error: error.message, code: "keel_artifact_plan_failed" });
  }
});

app.post("/api/v1/keel-artifact-plans/:id/stage", async (request, response) => {
  try {
    if (!request.body || typeof request.body !== "object" || Array.isArray(request.body) || Object.keys(request.body).length !== 1 || typeof request.body.revision !== "string") throw new Error("Keel artifact staging accepts only the immutable revision");
    response.status(201).json({ job: await keelArtifacts.stage(request.params.id, request.body.revision, request.boxpilotSession.owner.id) });
  } catch (error) {
    response.status(409).json({ error: error.message, code: "keel_artifact_stage_failed" });
  }
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

app.post("/api/v1/applications/:id/action-plans", async (request, response) => {
  try {
    if (!request.body || typeof request.body !== "object" || Array.isArray(request.body) || Object.keys(request.body).length !== 1 || typeof request.body.action !== "string") throw new Error("Application lifecycle planning accepts only one fixed action");
    const plan = await applicationLifecycle.plan(request.params.id, request.body.action, request.boxpilotSession.owner.id);
    response.status(201).json({ plan });
  } catch (error) {
    const status = error.message === "Application lifecycle adapter not found" ? 404 : 409;
    response.status(status).json({ error: error.message, code: "application_lifecycle_plan_failed" });
  }
});

app.post("/api/v1/application-action-plans/:id/stage", async (request, response) => {
  try {
    if (!request.body || typeof request.body !== "object" || Array.isArray(request.body) || Object.keys(request.body).length !== 1 || typeof request.body.revision !== "string") throw new Error("Application lifecycle staging accepts only the immutable revision");
    const job = await applicationLifecycle.stage(request.params.id, request.body.revision, request.boxpilotSession.owner.id);
    response.status(201).json({ job });
  } catch (error) {
    response.status(409).json({ error: error.message, code: "application_lifecycle_stage_failed" });
  }
});

app.post("/api/v1/applications/:id/private-access-plans", async (request, response) => {
  try {
    if (!request.body || typeof request.body !== "object" || Array.isArray(request.body) || Object.keys(request.body).length !== 1 || typeof request.body.action !== "string") throw new Error("Private access planning accepts only one fixed action");
    const plan = await applicationPrivateAccess.plan(request.params.id, request.body.action, request.boxpilotSession.owner.id);
    response.status(201).json({ plan });
  } catch (error) {
    const status = error.message === "Private access adapter not found" ? 404 : 409;
    response.status(status).json({ error: error.message, code: "application_private_access_plan_failed" });
  }
});

app.post("/api/v1/application-private-access-plans/:id/stage", async (request, response) => {
  try {
    if (!request.body || typeof request.body !== "object" || Array.isArray(request.body) || Object.keys(request.body).length !== 1 || typeof request.body.revision !== "string") throw new Error("Private access staging accepts only the immutable revision");
    const job = await applicationPrivateAccess.stage(request.params.id, request.body.revision, request.boxpilotSession.owner.id);
    response.status(201).json({ job });
  } catch (error) {
    response.status(409).json({ error: error.message, code: "application_private_access_stage_failed" });
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

app.get("/api/v1/application-backup-protection", async (_request, response) => {
  response.json(await applicationProtection.list());
});

app.post("/api/v1/application-backups/:id/protection-plans", async (request, response) => {
  try {
    const plan = await applicationProtection.plan(request.params.id, request.boxpilotSession.owner.id);
    response.status(201).json({ plan });
  } catch (error) {
    response.status(400).json({ error: error.message, code: "application_protection_plan_failed" });
  }
});

app.post("/api/v1/application-protection-plans/:id/stage", async (request, response) => {
  try {
    const job = await applicationProtection.stage(request.params.id, request.body?.revision, request.boxpilotSession.owner.id);
    response.status(201).json({ job });
  } catch (error) {
    response.status(409).json({ error: error.message, code: "application_protection_stage_failed" });
  }
});

app.get("/api/v1/application-backup-retention", async (_request, response) => {
  try {
    response.json(await applicationRetention.inspect());
  } catch (error) {
    response.status(503).json({ error: error.message, code: "application_retention_inspection_failed" });
  }
});

app.post("/api/v1/application-retention-plans", async (request, response) => {
  try {
    const plan = await applicationRetention.plan(request.boxpilotSession.owner.id);
    response.status(201).json({ plan });
  } catch (error) {
    response.status(503).json({ error: error.message, code: "application_retention_plan_failed" });
  }
});

app.post("/api/v1/application-retention-plans/:id/stage", async (request, response) => {
  try {
    const job = await applicationRetention.stage(request.params.id, request.body?.revision, request.boxpilotSession.owner.id);
    response.status(201).json({ job });
  } catch (error) {
    const status = error.message === "Application retention plan not found" ? 404 : 409;
    response.status(status).json({ error: error.message, code: "application_retention_stage_failed" });
  }
});

app.get("/api/v1/keel-recoveries", (_request, response) => {
  response.json({ recoveries: keelRecoveries.list() });
});

app.post("/api/v1/application-backups/:id/keel-recovery-plans", async (request, response) => {
  try {
    const plan = await keelRecoveries.plan(request.params.id, request.boxpilotSession.owner.id);
    response.status(201).json({ plan });
  } catch (error) {
    const status = error.message === "Verified local Keel backup not found" ? 404 : 400;
    response.status(status).json({ error: error.message, code: "keel_recovery_plan_failed" });
  }
});

app.post("/api/v1/keel-recovery-plans/:id/stage", async (request, response) => {
  try {
    const job = await keelRecoveries.stage(request.params.id, request.body?.revision, request.boxpilotSession.owner.id);
    response.status(201).json({ job });
  } catch (error) {
    const status = error.message === "Keel recovery plan not found" ? 404 : 409;
    response.status(status).json({ error: error.message, code: "keel_recovery_stage_failed" });
  }
});

app.get("/api/v1/keel-recovery-drills", (_request, response) => {
  response.json({ drills: keelRecoveryDrills.list() });
});

app.post("/api/v1/keel-recoveries/:id/drill-plans", async (request, response) => {
  try {
    const plan = await keelRecoveryDrills.plan(request.params.id, request.boxpilotSession.owner.id);
    response.status(201).json({ plan });
  } catch (error) {
    const status = error.message === "Stopped Keel recovery clone not found" ? 404 : 400;
    response.status(status).json({ error: error.message, code: "keel_recovery_drill_plan_failed" });
  }
});

app.post("/api/v1/keel-recovery-drill-plans/:id/stage", async (request, response) => {
  try {
    const job = await keelRecoveryDrills.stage(request.params.id, request.body?.revision, request.boxpilotSession.owner.id);
    response.status(201).json({ job });
  } catch (error) {
    const status = error.message === "Keel recovery drill plan not found" ? 404 : 409;
    response.status(status).json({ error: error.message, code: "keel_recovery_drill_stage_failed" });
  }
});

app.get("/api/v1/keel-recovery-promotions", (_request, response) => {
  response.json({ promotions: keelPromotions.list() });
});

app.post("/api/v1/keel-recoveries/:id/promotion-plans", async (request, response) => {
  try {
    const plan = await keelPromotions.plan(request.params.id, request.boxpilotSession.owner.id);
    response.status(201).json({ plan });
  } catch (error) {
    const status = error.message === "Stopped Keel recovery clone not found" ? 404 : 400;
    response.status(status).json({ error: error.message, code: "keel_promotion_plan_failed" });
  }
});

app.post("/api/v1/keel-promotion-plans/:id/stage", async (request, response) => {
  try {
    const job = await keelPromotions.stage(request.params.id, request.body?.revision, request.boxpilotSession.owner.id);
    response.status(201).json({ job });
  } catch (error) {
    const status = error.message === "Keel production promotion plan not found" ? 404 : 409;
    response.status(status).json({ error: error.message, code: "keel_promotion_stage_failed" });
  }
});

app.get("/api/v1/keel-rollbacks", (_request, response) => {
  response.json({ rollbacks: keelRollbacks.list() });
});

app.post("/api/v1/keel-promotions/:id/rollback-plans", async (request, response) => {
  try {
    const plan = await keelRollbacks.plan(request.params.id, request.boxpilotSession.owner.id);
    response.status(201).json({ plan });
  } catch (error) {
    const status = error.message === "Rollback-backed Keel promotion not found" ? 404 : 400;
    response.status(status).json({ error: error.message, code: "keel_rollback_plan_failed" });
  }
});

app.post("/api/v1/keel-rollback-plans/:id/stage", async (request, response) => {
  try {
    const job = await keelRollbacks.stage(request.params.id, request.body?.revision, request.boxpilotSession.owner.id);
    response.status(201).json({ job });
  } catch (error) {
    const status = error.message === "Keel operator rollback plan not found" ? 404 : 409;
    response.status(status).json({ error: error.message, code: "keel_rollback_stage_failed" });
  }
});

app.get("/api/v1/controller-backup-protection", async (_request, response) => {
  response.json(await controllerProtection.list());
});

app.post("/api/v1/controller-backups/:id/protection-plans", async (request, response) => {
  try {
    const plan = await controllerProtection.plan(request.params.id, request.boxpilotSession.owner.id);
    response.status(201).json({ plan });
  } catch (error) {
    response.status(400).json({ error: error.message, code: "controller_protection_plan_failed" });
  }
});

app.post("/api/v1/controller-protection-plans/:id/stage", async (request, response) => {
  try {
    const job = await controllerProtection.stage(request.params.id, request.body?.revision, request.boxpilotSession.owner.id);
    response.status(201).json({ job });
  } catch (error) {
    response.status(409).json({ error: error.message, code: "controller_protection_stage_failed" });
  }
});

app.get("/api/v1/controller-backup-retention", async (_request, response) => {
  try {
    response.json(await controllerRetention.inspect());
  } catch (error) {
    response.status(503).json({ error: error.message, code: "controller_retention_inspection_failed" });
  }
});

app.post("/api/v1/controller-retention-plans", async (request, response) => {
  try {
    const plan = await controllerRetention.plan(request.boxpilotSession.owner.id);
    response.status(201).json({ plan });
  } catch (error) {
    response.status(503).json({ error: error.message, code: "controller_retention_plan_failed" });
  }
});

app.post("/api/v1/controller-retention-plans/:id/stage", async (request, response) => {
  try {
    const job = await controllerRetention.stage(request.params.id, request.body?.revision, request.boxpilotSession.owner.id);
    response.status(201).json({ job });
  } catch (error) {
    const status = error.message === "Controller retention plan not found" ? 404 : 409;
    response.status(status).json({ error: error.message, code: "controller_retention_stage_failed" });
  }
});

app.get("/api/v1/jobs", (request, response) => {
  response.json({ jobs: state.listJobs(request.query.limit) });
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

app.post("/api/v1/operations/canary", auth.requireCsrf, (request, response) => {
  const job = jobs.createCanary(request.boxpilotSession.owner.id);
  response.status(201).json({ job });
});

app.post("/api/v1/jobs/:id/approve", auth.requireCsrf, async (request, response) => {
  try {
    const candidate = state.getJob(request.params.id);
    const background = ["prerequisite.smartmontools.install", "prerequisite.restic.install", "prerequisite.docker.install", "prerequisite.virtualization.install", "prerequisite.apt-metadata.refresh", "virtualization.foundation.initialize", "application.pi-hole.deploy", "application.keel.artifact.acquire", "application.keel.stage", "application.keel.install", "controller.database.backup", "controller.database.backup.protect", "controller.database.backup.retention.apply", "application.backup.protect", "application.backup.retention.apply", "application.pi-hole.backup", "application.keel.backup", "application.keel.recovery.create", "application.keel.recovery-drill.run", "application.keel.promotion", "application.keel.rollback", "network.dns.acceptance.run", "migration.bundle.transfer", "virtualization.domain.export.create", "virtualization.export.backup.create", "virtualization.export.backup.retention.apply", "virtualization.export.backup.restore-drill", "virtualization.backup.recovery.create"].includes(candidate?.type) || (typeof candidate?.type === "string" && candidate.type.startsWith("op:"));
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

app.post("/api/v1/virtualization/foundation/plans", async (request, response) => {
  try {
    const plan = await libvirtFoundation.plan(request.boxpilotSession.owner.id, request.body);
    response.status(201).json({ plan });
  } catch (error) {
    response.status(409).json({ error: error.message, code: "libvirt_foundation_plan_failed" });
  }
});

app.post("/api/v1/virtualization/foundation/plans/:id/stage", async (request, response) => {
  try {
    const job = await libvirtFoundation.stage(request.params.id, request.body?.revision, request.boxpilotSession.owner.id);
    response.status(201).json({ job });
  } catch (error) {
    const status = error.message.includes("not found") ? 404 : 409;
    response.status(status).json({ error: error.message, code: "libvirt_foundation_stage_failed" });
  }
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

app.post("/api/v1/virtualization/media/import-plans", async (request, response) => {
  try {
    const plan = await vmMedia.plan(request.body?.filename, request.boxpilotSession.owner.id);
    response.status(201).json({ plan });
  } catch (error) {
    response.status(409).json({ error: error.message, code: "vm_media_import_plan_failed" });
  }
});

app.post("/api/v1/virtualization/media/import-plans/:id/stage", async (request, response) => {
  try {
    const job = await vmMedia.stage(request.params.id, request.body?.revision, request.boxpilotSession.owner.id);
    response.status(201).json({ job });
  } catch (error) {
    const status = error.message.includes("not found") ? 404 : 409;
    response.status(status).json({ error: error.message, code: "vm_media_import_stage_failed" });
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
  console.log(`BoxPilot ${productVersion} listening on http://${host}:${port}`);
  if (interruptedJobs) console.warn(`${interruptedJobs} interrupted job(s) marked failed for operator review.`);
  console.log("Safe mode: host mutations require durable plans, password approval, and typed helper operations.");
});
