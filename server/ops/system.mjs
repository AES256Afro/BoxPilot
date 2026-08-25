import { readFile, readlink } from "node:fs/promises";
import { defineOperation } from "./registry.mjs";
import { hostnamePattern, timezonePattern } from "../tasks/system.mjs";

const systemctl = process.env.BOXPILOT_SYSTEMCTL_BINARY ?? "/usr/bin/systemctl";
const timedatectl = "/usr/bin/timedatectl";

/** Parse /proc/swaps: header line then `Filename Type Size Used Priority` (sizes in KiB). */
export function parseSwaps(content) {
  return String(content ?? "").split("\n").slice(1).filter(Boolean).map((line) => {
    const [filename, type, size, used, priority] = line.split(/\s+/);
    return { device: filename, type, sizeKiB: Number(size) || 0, usedKiB: Number(used) || 0, priority: Number(priority) || 0 };
  });
}

/** Pull selected `Key: value kB` fields out of /proc/meminfo. */
export function parseMeminfo(content) {
  const fields = {};
  for (const line of String(content ?? "").split("\n")) {
    const match = line.match(/^(MemTotal|MemAvailable|SwapTotal|SwapFree):\s+(\d+)\s*kB/);
    if (match) fields[match[1]] = Number(match[2]);
  }
  return { memTotalKiB: fields.MemTotal ?? null, memAvailableKiB: fields.MemAvailable ?? null, swapTotalKiB: fields.SwapTotal ?? null, swapFreeKiB: fields.SwapFree ?? null };
}

async function readText(path) {
  try { return (await readFile(path, "utf8")).trim(); } catch { return null; }
}

export function systemOperations() {
  return [
    defineOperation({
      id: "system.reboot", title: "Reboot the server", risk: "high", timeoutMs: 60_000,
      description: "Schedules a reboot in a few seconds. Running VMs and containers stop; BoxPilot comes back when the host does.",
      parameters: { fields: { delaySeconds: { type: "number", optional: true, validate: (value) => (Number.isInteger(value) && value >= 2 && value <= 300 ? null : "must be a whole number of seconds between 2 and 300") } } },
      run: (parameters, { runUnit, jobLog }) => runUnit.runTask("system.reboot", { delaySeconds: parameters.delaySeconds ?? 5 }, { timeoutMs: 30_000, logPath: jobLog?.path ?? null }),
    }),
    defineOperation({
      id: "system.settings.inspect", title: "Read system settings", risk: "low", readOnly: true, timeoutMs: 60_000,
      description: "Hostname, time zone, memory and swap, swappiness, and the fstrim timer state.",
      run: async (_parameters, { run }) => {
        const [staticHostname, liveHostname, swappiness, swaps, meminfo] = await Promise.all([
          readText("/etc/hostname"), readText("/proc/sys/kernel/hostname"), readText("/proc/sys/vm/swappiness"), readText("/proc/swaps"), readText("/proc/meminfo"),
        ]);
        let timezone = null;
        try { timezone = (await readlink("/etc/localtime")).replace(/^.*zoneinfo\//, ""); } catch { timezone = null; }
        const show = await run(systemctl, ["show", "fstrim.timer", "--property=ActiveState,UnitFileState,NextElapseUSecRealtime"], { timeout: 15_000 });
        const timer = Object.fromEntries(show.stdout.split("\n").map((line) => line.split("=", 2)).filter((pair) => pair.length === 2));
        const zones = await run(timedatectl, ["list-timezones"], { timeout: 15_000, maxBuffer: 2 * 1024 * 1024 });
        const localeDefault = await readText("/etc/default/locale");
        const locales = await run("/usr/bin/locale", ["-a"], { timeout: 15_000, maxBuffer: 2 * 1024 * 1024 });
        return {
          hostname: { static: staticHostname, live: liveHostname },
          timezone,
          timezones: zones.ok ? zones.stdout.split("\n").filter((zone) => timezonePattern.test(zone)) : [],
          locale: localeDefault?.match(/^LANG="?([^"\n]+)"?/m)?.[1] ?? null,
          locales: locales.ok ? locales.stdout.split("\n").map((line) => line.trim()).filter(Boolean) : [],
          swappiness: swappiness === null ? null : Number(swappiness),
          swap: parseSwaps(swaps),
          memory: parseMeminfo(meminfo),
          fstrim: { active: timer.ActiveState ?? null, enabled: timer.UnitFileState ?? null, nextRun: timer.NextElapseUSecRealtime || null },
        };
      },
    }),
    defineOperation({
      id: "system.locale.set", title: "Change the system language", risk: "medium", timeoutMs: 60_000,
      description: "Sets LANG to an already-generated locale with update-locale. New sessions and restarted services pick it up.",
      parameters: { fields: { locale: { type: "string", maxLength: 32, pattern: /^[A-Za-z][A-Za-z0-9_.@-]{1,31}$/ } } },
      run: (parameters, { runUnit, jobLog }) => runUnit.runTask("system.locale", { locale: parameters.locale }, { timeoutMs: 45_000, logPath: jobLog?.path ?? null }),
    }),
    defineOperation({
      id: "system.hostname.set", title: "Rename this server", risk: "medium", timeoutMs: 2 * 60_000,
      description: "Sets the hostname with hostnamectl and updates the 127.0.1.1 entry in /etc/hosts.",
      parameters: { fields: { hostname: { type: "string", maxLength: 253, pattern: hostnamePattern } } },
      run: (parameters, { runUnit, jobLog }) => runUnit.runTask("system.hostname", { hostname: parameters.hostname }, { timeoutMs: 60_000, logPath: jobLog?.path ?? null }),
    }),
    defineOperation({
      id: "system.timezone.set", title: "Change the time zone", risk: "medium", timeoutMs: 2 * 60_000,
      description: "Sets the system time zone with timedatectl. Timestamps in logs and schedules follow it.",
      parameters: { fields: { timezone: { type: "string", maxLength: 64, pattern: timezonePattern } } },
      run: (parameters, { runUnit, jobLog }) => runUnit.runTask("system.timezone", { timezone: parameters.timezone }, { timeoutMs: 60_000, logPath: jobLog?.path ?? null }),
    }),
    defineOperation({
      id: "system.swappiness.set", title: "Set swap pressure", risk: "medium", timeoutMs: 2 * 60_000,
      description: "Applies vm.swappiness now and persists it in /etc/sysctl.d/99-boxpilot.conf.",
      parameters: { fields: { value: { type: "number", validate: (value) => (Number.isInteger(value) && value >= 0 && value <= 100 ? null : "must be a whole number between 0 and 100") } } },
      run: (parameters, { runUnit, jobLog }) => runUnit.runTask("system.swappiness", { value: parameters.value }, { timeoutMs: 60_000, logPath: jobLog?.path ?? null }),
    }),
    defineOperation({
      id: "docker.disk.inspect", title: "Read Docker disk use", risk: "low", readOnly: true, timeoutMs: 60_000,
      description: "docker system df plus the daemon's logging configuration from /etc/docker/daemon.json.",
      run: async (_parameters, { run }) => {
        const docker = process.env.BOXPILOT_DOCKER_BINARY ?? "/usr/bin/docker";
        const result = await run(docker, ["system", "df", "--format", "json"], { timeout: 45_000, maxBuffer: 2 * 1024 * 1024 });
        let logging = { configured: false, logDriver: null, maxSize: null, liveRestore: false };
        try {
          const daemon = JSON.parse(await readFile("/etc/docker/daemon.json", "utf8"));
          logging = { configured: Boolean(daemon["log-opts"]?.["max-size"]), logDriver: daemon["log-driver"] ?? null, maxSize: daemon["log-opts"]?.["max-size"] ?? null, liveRestore: Boolean(daemon["live-restore"]) };
        } catch { /* no daemon.json means docker defaults: unbounded json-file logs */ }
        if (!result.ok) return { available: false, rows: [], logging };
        const rows = result.stdout.split("\n").filter(Boolean).map((line) => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean)
          .map((entry) => ({ type: entry.Type, total: entry.TotalCount ?? entry.Total ?? null, active: entry.Active ?? null, size: entry.Size ?? null, reclaimable: entry.Reclaimable ?? null }));
        return { available: true, rows, logging };
      },
    }),
    defineOperation({
      id: "docker.logging.set", title: "Apply Docker log rotation defaults", risk: "medium", timeoutMs: 5 * 60_000,
      description: "Sets the daemon's default log limit to 3 files of 10 MB, applying to containers created from now on rather than existing ones, and turns on live-restore, then restarts dockerd. Running containers restart briefly this one time; with live-restore on, future daemon restarts leave them running.",
      run: (_parameters, { runUnit, jobLog }) => runUnit.runTask("docker.logging", {}, { timeoutMs: 4 * 60_000, logPath: jobLog?.path ?? null }),
    }),
    defineOperation({
      id: "docker.prune", title: "Clean up Docker disk space", risk: "medium", timeoutMs: 15 * 60_000,
      description: "docker system prune: removes stopped containers, unused networks, dangling images, and the build cache. Volumes and images in use are kept.",
      run: async (_parameters, { run, progress }) => {
        const docker = process.env.BOXPILOT_DOCKER_BINARY ?? "/usr/bin/docker";
        progress?.("$ docker system prune --force", "stdout");
        const result = await run(docker, ["system", "prune", "--force"], { timeout: 10 * 60_000, maxBuffer: 8 * 1024 * 1024, onLine: progress ?? undefined });
        if (!result.ok) throw new Error(`docker system prune failed: ${result.stderr.split("\n").slice(-2).join(" ")}`);
        const reclaimed = result.stdout.match(/Total reclaimed space:\s*(.+)$/m)?.[1] ?? null;
        return { pruned: true, reclaimed };
      },
    }),
  ];
}
