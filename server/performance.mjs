/**
 * A live snapshot of how hard this machine is working, for the Performance page.
 *
 * Everything here is read straight from the kernel — `/proc`, `/sys`, and `os` — so it is cheap
 * enough to poll every few seconds and needs nothing privileged. CPU utilisation is the one figure
 * that cannot come from a single read: it is the share of busy time *between two samples*, so the
 * service remembers the last `/proc/stat` and reports the delta. The first call after a restart has
 * no baseline and returns `null` for usage rather than a made-up number.
 */
import os from "node:os";
import { readFile, statfs } from "node:fs/promises";
import { readdir } from "node:fs/promises";

/** Parse the aggregate and per-core lines of /proc/stat into busy/total tick counts. */
export function parseProcStat(text) {
  const cpus = {};
  for (const line of String(text ?? "").split("\n")) {
    const match = /^(cpu\d*)\s+(.*)$/.exec(line.trim());
    if (!match) continue;
    const fields = match[2].split(/\s+/).map(Number);
    // user nice system idle iowait irq softirq steal ...
    const [user = 0, nice = 0, system = 0, idle = 0, iowait = 0, irq = 0, softirq = 0, steal = 0] = fields;
    const total = user + nice + system + idle + iowait + irq + softirq + steal;
    const busy = total - (idle + iowait);
    cpus[match[1]] = { total, busy };
  }
  return cpus;
}

/** kB-valued keys from /proc/meminfo, as bytes. */
export function parseMeminfo(text) {
  const out = {};
  for (const line of String(text ?? "").split("\n")) {
    const match = /^(\w+):\s+(\d+)\s*kB$/.exec(line.trim());
    if (match) out[match[1]] = Number(match[2]) * 1024;
  }
  return out;
}

const percent = (part, whole) => (whole > 0 ? Math.round((part / whole) * 1000) / 10 : 0);

export function createPerformanceService({
  readProc = (name) => readFile(`/proc/${name}`, "utf8"),
  hwmonRoot = "/sys/class/hwmon",
  listDir = (dir) => readdir(dir),
  readSys = (path) => readFile(path, "utf8"),
  statFilesystem = (path) => statfs(path),
  loadavg = () => os.loadavg(),
  cpus = () => os.cpus(),
  uptime = () => os.uptime(),
  now = () => new Date(),
} = {}) {
  let previous = null;     // last /proc/stat sample, for the utilisation delta
  let lastComputed = null;  // the last usable answer, to repeat rather than invent a bad one

  /**
   * CPU busy-share since the previous call, overall and per core. Null until there are two samples.
   *
   * The samples are shared by every caller, which matters once two browser tabs poll at once: their
   * calls interleave and the window between two samples can collapse to almost nothing. Over a
   * near-zero window the tick counters have not moved, which reads as 0% — a wrong answer that
   * looks like an idle machine. Below a usable window the previous answer is repeated instead.
   */
  async function cpuUsage() {
    let current;
    try { current = parseProcStat(await readProc("stat")); } catch { return lastComputed ?? { usagePercent: null, perCore: [] }; }
    const last = previous;
    if (last?.cpu && current.cpu && current.cpu.total - last.cpu.total < 20 && lastComputed) return lastComputed;
    previous = current;
    if (!last || !last.cpu || !current.cpu) return { usagePercent: null, perCore: [] };
    const share = (a, b) => {
      const totalDelta = b.total - a.total;
      const busyDelta = b.busy - a.busy;
      return totalDelta > 0 ? Math.max(0, Math.min(100, Math.round((busyDelta / totalDelta) * 1000) / 10)) : 0;
    };
    const perCore = [];
    for (let index = 0; current[`cpu${index}`] && last[`cpu${index}`]; index += 1) {
      perCore.push(share(last[`cpu${index}`], current[`cpu${index}`]));
    }
    lastComputed = { usagePercent: share(last.cpu, current.cpu), perCore };
    return lastComputed;
  }

  /** Whatever temperatures the board exposes through hwmon, best-effort. */
  async function temperatures() {
    const readings = [];
    let entries = [];
    try { entries = await listDir(hwmonRoot); } catch { return readings; }
    for (const entry of entries) {
      const base = `${hwmonRoot}/${entry}`;
      let chip = entry;
      try { chip = (await readSys(`${base}/name`)).trim() || entry; } catch { /* keep the dir name */ }
      let files = [];
      try { files = await listDir(base); } catch { continue; }
      for (const file of files.filter((name) => /^temp\d+_input$/.test(name))) {
        try {
          const milli = Number((await readSys(`${base}/${file}`)).trim());
          if (!Number.isFinite(milli)) continue;
          let label = `${chip} ${file.replace("_input", "")}`;
          try { label = `${chip}: ${(await readSys(`${base}/${file.replace("_input", "_label")}`)).trim()}`; } catch { /* no label file */ }
          readings.push({ label, celsius: Math.round(milli / 100) / 10 });
        } catch { /* skip this sensor */ }
      }
    }
    return readings;
  }

  /** Usage of every real, non-duplicate mounted filesystem. */
  async function disks() {
    const realTypes = new Set(["ext4", "ext3", "ext2", "xfs", "btrfs", "vfat", "zfs", "f2fs", "ntfs", "exfat"]);
    let mounts = "";
    try { mounts = await readProc("mounts"); } catch { return []; }
    const seen = new Set();
    const out = [];
    for (const line of mounts.split("\n")) {
      const [source, mount, fstype] = line.split(/\s+/);
      if (!mount || !realTypes.has(fstype) || seen.has(source)) continue;
      seen.add(source);
      try {
        const fs = await statFilesystem(mount);
        const totalBytes = fs.blocks * fs.bsize;
        const availableBytes = fs.bavail * fs.bsize;
        const usedBytes = (fs.blocks - fs.bfree) * fs.bsize;
        if (totalBytes > 0) out.push({ mount, fstype, totalBytes, usedBytes, availableBytes, usedPercent: percent(usedBytes, totalBytes) });
      } catch { /* unmounted mid-read, skip */ }
    }
    return out.sort((a, b) => (a.mount === "/" ? -1 : b.mount === "/" ? 1 : b.totalBytes - a.totalBytes));
  }

  async function snapshot() {
    const [cpu, temps, mountUsage, meminfo] = await Promise.all([
      cpuUsage(),
      temperatures(),
      disks(),
      readProc("meminfo").then(parseMeminfo).catch(() => ({})),
    ]);
    const cores = cpus();
    const load = loadavg();
    const totalMemoryBytes = meminfo.MemTotal ?? os.totalmem();
    const availableMemoryBytes = meminfo.MemAvailable ?? os.freemem();
    const usedMemoryBytes = Math.max(0, totalMemoryBytes - availableMemoryBytes);
    const swapTotalBytes = meminfo.SwapTotal ?? 0;
    const swapUsedBytes = Math.max(0, swapTotalBytes - (meminfo.SwapFree ?? 0));
    return {
      generatedAt: now().toISOString(),
      cpu: {
        model: cores[0]?.model?.trim() ?? "unknown",
        cores: cores.length,
        usagePercent: cpu.usagePercent,
        perCore: cpu.perCore,
        load1: load[0], load5: load[1], load15: load[2],
        loadPercent: cores.length ? Math.min(100, Math.round((load[0] / cores.length) * 100)) : 0,
      },
      memory: { totalBytes: totalMemoryBytes, usedBytes: usedMemoryBytes, availableBytes: availableMemoryBytes, usedPercent: percent(usedMemoryBytes, totalMemoryBytes) },
      swap: { totalBytes: swapTotalBytes, usedBytes: swapUsedBytes, usedPercent: percent(swapUsedBytes, swapTotalBytes) },
      uptimeSeconds: Math.floor(uptime()),
      temps,
      disks: mountUsage,
    };
  }

  return { snapshot };
}
