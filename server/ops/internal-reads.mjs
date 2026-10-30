import { defineOperation } from "./registry.mjs";
import { validateDomainName } from "../libvirt.mjs";
import { validateVmRestoreDrillInput } from "../vm-restore-drill-helper.mjs";
import { validateVmRecoveryInput } from "../vm-recovery-helper.mjs";

/**
 * Reads the web side's own services make through the helper: Docker's inventory for the Repair
 * scan, the database backup destination, the VM foundation, library, inventory and backups. Each
 * is internal, so it is never run from the operations route, staged, scheduled or proposed; the
 * page that shows its answer decides who may see it.
 */
const noParameters = { fields: {} };
const typed = (names, types = {}) => Object.fromEntries(names.map((name) => [name, { type: types[name] ?? "string" }]));
const problems = (errors, label) => (errors.length ? `Invalid ${label}: ${errors.join(" | ")}` : null);
const read = (definition) => defineOperation({ risk: "low", readOnly: true, internal: true, parameters: noParameters, ...definition });

export const vmRestoreDrillFields = ["backupId", "domainName", "domainUuid", "drillId", "expectedDestinationRevision", "expectedManifestChecksumSha256", "expectedSizeBytes", "exportId", "repositoryId", "snapshotId"];
export const vmRecoveryFields = ["backupId", "expectedDestinationRevision", "expectedManifestChecksumSha256", "expectedSizeBytes", "exportId", "repositoryId", "restoreDrillId", "restoreId", "snapshotId", "sourceDomainName", "sourceDomainUuid", "targetDomainName"];

export function internalReadOperations() {
  return [
    read({
      id: "container.docker.inventory", title: "List Docker containers, images, networks and volumes",
      run: (_parameters, { hostInspect }) => hostInspect.inventoryDocker(),
    }),
    read({
      id: "controller.database.protection.inspect", title: "Check the encrypted copy of BoxPilot's database",
      run: (_parameters, { controllerProtection }) => controllerProtection.inspect(),
    }),
    read({
      id: "controller.database.protection.retention.inspect", title: "Preview which old database backups can go",
      run: (_parameters, { controllerRetention }) => controllerRetention.inspect(),
    }),
    read({
      id: "virtualization.foundation.inspect", title: "Check the default VM network and storage",
      run: (_parameters, { foundation }) => foundation.inspect(),
    }),
    read({
      id: "virtualization.media.inspect", title: "List the ISO library",
      run: (_parameters, { vmMedia }) => vmMedia.inspect(),
    }),
    read({
      id: "virtualization.inventory.inspect", title: "List VMs and their resources",
      parameters: { fields: { scope: { type: "string", enum: ["status", "domains", "domains-summary", "resources"] } } },
      run: (parameters, { virtualization }) => virtualization.inventory(parameters),
    }),
    read({
      id: "virtualization.console.inspect", title: "Explain how to reach a VM's console",
      run: (_parameters, { virtualization }) => virtualization.consoleGuidance(),
    }),
    read({
      id: "virtualization.domain.export.inspect", title: "Check whether a VM can be exported",
      parameters: { fields: { name: { type: "string", maxLength: 64, validate: (name) => (validateDomainName(name) ? null : "must be an exact domain name") } } },
      run: (parameters, { virtualization }) => virtualization.inspectExport(parameters),
    }),
    read({
      id: "virtualization.export.backup.inspect", title: "Check the encrypted VM backup repository",
      run: (_parameters, { vmProtection }) => vmProtection.inspect(),
    }),
    read({
      id: "virtualization.export.backup.retention.inspect", title: "Preview which old VM backups can go",
      run: (_parameters, { vmRetention }) => vmRetention.inspect(),
    }),
    read({
      id: "virtualization.export.backup.restore-drill.inspect", title: "Check a VM backup before a test restore",
      parameters: { fields: typed(vmRestoreDrillFields, { expectedSizeBytes: "number" }), validate: (parameters) => problems(validateVmRestoreDrillInput(parameters), "VM restore drill plan") },
      run: (parameters, { vmRestoreDrill }) => vmRestoreDrill.inspect(parameters),
    }),
    read({
      id: "virtualization.backup.recovery.inspect", title: "Check a VM backup before a recovery clone",
      parameters: { fields: typed(vmRecoveryFields, { expectedSizeBytes: "number" }), validate: (parameters) => problems(validateVmRecoveryInput(parameters), "VM recovery plan") },
      run: (parameters, { vmRecovery }) => vmRecovery.inspect(parameters),
    }),
  ];
}
