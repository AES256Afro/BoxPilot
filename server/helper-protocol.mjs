import net from "node:net";
import { createApplicationHelper } from "./application-helper.mjs";
import { createApplicationProtectionHelper, validateApplicationProtectionInput } from "./application-protection-helper.mjs";
import { createVmHelper } from "./vm-helper.mjs";
import { validateDomainName } from "./libvirt.mjs";
import { validateVmExportInput } from "./vm-export.mjs";
import { validateVmPlanInput } from "./vm-plan.mjs";
import { validateVmLifecycleInput } from "./vm-lifecycle.mjs";
import { validateVmSnapshotInput } from "./vm-snapshot.mjs";
import { createVmProtectionHelper, validateVmProtectionInput } from "./vm-protection-helper.mjs";
import { createVmRecoveryHelper, validateVmRecoveryInput } from "./vm-recovery-helper.mjs";
import { createVmRetentionHelper, validateVmRetentionInput } from "./vm-retention-helper.mjs";
import { createVmRestoreDrillHelper, validateVmRestoreDrillInput } from "./vm-restore-drill-helper.mjs";
import { createMigrationTransferHelper, validateMigrationTransferInput } from "./migration-transfer-helper.mjs";
import { createPrerequisiteHelper } from "./prerequisite-helper.mjs";
import { createControllerBackupHelper, controllerBackupHelperInternals } from "./controller-backup-helper.mjs";
import { createControllerProtectionHelper, validateControllerProtectionInput } from "./controller-protection-helper.mjs";
import { createControllerRetentionHelper, validateControllerRetentionInput } from "./controller-retention-helper.mjs";
import { createKeelDiscoveryHelper } from "./keel-discovery-helper.mjs";
import { createKeelArtifactHelper } from "./keel-artifact-helper.mjs";
import { createKeelArchiveHelper } from "./keel-archive-helper.mjs";
import { createKeelStageHelper } from "./keel-stage-helper.mjs";
import { createKeelInstallHelper } from "./keel-install-helper.mjs";
import { createKeelLoginProofHelper } from "./keel-login-proof-helper.mjs";
import { createKeelBackupHelper } from "./keel-backup-helper.mjs";
import { createKeelRecoveryHelper, validateKeelRecoveryInput } from "./keel-recovery-helper.mjs";
import { createKeelRecoveryDrillHelper, validateKeelRecoveryDrillCreateInput, validateKeelRecoveryDrillInspectInput } from "./keel-recovery-drill-helper.mjs";
import { createKeelPromotionHelper, validateKeelPromotionCreateInput, validateKeelPromotionInspectInput } from "./keel-promotion-helper.mjs";
import { createKeelRollbackHelper, validateKeelRollbackCreateInput, validateKeelRollbackInspectInput } from "./keel-rollback-helper.mjs";
import { validUuid } from "./keel-artifact-spec.mjs";

export const helperProtocolVersion = 1;
export const helperOperations = new Set(["canary.verify", "prerequisite.smartmontools.inspect", "prerequisite.smartmontools.install", "prerequisite.restic.inspect", "prerequisite.restic.install", "prerequisite.apt-metadata.inspect", "prerequisite.apt-metadata.refresh", "container.docker.inspect", "container.docker.inventory", "system.logs.inspect", "controller.database.backup.inspect", "controller.database.backup.create", "controller.database.protection.inspect", "controller.database.protection.create", "controller.database.protection.retention.inspect", "controller.database.protection.retention.apply", "application.backup.protection.inspect", "application.backup.protection.create", "application.uptime-kuma.inspect", "application.uptime-kuma.deploy", "application.uptime-kuma.backup", "application.pi-hole.inspect", "application.pi-hole.deploy", "application.pi-hole.backup", "application.keel.inspect", "application.keel.artifact.inspect", "application.keel.artifact.acquire", "application.keel.archive.inspect", "application.keel.stage.inspect", "application.keel.stage", "application.keel.install.inspect", "application.keel.install", "application.keel.login-proof.inspect", "application.keel.backup", "application.keel.recovery.inspect", "application.keel.recovery.create", "application.keel.recovery-drill.inspect", "application.keel.recovery-drill.create", "application.keel.promotion.inspect", "application.keel.promotion.create", "application.keel.rollback.inspect", "application.keel.rollback.create", "migration.bundle.inspect", "migration.bundle.transfer", "virtualization.inventory.inspect", "virtualization.console.inspect", "virtualization.domain.export.inspect", "virtualization.domain.export.create", "virtualization.export.backup.inspect", "virtualization.export.backup.create", "virtualization.export.backup.retention.inspect", "virtualization.export.backup.retention.apply", "virtualization.export.backup.restore-drill.inspect", "virtualization.export.backup.restore-drill", "virtualization.backup.recovery.inspect", "virtualization.backup.recovery.create", "virtualization.domain.create", "virtualization.domain.action", "virtualization.domain.snapshot.create"]);
const vmCreationKeys = ["autostart", "diskGiB", "firmware", "isoFile", "memoryMiB", "name", "network", "osProfile", "vcpus"];
const vmLifecycleKeys = ["action", "expectedAutostart", "expectedState", "name"];
const vmSnapshotKeys = ["expectedDiskRevision", "expectedSnapshotRevision", "expectedState", "expectedUuid", "name", "snapshotName"];
const vmExportKeys = ["expectedDiskRevision", "expectedSnapshotRevision", "expectedState", "expectedUuid", "exportId", "name"];
const vmProtectionKeys = ["backupId", "domainName", "domainUuid", "expectedDestinationRevision", "expectedManifestChecksumSha256", "expectedSizeBytes", "exportId"];
const vmRestoreDrillKeys = ["backupId", "domainName", "domainUuid", "drillId", "expectedDestinationRevision", "expectedManifestChecksumSha256", "expectedSizeBytes", "exportId", "repositoryId", "snapshotId"];
const vmRecoveryKeys = ["backupId", "expectedDestinationRevision", "expectedManifestChecksumSha256", "expectedSizeBytes", "exportId", "repositoryId", "restoreDrillId", "restoreId", "snapshotId", "sourceDomainName", "sourceDomainUuid", "targetDomainName"];
const vmRetentionKeys = ["expectedDestinationRevision", "expectedSnapshotSetRevision", "forgetSnapshotIds", "repositoryId", "retentionId"];

function privateIpv4(value) {
  if (net.isIP(value) !== 4) return false;
  const [first, second] = value.split(".").map(Number);
  return first === 10 || (first === 172 && second >= 16 && second <= 31) || (first === 192 && second === 168);
}

export function validateHelperRequest(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "Request must be an object";
  if (value.version !== helperProtocolVersion) return "Unsupported helper protocol version";
  if (typeof value.id !== "string" || !/^[a-f0-9-]{36}$/.test(value.id)) return "Request id must be a UUID";
  if (!helperOperations.has(value.operation)) return "Operation is not allowlisted";
  if (!value.parameters || typeof value.parameters !== "object" || Array.isArray(value.parameters)) return "Parameters must be an object";
  if (value.operation === "canary.verify" && Object.keys(value.parameters).length !== 0) return "Canary operation accepts no parameters";
  if (value.operation === "prerequisite.smartmontools.inspect" && Object.keys(value.parameters).length !== 0) return "Smartmontools inspection accepts no parameters";
  if (value.operation === "prerequisite.smartmontools.install") {
    const keys = Object.keys(value.parameters);
    if (keys.length !== 1 || keys[0] !== "expectedVersion" || typeof value.parameters.expectedVersion !== "string" || !/^[0-9A-Za-z.+:~_-]{1,64}$/.test(value.parameters.expectedVersion)) return "Smartmontools installation accepts only one exact expectedVersion";
  }
  if (value.operation === "prerequisite.restic.inspect" && Object.keys(value.parameters).length !== 0) return "Restic inspection accepts no parameters";
  if (value.operation === "prerequisite.restic.install") {
    const keys = Object.keys(value.parameters);
    if (keys.length !== 1 || keys[0] !== "expectedVersion" || typeof value.parameters.expectedVersion !== "string" || !/^[0-9A-Za-z.+:~_-]{1,64}$/.test(value.parameters.expectedVersion)) return "Restic installation accepts only one exact expectedVersion";
  }
  if (value.operation === "prerequisite.apt-metadata.inspect" && Object.keys(value.parameters).length !== 0) return "APT metadata inspection accepts no parameters";
  if (value.operation === "prerequisite.apt-metadata.refresh") {
    const keys = Object.keys(value.parameters);
    const timestamp = value.parameters.expectedUpdatedAt;
    const validTimestamp = timestamp === null || (typeof timestamp === "string" && timestamp.length <= 32 && Number.isFinite(Date.parse(timestamp)) && new Date(timestamp).toISOString() === timestamp);
    if (keys.length !== 1 || keys[0] !== "expectedUpdatedAt" || !validTimestamp) return "APT metadata refresh accepts only one exact expectedUpdatedAt timestamp";
  }
  if (value.operation === "container.docker.inspect" && Object.keys(value.parameters).length !== 0) return "Docker inspection accepts no parameters";
  if (value.operation === "container.docker.inventory" && Object.keys(value.parameters).length !== 0) return "Docker inventory accepts no parameters";
  if (value.operation === "system.logs.inspect") {
    const keys = Object.keys(value.parameters);
    if (keys.length !== 2 || !["boxpilot", "docker", "tailscale", "virtualization"].includes(value.parameters.source) || !Number.isInteger(value.parameters.limit) || value.parameters.limit < 1 || value.parameters.limit > 200) {
      return "Log inspection accepts only a fixed source and a limit from 1 to 200";
    }
  }
  if (value.operation === "controller.database.backup.inspect" && Object.keys(value.parameters).length !== 0) return "Controller backup inspection accepts no parameters";
  if (value.operation === "controller.database.backup.create") {
    const errors = controllerBackupHelperInternals.validateControllerBackupInput(value.parameters);
    if (errors.length) return errors.join(" | ");
  }
  if (value.operation === "controller.database.protection.inspect" && Object.keys(value.parameters).length !== 0) return "Controller protection inspection accepts no parameters";
  if (value.operation === "controller.database.protection.create") {
    const expectedKeys = ["backupId", "expectedArtifactChecksumSha256", "expectedDestinationRevision", "expectedManifestChecksumSha256", "expectedSizeBytes", "protectionId"];
    const keys = Object.keys(value.parameters).sort();
    if (keys.length !== expectedKeys.length || keys.some((key, index) => key !== expectedKeys[index])) return "Controller protection accepts only the fixed typed evidence fields";
    const errors = validateControllerProtectionInput(value.parameters);
    if (errors.length) return errors.join(" | ");
  }
  if (value.operation === "controller.database.protection.retention.inspect" && Object.keys(value.parameters).length !== 0) return "Controller retention inspection accepts no parameters";
  if (value.operation === "controller.database.protection.retention.apply") {
    const errors = validateControllerRetentionInput(value.parameters);
    if (errors.length) return errors.join(" | ");
  }
  if (value.operation === "application.backup.protection.inspect" && Object.keys(value.parameters).length !== 0) return "Application protection inspection accepts no parameters";
  if (value.operation === "application.backup.protection.create") {
    const expectedKeys = ["applicationId", "backupId", "expectedArtifactChecksumSha256", "expectedDestinationRevision", "expectedSizeBytes", "protectionId"];
    const keys = Object.keys(value.parameters).sort();
    if (keys.length !== expectedKeys.length || keys.some((key, index) => key !== expectedKeys[index])) return "Application protection accepts only the fixed typed evidence fields";
    const errors = validateApplicationProtectionInput(value.parameters);
    if (errors.length) return errors.join(" | ");
  }
  if (value.operation === "application.uptime-kuma.inspect" && Object.keys(value.parameters).length !== 0) return "Inspect operation accepts no parameters";
  if (value.operation === "application.uptime-kuma.deploy") {
    if (Object.keys(value.parameters).length !== 1 || !Number.isInteger(value.parameters.hostPort) || value.parameters.hostPort < 1024 || value.parameters.hostPort > 65535) {
      return "Uptime Kuma deployment accepts only a hostPort between 1024 and 65535";
    }
  }
  if (value.operation === "application.uptime-kuma.backup") {
    if (Object.keys(value.parameters).length !== 1 || typeof value.parameters.backupId !== "string" || !/^[a-f0-9-]{36}$/.test(value.parameters.backupId)) {
      return "Uptime Kuma backup accepts only a backupId UUID";
    }
  }
  if (value.operation === "application.pi-hole.inspect" && Object.keys(value.parameters).length !== 0) return "Pi-hole inspection accepts no parameters";
  if (value.operation === "application.pi-hole.deploy") {
    const keys = Object.keys(value.parameters).sort();
    if (keys.length !== 2 || keys[0] !== "lanAddress" || keys[1] !== "webPort" || !privateIpv4(value.parameters.lanAddress) || !Number.isInteger(value.parameters.webPort) || value.parameters.webPort < 1024 || value.parameters.webPort > 65535) {
      return "Pi-hole deployment accepts only a private lanAddress and a webPort between 1024 and 65535";
    }
  }
  if (value.operation === "application.pi-hole.backup") {
    if (Object.keys(value.parameters).length !== 1 || typeof value.parameters.backupId !== "string" || !/^[a-f0-9-]{36}$/.test(value.parameters.backupId)) {
      return "Pi-hole backup accepts only a backupId UUID";
    }
  }
  if (value.operation === "application.keel.inspect" && Object.keys(value.parameters).length !== 0) return "Keel inspection accepts no parameters";
  if (value.operation === "application.keel.artifact.inspect" && Object.keys(value.parameters).length !== 0) return "Keel artifact inspection accepts no parameters";
  if (value.operation === "application.keel.archive.inspect" && Object.keys(value.parameters).length !== 0) return "Keel archive inspection accepts no parameters";
  if (value.operation === "application.keel.stage.inspect" && Object.keys(value.parameters).length !== 0) return "Keel stage inspection accepts no parameters";
  if (value.operation === "application.keel.artifact.acquire") {
    const keys = Object.keys(value.parameters);
    if (keys.length !== 1 || keys[0] !== "acquisitionId" || !validUuid(value.parameters.acquisitionId)) return "Keel artifact acquisition accepts only one acquisitionId UUID";
  }
  if (value.operation === "application.keel.stage") {
    const keys = Object.keys(value.parameters);
    if (keys.length !== 1 || keys[0] !== "stageId" || !validUuid(value.parameters.stageId)) return "Keel staging accepts only one stageId UUID";
  }
  if (value.operation === "application.keel.install.inspect" && Object.keys(value.parameters).length !== 0) return "Keel installation inspection accepts no parameters";
  if (value.operation === "application.keel.login-proof.inspect" && Object.keys(value.parameters).length !== 0) return "Keel owner-login proof inspection accepts no parameters";
  if (value.operation === "application.keel.install") {
    const keys = Object.keys(value.parameters);
    if (keys.length !== 1 || keys[0] !== "installId" || !validUuid(value.parameters.installId)) return "Keel installation accepts only one installId UUID";
  }
  if (value.operation === "application.keel.backup") {
    const keys = Object.keys(value.parameters);
    if (keys.length !== 1 || keys[0] !== "backupId" || !validUuid(value.parameters.backupId)) return "Keel backup accepts only one backupId UUID";
  }
  if (["application.keel.recovery.inspect", "application.keel.recovery.create"].includes(value.operation)) {
    const errors = validateKeelRecoveryInput(value.parameters);
    if (errors.length) return errors.join(" | ");
  }
  if (value.operation === "application.keel.recovery-drill.inspect") {
    const errors = validateKeelRecoveryDrillInspectInput(value.parameters);
    if (errors.length) return errors.join(" | ");
  }
  if (value.operation === "application.keel.recovery-drill.create") {
    const errors = validateKeelRecoveryDrillCreateInput(value.parameters);
    if (errors.length) return errors.join(" | ");
  }
  if (value.operation === "application.keel.promotion.inspect") {
    const errors = validateKeelPromotionInspectInput(value.parameters);
    if (errors.length) return errors.join(" | ");
  }
  if (value.operation === "application.keel.promotion.create") {
    const errors = validateKeelPromotionCreateInput(value.parameters);
    if (errors.length) return errors.join(" | ");
  }
  if (value.operation === "application.keel.rollback.inspect") {
    const errors = validateKeelRollbackInspectInput(value.parameters);
    if (errors.length) return errors.join(" | ");
  }
  if (value.operation === "application.keel.rollback.create") {
    const errors = validateKeelRollbackCreateInput(value.parameters);
    if (errors.length) return errors.join(" | ");
  }
  if (value.operation === "migration.bundle.inspect" && Object.keys(value.parameters).length !== 0) return "Migration bundle inspection accepts no parameters";
  if (value.operation === "migration.bundle.transfer") {
    const errors = validateMigrationTransferInput(value.parameters);
    if (errors.length) return `Invalid migration transfer plan: ${errors.join(" | ")}`;
  }
  if (value.operation === "virtualization.domain.create") {
    const keys = Object.keys(value.parameters).sort();
    if (keys.length !== vmCreationKeys.length || keys.some((key, index) => key !== vmCreationKeys[index])) {
      return "VM creation accepts only the fixed typed plan fields";
    }
    const errors = validateVmPlanInput(value.parameters);
    if (errors.length) return `Invalid VM creation plan: ${errors.join(" | ")}`;
  }
  if (value.operation === "virtualization.inventory.inspect") {
    const keys = Object.keys(value.parameters);
    if (keys.length !== 1 || keys[0] !== "scope" || !["status", "domains", "resources"].includes(value.parameters.scope)) {
      return "Virtualization inventory accepts only a fixed status, domains, or resources scope";
    }
  }
  if (value.operation === "virtualization.console.inspect" && Object.keys(value.parameters).length !== 0) return "Virtualization console inspection accepts no parameters";
  if (value.operation === "virtualization.domain.export.inspect") {
    const keys = Object.keys(value.parameters);
    if (keys.length !== 1 || keys[0] !== "name" || !validateDomainName(value.parameters.name)) return "VM export inspection accepts only an exact domain name";
  }
  if (value.operation === "virtualization.domain.export.create") {
    const keys = Object.keys(value.parameters).sort();
    if (keys.length !== vmExportKeys.length || keys.some((key, index) => key !== vmExportKeys[index])) return "VM export creation accepts only the fixed typed plan fields";
    const errors = validateVmExportInput(value.parameters);
    if (errors.length) return `Invalid VM export plan: ${errors.join(" | ")}`;
  }
  if (value.operation === "virtualization.export.backup.inspect" && Object.keys(value.parameters).length !== 0) return "VM protection inspection accepts no parameters";
  if (value.operation === "virtualization.export.backup.create") {
    const keys = Object.keys(value.parameters).sort();
    if (keys.length !== vmProtectionKeys.length || keys.some((key, index) => key !== vmProtectionKeys[index])) return "VM protection accepts only the fixed typed plan fields";
    const errors = validateVmProtectionInput(value.parameters);
    if (errors.length) return `Invalid VM protection plan: ${errors.join(" | ")}`;
  }
  if (value.operation === "virtualization.export.backup.retention.inspect" && Object.keys(value.parameters).length !== 0) return "VM retention inspection accepts no parameters";
  if (value.operation === "virtualization.export.backup.retention.apply") {
    const keys = Object.keys(value.parameters).sort();
    if (keys.length !== vmRetentionKeys.length || keys.some((key, index) => key !== vmRetentionKeys[index])) return "VM retention accepts only the fixed typed evidence fields";
    const errors = validateVmRetentionInput(value.parameters);
    if (errors.length) return `Invalid VM retention plan: ${errors.join(" | ")}`;
  }
  if (["virtualization.export.backup.restore-drill.inspect", "virtualization.export.backup.restore-drill"].includes(value.operation)) {
    const keys = Object.keys(value.parameters).sort();
    if (keys.length !== vmRestoreDrillKeys.length || keys.some((key, index) => key !== vmRestoreDrillKeys[index])) return "VM restore drills accept only the fixed typed evidence fields";
    const errors = validateVmRestoreDrillInput(value.parameters);
    if (errors.length) return `Invalid VM restore drill plan: ${errors.join(" | ")}`;
  }
  if (["virtualization.backup.recovery.inspect", "virtualization.backup.recovery.create"].includes(value.operation)) {
    const keys = Object.keys(value.parameters).sort();
    if (keys.length !== vmRecoveryKeys.length || keys.some((key, index) => key !== vmRecoveryKeys[index])) return "VM recovery accepts only the fixed typed protected-backup fields";
    const errors = validateVmRecoveryInput(value.parameters);
    if (errors.length) return `Invalid VM recovery plan: ${errors.join(" | ")}`;
  }
  if (value.operation === "virtualization.domain.action") {
    const keys = Object.keys(value.parameters).sort();
    if (keys.length !== vmLifecycleKeys.length || keys.some((key, index) => key !== vmLifecycleKeys[index])) return "VM lifecycle accepts only the fixed typed plan fields";
    const errors = validateVmLifecycleInput(value.parameters);
    if (errors.length) return `Invalid VM lifecycle plan: ${errors.join(" | ")}`;
  }
  if (value.operation === "virtualization.domain.snapshot.create") {
    const keys = Object.keys(value.parameters).sort();
    if (keys.length !== vmSnapshotKeys.length || keys.some((key, index) => key !== vmSnapshotKeys[index])) return "VM snapshot creation accepts only the fixed typed plan fields";
    const errors = validateVmSnapshotInput(value.parameters);
    if (errors.length) return `Invalid VM snapshot plan: ${errors.join(" | ")}`;
  }
  return null;
}

export async function executeHelperOperation(request, { applications = createApplicationHelper(), applicationProtection = createApplicationProtectionHelper(), controllerBackups = createControllerBackupHelper(), controllerProtection = createControllerProtectionHelper(), controllerRetention = createControllerRetentionHelper(), keelDiscovery = createKeelDiscoveryHelper(), keelArtifacts = createKeelArtifactHelper(), keelArchive = createKeelArchiveHelper(), keelStage = createKeelStageHelper(), keelInstall = createKeelInstallHelper(), keelLoginProof = createKeelLoginProofHelper(), keelBackups = createKeelBackupHelper({ installHelper: keelInstall }), keelRecovery = createKeelRecoveryHelper(), keelRecoveryDrill = createKeelRecoveryDrillHelper(), keelPromotion = createKeelPromotionHelper(), keelRollback = createKeelRollbackHelper(), migrations = createMigrationTransferHelper(), prerequisites = createPrerequisiteHelper(), virtualization = createVmHelper(), vmProtection = createVmProtectionHelper(), vmRetention = createVmRetentionHelper(), vmRestoreDrill = createVmRestoreDrillHelper(), vmRecovery = createVmRecoveryHelper() } = {}) {
  const error = validateHelperRequest(request);
  if (error) return { version: helperProtocolVersion, id: request?.id ?? null, ok: false, error, code: "invalid_request" };
  if (request.operation === "canary.verify") {
    return {
      version: helperProtocolVersion,
      id: request.id,
      ok: true,
      result: { verified: true, helperVersion: "0.53.0", mutationPerformed: false },
    };
  }
  if (request.operation === "prerequisite.smartmontools.inspect") {
    return { version: helperProtocolVersion, id: request.id, ok: true, result: await prerequisites.inspectSmartmontools() };
  }
  if (request.operation === "prerequisite.smartmontools.install") {
    return { version: helperProtocolVersion, id: request.id, ok: true, result: await prerequisites.installSmartmontools(request.parameters) };
  }
  if (request.operation === "prerequisite.restic.inspect") {
    return { version: helperProtocolVersion, id: request.id, ok: true, result: await prerequisites.inspectRestic() };
  }
  if (request.operation === "prerequisite.restic.install") {
    return { version: helperProtocolVersion, id: request.id, ok: true, result: await prerequisites.installRestic(request.parameters) };
  }
  if (request.operation === "prerequisite.apt-metadata.inspect") {
    return { version: helperProtocolVersion, id: request.id, ok: true, result: await prerequisites.inspectAptMetadata() };
  }
  if (request.operation === "prerequisite.apt-metadata.refresh") {
    return { version: helperProtocolVersion, id: request.id, ok: true, result: await prerequisites.refreshAptMetadata(request.parameters) };
  }
  if (request.operation === "container.docker.inspect") {
    return { version: helperProtocolVersion, id: request.id, ok: true, result: await applications.inspectDocker() };
  }
  if (request.operation === "container.docker.inventory") {
    return { version: helperProtocolVersion, id: request.id, ok: true, result: await applications.inventoryDocker() };
  }
  if (request.operation === "system.logs.inspect") {
    return { version: helperProtocolVersion, id: request.id, ok: true, result: await applications.inspectLogs(request.parameters) };
  }
  if (request.operation === "controller.database.backup.inspect") {
    return { version: helperProtocolVersion, id: request.id, ok: true, result: await controllerBackups.inspect() };
  }
  if (request.operation === "controller.database.backup.create") {
    return { version: helperProtocolVersion, id: request.id, ok: true, result: await controllerBackups.createBackup(request.parameters) };
  }
  if (request.operation === "controller.database.protection.inspect") {
    return { version: helperProtocolVersion, id: request.id, ok: true, result: await controllerProtection.inspect() };
  }
  if (request.operation === "controller.database.protection.create") {
    return { version: helperProtocolVersion, id: request.id, ok: true, result: await controllerProtection.protect(request.parameters) };
  }
  if (request.operation === "controller.database.protection.retention.inspect") {
    return { version: helperProtocolVersion, id: request.id, ok: true, result: await controllerRetention.inspect() };
  }
  if (request.operation === "controller.database.protection.retention.apply") {
    return { version: helperProtocolVersion, id: request.id, ok: true, result: await controllerRetention.apply(request.parameters) };
  }
  if (request.operation === "application.backup.protection.inspect") {
    return { version: helperProtocolVersion, id: request.id, ok: true, result: await applicationProtection.inspect() };
  }
  if (request.operation === "application.backup.protection.create") {
    return { version: helperProtocolVersion, id: request.id, ok: true, result: await applicationProtection.protect(request.parameters) };
  }
  if (request.operation === "application.uptime-kuma.inspect") {
    return { version: helperProtocolVersion, id: request.id, ok: true, result: await applications.inspect() };
  }
  if (request.operation === "application.uptime-kuma.deploy") {
    return { version: helperProtocolVersion, id: request.id, ok: true, result: await applications.deploy(request.parameters) };
  }
  if (request.operation === "application.uptime-kuma.backup") {
    return { version: helperProtocolVersion, id: request.id, ok: true, result: await applications.backup(request.parameters) };
  }
  if (request.operation === "application.pi-hole.inspect") {
    return { version: helperProtocolVersion, id: request.id, ok: true, result: await applications.inspectPihole() };
  }
  if (request.operation === "application.pi-hole.deploy") {
    return { version: helperProtocolVersion, id: request.id, ok: true, result: await applications.deployPihole(request.parameters) };
  }
  if (request.operation === "application.pi-hole.backup") {
    return { version: helperProtocolVersion, id: request.id, ok: true, result: await applications.backupPihole(request.parameters) };
  }
  if (request.operation === "application.keel.inspect") {
    return { version: helperProtocolVersion, id: request.id, ok: true, result: await keelDiscovery.inspect() };
  }
  if (request.operation === "application.keel.artifact.inspect") {
    return { version: helperProtocolVersion, id: request.id, ok: true, result: await keelArtifacts.inspect() };
  }
  if (request.operation === "application.keel.artifact.acquire") {
    return { version: helperProtocolVersion, id: request.id, ok: true, result: await keelArtifacts.acquire(request.parameters) };
  }
  if (request.operation === "application.keel.archive.inspect") {
    return { version: helperProtocolVersion, id: request.id, ok: true, result: await keelArchive.inspect() };
  }
  if (request.operation === "application.keel.stage.inspect") {
    return { version: helperProtocolVersion, id: request.id, ok: true, result: await keelStage.inspect() };
  }
  if (request.operation === "application.keel.stage") {
    return { version: helperProtocolVersion, id: request.id, ok: true, result: await keelStage.stage(request.parameters) };
  }
  if (request.operation === "application.keel.install.inspect") {
    return { version: helperProtocolVersion, id: request.id, ok: true, result: await keelInstall.inspect() };
  }
  if (request.operation === "application.keel.install") {
    return { version: helperProtocolVersion, id: request.id, ok: true, result: await keelInstall.install(request.parameters) };
  }
  if (request.operation === "application.keel.login-proof.inspect") {
    return { version: helperProtocolVersion, id: request.id, ok: true, result: await keelLoginProof.inspect() };
  }
  if (request.operation === "application.keel.backup") {
    return { version: helperProtocolVersion, id: request.id, ok: true, result: await keelBackups.backup(request.parameters) };
  }
  if (request.operation === "application.keel.recovery.inspect") {
    return { version: helperProtocolVersion, id: request.id, ok: true, result: await keelRecovery.inspect(request.parameters) };
  }
  if (request.operation === "application.keel.recovery.create") {
    return { version: helperProtocolVersion, id: request.id, ok: true, result: await keelRecovery.create(request.parameters) };
  }
  if (request.operation === "application.keel.recovery-drill.inspect") {
    return { version: helperProtocolVersion, id: request.id, ok: true, result: await keelRecoveryDrill.inspect(request.parameters) };
  }
  if (request.operation === "application.keel.recovery-drill.create") {
    return { version: helperProtocolVersion, id: request.id, ok: true, result: await keelRecoveryDrill.create(request.parameters) };
  }
  if (request.operation === "application.keel.promotion.inspect") {
    return { version: helperProtocolVersion, id: request.id, ok: true, result: await keelPromotion.inspect(request.parameters) };
  }
  if (request.operation === "application.keel.promotion.create") {
    return { version: helperProtocolVersion, id: request.id, ok: true, result: await keelPromotion.create(request.parameters) };
  }
  if (request.operation === "application.keel.rollback.inspect") {
    return { version: helperProtocolVersion, id: request.id, ok: true, result: await keelRollback.inspect(request.parameters) };
  }
  if (request.operation === "application.keel.rollback.create") {
    return { version: helperProtocolVersion, id: request.id, ok: true, result: await keelRollback.create(request.parameters) };
  }
  if (request.operation === "migration.bundle.inspect") {
    return { version: helperProtocolVersion, id: request.id, ok: true, result: await migrations.inspect() };
  }
  if (request.operation === "migration.bundle.transfer") {
    return { version: helperProtocolVersion, id: request.id, ok: true, result: await migrations.transfer(request.parameters) };
  }
  if (request.operation === "virtualization.inventory.inspect") {
    return { version: helperProtocolVersion, id: request.id, ok: true, result: await virtualization.inventory(request.parameters) };
  }
  if (request.operation === "virtualization.console.inspect") {
    return { version: helperProtocolVersion, id: request.id, ok: true, result: await virtualization.consoleGuidance() };
  }
  if (request.operation === "virtualization.domain.export.inspect") {
    return { version: helperProtocolVersion, id: request.id, ok: true, result: await virtualization.inspectExport(request.parameters) };
  }
  if (request.operation === "virtualization.domain.export.create") {
    return { version: helperProtocolVersion, id: request.id, ok: true, result: await virtualization.createExport(request.parameters) };
  }
  if (request.operation === "virtualization.export.backup.inspect") {
    return { version: helperProtocolVersion, id: request.id, ok: true, result: await vmProtection.inspect() };
  }
  if (request.operation === "virtualization.export.backup.create") {
    return { version: helperProtocolVersion, id: request.id, ok: true, result: await vmProtection.createBackup(request.parameters) };
  }
  if (request.operation === "virtualization.export.backup.retention.inspect") {
    return { version: helperProtocolVersion, id: request.id, ok: true, result: await vmRetention.inspect() };
  }
  if (request.operation === "virtualization.export.backup.retention.apply") {
    return { version: helperProtocolVersion, id: request.id, ok: true, result: await vmRetention.apply(request.parameters) };
  }
  if (request.operation === "virtualization.export.backup.restore-drill.inspect") {
    return { version: helperProtocolVersion, id: request.id, ok: true, result: await vmRestoreDrill.inspect(request.parameters) };
  }
  if (request.operation === "virtualization.export.backup.restore-drill") {
    return { version: helperProtocolVersion, id: request.id, ok: true, result: await vmRestoreDrill.runDrill(request.parameters) };
  }
  if (request.operation === "virtualization.backup.recovery.inspect") {
    return { version: helperProtocolVersion, id: request.id, ok: true, result: await vmRecovery.inspect(request.parameters) };
  }
  if (request.operation === "virtualization.backup.recovery.create") {
    return { version: helperProtocolVersion, id: request.id, ok: true, result: await vmRecovery.createRecovery(request.parameters) };
  }
  if (request.operation === "virtualization.domain.create") {
    return { version: helperProtocolVersion, id: request.id, ok: true, result: await virtualization.create(request.parameters) };
  }
  if (request.operation === "virtualization.domain.action") {
    return { version: helperProtocolVersion, id: request.id, ok: true, result: await virtualization.action(request.parameters) };
  }
  if (request.operation === "virtualization.domain.snapshot.create") {
    return { version: helperProtocolVersion, id: request.id, ok: true, result: await virtualization.createSnapshot(request.parameters) };
  }
  return { version: helperProtocolVersion, id: request.id, ok: false, error: "Operation is not implemented", code: "not_implemented" };
}
