import express from "express";
import { randomUUID } from "node:crypto";
import { createReadStream, readFileSync } from "node:fs";
import { stat } from "node:fs/promises";
import { createDeviceResolver, createSnapshotDeviceResolver, deviceResolvingOperations } from "./catalog/devices.mjs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startTlsListener } from "./tls-listener.mjs";
import { productVersion } from "./version.mjs";
import { webHostOf, webPortOf } from "./env-file.mjs";
import { createCatalogService, installRiskLookup, secretEnvNamesLookup } from "./catalog/index.mjs";
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
import { createPushRouter } from "./routes/push.mjs";
import { createPushApprovals, defaultMayApprove } from "./push-approvals.mjs";
import { loadVapidKey } from "./web-push.mjs";
import { createHostRouter } from "./routes/host.mjs";
import { createFirewallRouter } from "./routes/firewall.mjs";
import { createStorageRouter } from "./routes/storage.mjs";
import { createPowerRouter } from "./routes/power.mjs";
import { createChecklistRouter } from "./routes/checklist.mjs";
import { createPeopleRouter } from "./routes/people.mjs";
import { createRunbookRouter } from "./routes/runbook.mjs";
import { createAssistantRouter } from "./routes/assistant.mjs";
import { createAgentsRouter } from "./routes/agents.mjs";
import { createAgentRunnerRouter } from "./routes/agent-runner.mjs";
import { apiRolePolicy } from "./routes/access.mjs";
import { createAssistantService } from "./assistant/index.mjs";
import { createAgentStore } from "./agents/store.mjs";
import { createAgentService } from "./agents/service.mjs";
import { createRateLimit } from "./agents/budget.mjs";
import { createHelperClient } from "./helper-client.mjs";
import { createHelperLibvirtService } from "./helper-libvirt.mjs";
import { createInventoryService } from "./inventory.mjs";
import { createStorageReader } from "./storage-inventory.mjs";
import { createJobService, recordFailed } from "./jobs.mjs";
import { planInterruptedReruns } from "./job-reruns.mjs";
import { invalidateOperationEvidence } from "./diagnostic-invalidation.mjs";
import { createLibvirtFoundationService } from "./libvirt-foundation.mjs";
import { createMaintenanceService } from "./maintenance.mjs";
import { createNetworkService } from "./network.mjs";
import { createDnsResilienceService, dnsAppIds, rehearsalSetting } from "./dns-resilience.mjs";
import { createOutageDnsWatch } from "./outage-dns.mjs";
import { createPrerequisiteService } from "./prerequisites.mjs";
import { createRecoveryKitService } from "./recovery-kit.mjs";
import { createRunbookService } from "./runbook-service.mjs";
import { createReleaseUpdateService } from "./release-updates.mjs";
import { createSetupService } from "./setup-profiles.mjs";
import { createUpdateNotifier } from "./update-notifier.mjs";
import { createHealthAlerts, jobNoticeKey, tellInterrupted } from "./health-alerts.mjs";
import { createWeeklyReport } from "./weekly-report.mjs";
import { buildChecklist, gatherChecklistEvidence } from "./setup-checklist.mjs";
import { createTlsRenewal } from "./tls-renewal.mjs";
import { createDiskSampler } from "./disk-forecast.mjs";
import { createAppDataSampler } from "./app-data-growth.mjs";
import { createSmartSampler } from "./smart-trends.mjs";
import { registry } from "./ops/index.mjs";
import { createNotificationService } from "./notifications.mjs";
import { createNotificationHistory } from "./notification-history.mjs";
import { createSchedulerService } from "./scheduler.mjs";
import { scrubStoredSecrets } from "./secret-scrub.mjs";
import { createFlowService } from "./flows.mjs";
import { createAutoReconnect } from "./auto-reconnect.mjs";
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
import { foldVerdict, verdictFrom } from "./backup-verdicts.mjs";
import { appStopClearingOperations, foldAppStop, seedAppStops } from "./app-stops.mjs";
import { jsonGzip, precompressedAssets } from "./compress.mjs";
import { rootFileHeaders, securityHeaders } from "./security-headers.mjs";

const app = express();
// As every reader of the env file takes them (server/env-file.mjs): the port with parseInt, since
// systemd hands over `9000   # moved off 8787` whole; loopback for an empty address, not every one.
const host = webHostOf(process.env.BOXPILOT_HOST);
const port = webPortOf(process.env.BOXPILOT_PORT);
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
// notify is called only at sign-in time, long after the health-alert ledger below is constructed. It
// goes through the ledger so a sign-in alert that reaches no one is kept as not announced (M27.2).
const auth = createAuthService(state, { resolveClientAddress: (request) => identity.clientAddress(request), notify: (payload) => healthAlerts.tell(payload) });
const helper = createHelperClient({ timeoutMs: 180000 });
const maintenance = createMaintenanceService();
const libvirt = createHelperLibvirtService({ helper });
const libvirtFoundation = createLibvirtFoundationService({ store: state, helper });
const prerequisites = createPrerequisiteService({
  stateDirectory: process.env.BOXPILOT_STATE_DIRECTORY ?? path.dirname(state.databasePath),
  helper,
});
const network = createNetworkService({ store: state });
// Whether the house keeps its DNS while this server is off (M39.2): read here, kept ten minutes.
const dnsResilience = createDnsResilienceService({ network, helper, store: state });
const githubProvenance = createGithubProvenanceService();
const releaseUpdates = createReleaseUpdateService();
const controllerProtection = createControllerProtectionService({ store: state, helper });
const controllerRetention = createControllerRetentionService({ store: state, helper });
const inventory = createInventoryService({ helper, maintenance });
// lsblk, findmnt and fstab for the Overview's drive checks, the weekly report and the runbook: one
// shared read held like the inventory, and dropped with it when an operation settles.
const storageRead = createStorageReader();
const vmCreation = createVmCreationService({ store: state, planner: vmPlanner, libvirt });
const vmMedia = createVmMediaService({ store: state, helper });
const vmExports = createVmExportService({ store: state, libvirt, helper });
const vmProtection = createVmProtectionService({ store: state, helper });
const vmRecoveries = createVmRecoveryService({ store: state, helper });
const vmRetention = createVmRetentionService({ store: state, helper });
const vmRestoreDrills = createVmRestoreDrillService({ store: state, helper });
const recoveryKit = createRecoveryKitService({ store: state, prerequisites, helper, libvirt });
// Anyone but the owner is shown only their own jobs, so their failed-job count is of their own (M29.4).
const actionCenter = createActionCenterService({ recoveryKit, inventory, listJobs: (createdBy) => state.listJobs(100, { createdBy }) });
const supportBundle = createSupportBundleService({ inventory, prerequisites, actionCenter, audit, helper, store: state });
const catalogService = createCatalogService();
// Device globs in manifests are resolved by this process: the helper's sandbox has no real /dev.
const withResolvedDevices = createDeviceResolver({ catalog: catalogService });
const withSnapshotDevices = createSnapshotDeviceResolver({ catalog: catalogService });
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

const secretEnvNamesFor = secretEnvNamesLookup(catalogService);
// Installing an app its manifest calls high risk (the house's DNS, the VPN) is staged and approved
// as high: the owner, with the password. The registry has the same hooks, so a card an agent or the
// assistant proposes says the tier the job will be staged at (sweep 3).
const operationRiskHooks = { "app.install": installRiskLookup(catalogService) };
registry.useRiskHooks(operationRiskHooks);
// Where alerts go, and the one ledger of what was announced and what could not be (M27.2). A failed
// scheduled run, an automation's step, or a result that could not be saved is announced through the
// health alerts, once per condition, so the notifier leaves those jobs alone. scheduler and flows are
// only read when a job event arrives, which is after notifications.start() below, once both exist.
// What BoxPilot told the owner and whether it arrived: the notification centre's record (M36).
const notificationHistory = createNotificationHistory({ store: state });
const notifications = createNotificationService({ store: state, history: notificationHistory, claimed: (job) => scheduler.owns(job.id) || flows.owns(job.id) || recordFailed(job) });
const healthAlerts = createHealthAlerts({ inventory, notifications, store: state, history: notificationHistory, resolveScheduleTitle: (operationId) => registry.get(operationId)?.title ?? operationId });
const jobs = createJobService(state, helper, {
  alerts: healthAlerts,
  onOperationSettled: (job) => invalidateOperationEvidence(job, { registry, inventory, prerequisites, helper, storage: storageRead }),
  secretEnvNamesFor,
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
    // A drive check's verdict is what Repair reads to know whether a drive that dropped has been
    // looked at since; the job itself is pruned within weeks.
    // markedDirty: an exFAT drive still carrying the kernel's "not properly unmounted" mark, which
    // the kernel repeats at every mount until a repairing check clears it (M26).
    "storage.check": (job, result) => state.updateSetting("driveChecks", {}, (entries) => ({ value: { ...(entries ?? {}), [result.name]: { checkedAt: result.checkedAt, clean: result.clean, checker: result.checker, summary: result.summary, markedDirty: result.markedDirty ?? null } } })),
    "app.vpn.killswitch.drill": (job, result) => state.updateSetting("killSwitchDrills", {}, (entries) => ({ value: { ...(entries ?? {}), [result.id]: { held: result.held, leaked: result.leaked, downForMs: result.downForMs, exitAfter: result.exitAfter ?? null, at: new Date().toISOString(), by: job.createdBy } } }), job.createdBy),
    // "The backups restore" has to be a record, not a hope: keep the last rehearsal verdict per app
    // so a schedule turns it into a history, and a failure is still visible after the job is pruned.
    "app.backup.verify": (job, result) => state.updateSetting("appBackupVerifications", {}, (entries) => ({ value: foldVerdict(entries, result.id, verdictFrom(result, job.createdBy)) }), job.createdBy),
    // Apps the owner stopped on purpose, so Home says "Stopped" rather than "not running"; anything
    // that brings the app back or replaces it clears it (server/app-stops.mjs).
    ...Object.fromEntries(["app.action", ...appStopClearingOperations].map((operation) => [operation, (job) => state.updateSetting("appStops", {}, (entries) => ({ value: foldAppStop(entries, job) }), job.createdBy)])),
    // Snapshot metadata (origin, size, time) lives here because lvs needs root; the Storage page merges it with lsblk.
    "storage.lvm.snapshot.create": (job, result) => state.updateSetting("lvmSnapshots", [], (entries) => ({ value: [...(entries ?? []).filter((entry) => entry.path !== result.path), { path: result.path, name: result.name, origin: result.origin, volumeGroup: result.volumeGroup, sizeGiB: result.sizeGiB, createdAt: result.createdAt, createdBy: job.createdBy, suffix: job.parameters?.suffix ?? null }] }), job.createdBy),
    // Read and write in one transaction rather than two statements that happen not to interleave.
    "storage.lvm.snapshot.delete": (job, result) => state.updateSetting("lvmSnapshots", [], (entries) => ({ value: (entries ?? []).filter((entry) => entry.path !== result.path) }), job.createdBy),
    "storage.lvm.snapshot.rollback": (job, result) => state.updateSetting("lvmSnapshots", [], (entries) => ({ value: (entries ?? []).filter((entry) => entry.path !== result.path) }), job.createdBy),
    // The Firewall page shows which profile is in force and when it was applied.
    "firewall.profile.apply": (job, result) => state.setSetting("firewallProfile", { id: result.profile, services: result.services ?? [], sshRateLimit: result.sshRateLimit ?? false, appliedAt: result.appliedAt, appliedBy: job.createdBy }, { updatedBy: job.createdBy }),
    // Editing rules by hand moves the box away from the profile, so the page stops claiming one is
    // in force rather than naming a profile whose rules are no longer what is loaded.
    "firewall.rule.add": (job) => markProfileEdited(job),
    "firewall.rule.delete": (job) => markProfileEdited(job),
    "backup.cloud.setup": (job, result) => state.setSetting("cloudDestination", result.destination, { updatedBy: job.createdBy }),
    "backup.cloud.sync": (job, result) => state.setSetting("cloudDestinationLastSync", { completedAt: result.completedAt, filesTransferred: result.filesTransferred, bytesTransferred: result.bytesTransferred, destination: result.destination, errors: result.errors ?? 0 }, { updatedBy: job.createdBy }),
    "backup.remote.sync": (job, result) => state.setSetting("backupDestinationLastSync", { completedAt: result.completedAt, filesTransferred: result.filesTransferred, bytesTransferred: result.bytesTransferred, destination: result.destination }, { updatedBy: job.createdBy }),
    // The VPN section reads this non-secret description; the profile's secrets stay in the root file.
    "vpn.profile.set": (job, result) => state.setSetting("vpnProfile", result, { updatedBy: job.createdBy }),
    "vpn.profile.clear": (job) => state.setSetting("vpnProfile", null, { updatedBy: job.createdBy }),
    // Repair's "Send alerts to the ntfy on this server" (M35): the helper proved the topic answers.
    "notifications.ntfy.connect": (job, result) => { notifications.adoptLocalNtfy(result, { updatedBy: job.createdBy }); },
    // M37: the helper checked the model is downloaded whole; the runner uses it from its next run.
    "agents.model.switch": (job, result) => agents.useModel(result, { actorId: job.createdBy }),
    "agents.runtime.install": (job, result) => agents.noteRuntimeInstalled(result, { actorId: job.createdBy }),
    // M37: a connector's documents, read in the root task with its credential, into the library.
    "agents.connector.sync": (job, result) => agents.ingestConnector(result, { actorId: job.createdBy }),
    // M38: where Zulip is and what Connect made; the bot's key stayed in the helper's credential store.
    "agents.zulip.connect": (job, result) => { agents.zulipConnected(result, { actorId: job.createdBy, boxpilotUrl: job.parameters?.boxpilotUrl ?? null }); },
    "agents.zulip.disconnect": (job) => { agents.zulipDisconnected({ actorId: job.createdBy }); },
    // M39.2: whether the router kept answering with the DNS app here stopped. The DNS check reads it
    // (a job is pruned within weeks; the verdict holds for ninety days).
    "dns.fallback.rehearse": (job, result) => {
      state.setSetting(rehearsalSetting, { router: result.router, app: result.app ?? null, appName: result.appName ?? null, passed: typeof result.passed === "boolean" ? result.passed : null, answered: result.answered, total: result.total, slowestMs: result.slowestMs ?? null, stoppedForMs: result.stoppedForMs ?? null, at: result.at ?? new Date().toISOString(), by: job.createdBy }, { updatedBy: job.createdBy });
      dnsResilience.forget();
    },
  },
  operationRiskHooks,
  // Prepare hooks pin server-derived expectations into the staged parameters.
  operationPrepareHooks: {
    // Device globs (/dev/sd?, /dev/ttyUSB?) resolve here against the real /dev; the helper runs with PrivateDevices.
    ...Object.fromEntries(deviceResolvingOperations.map((id) => [id, (parameters) => withResolvedDevices(parameters)])),
    // A snapshot restore installs apps too: each one that wants a device gets the ones found here.
    "host.snapshot.restore": (parameters) => withSnapshotDevices(parameters),
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
    // It never replaces a target set in Settings, which asks for the password there.
    "notifications.ntfy.connect": (parameters) => {
      if (notifications.describe().configured) throw new Error("A notification target is already set; change it under Settings, Notifications");
      return parameters ?? {};
    },
    // M37: the model agents use now is pinned into the job, so the root task can refuse to remove it.
    "agents.model.remove": (parameters) => ({ repo: parameters?.repo, file: parameters?.file, projector: parameters?.projector ?? null, current: agents.currentModel() }),
  },
  // Pinned again as the job is approved: what was pinned at staging may have changed since.
  operationApprovalHooks: {
    // A switch to the model a staged removal names, before it is approved, makes it the one in use.
    "agents.model.remove": (parameters) => ({ ...parameters, current: agents.currentModel() }),
  },
});
state.deleteExpiredSessions();
const interruptedJobs = state.recoverInterruptedJobs();
// A job, schedule or flow written before secrets were refused (M29.1) can still hold one in clear,
// and every controller backup copies it. Mask them before anything else reads them (M29.3).
try {
  const scrubbed = await scrubStoredSecrets({ store: state, registry, secretEnvNamesFor, holdsStagedSecrets: jobs.holdsStagedSecrets });
  if (scrubbed.secrets) console.warn(`[boxpilot] masked ${scrubbed.secrets} stored secret(s) in ${scrubbed.jobs} job(s), ${scrubbed.schedules} schedule(s) and ${scrubbed.flows} flow(s)`);
  if (scrubbed.unchecked) console.warn(`[boxpilot] ${scrubbed.unchecked} stored parameter set(s) could not be checked for secrets; they are checked again at the next start`);
} catch (error) {
  console.warn(`[boxpilot] stored parameters could not be checked for secrets: ${error.message}`);
}
// Apps stopped on purpose were first recorded in 1.137.0; an install that stopped some before then
// has them rebuilt once from its recent jobs, so Home does not call them down after the upgrade.
if (state.getSetting("appStops", null) === null) {
  try { state.setSetting("appStops", seedAppStops(state.listJobs(200)), { updatedBy: null }); } catch (error) { console.warn(`[boxpilot] apps stopped on purpose could not be read from recent jobs: ${error.message}`); }
}
const scheduler = createSchedulerService({ store: state, jobs, secretEnvNamesFor, alerts: healthAlerts });
// A job cut off by a restart - a crash, or BoxPilot updating itself mid-install - was marked failed
// in silence: recovery ran before the notifier existed, so the one failure that happens while the
// owner is away was the one never announced. A scheduled run's is its schedule's failure.
const scheduledInterrupted = new Set(scheduler.recover(interruptedJobs));
// M30.2: a job whose operation is safe to repeat runs again instead, once; started further down.
// A rerun that cannot start is told like any other interrupted job.
const tellOneInterrupted = (job) => { void tellInterrupted({ alerts: healthAlerts, store: state, interrupted: [job], owned: scheduledInterrupted }); };
const interruptedReruns = planInterruptedReruns(interruptedJobs, { store: state, jobs, scheduled: scheduledInterrupted, announce: tellOneInterrupted });
// The rest are told through the ledger, kept as not announced if the push reaches no one. This runs
// before flows.start() below, which rewrites the flows whose steps it must leave to them.
void tellInterrupted({ alerts: healthAlerts, store: state, interrupted: interruptedJobs.filter((job) => !interruptedReruns.has(job.id)), owned: scheduledInterrupted });
// Running the same operation cleanly again answers an interruption nobody was told about.
state.subscribeJobs((job) => { if (job.state === "completed") healthAlerts.clear(jobNoticeKey("job.interrupted", job), { quietly: true }).catch(() => {}); });
// A flow announces its own failures, steps included, once per flow until it next runs cleanly.
const { library: flowLibrary, problems: flowLibraryProblems } = await loadFlowLibrary().catch(() => ({ library: [], problems: [] }));
if (flowLibraryProblems.length) console.warn(`[boxpilot] flow library problems: ${flowLibraryProblems.map((problem) => `${problem.file}: ${problem.errors.join("; ")}`).join(" | ")}`);
const flows = createFlowService({ store: state, jobs, secretEnvNamesFor, library: flowLibrary, alerts: healthAlerts });
// M26.5: a drive somebody armed is reconnected when a health round finds it dead or read-only,
// through its own flow and within a cooldown, a daily cap and a hold after any failure.
const autoReconnect = createAutoReconnect({ store: state, flows, alerts: healthAlerts });
notifications.start();
// A run the restart stopped between two steps goes on from the step that had not begun (sweep 5).
flows.start({ interrupted: interruptedJobs });
autoReconnect.start();
scheduler.start();
// Once the notifier listens, so a rerun that fails at once is still announced.
void interruptedReruns.start().catch(() => {});
// Push approvals (M25.2): a job left waiting for a person is pushed to the phones of whoever may
// approve it, as a title and a link to the approval - never the approval itself. The app's name in
// the title comes from the catalog, never from what the job was given.
let catalogNames = new Map();
const readCatalogNames = () => catalogService.all().then(({ manifests }) => { catalogNames = new Map(manifests.map((manifest) => [manifest.id, manifest.name])); }).catch(() => {});
void readCatalogNames();
setInterval(readCatalogNames, 3600_000).unref?.();
const pushApprovals = createPushApprovals({
  store: state, notifications, history: notificationHistory,
  loadVapid: () => loadVapidKey(process.env.BOXPILOT_PUSH_DIR ?? path.join(process.env.BOXPILOT_STATE_DIRECTORY ?? path.dirname(state.databasePath), "push")),
  subjectOf: (job) => (String(job?.type).startsWith("op:app.") && typeof job?.parameters?.id === "string" ? catalogNames.get(job.parameters.id) ?? null : null),
  mayApprove: (store, job) => defaultMayApprove(store, job, { minimumRole: jobs.approvalPolicy(job).minimumRole }),
  contact: process.env.BOXPILOT_PUSH_CONTACT ?? null,
});
pushApprovals.start();
const setup = createSetupService({ helper, scheduler, installRisk: installRiskLookup(catalogService) });
createUpdateNotifier({ releaseUpdates, notifications, alerts: healthAlerts, store: state }).start();
// The weekly self-report (M30.4). "Not covered yet" asks what the Overview's checklist asks, plus
// which apps with data worth keeping have no backup schedule; either may fail, and is then left out.
const weeklyReport = createWeeklyReport({
  store: state, alerts: healthAlerts, notifications,
  coverage: async () => {
    const [evidence, protection] = await Promise.all([
      gatherChecklistEvidence({ state, helper, notifications, inventory, network, storage: storageRead }).catch(() => null),
      helper.request("app.backup.protection", {}, { timeoutMs: 60_000 }).catch(() => null),
    ]);
    return { checklist: evidence ? buildChecklist(evidence) : null, protection };
  },
});
weeklyReport.start();
healthAlerts.start();
// Reissue the LAN certificate before it expires, reusing its CA so trusted devices stay trusted (M18.2).
createTlsRenewal({ helper, store: state }).start();
// Sample free space daily so the disk-fill forecast (M23.1) has a trend to project.
createDiskSampler({ inventory, store: state }).start();
// What is filling each drive, not just that it is filling (M23.1). Walks the data folders, so it
// runs once a day and well after boot rather than alongside everything else that starts here.
createAppDataSampler({ helper, store: state }).start();
// Sample SMART numbers daily so a drive going bad is caught before it fails (M23.3).
createSmartSampler({ inventory, store: state }).start();
// After a boot that followed a power cut (M39.2): does the DNS app answer on the LAN, and does this
// server look names up? Both go on the outage's record, a few minutes in.
createOutageDnsWatch({
  store: state, helper, network,
  dnsApp: async () => {
    const [live, catalog] = await Promise.all([helper.request("app.inspect", {}, { timeoutMs: 60_000 }), catalogService.all().catch(() => ({ manifests: [] }))]);
    const app = (live?.applications ?? []).find((entry) => entry.installed && dnsAppIds.includes(entry.id));
    return app ? { id: app.id, name: catalog.manifests.find((manifest) => manifest.id === app.id)?.name ?? app.id } : null;
  },
}).start();
// The local assistant (M34): its model is only ever a local one, found when someone asks. Its index
// of BoxPilot's documents, registry and catalog is built the first time anyone asks or reads its
// status, not here: most servers never run a model, and building it at every start cost ~50 ms of
// CPU and kept ~3 MiB of heap (7 MiB before its postings were packed) for nothing.
const assistant = createAssistantService({ state, registry, catalog: catalogService, helper, inventory, secretEnvNamesFor });
// Agents (M37): their specs, runs and notes live here; the model runs only in the capped
// boxpilot-agents.service, which asks this process for work and for read-only tools. Off until the
// owner turns Agents on; with none made, a minute's timer that finds nothing to do.
const agentStore = createAgentStore({ databasePath: state.databasePath });
const agents = createAgentService({
  state, store: agentStore, registry, helper, inventory, knowledge: assistant.index, secretEnvNamesFor, healthAlerts, productVersion,
  // The daily look for a newer small Qwen reads Hugging Face's public model list; it never switches anything.
  fetchJson: (url) => fetch(url, { headers: { Accept: "application/json", "User-Agent": `BoxPilot/${productVersion}` }, signal: AbortSignal.timeout(15_000), redirect: "error" }).then((response) => (response.ok ? response.json() : null)),
});
agents.start({ subscribeJobs: (listener) => state.subscribeJobs(listener), afterRound: (listener) => healthAlerts.afterRound(listener) });

app.disable("x-powered-by");
app.use(jsonGzip());
app.use(express.json({ limit: "256kb", strict: true }));
// The policy's script hash comes from the shell as built, so the theme bootstrap that has always
// been inline is allowed by its own digest rather than blocked - which is what `script-src 'self'`
// alone had been doing to it.
let shell = "";
try { shell = readFileSync(path.join(dist, "index.html"), "utf8"); } catch { /* no build yet: a strict policy with no inline allowances is the right answer */ }
app.use(securityHeaders({ html: shell }));

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
// Start an agent by webhook (M37), the same door as a flow's: the token is the auth, only its digest
// is kept, a wrong one looks like a missing agent, and nothing from the request reaches the run -
// the caller chooses only when the agent does its job, never what it does.
app.post("/api/v1/hooks/agents/:id/:token", (request, response) => {
  const outcome = agents.fireAgentWebhook(request.params.id, request.params.token, { source: request.get("user-agent") ?? null });
  if (outcome === "accepted") return response.status(202).json({ accepted: true });
  if (outcome === "rate-limited") return response.status(429).json({ error: "This agent's webhook is being fired too often; wait a minute" });
  return response.status(404).json({ error: "Not found" });
});
// The agents runner's own door (M37), also before the session wall: one scoped key, loopback only,
// and its routes can only take work, report it and ask for read-only tools (routes/access.mjs).
app.use("/api/v1", createAgentRunnerRouter({ agents, limit: createRateLimit({ capacity: 100, refillPerSecond: 40 }) }));

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
  return auth.requireCsrf(request, response, next); // async: Express 5 handles what it returns
});

// Roles (M5.4): viewers may only look (plus read-only operation runs); operators may not change
// settings or manage people; disabled accounts get nothing. High-risk staging/approval is
// enforced in jobs.mjs. Owners pass through. What a composite route may show each role is in
// routes/access.mjs too (M29.4); the route-matrix test mounts this same policy.
app.use("/api/v1", apiRolePolicy());
app.use("/api/v1/people", auth.requireRole("owner"));
app.use("/api/v1", createPeopleRouter({ state, auth }));
app.use("/api/v1", createOperationsRouter({ state, helper, jobs, prerequisites, recoveryKit, actionCenter, auth }));
app.use("/api/v1", createJobsRouter({ state, jobs, scheduler, flows, autoReconnect, helper, jobLogReader, auth }));
app.use("/api/v1", createVirtualizationRouter({ libvirt, libvirtFoundation, vmPlanner, vmMedia, vmCreation, vmExports, vmProtection, vmRetention, vmRecoveries, audit }));
app.use("/api/v1", createSettingsRouter({ state, notifications, notificationHistory, weeklyReport, auth }));
app.use("/api/v1", createPushRouter({ push: pushApprovals, auth }));
app.use("/api/v1", createFirewallRouter({ state, helper, catalogService, webPort: port, webHost: host }));
app.use("/api/v1", createStorageRouter({ auth, helper, inventory, state }));
app.use("/api/v1", createPowerRouter());
app.use("/api/v1", createChecklistRouter({ state, helper, notifications, inventory, network, storage: storageRead }));
app.use("/api/v1", createHostRouter({ state, helper, catalogService, inventory, network, dnsResilience, notifications, controllerProtection, controllerRetention, githubProvenance, releaseUpdates, setup, supportBundle, audit, auth, identity, webHost: host, webPort: port }));
app.use("/api/v1", createOidcAdminRouter({ oidc, auth }));
// The runbook for this server (M34.4), from the same services the pages read.
const runbook = createRunbookService({ store: state, helper, catalogService, inventory, network, notifications, autoReconnect, identity, secretEnvNamesFor, collect: storageRead, webHost: host, webPort: port, tlsDir });
app.use("/api/v1", createRunbookRouter({ runbook, auth }));
app.use("/api/v1", createAssistantRouter({ assistant, state, auth }));
app.use("/api/v1", createAgentsRouter({ agents, state, auth }));

// OIDC provider endpoints (M19.3) live at the site root, not under /api/v1: discovery, JWKS, token
// and userinfo are public by design, and /oidc/authorize reads the owner's session itself.
app.use(createOidcRouter({ oidc, auth, store: state }));

const assets = path.join(dist, "assets");
app.use("/assets", precompressedAssets(assets));
app.use("/assets", express.static(assets, { index: false, maxAge: "365d", immutable: true }));
app.use(express.static(dist, { index: false, setHeaders: rootFileHeaders }));
app.use((request, response, next) => {
  if (request.method !== "GET" || request.path.startsWith("/api/")) {
    next();
    return;
  }
  // A hashed asset that is not there is missing, not a route into the app. Answering it with the
  // shell hides the real problem behind a page that cannot work, and during an upgrade - when the
  // tree is swapped out from under a browser that is still fetching the old bundle - it means
  // replying to a request for JavaScript with HTML.
  if (request.path.startsWith("/assets/")) {
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
const pruneHistory = () => { try { state.pruneHistory(); jobs.pruneStagedSecrets?.(); } catch (error) { console.warn(`History pruning failed: ${error.message}`); } };
setInterval(() => { try { jobs.pruneStagedSecrets(); } catch (error) { console.warn(`Staged credential expiry failed: ${error.message}`); } }, 60_000).unref?.();
setTimeout(pruneHistory, 2 * 60_000).unref?.();
setInterval(pruneHistory, 24 * 3600_000).unref?.();
// Staged jobs nobody will approve (M36): superseded ones (an update to a version this one already
// is) go at startup, which is right after an update lands; ones left waiting a week, hourly.
const sweepApprovals = () => {
  try {
    const swept = jobs.sweepStaleApprovals();
    if (swept.length) console.log(`Cancelled ${swept.length} staged job(s) nobody will approve: ${swept.map((entry) => `${entry.id} (${entry.why})`).join(", ")}`);
  } catch (error) { console.warn(`Stale approval sweep failed: ${error.message}`); }
};
sweepApprovals();
setInterval(sweepApprovals, 3600_000).unref?.();

app.listen(port, host, () => {
  console.log(`BoxPilot ${productVersion} listening on http://${host}:${port}`);
  if (interruptedJobs.length) console.warn(`${interruptedJobs.length} interrupted job(s) marked failed for operator review.`);
});

// The encrypted LAN listener (M18.2), if a certificate has been provisioned. Never fatal: the HTTP
// listener and the Tailscale Serve path above keep working regardless.
startTlsListener(app, { host });
