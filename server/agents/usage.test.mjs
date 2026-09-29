// @vitest-environment node
import { describe, expect, it } from "vitest";
import { createUsageReader, parseCgroupPath, parseCpuMax, parseKeyed, parseProcStatBusy } from "./usage.mjs";

describe("reading the runner's own cgroup", () => {
  it("parses what the kernel writes", () => {
    expect(parseCgroupPath("0::/system.slice/boxpilot-agents.service\n")).toBe("/system.slice/boxpilot-agents.service");
    expect(parseKeyed("usage_usec 1500000\nuser_usec 1000\nnr_throttled 3\nthrottled_usec 20000\n")).toMatchObject({ usage_usec: 1_500_000, throttled_usec: 20_000 });
    expect(parseCpuMax("200000 100000\n")).toBe(200);
    expect(parseCpuMax("max 100000\n")).toBeNull();
    expect(parseProcStatBusy("cpu  100 0 50 800 50 0 0 0 0 0\ncpu0 1 2 3")).toEqual({ total: 1000, busy: 150 });
  });

  it("reports the service's processor share since the last read, its memory and its caps", async () => {
    let clock = 0;
    let used = 0;
    const files = () => ({
      "/proc/self/cgroup": "0::/system.slice/boxpilot-agents.service\n",
      "/sys/fs/cgroup/system.slice/boxpilot-agents.service/cpu.stat": `usage_usec ${used}\nthrottled_usec 5000\n`,
      "/sys/fs/cgroup/system.slice/boxpilot-agents.service/memory.current": "104857600\n",
      "/sys/fs/cgroup/system.slice/boxpilot-agents.service/memory.peak": "209715200\n",
      "/sys/fs/cgroup/system.slice/boxpilot-agents.service/cpu.max": "200000 100000\n",
      "/sys/fs/cgroup/system.slice/boxpilot-agents.service/memory.max": "8589934592\n",
    });
    const reader = createUsageReader({ readFile: async (file) => { const text = files()[file]; if (text === undefined) throw new Error("ENOENT"); return text; }, now: () => clock });
    expect(await reader.read()).toMatchObject({ cgroup: true, cpuPercent: 0, memoryBytes: 104_857_600, memoryPeakBytes: 209_715_200, cpuQuotaPercent: 200, memoryMaxBytes: 8_589_934_592, throttledMs: 5 });
    clock += 10_000;
    used += 20_000_000; // two processors' worth over ten seconds
    expect((await reader.read()).cpuPercent).toBe(200);
    clock += 10_000;
    used += 10_000; // idle: a hundredth of a percent
    expect((await reader.read()).cpuPercent).toBe(0.1);
  });

  it("falls back to its own process, and says so, where there is no cgroup to read", async () => {
    const reader = createUsageReader({ readFile: async () => { throw new Error("ENOENT"); }, processUsage: () => ({ cpu: { user: 0, system: 0 }, rss: 50e6 }) });
    expect(await reader.read()).toMatchObject({ cgroup: false, memoryBytes: 50e6, cpuQuotaPercent: null });
  });

  it("tells a busy server from a quiet one", async () => {
    const stats = ["cpu  100 0 0 900 0 0 0 0", "cpu  1000 0 0 1000 0 0 0 0", "cpu  1010 0 0 1990 0 0 0 0"];
    const reader = createUsageReader({ readFile: async (file) => { if (file !== "/proc/stat") throw new Error("ENOENT"); return stats.shift(); } });
    expect(await reader.hostBusy()).toBe(false);
    expect(await reader.hostBusy()).toBe(true);
    expect(await reader.hostBusy()).toBe(false);
  });
});
