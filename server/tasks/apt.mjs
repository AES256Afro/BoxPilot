/**
 * Root-side APT tasks executed by scripts/boxpilot-run.mjs inside boxpilot-run@.service
 * (which has network access, unlike the helper). Each task validates its own parameters
 * again — the spec file is written by the helper, but defense in depth is cheap.
 */
import { access } from "node:fs/promises";
import { fixedRun } from "../exec.mjs";

export const packageNamePattern = /^[a-z0-9][a-z0-9+.-]{0,99}$/;
const aptGet = "/usr/bin/apt-get";
const dpkgQuery = "/usr/bin/dpkg-query";
const rebootRequiredPath = "/run/reboot-required";

export function validPackageList(value, { min = 1, max = 50 } = {}) {
  if (!Array.isArray(value)) return "must be an array of package names";
  if (value.length < min) return `must list at least ${min} package${min === 1 ? "" : "s"}`;
  if (value.length > max) return `must list at most ${max} packages`;
  if (new Set(value).size !== value.length) return "must not repeat a package";
  if (!value.every((name) => typeof name === "string" && packageNamePattern.test(name))) return "contains an invalid package name";
  return null;
}

async function installedVersions(run, packages) {
  const versions = {};
  for (const name of packages) {
    const result = await run(dpkgQuery, ["--show", "--showformat=${Status}\t${Version}", name], { timeout: 10_000 });
    const [status, version] = result.ok ? result.stdout.split("\t", 2) : [];
    versions[name] = status === "install ok installed" ? version : null;
  }
  return versions;
}

async function rebootRequired() {
  try { await access(rebootRequiredPath); return true; } catch { return false; }
}

function summarizeAptOutput(stdout) {
  const match = stdout.match(/^(\d+) upgraded, (\d+) newly installed, (\d+) to remove and (\d+) not upgraded\.$/m);
  return match ? { upgraded: Number(match[1]), newlyInstalled: Number(match[2]), removed: Number(match[3]), notUpgraded: Number(match[4]) } : null;
}

/** `apt-get update`. */
export async function aptUpdate(_parameters = {}, { run = fixedRun } = {}) {
  const result = await run(aptGet, ["update"], { timeout: 10 * 60_000 });
  if (!result.ok) throw new Error(`apt-get update failed: ${result.stderr.split("\n").slice(-3).join(" ")}`);
  return { updated: true, rebootRequired: await rebootRequired() };
}

/** Upgrade everything (`--with-new-pkgs upgrade`) or only the listed packages (`install --only-upgrade`). */
export async function aptUpgrade({ packages = null, refreshFirst = true } = {}, { run = fixedRun } = {}) {
  if (packages !== null) { const problem = validPackageList(packages); if (problem) throw new Error(`packages ${problem}`); }
  if (refreshFirst) await aptUpdate({}, { run });
  const before = packages ? await installedVersions(run, packages) : {};
  const args = packages ? ["install", "--yes", "--only-upgrade", ...packages] : ["upgrade", "--yes", "--with-new-pkgs"];
  const result = await run(aptGet, args, { timeout: 60 * 60_000, maxBuffer: 8 * 1024 * 1024 });
  if (!result.ok) throw new Error(`apt-get ${args[0]} failed: ${result.stderr.split("\n").slice(-3).join(" ")}`);
  const after = packages ? await installedVersions(run, packages) : {};
  return { upgraded: true, scope: packages ? "selected" : "all", packages: packages ?? [], before, after, summary: summarizeAptOutput(result.stdout), rebootRequired: await rebootRequired() };
}

/** Install packages without recommends. */
export async function aptInstall({ packages, refreshFirst = true } = {}, { run = fixedRun } = {}) {
  const problem = validPackageList(packages); if (problem) throw new Error(`packages ${problem}`);
  if (refreshFirst) await aptUpdate({}, { run });
  const before = await installedVersions(run, packages);
  const result = await run(aptGet, ["install", "--yes", "--no-install-recommends", ...packages], { timeout: 60 * 60_000, maxBuffer: 8 * 1024 * 1024 });
  if (!result.ok) throw new Error(`apt-get install failed: ${result.stderr.split("\n").slice(-3).join(" ")}`);
  const after = await installedVersions(run, packages);
  const missing = packages.filter((name) => !after[name]);
  if (missing.length) throw new Error(`apt-get reported success but ${missing.join(", ")} is not installed`);
  return { installed: true, packages, before, after, summary: summarizeAptOutput(result.stdout), rebootRequired: await rebootRequired() };
}

/** Remove (or purge) packages, then autoremove what they pulled in. */
export async function aptRemove({ packages, purge = false, autoremove = true } = {}, { run = fixedRun } = {}) {
  const problem = validPackageList(packages); if (problem) throw new Error(`packages ${problem}`);
  const before = await installedVersions(run, packages);
  const result = await run(aptGet, [purge ? "purge" : "remove", "--yes", ...(autoremove ? ["--auto-remove"] : []), ...packages], { timeout: 30 * 60_000, maxBuffer: 8 * 1024 * 1024 });
  if (!result.ok) throw new Error(`apt-get ${purge ? "purge" : "remove"} failed: ${result.stderr.split("\n").slice(-3).join(" ")}`);
  const after = await installedVersions(run, packages);
  const remaining = packages.filter((name) => after[name]);
  if (remaining.length) throw new Error(`apt-get reported success but ${remaining.join(", ")} is still installed`);
  return { removed: true, purged: purge, packages, before, after, summary: summarizeAptOutput(result.stdout), rebootRequired: await rebootRequired() };
}

/** `apt-get autoremove --purge`. */
export async function aptAutoremove(_parameters = {}, { run = fixedRun } = {}) {
  const result = await run(aptGet, ["autoremove", "--yes", "--purge"], { timeout: 30 * 60_000, maxBuffer: 8 * 1024 * 1024 });
  if (!result.ok) throw new Error(`apt-get autoremove failed: ${result.stderr.split("\n").slice(-3).join(" ")}`);
  return { autoremoved: true, summary: summarizeAptOutput(result.stdout), rebootRequired: await rebootRequired() };
}

export const aptTaskInternals = { installedVersions, summarizeAptOutput };
