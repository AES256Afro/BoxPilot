import { registry } from "./ops/index.mjs";
import { fixedRun } from "./exec.mjs";
import { createRunUnitClient } from "./run-unit.mjs";
import { createCredentialStore } from "./credentials.mjs";
import { createVpnProfileStore } from "./vpn-profile.mjs";
import { createAppHelper } from "./app-helper.mjs";
import { createHostInspectHelper } from "./host-inspect-helper.mjs";
import { createVmCloudHelper } from "./vm-cloud.mjs";
import { createJobLogWriter, jobIdPattern } from "./job-log.mjs";
import { readFileSync } from "node:fs";
import { createVmHelper } from "./vm-helper.mjs";
import { createVmMediaHelper } from "./vm-media-helper.mjs";
import { validateDomainName } from "./libvirt.mjs";
import { createVmProtectionHelper } from "./vm-protection-helper.mjs";
import { createVmRecoveryHelper, validateVmRecoveryInput } from "./vm-recovery-helper.mjs";
import { createVmRetentionHelper } from "./vm-retention-helper.mjs";
import { createVmRestoreDrillHelper, validateVmRestoreDrillInput } from "./vm-restore-drill-helper.mjs";
import { createPrerequisiteHelper } from "./prerequisite-helper.mjs";
import { createLibvirtFoundationHelper } from "./libvirt-foundation-helper.mjs";
import { createControllerBackupHelper } from "./controller-backup-helper.mjs";
import { createControllerProtectionHelper } from "./controller-protection-helper.mjs";
import { createControllerRetentionHelper } from "./controller-retention-helper.mjs";
import { createMachineSnapshotHelper } from "./machine-snapshot-helper.mjs";

export const helperProtocolVersion = 1;

/**
 * Hand-declared read-only inspections. Every mutation runs as a registry operation
 * (server/ops/, ADR-001); the executing service revalidates its own typed input.
 */
export const legacyHelperOperations = new Set(["container.docker.inspect", "container.docker.inventory", "controller.database.backup.inspect", "controller.database.protection.inspect", "controller.database.protection.retention.inspect", "virtualization.foundation.inspect", "virtualization.media.inspect", "virtualization.inventory.inspect", "virtualization.console.inspect", "virtualization.domain.export.inspect", "virtualization.export.backup.inspect", "virtualization.export.backup.retention.inspect", "virtualization.export.backup.restore-drill.inspect", "virtualization.backup.recovery.inspect"]);
export const helperOperations = new Set([...registry.ids(), ...legacyHelperOperations]);
const vmRestoreDrillKeys = ["backupId", "domainName", "domainUuid", "drillId", "expectedDestinationRevision", "expectedManifestChecksumSha256", "expectedSizeBytes", "exportId", "repositoryId", "snapshotId"];
const vmRecoveryKeys = ["backupId", "expectedDestinationRevision", "expectedManifestChecksumSha256", "expectedSizeBytes", "exportId", "repositoryId", "restoreDrillId", "restoreId", "snapshotId", "sourceDomainName", "sourceDomainUuid", "targetDomainName"];

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
  if (value.operation === "virtualization.media.inspect" && Object.keys(value.parameters).length !== 0) return "VM media inspection accepts no parameters";
  if (value.operation === "container.docker.inspect" && Object.keys(value.parameters).length !== 0) return "Docker inspection accepts no parameters";
  if (value.operation === "container.docker.inventory" && Object.keys(value.parameters).length !== 0) return "Docker inventory accepts no parameters";
  if (value.operation === "controller.database.backup.inspect" && Object.keys(value.parameters).length !== 0) return "Controller backup inspection accepts no parameters";
  if (value.operation === "controller.database.protection.inspect" && Object.keys(value.parameters).length !== 0) return "Controller protection inspection accepts no parameters";
  if (value.operation === "controller.database.protection.retention.inspect" && Object.keys(value.parameters).length !== 0) return "Controller retention inspection accepts no parameters";
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
  if (value.operation === "virtualization.export.backup.inspect" && Object.keys(value.parameters).length !== 0) return "VM protection inspection accepts no parameters";
  if (value.operation === "virtualization.export.backup.retention.inspect" && Object.keys(value.parameters).length !== 0) return "VM retention inspection accepts no parameters";
  if (value.operation === "virtualization.export.backup.restore-drill.inspect") {
    const keys = Object.keys(value.parameters).sort();
    if (keys.length !== vmRestoreDrillKeys.length || keys.some((key, index) => key !== vmRestoreDrillKeys[index])) return "VM restore drills accept only the fixed typed evidence fields";
    const errors = validateVmRestoreDrillInput(value.parameters);
    if (errors.length) return `Invalid VM restore drill plan: ${errors.join(" | ")}`;
  }
  if (value.operation === "virtualization.backup.recovery.inspect") {
    const keys = Object.keys(value.parameters).sort();
    if (keys.length !== vmRecoveryKeys.length || keys.some((key, index) => key !== vmRecoveryKeys[index])) return "VM recovery accepts only the fixed typed protected-backup fields";
    const errors = validateVmRecoveryInput(value.parameters);
    if (errors.length) return `Invalid VM recovery plan: ${errors.join(" | ")}`;
  }
  return null;
}

export async function executeHelperOperation(request, dependencies = {}) {
  const { hostInspect = createHostInspectHelper(), controllerBackups = createControllerBackupHelper(), controllerProtection = createControllerProtectionHelper(), controllerRetention = createControllerRetentionHelper(), prerequisites = createPrerequisiteHelper(), foundation = createLibvirtFoundationHelper(), vmMedia = createVmMediaHelper(), virtualization = createVmHelper(), vmProtection = createVmProtectionHelper(), vmRetention = createVmRetentionHelper(), vmRestoreDrill = createVmRestoreDrillHelper(), vmRecovery = createVmRecoveryHelper(), machineSnapshot = createMachineSnapshotHelper() } = dependencies;
  const error = validateHelperRequest(request);
  if (error) return { version: helperProtocolVersion, id: request?.id ?? null, ok: false, error, code: "invalid_request" };
  if (registry.has(request.operation)) {
    const jobLog = createJobLogWriter({ jobId: request.context?.jobId ?? null, gid: serviceGroupId() });
    const progress = (line, stream) => { void jobLog.append(line, stream); };
    // Every service the ops can name is passed explicitly (with its default), so a
    // dependency missing from the caller's set can never reach an op as undefined.
    return { version: helperProtocolVersion, id: request.id, ok: true, result: await registry.execute(request.operation, request.parameters, { run: fixedRun, runUnit: dependencies.runUnit ?? createRunUnitClient({ run: fixedRun }), apps: dependencies.apps ?? createAppHelper(), vmCloud: dependencies.vmCloud ?? createVmCloudHelper(), credentials: dependencies.credentials ?? createCredentialStore(), vpnProfile: dependencies.vpnProfile ?? createVpnProfileStore(), ...dependencies, hostInspect, controllerBackups, controllerProtection, controllerRetention, prerequisites, foundation, vmMedia, virtualization, vmProtection, vmRetention, vmRestoreDrill, vmRecovery, machineSnapshot, progress, jobLog }) };
  }
  if (request.operation === "container.docker.inspect") {
    return { version: helperProtocolVersion, id: request.id, ok: true, result: await hostInspect.inspectDocker() };
  }
  if (request.operation === "container.docker.inventory") {
    return { version: helperProtocolVersion, id: request.id, ok: true, result: await hostInspect.inventoryDocker() };
  }
  if (request.operation === "controller.database.backup.inspect") {
    return { version: helperProtocolVersion, id: request.id, ok: true, result: await controllerBackups.inspect() };
  }
  if (request.operation === "controller.database.protection.inspect") {
    return { version: helperProtocolVersion, id: request.id, ok: true, result: await controllerProtection.inspect() };
  }
  if (request.operation === "controller.database.protection.retention.inspect") {
    return { version: helperProtocolVersion, id: request.id, ok: true, result: await controllerRetention.inspect() };
  }
  if (request.operation === "virtualization.foundation.inspect") {
    return { version: helperProtocolVersion, id: request.id, ok: true, result: await foundation.inspect() };
  }
  if (request.operation === "virtualization.media.inspect") {
    return { version: helperProtocolVersion, id: request.id, ok: true, result: await vmMedia.inspect() };
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
  if (request.operation === "virtualization.export.backup.inspect") {
    return { version: helperProtocolVersion, id: request.id, ok: true, result: await vmProtection.inspect() };
  }
  if (request.operation === "virtualization.export.backup.retention.inspect") {
    return { version: helperProtocolVersion, id: request.id, ok: true, result: await vmRetention.inspect() };
  }
  if (request.operation === "virtualization.export.backup.restore-drill.inspect") {
    return { version: helperProtocolVersion, id: request.id, ok: true, result: await vmRestoreDrill.inspect(request.parameters) };
  }
  if (request.operation === "virtualization.backup.recovery.inspect") {
    return { version: helperProtocolVersion, id: request.id, ok: true, result: await vmRecovery.inspect(request.parameters) };
  }
  return { version: helperProtocolVersion, id: request.id, ok: false, error: "Operation is not implemented", code: "not_implemented" };
}
