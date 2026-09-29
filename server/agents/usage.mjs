/**
 * How hard the agents runner is working (M37), read by the runner itself from its own cgroup: the
 * processor time and memory of everything in boxpilot-agents.service - the runner and the model
 * server it started - and the caps systemd holds it to (cpu.max, memory.max). The Usage panel shows
 * these, so the owner sees at a glance that it runs cool, from the kernel's own counters.
 *
 * Also the host's load, for the self-throttle: when the whole server is busy, the runner takes
 * only people's questions and leaves schedules and learning for later.
 *
 * Off Linux, or where the cgroup cannot be read, it falls back to this process's own counters and
 * says so (`cgroup: false`), rather than showing a figure that looks like the whole service's.
 */
import { readFile as fsReadFile } from "node:fs/promises";

export function parseCgroupPath(text) {
  const line = String(text ?? "").split("\n").find((entry) => entry.startsWith("0::"));
  return line ? line.slice(3).trim() : null;
}

export function parseKeyed(text) {
  const values = {};
  for (const line of String(text ?? "").split("\n")) {
    const [key, value] = line.trim().split(/\s+/);
    if (key && value !== undefined && /^\d+$/.test(value)) values[key] = Number(value);
  }
  return values;
}

/** cpu.max ("200000 100000", or "max 100000") as a percent of one processor, or null for no cap. */
export function parseCpuMax(text) {
  const [quota, period] = String(text ?? "").trim().split(/\s+/);
  if (!quota || quota === "max" || !Number(period)) return null;
  return Math.round((Number(quota) / Number(period)) * 100);
}

export function parseProcStatBusy(text) {
  const line = String(text ?? "").split("\n").find((entry) => entry.startsWith("cpu "));
  if (!line) return null;
  const [user = 0, nice = 0, system = 0, idle = 0, iowait = 0, irq = 0, softirq = 0, steal = 0] = line.trim().split(/\s+/).slice(1).map(Number);
  const total = user + nice + system + idle + iowait + irq + softirq + steal;
  return { total, busy: total - idle - iowait };
}

export function createUsageReader({
  readFile = (file) => fsReadFile(file, "utf8"),
  cgroupRoot = "/sys/fs/cgroup",
  now = () => Date.now(),
  busyThreshold = 0.8,
  processUsage = () => ({ cpu: process.cpuUsage(), rss: process.memoryUsage().rss }),
} = {}) {
  let directory;
  let previous = null;
  let previousHost = null;

  async function cgroupDirectory() {
    if (directory !== undefined) return directory;
    const relative = await readFile("/proc/self/cgroup").then(parseCgroupPath).catch(() => null);
    directory = relative ? `${cgroupRoot}${relative === "/" ? "" : relative}` : null;
    return directory;
  }

  async function sampleCgroup(dir) {
    const [cpu, current, peak, cpuMax, memoryMax] = await Promise.all([
      readFile(`${dir}/cpu.stat`).then(parseKeyed),
      readFile(`${dir}/memory.current`).then((text) => Number(text.trim())),
      readFile(`${dir}/memory.peak`).then((text) => Number(text.trim())).catch(() => null),
      readFile(`${dir}/cpu.max`).then(parseCpuMax).catch(() => null),
      readFile(`${dir}/memory.max`).then((text) => (text.trim() === "max" ? null : Number(text.trim()))).catch(() => null),
    ]);
    if (!Number.isFinite(cpu.usage_usec) || !Number.isFinite(current)) throw new Error("unreadable");
    return { usageUsec: cpu.usage_usec, throttledUsec: cpu.throttled_usec ?? 0, memoryBytes: current, memoryPeakBytes: peak, cpuQuotaPercent: cpuMax, memoryMaxBytes: memoryMax };
  }

  /** The service's processor share since the last read (percent of one processor), memory, and caps. */
  async function read() {
    const at = now();
    const dir = await cgroupDirectory();
    let sample = null;
    if (dir) sample = await sampleCgroup(dir).catch(() => null);
    const cgroup = Boolean(sample);
    if (!sample) {
      const own = processUsage();
      sample = { usageUsec: own.cpu.user + own.cpu.system, throttledUsec: 0, memoryBytes: own.rss, memoryPeakBytes: null, cpuQuotaPercent: null, memoryMaxBytes: null };
    }
    const last = previous;
    previous = { at, ...sample };
    const elapsedUsec = last ? (at - last.at) * 1000 : 0;
    const cpuPercent = last && elapsedUsec > 0 ? Math.max(0, ((sample.usageUsec - last.usageUsec) / elapsedUsec) * 100) : 0;
    return {
      cgroup,
      cpuPercent: Math.round(cpuPercent * 10) / 10,
      memoryBytes: sample.memoryBytes,
      memoryPeakBytes: sample.memoryPeakBytes,
      cpuQuotaPercent: sample.cpuQuotaPercent,
      memoryMaxBytes: sample.memoryMaxBytes,
      throttledMs: Math.round((sample.throttledUsec ?? 0) / 1000),
    };
  }

  /** Whether the whole server has been busy since the last look: the self-throttle's question. */
  async function hostBusy() {
    const current = await readFile("/proc/stat").then(parseProcStatBusy).catch(() => null);
    const last = previousHost;
    previousHost = current;
    if (!current || !last || current.total <= last.total) return false;
    return (current.busy - last.busy) / (current.total - last.total) > busyThreshold;
  }

  return { read, hostBusy, cgroupDirectory };
}
