import { readFile } from "node:fs/promises";
import os from "node:os";
import { statfs } from "node:fs/promises";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { normalizeMountEvidence, normalizeSmartEvidence, parseBlockInventory } from "./storage-evidence.mjs";

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
  now = () => new Date(),
} = {}) {
  async function inspectService(unit) {
    const result = await runCommand("systemctl", ["show", unit, "--property=Id,LoadState,ActiveState,SubState,UnitFileState", "--no-pager"]);
    const values = parseKeyValues(result.stdout);
    return { unit, load: values.LoadState ?? (result.ok ? "unknown" : "unavailable"), active: values.ActiveState ?? "unknown", sub: values.SubState ?? "unknown", enabled: values.UnitFileState ?? "unknown" };
  }

  async function inspectTailscale() {
    const result = await runCommand("tailscale", ["status", "--json"]);
    if (!result.ok) return { installed: false, connected: false, dnsName: null };
    try {
      const parsed = JSON.parse(result.stdout);
      return { installed: true, connected: parsed.BackendState === "Running", dnsName: parsed.Self?.DNSName?.replace(/\.$/, "") ?? null };
    } catch {
      return { installed: true, connected: false, dnsName: null };
    }
  }

  async function inspect() {
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
    const [services, tailscale, blockResult, smartResult] = await Promise.all([
      Promise.all(serviceUnits.map(inspectService)),
      inspectTailscale(),
      runCommand("lsblk", ["--json", "--bytes", "--paths", "--output", "NAME,TYPE,FSTYPE,SIZE,MOUNTPOINTS,ROTA,RO,TRAN,MODEL"]),
      readStorageHealth().then((contents) => ({ ok: true, contents })).catch(() => ({ ok: false, contents: "" })),
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
      network: { addresses, tailscale },
      services,
      docker,
    };
  }

  return { inspect };
}

export const inventoryInternals = { parseKeyValues, filesystemSummary, serviceUnits, storageHealthPath };
