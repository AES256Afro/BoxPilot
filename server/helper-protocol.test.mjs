import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { executeHelperOperation, validateHelperRequest } from "./helper-protocol.mjs";
import { productVersion } from "./version.mjs";

function request(overrides = {}) {
  return { version: 1, id: randomUUID(), operation: "canary.verify", parameters: {}, ...overrides };
}

function vmParameters(overrides = {}) {
  return { name: "ubuntu-lab", osProfile: "ubuntu-24.04", vcpus: 2, memoryMiB: 4096, diskGiB: 40, isoFile: "ubuntu.iso", network: "default", firmware: "uefi", autostart: false, ...overrides };
}

function vmMediaParameters(overrides = {}) {
  return { importId: "77777777-7777-4777-8777-777777777777", filename: "ubuntu.iso", expectedSizeBytes: 8192, expectedSha256: "a".repeat(64), expectedRevision: "b".repeat(64), ...overrides };
}

function lifecycleParameters(overrides = {}) {
  return { name: "ubuntu-lab", action: "shutdown", expectedState: "running", expectedAutostart: false, ...overrides };
}

function snapshotParameters(overrides = {}) {
  return { name: "ubuntu-lab", snapshotName: "pre-upgrade", expectedUuid: "11111111-1111-4111-8111-111111111111", expectedState: "stopped", expectedDiskRevision: "b".repeat(64), expectedSnapshotRevision: "a".repeat(64), ...overrides };
}

function exportParameters(overrides = {}) {
  return { name: "ubuntu-lab", exportId: "22222222-2222-4222-8222-222222222222", expectedUuid: "11111111-1111-4111-8111-111111111111", expectedState: "stopped", expectedDiskRevision: "b".repeat(64), expectedSnapshotRevision: "a".repeat(64), ...overrides };
}

function protectionParameters(overrides = {}) {
  return { backupId: "22222222-2222-4222-8222-222222222222", exportId: "33333333-3333-4333-8333-333333333333", domainName: "ubuntu-lab", domainUuid: "11111111-1111-4111-8111-111111111111", expectedManifestChecksumSha256: "c".repeat(64), expectedSizeBytes: 8192, expectedDestinationRevision: "d".repeat(64), ...overrides };
}

function restoreDrillParameters(overrides = {}) {
  return {
    drillId: "44444444-4444-4444-8444-444444444444", backupId: "22222222-2222-4222-8222-222222222222", exportId: "33333333-3333-4333-8333-333333333333",
    domainName: "ubuntu-lab", domainUuid: "11111111-1111-4111-8111-111111111111", repositoryId: "a".repeat(64), snapshotId: "b".repeat(64),
    expectedManifestChecksumSha256: "c".repeat(64), expectedSizeBytes: 8192, expectedDestinationRevision: "d".repeat(64), ...overrides,
  };
}

function recoveryParameters(overrides = {}) {
  return {
    restoreId: "55555555-5555-4555-8555-555555555555", backupId: "22222222-2222-4222-8222-222222222222", exportId: "33333333-3333-4333-8333-333333333333",
    sourceDomainName: "ubuntu-lab", sourceDomainUuid: "11111111-1111-4111-8111-111111111111", targetDomainName: "ubuntu-recovered",
    restoreDrillId: "44444444-4444-4444-8444-444444444444", repositoryId: "a".repeat(64), snapshotId: "b".repeat(64),
    expectedManifestChecksumSha256: "c".repeat(64), expectedSizeBytes: 8192, expectedDestinationRevision: "d".repeat(64), ...overrides,
  };
}

function retentionParameters(overrides = {}) {
  return {
    retentionId: "77777777-7777-4777-8777-777777777777",
    repositoryId: "a".repeat(64),
    expectedDestinationRevision: "b".repeat(64),
    expectedSnapshotSetRevision: "c".repeat(64),
    forgetSnapshotIds: ["d".repeat(64)],
    ...overrides,
  };
}

function migrationTransferParameters(overrides = {}) {
  return {
    transferId: "88888888-8888-4888-8888-888888888888",
    bundleId: "99999999-9999-4999-8999-999999999999",
    sourceFingerprint: `sha256:${"a".repeat(64)}`,
    contentRevision: "b".repeat(64),
    expectedDestinationState: "empty",
    expectedRemainingBytes: 8192,
    ...overrides,
  };
}

describe("restricted helper protocol", () => {
  it("executes the no-mutation canary", async () => {
    const result = await executeHelperOperation(request());
    expect(result).toMatchObject({ ok: true, result: { verified: true, helperVersion: productVersion, mutationPerformed: false } });
  });

  it("accepts only the fixed smartmontools inspection and exact-version installation", async () => {
    expect(validateHelperRequest(request({ operation: "prerequisite.smartmontools.inspect", parameters: {} }))).toBeNull();
    expect(validateHelperRequest(request({ operation: "prerequisite.smartmontools.inspect", parameters: { package: "curl" } }))).toContain("no parameters");
    expect(validateHelperRequest(request({ operation: "prerequisite.smartmontools.install", parameters: { expectedVersion: "7.5-2" } }))).toBeNull();
    expect(validateHelperRequest(request({ operation: "prerequisite.smartmontools.install", parameters: { expectedVersion: "7.5-2", package: "curl" } }))).toContain('does not accept parameter "package"');
    expect(validateHelperRequest(request({ operation: "prerequisite.smartmontools.install", parameters: { expectedVersion: "$(id)" } }))).toContain("invalid value");
    const prerequisites = {
      inspectSmartmontools: async () => ({ package: "smartmontools", installed: false, candidateVersion: "7.5-2", mutationPerformed: false }),
      installSmartmontools: async ({ expectedVersion }) => ({ package: "smartmontools", installed: true, version: expectedVersion, boundary: { arbitraryPackageAccepted: false } }),
    };
    await expect(executeHelperOperation(request({ operation: "prerequisite.smartmontools.inspect", parameters: {} }), { prerequisites })).resolves.toMatchObject({ ok: true, result: { candidateVersion: "7.5-2", mutationPerformed: false } });
    await expect(executeHelperOperation(request({ operation: "prerequisite.smartmontools.install", parameters: { expectedVersion: "7.5-2" } }), { prerequisites })).resolves.toMatchObject({ ok: true, result: { installed: true, version: "7.5-2", boundary: { arbitraryPackageAccepted: false } } });
  });

  it("accepts only fixed restic inspection and exact-version installation", async () => {
    expect(validateHelperRequest(request({ operation: "prerequisite.restic.inspect", parameters: {} }))).toBeNull();
    expect(validateHelperRequest(request({ operation: "prerequisite.restic.inspect", parameters: { repository: "/tmp/repo" } }))).toContain("no parameters");
    expect(validateHelperRequest(request({ operation: "prerequisite.restic.install", parameters: { expectedVersion: "0.18.1-1" } }))).toBeNull();
    expect(validateHelperRequest(request({ operation: "prerequisite.restic.install", parameters: { expectedVersion: "0.18.1-1", package: "curl" } }))).toContain('does not accept parameter "package"');
    expect(validateHelperRequest(request({ operation: "prerequisite.restic.install", parameters: { expectedVersion: "$(id)" } }))).toContain("invalid value");
    const prerequisites = {
      inspectRestic: async () => ({ package: "restic", installed: false, candidateVersion: "0.18.1-1", mutationPerformed: false }),
      installRestic: async ({ expectedVersion }) => ({ package: "restic", installed: true, version: expectedVersion, binaryVerified: true, boundary: { arbitraryPackageAccepted: false } }),
    };
    await expect(executeHelperOperation(request({ operation: "prerequisite.restic.inspect", parameters: {} }), { prerequisites })).resolves.toMatchObject({ ok: true, result: { candidateVersion: "0.18.1-1", mutationPerformed: false } });
    await expect(executeHelperOperation(request({ operation: "prerequisite.restic.install", parameters: { expectedVersion: "0.18.1-1" } }), { prerequisites })).resolves.toMatchObject({ ok: true, result: { installed: true, version: "0.18.1-1", binaryVerified: true } });
  });

  it("accepts only fixed Docker prerequisite inspection and exact-version installation", async () => {
    expect(validateHelperRequest(request({ operation: "prerequisite.docker.inspect", parameters: {} }))).toBeNull();
    expect(validateHelperRequest(request({ operation: "prerequisite.docker.inspect", parameters: { repository: "example" } }))).toContain("no parameters");
    expect(validateHelperRequest(request({ operation: "prerequisite.docker.install", parameters: { expectedVersion: "28.2.2-0ubuntu1" } }))).toBeNull();
    expect(validateHelperRequest(request({ operation: "prerequisite.docker.install", parameters: { expectedVersion: "28.2.2-0ubuntu1", package: "curl" } }))).toContain('does not accept parameter "package"');
    expect(validateHelperRequest(request({ operation: "prerequisite.docker.install", parameters: { expectedVersion: "$(id)" } }))).toContain("invalid value");
    const prerequisites = {
      inspectDocker: async () => ({ package: "docker.io", installed: false, candidateVersion: "28.2.2-0ubuntu1", mutationPerformed: false }),
      installDocker: async ({ expectedVersion }) => ({ package: "docker.io", installed: true, version: expectedVersion, engineVersion: "28.2.2", engineVerified: true, boundary: { arbitraryPackageAccepted: false, arbitraryRepositoryAccepted: false } }),
    };
    await expect(executeHelperOperation(request({ operation: "prerequisite.docker.inspect", parameters: {} }), { prerequisites })).resolves.toMatchObject({ ok: true, result: { candidateVersion: "28.2.2-0ubuntu1", mutationPerformed: false } });
    await expect(executeHelperOperation(request({ operation: "prerequisite.docker.install", parameters: { expectedVersion: "28.2.2-0ubuntu1" } }), { prerequisites })).resolves.toMatchObject({ ok: true, result: { installed: true, version: "28.2.2-0ubuntu1", engineVerified: true } });
  });

  it("accepts only the fixed virtualization package set", async () => {
    const expectedPackages = { "qemu-system-x86": "1:10.2.1+ds-1ubuntu3.2", "libvirt-daemon-system": "12.0.0-1ubuntu5.2", "libvirt-clients": "12.0.0-1ubuntu5.2", virtinst: "1:5.1.0-1", ovmf: "2025.11-3ubuntu7" };
    expect(validateHelperRequest(request({ operation: "prerequisite.virtualization.inspect", parameters: {} }))).toBeNull();
    expect(validateHelperRequest(request({ operation: "prerequisite.virtualization.inspect", parameters: { uri: "qemu:///session" } }))).toContain("no parameters");
    expect(validateHelperRequest(request({ operation: "prerequisite.virtualization.install", parameters: { expectedPackages } }))).toBeNull();
    expect(validateHelperRequest(request({ operation: "prerequisite.virtualization.install", parameters: { expectedPackages: { ...expectedPackages, curl: "1.0" } } }))).toContain("must list exactly");
    expect(validateHelperRequest(request({ operation: "prerequisite.virtualization.install", parameters: { expectedPackages: { ...expectedPackages, ovmf: "$(id)" } } }))).toContain("exact Debian version");
    const prerequisites = {
      inspectVirtualization: async () => ({ installed: false, candidatePackages: expectedPackages, repairAvailable: true, mutationPerformed: false }),
      installVirtualization: async ({ expectedPackages: packages }) => ({ installed: true, packages, connectionUri: "qemu:///system", kvmDeviceVerified: true, boundary: { arbitraryPackageAccepted: false, virtualMachineCreated: false } }),
    };
    await expect(executeHelperOperation(request({ operation: "prerequisite.virtualization.inspect", parameters: {} }), { prerequisites })).resolves.toMatchObject({ ok: true, result: { repairAvailable: true, mutationPerformed: false } });
    await expect(executeHelperOperation(request({ operation: "prerequisite.virtualization.install", parameters: { expectedPackages } }), { prerequisites })).resolves.toMatchObject({ ok: true, result: { installed: true, packages: expectedPackages, connectionUri: "qemu:///system", kvmDeviceVerified: true } });
  });

  it("accepts only exact APT metadata evidence and no package or command input", async () => {
    const updatedAt = "2026-08-01T00:00:00.000Z";
    expect(validateHelperRequest(request({ operation: "prerequisite.apt-metadata.inspect", parameters: {} }))).toBeNull();
    expect(validateHelperRequest(request({ operation: "prerequisite.apt-metadata.inspect", parameters: { command: "apt upgrade" } }))).toContain("no parameters");
    expect(validateHelperRequest(request({ operation: "prerequisite.apt-metadata.refresh", parameters: { expectedUpdatedAt: updatedAt } }))).toBeNull();
    expect(validateHelperRequest(request({ operation: "prerequisite.apt-metadata.refresh", parameters: { expectedUpdatedAt: null } }))).toBeNull();
    expect(validateHelperRequest(request({ operation: "prerequisite.apt-metadata.refresh", parameters: { expectedUpdatedAt: updatedAt, package: "curl" } }))).toContain('does not accept parameter "package"');
    expect(validateHelperRequest(request({ operation: "prerequisite.apt-metadata.refresh", parameters: { expectedUpdatedAt: "yesterday" } }))).toContain("ISO-8601");
    const prerequisites = {
      inspectAptMetadata: async () => ({ state: "stale", updatedAt, refreshAvailable: true, mutationPerformed: false }),
      refreshAptMetadata: async () => ({ refreshed: true, state: "current", boundary: { fixedAptUpdateOnly: true, packageInstallPerformed: false } }),
    };
    await expect(executeHelperOperation(request({ operation: "prerequisite.apt-metadata.inspect", parameters: {} }), { prerequisites })).resolves.toMatchObject({ ok: true, result: { state: "stale", mutationPerformed: false } });
    await expect(executeHelperOperation(request({ operation: "prerequisite.apt-metadata.refresh", parameters: { expectedUpdatedAt: updatedAt } }), { prerequisites })).resolves.toMatchObject({ ok: true, result: { refreshed: true, boundary: { fixedAptUpdateOnly: true, packageInstallPerformed: false } } });
  });

  it("rejects arbitrary operation names and parameters", () => {
    expect(validateHelperRequest(request({ operation: "shell.exec" }))).toBe("Operation is not allowlisted");
    expect(validateHelperRequest(request({ parameters: { command: "id" } }))).toBe("Helper canary accepts no parameters");
  });

  it("returns only the Docker server availability and version", async () => {
    const result = await executeHelperOperation(request({ operation: "container.docker.inspect", parameters: {} }), {
      hostInspect: { inspectDocker: async () => ({ available: true, version: "29.1.3" }) },
    });
    expect(result).toMatchObject({ ok: true, result: { available: true, version: "29.1.3" } });
  });

  it("keeps controller backup inspection read-only and routes creation through the registry", async () => {
    expect(validateHelperRequest(request({ operation: "controller.database.backup.inspect", parameters: {} }))).toBeNull();
    expect(validateHelperRequest(request({ operation: "controller.database.backup.inspect", parameters: { database: "/tmp/db" } }))).toContain("no parameters");
    expect(validateHelperRequest(request({ operation: "controller.database.backup.create", parameters: { backupId: randomUUID() } }))).toBe("Operation is not allowlisted");
    const controllerBackups = {
      inspect: async () => ({ healthy: true, boundary: { mutationPerformed: false } }),
      createBackup: async (parameters) => ({ ...parameters, applicationId: "boxpilot-controller", consistentSnapshot: true, restoreDrill: { passed: true } }),
    };
    await expect(executeHelperOperation(request({ operation: "controller.database.backup.inspect", parameters: {} }), { controllerBackups })).resolves.toMatchObject({ ok: true, result: { healthy: true, boundary: { mutationPerformed: false } } });
    await expect(executeHelperOperation(request({ operation: "controller.backup.create", parameters: {} }), { controllerBackups })).resolves.toMatchObject({ ok: true, result: { applicationId: "boxpilot-controller", consistentSnapshot: true } });
  });

  it("keeps controller protection inspection read-only and rejects the legacy create", async () => {
    expect(validateHelperRequest(request({ operation: "controller.database.protection.inspect", parameters: {} }))).toBeNull();
    expect(validateHelperRequest(request({ operation: "controller.database.protection.inspect", parameters: { repository: "/tmp" } }))).toContain("no parameters");
    expect(validateHelperRequest(request({ operation: "controller.database.protection.create", parameters: { protectionId: randomUUID() } }))).toBe("Operation is not allowlisted");
    const controllerProtection = { inspect: async () => ({ ready: false, setupCommand: "sudo setup", boundary: { mutationPerformed: false } }) };
    await expect(executeHelperOperation(request({ operation: "controller.database.protection.inspect", parameters: {} }), { controllerProtection })).resolves.toMatchObject({ ok: true, result: { ready: false, boundary: { mutationPerformed: false } } });
  });

  it("keeps controller retention inspection read-only and rejects the legacy apply", async () => {
    expect(validateHelperRequest(request({ operation: "controller.database.protection.retention.inspect", parameters: {} }))).toBeNull();
    expect(validateHelperRequest(request({ operation: "controller.database.protection.retention.inspect", parameters: { repository: "/tmp" } }))).toContain("no parameters");
    expect(validateHelperRequest(request({ operation: "controller.database.protection.retention.apply", parameters: { retentionId: randomUUID() } }))).toBe("Operation is not allowlisted");
    const controllerRetention = { inspect: async () => ({ ready: true, snapshots: [] }) };
    await expect(executeHelperOperation(request({ operation: "controller.database.protection.retention.inspect", parameters: {} }), { controllerRetention })).resolves.toMatchObject({ ok: true, result: { ready: true, snapshots: [] } });
  });

  it("rejects incompatible versions and malformed ids", () => {
    expect(validateHelperRequest(request({ version: 99 }))).toBe("Unsupported helper protocol version");
    expect(validateHelperRequest(request({ id: "not-a-uuid" }))).toBe("Request id must be a UUID");
  });

  it("routes VM creation through the registry and rejects the legacy operation", async () => {
    expect(validateHelperRequest(request({ operation: "virtualization.domain.create", parameters: vmParameters() }))).toBe("Operation is not allowlisted");
    const virtualization = { create: async (parameters) => ({ created: true, verified: true, domain: parameters.name }) };
    const result = await executeHelperOperation(request({ operation: "vm.create", parameters: vmParameters() }), { virtualization });
    expect(result).toMatchObject({ ok: true, result: { created: true, verified: true, domain: "ubuntu-lab" } });
  });

  it("keeps VM media inspection read-only and routes the import through the registry", async () => {
    expect(validateHelperRequest(request({ operation: "virtualization.media.inspect", parameters: {} }))).toBeNull();
    expect(validateHelperRequest(request({ operation: "virtualization.media.inspect", parameters: { path: "/tmp" } }))).toContain("no parameters");
    expect(validateHelperRequest(request({ operation: "virtualization.media.import", parameters: vmMediaParameters() }))).toBe("Operation is not allowlisted");
    const vmMedia = {
      inspect: async () => ({ inbox: { candidates: [] }, boundary: { mutationPerformed: false } }),
      importMedia: async (parameters) => ({ imported: true, verified: true, filename: parameters.filename, sha256: parameters.expectedSha256 }),
    };
    await expect(executeHelperOperation(request({ operation: "virtualization.media.inspect", parameters: {} }), { vmMedia })).resolves.toMatchObject({ ok: true, result: { boundary: { mutationPerformed: false } } });
    await expect(executeHelperOperation(request({ operation: "vm.media.import", parameters: vmMediaParameters() }), { vmMedia })).resolves.toMatchObject({ ok: true, result: { imported: true, filename: "ubuntu.iso" } });
  });

  it("accepts only fixed read-only virtualization inventory scopes", async () => {
    expect(validateHelperRequest(request({ operation: "virtualization.inventory.inspect", parameters: { scope: "domains" } }))).toBeNull();
    expect(validateHelperRequest(request({ operation: "virtualization.inventory.inspect", parameters: { scope: "domain", name: "ubuntu-lab" } }))).toContain("fixed status, domains, or resources scope");
    expect(validateHelperRequest(request({ operation: "virtualization.inventory.inspect", parameters: { scope: "../../etc" } }))).toContain("fixed status, domains, or resources scope");
    const virtualization = { inventory: async ({ scope }) => ({ scope, connected: true }) };
    const result = await executeHelperOperation(request({ operation: "virtualization.inventory.inspect", parameters: { scope: "resources" } }), { virtualization });
    expect(result).toMatchObject({ ok: true, result: { scope: "resources", connected: true } });
  });

  it("keeps foundation inspection read-only and routes initialization through the registry", async () => {
    expect(validateHelperRequest(request({ operation: "virtualization.foundation.inspect", parameters: {} }))).toBeNull();
    expect(validateHelperRequest(request({ operation: "virtualization.foundation.inspect", parameters: { pool: "custom" } }))).toContain("no parameters");
    expect(validateHelperRequest(request({ operation: "virtualization.foundation.initialize", parameters: { foundationId: randomUUID(), expectedRevision: "a".repeat(64) } }))).toBe("Operation is not allowlisted");
    const foundation = {
      inspect: async () => ({ ready: false, revision: "a".repeat(64), mutationPerformed: false }),
      initialize: async () => ({ initialized: true, ready: true }),
    };
    await expect(executeHelperOperation(request({ operation: "virtualization.foundation.inspect", parameters: {} }), { foundation })).resolves.toMatchObject({ ok: true, result: { ready: false } });
    await expect(executeHelperOperation(request({ operation: "vm.foundation.initialize", parameters: {} }), { foundation })).resolves.toMatchObject({ ok: true, result: { initialized: true, ready: true } });
  });

  it("accepts only a parameter-free console handoff inspection", async () => {
    expect(validateHelperRequest(request({ operation: "virtualization.console.inspect", parameters: {} }))).toBeNull();
    expect(validateHelperRequest(request({ operation: "virtualization.console.inspect", parameters: { port: 22 } }))).toContain("accepts no parameters");
    const virtualization = { consoleGuidance: async () => ({ nativeProxyAvailable: false, cockpit: { active: true, port: 9090 } }) };
    const result = await executeHelperOperation(request({ operation: "virtualization.console.inspect", parameters: {} }), { virtualization });
    expect(result).toMatchObject({ ok: true, result: { nativeProxyAvailable: false, cockpit: { active: true, port: 9090 } } });
  });

  it("keeps export inspection exact and routes export creation through the registry", async () => {
    expect(validateHelperRequest(request({ operation: "virtualization.domain.export.inspect", parameters: { name: "ubuntu-lab" } }))).toBeNull();
    expect(validateHelperRequest(request({ operation: "virtualization.domain.export.inspect", parameters: { name: "../../etc" } }))).toContain("exact domain name");
    expect(validateHelperRequest(request({ operation: "virtualization.domain.export.create", parameters: exportParameters() }))).toBe("Operation is not allowlisted");
    const virtualization = {
      inspectExport: async ({ name }) => ({ domain: name, state: "stopped" }),
      createExport: async (parameters) => ({ created: true, contentVerified: true, domain: parameters.name, exportId: parameters.exportId, protected: false }),
    };
    await expect(executeHelperOperation(request({ operation: "virtualization.domain.export.inspect", parameters: { name: "ubuntu-lab" } }), { virtualization })).resolves.toMatchObject({ ok: true, result: { state: "stopped" } });
    await expect(executeHelperOperation(request({ operation: "vm.export.create", parameters: exportParameters() }), { virtualization })).resolves.toMatchObject({ ok: true, result: { contentVerified: true, protected: false } });
  });

  it("keeps protection inspection read-only and routes the encrypted backup through the registry", async () => {
    expect(validateHelperRequest(request({ operation: "virtualization.export.backup.inspect", parameters: {} }))).toBeNull();
    expect(validateHelperRequest(request({ operation: "virtualization.export.backup.inspect", parameters: { repository: "/tmp" } }))).toContain("accepts no parameters");
    expect(validateHelperRequest(request({ operation: "virtualization.export.backup.create", parameters: protectionParameters() }))).toBe("Operation is not allowlisted");
    const vmProtection = {
      inspect: async () => ({ ready: true, encrypted: true, independent: true }),
      createBackup: async (parameters) => ({ created: true, backupId: parameters.backupId, encrypted: true, independent: true, protected: false }),
    };
    await expect(executeHelperOperation(request({ operation: "virtualization.export.backup.inspect", parameters: {} }), { vmProtection })).resolves.toMatchObject({ ok: true, result: { ready: true, encrypted: true } });
    await expect(executeHelperOperation(request({ operation: "vm.export.protect", parameters: protectionParameters() }), { vmProtection })).resolves.toMatchObject({ ok: true, result: { created: true, protected: false } });
  });

  it("keeps retention inspection read-only and routes the apply through the registry", async () => {
    expect(validateHelperRequest(request({ operation: "virtualization.export.backup.retention.inspect", parameters: {} }))).toBeNull();
    expect(validateHelperRequest(request({ operation: "virtualization.export.backup.retention.inspect", parameters: { repository: "/tmp" } }))).toContain("accepts no parameters");
    expect(validateHelperRequest(request({ operation: "virtualization.export.backup.retention.apply", parameters: retentionParameters() }))).toBe("Operation is not allowlisted");
    const vmRetention = {
      inspect: async () => ({ ready: true, snapshots: [] }),
      apply: async (parameters) => ({ applied: true, retentionId: parameters.retentionId, forgottenSnapshotIds: parameters.forgetSnapshotIds, prunePerformed: false }),
    };
    await expect(executeHelperOperation(request({ operation: "virtualization.export.backup.retention.inspect", parameters: {} }), { vmRetention })).resolves.toMatchObject({ ok: true, result: { ready: true } });
    await expect(executeHelperOperation(request({ operation: "vm.backup.retention.apply", parameters: retentionParameters() }), { vmRetention })).resolves.toMatchObject({ ok: true, result: { applied: true, prunePerformed: false } });
  });

  it("keeps the drill inspection typed and routes the drill run through the registry", async () => {
    expect(validateHelperRequest(request({ operation: "virtualization.export.backup.restore-drill.inspect", parameters: restoreDrillParameters() }))).toBeNull();
    expect(validateHelperRequest(request({ operation: "virtualization.export.backup.restore-drill.inspect", parameters: restoreDrillParameters({ network: "default" }) }))).toContain("only the fixed typed evidence fields");
    expect(validateHelperRequest(request({ operation: "virtualization.export.backup.restore-drill", parameters: restoreDrillParameters() }))).toBe("Operation is not allowlisted");
    const vmRestoreDrill = {
      inspect: async (parameters) => ({ ready: true, drillId: parameters.drillId, network: "none", transient: true }),
      runDrill: async (parameters) => ({ passed: true, drillId: parameters.drillId, backupId: parameters.backupId, network: "none", protected: true }),
    };
    await expect(executeHelperOperation(request({ operation: "virtualization.export.backup.restore-drill.inspect", parameters: restoreDrillParameters() }), { vmRestoreDrill })).resolves.toMatchObject({ ok: true, result: { ready: true, network: "none" } });
    await expect(executeHelperOperation(request({ operation: "vm.backup.restore-drill", parameters: restoreDrillParameters() }), { vmRestoreDrill })).resolves.toMatchObject({ ok: true, result: { passed: true, protected: true } });
  });

  it("keeps the recovery inspection typed and routes the clone through the registry", async () => {
    expect(validateHelperRequest(request({ operation: "virtualization.backup.recovery.inspect", parameters: recoveryParameters() }))).toBeNull();
    expect(validateHelperRequest(request({ operation: "virtualization.backup.recovery.inspect", parameters: recoveryParameters({ path: "/tmp/restore" }) }))).toContain("only the fixed typed protected-backup fields");
    expect(validateHelperRequest(request({ operation: "virtualization.backup.recovery.create", parameters: recoveryParameters() }))).toBe("Operation is not allowlisted");
    const vmRecovery = {
      inspect: async (parameters) => ({ ready: true, targetDomainName: parameters.targetDomainName, network: "none", persistent: true, initialState: "stopped" }),
      createRecovery: async (parameters) => ({ created: true, restoreId: parameters.restoreId, domain: parameters.targetDomainName, network: "none", persistent: true, state: "stopped" }),
    };
    await expect(executeHelperOperation(request({ operation: "virtualization.backup.recovery.inspect", parameters: recoveryParameters() }), { vmRecovery })).resolves.toMatchObject({ ok: true, result: { ready: true, network: "none", initialState: "stopped" } });
    await expect(executeHelperOperation(request({ operation: "vm.recovery.create", parameters: recoveryParameters() }), { vmRecovery })).resolves.toMatchObject({ ok: true, result: { created: true, domain: "ubuntu-recovered", persistent: true } });
  });
});
