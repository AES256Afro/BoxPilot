import { describe, expect, it, vi } from "vitest";
import { createActionCenterService } from "./action-center.mjs";

const now = () => new Date("2026-08-16T05:00:00.000Z");

describe("read-only local Action Center", () => {
  it("prioritizes fixed guidance without exposing mutation controls or sensitive evidence", async () => {
    const recoveryKit = { inspect: vi.fn(async () => ({
      checks: [
        { id: "controller.database", state: "operator-check", title: "Independent BoxPilot database copy", evidence: "No off-host database proof exists.", action: "Create an independent copy." },
        { id: "router.checkpoint", state: "action-required", title: "Router configuration checkpoint", evidence: "No router backup identity is recorded.", action: "Export and hash the active router configuration." },
        { id: "virtualization.backup", state: "unavailable", title: "Virtual-machine recovery", evidence: "Libvirt inventory is unavailable.", action: "Restore helper access." },
        { id: "dns.second-device", state: "not-applicable", title: "Independent DNS proof", evidence: "No direct proof.", action: "Keep DNS unchanged." },
      ],
      evidence: { jobs: [{ state: "failed", error: "password=do-not-export", owner: "private-owner" }] },
    })) };
    const result = await createActionCenterService({ recoveryKit, now, version: "0.29.0-test" }).inspect();
    expect(result).toMatchObject({
      product: { version: "0.29.0-test" },
      mode: "read-only-local-action-guidance",
      sourceStatus: "ready",
      summary: { critical: 1, warning: 2, info: 1, total: 4 },
      boundary: { mutationPerformed: false, automaticRepair: false, persistence: false, externalDelivery: false },
    });
    expect(result.notices.map((item) => item.id)).toEqual([
      "recovery.virtualization.backup",
      "jobs.failed",
      "recovery.router.checkpoint",
      "recovery.controller.database",
    ]);
    expect(result.notices.every((item) => item.boundary.automaticFixAvailable === false)).toBe(true);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("do-not-export");
    expect(serialized).not.toContain("private-owner");
  });

  it("fails closed to a critical notice when recovery evidence cannot be collected", async () => {
    const service = createActionCenterService({ recoveryKit: { inspect: vi.fn(async () => { throw new Error("offline secret"); }) }, now });
    const result = await service.inspect();
    expect(result.sourceStatus).toBe("unavailable");
    expect(result.summary).toEqual({ critical: 1, warning: 0, info: 0, total: 1 });
    expect(result.notices[0]).toMatchObject({ id: "action-center.collector-unavailable", boundary: { mutationPerformed: false, logsIncluded: false } });
    expect(JSON.stringify(result)).not.toContain("offline secret");
  });

  it("does not claim all-clear when an unknown actionable check appears", async () => {
    const recoveryKit = { inspect: vi.fn(async () => ({ checks: [{ id: "future.check", state: "action-required" }], evidence: { jobs: [] } })) };
    const result = await createActionCenterService({ recoveryKit, now }).inspect();
    expect(result.notices).toEqual([expect.objectContaining({ id: "action-center.unmapped-evidence", severity: "warning" })]);
  });

  it("adds fail-closed storage capacity and SMART guidance without a repair route", async () => {
    const recoveryKit = { inspect: vi.fn(async () => ({ checks: [], evidence: { jobs: [] } })) };
    const inventory = { inspect: vi.fn(async () => ({ storage: { filesystems: { available: true, summary: { healthy: 1, warning: 0, critical: 1, unavailable: 0 } }, smart: { available: false, status: "unavailable", reason: "smartctl-not-installed" } } })) };
    const result = await createActionCenterService({ recoveryKit, inventory, now }).inspect();
    expect(result.notices).toEqual([
      expect.objectContaining({ id: "storage.filesystem-capacity", severity: "critical", recommendation: { view: "overview", title: "Open Overview", steps: expect.any(Array) } }),
      expect.objectContaining({ id: "storage.smart-evidence", severity: "warning", boundary: expect.objectContaining({ automaticFixAvailable: false }) }),
    ]);
    expect(JSON.stringify(result)).not.toContain("apt-get");
    expect(JSON.stringify(result)).not.toContain("rm ");
  });

  it("surfaces filesystem error counters and unsupported coverage without offering fsck", async () => {
    const recoveryKit = { inspect: vi.fn(async () => ({ checks: [], evidence: { jobs: [] } })) };
    const inventory = { inspect: vi.fn(async () => ({ storage: { filesystems: { available: true, summary: { healthy: 2, warning: 0, critical: 0, unavailable: 0 }, errors: { healthy: 1, critical: 1, unavailable: 0, unsupported: 1 } }, smart: { available: true, status: "healthy", reason: "fixed-root-scan" } } })) };
    const critical = await createActionCenterService({ recoveryKit, inventory, now }).inspect();
    expect(critical.notices).toEqual([expect.objectContaining({ id: "storage.filesystem-errors", severity: "critical", boundary: expect.objectContaining({ automaticFixAvailable: false }) })]);
    expect(JSON.stringify(critical)).not.toContain("fsck -");

    inventory.inspect.mockResolvedValueOnce({ storage: { filesystems: { available: true, summary: { healthy: 2, warning: 0, critical: 0, unavailable: 0 }, errors: { healthy: 2, critical: 0, unavailable: 0, unsupported: 1 } }, smart: { available: true, status: "healthy", reason: "fixed-root-scan" } } });
    const unsupported = await createActionCenterService({ recoveryKit, inventory, now }).inspect();
    expect(unsupported.notices).toEqual([expect.objectContaining({ id: "storage.filesystem-errors-unsupported", severity: "info" })]);
  });
});
