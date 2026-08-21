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
const maxRequestBytes = 8192;
const legacyReadOnlyOperations = new Set(["container.docker.inspect", "container.docker.inventory", "controller.database.backup.inspect", "controller.database.protection.inspect", "controller.database.protection.retention.inspect", "virtualization.foundation.inspect", "virtualization.media.inspect", "virtualization.inventory.inspect", "virtualization.console.inspect", "virtualization.domain.export.inspect", "virtualization.export.backup.inspect", "virtualization.export.backup.retention.inspect", "virtualization.export.backup.restore-drill.inspect", "virtualization.backup.recovery.inspect"]);
const readOnlyOperations = new Set([...registry.readOnlyIds(), ...legacyReadOnlyOperations]);
let operationQueue = Promise.resolve();
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

await mkdir(path.dirname(socketPath), { recursive: true, mode: 0o750 });
await unlink(socketPath).catch((error) => {
  if (error.code !== "ENOENT") throw error;
});

const server = net.createServer({ allowHalfOpen: true }, (connection) => {
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
      connection.end(`${JSON.stringify({ version: 1, id: null, ok: false, error: "Malformed JSON request", code: "malformed_json" })}\n`);
      return;
    }
    try {
      const registeredTimeout = registry.timeoutFor(request.operation);
      if (registeredTimeout) connection.setTimeout(registeredTimeout);
      const execution = readOnlyOperations.has(request.operation)
        ? executeHelperOperation(request, helperDependencies)
        : operationQueue.then(() => executeHelperOperation(request, helperDependencies));
      if (!readOnlyOperations.has(request.operation)) operationQueue = execution.catch(() => {});
      connection.end(`${JSON.stringify(await execution)}\n`);
    } catch (error) {
      connection.end(`${JSON.stringify({ version: 1, id: request?.id ?? null, ok: false, error: error.message, code: "operation_failed" })}\n`);
    }
  }

  connection.on("data", (chunk) => {
    payload += chunk;
    if (Buffer.byteLength(payload, "utf8") > maxRequestBytes) {
      handled = true;
      connection.end(`${JSON.stringify({ version: 1, id: null, ok: false, error: "Request is too large", code: "request_too_large" })}\n`);
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
