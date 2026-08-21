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

describe("libvirt foundation preparation", () => {
  it("pins the current safe revision for the registry operation", async () => {
    const { service } = setup();
    await expect(service.prepareOperation()).resolves.toEqual({ foundationId, expectedRevision: revision });
  });

  it("refuses ready hosts and unsafe states", async () => {
    const ready = setup({ ready: true, planAvailable: false });
    await expect(ready.service.prepareOperation()).rejects.toThrow("already ready");
    const conflict = setup({ planAvailable: false, conflicts: ["subnet conflict"] });
    await expect(conflict.service.prepareOperation()).rejects.toThrow("subnet conflict");
  });
});
