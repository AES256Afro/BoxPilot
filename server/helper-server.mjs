import { chmod, mkdir, unlink } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { createApplicationHelper } from "./application-helper.mjs";
import { createApplicationProtectionHelper } from "./application-protection-helper.mjs";
import { executeHelperOperation } from "./helper-protocol.mjs";
import { createVmRecoveryHelper } from "./vm-recovery-helper.mjs";
import { createVmRestoreDrillHelper } from "./vm-restore-drill-helper.mjs";
import { createVmRetentionHelper } from "./vm-retention-helper.mjs";
import { createMigrationTransferHelper } from "./migration-transfer-helper.mjs";
import { createPrerequisiteHelper } from "./prerequisite-helper.mjs";
import { createLibvirtFoundationHelper } from "./libvirt-foundation-helper.mjs";
import { createControllerBackupHelper } from "./controller-backup-helper.mjs";
import { createControllerProtectionHelper } from "./controller-protection-helper.mjs";
import { createControllerRetentionHelper } from "./controller-retention-helper.mjs";
import { createKeelDiscoveryHelper } from "./keel-discovery-helper.mjs";
import { createKeelArtifactHelper } from "./keel-artifact-helper.mjs";
import { createKeelArchiveHelper } from "./keel-archive-helper.mjs";
import { createKeelStageHelper } from "./keel-stage-helper.mjs";
import { createKeelInstallHelper } from "./keel-install-helper.mjs";
import { createKeelBackupHelper } from "./keel-backup-helper.mjs";
import { createKeelRecoveryHelper } from "./keel-recovery-helper.mjs";
import { createKeelRecoveryDrillHelper } from "./keel-recovery-drill-helper.mjs";
import { createKeelPromotionHelper } from "./keel-promotion-helper.mjs";
import { createKeelRollbackHelper } from "./keel-rollback-helper.mjs";
import { createApplicationRetentionHelper } from "./application-retention-helper.mjs";

const socketPath = process.env.BOXPILOT_HELPER_SOCKET ?? "/run/boxpilot/helper.sock";
const maxRequestBytes = 8192;
const readOnlyOperations = new Set(["canary.verify", "prerequisite.smartmontools.inspect", "prerequisite.restic.inspect", "prerequisite.docker.inspect", "prerequisite.virtualization.inspect", "prerequisite.apt-metadata.inspect", "container.docker.inspect", "container.docker.inventory", "system.logs.inspect", "controller.database.backup.inspect", "controller.database.protection.inspect", "controller.database.protection.retention.inspect", "application.backup.protection.inspect", "application.backup.protection.retention.inspect", "application.uptime-kuma.inspect", "application.uptime-kuma.lifecycle.inspect", "application.uptime-kuma.private-access.inspect", "application.pi-hole.inspect", "application.pi-hole.lifecycle.inspect", "application.keel.inspect", "application.keel.artifact.inspect", "application.keel.archive.inspect", "application.keel.stage.inspect", "application.keel.install.inspect", "application.keel.recovery.inspect", "application.keel.recovery-drill.inspect", "application.keel.promotion.inspect", "application.keel.rollback.inspect", "virtualization.foundation.inspect", "virtualization.inventory.inspect", "virtualization.console.inspect", "virtualization.domain.export.inspect", "virtualization.export.backup.inspect", "virtualization.export.backup.retention.inspect", "virtualization.export.backup.restore-drill.inspect", "virtualization.backup.recovery.inspect"]);
let operationQueue = Promise.resolve();
const vmRestoreDrill = createVmRestoreDrillHelper();
const vmRecovery = createVmRecoveryHelper({ restoreEngine: vmRestoreDrill });
const vmRetention = createVmRetentionHelper();
const migrations = createMigrationTransferHelper();
const applications = createApplicationHelper();
const applicationProtection = createApplicationProtectionHelper();
const applicationRetention = createApplicationRetentionHelper({ inspectDestination: applicationProtection.inspect });
const prerequisites = createPrerequisiteHelper();
const foundation = createLibvirtFoundationHelper();
const controllerBackups = createControllerBackupHelper();
const controllerProtection = createControllerProtectionHelper();
const controllerRetention = createControllerRetentionHelper({ inspectDestination: controllerProtection.inspect });
const keelDiscovery = createKeelDiscoveryHelper();
const keelArtifacts = createKeelArtifactHelper();
const keelArchive = createKeelArchiveHelper();
const keelStage = createKeelStageHelper({ artifactHelper: keelArtifacts, archiveHelper: keelArchive });
const keelInstall = createKeelInstallHelper({ stageHelper: keelStage });
const keelBackups = createKeelBackupHelper({ installHelper: keelInstall });
const keelRecovery = createKeelRecoveryHelper();
const keelRecoveryDrill = createKeelRecoveryDrillHelper();
const keelPromotion = createKeelPromotionHelper();
const keelRollback = createKeelRollbackHelper();
await controllerBackups.initialize();
await controllerProtection.initialize();
await applicationProtection.initialize();
await migrations.initialize();
const recovery = await vmRestoreDrill.recoverOrphans();
const applicationRecovery = await applications.recoverInterruptedPiholeBackup();
const keelBackupRecovery = await keelBackups.recoverInterrupted();
const keelDrillRecovery = await keelRecoveryDrill.recoverInterrupted();
const keelPromotionRecovery = await keelPromotion.recoverInterrupted();
const keelRollbackRecovery = await keelRollback.recoverInterrupted();
const helperDependencies = { applications, applicationProtection, applicationRetention, controllerBackups, controllerProtection, controllerRetention, keelDiscovery, keelArtifacts, keelArchive, keelStage, keelInstall, keelBackups, keelRecovery, keelRecoveryDrill, keelPromotion, keelRollback, migrations, prerequisites, foundation, vmRestoreDrill, vmRecovery, vmRetention };
if (recovery.stoppedDomains > 0 || recovery.removedNvramFiles > 0 || recovery.normalizedWorkspaces > 0) {
  console.log(`BoxPilot restore drill recovery stopped=${recovery.stoppedDomains} nvram=${recovery.removedNvramFiles} workspaces=${recovery.normalizedWorkspaces}`);
}
if (applicationRecovery.recovered) {
  console.log(`BoxPilot Pi-hole backup recovery sourceRestarted=${applicationRecovery.sourceRestarted} drillRemoved=${applicationRecovery.drillRemoved}`);
}
if (keelBackupRecovery.recovered || keelBackupRecovery.active) {
  console.log(`BoxPilot Keel backup recovery active=${keelBackupRecovery.active} restartRequested=${keelBackupRecovery.sourceRestartRequested} pathsRemoved=${keelBackupRecovery.generatedPathsRemoved}`);
}
if (keelDrillRecovery.recovered || keelDrillRecovery.active) {
  console.log(`BoxPilot Keel recovery drill reconciliation active=${keelDrillRecovery.active} resultRecovered=${keelDrillRecovery.resultRecovered} partialRemoved=${keelDrillRecovery.generatedPartialRemoved}`);
}
if (keelPromotionRecovery.recovered || keelPromotionRecovery.active) {
  console.log(`BoxPilot Keel promotion reconciliation active=${keelPromotionRecovery.active} previousProductionRestored=${keelPromotionRecovery.previousProductionRestored}`);
}
if (keelRollbackRecovery.recovered || keelRollbackRecovery.active) {
  console.log(`BoxPilot Keel operator rollback reconciliation active=${keelRollbackRecovery.active} currentProductionRestored=${keelRollbackRecovery.currentProductionRestored}`);
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
      if (request.operation === "virtualization.domain.export.create") connection.setTimeout(6 * 60 * 60 * 1000);
      if (request.operation === "virtualization.export.backup.create") connection.setTimeout(12 * 60 * 60 * 1000);
      if (request.operation === "virtualization.export.backup.retention.apply") connection.setTimeout(12 * 60 * 60 * 1000);
      if (request.operation === "virtualization.export.backup.restore-drill") connection.setTimeout(12 * 60 * 60 * 1000);
      if (request.operation === "virtualization.backup.recovery.create") connection.setTimeout(12 * 60 * 60 * 1000);
      if (request.operation === "migration.bundle.transfer") connection.setTimeout(12 * 60 * 60 * 1000);
      if (request.operation === "migration.bundle.inspect") connection.setTimeout(12 * 60 * 60 * 1000);
      if (request.operation === "application.pi-hole.deploy") connection.setTimeout(10 * 60 * 1000);
      if (request.operation === "application.pi-hole.backup") connection.setTimeout(10 * 60 * 1000);
      if (request.operation === "controller.database.backup.create") connection.setTimeout(10 * 60 * 1000);
      if (request.operation === "controller.database.protection.create") connection.setTimeout(12 * 60 * 60 * 1000);
      if (request.operation === "application.backup.protection.create") connection.setTimeout(12 * 60 * 60 * 1000);
      if (request.operation === "application.backup.protection.retention.apply") connection.setTimeout(12 * 60 * 60 * 1000);
      if (request.operation === "controller.database.protection.retention.apply") connection.setTimeout(12 * 60 * 60 * 1000);
      if (request.operation === "prerequisite.smartmontools.install") connection.setTimeout(15 * 60 * 1000);
      if (request.operation === "prerequisite.restic.install") connection.setTimeout(15 * 60 * 1000);
      if (request.operation === "prerequisite.apt-metadata.refresh") connection.setTimeout(15 * 60 * 1000);
      if (request.operation === "virtualization.foundation.initialize") connection.setTimeout(5 * 60 * 1000);
      if (request.operation === "application.keel.stage") connection.setTimeout(15 * 60 * 1000);
      if (request.operation === "application.keel.install") connection.setTimeout(15 * 60 * 1000);
      if (request.operation === "application.keel.backup") connection.setTimeout(20 * 60 * 1000);
      if (request.operation === "application.keel.recovery.create") connection.setTimeout(20 * 60 * 1000);
      if (request.operation === "application.keel.recovery-drill.create") connection.setTimeout(20 * 60 * 1000);
      if (request.operation === "application.keel.promotion.create") connection.setTimeout(20 * 60 * 1000);
      if (request.operation === "application.keel.rollback.create") connection.setTimeout(20 * 60 * 1000);
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
  console.log(`BoxPilot helper 0.60.0 listening on ${socketPath}`);
});

async function shutdown() {
  server.close(async () => {
    await unlink(socketPath).catch(() => {});
    process.exit(0);
  });
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
