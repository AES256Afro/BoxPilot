import { describe, expect, it, vi } from "vitest";
import { createLaneQueues, laneFor } from "./helper-lanes.mjs";
import { createDrainedRestart } from "./self-restart.mjs";

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * An upgrade that moved libc, and installing KVM, leave BoxPilot needing a restart. It used to be a
 * blind timer: 30 seconds after an upgrade, 8 after KVM. Work queued behind them (an install waiting
 * on the Docker lane) started the moment they returned, and the timer killed it mid compose up, with
 * no rollback. The restart now waits for every lane to drain and holds the exclusive lane, so
 * nothing new starts before it.
 */
describe("BoxPilot restarting itself after a job", () => {
  const setup = ({ ok = true, order = [] } = {}) => {
    const lanes = createLaneQueues();
    const calls = [];
    const run = vi.fn(async (binary, args) => {
      calls.push({ binary, args });
      order.push("restart");
      return ok ? { ok: true, stdout: "", stderr: "" } : { ok: false, stdout: "", stderr: "dbus is down" };
    });
    const sleep = vi.fn(async () => {});
    const log = vi.fn();
    const restart = createDrainedRestart({ lanes, run, sleep, log });
    return { lanes, calls, run, sleep, log, restart, order };
  };

  it("lets the work running or queued finish first, and new work keeps flowing while it waits (sweep 4)", async () => {
    // It used to take the exclusive lane at once and wait there, so every change staged after it
    // queued behind the longest job running - for hours - and only SSH got the owner out.
    const { lanes, calls, restart, order } = setup();
    let releaseUpgrade;
    const upgrade = lanes.run(laneFor("apt.upgrade", {}), async () => {
      order.push("upgrade:start");
      await new Promise((resolve) => { releaseUpgrade = resolve; });
      // The job asks for the restart as it finishes, still holding its own lanes.
      expect(restart.request(["boxpilot.service", "boxpilot-helper.service"], { reason: "upgraded libraries" })).toBe(true);
      order.push("upgrade:end");
    });
    await tick();
    // An install staged while the upgrade runs waits behind it on the Docker lane.
    let releaseInstall;
    const install = lanes.run(laneFor("app.install", { id: "jellyfin" }), async () => {
      order.push("install:start");
      await new Promise((resolve) => { releaseInstall = resolve; });
      order.push("install:end");
    });
    releaseUpgrade();
    await upgrade;
    await tick(); await tick();
    expect(order).toEqual(["upgrade:start", "upgrade:end", "install:start"]);
    // Work staged now runs: the restart is not holding anything while it waits.
    expect(lanes.busy(laneFor("app.action", { id: "immich", action: "start" }))).toBe(false);
    await lanes.run(laneFor("vm.action", { name: "dev-lab" }), async () => { order.push("vm"); });
    expect(calls).toHaveLength(0);
    releaseInstall();
    await install;
    await restart.settled();
    expect(calls).toHaveLength(1);
    expect(calls[0].binary).toBe("/usr/bin/systemd-run");
    expect(calls[0].args).toEqual(expect.arrayContaining(["--wait", "restart", "boxpilot.service", "boxpilot-helper.service"]));
    expect(order).toEqual(["upgrade:start", "upgrade:end", "install:start", "vm", "install:end", "restart"]);
  });

  it("holds the exclusive lane once nothing runs, so nothing starts between the drain and the restart", async () => {
    const lanes = createLaneQueues();
    const order = [];
    let releaseGrace;
    const sleep = () => new Promise((resolve) => { releaseGrace = resolve; });
    const held = createDrainedRestart({ lanes, run: async () => { order.push("restart"); return { ok: true }; }, sleep, log: () => {} });
    held.request(["boxpilot.service"], { reason: "upgraded libraries" });
    await tick();
    const late = lanes.run(laneFor("vm.action", { name: "dev-lab" }), async () => { order.push("late"); });
    expect(lanes.busy(laneFor("app.action", { id: "immich", action: "start" }))).toBe(true);
    releaseGrace();
    await held.settled();
    await late;
    // On a real server "late" never runs in this process: it is refused as the restart begins.
    expect(order).toEqual(["restart", "late"]);
  });

  it("gives up after six hours of the server never being idle, stopping nothing, and says BoxPilot needs a restart", async () => {
    const lanes = createLaneQueues();
    const run = vi.fn(async () => ({ ok: true }));
    const log = vi.fn();
    let fire;
    const setTimer = vi.fn((callback, ms) => { fire = { callback, ms }; return 1; });
    const restart = createDrainedRestart({ lanes, run, sleep: async () => {}, log, setTimer, clearTimer: () => {} });
    let release;
    const sync = lanes.run(laneFor("backup.remote.sync", {}), () => new Promise((resolve) => { release = resolve; }));
    await tick();
    restart.request(["boxpilot.service", "boxpilot-helper.service"], { reason: "upgraded libraries" });
    expect(fire.ms).toBe(6 * 60 * 60_000);
    fire.callback();
    await expect(restart.settled()).resolves.toMatchObject({ restarted: false, gaveUp: true });
    expect(restart.pending()).toEqual([]);
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/BoxPilot still needs a restart.*never idle.*6 hours.*nothing was stopped.*System page/));
    // The work that kept it busy finishes, and still nothing restarts.
    release();
    await sync;
    await tick();
    expect(run).not.toHaveBeenCalled();
  });

  it("says when it begins and when it is over, so the helper can turn away what would wait for it", async () => {
    const states = [];
    const said = createDrainedRestart({ lanes: createLaneQueues(), run: async () => { states.push("systemd-run"); return { ok: true }; }, sleep: async () => { states.push("grace"); }, log: () => {}, onRestarting: (active) => states.push(active ? "refusing" : "accepting") });
    said.request(["boxpilot.service"], { reason: "upgraded libraries" });
    await said.settled();
    // Refusing starts before the grace and the restart; a web-only restart leaves this helper up,
    // so it takes work again afterwards.
    expect(states).toEqual(["refusing", "grace", "systemd-run", "accepting"]);
  });

  it("does not start while another lane is still busy", async () => {
    const { lanes, calls, restart } = setup();
    let releaseVm;
    const vm = lanes.run(laneFor("vm.action", { name: "dev-lab" }), () => new Promise((resolve) => { releaseVm = resolve; }));
    await tick();
    restart.request(["boxpilot-helper.service"], { reason: "KVM installed" });
    await tick(); await tick();
    expect(calls).toHaveLength(0);
    releaseVm();
    await vm;
    await restart.settled();
    expect(calls).toHaveLength(1);
    expect(calls[0].args.slice(-2)).toEqual(["restart", "boxpilot-helper.service"]);
  });

  it("makes one restart of every unit asked for while one is waiting", async () => {
    const { lanes, calls, restart } = setup();
    let release;
    const held = lanes.run(["host"], () => new Promise((resolve) => { release = resolve; }));
    await tick();
    expect(restart.request(["boxpilot-helper.service"], { reason: "KVM installed" })).toBe(true);
    expect(restart.request(["boxpilot.service", "cron.service"], { reason: "upgraded libraries" })).toBe(true);
    expect(restart.pending()).toEqual(["boxpilot-helper.service", "boxpilot.service"]);
    release();
    await held;
    await restart.settled();
    expect(calls).toHaveLength(1);
    expect(calls[0].args.filter((arg) => /^boxpilot.*\.service$/.test(arg)).sort()).toEqual(["boxpilot-helper.service", "boxpilot.service"]);
    expect(calls[0].args).not.toContain("cron.service");
    expect(restart.pending()).toEqual([]);
  });

  it("restarts nothing but BoxPilot's own units", async () => {
    const { calls, restart } = setup();
    expect(restart.request(["cron.service", "boxpilot.service; reboot"], { reason: "x" })).toBe(false);
    expect(restart.request([], { reason: "x" })).toBe(false);
    expect(restart.request(null, { reason: "x" })).toBe(false);
    await restart.settled();
    expect(calls).toHaveLength(0);
  });

  it("gives the job that asked a moment to be recorded, and says so when the restart cannot be made", async () => {
    const { lanes, sleep, log, restart } = setup({ ok: false });
    restart.request(["boxpilot.service"], { reason: "upgraded libraries" });
    await restart.settled();
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep.mock.calls[0][0]).toBeGreaterThanOrEqual(5_000);
    expect(log.mock.calls.some(([line]) => /could not restart/i.test(line) && /dbus is down/.test(line))).toBe(true);
    // The lanes are free again: nothing waits behind a restart that never happened.
    await tick();
    expect(lanes.size()).toBe(0);
  });
});
