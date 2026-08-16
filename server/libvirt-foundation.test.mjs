// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createStateStore } from "./state.mjs";
import { createLibvirtFoundationService } from "./libvirt-foundation.mjs";

const foundationId = "123e4567-e89b-42d3-a456-426614174000";
const revision = "a".repeat(64);

function setup(state = {}) {
  const stateDirectory = mkdtempSync(path.join(tmpdir(), "boxpilot-libvirt-foundation-plan-"));
  const store = createStateStore({ databasePath: ":memory:", stateDirectory });
  const token = store.createBootstrapToken();
  const owner = store.consumeBootstrapToken(token.token, { username: "owner", passwordHash: "hash" });
  const inspection = {
    connectionUri: "qemu:///system", connectionReady: true, ready: false, revision,
    network: { name: "default", exists: false, active: false, autostart: false, compatible: true },
    pool: { name: "default", exists: false, active: false, autostart: false, compatible: true, target: { exists: false } },
    conflicts: [], planAvailable: true, changes: ["Define the fixed default NAT network"], boundary: { mutationPerformed: false },
    ...state,
  };
  const helper = { request: vi.fn(async () => inspection) };
  const service = createLibvirtFoundationService({ store, helper, newId: () => foundationId });
  return { store, owner, helper, service, inspection };
}

describe("libvirt foundation plans", () => {
  it("creates and stages an immutable fixed-resource plan", async () => {
    const { owner, service } = setup();
    const plan = await service.plan(owner.id, {});
    expect(plan).toMatchObject({ type: "virtualization.foundation", subjectId: "default", input: { expectedRevision: revision, foundationId }, output: { executable: true, automaticRollback: true, network: { name: "default", mode: "nat", cidr: "192.168.122.0/24" }, pool: { name: "default", targetPath: "/var/lib/libvirt/images" } } });
    const job = await service.stage(plan.id, plan.revision, owner.id);
    expect(job).toMatchObject({ type: "virtualization.foundation.initialize", state: "awaiting_approval", parameters: { planId: plan.id, revision: plan.revision, foundationId, expectedRevision: revision }, recovery: { automaticRollback: true } });
    await expect(service.validateJob(job)).resolves.toMatchObject({ plan: { id: plan.id }, state: { revision } });
  });

  it("rejects browser-selected resources, ready hosts, conflicts, and stale state", async () => {
    const selected = setup();
    await expect(selected.service.plan(selected.owner.id, { pool: "custom" })).rejects.toThrow("empty object");
    const ready = setup({ ready: true, planAvailable: false });
    await expect(ready.service.plan(ready.owner.id, {})).rejects.toThrow("already ready");
    const conflict = setup({ planAvailable: false, conflicts: ["subnet conflict"] });
    await expect(conflict.service.plan(conflict.owner.id, {})).rejects.toThrow("subnet conflict");

    const stale = setup();
    const plan = await stale.service.plan(stale.owner.id, {});
    stale.inspection.revision = "b".repeat(64);
    await expect(stale.service.stage(plan.id, plan.revision, stale.owner.id)).rejects.toThrow("Host state changed");
  });
});
