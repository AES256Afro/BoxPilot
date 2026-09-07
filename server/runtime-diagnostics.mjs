import { readFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { shared } from "./cache.mjs";
import { productVersion } from "./version.mjs";

/** Kernel counters only; no process command lines, environment, logs or user paths are returned. */
export function parseCounters(text) {
  return Object.fromEntries(String(text ?? "").split("\n").map((line) => line.trim().split(/\s+/, 2)).filter(([key, value]) => /^[a-z_]+$/.test(key) && /^\d+$/.test(value ?? "")).map(([key, value]) => [key, Number(value)]));
}
export function parsePressure(text) {
  const result = {};
  for (const line of String(text ?? "").split("\n")) {
    const match = line.match(/^(some|full) avg10=([\d.]+) avg60=([\d.]+) avg300=([\d.]+) total=(\d+)$/);
    if (match) result[match[1]] = { avg10: Number(match[2]), avg60: Number(match[3]), avg300: Number(match[4]), totalMicroseconds: Number(match[5]) };
  }
  return Object.keys(result).length ? result : null;
}
export function cgroupDirectory(text) {
  const raw = String(text ?? "").split("\n").find((line) => line.startsWith("0::"))?.slice(3);
  if (!raw?.startsWith("/") || raw.split("/").includes("..")) return null;
  return path.join("/sys/fs/cgroup", raw);
}

export function createRuntimeDiagnostics({
  readText = (file) => readFile(file, "utf8"),
  processInfo = process,
  now = () => Date.now(),
  eventLoop = () => performance.eventLoopUtilization(),
  ttlMs = 5000,
} = {}) {
  let previous = null;
  const read = (file) => readText(file).catch(() => null);
  const inspect = shared(async () => {
    const at = now();
    const usage = processInfo.cpuUsage();
    const loop = eventLoop();
    const elapsedMs = previous ? at - previous.at : null;
    const cpuPercent = elapsedMs > 0 ? Math.max(0, ((usage.user + usage.system) - (previous.cpu.user + previous.cpu.system)) / (elapsedMs * 10)) : null;
    const loopDelta = previous ? (loop.active + loop.idle) - (previous.loop.active + previous.loop.idle) : 0;
    const eventLoopBusyPercent = loopDelta > 0 ? Math.max(0, Math.min(100, (loop.active - previous.loop.active) / loopDelta * 100)) : null;
    previous = { at, cpu: usage, loop };
    const directory = cgroupDirectory(await read("/proc/self/cgroup"));
    const [memoryText, currentText, eventsText, cpuPressure, memoryPressure, ioPressure] = await Promise.all([
      directory ? read(path.join(directory, "memory.stat")) : null,
      directory ? read(path.join(directory, "memory.current")) : null,
      directory ? read(path.join(directory, "memory.events")) : null,
      read("/proc/pressure/cpu"), read("/proc/pressure/memory"), read("/proc/pressure/io"),
    ]);
    const memory = parseCounters(memoryText);
    const events = parseCounters(eventsText);
    const resources = {};
    for (const name of processInfo.getActiveResourcesInfo?.() ?? []) resources[name] = (resources[name] ?? 0) + 1;
    return {
      checkedAt: new Date(at).toISOString(), version: productVersion,
      uptimeSeconds: processInfo.uptime(), processMemory: processInfo.memoryUsage(),
      cpu: { totalMicroseconds: usage.user + usage.system, percentOfOneCore: cpuPercent, intervalMs: elapsedMs },
      eventLoopBusyPercent, resources,
      cgroup: { available: memoryText !== null, currentBytes: /^\d+\s*$/.test(currentText ?? "") ? Number(currentText) : null, anonymousBytes: memory.anon ?? null, fileCacheBytes: memory.file ?? null, kernelBytes: memory.kernel ?? null, oomKills: events.oom_kill ?? null },
      pressure: { cpu: parsePressure(cpuPressure), memory: parsePressure(memoryPressure), io: parsePressure(ioPressure) },
    };
  }, { ttlMs, now });
  return { inspect, cacheStats: () => inspect.stats() };
}

export const runtimeDiagnostics = createRuntimeDiagnostics();
