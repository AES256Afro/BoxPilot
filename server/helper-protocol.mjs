import net from "node:net";
import { registry } from "./ops/index.mjs";
import { fixedRun } from "./exec.mjs";
import { createRunUnitClient } from "./run-unit.mjs";
import { createAppHelper } from "./app-helper.mjs";
import { createHostInspectHelper } from "./host-inspect-helper.mjs";
import { createVmCloudHelper } from "./vm-cloud.mjs";
import { createJobLogWriter, jobIdPattern } from "./job-log.mjs";
import { readFileSync } from "node:fs";
import { createVmHelper } from "./vm-helper.mjs";
import { createVmMediaHelper, validateVmMediaImportInput } from "./vm-media-helper.mjs";
import { validateDomainName } from "./libvirt.mjs";
import { validateVmExportInput } from "./vm-export.mjs";
import { validateVmPlanInput } from "./vm-plan.mjs";
import { createVmProtectionHelper, validateVmProtectionInput } from "./vm-protection-helper.mjs";
import { createVmRecoveryHelper, validateVmRecoveryInput } from "./vm-recovery-helper.mjs";
import { createVmRetentionHelper, validateVmRetentionInput } from "./vm-retention-helper.mjs";
import { createVmRestoreDrillHelper, validateVmRestoreDrillInput } from "./vm-restore-drill-helper.mjs";
import { createPrerequisiteHelper } from "./prerequisite-helper.mjs";
import { createLibvirtFoundationHelper } from "./libvirt-foundation-helper.mjs";
import { createControllerBackupHelper, controllerBackupHelperInternals } from "./controller-backup-helper.mjs";
import { createControllerProtectionHelper, validateControllerProtectionInput } from "./controller-protection-helper.mjs";
import { createControllerRetentionHelper, validateControllerRetentionInput } from "./controller-retention-helper.mjs";

export const helperProtocolVersion = 1;

function validUuid(value) {
  return typeof value === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value);
}
/** Operations still declared by hand. New operations go in server/ops/ (ADR-001). */
export const legacyHelperOperations = new Set(["container.docker.inspect", "container.docker.inventory", "system.logs.inspect", "controller.database.backup.inspect", "controller.database.backup.create", "controller.database.protection.inspect", "controller.database.protection.create", "controller.database.protection.retention.inspect", "controller.database.protection.retention.apply", "virtualization.foundation.inspect", "virtualization.foundation.initialize", "virtualization.media.inspect", "virtualization.media.import", "virtualization.inventory.inspect", "virtualization.console.inspect", "virtualization.domain.export.inspect", "virtualization.domain.export.create", "virtualization.export.backup.inspect", "virtualization.export.backup.create", "virtualization.export.backup.retention.inspect", "virtualization.export.backup.retention.apply", "virtualization.export.backup.restore-drill.inspect", "virtualization.export.backup.restore-drill", "virtualization.backup.recovery.inspect", "virtualization.backup.recovery.create", "virtualization.domain.create"]);
export const helperOperations = new Set([...registry.ids(), ...legacyHelperOperations]);
const vmCreationKeys = ["autostart", "diskGiB", "firmware", "isoFile", "memoryMiB", "name", "network", "osProfile", "vcpus"];
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

let cachedServiceGroupId = null;
/** gid of the unprivileged web service group (boxpilot) so job logs are group-readable; null when unknown. */
export function serviceGroupId() {
  if (cachedServiceGroupId !== null) return cachedServiceGroupId === -1 ? null : cachedServiceGroupId;
  try {
    const line = readFileSync("/etc/group", "utf8").split("\n").find((entry) => entry.startsWith("boxpilot:"));
    const gid = line ? Number.parseInt(line.split(":")[2], 10) : Number.NaN;
    cachedServiceGroupId = Number.isInteger(gid) ? gid : -1;
  } catch { cachedServiceGroupId = -1; }
  return cachedServiceGroupId === -1 ? null : cachedServiceGroupId;
}

export function validateHelperRequest(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "Request must be an object";
  if (value.version !== helperProtocolVersion) return "Unsupported helper protocol version";
  if (typeof value.id !== "string" || !/^[a-f0-9-]{36}$/.test(value.id)) return "Request id must be a UUID";
  if (!helperOperations.has(value.operation)) return "Operation is not allowlisted";
  if (value.context !== undefined) {
    if (!value.context || typeof value.context !== "object" || Array.isArray(value.context)) return "Request context must be an object";
    const keys = Object.keys(value.context);
    if (keys.some((key) => key !== "jobId")) return "Request context accepts only jobId";
    if (value.context.jobId !== undefined && (typeof value.context.jobId !== "string" || !jobIdPattern.test(value.context.jobId))) return "Request context jobId must be a UUID";
  }
  if (!value.parameters || typeof value.parameters !== "object" || Array.isArray(value.parameters)) return "Parameters must be an object";
  if (registry.has(value.operation)) return registry.validate(value.operation, value.parameters);
  if (value.operation === "virtualization.foundation.inspect" && Object.keys(value.parameters).length !== 0) return "Libvirt foundation inspection accepts no parameters";
  if (value.operation === "virtualization.foundation.initialize") {
    const keys = Object.keys(value.parameters).sort();
    if (keys.join(",") !== "expectedRevision,foundationId" || !/^[a-f0-9]{64}$/.test(String(value.parameters.expectedRevision ?? "")) || !validUuid(value.parameters.foundationId)) return "Libvirt foundation initialization accepts only one server-generated id and exact state revision";
  }
  if (value.operation === "virtualization.media.inspect" && Object.keys(value.parameters).length !== 0) return "VM media inspection accepts no parameters";
  if (value.operation === "virtualization.media.import") {
    const errors = validateVmMediaImportInput(value.parameters);
    if (errors.length) return errors.join(" | ");
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
  return null;
}

export async function executeHelperOperation(request, dependencies = {}) {
  const { hostInspect = createHostInspectHelper(), controllerBackups = createControllerBackupHelper(), controllerProtection = createControllerProtectionHelper(), controllerRetention = createControllerRetentionHelper(), prerequisites = createPrerequisiteHelper(), foundation = createLibvirtFoundationHelper(), vmMedia = createVmMediaHelper(), virtualization = createVmHelper(), vmProtection = createVmProtectionHelper(), vmRetention = createVmRetentionHelper(), vmRestoreDrill = createVmRestoreDrillHelper(), vmRecovery = createVmRecoveryHelper() } = dependencies;
  const error = validateHelperRequest(request);
  if (error) return { version: helperProtocolVersion, id: request?.id ?? null, ok: false, error, code: "invalid_request" };
  if (registry.has(request.operation)) {
    const jobLog = createJobLogWriter({ jobId: request.context?.jobId ?? null, gid: serviceGroupId() });
    const progress = (line, stream) => { void jobLog.append(line, stream); };
    return { version: helperProtocolVersion, id: request.id, ok: true, result: await registry.execute(request.operation, request.parameters, { run: fixedRun, runUnit: dependencies.runUnit ?? createRunUnitClient({ run: fixedRun }), apps: dependencies.apps ?? createAppHelper(), vmCloud: dependencies.vmCloud ?? createVmCloudHelper(), ...dependencies, prerequisites, progress, jobLog }) };
  }
  if (request.operation === "container.docker.inspect") {
    return { version: helperProtocolVersion, id: request.id, ok: true, result: await hostInspect.inspectDocker() };
  }
  if (request.operation === "container.docker.inventory") {
    return { version: helperProtocolVersion, id: request.id, ok: true, result: await hostInspect.inventoryDocker() };
  }
  if (request.operation === "system.logs.inspect") {
    return { version: helperProtocolVersion, id: request.id, ok: true, result: await hostInspect.inspectLogs(request.parameters) };
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
  if (request.operation === "virtualization.foundation.inspect") {
    return { version: helperProtocolVersion, id: request.id, ok: true, result: await foundation.inspect() };
  }
  if (request.operation === "virtualization.foundation.initialize") {
    return { version: helperProtocolVersion, id: request.id, ok: true, result: await foundation.initialize(request.parameters) };
  }
  if (request.operation === "virtualization.media.inspect") {
    return { version: helperProtocolVersion, id: request.id, ok: true, result: await vmMedia.inspect() };
  }
  if (request.operation === "virtualization.media.import") {
    return { version: helperProtocolVersion, id: request.id, ok: true, result: await vmMedia.importMedia(request.parameters) };
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
  return { version: helperProtocolVersion, id: request.id, ok: false, error: "Operation is not implemented", code: "not_implemented" };
}
