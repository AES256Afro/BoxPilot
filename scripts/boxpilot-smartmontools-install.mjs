#!/usr/local/bin/node
import { execFile as execFileCallback } from "node:child_process";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

/**
 * Fixed installer for the drive-check tools: smartmontools (smartctl, which reads a disk's SMART
 * health) and exfatprogs (fsck.exfat, which checks an exFAT drive). It installs only packages from
 * this fixed set, only at the exact versions the helper approved moments ago, and changes nothing
 * that is already installed. The approval marker names either one smartmontools version (the
 * original shape) or a set of packages from the fixed list.
 */
const execFile = promisify(execFileCallback);
const approvalPath = "/run/boxpilot/smartmontools-approval.json";
const fixedPackages = Object.freeze(["exfatprogs", "smartmontools"]);
const versionPattern = /^[0-9A-Za-z.+:~_-]{1,64}$/;
const fixedEnvironment = { PATH: "/usr/sbin:/usr/bin:/sbin:/bin", LANG: "C.UTF-8", LC_ALL: "C.UTF-8", DEBIAN_FRONTEND: "noninteractive" };

/**
 * needrestart's hook is suspended for the install (NEEDRESTART_SUSPEND, its documented off switch),
 * as server/tasks/apt.mjs does for every package change: Ubuntu server runs it in automatic mode, and a
 * dependency that moves libc or openssl had it restart BoxPilot and its helper mid-install.
 */
const aptEnvironment = { NEEDRESTART_SUSPEND: "1" };

async function fixedRun(binary, args, { timeout = 30000, env = {} } = {}) {
  try {
    const result = await execFile(binary, args, { timeout, maxBuffer: 256 * 1024, encoding: "utf8", env: { ...fixedEnvironment, ...env } });
    return { ok: true, stdout: result.stdout.trim() };
  } catch (error) {
    return { ok: false, stdout: typeof error.stdout === "string" ? error.stdout.trim() : "" };
  }
}

function cleanVersion(value) {
  const candidate = String(value ?? "").trim();
  return versionPattern.test(candidate) && candidate !== "(none)" ? candidate : null;
}

function installedVersion(output) {
  const [status, version] = String(output ?? "").split("\t", 2);
  return status === "install ok installed" ? cleanVersion(version) : null;
}

function candidateVersion(output) {
  return cleanVersion(String(output ?? "").match(/^\s*Candidate:\s*(\S+)\s*$/m)?.[1]);
}

/** The approved packages, as { name: exactVersion }, from either marker shape. */
function approvedPackages(value) {
  const keys = value && typeof value === "object" && !Array.isArray(value) ? Object.keys(value).sort().join(",") : "";
  if (keys === "approvedAt,expectedVersion") {
    if (!versionPattern.test(String(value.expectedVersion ?? ""))) throw new Error("The approved smartmontools version is invalid");
    return { smartmontools: value.expectedVersion };
  }
  if (keys !== "approvedAt,packages") throw new Error("The drive tools approval marker has unexpected fields");
  const packages = value.packages;
  if (!packages || typeof packages !== "object" || Array.isArray(packages) || Object.keys(packages).length === 0) throw new Error("The drive tools approval marker lists no packages");
  for (const [name, version] of Object.entries(packages)) {
    if (!fixedPackages.includes(name)) throw new Error("The drive tools approval marker names a package outside the fixed set");
    if (typeof version !== "string" || !versionPattern.test(version)) throw new Error(`The approved ${name} version is invalid`);
  }
  return Object.fromEntries(Object.keys(packages).sort().map((name) => [name, packages[name]]));
}

function parseApproval(raw, now) {
  let value;
  try { value = JSON.parse(raw); } catch { throw new Error("The drive tools approval marker is invalid"); }
  const packages = approvedPackages(value);
  if (typeof value.approvedAt !== "string") throw new Error("The drive tools approval marker has unexpected fields");
  const approvedTime = Date.parse(value.approvedAt);
  const age = now.getTime() - approvedTime;
  if (!Number.isFinite(approvedTime) || age < -30000 || age > 5 * 60 * 1000) throw new Error("The drive tools approval marker is stale");
  return packages;
}

export async function installApprovedDriveTools({
  run = fixedRun,
  loadApproval = () => readFile(approvalPath, "utf8"),
  now = () => new Date(),
} = {}) {
  const approved = parseApproval(await loadApproval(), now());
  const names = Object.keys(approved);
  const missing = [];
  // Every approved package is checked before anything is installed: one stale version stops all of them.
  for (const name of names) {
    const policy = await run("/usr/bin/apt-cache", ["policy", name], { timeout: 10000 });
    const candidate = policy.ok ? candidateVersion(policy.stdout) : null;
    if (!candidate || candidate !== approved[name]) throw new Error(`APT metadata for ${name} changed after approval; no package was installed`);
    const current = await run("/usr/bin/dpkg-query", ["--show", "--showformat=${Status}\\t${Version}", name], { timeout: 10000 });
    const before = current.ok ? installedVersion(current.stdout) : null;
    if (before && before !== approved[name]) throw new Error(`A different ${name} version is already installed; no package was changed`);
    if (!before) missing.push(name);
  }
  if (missing.length) {
    // --no-remove: if satisfying this would remove anything (a conflicting exFAT provider, say), apt stops instead.
    const installation = await run("/usr/bin/apt-get", ["install", "--yes", "--no-install-recommends", "--no-remove", ...missing.map((name) => `${name}=${approved[name]}`)], { timeout: 14 * 60 * 1000, env: aptEnvironment });
    if (!installation.ok) throw new Error(`The exact approved installation of ${missing.join(" and ")} failed`);
  }
  for (const name of names) {
    const after = await run("/usr/bin/dpkg-query", ["--show", "--showformat=${Status}\\t${Version}", name], { timeout: 10000 });
    if (!after.ok || installedVersion(after.stdout) !== approved[name]) throw new Error(`The installed ${name} version does not match approval`);
  }
  const scan = await run("/usr/bin/systemctl", ["start", "boxpilot-storage-scan.service"], { timeout: 120000 });
  if (!scan.ok) throw new Error("The fixed storage evidence scan failed after installation");
  return { installed: true, packages: approved, packagesChanged: missing };
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
if (invokedPath === import.meta.url) {
  if (process.argv.length !== 2) {
    console.error("The fixed drive tools installer accepts no arguments");
    process.exitCode = 64;
  } else {
    try {
      const result = await installApprovedDriveTools();
      console.log(`Installed and verified ${Object.entries(result.packages).map(([name, version]) => `${name} ${version}`).join(", ")}`);
    } catch (error) {
      console.error(error.message);
      process.exitCode = 1;
    }
  }
}
