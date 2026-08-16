import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPrerequisiteRepairService } from "./prerequisite-repairs.mjs";
import { hashPassword } from "./security.mjs";
import { createStateStore } from "./state.mjs";

const directories = [];

async function setup(state) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "boxpilot-prerequisite-repair-"));
  directories.push(directory);
  const store = createStateStore({ stateDirectory: directory });
  const bootstrap = store.createBootstrapToken();
  const owner = store.consumeBootstrapToken(bootstrap.token, { username: "operator", passwordHash: await hashPassword("correct horse battery") });
  const helper = { request: vi.fn(async () => state) };
  return { store, owner, helper, service: createPrerequisiteRepairService({ store, helper }) };
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("smartmontools prerequisite repair planning", () => {
  it("creates and stages an immutable fixed-package repair", async () => {
    const state = { package: "smartmontools", installed: false, installedVersion: null, candidateVersion: "7.5-2", selectedVersion: "7.5-2", supported: true, repairAvailable: true };
    const { store, owner, service } = await setup(state);
    const plan = await service.planSmartmontools(owner.id, {});
    expect(plan).toMatchObject({ type: "prerequisite.repair", subjectId: "smartmontools", input: { expectedVersion: "7.5-2", installedBefore: false }, output: { arbitraryPackageSelection: false, aptUpdatePerformed: false, automaticRollback: false } });
    const job = await service.stage(plan.id, plan.revision, owner.id);
    expect(job).toMatchObject({ type: "prerequisite.smartmontools.install", state: "awaiting_approval", risk: "system-package", parameters: { expectedVersion: "7.5-2", installedBefore: false }, recovery: { automaticRollback: false } });
    await expect(service.validateJob(job)).resolves.toMatchObject({ plan: { id: plan.id }, state: { selectedVersion: "7.5-2" } });
    store.close();
  });

  it("rejects input fields and a package-state change before staging", async () => {
    const state = { installed: false, candidateVersion: "7.5-2", selectedVersion: "7.5-2", supported: true, repairAvailable: true };
    const { store, owner, helper, service } = await setup(state);
    await expect(service.planSmartmontools(owner.id, { package: "curl" })).rejects.toThrow("empty object");
    const plan = await service.planSmartmontools(owner.id, {});
    helper.request.mockResolvedValueOnce({ ...state, candidateVersion: "7.6-1", selectedVersion: "7.6-1" });
    await expect(service.stage(plan.id, plan.revision, owner.id)).rejects.toThrow("Host state changed");
    expect(store.getPlan(plan.id).status).toBe("draft");
    store.close();
  });
});

describe("APT metadata prerequisite repair planning", () => {
  it("creates, stages, and revalidates an immutable metadata-only refresh", async () => {
    const state = { available: true, state: "stale", updatedAt: "2026-08-01T00:00:00.000Z", ageHours: 360, packageManagerState: "ready", refreshAvailable: true };
    const { store, owner, service } = await setup(state);
    const plan = await service.planAptMetadata(owner.id, {});
    expect(plan).toMatchObject({
      type: "prerequisite.repair",
      subjectId: "apt-metadata",
      input: { expectedUpdatedAt: state.updatedAt, expectedState: "stale" },
      output: { aptUpdatePerformed: true, packageInstallPerformed: false, packageUpgradePerformed: false, packageRemovalPerformed: false, arbitraryCommandAccepted: false, automaticRollback: false },
    });
    const job = await service.stage(plan.id, plan.revision, owner.id);
    expect(job).toMatchObject({ type: "prerequisite.apt-metadata.refresh", state: "awaiting_approval", risk: "system-package-metadata", parameters: { expectedUpdatedAt: state.updatedAt, expectedState: "stale" } });
    await expect(service.validateJob(job)).resolves.toMatchObject({ plan: { id: plan.id }, state: { state: "stale", packageManagerState: "ready" } });
    store.close();
  });

  it("rejects browser fields, current metadata, interrupted dpkg, and changed state", async () => {
    const stale = { available: true, state: "stale", updatedAt: "2026-08-01T00:00:00.000Z", ageHours: 360, packageManagerState: "ready", refreshAvailable: true };
    const { store, owner, helper, service } = await setup(stale);
    await expect(service.planAptMetadata(owner.id, { package: "curl" })).rejects.toThrow("empty object");
    helper.request.mockResolvedValueOnce({ ...stale, state: "current", refreshAvailable: false });
    await expect(service.planAptMetadata(owner.id, {})).rejects.toThrow("already current");
    helper.request.mockResolvedValueOnce({ ...stale, packageManagerState: "interrupted", refreshAvailable: false });
    await expect(service.planAptMetadata(owner.id, {})).rejects.toThrow("not ready");
    const plan = await service.planAptMetadata(owner.id, {});
    helper.request.mockResolvedValueOnce({ ...stale, updatedAt: "2026-08-02T00:00:00.000Z" });
    await expect(service.stage(plan.id, plan.revision, owner.id)).rejects.toThrow("Host state changed");
    expect(store.getPlan(plan.id).status).toBe("draft");
    store.close();
  });
});

describe("restic prerequisite repair planning", () => {
  it("creates, stages, and revalidates an immutable fixed-package repair", async () => {
    const state = { package: "restic", installed: false, installedVersion: null, candidateVersion: "0.18.1-1", selectedVersion: "0.18.1-1", supported: true, repairAvailable: true };
    const { store, owner, service } = await setup(state);
    const plan = await service.planRestic(owner.id, {});
    expect(plan).toMatchObject({ type: "prerequisite.repair", subjectId: "restic", input: { expectedVersion: "0.18.1-1", installedBefore: false }, output: { arbitraryPackageSelection: false, aptUpdatePerformed: false, storageSetupPerformed: false, automaticRollback: false } });
    const job = await service.stage(plan.id, plan.revision, owner.id);
    expect(job).toMatchObject({ type: "prerequisite.restic.install", state: "awaiting_approval", risk: "system-package", parameters: { expectedVersion: "0.18.1-1", installedBefore: false }, recovery: { automaticRollback: false } });
    await expect(service.validateJob(job)).resolves.toMatchObject({ plan: { id: plan.id }, state: { selectedVersion: "0.18.1-1" } });
    store.close();
  });

  it("rejects input fields and a package-state change before staging", async () => {
    const state = { installed: false, candidateVersion: "0.18.1-1", selectedVersion: "0.18.1-1", supported: true, repairAvailable: true };
    const { store, owner, helper, service } = await setup(state);
    await expect(service.planRestic(owner.id, { package: "curl" })).rejects.toThrow("empty object");
    const plan = await service.planRestic(owner.id, {});
    helper.request.mockResolvedValueOnce({ ...state, candidateVersion: "0.18.2-1", selectedVersion: "0.18.2-1" });
    await expect(service.stage(plan.id, plan.revision, owner.id)).rejects.toThrow("Host state changed");
    expect(store.getPlan(plan.id).status).toBe("draft");
    store.close();
  });
});

describe("Docker Engine prerequisite repair planning", () => {
  it("creates, stages, and revalidates an immutable Ubuntu docker.io repair", async () => {
    const state = { package: "docker.io", installed: false, installedPackageVersion: null, candidateVersion: "28.2.2-0ubuntu1", selectedVersion: "28.2.2-0ubuntu1", supported: true, repairAvailable: true, engineVersion: null, serviceActive: false };
    const { store, owner, service } = await setup(state);
    const plan = await service.planDocker(owner.id, {});
    expect(plan).toMatchObject({ type: "prerequisite.repair", subjectId: "docker", input: { expectedVersion: "28.2.2-0ubuntu1", installedBefore: false }, output: { package: "docker.io", arbitraryPackageSelection: false, arbitraryRepositorySelection: false, aptUpdatePerformed: false, daemonConfigurationChanged: false, userGroupChanged: false, containerCreated: false, automaticRollback: false } });
    const job = await service.stage(plan.id, plan.revision, owner.id);
    expect(job).toMatchObject({ type: "prerequisite.docker.install", state: "awaiting_approval", risk: "system-package-service", parameters: { expectedVersion: "28.2.2-0ubuntu1", installedBefore: false }, recovery: { automaticRollback: false } });
    await expect(service.validateJob(job)).resolves.toMatchObject({ plan: { id: plan.id }, state: { selectedVersion: "28.2.2-0ubuntu1", installed: false } });
    store.close();
  });

  it("rejects browser fields, existing engines, and a changed candidate", async () => {
    const state = { installed: false, candidateVersion: "28.2.2-0ubuntu1", selectedVersion: "28.2.2-0ubuntu1", supported: true, repairAvailable: true };
    const { store, owner, helper, service } = await setup(state);
    await expect(service.planDocker(owner.id, { repository: "https://example.test" })).rejects.toThrow("empty object");
    helper.request.mockResolvedValueOnce({ ...state, installed: true, repairAvailable: false, engineVersion: "29.1.3" });
    await expect(service.planDocker(owner.id, {})).rejects.toThrow("already active");
    const plan = await service.planDocker(owner.id, {});
    helper.request.mockResolvedValueOnce({ ...state, candidateVersion: "28.3.0-0ubuntu1", selectedVersion: "28.3.0-0ubuntu1" });
    await expect(service.stage(plan.id, plan.revision, owner.id)).rejects.toThrow("Host state changed");
    expect(store.getPlan(plan.id).status).toBe("draft");
    store.close();
  });
});

describe("KVM QEMU libvirt prerequisite repair planning", () => {
  const candidates = { "qemu-system-x86": "1:10.2.1+ds-1ubuntu3.2", "libvirt-daemon-system": "12.0.0-1ubuntu5.2", "libvirt-clients": "12.0.0-1ubuntu5.2", virtinst: "1:5.1.0-1", ovmf: "2025.11-3ubuntu7" };
  const state = { installed: false, installedPackages: {}, candidatePackages: candidates, packageNames: Object.keys(candidates), candidateSetAvailable: true, providerPresent: false, kvmDeviceAvailable: true, serviceActive: false, connectionReady: false, qemuVerified: false, supported: true, repairAvailable: true };

  it("creates, stages, and revalidates the immutable five-package Ubuntu bundle", async () => {
    const { store, owner, service } = await setup(state);
    const plan = await service.planVirtualization(owner.id, {});
    expect(plan).toMatchObject({ type: "prerequisite.repair", subjectId: "virtualization", input: { expectedPackages: candidates, expectedKvmDevice: true, installedBefore: false }, output: { dependencyChangesPossible: true, arbitraryPackageSelection: false, arbitraryRepositorySelection: false, aptUpdatePerformed: false, operatorUserGroupChanged: false, networkCreated: false, storagePoolCreated: false, virtualMachineCreated: false, automaticRollback: false } });
    const job = await service.stage(plan.id, plan.revision, owner.id);
    expect(job).toMatchObject({ type: "prerequisite.virtualization.install", state: "awaiting_approval", risk: "system-package-service-virtualization", parameters: { expectedPackages: candidates, expectedKvmDevice: true, installedBefore: false }, recovery: { automaticRollback: false } });
    await expect(service.validateJob(job)).resolves.toMatchObject({ plan: { id: plan.id }, state: { kvmDeviceAvailable: true, repairAvailable: true } });
    store.close();
  });

  it("rejects browser fields, unavailable KVM, existing providers, and changed candidates", async () => {
    const { store, owner, helper, service } = await setup(state);
    await expect(service.planVirtualization(owner.id, { uri: "qemu:///session" })).rejects.toThrow("empty object");
    helper.request.mockResolvedValueOnce({ ...state, kvmDeviceAvailable: false, repairAvailable: false });
    await expect(service.planVirtualization(owner.id, {})).rejects.toThrow("KVM kernel interface");
    helper.request.mockResolvedValueOnce({ ...state, installed: true, providerPresent: true, repairAvailable: false });
    await expect(service.planVirtualization(owner.id, {})).rejects.toThrow("already active");
    helper.request.mockResolvedValueOnce({ ...state, candidatePackages: { "qemu-system-x86": candidates["qemu-system-x86"], "libvirt-daemon-system": candidates["libvirt-daemon-system"], "libvirt-clients": candidates["libvirt-clients"], virtinst: candidates.virtinst, curl: "1.0" } });
    await expect(service.planVirtualization(owner.id, {})).rejects.toThrow("No clean fixed virtualization package set");
    const plan = await service.planVirtualization(owner.id, {});
    helper.request.mockResolvedValueOnce({ ...state, candidatePackages: { ...candidates, ovmf: "2026.1-1" } });
    await expect(service.stage(plan.id, plan.revision, owner.id)).rejects.toThrow("Host state changed");
    expect(store.getPlan(plan.id).status).toBe("draft");
    store.close();
  });
});
