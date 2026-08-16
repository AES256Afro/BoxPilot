import { access, readdir, stat } from "node:fs/promises";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const systemctlBinary = "/usr/bin/systemctl";
const rebootRequiredPath = "/run/reboot-required";
const dpkgUpdatesPath = "/var/lib/dpkg/updates";
const aptListsPath = "/var/lib/apt/lists";
const systemStates = new Set(["running", "degraded", "maintenance", "starting", "stopping", "offline"]);

async function fixedRun(binary, args, { timeout = 5000 } = {}) {
  try {
    const result = await execFile(binary, args, { timeout, maxBuffer: 256 * 1024, encoding: "utf8", env: { PATH: "/usr/sbin:/usr/bin:/sbin:/bin", LANG: "C.UTF-8", LC_ALL: "C.UTF-8" } });
    return { ok: true, stdout: result.stdout.trim(), code: null };
  } catch (error) {
    const stdout = typeof error.stdout === "string" ? error.stdout.trim() : "";
    return { ok: false, stdout, code: error.code ?? null };
  }
}

async function fixedExists(path) {
  try { await access(path); return true; } catch (error) { return error?.code === "ENOENT" ? false : null; }
}

function keyValues(output) {
  const values = {};
  for (const line of String(output ?? "").split("\n").slice(0, 16)) {
    const separator = line.indexOf("=");
    if (separator > 0) values[line.slice(0, separator)] = line.slice(separator + 1).trim();
  }
  return values;
}

function boundary() {
  return { mutationPerformed: false, aptOperationAvailable: false, packageNamesIncluded: false, unitNamesIncluded: false, rebootAvailable: false, serviceControlAvailable: false, rawOutputIncluded: false, browserTargetAccepted: false };
}

export function unavailableMaintenanceEvidence() {
  return {
    system: { available: false, state: "unavailable", failedServiceCount: null, failedServiceCountTruncated: false },
    reboot: { available: false, required: null },
    packageManager: { available: false, state: "unavailable", pendingUpdateFragments: null, countTruncated: false },
    aptMetadata: { available: false, state: "unavailable", updatedAt: null, ageHours: null },
    automaticSecurityUpdates: { available: false, state: "unavailable", enabled: null, active: null },
    boundary: boundary(),
  };
}

export function createMaintenanceService({
  run = fixedRun,
  exists = fixedExists,
  readDirectory = readdir,
  getStat = stat,
  now = () => new Date(),
} = {}) {
  async function inspect() {
    const [systemResult, failedResult, unattendedResult, rebootResult, dpkgResult, aptResult] = await Promise.all([
      run(systemctlBinary, ["is-system-running"], { timeout: 5000 }),
      run(systemctlBinary, ["--failed", "--type=service", "--no-legend", "--plain", "--no-pager"], { timeout: 5000 }),
      run(systemctlBinary, ["show", "unattended-upgrades.service", "--property=LoadState,ActiveState,SubState,UnitFileState", "--no-pager"], { timeout: 5000 }),
      exists(rebootRequiredPath).catch(() => null),
      readDirectory(dpkgUpdatesPath).then((entries) => ({ ok: true, entries })).catch(() => ({ ok: false, entries: [] })),
      getStat(aptListsPath).then((value) => ({ ok: true, value })).catch(() => ({ ok: false, value: null })),
    ]);

    const rawSystemState = String(systemResult.stdout ?? "").trim();
    const systemState = systemStates.has(rawSystemState) ? rawSystemState : "unavailable";
    const failedLines = failedResult.ok ? failedResult.stdout.split("\n").map((line) => line.trim()).filter(Boolean).slice(0, 257) : [];
    const dpkgEntries = dpkgResult.ok ? dpkgResult.entries.filter((entry) => /^\d{4}$/.test(entry)).slice(0, 257) : [];
    const unattended = unattendedResult.ok ? keyValues(unattendedResult.stdout) : {};
    const unattendedAvailable = unattended.LoadState === "loaded";
    const unattendedEnabled = unattendedAvailable ? ["enabled", "enabled-runtime", "static"].includes(unattended.UnitFileState) : null;
    const unattendedActive = unattendedAvailable ? unattended.ActiveState === "active" : null;
    const unattendedState = !unattendedAvailable ? "unavailable" : unattendedEnabled && unattendedActive ? "enabled-active" : unattendedEnabled ? "configured-inactive" : "disabled";

    let updatedAt = null;
    let ageHours = null;
    let aptState = "unavailable";
    if (aptResult.ok && aptResult.value?.mtime instanceof Date) {
      const difference = now().getTime() - aptResult.value.mtime.getTime();
      if (difference >= -5 * 60 * 1000) {
        updatedAt = aptResult.value.mtime.toISOString();
        ageHours = Math.max(0, Math.floor(difference / (60 * 60 * 1000)));
        aptState = ageHours > 7 * 24 ? "stale" : "current";
      }
    }

    return {
      system: { available: systemState !== "unavailable" && failedResult.ok, state: systemState, failedServiceCount: failedResult.ok ? Math.min(failedLines.length, 256) : null, failedServiceCountTruncated: failedLines.length > 256 },
      reboot: { available: rebootResult !== null, required: rebootResult },
      packageManager: { available: dpkgResult.ok, state: dpkgResult.ok ? dpkgEntries.length > 0 ? "interrupted" : "ready" : "unavailable", pendingUpdateFragments: dpkgResult.ok ? Math.min(dpkgEntries.length, 256) : null, countTruncated: dpkgEntries.length > 256 },
      aptMetadata: { available: aptState !== "unavailable", state: aptState, updatedAt, ageHours },
      automaticSecurityUpdates: { available: unattendedAvailable, state: unattendedState, enabled: unattendedEnabled, active: unattendedActive },
      boundary: boundary(),
    };
  }

  return { inspect };
}

export const maintenanceInternals = { aptListsPath, boundary, dpkgUpdatesPath, keyValues, rebootRequiredPath, systemctlBinary, systemStates };
