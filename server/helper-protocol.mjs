import { createApplicationHelper } from "./application-helper.mjs";
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

export const helperProtocolVersion = 1;
export const helperOperations = new Set(["canary.verify", "container.docker.inspect", "container.docker.inventory", "system.logs.inspect", "application.uptime-kuma.inspect", "application.uptime-kuma.deploy", "application.uptime-kuma.backup", "migration.bundle.inspect", "migration.bundle.transfer", "virtualization.inventory.inspect", "virtualization.console.inspect", "virtualization.domain.export.inspect", "virtualization.domain.export.create", "virtualization.export.backup.inspect", "virtualization.export.backup.create", "virtualization.export.backup.retention.inspect", "virtualization.export.backup.retention.apply", "virtualization.export.backup.restore-drill.inspect", "virtualization.export.backup.restore-drill", "virtualization.backup.recovery.inspect", "virtualization.backup.recovery.create", "virtualization.domain.create", "virtualization.domain.action", "virtualization.domain.snapshot.create"]);
const vmCreationKeys = ["autostart", "diskGiB", "firmware", "isoFile", "memoryMiB", "name", "network", "osProfile", "vcpus"];
const vmLifecycleKeys = ["action", "expectedAutostart", "expectedState", "name"];
const vmSnapshotKeys = ["expectedDiskRevision", "expectedSnapshotRevision", "expectedState", "expectedUuid", "name", "snapshotName"];
const vmExportKeys = ["expectedDiskRevision", "expectedSnapshotRevision", "expectedState", "expectedUuid", "exportId", "name"];
const vmProtectionKeys = ["backupId", "domainName", "domainUuid", "expectedDestinationRevision", "expectedManifestChecksumSha256", "expectedSizeBytes", "exportId"];
const vmRestoreDrillKeys = ["backupId", "domainName", "domainUuid", "drillId", "expectedDestinationRevision", "expectedManifestChecksumSha256", "expectedSizeBytes", "exportId", "repositoryId", "snapshotId"];
const vmRecoveryKeys = ["backupId", "expectedDestinationRevision", "expectedManifestChecksumSha256", "expectedSizeBytes", "exportId", "repositoryId", "restoreDrillId", "restoreId", "snapshotId", "sourceDomainName", "sourceDomainUuid", "targetDomainName"];
const vmRetentionKeys = ["expectedDestinationRevision", "expectedSnapshotSetRevision", "forgetSnapshotIds", "repositoryId", "retentionId"];

export function validateHelperRequest(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "Request must be an object";
  if (value.version !== helperProtocolVersion) return "Unsupported helper protocol version";
  if (typeof value.id !== "string" || !/^[a-f0-9-]{36}$/.test(value.id)) return "Request id must be a UUID";
  if (!helperOperations.has(value.operation)) return "Operation is not allowlisted";
  if (!value.parameters || typeof value.parameters !== "object" || Array.isArray(value.parameters)) return "Parameters must be an object";
  if (value.operation === "canary.verify" && Object.keys(value.parameters).length !== 0) return "Canary operation accepts no parameters";
  if (value.operation === "container.docker.inspect" && Object.keys(value.parameters).length !== 0) return "Docker inspection accepts no parameters";
  if (value.operation === "container.docker.inventory" && Object.keys(value.parameters).length !== 0) return "Docker inventory accepts no parameters";
  if (value.operation === "system.logs.inspect") {
    const keys = Object.keys(value.parameters);
    if (keys.length !== 2 || !["boxpilot", "docker", "tailscale", "virtualization"].includes(value.parameters.source) || !Number.isInteger(value.parameters.limit) || value.parameters.limit < 1 || value.parameters.limit > 200) {
      return "Log inspection accepts only a fixed source and a limit from 1 to 200";
    }
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

export async function executeHelperOperation(request, { applications = createApplicationHelper(), migrations = createMigrationTransferHelper(), virtualization = createVmHelper(), vmProtection = createVmProtectionHelper(), vmRetention = createVmRetentionHelper(), vmRestoreDrill = createVmRestoreDrillHelper(), vmRecovery = createVmRecoveryHelper() } = {}) {
  const error = validateHelperRequest(request);
  if (error) return { version: helperProtocolVersion, id: request?.id ?? null, ok: false, error, code: "invalid_request" };
  if (request.operation === "canary.verify") {
    return {
      version: helperProtocolVersion,
      id: request.id,
      ok: true,
      result: { verified: true, helperVersion: "0.13.0", mutationPerformed: false },
    };
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
  if (request.operation === "application.uptime-kuma.inspect") {
    return { version: helperProtocolVersion, id: request.id, ok: true, result: await applications.inspect() };
  }
  if (request.operation === "application.uptime-kuma.deploy") {
    return { version: helperProtocolVersion, id: request.id, ok: true, result: await applications.deploy(request.parameters) };
  }
  if (request.operation === "application.uptime-kuma.backup") {
    return { version: helperProtocolVersion, id: request.id, ok: true, result: await applications.backup(request.parameters) };
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
