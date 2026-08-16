import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { executeHelperOperation, validateHelperRequest } from "./helper-protocol.mjs";

function request(overrides = {}) {
  return { version: 1, id: randomUUID(), operation: "canary.verify", parameters: {}, ...overrides };
}

function vmParameters(overrides = {}) {
  return { name: "ubuntu-lab", osProfile: "ubuntu-24.04", vcpus: 2, memoryMiB: 4096, diskGiB: 40, isoFile: "ubuntu.iso", network: "default", firmware: "uefi", autostart: false, ...overrides };
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
    expect(result).toMatchObject({ ok: true, result: { verified: true, helperVersion: "0.59.0", mutationPerformed: false } });
  });

  it("accepts only the fixed smartmontools inspection and exact-version installation", async () => {
    expect(validateHelperRequest(request({ operation: "prerequisite.smartmontools.inspect", parameters: {} }))).toBeNull();
    expect(validateHelperRequest(request({ operation: "prerequisite.smartmontools.inspect", parameters: { package: "curl" } }))).toContain("no parameters");
    expect(validateHelperRequest(request({ operation: "prerequisite.smartmontools.install", parameters: { expectedVersion: "7.5-2" } }))).toBeNull();
    expect(validateHelperRequest(request({ operation: "prerequisite.smartmontools.install", parameters: { expectedVersion: "7.5-2", package: "curl" } }))).toContain("only one exact expectedVersion");
    expect(validateHelperRequest(request({ operation: "prerequisite.smartmontools.install", parameters: { expectedVersion: "$(id)" } }))).toContain("only one exact expectedVersion");
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
    expect(validateHelperRequest(request({ operation: "prerequisite.restic.install", parameters: { expectedVersion: "0.18.1-1", package: "curl" } }))).toContain("only one exact expectedVersion");
    expect(validateHelperRequest(request({ operation: "prerequisite.restic.install", parameters: { expectedVersion: "$(id)" } }))).toContain("only one exact expectedVersion");
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
    expect(validateHelperRequest(request({ operation: "prerequisite.docker.install", parameters: { expectedVersion: "28.2.2-0ubuntu1", package: "curl" } }))).toContain("only one exact expectedVersion");
    expect(validateHelperRequest(request({ operation: "prerequisite.docker.install", parameters: { expectedVersion: "$(id)" } }))).toContain("only one exact expectedVersion");
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
    expect(validateHelperRequest(request({ operation: "prerequisite.virtualization.install", parameters: { expectedPackages: { ...expectedPackages, curl: "1.0" } } }))).toContain("exact fixed expectedPackages");
    expect(validateHelperRequest(request({ operation: "prerequisite.virtualization.install", parameters: { expectedPackages: { ...expectedPackages, ovmf: "$(id)" } } }))).toContain("exact fixed expectedPackages");
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
    expect(validateHelperRequest(request({ operation: "prerequisite.apt-metadata.refresh", parameters: { expectedUpdatedAt: updatedAt, package: "curl" } }))).toContain("only one exact");
    expect(validateHelperRequest(request({ operation: "prerequisite.apt-metadata.refresh", parameters: { expectedUpdatedAt: "yesterday" } }))).toContain("only one exact");
    const prerequisites = {
      inspectAptMetadata: async () => ({ state: "stale", updatedAt, refreshAvailable: true, mutationPerformed: false }),
      refreshAptMetadata: async () => ({ refreshed: true, state: "current", boundary: { fixedAptUpdateOnly: true, packageInstallPerformed: false } }),
    };
    await expect(executeHelperOperation(request({ operation: "prerequisite.apt-metadata.inspect", parameters: {} }), { prerequisites })).resolves.toMatchObject({ ok: true, result: { state: "stale", mutationPerformed: false } });
    await expect(executeHelperOperation(request({ operation: "prerequisite.apt-metadata.refresh", parameters: { expectedUpdatedAt: updatedAt } }), { prerequisites })).resolves.toMatchObject({ ok: true, result: { refreshed: true, boundary: { fixedAptUpdateOnly: true, packageInstallPerformed: false } } });
  });

  it("rejects arbitrary operation names and parameters", () => {
    expect(validateHelperRequest(request({ operation: "shell.exec" }))).toBe("Operation is not allowlisted");
    expect(validateHelperRequest(request({ parameters: { command: "id" } }))).toBe("Canary operation accepts no parameters");
  });

  it("accepts only the typed Uptime Kuma port parameter", () => {
    expect(validateHelperRequest(request({ operation: "container.docker.inspect", parameters: {} }))).toBeNull();
    expect(validateHelperRequest(request({ operation: "container.docker.inspect", parameters: { socket: "/var/run/docker.sock" } }))).toContain("no parameters");
    expect(validateHelperRequest(request({ operation: "application.uptime-kuma.inspect", parameters: {} }))).toBeNull();
    expect(validateHelperRequest(request({ operation: "application.uptime-kuma.lifecycle.inspect", parameters: {} }))).toBeNull();
    expect(validateHelperRequest(request({ operation: "application.uptime-kuma.lifecycle.inspect", parameters: { container: "other" } }))).toContain("no parameters");
    expect(validateHelperRequest(request({ operation: "application.uptime-kuma.action", parameters: { action: "restart", expectedRevision: "a".repeat(64) } }))).toBeNull();
    expect(validateHelperRequest(request({ operation: "application.uptime-kuma.action", parameters: { action: "remove", expectedRevision: "a".repeat(64) } }))).toContain("fixed action");
    expect(validateHelperRequest(request({ operation: "application.uptime-kuma.action", parameters: { action: "restart", expectedRevision: "a".repeat(64), command: "sh" } }))).toContain("fixed action");
    expect(validateHelperRequest(request({ operation: "application.uptime-kuma.private-access.inspect", parameters: {} }))).toBeNull();
    expect(validateHelperRequest(request({ operation: "application.uptime-kuma.private-access.inspect", parameters: { port: 3101 } }))).toContain("no parameters");
    expect(validateHelperRequest(request({ operation: "application.uptime-kuma.private-access.configure", parameters: { action: "publish", expectedRevision: "a".repeat(64) } }))).toBeNull();
    expect(validateHelperRequest(request({ operation: "application.uptime-kuma.private-access.configure", parameters: { action: "funnel", expectedRevision: "a".repeat(64) } }))).toContain("fixed action");
    expect(validateHelperRequest(request({ operation: "application.uptime-kuma.private-access.configure", parameters: { action: "publish", expectedRevision: "a".repeat(64), target: "evil" } }))).toContain("fixed action");
    expect(validateHelperRequest(request({ operation: "application.uptime-kuma.deploy", parameters: { hostPort: 3001 } }))).toBeNull();
    expect(validateHelperRequest(request({ operation: "application.uptime-kuma.deploy", parameters: { hostPort: 53 } }))).toContain("hostPort");
    expect(validateHelperRequest(request({ operation: "application.uptime-kuma.deploy", parameters: { hostPort: 3001, image: "evil" } }))).toContain("only a hostPort");
    expect(validateHelperRequest(request({ operation: "application.uptime-kuma.backup", parameters: { backupId: randomUUID() } }))).toBeNull();
    expect(validateHelperRequest(request({ operation: "application.uptime-kuma.backup", parameters: { backupId: "../../etc" } }))).toContain("backupId UUID");
    expect(validateHelperRequest(request({ operation: "application.uptime-kuma.backup", parameters: { backupId: randomUUID(), destination: "/tmp" } }))).toContain("only a backupId");
    expect(validateHelperRequest(request({ operation: "container.docker.inventory", parameters: {} }))).toBeNull();
    expect(validateHelperRequest(request({ operation: "container.docker.inventory", parameters: { labels: true } }))).toContain("no parameters");
    expect(validateHelperRequest(request({ operation: "system.logs.inspect", parameters: { source: "boxpilot", limit: 50 } }))).toBeNull();
    expect(validateHelperRequest(request({ operation: "system.logs.inspect", parameters: { source: "../../etc", limit: 50 } }))).toContain("fixed source");
    expect(validateHelperRequest(request({ operation: "system.logs.inspect", parameters: { source: "docker", limit: 500 } }))).toContain("1 to 200");
  });

  it("delegates only the exact managed Uptime Kuma lifecycle request", async () => {
    const expectedRevision = "a".repeat(64);
    const applications = {
      inspectUptimeKumaLifecycle: vi.fn(async () => ({ installed: true, managed: true, revision: expectedRevision, allowedActions: ["restart"], mutationPerformed: false })),
      actionUptimeKuma: vi.fn(async (parameters) => ({ applicationId: "uptime-kuma", ...parameters, performed: true, dataPreserved: true })),
    };
    await expect(executeHelperOperation(request({ operation: "application.uptime-kuma.lifecycle.inspect", parameters: {} }), { applications })).resolves.toMatchObject({ ok: true, result: { installed: true, managed: true, mutationPerformed: false } });
    await expect(executeHelperOperation(request({ operation: "application.uptime-kuma.action", parameters: { action: "restart", expectedRevision } }), { applications })).resolves.toMatchObject({ ok: true, result: { applicationId: "uptime-kuma", action: "restart", expectedRevision, performed: true, dataPreserved: true } });
  });

  it("delegates only fixed Uptime Kuma private access inspection and configuration", async () => {
    const expectedRevision = "c".repeat(64);
    const applications = {
      inspectUptimeKumaPrivateAccess: vi.fn(async () => ({ connected: true, published: false, revision: expectedRevision, allowedActions: ["publish"], boundary: { mutationPerformed: false } })),
      configureUptimeKumaPrivateAccess: vi.fn(async (parameters) => ({ applicationId: "uptime-kuma", ...parameters, performed: true, published: true, tailnetOnly: true, boundary: { publicExposure: false, arbitraryTargetAccepted: false } })),
    };
    await expect(executeHelperOperation(request({ operation: "application.uptime-kuma.private-access.inspect", parameters: {} }), { applications })).resolves.toMatchObject({ ok: true, result: { connected: true, published: false, boundary: { mutationPerformed: false } } });
    await expect(executeHelperOperation(request({ operation: "application.uptime-kuma.private-access.configure", parameters: { action: "publish", expectedRevision } }), { applications })).resolves.toMatchObject({ ok: true, result: { applicationId: "uptime-kuma", action: "publish", expectedRevision, performed: true, published: true, tailnetOnly: true, boundary: { publicExposure: false, arbitraryTargetAccepted: false } } });
  });

  it("accepts only a private Pi-hole LAN binding and high web port", () => {
    expect(validateHelperRequest(request({ operation: "application.pi-hole.inspect", parameters: {} }))).toBeNull();
    expect(validateHelperRequest(request({ operation: "application.pi-hole.lifecycle.inspect", parameters: {} }))).toBeNull();
    expect(validateHelperRequest(request({ operation: "application.pi-hole.lifecycle.inspect", parameters: { container: "other" } }))).toContain("no parameters");
    expect(validateHelperRequest(request({ operation: "application.pi-hole.action", parameters: { action: "restart", expectedRevision: "b".repeat(64) } }))).toBeNull();
    expect(validateHelperRequest(request({ operation: "application.pi-hole.action", parameters: { action: "remove", expectedRevision: "b".repeat(64) } }))).toContain("fixed action");
    expect(validateHelperRequest(request({ operation: "application.pi-hole.action", parameters: { action: "restart", expectedRevision: "b".repeat(64), address: "192.168.8.10" } }))).toContain("fixed action");
    expect(validateHelperRequest(request({ operation: "application.pi-hole.deploy", parameters: { lanAddress: "192.168.8.10", webPort: 8080 } }))).toBeNull();
    expect(validateHelperRequest(request({ operation: "application.pi-hole.backup", parameters: { backupId: randomUUID() } }))).toBeNull();
    expect(validateHelperRequest(request({ operation: "application.pi-hole.backup", parameters: { backupId: "../../etc" } }))).toContain("backupId UUID");
    expect(validateHelperRequest(request({ operation: "application.pi-hole.backup", parameters: { backupId: randomUUID(), path: "/tmp" } }))).toContain("only a backupId");
    expect(validateHelperRequest(request({ operation: "application.pi-hole.deploy", parameters: { lanAddress: "127.0.0.1", webPort: 8080 } }))).toContain("private lanAddress");
    expect(validateHelperRequest(request({ operation: "application.pi-hole.deploy", parameters: { lanAddress: "192.168.8.10", webPort: 8080, image: "evil" } }))).toContain("accepts only");
    expect(validateHelperRequest(request({ operation: "application.pi-hole.deploy", parameters: { lanAddress: "192.168.8.10", webPort: 53 } }))).toContain("webPort");
  });

  it("delegates only the exact managed Pi-hole lifecycle request", async () => {
    const expectedRevision = "b".repeat(64);
    const applications = {
      inspectPiholeLifecycle: vi.fn(async () => ({ installed: true, managed: true, revision: expectedRevision, allowedActions: ["restart"], boundary: { mutationPerformed: false } })),
      actionPihole: vi.fn(async (parameters) => ({ applicationId: "pi-hole", ...parameters, performed: true, dataPreserved: true, secretPreserved: true, routerMutationPerformed: false, dnsCutoverPerformed: false })),
    };
    await expect(executeHelperOperation(request({ operation: "application.pi-hole.lifecycle.inspect", parameters: {} }), { applications })).resolves.toMatchObject({ ok: true, result: { installed: true, managed: true, boundary: { mutationPerformed: false } } });
    await expect(executeHelperOperation(request({ operation: "application.pi-hole.action", parameters: { action: "restart", expectedRevision } }), { applications })).resolves.toMatchObject({ ok: true, result: { applicationId: "pi-hole", action: "restart", expectedRevision, performed: true, dataPreserved: true, secretPreserved: true, routerMutationPerformed: false, dnsCutoverPerformed: false } });
  });

  it("delegates only the reviewed Pi-hole binding to the curated helper", async () => {
    const applications = {
      deployPihole: async (parameters) => ({ ...parameters, installed: true, healthy: true, routerMutationPerformed: false, dnsCutoverPerformed: false, dhcpEnabled: false }),
    };
    const result = await executeHelperOperation(request({ operation: "application.pi-hole.deploy", parameters: { lanAddress: "192.168.8.10", webPort: 8080 } }), { applications });
    expect(result).toMatchObject({ ok: true, result: { lanAddress: "192.168.8.10", webPort: 8080, routerMutationPerformed: false, dnsCutoverPerformed: false, dhcpEnabled: false } });
  });

  it("accepts and delegates only one server-generated Keel backup UUID", async () => {
    const backupId = randomUUID();
    expect(validateHelperRequest(request({ operation: "application.keel.backup", parameters: { backupId } }))).toBeNull();
    expect(validateHelperRequest(request({ operation: "application.keel.backup", parameters: { backupId: "../../etc" } }))).toContain("only one backupId UUID");
    expect(validateHelperRequest(request({ operation: "application.keel.backup", parameters: { backupId, path: "/tmp/copy" } }))).toContain("only one backupId UUID");
    const keelBackups = { backup: async (parameters) => ({ ...parameters, applicationId: "keel", sourceRestartVerified: true, restoreDrill: { passed: true, mode: "isolated-keel-export-open" } }) };
    await expect(executeHelperOperation(request({ operation: "application.keel.backup", parameters: { backupId } }), { keelBackups })).resolves.toMatchObject({ ok: true, result: { backupId, applicationId: "keel", sourceRestartVerified: true } });
  });

  it("accepts and delegates only fixed Keel recovery evidence", async () => {
    const parameters = { recoveryId: randomUUID(), backupId: randomUUID(), expectedArtifactChecksumSha256: "a".repeat(64), expectedManifestChecksumSha256: "b".repeat(64), expectedSizeBytes: 8192 };
    expect(validateHelperRequest(request({ operation: "application.keel.recovery.inspect", parameters }))).toBeNull();
    expect(validateHelperRequest(request({ operation: "application.keel.recovery.create", parameters }))).toBeNull();
    expect(validateHelperRequest(request({ operation: "application.keel.recovery.create", parameters: { ...parameters, path: "/tmp" } }))).toContain("fixed typed backup evidence fields");
    expect(validateHelperRequest(request({ operation: "application.keel.recovery.create", parameters: { ...parameters, recoveryId: "../../etc" } }))).toContain("Recovery id must be a UUID");
    const keelRecovery = {
      inspect: async (input) => ({ ready: true, ...input, initialState: "stopped", network: "none" }),
      create: async (input) => ({ created: true, ...input, initialState: "stopped", network: "none", productionStateReplaced: false }),
    };
    await expect(executeHelperOperation(request({ operation: "application.keel.recovery.inspect", parameters }), { keelRecovery })).resolves.toMatchObject({ ok: true, result: { ready: true, recoveryId: parameters.recoveryId, backupId: parameters.backupId, initialState: "stopped" } });
    await expect(executeHelperOperation(request({ operation: "application.keel.recovery.create", parameters }), { keelRecovery })).resolves.toMatchObject({ ok: true, result: { created: true, recoveryId: parameters.recoveryId, productionStateReplaced: false } });
  });

  it("accepts only a recovery UUID for drill inspection and exact pinned evidence for execution", async () => {
    const recoveryId = "11111111-1111-4111-8111-111111111111";
    const parameters = { drillId: "22222222-2222-4222-8222-222222222222", recoveryId, expectedEvidenceChecksumSha256: "a".repeat(64), expectedStateTreeDigestSha256: "b".repeat(64) };
    expect(validateHelperRequest(request({ operation: "application.keel.recovery-drill.inspect", parameters: { recoveryId } }))).toBeNull();
    expect(validateHelperRequest(request({ operation: "application.keel.recovery-drill.inspect", parameters: { recoveryId, path: "/tmp" } }))).toContain("only one recoveryId");
    expect(validateHelperRequest(request({ operation: "application.keel.recovery-drill.create", parameters }))).toBeNull();
    expect(validateHelperRequest(request({ operation: "application.keel.recovery-drill.create", parameters: { ...parameters, command: "sh" } }))).toContain("only the fixed typed recovery evidence fields");
    const keelRecoveryDrill = {
      inspect: vi.fn(async () => ({ ready: true, recoveryId, drillNetwork: "private-loopback-only" })),
      create: vi.fn(async () => ({ passed: true, drillId: parameters.drillId, recoveryId, workspaceRemoved: true })),
    };
    await expect(executeHelperOperation(request({ operation: "application.keel.recovery-drill.inspect", parameters: { recoveryId } }), { keelRecoveryDrill })).resolves.toMatchObject({ ok: true, result: { ready: true, drillNetwork: "private-loopback-only" } });
    await expect(executeHelperOperation(request({ operation: "application.keel.recovery-drill.create", parameters }), { keelRecoveryDrill })).resolves.toMatchObject({ ok: true, result: { passed: true, workspaceRemoved: true } });
  });

  it("accepts only exact drilled recovery and managed-install evidence for Keel promotion", async () => {
    const inspectParameters = {
      drillId: "22222222-2222-4222-8222-222222222222", recoveryId: "11111111-1111-4111-8111-111111111111",
      expectedEvidenceChecksumSha256: "a".repeat(64), expectedStateTreeDigestSha256: "b".repeat(64),
    };
    const parameters = { ...inspectParameters, promotionId: "33333333-3333-4333-8333-333333333333", expectedInstallId: "44444444-4444-4444-8444-444444444444" };
    expect(validateHelperRequest(request({ operation: "application.keel.promotion.inspect", parameters: inspectParameters }))).toBeNull();
    expect(validateHelperRequest(request({ operation: "application.keel.promotion.inspect", parameters: { ...inspectParameters, path: "/var/lib/keel" } }))).toContain("fixed recovery and drill evidence");
    expect(validateHelperRequest(request({ operation: "application.keel.promotion.create", parameters }))).toBeNull();
    expect(validateHelperRequest(request({ operation: "application.keel.promotion.create", parameters: { ...parameters, command: "sh" } }))).toContain("fixed promotion");
    const keelPromotion = {
      inspect: vi.fn(async () => ({ ready: true, installId: parameters.expectedInstallId, rollbackDestination: "managed-keel-promotion-rollback" })),
      create: vi.fn(async () => ({ passed: true, promotionId: parameters.promotionId, recoveryId: parameters.recoveryId, rollbackAvailable: true })),
    };
    await expect(executeHelperOperation(request({ operation: "application.keel.promotion.inspect", parameters: inspectParameters }), { keelPromotion })).resolves.toMatchObject({ ok: true, result: { ready: true, rollbackDestination: "managed-keel-promotion-rollback" } });
    await expect(executeHelperOperation(request({ operation: "application.keel.promotion.create", parameters }), { keelPromotion })).resolves.toMatchObject({ ok: true, result: { passed: true, rollbackAvailable: true } });
  });

  it("accepts only exact retained checkpoint and installation evidence for Keel operator rollback", async () => {
    const inspectParameters = {
      promotionId: "33333333-3333-4333-8333-333333333333",
      expectedPreviousStateTreeDigestSha256: "a".repeat(64),
    };
    const parameters = {
      ...inspectParameters,
      rollbackId: "55555555-5555-4555-8555-555555555555",
      expectedInstallId: "44444444-4444-4444-8444-444444444444",
      expectedRollbackEvidenceChecksumSha256: "b".repeat(64),
    };
    expect(validateHelperRequest(request({ operation: "application.keel.rollback.inspect", parameters: inspectParameters }))).toBeNull();
    expect(validateHelperRequest(request({ operation: "application.keel.rollback.inspect", parameters: { ...inspectParameters, path: "/var/lib/keel" } }))).toContain("fixed promotion and state digest fields");
    expect(validateHelperRequest(request({ operation: "application.keel.rollback.create", parameters }))).toBeNull();
    expect(validateHelperRequest(request({ operation: "application.keel.rollback.create", parameters: { ...parameters, command: "sh" } }))).toContain("fixed rollback");
    const keelRollback = {
      inspect: vi.fn(async () => ({ ready: true, installId: parameters.expectedInstallId, displacedDestination: "managed-keel-rollback-checkpoint", sourceCheckpointPreserved: true })),
      create: vi.fn(async () => ({ passed: true, rollbackId: parameters.rollbackId, promotionId: parameters.promotionId, displacedStateRetained: true })),
    };
    await expect(executeHelperOperation(request({ operation: "application.keel.rollback.inspect", parameters: inspectParameters }), { keelRollback })).resolves.toMatchObject({ ok: true, result: { ready: true, sourceCheckpointPreserved: true } });
    await expect(executeHelperOperation(request({ operation: "application.keel.rollback.create", parameters }), { keelRollback })).resolves.toMatchObject({ ok: true, result: { passed: true, displacedStateRetained: true } });
  });

  it("delegates only a typed Pi-hole backup id to the curated helper", async () => {
    const backupId = randomUUID();
    const applications = { backupPihole: async (parameters) => ({ ...parameters, applicationId: "pi-hole", restoreDrill: { passed: true, network: "none" } }) };
    const result = await executeHelperOperation(request({ operation: "application.pi-hole.backup", parameters: { backupId } }), { applications });
    expect(result).toMatchObject({ ok: true, result: { backupId, applicationId: "pi-hole", restoreDrill: { passed: true, network: "none" } } });
  });

  it("returns only the Docker server availability and version", async () => {
    const result = await executeHelperOperation(request({ operation: "container.docker.inspect", parameters: {} }), {
      applications: { inspectDocker: async () => ({ available: true, version: "29.1.3" }) },
    });
    expect(result).toMatchObject({ ok: true, result: { available: true, version: "29.1.3" } });
  });

  it("accepts only a server-generated controller backup id and delegates no path or command", async () => {
    const backupId = randomUUID();
    expect(validateHelperRequest(request({ operation: "controller.database.backup.inspect", parameters: {} }))).toBeNull();
    expect(validateHelperRequest(request({ operation: "controller.database.backup.inspect", parameters: { database: "/tmp/db" } }))).toContain("no parameters");
    expect(validateHelperRequest(request({ operation: "controller.database.backup.create", parameters: { backupId } }))).toBeNull();
    expect(validateHelperRequest(request({ operation: "controller.database.backup.create", parameters: { backupId: "../../etc" } }))).toContain("backupId UUID");
    expect(validateHelperRequest(request({ operation: "controller.database.backup.create", parameters: { backupId, destination: "/tmp" } }))).toContain("only one backupId");
    const controllerBackups = {
      inspect: async () => ({ healthy: true, boundary: { mutationPerformed: false } }),
      createBackup: async (parameters) => ({ ...parameters, applicationId: "boxpilot-controller", consistentSnapshot: true, restoreDrill: { passed: true } }),
    };
    await expect(executeHelperOperation(request({ operation: "controller.database.backup.inspect", parameters: {} }), { controllerBackups })).resolves.toMatchObject({ ok: true, result: { healthy: true, boundary: { mutationPerformed: false } } });
    await expect(executeHelperOperation(request({ operation: "controller.database.backup.create", parameters: { backupId } }), { controllerBackups })).resolves.toMatchObject({ ok: true, result: { backupId, applicationId: "boxpilot-controller", consistentSnapshot: true, restoreDrill: { passed: true } } });
  });

  it("accepts only fixed controller protection evidence and never a path, password, repository, or restic argument", async () => {
    const parameters = {
      protectionId: randomUUID(),
      backupId: randomUUID(),
      expectedArtifactChecksumSha256: "a".repeat(64),
      expectedManifestChecksumSha256: "b".repeat(64),
      expectedSizeBytes: 8192,
      expectedDestinationRevision: "c".repeat(64),
    };
    expect(validateHelperRequest(request({ operation: "controller.database.protection.inspect", parameters: {} }))).toBeNull();
    expect(validateHelperRequest(request({ operation: "controller.database.protection.inspect", parameters: { repository: "/tmp" } }))).toContain("no parameters");
    expect(validateHelperRequest(request({ operation: "controller.database.protection.create", parameters }))).toBeNull();
    expect(validateHelperRequest(request({ operation: "controller.database.protection.create", parameters: { ...parameters, path: "/tmp" } }))).toContain("fixed typed evidence");
    expect(validateHelperRequest(request({ operation: "controller.database.protection.create", parameters: { ...parameters, protectionId: "../../etc" } }))).toContain("Protection id");
    const controllerProtection = {
      inspect: async () => ({ ready: false, setupCommand: "sudo setup", boundary: { mutationPerformed: false } }),
      protect: async (input) => ({ ...input, created: true, protected: true, boundary: { browserPathAccepted: false } }),
    };
    await expect(executeHelperOperation(request({ operation: "controller.database.protection.inspect", parameters: {} }), { controllerProtection })).resolves.toMatchObject({ ok: true, result: { ready: false, boundary: { mutationPerformed: false } } });
    await expect(executeHelperOperation(request({ operation: "controller.database.protection.create", parameters }), { controllerProtection })).resolves.toMatchObject({ ok: true, result: { protectionId: parameters.protectionId, backupId: parameters.backupId, created: true, protected: true } });
  });

  it("accepts only exact controller retention evidence and delegates no selector, path, password, or prune flag", async () => {
    const parameters = {
      retentionId: randomUUID(),
      repositoryId: "a".repeat(64),
      expectedDestinationRevision: "b".repeat(64),
      expectedSnapshotSetRevision: "c".repeat(64),
      forgetSnapshotIds: ["d".repeat(64)],
    };
    expect(validateHelperRequest(request({ operation: "controller.database.protection.retention.inspect", parameters: {} }))).toBeNull();
    expect(validateHelperRequest(request({ operation: "controller.database.protection.retention.inspect", parameters: { repository: "/tmp" } }))).toContain("no parameters");
    expect(validateHelperRequest(request({ operation: "controller.database.protection.retention.apply", parameters }))).toBeNull();
    expect(validateHelperRequest(request({ operation: "controller.database.protection.retention.apply", parameters: { ...parameters, prune: true } }))).toContain("fixed typed evidence");
    const controllerRetention = {
      inspect: async () => ({ ready: true, snapshots: [] }),
      apply: async (input) => ({ ...input, applied: true, complete: true, prunePerformed: false }),
    };
    await expect(executeHelperOperation(request({ operation: "controller.database.protection.retention.inspect", parameters: {} }), { controllerRetention })).resolves.toMatchObject({ ok: true, result: { ready: true, snapshots: [] } });
    await expect(executeHelperOperation(request({ operation: "controller.database.protection.retention.apply", parameters }), { controllerRetention })).resolves.toMatchObject({ ok: true, result: { retentionId: parameters.retentionId, applied: true, complete: true, prunePerformed: false } });
  });

  it("accepts only exact application protection evidence and never a path, password, or repository selector", async () => {
    const parameters = { protectionId: randomUUID(), backupId: randomUUID(), applicationId: "pi-hole", expectedArtifactChecksumSha256: "a".repeat(64), expectedSizeBytes: 8192, expectedDestinationRevision: "c".repeat(64) };
    expect(validateHelperRequest(request({ operation: "application.backup.protection.inspect", parameters: {} }))).toBeNull();
    expect(validateHelperRequest(request({ operation: "application.backup.protection.inspect", parameters: { repository: "/tmp" } }))).toContain("no parameters");
    expect(validateHelperRequest(request({ operation: "application.backup.protection.create", parameters }))).toBeNull();
    expect(validateHelperRequest(request({ operation: "application.backup.protection.create", parameters: { ...parameters, path: "/tmp" } }))).toContain("fixed typed evidence");
    expect(validateHelperRequest(request({ operation: "application.backup.protection.create", parameters: { ...parameters, applicationId: "../../etc" } }))).toContain("Application id");
    const applicationProtection = { inspect: async () => ({ ready: false, boundary: { mutationPerformed: false } }), protect: async (input) => ({ ...input, created: true, protected: true }) };
    await expect(executeHelperOperation(request({ operation: "application.backup.protection.inspect", parameters: {} }), { applicationProtection })).resolves.toMatchObject({ ok: true, result: { ready: false } });
    await expect(executeHelperOperation(request({ operation: "application.backup.protection.create", parameters }), { applicationProtection })).resolves.toMatchObject({ ok: true, result: { applicationId: "pi-hole", backupId: parameters.backupId, created: true, protected: true } });
  });

  it("delegates a typed backup id without accepting a path", async () => {
    const backupId = randomUUID();
    const applications = { backup: async (parameters) => ({ ...parameters, restoreDrill: { passed: true } }) };
    const result = await executeHelperOperation(request({ operation: "application.uptime-kuma.backup", parameters: { backupId } }), { applications });
    expect(result).toMatchObject({ ok: true, result: { backupId, restoreDrill: { passed: true } } });
  });

  it("accepts only a parameter-free read-only Keel discovery request", async () => {
    expect(validateHelperRequest(request({ operation: "application.keel.inspect", parameters: {} }))).toBeNull();
    expect(validateHelperRequest(request({ operation: "application.keel.inspect", parameters: { path: "/home/operator/keel" } }))).toContain("no parameters");
    const keelDiscovery = { inspect: async () => ({ installed: false, state: "not-installed", boundary: { mutationPerformed: false, secretRead: false } }) };
    await expect(executeHelperOperation(request({ operation: "application.keel.inspect", parameters: {} }), { keelDiscovery })).resolves.toMatchObject({ ok: true, result: { installed: false, state: "not-installed", boundary: { mutationPerformed: false, secretRead: false } } });
  });

  it("accepts only parameter-free Keel artifact inspection and one server-generated acquisition UUID", async () => {
    const acquisitionId = randomUUID();
    expect(validateHelperRequest(request({ operation: "application.keel.artifact.inspect", parameters: {} }))).toBeNull();
    expect(validateHelperRequest(request({ operation: "application.keel.artifact.inspect", parameters: { path: "/tmp/keel" } }))).toContain("no parameters");
    expect(validateHelperRequest(request({ operation: "application.keel.artifact.acquire", parameters: { acquisitionId } }))).toBeNull();
    expect(validateHelperRequest(request({ operation: "application.keel.artifact.acquire", parameters: { acquisitionId, url: "https://example.invalid" } }))).toContain("only one acquisitionId UUID");
    expect(validateHelperRequest(request({ operation: "application.keel.artifact.acquire", parameters: { acquisitionId: "changed" } }))).toContain("only one acquisitionId UUID");
    const keelArtifacts = { inspect: async () => ({ state: "absent", locallyVerified: false }), acquire: async (parameters) => ({ acquired: true, ...parameters, locallyVerified: true }) };
    await expect(executeHelperOperation(request({ operation: "application.keel.artifact.inspect", parameters: {} }), { keelArtifacts })).resolves.toMatchObject({ ok: true, result: { state: "absent", locallyVerified: false } });
    await expect(executeHelperOperation(request({ operation: "application.keel.artifact.acquire", parameters: { acquisitionId } }), { keelArtifacts })).resolves.toMatchObject({ ok: true, result: { acquired: true, acquisitionId, locallyVerified: true } });
  });

  it("accepts only parameter-free read-only Keel archive inspection", async () => {
    expect(validateHelperRequest(request({ operation: "application.keel.archive.inspect", parameters: {} }))).toBeNull();
    expect(validateHelperRequest(request({ operation: "application.keel.archive.inspect", parameters: { path: "/tmp/keel.tar.gz" } }))).toContain("no parameters");
    const keelArchive = { inspect: async () => ({ state: "blocked", safeToExtract: false, memberCount: 2900, risks: ["symbolic-link-member", "absolute-link-target"], boundary: { mutationPerformed: false, extractionPerformed: false } }) };
    await expect(executeHelperOperation(request({ operation: "application.keel.archive.inspect", parameters: {} }), { keelArchive })).resolves.toMatchObject({ ok: true, result: { state: "blocked", safeToExtract: false, memberCount: 2900, boundary: { mutationPerformed: false, extractionPerformed: false } } });
  });

  it("accepts only parameter-free Keel staging inspection and one server-generated stage UUID", async () => {
    const stageId = randomUUID();
    expect(validateHelperRequest(request({ operation: "application.keel.stage.inspect", parameters: {} }))).toBeNull();
    expect(validateHelperRequest(request({ operation: "application.keel.stage.inspect", parameters: { path: "/tmp/keel" } }))).toContain("no parameters");
    expect(validateHelperRequest(request({ operation: "application.keel.stage", parameters: { stageId } }))).toBeNull();
    expect(validateHelperRequest(request({ operation: "application.keel.stage", parameters: { stageId, archive: "/tmp/keel.tar.gz" } }))).toContain("only one stageId UUID");
    expect(validateHelperRequest(request({ operation: "application.keel.stage", parameters: { stageId: "changed" } }))).toContain("only one stageId UUID");
    const keelStage = { inspect: async () => ({ state: "absent", readyToStage: true }), stage: async (parameters) => ({ staged: true, ...parameters, boundary: { applicationInstalled: false } }) };
    await expect(executeHelperOperation(request({ operation: "application.keel.stage.inspect", parameters: {} }), { keelStage })).resolves.toMatchObject({ ok: true, result: { state: "absent", readyToStage: true } });
    await expect(executeHelperOperation(request({ operation: "application.keel.stage", parameters: { stageId } }), { keelStage })).resolves.toMatchObject({ ok: true, result: { staged: true, stageId, boundary: { applicationInstalled: false } } });
  });

  it("accepts only parameter-free Keel install inspection and one server-generated install UUID", async () => {
    const installId = randomUUID();
    expect(validateHelperRequest(request({ operation: "application.keel.install.inspect", parameters: {} }))).toBeNull();
    expect(validateHelperRequest(request({ operation: "application.keel.install.inspect", parameters: { unit: "changed.service" } }))).toContain("no parameters");
    expect(validateHelperRequest(request({ operation: "application.keel.install", parameters: { installId } }))).toBeNull();
    expect(validateHelperRequest(request({ operation: "application.keel.install", parameters: { installId, command: "bash" } }))).toContain("only one installId UUID");
    expect(validateHelperRequest(request({ operation: "application.keel.install", parameters: { installId: "changed" } }))).toContain("only one installId UUID");
    const keelInstall = {
      inspect: async () => ({ state: "absent", readyToInstall: true, boundary: { mutationPerformed: false } }),
      install: async (parameters) => ({ installed: true, healthy: true, ...parameters, listener: "127.0.0.1:3000", boundary: { claimChanged: false, arbitraryCommandAccepted: false } }),
    };
    await expect(executeHelperOperation(request({ operation: "application.keel.install.inspect", parameters: {} }), { keelInstall })).resolves.toMatchObject({ ok: true, result: { state: "absent", readyToInstall: true, boundary: { mutationPerformed: false } } });
    await expect(executeHelperOperation(request({ operation: "application.keel.install", parameters: { installId } }), { keelInstall })).resolves.toMatchObject({ ok: true, result: { installed: true, healthy: true, installId, listener: "127.0.0.1:3000", boundary: { claimChanged: false, arbitraryCommandAccepted: false } } });
  });

  it("accepts only parameter-free sanitized Keel owner-login proof inspection", async () => {
    expect(validateHelperRequest(request({ operation: "application.keel.login-proof.inspect", parameters: {} }))).toBeNull();
    expect(validateHelperRequest(request({ operation: "application.keel.login-proof.inspect", parameters: { email: "owner@example.test" } }))).toContain("no parameters");
    const keelLoginProof = { inspect: async () => ({ state: "verified", verified: true, credentialsStored: false, sessionStored: false, boundary: { credentialRead: false, sessionRead: false } }) };
    await expect(executeHelperOperation(request({ operation: "application.keel.login-proof.inspect", parameters: {} }), { keelLoginProof })).resolves.toMatchObject({
      ok: true,
      result: { state: "verified", verified: true, credentialsStored: false, sessionStored: false, boundary: { credentialRead: false, sessionRead: false } },
    });
  });

  it("accepts only exact migration bundle evidence and keeps all paths helper-owned", async () => {
    expect(validateHelperRequest(request({ operation: "migration.bundle.inspect", parameters: {} }))).toBeNull();
    expect(validateHelperRequest(request({ operation: "migration.bundle.inspect", parameters: { inbox: "/tmp" } }))).toContain("accepts no parameters");
    expect(validateHelperRequest(request({ operation: "migration.bundle.transfer", parameters: migrationTransferParameters() }))).toBeNull();
    expect(validateHelperRequest(request({ operation: "migration.bundle.transfer", parameters: migrationTransferParameters({ sourcePath: "/etc" }) }))).toContain("only fixed typed evidence fields");
    expect(validateHelperRequest(request({ operation: "migration.bundle.transfer", parameters: migrationTransferParameters({ expectedDestinationState: "overwrite" }) }))).toContain("Destination state is invalid");
    const migrations = {
      inspect: async () => ({ ready: true, bundles: [] }),
      transfer: async (parameters) => ({ created: true, transferId: parameters.transferId, bundleId: parameters.bundleId, contentVerified: true, activationPerformed: false }),
    };
    await expect(executeHelperOperation(request({ operation: "migration.bundle.inspect", parameters: {} }), { migrations })).resolves.toMatchObject({ ok: true, result: { ready: true, bundles: [] } });
    await expect(executeHelperOperation(request({ operation: "migration.bundle.transfer", parameters: migrationTransferParameters() }), { migrations })).resolves.toMatchObject({ ok: true, result: { created: true, contentVerified: true, activationPerformed: false } });
  });

  it("rejects incompatible versions and malformed ids", () => {
    expect(validateHelperRequest(request({ version: 99 }))).toBe("Unsupported helper protocol version");
    expect(validateHelperRequest(request({ id: "not-a-uuid" }))).toBe("Request id must be a UUID");
  });

  it("accepts only typed VM fields and delegates no command or path", async () => {
    expect(validateHelperRequest(request({ operation: "virtualization.domain.create", parameters: vmParameters() }))).toBeNull();
    expect(validateHelperRequest(request({ operation: "virtualization.domain.create", parameters: vmParameters({ arguments: ["--name", "evil"] }) }))).toContain("only the fixed typed plan fields");
    expect(validateHelperRequest(request({ operation: "virtualization.domain.create", parameters: vmParameters({ path: "/tmp/evil.iso" }) }))).toContain("only the fixed typed plan fields");
    expect(validateHelperRequest(request({ operation: "virtualization.domain.create", parameters: vmParameters({ program: "/bin/sh" }) }))).toContain("only the fixed typed plan fields");
    const virtualization = { create: async (parameters) => ({ created: true, verified: true, domain: parameters.name }) };
    const result = await executeHelperOperation(request({ operation: "virtualization.domain.create", parameters: vmParameters() }), { virtualization });
    expect(result).toMatchObject({ ok: true, result: { created: true, verified: true, domain: "ubuntu-lab" } });
  });

  it("accepts only fixed lifecycle state and action fields", async () => {
    expect(validateHelperRequest(request({ operation: "virtualization.domain.action", parameters: lifecycleParameters() }))).toBeNull();
    expect(validateHelperRequest(request({ operation: "virtualization.domain.action", parameters: lifecycleParameters({ action: "destroy" }) }))).toContain("Unsupported VM lifecycle action");
    expect(validateHelperRequest(request({ operation: "virtualization.domain.action", parameters: lifecycleParameters({ arguments: ["destroy"] }) }))).toContain("only the fixed typed plan fields");
    const virtualization = { action: async (parameters) => ({ verified: true, domain: parameters.name, action: parameters.action }) };
    const result = await executeHelperOperation(request({ operation: "virtualization.domain.action", parameters: lifecycleParameters() }), { virtualization });
    expect(result).toMatchObject({ ok: true, result: { verified: true, domain: "ubuntu-lab", action: "shutdown" } });
  });

  it("accepts only fixed read-only virtualization inventory scopes", async () => {
    expect(validateHelperRequest(request({ operation: "virtualization.inventory.inspect", parameters: { scope: "domains" } }))).toBeNull();
    expect(validateHelperRequest(request({ operation: "virtualization.inventory.inspect", parameters: { scope: "domain", name: "ubuntu-lab" } }))).toContain("fixed status, domains, or resources scope");
    expect(validateHelperRequest(request({ operation: "virtualization.inventory.inspect", parameters: { scope: "../../etc" } }))).toContain("fixed status, domains, or resources scope");
    const virtualization = { inventory: async ({ scope }) => ({ scope, connected: true }) };
    const result = await executeHelperOperation(request({ operation: "virtualization.inventory.inspect", parameters: { scope: "resources" } }), { virtualization });
    expect(result).toMatchObject({ ok: true, result: { scope: "resources", connected: true } });
  });

  it("accepts only the fixed libvirt foundation identity and state revision", async () => {
    const foundationId = "123e4567-e89b-42d3-a456-426614174000";
    const expectedRevision = "a".repeat(64);
    expect(validateHelperRequest(request({ operation: "virtualization.foundation.inspect", parameters: {} }))).toBeNull();
    expect(validateHelperRequest(request({ operation: "virtualization.foundation.inspect", parameters: { pool: "custom" } }))).toContain("no parameters");
    expect(validateHelperRequest(request({ operation: "virtualization.foundation.initialize", parameters: { foundationId, expectedRevision } }))).toBeNull();
    expect(validateHelperRequest(request({ operation: "virtualization.foundation.initialize", parameters: { foundationId, expectedRevision, network: "bridge" } }))).toContain("only one server-generated id");
    expect(validateHelperRequest(request({ operation: "virtualization.foundation.initialize", parameters: { foundationId, expectedRevision: "$(id)" } }))).toContain("only one server-generated id");
    const foundation = {
      inspect: async () => ({ ready: false, revision: expectedRevision, mutationPerformed: false }),
      initialize: async () => ({ initialized: true, foundationId, revisionBefore: expectedRevision, ready: true }),
    };
    await expect(executeHelperOperation(request({ operation: "virtualization.foundation.inspect", parameters: {} }), { foundation })).resolves.toMatchObject({ ok: true, result: { ready: false, revision: expectedRevision } });
    await expect(executeHelperOperation(request({ operation: "virtualization.foundation.initialize", parameters: { foundationId, expectedRevision } }), { foundation })).resolves.toMatchObject({ ok: true, result: { initialized: true, foundationId, ready: true } });
  });

  it("accepts only a parameter-free console handoff inspection", async () => {
    expect(validateHelperRequest(request({ operation: "virtualization.console.inspect", parameters: {} }))).toBeNull();
    expect(validateHelperRequest(request({ operation: "virtualization.console.inspect", parameters: { port: 22 } }))).toContain("accepts no parameters");
    const virtualization = { consoleGuidance: async () => ({ nativeProxyAvailable: false, cockpit: { active: true, port: 9090 } }) };
    const result = await executeHelperOperation(request({ operation: "virtualization.console.inspect", parameters: {} }), { virtualization });
    expect(result).toMatchObject({ ok: true, result: { nativeProxyAvailable: false, cockpit: { active: true, port: 9090 } } });
  });

  it("accepts only exact offline snapshot plan fields", async () => {
    expect(validateHelperRequest(request({ operation: "virtualization.domain.snapshot.create", parameters: snapshotParameters() }))).toBeNull();
    expect(validateHelperRequest(request({ operation: "virtualization.domain.snapshot.create", parameters: snapshotParameters({ expectedState: "running" }) }))).toContain("requires a stopped VM");
    expect(validateHelperRequest(request({ operation: "virtualization.domain.snapshot.create", parameters: snapshotParameters({ path: "/tmp/evil" }) }))).toContain("only the fixed typed plan fields");
    const virtualization = { createSnapshot: async (parameters) => ({ created: true, verified: true, domain: parameters.name, snapshotName: parameters.snapshotName }) };
    const result = await executeHelperOperation(request({ operation: "virtualization.domain.snapshot.create", parameters: snapshotParameters() }), { virtualization });
    expect(result).toMatchObject({ ok: true, result: { created: true, verified: true, snapshotName: "pre-upgrade" } });
  });

  it("accepts only exact stopped-VM export fields and keeps destination paths server-owned", async () => {
    expect(validateHelperRequest(request({ operation: "virtualization.domain.export.inspect", parameters: { name: "ubuntu-lab" } }))).toBeNull();
    expect(validateHelperRequest(request({ operation: "virtualization.domain.export.inspect", parameters: { name: "../../etc" } }))).toContain("exact domain name");
    expect(validateHelperRequest(request({ operation: "virtualization.domain.export.create", parameters: exportParameters() }))).toBeNull();
    expect(validateHelperRequest(request({ operation: "virtualization.domain.export.create", parameters: exportParameters({ path: "/tmp/evil" }) }))).toContain("only the fixed typed plan fields");
    const virtualization = {
      inspectExport: async ({ name }) => ({ domain: name, state: "stopped" }),
      createExport: async (parameters) => ({ created: true, contentVerified: true, domain: parameters.name, exportId: parameters.exportId, protected: false }),
    };
    await expect(executeHelperOperation(request({ operation: "virtualization.domain.export.inspect", parameters: { name: "ubuntu-lab" } }), { virtualization })).resolves.toMatchObject({ ok: true, result: { state: "stopped" } });
    await expect(executeHelperOperation(request({ operation: "virtualization.domain.export.create", parameters: exportParameters() }), { virtualization })).resolves.toMatchObject({ ok: true, result: { contentVerified: true, protected: false } });
  });

  it("accepts only secret-free VM protection fields and delegates fixed destination handling", async () => {
    expect(validateHelperRequest(request({ operation: "virtualization.export.backup.inspect", parameters: {} }))).toBeNull();
    expect(validateHelperRequest(request({ operation: "virtualization.export.backup.inspect", parameters: { repository: "/tmp" } }))).toContain("accepts no parameters");
    expect(validateHelperRequest(request({ operation: "virtualization.export.backup.create", parameters: protectionParameters() }))).toBeNull();
    expect(validateHelperRequest(request({ operation: "virtualization.export.backup.create", parameters: protectionParameters({ password: "secret" }) }))).toContain("only the fixed typed plan fields");
    const vmProtection = {
      inspect: async () => ({ ready: true, encrypted: true, independent: true }),
      createBackup: async (parameters) => ({ created: true, backupId: parameters.backupId, encrypted: true, independent: true, protected: false }),
    };
    await expect(executeHelperOperation(request({ operation: "virtualization.export.backup.inspect", parameters: {} }), { vmProtection })).resolves.toMatchObject({ ok: true, result: { ready: true, encrypted: true } });
    await expect(executeHelperOperation(request({ operation: "virtualization.export.backup.create", parameters: protectionParameters() }), { vmProtection })).resolves.toMatchObject({ ok: true, result: { created: true, protected: false } });
  });

  it("accepts only exact retention evidence and never accepts paths, passwords, selectors, or prune flags", async () => {
    expect(validateHelperRequest(request({ operation: "virtualization.export.backup.retention.inspect", parameters: {} }))).toBeNull();
    expect(validateHelperRequest(request({ operation: "virtualization.export.backup.retention.inspect", parameters: { repository: "/tmp" } }))).toContain("accepts no parameters");
    expect(validateHelperRequest(request({ operation: "virtualization.export.backup.retention.apply", parameters: retentionParameters() }))).toBeNull();
    expect(validateHelperRequest(request({ operation: "virtualization.export.backup.retention.apply", parameters: retentionParameters({ prune: true }) }))).toContain("only the fixed typed evidence fields");
    expect(validateHelperRequest(request({ operation: "virtualization.export.backup.retention.apply", parameters: retentionParameters({ forgetSnapshotIds: ["latest"] }) }))).toContain("exact SHA-256 id");
    const vmRetention = {
      inspect: async () => ({ ready: true, snapshots: [] }),
      apply: async (parameters) => ({ applied: true, retentionId: parameters.retentionId, forgottenSnapshotIds: parameters.forgetSnapshotIds, prunePerformed: false }),
    };
    await expect(executeHelperOperation(request({ operation: "virtualization.export.backup.retention.inspect", parameters: {} }), { vmRetention })).resolves.toMatchObject({ ok: true, result: { ready: true } });
    await expect(executeHelperOperation(request({ operation: "virtualization.export.backup.retention.apply", parameters: retentionParameters() }), { vmRetention })).resolves.toMatchObject({ ok: true, result: { applied: true, prunePerformed: false } });
  });

  it("accepts only exact restore evidence and delegates fixed no-network drill handling", async () => {
    expect(validateHelperRequest(request({ operation: "virtualization.export.backup.restore-drill.inspect", parameters: restoreDrillParameters() }))).toBeNull();
    expect(validateHelperRequest(request({ operation: "virtualization.export.backup.restore-drill", parameters: restoreDrillParameters() }))).toBeNull();
    expect(validateHelperRequest(request({ operation: "virtualization.export.backup.restore-drill", parameters: restoreDrillParameters({ network: "default" }) }))).toContain("only the fixed typed evidence fields");
    expect(validateHelperRequest(request({ operation: "virtualization.export.backup.restore-drill", parameters: restoreDrillParameters({ snapshotId: "latest" }) }))).toContain("Snapshot id is invalid");
    const vmRestoreDrill = {
      inspect: async (parameters) => ({ ready: true, drillId: parameters.drillId, network: "none", transient: true }),
      runDrill: async (parameters) => ({ passed: true, drillId: parameters.drillId, backupId: parameters.backupId, network: "none", protected: true }),
    };
    await expect(executeHelperOperation(request({ operation: "virtualization.export.backup.restore-drill.inspect", parameters: restoreDrillParameters() }), { vmRestoreDrill })).resolves.toMatchObject({ ok: true, result: { ready: true, network: "none" } });
    await expect(executeHelperOperation(request({ operation: "virtualization.export.backup.restore-drill", parameters: restoreDrillParameters() }), { vmRestoreDrill })).resolves.toMatchObject({ ok: true, result: { passed: true, protected: true } });
  });

  it("accepts only fixed protected-backup recovery fields and delegates a stopped no-network clone", async () => {
    expect(validateHelperRequest(request({ operation: "virtualization.backup.recovery.inspect", parameters: recoveryParameters() }))).toBeNull();
    expect(validateHelperRequest(request({ operation: "virtualization.backup.recovery.create", parameters: recoveryParameters() }))).toBeNull();
    expect(validateHelperRequest(request({ operation: "virtualization.backup.recovery.create", parameters: recoveryParameters({ path: "/tmp/restore" }) }))).toContain("only the fixed typed protected-backup fields");
    expect(validateHelperRequest(request({ operation: "virtualization.backup.recovery.create", parameters: recoveryParameters({ targetDomainName: "boxpilot-drill-manual" }) }))).toContain("reserved restore-drill namespace");
    const vmRecovery = {
      inspect: async (parameters) => ({ ready: true, targetDomainName: parameters.targetDomainName, network: "none", persistent: true, initialState: "stopped" }),
      createRecovery: async (parameters) => ({ created: true, restoreId: parameters.restoreId, domain: parameters.targetDomainName, network: "none", persistent: true, state: "stopped" }),
    };
    await expect(executeHelperOperation(request({ operation: "virtualization.backup.recovery.inspect", parameters: recoveryParameters() }), { vmRecovery })).resolves.toMatchObject({ ok: true, result: { ready: true, network: "none", initialState: "stopped" } });
    await expect(executeHelperOperation(request({ operation: "virtualization.backup.recovery.create", parameters: recoveryParameters() }), { vmRecovery })).resolves.toMatchObject({ ok: true, result: { created: true, domain: "ubuntu-recovered", persistent: true } });
  });
});
