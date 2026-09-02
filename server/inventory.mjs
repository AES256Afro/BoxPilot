import { readFile } from "node:fs/promises";
import os from "node:os";
import { statfs } from "node:fs/promises";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { normalizeMountEvidence, normalizeSmartEvidence, parseBlockInventory } from "./storage-evidence.mjs";
import { createMaintenanceService, unavailableMaintenanceEvidence } from "./maintenance.mjs";
import { createUpsService, unavailableUpsEvidence } from "./ups.mjs";

const execFile = promisify(execFileCallback);
const serviceUnits = ["boxpilot.service", "boxpilot-helper.service", "docker.service", "tailscaled.service", "libvirtd.service", "virtqemud.service"];
const storageHealthPath = "/var/lib/boxpilot/storage-health.json";

async function fixedCommand(command, args, { timeout = 5000 } = {}) {
  try {
    const result = await execFile(command, args, { timeout, maxBuffer: 256 * 1024, encoding: "utf8", env: { PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin", LANG: "C.UTF-8", LC_ALL: "C.UTF-8" } });
    return { ok: true, stdout: result.stdout.trim() };
  } catch (error) {
    return { ok: false, stdout: typeof error.stdout === "string" ? error.stdout.trim() : "", code: error.code ?? null };
  }
}

function parseKeyValues(output, separator = "=") {
  const values = {};
  for (const line of output.split("\n")) {
    const index = line.indexOf(separator);
    if (index > 0) values[line.slice(0, index).trim()] = line.slice(index + separator.length).trim().replace(/^"|"$/g, "");
  }
  return values;
}

function filesystemSummary(value) {
  const totalBytes = Number(value.blocks) * Number(value.bsize);
  const freeBytes = Number(value.bavail) * Number(value.bsize);
  return { totalBytes, freeBytes, usedBytes: Math.max(0, totalBytes - freeBytes), usedPercent: totalBytes ? Math.round(((totalBytes - freeBytes) / totalBytes) * 100) : 0 };
}

export function createInventoryService({
  helper,
  runCommand = fixedCommand,
  readOsRelease = () => readFile("/etc/os-release", "utf8"),
  getFilesystem = statfs,
  getNetworkInterfaces = os.networkInterfaces,
  readStorageHealth = () => readFile(process.env.BOXPILOT_STORAGE_HEALTH_PATH ?? storageHealthPath, "utf8"),
  maintenance = createMaintenanceService(),
  ups = createUpsService(),
  now = () => new Date(),
} = {}) {
  /**
   * One `systemctl show` for every unit rather than one per unit. systemctl answers several units in
   * a single call, separating them with a blank line and naming each with Id=, so six processes
   * become one - on every Overview, Apps, Storage and Repair load, and every fifteen minutes from
   * the health check. A unit systemctl did not answer for comes back as it always did when its own
   * call failed: unavailable.
   */
  async function inspectServices(units) {
    const result = await runCommand("systemctl", ["show", ...units, "--property=Id,LoadState,ActiveState,SubState,UnitFileState", "--no-pager"]);
    const answered = new Map();
    for (const block of String(result.stdout ?? "").split(/\n\s*\n/)) {
      const values = parseKeyValues(block);
      if (values.Id) answered.set(values.Id, values);
    }
    return units.map((unit) => {
      const values = answered.get(unit) ?? {};
      return { unit, load: values.LoadState ?? (result.ok ? "unknown" : "unavailable"), active: values.ActiveState ?? "unknown", sub: values.SubState ?? "unknown", enabled: values.UnitFileState ?? "unknown" };
    });
  }

  async function inspectTailscale() {
    const result = await runCommand("tailscale", ["status", "--json", "--peers=false"]);
    if (!result.ok) return { installed: false, connected: false, dnsName: null };
    try {
      const parsed = JSON.parse(result.stdout);
      return { installed: true, connected: parsed.BackendState === "Running", dnsName: parsed.Self?.DNSName?.replace(/\.$/, "") ?? null };
    } catch {
      return { installed: true, connected: false, dnsName: null };
    }
  }

  const inventoryTtlMs = 10_000;
  let cached = null; // { at, value }
  let inFlight = null;
  /** The full inventory is ~17 commands; the Overview asks for it several times per visit. */
  async function inspect() {
    if (cached && Date.now() - cached.at < inventoryTtlMs) return cached.value;
    if (inFlight) return inFlight;
    inFlight = collect().then((value) => { cached = { at: Date.now(), value }; return value; }).finally(() => { inFlight = null; });
    return inFlight;
  }

  async function collect() {
    let release = {};
    try { release = parseKeyValues(await readOsRelease()); } catch { release = {}; }
    const cpuCount = os.cpus().length;
    const load = os.loadavg();
    const totalMemoryBytes = os.totalmem();
    const freeMemoryBytes = os.freemem();
    let rootStorage = null;
    try { rootStorage = filesystemSummary(await getFilesystem("/")); } catch { rootStorage = null; }
    const addresses = Object.entries(getNetworkInterfaces()).flatMap(([name, entries]) => (entries ?? [])
      .filter((entry) => !entry.internal && (entry.family === "IPv4" || entry.family === 4))
      .map((entry) => ({ interface: name, address: entry.address, cidr: entry.cidr ?? null })));

    let docker = { available: false, containers: [], images: [], networks: [], volumes: [], projects: [] };
    try { docker = await helper.request("container.docker.inventory", {}); } catch { docker = { ...docker, error: "Docker inventory is unavailable through the restricted helper" }; }
    const [services, tailscale, blockResult, smartResult, maintenanceResult, upsResult] = await Promise.all([
      inspectServices(serviceUnits),
      inspectTailscale(),
      runCommand("lsblk", ["--json", "--bytes", "--paths", "--output", "NAME,TYPE,FSTYPE,SIZE,MOUNTPOINTS,ROTA,RO,TRAN,MODEL"]),
      readStorageHealth().then((contents) => ({ ok: true, contents })).catch(() => ({ ok: false, contents: "" })),
      maintenance.inspect().catch(() => unavailableMaintenanceEvidence()),
      ups.inspect().catch(() => unavailableUpsEvidence()),
    ]);
    const blockDevices = blockResult.ok ? parseBlockInventory(blockResult.stdout) : parseBlockInventory("");
    let smartValue = null;
    if (smartResult.ok) {
      try { smartValue = JSON.parse(smartResult.contents); } catch { smartValue = null; }
    }
    const filesystems = normalizeMountEvidence(smartValue?.filesystems, { schemaVersion: smartValue?.schemaVersion, generatedAt: smartValue?.generatedAt, now });
    const smart = normalizeSmartEvidence(smartValue, { now });
    return {
      generatedAt: now().toISOString(),
      host: {
        hostname: os.hostname(),
        operatingSystem: release.PRETTY_NAME ?? `${os.type()} ${os.release()}`,
        kernel: os.release(),
        architecture: os.arch(),
        uptimeSeconds: Math.floor(os.uptime()),
      },
      compute: {
        cpuCount,
        cpuModel: os.cpus()[0]?.model ?? "unknown",
        load1: load[0],
        load5: load[1],
        load15: load[2],
        loadPercent: cpuCount ? Math.min(100, Math.round((load[0] / cpuCount) * 100)) : 0,
        totalMemoryBytes,
        freeMemoryBytes,
        usedMemoryBytes: totalMemoryBytes - freeMemoryBytes,
        memoryUsedPercent: totalMemoryBytes ? Math.round(((totalMemoryBytes - freeMemoryBytes) / totalMemoryBytes) * 100) : 0,
      },
      storage: { root: rootStorage, filesystems, blockDevices, smart },
      maintenance: maintenanceResult,
      power: { ups: upsResult },
      network: { addresses, tailscale },
      services,
      docker,
    };
  }

  return { inspect };
}

export const inventoryInternals = { parseKeyValues, filesystemSummary, serviceUnits, storageHealthPath };
