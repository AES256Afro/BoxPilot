import { productVersion } from "../version.mjs";
import { defineOperation } from "./registry.mjs";

const debianVersion = /^[0-9A-Za-z.+:~_-]{1,64}$/;
const virtualizationPackageKeys = ["libvirt-clients", "libvirt-daemon-system", "ovmf", "qemu-system-x86", "virtinst"];
const minutes = (value) => value * 60_000;

const exactVersion = { fields: { expectedVersion: { type: "string", pattern: debianVersion } } };
const noParameters = { fields: {} };

function validExpectedPackages(packages) {
  if (!packages || typeof packages !== "object" || Array.isArray(packages)) return "must be an object of package name to exact version";
  const keys = Object.keys(packages).sort();
  if (keys.length !== virtualizationPackageKeys.length || !keys.every((key, index) => key === virtualizationPackageKeys[index])) return `must list exactly ${virtualizationPackageKeys.join(", ")}`;
  if (!keys.every((key) => typeof packages[key] === "string" && debianVersion.test(packages[key]))) return "every version must be an exact Debian version string";
  return null;
}

function validIsoTimestamp(value) {
  return value.length <= 32 && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value ? null : "must be an exact ISO-8601 timestamp";
}

/** Canary plus the fixed prerequisite inspect/install pairs. Dependencies: `{ prerequisites }` from createPrerequisiteHelper(). */
export function prerequisiteOperations() {
  return [
    defineOperation({
      id: "canary.verify", title: "Helper canary", risk: "low", readOnly: true, parameters: noParameters,
      description: "Confirms the helper socket answers and reports its version.",
      run: async () => ({ verified: true, helperVersion: productVersion, mutationPerformed: false }),
    }),
    defineOperation({ id: "prerequisite.smartmontools.inspect", title: "Inspect smartmontools", risk: "low", readOnly: true, parameters: noParameters, run: (_p, { prerequisites }) => prerequisites.inspectSmartmontools() }),
    defineOperation({ id: "prerequisite.smartmontools.install", title: "Install smartmontools", risk: "medium", timeoutMs: minutes(15), parameters: exactVersion, run: (parameters, { prerequisites }) => prerequisites.installSmartmontools(parameters) }),
    defineOperation({ id: "prerequisite.restic.inspect", title: "Inspect restic", risk: "low", readOnly: true, parameters: noParameters, run: (_p, { prerequisites }) => prerequisites.inspectRestic() }),
    defineOperation({ id: "prerequisite.restic.install", title: "Install restic", risk: "medium", timeoutMs: minutes(15), parameters: exactVersion, run: (parameters, { prerequisites }) => prerequisites.installRestic(parameters) }),
    defineOperation({ id: "prerequisite.docker.inspect", title: "Inspect Docker Engine", risk: "low", readOnly: true, parameters: noParameters, run: (_p, { prerequisites }) => prerequisites.inspectDocker() }),
    defineOperation({ id: "prerequisite.docker.install", title: "Install Docker Engine", risk: "medium", timeoutMs: minutes(15), parameters: exactVersion, run: (parameters, { prerequisites }) => prerequisites.installDocker(parameters) }),
    defineOperation({ id: "prerequisite.virtualization.inspect", title: "Inspect KVM/QEMU/libvirt", risk: "low", readOnly: true, parameters: noParameters, run: (_p, { prerequisites }) => prerequisites.inspectVirtualization() }),
    defineOperation({
      id: "prerequisite.virtualization.install", title: "Install KVM/QEMU/libvirt", risk: "medium", timeoutMs: minutes(15),
      parameters: { fields: { expectedPackages: { type: "object", validate: validExpectedPackages } } },
      run: (parameters, { prerequisites }) => prerequisites.installVirtualization(parameters),
    }),
    defineOperation({ id: "prerequisite.apt-metadata.inspect", title: "Inspect APT metadata", risk: "low", readOnly: true, parameters: noParameters, run: (_p, { prerequisites }) => prerequisites.inspectAptMetadata() }),
    defineOperation({
      id: "prerequisite.apt-metadata.refresh", title: "Refresh APT metadata", risk: "low", timeoutMs: minutes(15),
      parameters: { fields: { expectedUpdatedAt: { type: "string", nullable: true, validate: validIsoTimestamp } } },
      run: (parameters, { prerequisites }) => prerequisites.refreshAptMetadata(parameters),
    }),
  ];
}
