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
