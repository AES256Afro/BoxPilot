// @vitest-environment node
/**
 * Faster while someone waits (M40, ADR-009): a person's run gets the owner's "while you wait"
 * processors (eight on the owner's server) and a thread for each; everything else stays at the
 * background number (four). The root helper sets the running unit's quota, and a raise always
 * comes with a timer that takes it back. tests/ubuntu/agents-caps.sh proves the same on systemd.
 */
import { afterEach, describe, expect, it } from "vitest";
import { createAgentsHarness } from "../../test/agents-harness.mjs";
import { coreCeiling, effectiveCores, threadsFor } from "./caps.mjs";
import { cpuResetUnit, setRunnerProcessors } from "./cpu.mjs";
import { laneFor } from "../helper-lanes.mjs";
import { registry } from "../ops/index.mjs";

describe("the root helper's side", () => {
  const recorder = ({ fail = {} } = {}) => {
    const calls = [];
    const run = async (binary, args) => {
      const line = `${binary.split("/").pop()} ${args.join(" ")}`;
      calls.push(line);
      const failing = Object.entries(fail).find(([start]) => line.startsWith(start));
      if (failing) return { ok: false, stdout: "", stderr: failing[1] };
      return { ok: true, stdout: line.includes("show") ? "CPUQuotaPerSecUSec=8s\n" : "", stderr: "" };
    };
    return { calls, run };
  };

  it("raises the running unit's quota and arms the timer that takes it back", async () => {
    const { calls, run } = recorder();
    const result = await setRunnerProcessors({ processors: 8, background: 4, resetAfterSeconds: 1_020 }, { run, bounds: { min: 2, max: 8 } });
    expect(calls).toEqual([
      `systemctl stop ${cpuResetUnit}.timer`,
      "systemctl set-property --runtime boxpilot-agents.service CPUQuota=800%",
      `systemd-run --quiet --collect --unit=${cpuResetUnit} --on-active=1020 --timer-property=AccuracySec=1s --description=BoxPilot: the agents runner back to 4 processors -- /usr/bin/systemctl set-property --runtime boxpilot-agents.service CPUQuota=400%`,
      "systemctl show boxpilot-agents.service --property=CPUQuotaPerSecUSec",
    ]);
    expect(result).toMatchObject({ processors: 8, background: 4, quotaPercent: 800, perSecond: "8s", resetAt: expect.any(String) });
  });

  it("lowers it with no timer, and stops the one a raise left", async () => {
    const { calls, run } = recorder();
    const result = await setRunnerProcessors({ processors: 4, background: 4 }, { run, bounds: { min: 2, max: 8 } });
    expect(calls.slice(0, 2)).toEqual([`systemctl stop ${cpuResetUnit}.timer`, "systemctl set-property --runtime boxpilot-agents.service CPUQuota=400%"]);
    expect(calls.some((line) => line.startsWith("systemd-run"))).toBe(false);
    expect(result.resetAt).toBeNull();
  });

  it("never raises without its way back: a timer that cannot be set takes the raise back at once", async () => {
    const { calls, run } = recorder({ fail: { "systemd-run": "Failed to connect to bus" } });
    await expect(setRunnerProcessors({ processors: 8, background: 4 }, { run, bounds: { min: 2, max: 8 } })).rejects.toThrow(/could not be set \(Failed to connect to bus\), so the runner stays at 4/);
    expect(calls.at(-1)).toBe("systemctl set-property --runtime boxpilot-agents.service CPUQuota=400%");
  });

  it("holds every number to the machine's ceiling, whatever it is asked", async () => {
    const { run } = recorder();
    await expect(setRunnerProcessors({ processors: 12, background: 4 }, { run, bounds: { min: 2, max: 8 } })).rejects.toThrow(/The processors must be 4 to 8/);
    await expect(setRunnerProcessors({ processors: 3, background: 4 }, { run, bounds: { min: 2, max: 8 } })).rejects.toThrow(/The processors must be 4 to 8/);
    await expect(setRunnerProcessors({ processors: 4, background: 1 }, { run, bounds: { min: 2, max: 8 } })).rejects.toThrow(/The background processors must be 2 to 8/);
    // A four-processor machine keeps two free: two at most.
    await expect(setRunnerProcessors({ processors: 3, background: 2 }, { run, bounds: { min: 2, max: coreCeiling(4) } })).rejects.toThrow(/must be 2 to 2/);
  });

  it("is a registered low-risk operation for the owner, on a lane of its own", () => {
    expect(registry.get("agents.runtime.cpu")).toMatchObject({ risk: "low", minimumRole: "owner", readOnly: false });
    expect(registry.validate("agents.runtime.cpu", { processors: 8, background: 4, resetAfterSeconds: 1_020 })).toBeNull();
    expect(registry.validate("agents.runtime.cpu", { processors: 8, background: 4, resetAfterSeconds: 10 })).toMatch(/60 to 7200/);
    expect(registry.validate("agents.runtime.cpu", { processors: 8, background: 4, resetAfterSeconds: 600, unit: "sshd.service" })).toMatch(/unit/);
    expect(laneFor("agents.runtime.cpu", {})).toEqual(["agents:cpu"]);
  });
});

describe("the numbers", () => {
  it("are eight and four on the owner's server, and never take the last two processors", () => {
    expect(effectiveCores({}, { processors: 16 })).toEqual({ waiting: 8, background: 4, ceiling: 8 });
    expect(effectiveCores({ waiting: 6, background: 3 }, { processors: 16 })).toEqual({ waiting: 6, background: 3, ceiling: 8 });
    expect(effectiveCores({}, { processors: 8 })).toEqual({ waiting: 6, background: 4, ceiling: 6 });
    expect(effectiveCores({}, { processors: 4 })).toEqual({ waiting: 2, background: 2, ceiling: 2 });
    expect(effectiveCores({ waiting: 3, background: 6 }, { processors: 16 })).toEqual({ waiting: 3, background: 3, ceiling: 8 });
    // A thread a processor, never more threads than physical cores.
    expect([threadsFor(8, 8), threadsFor(8, 4), threadsFor(4, null)]).toEqual([8, 4, 4]);
  });
});

describe("the service", () => {
  let h;
  afterEach(async () => { await h?.close(); h = null; });
  const cpuCalls = () => h.helperCalls.filter((call) => call.operation === "agents.runtime.cpu").map((call) => call.parameters);

  it("gives a person's question eight processors and threads, then takes them back when nobody waits", async () => {
    h = await createAgentsHarness();
    h.enable();
    const keeper = h.service.createAgent(h.caller("owner"), { template: "server-keeper" });
    h.service.startRun(h.caller("owner"), keeper.id, { kind: "ask", question: "Is anything failing?" });
    const claim = await h.service.runnerNext(h.runnerId, { waitMs: 0 });
    // The quota was raised before the runner was handed the run, with a timer for its longest time.
    expect(cpuCalls()).toEqual([{ processors: 8, background: 4, resetAfterSeconds: 900 + 60 + 60 }]);
    expect(claim.runtime).toMatchObject({ threads: 8, cpu: { processors: 8, threads: 8, waiting: true } });
    await h.runner.execute(claim);
    const run = h.service.getRun(h.caller("owner"), claim.run.id);
    expect(run.steps.find((step) => step.name === "claimed").flags.detail).toBe("The runner took this run, with 8 processors and 8 model threads while you wait.");
    // Finished, and nothing else waits: back to four.
    await expect.poll(() => cpuCalls().length).toBe(2);
    expect(cpuCalls()[1]).toMatchObject({ processors: 4, background: 4 });
    expect(h.service.usage(h.caller("owner")).module.cores).toMatchObject({ waiting: 8, background: 4, ceiling: 8, processors: 16, physical: 8, now: { processors: 4, burst: false } });
  });

  it("keeps a schedule, an event and learning at four, and asks nothing when four is already set", async () => {
    h = await createAgentsHarness();
    h.enable();
    const keeper = h.service.createAgent(h.caller("owner"), { template: "server-keeper" });
    h.service.relearn(h.caller("owner"), keeper.id);
    h.setTime(new Date(2026, 8, 30, 3, 0, 0));
    const claim = await h.service.runnerNext(h.runnerId, { waitMs: 0 });
    expect(claim.run.kind).toBe("learn");
    expect(claim.runtime).toMatchObject({ threads: 4, cpu: { processors: 4, threads: 4, waiting: false } });
    expect(cpuCalls()).toEqual([{ processors: 4, background: 4, resetAfterSeconds: 1_020 }]);
    await h.runner.execute(claim);
    h.service.relearn(h.caller("owner"), keeper.id);
    const next = await h.service.runnerNext(h.runnerId, { waitMs: 0 });
    expect(next.runtime.threads).toBe(4);
    expect(cpuCalls()).toHaveLength(1);
  });

  it("runs a person's question at the background number's threads when the raise cannot be set, and says so", async () => {
    h = await createAgentsHarness();
    h.enable();
    h.helperAnswers["agents.runtime.cpu"] = () => { throw new Error("The helper is restarting"); };
    const keeper = h.service.createAgent(h.caller("owner"), { template: "server-keeper" });
    h.service.startRun(h.caller("owner"), keeper.id, { kind: "ask", question: "Is anything failing?" });
    const claim = await h.service.runnerNext(h.runnerId, { waitMs: 0 });
    expect(claim.runtime).toMatchObject({ threads: 4, cpu: { processors: 4, waiting: false } });
    const step = h.store.listSteps(claim.run.id).find((entry) => entry.name === "claimed");
    expect(step.flags.detail).toBe("The runner took this run. It could not be given 8 processors (The helper is restarting), so it runs with 4.");
  });

  it("runs no more model threads than the machine has physical cores", async () => {
    h = await createAgentsHarness({ serviceOptions: { processors: 16, physicalCoreCount: 6 } });
    h.enable();
    const keeper = h.service.createAgent(h.caller("owner"), { template: "server-keeper" });
    h.service.startRun(h.caller("owner"), keeper.id, { kind: "ask", question: "Is anything failing?" });
    const claim = await h.service.runnerNext(h.runnerId, { waitMs: 0 });
    expect(claim.runtime).toMatchObject({ threads: 6, cpu: { processors: 8, threads: 6 } });
  });

  it("takes the owner's two numbers with their bounds, and applies a new background number at once", async () => {
    h = await createAgentsHarness({ serviceOptions: { processors: 12, physicalCoreCount: 6 } });
    h.enable();
    expect(() => h.service.saveModule(h.caller("owner"), { cores: { waiting: 9 } })).toThrow(/Processors while you wait must be 2 to 8 on this server \(it has 12 processors, and two stay free\)/);
    expect(() => h.service.saveModule(h.caller("owner"), { cores: { waiting: 1 } })).toThrow(/must be 2 to 8/);
    expect(() => h.service.saveModule(h.caller("owner"), { cores: { waiting: 4, background: 6 } })).toThrow(/no more processors than a question someone waits on/);
    const saved = h.service.saveModule(h.caller("owner"), { cores: { waiting: 6, background: 3 } });
    expect(saved.module.cores).toMatchObject({ waiting: 6, background: 3, ceiling: 8 });
    await expect.poll(() => cpuCalls().at(-1)).toMatchObject({ processors: 3, background: 3 });
    expect(h.state.listAudit(50).find((event) => event.type === "settings.agents.changed").details.cores).toEqual({ waiting: 6, background: 3 });
    // A small machine: four processors leave two for agents.
    const small = await createAgentsHarness({ serviceOptions: { processors: 4, physicalCoreCount: 2 } });
    try {
      small.enable();
      expect(() => small.service.saveModule(small.caller("owner"), { cores: { waiting: 3 } })).toThrow(/must be 2 to 2/);
    } finally { await small.close(); }
  });

  it("takes a raise back after the kill switch, and at start after a restart", async () => {
    h = await createAgentsHarness();
    h.enable();
    const keeper = h.service.createAgent(h.caller("owner"), { template: "server-keeper" });
    h.service.startRun(h.caller("owner"), keeper.id, { kind: "ask", question: "Is anything failing?" });
    await h.service.runnerNext(h.runnerId, { waitMs: 0 });
    expect(cpuCalls().at(-1)).toMatchObject({ processors: 8 });
    h.service.killSwitch(h.caller("owner"));
    await expect.poll(() => cpuCalls().at(-1)).toMatchObject({ processors: 4 });
    const stop = h.service.start();
    await expect.poll(() => cpuCalls().length).toBe(3);
    stop();
  });
});
