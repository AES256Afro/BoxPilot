import { describe, expect, it, vi } from "vitest";
import { budgetSecondsFrom, prepareForPowerOff } from "./boxpilot-ups-shutdown.mjs";

const summary = (overrides = {}) => ({
  dockerStopped: true,
  containers: { stopped: ["bp-jellyfin", "bp-pihole"], signalled: [], killed: ["bp-qbittorrent"], stillRunning: [] },
  drives: [{ mounted: true, state: "unmounted" }, { mounted: true, state: "busy" }, { mounted: false, state: "not-mounted" }],
  ...overrides,
});

describe("the UPS's shutdown preparation", () => {
  it("runs the reboot's steps for every app, bounded, and logs one line of how it went", async () => {
    const prepare = vi.fn(async () => summary());
    const append = vi.fn(async () => true);
    const outcome = await prepareForPowerOff({ budgetSeconds: 45, prepare, append, log: () => {} });
    expect(prepare).toHaveBeenCalledWith({}, expect.objectContaining({ budgetMs: 45_000, allContainers: true, occasion: "shutdown" }));
    expect(append).toHaveBeenCalledWith("apps-stopped", { containers: 3, drives: 1, busy: 1 });
    expect(outcome).toEqual({ ok: true, containers: 3, drives: 1, busy: 1 });
  });

  it("logs that it could not, and lets the power-off go ahead", async () => {
    const append = vi.fn(async () => true);
    const log = vi.fn();
    const outcome = await prepareForPowerOff({ prepare: async () => { throw new Error("fstab unreadable"); }, append, log });
    expect(outcome).toEqual({ ok: false, error: "fstab unreadable" });
    expect(append).toHaveBeenCalledWith("apps-not-stopped");
    expect(log).toHaveBeenCalledWith(expect.stringContaining("powering off regardless"));
  });

  it("takes its budget from the shell script, within bounds", () => {
    expect(budgetSecondsFrom(["node", "x", "--budget-seconds", "90"])).toBe(90);
    expect(budgetSecondsFrom(["node", "x", "--budget-seconds", "5"])).toBe(60);
    expect(budgetSecondsFrom(["node", "x"])).toBe(60);
  });
});
