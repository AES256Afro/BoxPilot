import { describe, expect, it, vi } from "vitest";
import { validateParameters } from "./registry.mjs";
import { parseMeminfo, parseSwaps, systemOperations } from "./system.mjs";

const operations = Object.fromEntries(systemOperations().map((operation) => [operation.id, operation]));

describe("system operations", () => {
  it("parses /proc/swaps and /proc/meminfo", () => {
    expect(parseSwaps("Filename\tType\tSize\t\tUsed\tPriority\n/swap.img                               file\t\t4194300\t\t1024\t\t-2\n"))
      .toEqual([{ device: "/swap.img", type: "file", sizeKiB: 4194300, usedKiB: 1024, priority: -2 }]);
    expect(parseSwaps("Filename\tType\tSize\tUsed\tPriority\n")).toEqual([]);
    expect(parseMeminfo("MemTotal:       32768000 kB\nMemAvailable:   16384000 kB\nSwapTotal:       4194300 kB\nSwapFree:        4193276 kB\nDirty:  12 kB\n"))
      .toEqual({ memTotalKiB: 32768000, memAvailableKiB: 16384000, swapTotalKiB: 4194300, swapFreeKiB: 4193276 });
  });

  it("stages hostname, timezone, and swappiness changes as root tasks with exact payloads", async () => {
    const runUnit = { runTask: vi.fn(async () => ({ ok: true })) };
    await operations["system.hostname.set"].run({ hostname: "shiny-box" }, { runUnit, jobLog: null });
    expect(runUnit.runTask).toHaveBeenCalledWith("system.hostname", { hostname: "shiny-box" }, expect.objectContaining({ timeoutMs: 60_000 }));
    await operations["system.timezone.set"].run({ timezone: "Europe/Berlin" }, { runUnit, jobLog: null });
    expect(runUnit.runTask).toHaveBeenCalledWith("system.timezone", { timezone: "Europe/Berlin" }, expect.objectContaining({ timeoutMs: 60_000 }));
    await operations["system.swappiness.set"].run({ value: 10 }, { runUnit, jobLog: null });
    expect(runUnit.runTask).toHaveBeenCalledWith("system.swappiness", { value: 10 }, expect.objectContaining({ timeoutMs: 60_000 }));
  });

  it("rejects malformed parameters at the registry boundary", () => {
    expect(validateParameters(operations["system.hostname.set"].parameters, { hostname: "ok-name" }, "t")).toBeNull();
    expect(validateParameters(operations["system.hostname.set"].parameters, { hostname: "Bad Name" }, "t")).toContain("invalid value");
    expect(validateParameters(operations["system.timezone.set"].parameters, { timezone: "America/Argentina/Buenos_Aires" }, "t")).toBeNull();
    expect(validateParameters(operations["system.timezone.set"].parameters, { timezone: "../zoneinfo" }, "t")).toContain("invalid value");
    expect(validateParameters(operations["system.swappiness.set"].parameters, { value: 55 }, "t")).toBeNull();
    expect(validateParameters(operations["system.swappiness.set"].parameters, { value: 500 }, "t")).toContain("between 0 and 100");
  });
});
