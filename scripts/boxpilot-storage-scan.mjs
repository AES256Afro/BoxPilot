#!/usr/bin/env node
import { execFile as execFileCallback } from "node:child_process";
import { access, chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { parseMountInventory } from "../server/storage-evidence.mjs";

const execFile = promisify(execFileCallback);
const fixedDevicePattern = /^\/dev\/(?:sd[a-z]+|vd[a-z]+|xvd[a-z]+|nvme\d+n\d+|mmcblk\d+)$/;
const defaultOutputPath = "/var/lib/boxpilot/storage-health.json";
const defaultSmartctl = "/usr/sbin/smartctl";
const defaultLsblk = "/usr/bin/lsblk";
const defaultFindmnt = "/usr/bin/findmnt";
const fixedFilesystemSourcePattern = /^\/dev\/(?:mapper\/[a-zA-Z0-9+_.-]+|[a-zA-Z0-9+_.-]+)$/;
const fixedKernelNamePattern = /^[a-zA-Z0-9+_.-]{1,64}$/;

async function fixedRun(binary, args, { timeout = 30000 } = {}) {
  try {
    const result = await execFile(binary, args, { timeout, maxBuffer: 1024 * 1024, encoding: "utf8", env: { PATH: "/usr/sbin:/usr/bin:/sbin:/bin", LANG: "C.UTF-8", LC_ALL: "C.UTF-8" } });
    return { ok: true, stdout: result.stdout.trim() };
  } catch (error) {
    return { ok: false, stdout: typeof error.stdout === "string" ? error.stdout.trim() : "" };
  }
}

function safeNumber(value) {
  const parsed = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function safeCounter(value) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function parseDisks(value) {
  try {
    const parsed = JSON.parse(value);
    return (Array.isArray(parsed.blockdevices) ? parsed.blockdevices : [])
      .filter((item) => item?.type === "disk" && typeof item.name === "string" && fixedDevicePattern.test(item.name))
      .map((item) => item.name)
      .slice(0, 16);
  } catch {
    return [];
  }
}

function filesystemErrorSummary(mounts) {
  return {
    healthy: mounts.filter((item) => item.errorEvidence?.state === "healthy").length,
    critical: mounts.filter((item) => item.errorEvidence?.state === "critical").length,
    unavailable: mounts.filter((item) => item.errorEvidence?.state === "unavailable").length,
    unsupported: mounts.filter((item) => item.errorEvidence?.state === "unsupported").length,
  };
}

export async function collectFilesystemErrors(filesystems, { run = fixedRun, loadFile = readFile, lsblkBinary = defaultLsblk } = {}) {
  if (!filesystems?.available || !Array.isArray(filesystems.mounts)) return { ...filesystems, errors: filesystemErrorSummary([]) };
  const cache = new Map();
  async function inspectExt4(source) {
    if (source.length > 128 || !fixedFilesystemSourcePattern.test(source)) return { supported: true, state: "unavailable", errorsCount: null, source: "ext4-sysfs-errors-count", reason: "local-device-unavailable" };
    if (!cache.has(source)) {
      cache.set(source, (async () => {
        const lookup = await run(lsblkBinary, ["--noheadings", "--nodeps", "--output", "KNAME", source], { timeout: 10000 });
        const names = lookup.ok ? lookup.stdout.split("\n").map((item) => item.trim()).filter(Boolean) : [];
        const kernelName = names.length === 1 && fixedKernelNamePattern.test(names[0]) ? names[0] : null;
        if (!kernelName) return { supported: true, state: "unavailable", errorsCount: null, source: "ext4-sysfs-errors-count", reason: "kernel-device-unavailable" };
        let counter = null;
        try { counter = safeCounter((await loadFile(`/sys/fs/ext4/${kernelName}/errors_count`, "utf8")).trim()); } catch { counter = null; }
        if (counter === null) return { supported: true, state: "unavailable", errorsCount: null, source: "ext4-sysfs-errors-count", reason: "counter-unavailable" };
        return { supported: true, state: counter > 0 ? "critical" : "healthy", errorsCount: counter, source: "ext4-sysfs-errors-count", reason: counter > 0 ? "errors-recorded" : "ok" };
      })());
    }
    return cache.get(source);
  }
  const mounts = [];
  for (const mount of filesystems.mounts.slice(0, 128)) {
    const errorEvidence = mount.filesystem === "ext4"
      ? await inspectExt4(mount.source)
      : { supported: false, state: "unsupported", errorsCount: null, source: null, reason: "unsupported-filesystem" };
    mounts.push({ ...mount, errorEvidence });
  }
  return { ...filesystems, mounts, errors: filesystemErrorSummary(mounts) };
}

export function parseSmartctlEvidence(device, output) {
  let parsed;
  try { parsed = JSON.parse(output); } catch {
    return { device, health: "unavailable", passed: null, temperatureCelsius: null, powerOnHours: null, percentageUsed: null, criticalWarning: null, mediaErrors: null, unsafeShutdowns: null, reason: "smartctl-read-failed" };
  }
  const passed = typeof parsed.smart_status?.passed === "boolean" ? parsed.smart_status.passed : null;
  const temperatureCelsius = safeNumber(parsed.temperature?.current ?? parsed.nvme_smart_health_information_log?.temperature);
  const powerOnHours = safeNumber(parsed.power_on_time?.hours);
  const percentageUsed = safeNumber(parsed.nvme_smart_health_information_log?.percentage_used);
  const criticalWarning = safeNumber(parsed.nvme_smart_health_information_log?.critical_warning);
  const mediaErrors = safeNumber(parsed.nvme_smart_health_information_log?.media_errors);
  const unsafeShutdowns = safeNumber(parsed.nvme_smart_health_information_log?.unsafe_shutdowns);
  const critical = passed === false || (criticalWarning !== null && criticalWarning > 0) || (mediaErrors !== null && mediaErrors > 0);
  const warning = (temperatureCelsius !== null && temperatureCelsius >= 70) || (percentageUsed !== null && percentageUsed >= 90);
  const readable = passed !== null || [temperatureCelsius, powerOnHours, percentageUsed, criticalWarning, mediaErrors, unsafeShutdowns].some((item) => item !== null);
  return {
    device,
    health: !readable ? "unavailable" : critical ? "critical" : warning ? "warning" : "healthy",
    passed,
    temperatureCelsius,
    powerOnHours,
    percentageUsed,
    criticalWarning,
    mediaErrors,
    unsafeShutdowns,
    reason: readable ? "ok" : "unsupported-device",
  };
}

export function createStorageScanner({
  run = fixedRun,
  checkAccess = access,
  now = () => new Date(),
  smartctlBinary = defaultSmartctl,
  lsblkBinary = defaultLsblk,
  findmntBinary = defaultFindmnt,
  loadFile = readFile,
} = {}) {
  async function scan() {
    const mountResult = await run(findmntBinary, ["--json", "--bytes", "--real", "--tab-file", "/proc/1/mountinfo", "--output", "TARGET,SOURCE,FSTYPE,SIZE,USED,AVAIL,USE%,OPTIONS"], { timeout: 10000 });
    let filesystems = parseMountInventory(mountResult.ok ? mountResult.stdout : "");
    filesystems.namespace = mountResult.ok ? "host-pid1" : "unavailable";
    filesystems = await collectFilesystemErrors(filesystems, { run, loadFile, lsblkBinary });
    try {
      await checkAccess(smartctlBinary);
    } catch {
      return { schemaVersion: 2, generatedAt: now().toISOString(), available: false, reason: "smartctl-not-installed", filesystems, disks: [], boundary: { mutationPerformed: false, serialsIncluded: false, rawOutputIncluded: false, browserTriggered: false, filesystemCheckTriggered: false } };
    }
    const deviceResult = await run(lsblkBinary, ["--json", "--paths", "--nodeps", "--output", "NAME,TYPE"], { timeout: 10000 });
    const devices = deviceResult.ok ? parseDisks(deviceResult.stdout) : [];
    if (devices.length === 0) return { schemaVersion: 2, generatedAt: now().toISOString(), available: false, reason: "no-supported-disks", filesystems, disks: [], boundary: { mutationPerformed: false, serialsIncluded: false, rawOutputIncluded: false, browserTriggered: false, filesystemCheckTriggered: false } };
    const disks = [];
    for (const device of devices) {
      const result = await run(smartctlBinary, ["--json=c", "--all", device], { timeout: 30000 });
      disks.push(parseSmartctlEvidence(device, result.stdout));
    }
    return { schemaVersion: 2, generatedAt: now().toISOString(), available: disks.some((item) => item.health !== "unavailable"), reason: disks.some((item) => item.health !== "unavailable") ? "fixed-root-scan" : "storage-scan-failed", filesystems, disks, boundary: { mutationPerformed: false, serialsIncluded: false, rawOutputIncluded: false, browserTriggered: false, filesystemCheckTriggered: false } };
  }
  return { scan };
}

export async function writeStorageEvidence({ outputPath = process.env.BOXPILOT_STORAGE_HEALTH_PATH ?? defaultOutputPath, stateDirectory = process.env.BOXPILOT_STATE_DIRECTORY ?? "/var/lib/boxpilot", scanner = createStorageScanner() } = {}) {
  const resolved = path.resolve(outputPath);
  const resolvedStateDirectory = path.resolve(stateDirectory);
  if (resolved !== path.join(resolvedStateDirectory, "storage-health.json")) throw new Error("Storage evidence path must remain the fixed file in the BoxPilot state directory");
  const partial = `${resolved}.partial`;
  const evidence = await scanner.scan();
  await mkdir(path.dirname(resolved), { recursive: true, mode: 0o700 });
  await writeFile(partial, `${JSON.stringify(evidence)}\n`, { encoding: "utf8", mode: 0o640 });
  await rename(partial, resolved);
  await chmod(resolved, 0o640);
  return evidence;
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) {
  writeStorageEvidence().then((evidence) => {
    process.stdout.write(`BoxPilot storage evidence: ${evidence.available ? "available" : evidence.reason}\n`);
  }).catch((error) => {
    process.stderr.write(`BoxPilot storage evidence failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}

export const storageScanInternals = { defaultFindmnt, defaultLsblk, defaultOutputPath, defaultSmartctl, filesystemErrorSummary, fixedDevicePattern, fixedFilesystemSourcePattern, fixedKernelNamePattern, parseDisks, safeCounter, safeNumber };
