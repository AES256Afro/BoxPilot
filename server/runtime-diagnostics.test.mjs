import { describe, expect, it, vi } from "vitest";
import { createRuntimeDiagnostics, cgroupDirectory, parsePressure } from "./runtime-diagnostics.mjs";

describe("low-cost process diagnostics", () => {
  it("separates file cache from process heap and preserves unavailable values", async () => {
    let clock = 0;
    let cpu = { user: 1000, system: 1000 };
    const readText = vi.fn(async (file) => {
      if (file === "/proc/self/cgroup") return "0::/system.slice/example.service\n";
      if (file.endsWith("memory.stat")) return "anon 1048576\nfile 4294967296\n";
      if (file.endsWith("memory.current")) return "4296015872\n";
      throw new Error("unavailable");
    });
    const diagnostics = createRuntimeDiagnostics({ readText, now: () => clock, eventLoop: () => ({ active: clock / 10, idle: clock * 0.9 }), processInfo: { cpuUsage: () => cpu, memoryUsage: () => ({ rss: 2000, heapUsed: 1000, external: 200 }), uptime: () => 100, getActiveResourcesInfo: () => ["Timeout", "Timeout"] } });
    const first = await diagnostics.inspect();
    expect(first.cgroup).toMatchObject({ fileCacheBytes: 4294967296, anonymousBytes: 1048576, oomKills: null });
    expect(first.processMemory.heapUsed).toBe(1000);
    expect(first.cpu.percentOfOneCore).toBeNull();
    expect(first.resources.Timeout).toBe(2);
    const calls = readText.mock.calls.length;
    await diagnostics.inspect(); expect(readText).toHaveBeenCalledTimes(calls);
    clock = 6000; cpu = { user: 601000, system: 1000 };
    const second = await diagnostics.inspect();
    expect(second.cpu.percentOfOneCore).toBe(10);
    expect(second.eventLoopBusyPercent).toBe(10);
    expect(second.pressure.memory).toBeNull();
  });
  it("supports unavailable cgroups without inventing zero counters", async () => {
    const diagnostics = createRuntimeDiagnostics({ readText: async () => { throw new Error("not Linux"); } });
    expect((await diagnostics.inspect()).cgroup).toMatchObject({ available: false, currentBytes: null, fileCacheBytes: null });
    expect(cgroupDirectory("0::/../../outside")).toBeNull();
    expect(cgroupDirectory("0::/system.slice/example.service")).toBe("/sys/fs/cgroup/system.slice/example.service");
    expect(parsePressure("some avg10=0.12 avg60=0.34 avg300=0.56 total=123\n")).toEqual({ some: { avg10: 0.12, avg60: 0.34, avg300: 0.56, totalMicroseconds: 123 } });
  });
});
