import { describe, expect, it, vi } from "vitest";
import { createMaintenanceService } from "./maintenance.mjs";

const now = () => new Date("2026-08-16T06:00:00.000Z");

function healthyRun(_binary, args) {
  if (args[0] === "is-system-running") return { ok: true, stdout: "running", code: null };
  if (args[0] === "--failed") return { ok: true, stdout: "", code: null };
  return { ok: true, stdout: "LoadState=loaded\nActiveState=active\nSubState=running\nUnitFileState=enabled", code: null };
}

describe("bounded host-maintenance evidence", () => {
  it("reports a healthy fixed-source state without names or mutation controls", async () => {
    const run = vi.fn(healthyRun);
    const result = await createMaintenanceService({ run, exists: vi.fn(async () => false), readDirectory: vi.fn(async () => []), getStat: vi.fn(async () => ({ mtime: new Date("2026-08-16T04:00:00.000Z") })), now }).inspect();
    expect(result).toMatchObject({ system: { available: true, state: "running", failedServiceCount: 0 }, reboot: { available: true, required: false }, packageManager: { available: true, state: "ready", pendingUpdateFragments: 0 }, aptMetadata: { available: true, state: "current", ageHours: 2 }, automaticSecurityUpdates: { available: true, state: "enabled-active", enabled: true, active: true }, boundary: { mutationPerformed: false, aptOperationAvailable: false, rebootAvailable: false, packageNamesIncluded: false, unitNamesIncluded: false } });
    expect(run).toHaveBeenCalledWith("/usr/bin/systemctl", ["--failed", "--type=service", "--no-legend", "--plain", "--no-pager"], { timeout: 5000 });
  });

  it("derives degraded, reboot, interrupted dpkg, stale APT, and disabled update evidence", async () => {
    const run = vi.fn(async (_binary, args) => args[0] === "is-system-running"
      ? { ok: false, stdout: "degraded", code: 1 }
      : args[0] === "--failed"
        ? { ok: true, stdout: "secret-unit.service loaded failed failed secret description\nsecond.service loaded failed failed second", code: null }
        : { ok: true, stdout: "LoadState=loaded\nActiveState=inactive\nSubState=dead\nUnitFileState=disabled\nDescription=secret", code: null });
    const result = await createMaintenanceService({ run, exists: vi.fn(async () => true), readDirectory: vi.fn(async () => ["0000", "0001", "lock", "private-name"]), getStat: vi.fn(async () => ({ mtime: new Date("2026-08-01T00:00:00.000Z") })), now }).inspect();
    expect(result).toMatchObject({ system: { state: "degraded", failedServiceCount: 2 }, reboot: { required: true }, packageManager: { state: "interrupted", pendingUpdateFragments: 2 }, aptMetadata: { state: "stale" }, automaticSecurityUpdates: { state: "disabled", enabled: false, active: false } });
    expect(JSON.stringify(result)).not.toContain("secret");
    expect(JSON.stringify(result)).not.toContain("second.service");
    expect(JSON.stringify(result)).not.toContain("private-name");
  });

  it("fails individual unavailable collectors closed without returning errors", async () => {
    const result = await createMaintenanceService({ run: vi.fn(async () => { throw new Error("command secret"); }), exists: vi.fn(async () => { throw new Error("path secret"); }), readDirectory: vi.fn(async () => { throw new Error("dpkg secret"); }), getStat: vi.fn(async () => { throw new Error("apt secret"); }), now }).inspect().catch(() => null);
    expect(result).toBeNull();
  });

  it("rejects future APT timestamps and unknown system states", async () => {
    const run = vi.fn(async (_binary, args) => args[0] === "--failed" ? { ok: false, stdout: "", code: 1 } : args[0] === "show" ? { ok: false, stdout: "", code: 1 } : { ok: true, stdout: "private-state", code: null });
    const result = await createMaintenanceService({ run, exists: vi.fn(async () => null), readDirectory: vi.fn(async () => []), getStat: vi.fn(async () => ({ mtime: new Date("2026-08-17T00:00:00.000Z") })), now }).inspect();
    expect(result).toMatchObject({ system: { available: false, state: "unavailable", failedServiceCount: null }, reboot: { available: false, required: null }, aptMetadata: { available: false, state: "unavailable", updatedAt: null, ageHours: null }, automaticSecurityUpdates: { available: false, state: "unavailable" } });
    expect(JSON.stringify(result)).not.toContain("private-state");
  });
});
