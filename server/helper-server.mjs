import { chmod, mkdir, unlink } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { productVersion } from "./version.mjs";
import { registry } from "./ops/index.mjs";
import { createRunUnitClient } from "./run-unit.mjs";
import { createCredentialStore } from "./credentials.mjs";
import { createVpnProfileStore } from "./vpn-profile.mjs";
import { createAppHelper } from "./app-helper.mjs";
import { createVmCloudHelper } from "./vm-cloud.mjs";
import { createHostInspectHelper } from "./host-inspect-helper.mjs";
import { executeHelperOperation } from "./helper-protocol.mjs";
import { createHelperConnectionHandler } from "./helper-connection.mjs";
import { createAdmission, createConcurrencyGate, createLaneQueues } from "./helper-lanes.mjs";
import { createDrainedRestart, restartRefusalError } from "./self-restart.mjs";
import { resumeInterruptedBackups } from "./interrupted-backups.mjs";
import { createVmRecoveryHelper } from "./vm-recovery-helper.mjs";
import { createVmRestoreDrillHelper } from "./vm-restore-drill-helper.mjs";
import { createVmRetentionHelper } from "./vm-retention-helper.mjs";
import { createPrerequisiteHelper } from "./prerequisite-helper.mjs";
import { createLibvirtFoundationHelper } from "./libvirt-foundation-helper.mjs";
import { createControllerBackupHelper } from "./controller-backup-helper.mjs";
import { createControllerProtectionHelper } from "./controller-protection-helper.mjs";
import { createControllerRetentionHelper } from "./controller-retention-helper.mjs";
import { createVmMediaHelper } from "./vm-media-helper.mjs";
import { createVmHelper } from "./vm-helper.mjs";
import { createVmProtectionHelper } from "./vm-protection-helper.mjs";
import { createMachineSnapshotHelper } from "./machine-snapshot-helper.mjs";
import { createHousekeepingService } from "./housekeeping.mjs";
import { createPerformanceService } from "./performance.mjs";
import { createLocalDnsService } from "./local-dns.mjs";
import { fixedRun } from "./exec.mjs";

const socketPath = process.env.BOXPILOT_HELPER_SOCKET ?? "/run/boxpilot/helper.sock";
const idleGraceMs = 30_000;
const maxRequestBytes = 128 * 1024; // compose edits and key imports declare 64 KiB fields
const readOnlyOperations = new Set(registry.readOnlyIds());
const lanes = createLaneQueues();
// BoxPilot restarting itself after an upgrade or a KVM install: once no lane is held, waiting without
// holding any, then holding the exclusive lane so nothing new starts before it. From the moment it
// begins, what waits in a lane and what arrives is answered at once, with nothing done, while the web
// side is still there to record it: stopped first, it used to mark those jobs as cut off mid-run.
// The refusal carries its own code (helper_restarting), so the web side's job layer waits for
// BoxPilot to come back and sends it again once: an automation's next step, sent in the moment
// between its last step and the restart, is not lost to it (sweep 5).
let restarting = false;
const selfRestart = createDrainedRestart({ lanes, run: fixedRun, onRestarting: (active) => {
  restarting = active;
  if (!active) return;
  for (const queued of waiting) queued.refuse(restartRefusalError());
  waiting.clear();
} });
// Inspections do not queue per subject, so this is what stops a page in a reload loop from
// starting dozens of root child processes at once.
const reads = createConcurrencyGate(8);
// Mutations held at once, and the connections that leaves room for: 64 mutations, 8 reads running
// and 32 waiting (the gate above), and the rest for connections that have not sent their request yet.
const mutations = createAdmission(64);
const maxConnections = 128;
const queuedHeartbeatMs = 20_000;
/** Mutations waiting in a lane, not yet started. */
const waiting = new Set();
const vmRestoreDrill = createVmRestoreDrillHelper();
const vmRecovery = createVmRecoveryHelper({ restoreEngine: vmRestoreDrill });
const vmRetention = createVmRetentionHelper();
const vmMedia = createVmMediaHelper();
const prerequisites = createPrerequisiteHelper();
const runUnit = createRunUnitClient();
const credentials = createCredentialStore();
const vpnProfile = createVpnProfileStore();
// The port check before `compose up` needs the host's listeners, which this sandbox cannot see.
const apps = createAppHelper({ vpnProfile, hostListeners: async () => (await runUnit.runTask("host.listeners", {}, { timeoutMs: 30_000 })).listeners });
const vmCloud = createVmCloudHelper();
const foundation = createLibvirtFoundationHelper();
const controllerBackups = createControllerBackupHelper();
const controllerProtection = createControllerProtectionHelper();
const controllerRetention = createControllerRetentionHelper({ inspectDestination: controllerProtection.inspect });
await controllerBackups.initialize();
await controllerProtection.initialize();
/** @type {{ stoppedDomains: number, removedNvramFiles: number, normalizedWorkspaces: number, removedWorkspaces?: number, reclaimedBytes?: number, blocked?: string }} */
const recovery = await vmRestoreDrill.recoverOrphans().catch((error) => {
  console.error(`BoxPilot restore drill recovery could not finish: ${error.message}`);
  return { stoppedDomains: 0, removedNvramFiles: 0, normalizedWorkspaces: 0, blocked: error.message };
});
const hostInspect = createHostInspectHelper();
const virtualization = createVmHelper();
const vmProtection = createVmProtectionHelper();
const machineSnapshot = createMachineSnapshotHelper({ controllerBackups });
const housekeeping = createHousekeepingService({ apps, runUnit });
const performance = createPerformanceService();
const localDns = createLocalDnsService({ apps, runDocker: fixedRun });
const helperDependencies = { runUnit, credentials, vpnProfile, apps, housekeeping, performance, localDns, vmCloud, hostInspect, controllerBackups, controllerProtection, controllerRetention, prerequisites, foundation, vmMedia, virtualization, vmProtection, vmRestoreDrill, vmRecovery, vmRetention, machineSnapshot, selfRestart };
if (recovery.blocked) {
  console.error("BoxPilot is serving requests; restore drills stay unavailable until that is resolved.");
}
if (recovery.stoppedDomains > 0 || recovery.removedNvramFiles > 0 || recovery.normalizedWorkspaces > 0 || recovery.removedWorkspaces > 0) {
  const reclaimed = recovery.reclaimedBytes ? ` reclaimed=${(recovery.reclaimedBytes / 1024 ** 3).toFixed(1)}GiB` : "";
  console.log(`BoxPilot restore drill recovery stopped=${recovery.stoppedDomains} nvram=${recovery.removedNvramFiles} kept=${recovery.normalizedWorkspaces} removed=${recovery.removedWorkspaces ?? 0}${reclaimed}`);
}

// A task whose caller gave up can write its result hours later, into tmpfs nobody reads.
const swept = await runUnit.sweepStale().catch(() => ({ removed: 0 }));
if (swept.removed > 0) console.log(`Removed ${swept.removed} stale root-task file(s) from a previous run`);

// An app backup a power cut or a restart cut off left the app stopped, which Docker never undoes,
// and half an archive. Both are put right here: Docker may still be starting, so it is waited for
// outside any lane, and each app's lane is held only for its start (interrupted-backups.mjs).
void resumeInterruptedBackups(await apps.interruptedBackups().catch(() => []), { apps, lanes });

// A machine snapshot or a restore of one that a power cut or a restart cut off left its half-written
// archive and the folder it worked in, which hold the database and every app's .env in the clear;
// and an app data archive it was copying in from the mirror or a drive is left unfinished beside the
// app's backups. All run in this process, which has taken no request yet, so none can still be running.
const snapshotScraps = await machineSnapshot.sweepInterrupted().catch((error) => {
  console.error(`Clearing what an interrupted machine snapshot or restore left failed: ${error.message}`);
  return { removed: [] };
});
if (snapshotScraps.removed.length) console.log(`Removed what an interrupted machine snapshot or restore left: ${snapshotScraps.removed.join(", ")}`);

await mkdir(path.dirname(socketPath), { recursive: true, mode: 0o750 });
await unlink(socketPath).catch((error) => {
  if (error.code !== "ENOENT") throw error;
});

const handleConnection = createHelperConnectionHandler({
  registry, readOnlyOperations, lanes, reads, mutations, waiting, idleGraceMs, maxRequestBytes, queuedHeartbeatMs,
  isRestarting: () => restarting,
  execute: (request) => executeHelperOperation(request, helperDependencies),
});
const server = net.createServer({ allowHalfOpen: true }, handleConnection);
// Bound even peers that connect without submitting a request. The socket is local and group
// protected, but valid web requests must not turn into unlimited root-process connections.
server.maxConnections = maxConnections;

server.listen(socketPath, async () => {
  await chmod(socketPath, 0o660);
  console.log(`BoxPilot helper ${productVersion} listening on ${socketPath}`);
});

async function shutdown() {
  // Work already running drains (systemd allows it 90 seconds); work still queued never starts.
  for (const queued of waiting) queued.refuse();
  waiting.clear();
  server.close(async () => {
    await unlink(socketPath).catch(() => {});
    process.exit(0);
  });
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
