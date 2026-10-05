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
import { helperErrorReply, helperQueuedFrame, helperStartedFrame } from "./helper-response.mjs";
import { createConcurrencyGate, createLaneQueues, laneFor } from "./helper-lanes.mjs";
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
const legacyReadOnlyOperations = new Set(["container.docker.inspect", "container.docker.inventory", "controller.database.backup.inspect", "controller.database.protection.inspect", "controller.database.protection.retention.inspect", "virtualization.foundation.inspect", "virtualization.media.inspect", "virtualization.inventory.inspect", "virtualization.console.inspect", "virtualization.domain.export.inspect", "virtualization.export.backup.inspect", "virtualization.export.backup.retention.inspect", "virtualization.export.backup.restore-drill.inspect", "virtualization.backup.recovery.inspect"]);
const readOnlyOperations = new Set([...registry.readOnlyIds(), ...legacyReadOnlyOperations]);
const lanes = createLaneQueues();
// Inspections do not queue per subject, so this is what stops a page in a reload loop from
// starting dozens of root child processes at once.
const reads = createConcurrencyGate(8);
const queuedHeartbeatMs = 20_000;
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
const helperDependencies = { runUnit, credentials, vpnProfile, apps, housekeeping, performance, localDns, vmCloud, hostInspect, controllerBackups, controllerProtection, controllerRetention, prerequisites, foundation, vmMedia, virtualization, vmProtection, vmRestoreDrill, vmRecovery, vmRetention, machineSnapshot };
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
// and half an archive. Both are put right here, each under its app's lane so nothing that arrives
// once the socket is up reaches the app first; Docker may still be starting, so this waits for it.
for (const entry of await apps.interruptedBackups().catch(() => [])) {
  void lanes.run([`app:${entry.id}`], () => apps.resumeInterruptedBackup(entry)).then((outcome) => {
    if (outcome.restarted) console.log(`Started ${entry.id} again: a backup begun at ${entry.startedAt ?? "an unknown time"} had stopped it and was cut off`);
    else if (outcome.error) console.error(`${entry.id} was stopped by a backup that was cut off, and could not be started again: ${outcome.error}`);
    if (outcome.removedPartial) console.log(`Removed the unfinished backup archive ${entry.partial} of ${entry.id}`);
  }, (error) => console.error(`Recovering ${entry.id} after an interrupted backup failed: ${error.message}`));
}

// A machine snapshot or a restore of one that a power cut or a restart cut off left its half-written
// archive and the folder it worked in, which hold the database and every app's .env in the clear.
// Both run in this process, which has taken no request yet, so neither can still be running.
const snapshotScraps = await machineSnapshot.sweepInterrupted().catch((error) => {
  console.error(`Clearing what an interrupted machine snapshot or restore left failed: ${error.message}`);
  return { removed: [] };
});
if (snapshotScraps.removed.length) console.log(`Removed what an interrupted machine snapshot or restore left: ${snapshotScraps.removed.join(", ")}`);

await mkdir(path.dirname(socketPath), { recursive: true, mode: 0o750 });
await unlink(socketPath).catch((error) => {
  if (error.code !== "ENOENT") throw error;
});

const server = net.createServer({ allowHalfOpen: true }, (connection) => {
  const abandoned = new AbortController();
  connection.once("close", () => abandoned.abort());
  // The web side destroys its socket when a request times out or the service restarts. Writing the
  // reply then raises EPIPE, and an unhandled 'error' here would take the root helper down mid-operation.
  connection.on("error", () => connection.destroy());
  /** Send a reply only if the peer is still there. */
  const reply = (payload) => { if (!connection.destroyed && connection.writable) connection.end(`${JSON.stringify(payload)}\n`); else connection.destroy(); };
  connection.setEncoding("utf8");
  connection.setTimeout(180000);
  let payload = "";
  let handled = false;

  async function respond() {
    if (handled) return;
    handled = true;
    let request;
    try {
      request = JSON.parse(payload);
      payload = "";
    } catch {
      reply({ version: 1, id: null, ok: false, error: "Malformed JSON request", code: "malformed_json" });
      return;
    }
    try {
      // The budget this request runs under: the operation's own, or a larger one a job was given
      // with "Try again with more time" (the protocol validator checks it against the registry).
      // The idle limit sits a little past it, so the web side's deadline - the one that records the
      // timeout on the job - is the one that fires, and this stays the backstop for a dead peer.
      const budget = registry.budgetFor(request.operation, request.context?.budgetMs ?? null);
      const registeredTimeout = budget ? budget + idleGraceMs : null;
      if (registeredTimeout) connection.setTimeout(registeredTimeout);
      let result;
      if (readOnlyOperations.has(request.operation)) {
        result = await reads.run(() => executeHelperOperation(request, helperDependencies), { signal: abandoned.signal });
      } else {
        const held = laneFor(request.operation, request.parameters);
        // Waiting behind another operation must not look like a hung request: a heartbeat line keeps
        // both idle timers alive; the client reads those lines as progress, not as the reply.
        let heartbeat = null;
        // Anything can be held up by the exclusive lane, and an exclusive request waits for every lane.
        const willWait = lanes.busy(held);
        const frame = (value) => { if (!connection.destroyed && connection.writable) connection.write(`${JSON.stringify(value)}\n`); };
        if (willWait) {
          // Say so at once: the client holds a queued request to its queue ceiling rather than the
          // operation's own budget, which starts only when the "started" frame below arrives.
          frame(helperQueuedFrame(request?.id ?? null, held.join("+")));
          heartbeat = setInterval(() => frame(helperQueuedFrame(request?.id ?? null, held.join("+"))), queuedHeartbeatMs);
          heartbeat.unref?.();
        }
        try {
          result = await lanes.run(held, async () => {
            // The web side gave up while this waited: running it now would change the host with no job watching.
            // allowHalfOpen keeps `destroyed` false after the peer's FIN, so check the read side too.
            if (connection.destroyed || connection.readableEnded) throw new Error("The request was abandoned while it waited for an earlier operation on this subject");
            if (heartbeat) { clearInterval(heartbeat); heartbeat = null; }
            if (registeredTimeout) connection.setTimeout(registeredTimeout); // the operation's own budget starts now
            if (willWait) frame(helperStartedFrame(request.id)); // ...and the client's deadline restarts with it
            return executeHelperOperation(request, helperDependencies);
          });
        } finally {
          if (heartbeat) clearInterval(heartbeat);
        }
      }
      reply(result);
    } catch (error) {
      // A step that ran out of its own time, and whether a rollback worked, go in fields.
      reply(helperErrorReply(request?.id ?? null, error));
    }
  }

  connection.on("data", (chunk) => {
    if (handled) return;
    payload += chunk;
    if (Buffer.byteLength(payload, "utf8") > maxRequestBytes) {
      handled = true;
      reply({ version: 1, id: null, ok: false, error: "Request is too large", code: "request_too_large" });
      return;
    }
    if (payload.includes("\n")) {
      payload = payload.slice(0, payload.indexOf("\n"));
      void respond();
    }
  });
  connection.on("end", () => {
    // Official clients keep the request side open until the reply. A FIN after submission
    // means that caller has gone; release a queued read before it starts expensive host work.
    if (handled) abandoned.abort();
    else void respond();
  });
  connection.on("timeout", () => connection.destroy());
});
// Bound even peers that connect without submitting a request. The socket is local and group
// protected, but valid web requests must not turn into unlimited root-process connections.
server.maxConnections = 64;

server.listen(socketPath, async () => {
  await chmod(socketPath, 0o660);
  console.log(`BoxPilot helper ${productVersion} listening on ${socketPath}`);
});

async function shutdown() {
  server.close(async () => {
    await unlink(socketPath).catch(() => {});
    process.exit(0);
  });
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
