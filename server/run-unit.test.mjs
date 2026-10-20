import { mkdtemp, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createLaneQueues, laneFor } from "./helper-lanes.mjs";
import { createRunUnitClient, rootTaskLingerCapMs, whileHoldingRootTasks } from "./run-unit.mjs";

const directories = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((d) => rm(d, { recursive: true, force: true }))); });

describe("run-unit client", () => {
  it("writes a one-shot spec, starts the template unit, and returns the task result", async () => {
    const runDirectory = await mkdtemp(path.join(os.tmpdir(), "boxpilot-run-unit-")); directories.push(runDirectory);
    const run = vi.fn(async (_binary, args) => {
      const id = args[1].replace(/^boxpilot-run@/, "").replace(/\.service$/, "");
      await writeFile(path.join(runDirectory, `${id}.result.json`), JSON.stringify({ ok: true, task: "apt.update", result: { updated: true } }));
      return { ok: true, stdout: "", stderr: "" };
    });
    const client = createRunUnitClient({ run, runDirectory, systemctlBinary: "/bin/systemctl", now: () => new Date("2026-08-19T12:00:00.000Z") });
    await expect(client.runTask("apt.update", {}, { timeoutMs: 5000 })).resolves.toEqual({ updated: true });
    expect(run).toHaveBeenCalledWith("/bin/systemctl", ["start", expect.stringMatching(/^boxpilot-run@[a-f0-9-]{36}\.service$/)], { timeout: 35000 });
    expect(await readdir(runDirectory)).toEqual([]);
  });

  it("refuses unknown tasks and surfaces unit failures and task errors", async () => {
    const runDirectory = await mkdtemp(path.join(os.tmpdir(), "boxpilot-run-unit-")); directories.push(runDirectory);
    const client = createRunUnitClient({ run: vi.fn(async () => ({ ok: false, stdout: "", stderr: "Job failed" })), runDirectory });
    await expect(client.runTask("shell.exec", {})).rejects.toThrow("not in the task table");
    await expect(client.runTask("apt.update", {})).rejects.toThrow("produced no result");
    const failing = createRunUnitClient({ runDirectory, run: vi.fn(async (_binary, args) => {
      const id = args[1].replace(/^boxpilot-run@/, "").replace(/\.service$/, "");
      await writeFile(path.join(runDirectory, `${id}.result.json`), JSON.stringify({ ok: false, task: "apt.update", error: "apt-get update failed" }));
      return { ok: false, stdout: "", stderr: "" };
    }) });
    await expect(failing.runTask("apt.update", {})).rejects.toThrow("apt-get update failed");
  });

  // systemctl as an upgrade of systemd leaves it: `start` comes back at once with the D-Bus error
  // and nothing written yet; `is-active` answers from the states given, writing the result with the last.
  async function managerLost({ states, result = { ok: true, task: "apt.upgrade", result: { upgraded: true, scope: "all" } }, tick = 1_000 }) {
    const runDirectory = await mkdtemp(path.join(os.tmpdir(), "boxpilot-run-unit-")); directories.push(runDirectory);
    let unit = null;
    const run = vi.fn(async (_binary, args) => {
      if (args[0] === "is-active") {
        const state = states.length > 1 ? states.shift() : states[0];
        if (!["active", "activating", "deactivating", "reloading", "refreshing"].includes(state) && result) {
          const id = unit.replace(/^boxpilot-run@/, "").replace(/\.service$/, "");
          await writeFile(path.join(runDirectory, `${id}.result.json`), JSON.stringify(result));
        }
        return { ok: state === "active", code: state === "active" ? 0 : 3, stdout: `${state}\n`, stderr: "" };
      }
      unit = args[1];
      return { ok: false, stdout: "", stderr: "Failed to start boxpilot-run@x.service: Connection reset by peer\nD-Bus connection terminated\n" };
    });
    const sleep = vi.fn(async () => {});
    const log = vi.fn();
    let clock = 0;
    const client = createRunUnitClient({ run, runDirectory, systemctlBinary: "/bin/systemctl", sleep, log, clock: () => (clock += tick) });
    return { client, run, sleep, log, runDirectory, asked: () => run.mock.calls.filter(([, args]) => args[0] === "is-active").length };
  }

  it("waits on the unit itself when systemctl loses the manager under it, then returns the result it wrote", async () => {
    const { client, sleep, log, asked, runDirectory } = await managerLost({ states: ["activating", "activating", "inactive"] });
    await expect(client.runTask("apt.upgrade", {}, { timeoutMs: 10_800_000 })).resolves.toEqual({ upgraded: true, scope: "all" });
    expect(asked()).toBe(3);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/^Root task apt\.upgrade \(boxpilot-run@[a-f0-9-]{36}\.service\): systemctl lost the manager while waiting \(Failed to start boxpilot-run@x\.service: Connection reset by peer\); waiting on the unit itself$/));
    expect(await readdir(runDirectory)).toEqual([]);
  });

  it("still reports a unit that stopped without a result after the manager was lost, and stops asking when the budget is spent", async () => {
    const failed = await managerLost({ states: ["failed"], result: null });
    await expect(failed.client.runTask("apt.upgrade", {})).rejects.toThrow("Root task apt.upgrade produced no result (unit failed: Failed to start boxpilot-run@x.service: Connection reset by peer");
    expect(failed.sleep).not.toHaveBeenCalled();
    // A unit that never stops: the wait ends with the task's budget plus the margin, as systemctl's own would have.
    const stuck = await managerLost({ states: ["activating"], result: null, tick: 60_000 });
    await expect(stuck.client.runTask("apt.upgrade", {}, { timeoutMs: 60_000 })).rejects.toThrow("produced no result");
    expect(stuck.asked()).toBe(2);
    expect(stuck.sleep).toHaveBeenCalledTimes(1);
  });

  it("reports a task that ran past its own budget as a timeout (M30.3)", async () => {
    const runDirectory = await mkdtemp(path.join(os.tmpdir(), "boxpilot-run-unit-")); directories.push(runDirectory);
    const client = createRunUnitClient({ runDirectory, run: vi.fn(async (_binary, args) => {
      const id = args[1].replace(/^boxpilot-run@/, "").replace(/\.service$/, "");
      await writeFile(path.join(runDirectory, `${id}.result.json`), JSON.stringify({ ok: false, task: "apt.upgrade", error: "Task apt.upgrade exceeded 10800000 ms", timedOut: true, timeoutMs: 10_800_000 }));
      return { ok: false, stdout: "", stderr: "" };
    }) });
    const error = await client.runTask("apt.upgrade", {}, { timeoutMs: 10_800_000 }).catch((caught) => caught);
    expect(error.message).toBe("Root task apt.upgrade did not finish within 3 hours");
    // The runner writes "timed out" and lets the task carry on (KillMode=process): it may still be
    // running, which a flow must not retry beside, nor "Try again with more time" start again.
    expect(error.timeout).toEqual({ scope: "step", budgetMs: 10_800_000, step: "Root task apt.upgrade", stillRunning: true });
  });
});

describe("a root task left running past its own limit (sweep 4)", () => {
  // systemctl as the helper sees it: `start` returns once the runner has written "timed out" (the
  // task itself carries on), and `is-active` says what the unit is doing, one answer per ask.
  async function timingOut({ states }) {
    const runDirectory = await mkdtemp(path.join(os.tmpdir(), "boxpilot-run-unit-")); directories.push(runDirectory);
    const asked = [];
    let clock = 0;
    const run = vi.fn(async (_binary, args) => {
      if (args[0] === "is-active") {
        asked.push(args[1]);
        const state = states.length > 1 ? states.shift() : states[0];
        return { ok: state === "active", code: state === "active" ? 0 : 3, stdout: `${state}\n`, stderr: "" };
      }
      const id = args[1].replace(/^boxpilot-run@/, "").replace(/\.service$/, "");
      await writeFile(path.join(runDirectory, `${id}.result.json`), JSON.stringify({ ok: false, task: "storage.clear-mark", error: "Task storage.clear-mark exceeded 3480000 ms", timedOut: true, timeoutMs: 3_480_000 }));
      return { ok: false, stdout: "", stderr: "" };
    });
    const sleep = vi.fn(async (ms) => { clock += ms; });
    const log = vi.fn();
    const client = createRunUnitClient({ run, runDirectory, systemctlBinary: "/bin/systemctl", sleep, log, clock: () => clock });
    const held = [];
    const clear = () => whileHoldingRootTasks((promise) => held.push(promise), () => client.runTask("storage.clear-mark", { name: "media" }, { timeoutMs: 3_480_000 }));
    return { client, asked, sleep, log, held, clear, elapsed: () => clock };
  }

  it("answers at once, and holds what its operation holds until systemd says the unit has stopped", async () => {
    const { asked, sleep, log, held, clear } = await timingOut({ states: ["activating", "activating", "inactive"] });
    const error = await clear().catch((caught) => caught);
    expect(error.timeout).toMatchObject({ scope: "step", stillRunning: true });
    expect(held).toHaveLength(1);
    await held[0];
    expect(asked).toHaveLength(3);
    expect(asked[0]).toMatch(/^boxpilot-run@[a-f0-9-]{36}\.service$/);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(log).toHaveBeenLastCalledWith(expect.stringMatching(/^Root task storage\.clear-mark \(boxpilot-run@.+\) has stopped; what it held is free again$/));
  });

  it("lets go after the unit's own limit, and says so, rather than hold everything for ever", async () => {
    const { log, held, clear, elapsed } = await timingOut({ states: ["activating"] });
    await clear().catch(() => {});
    await held[0];
    expect(elapsed()).toBeGreaterThanOrEqual(rootTaskLingerCapMs);
    expect(elapsed()).toBeLessThan(rootTaskLingerCapMs + 5 * 60_000);
    expect(log).toHaveBeenLastCalledWith(expect.stringMatching(/^Root task storage\.clear-mark \(boxpilot-run@.+\) is still running after 12 hours; what it held is free again$/));
  });

  it("keeps a reconnect of the drive queued behind the repair still running, as the helper runs it", async () => {
    const runDirectory = await mkdtemp(path.join(os.tmpdir(), "boxpilot-run-unit-")); directories.push(runDirectory);
    // The unit stops when the test says so; until then every poll finds it still activating.
    let stops;
    const unitStopped = new Promise((resolve) => { stops = resolve; });
    const queues = createLaneQueues();
    const order = [];
    const slow = createRunUnitClient({
      runDirectory,
      systemctlBinary: "/bin/systemctl",
      sleep: () => unitStopped,
      log: () => {},
      run: async (_binary, args) => {
        if (args[0] === "is-active") return { ok: false, code: 3, stdout: order.includes("unit stopped") ? "inactive\n" : "activating\n", stderr: "" };
        const id = args[1].replace(/^boxpilot-run@/, "").replace(/\.service$/, "");
        await writeFile(path.join(runDirectory, `${id}.result.json`), JSON.stringify({ ok: false, task: "storage.clear-mark", error: "exceeded", timedOut: true, timeoutMs: 3_480_000 }));
        return { ok: false, stdout: "", stderr: "" };
      },
    });
    const clearing = queues.run(laneFor("storage.dirty-mark.clear", { name: "media" }), (holdUntil) => whileHoldingRootTasks(holdUntil, () => slow.runTask("storage.clear-mark", { name: "media" }, { timeoutMs: 3_480_000 })));
    await expect(clearing).rejects.toMatchObject({ timeout: { stillRunning: true } });
    const reconnect = queues.run(laneFor("storage.remount", { name: "media" }), async () => { order.push("reconnect"); });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(order).toEqual([]);
    order.push("unit stopped");
    stops();
    await reconnect;
    expect(order).toEqual(["unit stopped", "reconnect"]);
  });

  it("holds nothing when the unit has already stopped, or when no lane is held for it", async () => {
    const { client, asked, held, clear } = await timingOut({ states: ["inactive"] });
    await clear().catch(() => {});
    expect(held).toEqual([]);
    expect(asked).toHaveLength(1);
    // Outside the helper's lanes nothing waits on it, and nothing is asked.
    await client.runTask("storage.clear-mark", { name: "media" }, { timeoutMs: 3_480_000 }).catch(() => {});
    expect(asked).toHaveLength(1);
  });
});

describe("stale files from an abandoned task", () => {
  it("removes spec and result files older than a day, and keeps recent ones", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "boxpilot-run-sweep-"));
    directories.push(directory);
    const id = "11111111-2222-4333-8444-555555555555";
    const old = path.join(directory, `${id}.result.json`);
    const fresh = path.join(directory, `${id}.json`);
    await writeFile(old, "{}");
    await writeFile(fresh, "{}");
    const twoDays = 2 * 24 * 60 * 60 * 1000;
    await utimes(old, new Date(Date.now() - twoDays), new Date(Date.now() - twoDays));
    const client = createRunUnitClient({ runDirectory: directory });
    expect(await client.sweepStale()).toEqual({ removed: 1 });
    await expect(stat(old)).rejects.toThrow();
    expect((await stat(fresh)).isFile()).toBe(true);
  });
});
