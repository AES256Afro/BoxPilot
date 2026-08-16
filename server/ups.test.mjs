import { describe, expect, it, vi } from "vitest";
import { createUpsService } from "./ups.mjs";

describe("bounded local UPS evidence", () => {
  it("reports a missing NUT client without probing another host", async () => {
    const run = vi.fn(async () => ({ ok: false, stdout: "", code: "ENOENT" }));
    const result = await createUpsService({ run }).inspect();
    expect(result).toMatchObject({ installed: false, configured: false, available: false, reason: "nut-client-not-installed", boundary: { mutationPerformed: false, powerCommandAvailable: false, localhostOnly: true, remoteNetworkProbePerformed: false } });
    expect(run).toHaveBeenCalledWith("/usr/bin/upsc", ["-l", "localhost"], { timeout: 5000 });
  });

  it("returns only allowlisted state and metrics for one locally enumerated UPS", async () => {
    const run = vi.fn(async (_binary, args) => args[0] === "-l"
      ? { ok: true, stdout: "mainups\n", code: null }
      : { ok: true, stdout: "ups.status: OL CHRG\nbattery.charge: 98\nbattery.runtime: 1800\nups.load: 22.5\ndevice.serial: private-serial\nups.alarm: private-alarm", code: null });
    const result = await createUpsService({ run }).inspect();
    expect(result).toMatchObject({ installed: true, configured: true, available: true, state: "online", reason: "ok", deviceCount: 1, statusTokens: ["CHRG", "OL"], batteryChargePercent: 98, estimatedRuntimeSeconds: 1800, loadPercent: 22.5, boundary: { deviceNameIncluded: false, serialIncluded: false, rawOutputIncluded: false } });
    expect(run).toHaveBeenLastCalledWith("/usr/bin/upsc", ["mainups@localhost"], { timeout: 5000 });
    expect(JSON.stringify(result)).not.toContain("private");
    expect(JSON.stringify(result)).not.toContain("mainups");
  });

  it("derives low-battery state and fails multiple devices closed", async () => {
    const lowRun = vi.fn(async (_binary, args) => args[0] === "-l" ? { ok: true, stdout: "ups", code: null } : { ok: true, stdout: "ups.status: OB LB DISCHRG\nbattery.charge: 9", code: null });
    await expect(createUpsService({ run: lowRun }).inspect()).resolves.toMatchObject({ state: "low-battery", statusTokens: ["DISCHRG", "LB", "OB"], batteryChargePercent: 9 });

    const multipleRun = vi.fn(async () => ({ ok: true, stdout: "first\nsecond", code: null }));
    await expect(createUpsService({ run: multipleRun }).inspect()).resolves.toMatchObject({ installed: true, configured: true, available: false, deviceCount: 2, reason: "multiple-local-ups-devices" });
    expect(multipleRun).toHaveBeenCalledTimes(1);
  });

  it("rejects unknown status and out-of-range metrics", async () => {
    const run = vi.fn(async (_binary, args) => args[0] === "-l" ? { ok: true, stdout: "ups", code: null } : { ok: true, stdout: "ups.status: SECRET\nbattery.charge: 101\nbattery.runtime: -1\nups.load: 999", code: null });
    const result = await createUpsService({ run }).inspect();
    expect(result).toMatchObject({ available: false, state: "unavailable", reason: "local-ups-status-unavailable", statusTokens: [], batteryChargePercent: null, estimatedRuntimeSeconds: null, loadPercent: null });
  });
});
