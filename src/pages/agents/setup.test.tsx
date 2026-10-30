import { cleanup, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { RuntimeState } from "./api";
import { capsWords, moduleVerdict, processorWords, waitingWords } from "./format";
import { chainSteps, runnerDetail, setupSteps } from "./setup";

const model = (extra: Record<string, unknown>) => ({
  id: "qwen3.5-4b", title: "Qwen 3.5 4B", repo: "unsloth/Qwen3.5-4B-GGUF", file: "Qwen3.5-4B-UD-Q4_K_XL.gguf", projector: "mmproj-F16.gguf", quant: "UD-Q4_K_XL", parameters: 4, memoryBytes: 6.2e9, contextTokens: 8192,
  tokensPerSecond: 4.2, vision: true, recommended: true, note: "", preview: { bytes: 3.58e9, fastMinutes: 2, slowMinutes: 12, memoryBytes: 6.2e9 }, fitsCap: true, downloaded: false, current: true, ...extra,
});
const caps = { cpuQuotaPercent: 100, cpuWeight: "idle", nice: 19, ioSchedulingClass: "idle", memoryMaxBytes: 8 * 1024 ** 3, memorySwapMaxBytes: 0, tasksMax: 256, modelThreads: 1, unit: "boxpilot-agents.service" };
const runtimeWith = ({ driver = "unsloth", unsloth = false, downloaded = false, active = "inactive" }: { driver?: RuntimeState["settings"]["driver"]; unsloth?: boolean; downloaded?: boolean; active?: string } = {}): RuntimeState => ({
  settings: { driver, repo: "unsloth/Qwen3.5-4B-GGUF", file: "Qwen3.5-4B-UD-Q4_K_XL.gguf" },
  library: [model({ downloaded })] as RuntimeState["library"],
  installed: { runtime: { installed: unsloth, path: "/var/lib/boxpilot-agents/unsloth/bin/unsloth" }, service: { unit: caps.unit, loaded: true, active, sub: "dead", enabled: "disabled" }, models: [], diskFreeBytes: 1e11 },
  unsloth: { version: null, installerSha256: null, installedAt: null, testedVersion: "2026.9.12" }, newer: null, checkedAt: null,
  runner: { online: false, lastSeenAt: null, version: null, startedAt: null, hostBusy: false, usage: null }, caps,
});
const ids = (runtime: RuntimeState | null, enabled = true) => setupSteps(runtime, { enabled })?.map((step) => step.id) ?? null;

describe("what is missing before an agent can run", () => {
  it("is Unsloth, then the model, then the runner, each left out once it is there", () => {
    expect(ids(runtimeWith())).toEqual(["install", "download", "enable"]);
    expect(ids(runtimeWith({ unsloth: true }))).toEqual(["download", "enable"]);
    expect(ids(runtimeWith({ unsloth: true, downloaded: true }))).toEqual(["enable"]);
    expect(ids(runtimeWith({ unsloth: true, downloaded: true, active: "active" }))).toEqual([]);
  });

  it("counts a failed unit as stopped, and one on its way up as up", () => {
    expect(ids(runtimeWith({ unsloth: true, downloaded: true, active: "failed" }))).toEqual(["enable"]);
    expect(ids(runtimeWith({ unsloth: true, downloaded: true, active: "activating" }))).toEqual([]);
  });

  it("needs neither Unsloth nor a download for a model server already on the machine", () => {
    expect(ids(runtimeWith({ driver: "external" }))).toEqual(["enable"]);
  });

  it("leaves the runner alone while Agents are off, and knows nothing when the runtime was not read", () => {
    expect(ids(runtimeWith(), false)).toEqual(["install", "download"]);
    expect(ids(null)).toBeNull();
    expect(ids({ ...runtimeWith(), installed: null })).toBeNull();
  });

  it("chains each step to the next, so each dialog offers the one after it", () => {
    const steps = setupSteps(runtimeWith(), { enabled: true })!;
    const chain = chainSteps(steps);
    expect([chain?.title, chain?.next?.title, chain?.next?.next?.title, chain?.next?.next?.next]).toEqual(["Install Unsloth for agents", "Download Qwen 3.5 4B", "Start the agents runner", undefined]);
    expect(chain?.next?.parameters).toEqual({ repo: "unsloth/Qwen3.5-4B-GGUF", file: "Qwen3.5-4B-UD-Q4_K_XL.gguf", projector: "mmproj-F16.gguf" });
    expect(chainSteps(steps, 2)?.operationId).toBe("agents.runtime.enable");
    expect(chainSteps([])).toBeNull();
  });
});

describe("the caps in words", () => {
  it("counts the processors a CPUQuota adds up to, from what the server reports", () => {
    expect([100, 400, 150, 800].map(processorWords)).toEqual(["one processor", "four processors", "1.5 processors", "eight processors"]);
    expect(capsWords({ cpuQuotaPercent: 400, memoryMaxBytes: 8 * 1024 ** 3 })).toBe("four processors at most, idle priority, 8 GiB");
    // M40: the raised number while someone waits, when there is one.
    expect(capsWords({ cpuQuotaPercent: 400, waitingQuotaPercent: 800, memoryMaxBytes: 8 * 1024 ** 3 })).toBe("four processors at most, eight while you wait, idle priority, 8 GiB");
    expect(capsWords({ cpuQuotaPercent: 200, waitingQuotaPercent: 200 })).toBe("two processors at most, idle priority");
    expect(capsWords(null)).toBe("capped processors and memory, idle priority");
  });

  it("starts the runner with the caps it reports, whatever they are", () => {
    const runtime = { ...runtimeWith({ unsloth: true, downloaded: true }), caps: { ...caps, cpuQuotaPercent: 400, modelThreads: 4 } };
    const [enable] = setupSteps(runtime, { enabled: true })!;
    render(<>{enable.operation.preview}</>);
    expect(screen.getByText("boxpilot-agents.service: four processors at most, idle priority, 8 GiB, this machine only.")).toBeTruthy();
    cleanup();
  });
});

describe("what the page says about a runner that is not answering", () => {
  const on = { enabled: true, paused: false, pausedUntil: null, killedAt: null, quietHours: { start: "02:00", end: "06:00" }, inQuietHours: false, notify: true };

  it("says it is stopped, and what is missing when that is known", () => {
    expect(moduleVerdict(on, false, 0)).toMatchObject({ status: "warning", label: "Runner stopped", sentence: "Agents are on, but the runner is stopped, so nothing runs." });
    const runtime = runtimeWith({ unsloth: true });
    expect(moduleVerdict(on, false, 0, runnerDetail(runtime, setupSteps(runtime, { enabled: true }))).sentence).toBe("Agents are on, but nothing runs until the model is downloaded and the runner is started.");
    expect(waitingWords(false)).toBe("Waiting for the runner, which is stopped");
  });

  it("says a running unit whose runner is silent is not answering, rather than stopped", () => {
    const runtime = runtimeWith({ unsloth: true, downloaded: true, active: "active" });
    const detail = runnerDetail(runtime, setupSteps(runtime, { enabled: true }));
    expect(moduleVerdict(on, false, 0, detail)).toMatchObject({ label: "Runner not answering" });
    expect(waitingWords(false, detail)).toBe("Waiting for the runner, which is not answering");
  });

  it("leads with a pause or the switch being off, and says nothing of the runner while it answers", () => {
    expect(moduleVerdict({ ...on, paused: true }, false, 0).label).toBe("Paused");
    expect(moduleVerdict({ ...on, enabled: false }, false, 0).label).toBe("Off");
    expect(moduleVerdict(on, true, 0).label).toBe("Running cool");
    expect(waitingWords(true)).toMatch(/^Waiting for the runner: one run goes at a time/);
  });
});
