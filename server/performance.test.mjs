import { describe, it, expect } from "vitest";
import { createPerformanceService, parseProcStat, parseMeminfo } from "./performance.mjs";

describe("reading kernel counters", () => {
  it("splits /proc/stat into busy and total ticks per core", () => {
    const parsed = parseProcStat("cpu  100 0 50 800 50 0 0 0\ncpu0 60 0 30 400 10 0 0 0\nintr 1 2 3");
    expect(parsed.cpu).toEqual({ total: 1000, busy: 150 }); // busy = total 1000 - (idle 800 + iowait 50)
    expect(parsed.cpu0.total).toBe(500);
    expect(parsed.intr).toBeUndefined(); // only cpu lines
  });

  it("reads /proc/meminfo kB values as bytes", () => {
    const mem = parseMeminfo("MemTotal:       32000000 kB\nMemAvailable:   24000000 kB\nSwapTotal: 4000000 kB\nSwapFree: 4000000 kB");
    expect(mem.MemTotal).toBe(32000000 * 1024);
    expect(mem.MemAvailable).toBe(24000000 * 1024);
  });
});

describe("the performance snapshot", () => {
  function service(overrides = {}) {
    const proc = {
      // first sample idle-heavy, second sample busier, so the delta shows real load
      stat: ["cpu 100 0 50 800 50 0 0 0\ncpu0 100 0 50 800 50 0 0 0", "cpu 220 0 110 860 60 0 0 0\ncpu0 220 0 110 860 60 0 0 0"],
      meminfo: "MemTotal: 32000000 kB\nMemAvailable: 8000000 kB\nSwapTotal: 4000000 kB\nSwapFree: 3000000 kB",
      mounts: "/dev/root / ext4 rw 0 0\ntmpfs /run tmpfs rw 0 0\n/dev/root /snap ext4 rw 0 0",
    };
    let statCall = 0;
    return createPerformanceService({
      readProc: async (name) => (name === "stat" ? proc.stat[Math.min(statCall++, proc.stat.length - 1)] : proc[name]),
      listDir: async (dir) => (dir.endsWith("hwmon") ? ["hwmon0"] : ["temp1_input", "temp1_label", "name"]),
      readSys: async (path) => (path.endsWith("/name") ? "k10temp" : path.endsWith("_label") ? "Tctl" : "52000"),
      statFilesystem: async () => ({ blocks: 1000, bsize: 4096, bfree: 400, bavail: 400 }),
      loadavg: () => [4, 3, 2],
      cpus: () => Array.from({ length: 16 }, () => ({ model: "AMD Ryzen 7 7800X3D" })),
      uptime: () => 123456,
      now: () => new Date("2026-08-25T00:00:00.000Z"),
      ...overrides,
    });
  }

  it("reports null CPU usage on the first call, then a real delta on the second", async () => {
    const perf = service();
    const first = await perf.snapshot();
    expect(first.cpu.usagePercent).toBeNull(); // no baseline yet
    const second = await perf.snapshot();
    // busy delta 180 over total delta 250 → 72%
    expect(second.cpu.usagePercent).toBeGreaterThan(60);
    expect(second.cpu.usagePercent).toBeLessThan(80);
    expect(second.cpu.perCore).toHaveLength(1);
  });

  it("computes memory and swap from meminfo, not just os totals", async () => {
    const snap = await service().snapshot();
    expect(snap.memory.totalBytes).toBe(32000000 * 1024);
    expect(snap.memory.usedBytes).toBe((32000000 - 8000000) * 1024);
    expect(snap.memory.usedPercent).toBe(75);
    expect(snap.swap.usedBytes).toBe((4000000 - 3000000) * 1024);
  });

  it("surfaces temperatures and de-duplicates disks by device", async () => {
    const snap = await service().snapshot();
    expect(snap.temps).toEqual([{ label: "k10temp: Tctl", celsius: 52 }]);
    expect(snap.disks).toHaveLength(1); // /dev/root mounted twice, counted once; tmpfs ignored
    expect(snap.disks[0].mount).toBe("/");
    expect(snap.disks[0].usedPercent).toBe(60);
  });

  it("survives a machine that exposes no hwmon or /proc at all", async () => {
    const bare = service({
      readProc: async () => { throw new Error("no /proc"); },
      listDir: async () => { throw new Error("no hwmon"); },
    });
    const snap = await bare.snapshot();
    expect(snap.temps).toEqual([]);
    expect(snap.disks).toEqual([]);
    expect(snap.cpu.usagePercent).toBeNull();
    expect(snap.memory.totalBytes).toBeGreaterThan(0); // falls back to os.totalmem()
  });
});
