import { describe, expect, it, vi } from "vitest";
import { appendPowerEvent, formatPowerEvent, parsePowerEvents, powerEventNames, readPowerEvents, readPowerPolicy } from "./power-events.mjs";

const log = [
  "2026-09-29T18:41:02Z on-battery charge=100 runtime=1260",
  "2026-09-29T18:44:40Z on-mains charge=96 runtime=1180",
  "not a line",
  "2026-09-29T19:02:00Z made-up-event",
  "2026-09-29T19:05:00Z low-battery charge=9 runtime=110 secret=12 ups=bigbox",
  "2026-09-29T19:05:06Z shutdown",
  "2026-09-29T19:05:31Z apps-stopped containers=7 drives=2 busy=0",
  "2026-09-29T19:05:33Z power-off",
  "",
].join("\n");

describe("the power-event log", () => {
  it("reads known events and numeric fields only", () => {
    const events = parsePowerEvents(log);
    expect(events.map((event) => event.event)).toEqual(["on-battery", "on-mains", "shutdown", "apps-stopped", "power-off"]);
    expect(events[0]).toEqual({ at: "2026-09-29T18:41:02.000Z", event: "on-battery", charge: 100, runtime: 1260 });
    expect(events[3]).toEqual({ at: "2026-09-29T19:05:31.000Z", event: "apps-stopped", containers: 7, drives: 2, busy: 0 });
  });

  it("drops a line with a field that is not a number, whatever else it says", () => {
    // `ups=bigbox` is not numeric, so the whole low-battery line is refused rather than half-read.
    expect(parsePowerEvents("2026-09-29T19:05:00Z low-battery charge=9 ups=bigbox").length).toBe(0);
    expect(parsePowerEvents("2026-09-29T19:05:00Z low-battery charge=9 secret=12")).toEqual([{ at: "2026-09-29T19:05:00.000Z", event: "low-battery", charge: 9 }]);
  });

  it("writes lines the reader reads back, and refuses a name it would not", () => {
    const line = formatPowerEvent("apps-stopped", { containers: 3, drives: 1, busy: 0, bogus: 5 }, new Date("2026-09-29T19:05:31.123Z"));
    expect(line).toBe("2026-09-29T19:05:31Z apps-stopped containers=3 drives=1 busy=0\n");
    expect(parsePowerEvents(line)).toEqual([{ at: "2026-09-29T19:05:31.000Z", event: "apps-stopped", containers: 3, drives: 1, busy: 0 }]);
    expect(() => formatPowerEvent("nonsense")).toThrow("Unknown power event");
    expect(powerEventNames).toEqual(expect.arrayContaining(["on-battery", "on-mains", "low-battery", "shutdown", "power-off", "watching"]));
  });

  it("appends without ever failing a power-off", async () => {
    const append = vi.fn(async () => {});
    await expect(appendPowerEvent("power-off", {}, { path: "/x/events.log", append, now: new Date("2026-09-29T19:05:33Z") })).resolves.toBe(true);
    expect(append).toHaveBeenCalledWith("/x/events.log", "2026-09-29T19:05:33Z power-off\n", { mode: 0o644 });
    await expect(appendPowerEvent("power-off", {}, { append: async () => { throw new Error("EROFS"); } })).resolves.toBe(false);
  });

  it("returns the newest first, and says when the server started again after switching itself off", async () => {
    const result = await readPowerEvents({ read: async () => log, bootTime: new Date("2026-09-29T20:10:07.500Z") });
    expect(result.available).toBe("yes");
    expect(result.events.map((event) => event.event)).toEqual(["started", "power-off", "apps-stopped", "shutdown", "on-mains", "on-battery"]);
    expect(result.events[0].at).toBe("2026-09-29T20:10:07.000Z");
    // Booted before the power-off (this boot is the one that switched off): no "started".
    const same = await readPowerEvents({ read: async () => log, bootTime: new Date("2026-09-20T00:00:00Z") });
    expect(same.events[0].event).toBe("power-off");
    const limited = await readPowerEvents({ read: async () => log, bootTime: new Date("2026-09-20T00:00:00Z"), limit: 2 });
    expect(limited.events.map((event) => event.event)).toEqual(["power-off", "apps-stopped"]);
  });

  it("tells no log apart from one it cannot read", async () => {
    const missing = Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    await expect(readPowerEvents({ read: async () => { throw missing; } })).resolves.toEqual({ available: "none", events: [] });
    await expect(readPowerEvents({ read: async () => { throw Object.assign(new Error("EACCES"), { code: "EACCES" }); } })).resolves.toEqual({ available: "unreadable", events: [] });
  });

  it("reads what BoxPilot set up, and nothing it does not recognise", async () => {
    const policy = { shutdownAtLowBattery: true, lowBatteryPercent: 20, lowRuntimeSeconds: 300, preparationSeconds: 60, configuredAt: "2026-09-29T18:00:00.000Z", password: "never" };
    await expect(readPowerPolicy({ read: async () => JSON.stringify(policy) })).resolves.toEqual({ shutdownAtLowBattery: true, lowBatteryPercent: 20, lowRuntimeSeconds: 300, preparationSeconds: 60, configuredAt: "2026-09-29T18:00:00.000Z" });
    await expect(readPowerPolicy({ read: async () => JSON.stringify({ shutdownAtLowBattery: "yes", lowBatteryPercent: 400 }) })).resolves.toMatchObject({ shutdownAtLowBattery: false, lowBatteryPercent: null });
    await expect(readPowerPolicy({ read: async () => "{" })).resolves.toBeNull();
  });
});
