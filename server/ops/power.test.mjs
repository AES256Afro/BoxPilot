import { describe, expect, it, vi } from "vitest";
import express from "express";
import { validateParameters } from "./registry.mjs";
import { powerOperations } from "./power.mjs";
import { createPowerRouter } from "../routes/power.mjs";
import { powerHardware } from "../tasks/power.mjs";

const byId = Object.fromEntries(powerOperations().map((operation) => [operation.id, operation]));

describe("the power operations (M39)", () => {
  it("have honest tiers: reads for operators, turning things on is medium, turning the watchdog off is low", () => {
    expect(byId["power.hardware.inspect"]).toMatchObject({ risk: "low", readOnly: true, minimumRole: "operator" });
    expect(byId["power.watchdog.enable"]).toMatchObject({ risk: "medium", readOnly: false });
    expect(byId["power.watchdog.disable"]).toMatchObject({ risk: "low", readOnly: false });
    expect(byId["power.wake-on-lan.set"]).toMatchObject({ risk: "medium", readOnly: false });
    // The preview has to say plainly what turning the watchdog on means.
    expect(byId["power.watchdog.enable"].description).toContain("if the server freezes it restarts by itself");
  });

  it("validate what they are sent", () => {
    const enable = byId["power.watchdog.enable"].parameters;
    expect(validateParameters(enable, {}, "t")).toBeNull();
    expect(validateParameters(enable, { runtimeSeconds: 60 }, "t")).toBeNull();
    expect(validateParameters(enable, { runtimeSeconds: 10 }, "t")).toContain("from 30 to 300");
    expect(validateParameters(enable, { runtimeSeconds: 60, device: "/dev/sda" }, "t")).toContain("does not accept");
    const wake = byId["power.wake-on-lan.set"].parameters;
    expect(validateParameters(wake, { interface: "enp5s0", enabled: true }, "t")).toBeNull();
    expect(validateParameters(wake, { interface: "../../etc", enabled: true }, "t")).toContain("invalid");
    expect(validateParameters(wake, { interface: "enp5s0" }, "t")).toContain("requires");
  });

  it("run as root tasks with the parameters they were given", async () => {
    const runUnit = { runTask: vi.fn(async () => ({})) };
    await byId["power.watchdog.enable"].run({}, { runUnit, jobLog: { path: "/x.log" } });
    expect(runUnit.runTask).toHaveBeenLastCalledWith("power.watchdog.enable", { runtimeSeconds: 60 }, { timeoutMs: 90_000, logPath: "/x.log" });
    await byId["power.wake-on-lan.set"].run({ interface: "enp5s0", enabled: false }, { runUnit, jobLog: null });
    expect(runUnit.runTask).toHaveBeenLastCalledWith("power.wake-on-lan.set", { interface: "enp5s0", enabled: false }, expect.anything());
    await byId["power.hardware.inspect"].run({}, { runUnit, jobLog: null });
    expect(runUnit.runTask).toHaveBeenLastCalledWith("power.hardware", {}, expect.anything());
  });

  it("read the hardware in one task, and a part that fails does not sink the rest", async () => {
    const result = await powerHardware({}, {
      run: vi.fn(),
      watchdog: async () => { throw new Error("no /proc"); },
      wake: async () => ({ ethtool: true, ports: [] }),
      board: async () => "ASUSTeK COMPUTER INC.",
    });
    expect(result).toEqual({ watchdog: { state: "unreadable", usable: false, error: "no /proc" }, wakeOnLan: { ethtool: true, ports: [] }, boardVendor: "ASUSTeK COMPUTER INC." });
  });
});

describe("the power overview route", () => {
  async function get(router, url) {
    const app = express();
    app.use("/api/v1", router);
    const server = app.listen(0);
    try {
      const { port } = server.address();
      const response = await fetch(`http://127.0.0.1:${port}${url}`);
      return { status: response.status, body: await response.json() };
    } finally {
      server.close();
    }
  }

  it("answers the events, the policy and the guidance for this board", async () => {
    const router = createPowerRouter({
      events: async () => ({ available: "yes", events: [{ at: "2026-09-29T18:41:02.000Z", event: "on-battery", charge: 100 }] }),
      policy: async () => ({ shutdownAtLowBattery: true, lowBatteryPercent: 20, lowRuntimeSeconds: 300, preparationSeconds: 60, configuredAt: null }),
      boardVendor: async () => "Gigabyte Technology Co., Ltd.",
      ups: { inspect: async () => ({ configured: true, available: true, state: "online", batteryChargePercent: 100 }) },
    });
    const { status, body } = await get(router, "/api/v1/power/overview");
    expect(status).toBe(200);
    expect(body.ups).toMatchObject({ state: "online", batteryChargePercent: 100 });
    expect(body.events).toHaveLength(1);
    expect(body.eventsAvailable).toBe("yes");
    expect(body.policy.shutdownAtLowBattery).toBe(true);
    expect(body.guidance.steps[0]).toMatchObject({ maker: "Gigabyte", thisBoard: true, value: "Always On" });
    expect(body.guidance.why[1]).toContain("the UPS then switches its outlets off");
  });

  it("still answers when nothing can be read", async () => {
    const router = createPowerRouter({ events: async () => { throw new Error("x"); }, policy: async () => { throw new Error("y"); }, boardVendor: async () => { throw new Error("z"); }, ups: { inspect: async () => { throw new Error("w"); } } });
    const { status, body } = await get(router, "/api/v1/power/overview");
    expect(status).toBe(200);
    expect(body).toMatchObject({ ups: { configured: false, state: "unavailable" }, events: [], eventsAvailable: "unreadable", policy: null, guidance: { board: null } });
  });
});
