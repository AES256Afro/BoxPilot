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
const fixedTransportPattern = /^[a-z0-9]{1,16}$/;

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
      .map((item) => ({ device: item.name, transport: typeof item.tran === "string" && fixedTransportPattern.test(item.tran) ? item.tran : null }))
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

/**
 * Every read asks smartctl to leave a sleeping disk alone (M36): `-n standby` answers "Device is in
 * STANDBY mode" instead of spinning it up, which a check every six hours otherwise did to every
 * idle drive. NVMe ignores it; nothing else about the read changes.
 */
export const smartReadArgs = Object.freeze(["--json=c", "--all", "-n", "standby"]);

/** smartctl skipped the disk because it was asleep (standby or sleep), which says nothing about its health. */
export function diskAsleep(output) {
  return smartctlMessages(output).some((line) => /Device is in [A-Z_ ]*(?:STANDBY|SLEEP)[A-Z_ ]* mode/i.test(line));
}

export function parseSmartctlEvidence(device, output) {
  let parsed;
  try { parsed = JSON.parse(output); } catch {
    return { device, health: "unavailable", passed: null, temperatureCelsius: null, powerOnHours: null, percentageUsed: null, criticalWarning: null, mediaErrors: null, unsafeShutdowns: null, reason: "smartctl-read-failed" };
  }
  if (diskAsleep(output)) {
    return { device, health: "unavailable", passed: null, temperatureCelsius: null, powerOnHours: null, percentageUsed: null, criticalWarning: null, mediaErrors: null, unsafeShutdowns: null, reason: "asleep" };
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

/** The lines smartctl wrote about why it could not read a device, from its JSON `messages`. */
function smartctlMessages(output) {
  try {
    const messages = JSON.parse(output)?.smartctl?.messages;
    return Array.isArray(messages) ? messages.slice(0, 16).map((entry) => String(entry?.string ?? "").slice(0, 256)) : [];
  } catch {
    return [];
  }
}

/** smartctl did not know the USB bridge in front of this disk and asked to be told the device type. */
export function usbBridgeUnrecognized(output) {
  return smartctlMessages(output).some((line) => /Unknown USB bridge|specify device type with the -d option/i.test(line));
}

/** smartctl could not open the device at all, which says nothing about what the bridge passes through. */
function deviceOpenFailed(output) {
  return smartctlMessages(output).some((line) => /open device: .* failed|No such device|Permission denied/i.test(line));
}

/**
 * Whether a disk that did not answer is worth asking once more with `-d sat`.
 *
 * smartctl recognises many USB-SATA bridges by their USB id and speaks SAT (ATA commands wrapped in
 * SCSI) to them on its own. One it does not recognise answers "Unknown USB bridge" and nothing
 * else, and plenty of those pass ATA commands through perfectly well when asked. Only USB disks are
 * asked again: an internal disk that did not answer has no bridge to blame.
 */
export function needsSatRetry(transport, directOutput) {
  if (transport !== "usb" && !usbBridgeUnrecognized(directOutput)) return false;
  // Asleep is an answer: the bridge passed the power check through, and asking again would wake it.
  if (diskAsleep(directOutput)) return false;
  return parseSmartctlEvidence("", directOutput).health === "unavailable";
}

/**
 * One disk's SMART evidence from the reading as smartctl chose to do it and, for a USB disk that
 * did not answer, the second reading through `-d sat`. Both are reads; nothing is enabled or
 * written on the drive. A USB disk that answers neither way sits behind a bridge that does not pass
 * SMART through, and is recorded as exactly that: a limit of the enclosure, not a failed reading.
 */
export function smartEvidenceFor(device, { transport = null, direct = "", sat = null } = {}) {
  const onUsb = transport === "usb" || usbBridgeUnrecognized(direct);
  const first = { ...parseSmartctlEvidence(device, direct), transport: onUsb ? "usb" : transport, deviceType: "auto" };
  if (first.health !== "unavailable" || !onUsb || sat === null) return first;
  const second = parseSmartctlEvidence(device, sat);
  if (second.health !== "unavailable" || second.reason === "asleep") return { ...second, transport: "usb", deviceType: "sat" };
  return { ...first, deviceType: "sat", reason: deviceOpenFailed(direct) || deviceOpenFailed(sat) ? "smartctl-read-failed" : "usb-bridge-unsupported" };
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
    const deviceResult = await run(lsblkBinary, ["--json", "--paths", "--nodeps", "--output", "NAME,TYPE,TRAN"], { timeout: 10000 });
    const devices = deviceResult.ok ? parseDisks(deviceResult.stdout) : [];
    if (devices.length === 0) return { schemaVersion: 2, generatedAt: now().toISOString(), available: false, reason: "no-supported-disks", filesystems, disks: [], boundary: { mutationPerformed: false, serialsIncluded: false, rawOutputIncluded: false, browserTriggered: false, filesystemCheckTriggered: false } };
    const disks = [];
    for (const { device, transport } of devices) {
      const direct = await run(smartctlBinary, [...smartReadArgs, device], { timeout: 30000 });
      const sat = needsSatRetry(transport, direct.stdout) ? await run(smartctlBinary, [...smartReadArgs, "-d", "sat", device], { timeout: 30000 }) : null;
      const reading = smartEvidenceFor(device, { transport, direct: direct.stdout, sat: sat ? sat.stdout : null });
      disks.push(reading.health === "unavailable" ? reading : { ...reading, readAt: now().toISOString() });
    }
    const read = disks.some((item) => item.health !== "unavailable");
    // Every disk that was not read was asleep: not a failed scan, just a quiet server.
    const allAsleep = !read && disks.every((item) => item.reason === "asleep");
    return { schemaVersion: 2, generatedAt: now().toISOString(), available: read, reason: read ? "fixed-root-scan" : allAsleep ? "disks-asleep" : "storage-scan-failed", filesystems, disks, boundary: { mutationPerformed: false, serialsIncluded: false, rawOutputIncluded: false, browserTriggered: false, filesystemCheckTriggered: false } };
  }
  return { scan };
}

/**
 * A disk that was asleep keeps what it last said (M36): its health and when it was read, from the
 * evidence this scan replaces, so a drive that sleeps through every check is not reported as never
 * read, and one that was failing is not reported as fixed. Its other figures are not carried: they
 * were true then, not now.
 */
export function carryLastReadings(evidence, previous) {
  const before = new Map((Array.isArray(previous?.disks) ? previous.disks : []).map((disk) => [disk?.device, disk]));
  const disks = (evidence.disks ?? []).map((disk) => {
    if (disk.reason !== "asleep") return disk;
    const last = before.get(disk.device);
    if (!last) return disk;
    const health = last.reason === "asleep" ? last.lastHealth : last.health;
    const readAt = last.reason === "asleep" ? last.lastReadAt : last.readAt ?? previous.generatedAt;
    if (!["healthy", "warning", "critical"].includes(health) || typeof readAt !== "string") return disk;
    return { ...disk, lastHealth: health, lastReadAt: readAt };
  });
  return { ...evidence, disks };
}

export async function writeStorageEvidence({ outputPath = process.env.BOXPILOT_STORAGE_HEALTH_PATH ?? defaultOutputPath, stateDirectory = process.env.BOXPILOT_STATE_DIRECTORY ?? "/var/lib/boxpilot", scanner = createStorageScanner() } = {}) {
  const resolved = path.resolve(outputPath);
  const resolvedStateDirectory = path.resolve(stateDirectory);
  if (resolved !== path.join(resolvedStateDirectory, "storage-health.json")) throw new Error("Storage evidence path must remain the fixed file in the BoxPilot state directory");
  const partial = `${resolved}.partial`;
  const evidence = carryLastReadings(await scanner.scan(), await readFile(resolved, "utf8").then(JSON.parse).catch(() => null));
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

export const storageScanInternals = { defaultFindmnt, defaultLsblk, defaultOutputPath, defaultSmartctl, filesystemErrorSummary, fixedDevicePattern, fixedFilesystemSourcePattern, fixedKernelNamePattern, fixedTransportPattern, parseDisks, safeCounter, safeNumber };
