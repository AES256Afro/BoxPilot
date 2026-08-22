import { chmod, mkdir, unlink } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { productVersion } from "./version.mjs";
import { registry } from "./ops/index.mjs";
import { createRunUnitClient } from "./run-unit.mjs";
import { createAppHelper } from "./app-helper.mjs";
import { createVmCloudHelper } from "./vm-cloud.mjs";
import { createHostInspectHelper } from "./host-inspect-helper.mjs";
import { executeHelperOperation } from "./helper-protocol.mjs";
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

const socketPath = process.env.BOXPILOT_HELPER_SOCKET ?? "/run/boxpilot/helper.sock";
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
const apps = createAppHelper();
const vmCloud = createVmCloudHelper();
const foundation = createLibvirtFoundationHelper();
const controllerBackups = createControllerBackupHelper();
const controllerProtection = createControllerProtectionHelper();
const controllerRetention = createControllerRetentionHelper({ inspectDestination: controllerProtection.inspect });
await controllerBackups.initialize();
await controllerProtection.initialize();
const recovery = await vmRestoreDrill.recoverOrphans();
const hostInspect = createHostInspectHelper();
const virtualization = createVmHelper();
const vmProtection = createVmProtectionHelper();
const machineSnapshot = createMachineSnapshotHelper({ controllerBackups });
const helperDependencies = { runUnit, apps, vmCloud, hostInspect, controllerBackups, controllerProtection, controllerRetention, prerequisites, foundation, vmMedia, virtualization, vmProtection, vmRestoreDrill, vmRecovery, vmRetention, machineSnapshot };
if (recovery.stoppedDomains > 0 || recovery.removedNvramFiles > 0 || recovery.normalizedWorkspaces > 0) {
  console.log(`BoxPilot restore drill recovery stopped=${recovery.stoppedDomains} nvram=${recovery.removedNvramFiles} workspaces=${recovery.normalizedWorkspaces}`);
}

// A task whose caller gave up can write its result hours later, into tmpfs nobody reads.
const swept = await runUnit.sweepStale().catch(() => ({ removed: 0 }));
if (swept.removed > 0) console.log(`Removed ${swept.removed} stale root-task file(s) from a previous run`);

await mkdir(path.dirname(socketPath), { recursive: true, mode: 0o750 });
await unlink(socketPath).catch((error) => {
  if (error.code !== "ENOENT") throw error;
});

const server = net.createServer({ allowHalfOpen: true }, (connection) => {
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
    } catch {
      reply({ version: 1, id: null, ok: false, error: "Malformed JSON request", code: "malformed_json" });
      return;
    }
    try {
      const registeredTimeout = registry.timeoutFor(request.operation);
      if (registeredTimeout) connection.setTimeout(registeredTimeout);
      let result;
      if (readOnlyOperations.has(request.operation)) {
        result = await reads.run(() => executeHelperOperation(request, helperDependencies));
      } else {
        const held = laneFor(request.operation, request.parameters);
        // Waiting behind another operation must not look like a hung request: a heartbeat line keeps
        // both idle timers alive, and the client ignores every line before the last one.
        let heartbeat = null;
        // Anything can be held up by the exclusive lane, and an exclusive request waits for every lane.
        const willWait = lanes.busy(held);
        if (willWait) {
          heartbeat = setInterval(() => {
            if (!connection.destroyed && connection.writable) connection.write(`${JSON.stringify({ version: 1, id: request?.id ?? null, queued: true, lane: held.join("+") })}\n`);
          }, queuedHeartbeatMs);
          heartbeat.unref?.();
        }
        try {
          result = await lanes.run(held, async () => {
            // The web side gave up while this waited: running it now would change the host with no job watching.
            // allowHalfOpen keeps `destroyed` false after the peer's FIN, so check the read side too.
            if (connection.destroyed || connection.readableEnded) throw new Error("The request was abandoned while it waited for an earlier operation on this subject");
            if (heartbeat) { clearInterval(heartbeat); heartbeat = null; }
            if (registeredTimeout) connection.setTimeout(registeredTimeout); // the operation's own budget starts now
            return executeHelperOperation(request, helperDependencies);
          });
        } finally {
          if (heartbeat) clearInterval(heartbeat);
        }
      }
      reply(result);
    } catch (error) {
      reply({ version: 1, id: request?.id ?? null, ok: false, error: error.message, code: "operation_failed" });
    }
  }

  connection.on("data", (chunk) => {
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
  connection.on("end", () => void respond());
  connection.on("timeout", () => connection.destroy());
});

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
