import { describe, expect, it } from "vitest";
import { heartbeatConfigure, heartbeatPing } from "./heartbeat.mjs";

const at = Date.parse("2026-09-30T10:00:00Z");
const now = () => new Date(at);
const pinged = { at: new Date(at + 400).toISOString(), ok: true, status: 200, ms: 120, error: null };

function systemctl({ fail = null } = {}) {
  const calls = [];
  const run = async (binary, args) => {
    calls.push(args.join(" "));
    return fail && args[0] === fail ? { ok: false, code: 1, stdout: "", stderr: `Failed to ${fail}` } : { ok: true, code: 0, stdout: "", stderr: "" };
  };
  return { calls, run };
}

describe("turning the heartbeat on and off", () => {
  it("writes the interval, enables and restarts the timer, and sends the first ping through the unit", async () => {
    const written = [];
    const files = { mkdir: async () => {}, writeFile: async (file, text, options) => { written.push({ file, text, mode: options.mode }); } };
    const { calls, run } = systemctl();
    const result = await heartbeatConfigure({ enabled: true, intervalMinutes: 10 }, { run, files, now, read: async () => pinged });
    expect(result).toEqual({ enabled: true, intervalMinutes: 10, last: pinged });
    expect(written).toHaveLength(1);
    expect(written[0].file.replaceAll("\\", "/")).toMatch(/boxpilot-heartbeat\.timer\.d\/interval\.conf$/);
    expect(written[0].text).toContain("OnUnitActiveSec=10min");
    expect(written[0].mode).toBe(0o644);
    expect(calls).toEqual(["daemon-reload", "enable boxpilot-heartbeat.timer", "restart boxpilot-heartbeat.timer", "start boxpilot-heartbeat.service"]);
  });

  it("turns the timer off without touching the interval", async () => {
    const { calls, run } = systemctl();
    const files = { mkdir: async () => { throw new Error("must not write"); }, writeFile: async () => { throw new Error("must not write"); } };
    const result = await heartbeatConfigure({ enabled: false }, { run, files, now, read: async () => pinged });
    expect(result).toEqual({ enabled: false, intervalMinutes: null, last: pinged });
    expect(calls).toEqual(["disable --now boxpilot-heartbeat.timer"]);
  });

  it("refuses an interval it does not offer, and says which systemctl step failed", async () => {
    const files = { mkdir: async () => {}, writeFile: async () => {} };
    await expect(heartbeatConfigure({ enabled: true, intervalMinutes: 7 }, { run: systemctl().run, files, now })).rejects.toThrow(/one of 1, 2, 5, 10, 15, 30, 60/);
    await expect(heartbeatConfigure({ enabled: true, intervalMinutes: 5 }, { run: systemctl({ fail: "enable" }).run, files, now })).rejects.toThrow(/Could not enable the heartbeat timer: Failed to enable/);
  });
});

describe("a test ping", () => {
  it("runs the unit and returns what it recorded", async () => {
    const { calls, run } = systemctl();
    expect(await heartbeatPing({}, { run, now, read: async () => pinged })).toEqual(pinged);
    expect(calls).toEqual(["start boxpilot-heartbeat.service"]);
  });

  it("does not pass an old ping off as this one", async () => {
    const old = { ...pinged, at: new Date(at - 5 * 60_000).toISOString() };
    await expect(heartbeatPing({}, { run: systemctl().run, now, read: async () => old })).rejects.toThrow(/did not record a ping/);
    await expect(heartbeatPing({}, { run: systemctl().run, now, read: async () => null })).rejects.toThrow(/did not record a ping/);
  });
});
