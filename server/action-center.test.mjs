import { describe, expect, it, vi } from "vitest";
import { createActionCenterService } from "./action-center.mjs";

const now = () => new Date("2026-08-16T05:00:00.000Z");

describe("read-only local Action Center", () => {
  it("prioritizes fixed guidance without exposing mutation controls or sensitive evidence", async () => {
    const recoveryKit = { inspect: vi.fn(async () => ({
      checks: [
        { id: "controller.database", state: "operator-check", title: "Independent BoxPilot database copy", evidence: "No off-host database proof exists.", action: "Create an independent copy." },
        { id: "applications.backup", state: "action-required", title: "Catalog application backups", evidence: "1 installed application has no recorded backup.", action: "Back it up from the catalog card." },
        { id: "virtualization.backup", state: "unavailable", title: "Virtual-machine recovery", evidence: "Libvirt inventory is unavailable.", action: "Restore helper access." },
        { id: "host.prerequisites", state: "not-applicable", title: "Host prerequisite review", evidence: "All ready.", action: "Nothing to do." },
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
      "recovery.applications.backup",
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

  it("maps optional local UPS evidence without exposing power controls", async () => {
    const recoveryKit = { inspect: vi.fn(async () => ({ checks: [], evidence: { jobs: [] } })) };
    const storage = { filesystems: { available: true, summary: { healthy: 1, warning: 0, critical: 0, unavailable: 0 }, errors: { healthy: 1, critical: 0, unavailable: 0, unsupported: 0 } }, smart: { available: true, status: "healthy", reason: "fixed-root-scan" } };
    const inventory = { inspect: vi.fn(async () => ({ storage, power: { ups: { installed: false, configured: false, available: false, state: "unavailable", reason: "nut-client-not-installed" } } })) };
    const optional = await createActionCenterService({ recoveryKit, inventory, now }).inspect();
    expect(optional.notices).toEqual([expect.objectContaining({ id: "power.ups-not-configured", severity: "info", boundary: expect.objectContaining({ automaticFixAvailable: false }) })]);

    inventory.inspect.mockResolvedValueOnce({ storage, power: { ups: { installed: true, configured: true, available: true, state: "low-battery", batteryChargePercent: 8 } } });
    const critical = await createActionCenterService({ recoveryKit, inventory, now }).inspect();
    expect(critical.notices).toEqual([expect.objectContaining({ id: "power.ups-critical", severity: "critical" })]);
    const serialized = JSON.stringify(critical);
    expect(serialized).not.toContain("upsdrvctl");
    expect(serialized).not.toContain("shutdown -");
  });

  it("maps bounded host-maintenance evidence to fixed manual guidance", async () => {
    const recoveryKit = { inspect: vi.fn(async () => ({ checks: [], evidence: { jobs: [] } })) };
    const storage = { filesystems: { available: true, summary: { healthy: 1, warning: 0, critical: 0, unavailable: 0 }, errors: { healthy: 1, critical: 0, unavailable: 0, unsupported: 0 } }, smart: { available: true, status: "healthy", reason: "fixed-root-scan" } };
    const maintenance = { system: { available: true, state: "degraded", failedServiceCount: 2 }, reboot: { available: true, required: true }, packageManager: { available: true, state: "interrupted", pendingUpdateFragments: 1 }, aptMetadata: { available: true, state: "stale", ageHours: 240 }, automaticSecurityUpdates: { available: true, state: "disabled" } };
    const result = await createActionCenterService({ recoveryKit, inventory: { inspect: vi.fn(async () => ({ storage, maintenance })) }, now }).inspect();
    expect(result.notices.map((notice) => notice.id)).toEqual(["maintenance.package-manager-interrupted", "maintenance.reboot-required", "maintenance.system-degraded", "maintenance.apt-metadata-stale", "maintenance.security-updates"]);
    expect(result.notices.every((notice) => notice.boundary.automaticFixAvailable === false)).toBe(true);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("apt-get");
    expect(serialized).not.toContain("systemctl restart");
    expect(serialized).not.toContain("shutdown -");
  });
});
