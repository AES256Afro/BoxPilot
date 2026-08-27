/**
 * Root-side APT tasks executed by scripts/boxpilot-run.mjs inside boxpilot-run@.service
 * (which has network access, unlike the helper). Each task validates its own parameters
 * again — the spec file is written by the helper, but defense in depth is cheap.
 */
import { access, writeFile } from "node:fs/promises";
import { fixedRun } from "../exec.mjs";
import { parseNeedrestart } from "../ops/apt.mjs";

export const packageNamePattern = /^[a-z0-9][a-z0-9+.-]{0,99}$/;
const aptGet = "/usr/bin/apt-get";
const needrestartBinary = "/usr/sbin/needrestart";
const systemctl = "/usr/bin/systemctl";
const systemdRun = "/usr/bin/systemd-run";
/**
 * apt runs with needrestart's hook suspended (NEEDRESTART_SUSPEND is its documented off switch).
 *
 * Ubuntu server ships needrestart in automatic mode: after an upgrade it restarts every service
 * whose libraries changed, and BoxPilot's own services are such services whenever libc or openssl
 * moves. So the upgrade job killed the web process that was waiting on it, startup recovery marked
 * the job failed, and the owner was shown a failed upgrade that had in fact succeeded — every
 * time an upgrade mattered. Seen live at 11:12:32 on a real machine: the task logged "completed"
 * one second after the service waiting for it was stopped.
 *
 * Suspending the hook does not mean skipping the restarts. The task takes them over after apt is
 * done: everything else immediately, BoxPilot itself on a short detached timer, so its restart
 * lands after the job's result has been recorded instead of in the middle of it.
 */
const aptEnvironment = { NEEDRESTART_SUSPEND: "1", DEBIAN_FRONTEND: "noninteractive" };

/** Restart what the upgrade left stale: everything now, BoxPilot itself after the job has landed. */
async function restartStaleServices(run, log = null) {
  const present = await run(needrestartBinary, ["--help"], { timeout: 15_000 }).then((result) => result.ok, () => false);
  if (!present) return { servicesNeedingRestart: null, servicesRestarted: [], selfRestartScheduled: false };
  const scan = await run(needrestartBinary, ["-b"], { timeout: 120_000, maxBuffer: 2 * 1024 * 1024 });
  if (!scan.ok) return { servicesNeedingRestart: null, servicesRestarted: [], selfRestartScheduled: false };
  const listed = parseNeedrestart(scan.stdout);
  const own = listed.filter((unit) => /^boxpilot(-helper)?\.service$/.test(unit));
  const others = listed.filter((unit) => !own.includes(unit));
  const restarted = [];
  for (const unit of others) {
    const result = await run(systemctl, ["restart", unit], { timeout: 120_000 });
    if (result.ok) { restarted.push(unit); log?.(`Restarted ${unit}, which was running pre-upgrade libraries`, "stdout"); }
    else log?.(`Could not restart ${unit}: ${result.stderr.split("\n").slice(-1)[0]}`, "stderr");
  }
  let selfRestartScheduled = false;
  if (own.length) {
    // Detached on purpose: this restart must land after the job has recorded its result, and the
    // transient timer survives everything between here and there.
    const schedule = await run(systemdRun, ["--on-active=30", "--unit=boxpilot-restart-after-upgrade", "--description=Restart BoxPilot to pick up upgraded libraries (scheduled by the upgrade job it would otherwise have interrupted)", systemctl, "restart", ...own], { timeout: 30_000 });
    selfRestartScheduled = schedule.ok;
    log?.(schedule.ok
      ? "BoxPilot itself is running pre-upgrade libraries; it restarts in 30 seconds, after this job has finished recording."
      : `BoxPilot needs a restart to pick up upgraded libraries, and scheduling one failed: ${schedule.stderr.split("\n").slice(-1)[0]}. Restart it from the System page.`, schedule.ok ? "stdout" : "stderr");
  }
  return { servicesNeedingRestart: listed, servicesRestarted: restarted, selfRestartScheduled };
}
const dpkgQuery = "/usr/bin/dpkg-query";
const rebootRequiredPath = "/run/reboot-required";

/** Wrap a runner so every command streams its output to `log` (if given). */
function withLog(run, log) {
  if (typeof log !== "function") return run;
  return (binary, args, options = {}) => {
    log(`$ ${[binary, ...args].join(" ")}`, "stdout");
    return run(binary, args, { ...options, onLine: log });
  };
}

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

/**
 * Finish any interrupted dpkg run and repair unmet dependencies (both idempotent no-ops on a
 * healthy system). apt refuses to upgrade/install while packages are half-configured or broken,
 * so every mutation runs this first instead of telling the operator to use a terminal.
 */
export async function repairPackageState({ run: baseRun = fixedRun, log = null } = {}) {
  const run = withLog(baseRun, log);
  // Budget: the apt.upgrade task allows 180 min; these inner limits sum to less so a stuck step fails inside the job instead of outliving it.
  const configure = await run("/usr/bin/dpkg", ["--configure", "-a"], { timeout: 20 * 60_000, maxBuffer: 8 * 1024 * 1024 });
  const fixBroken = await run(aptGet, ["install", "--fix-broken", "--yes"], { timeout: 30 * 60_000, maxBuffer: 8 * 1024 * 1024, env: aptEnvironment });
  return {
    ok: configure.ok && fixBroken.ok,
    configured: configure.ok,
    fixedBroken: fixBroken.ok,
    detail: [configure, fixBroken].filter((result) => !result.ok).map((result) => result.stderr.split("\n").slice(-2).join(" ")).join(" | ") || null,
  };
}


/** `apt-get update`. */
export async function aptUpdate(_parameters = {}, { run: baseRun = fixedRun, log = null } = {}) {
  const run = withLog(baseRun, log);
  const result = await run(aptGet, ["update"], { timeout: 10 * 60_000, env: aptEnvironment });
  if (!result.ok) throw new Error(`apt-get update failed: ${result.stderr.split("\n").slice(-3).join(" ")}`);
  return { updated: true, rebootRequired: await rebootRequired() };
}

/** Upgrade everything (`--with-new-pkgs upgrade`) or only the listed packages (`install --only-upgrade`). */
export async function aptUpgrade({ packages = null, refreshFirst = true } = {}, { run: baseRun = fixedRun, log = null } = {}) {
  const run = withLog(baseRun, log);
  if (packages !== null) { const problem = validPackageList(packages); if (problem) throw new Error(`packages ${problem}`); }
  const repair = await repairPackageState({ run });
  if (refreshFirst) await aptUpdate({}, { run });
  const before = packages ? await installedVersions(run, packages) : {};
  const args = packages ? ["install", "--yes", "--only-upgrade", ...packages] : ["upgrade", "--yes", "--with-new-pkgs"];
  const result = await run(aptGet, args, { timeout: 110 * 60_000, maxBuffer: 8 * 1024 * 1024, env: aptEnvironment });
  if (!result.ok) throw new Error(`apt-get ${args[0]} failed: ${result.stderr.split("\n").slice(-3).join(" ")}`);
  const after = packages ? await installedVersions(run, packages) : {};
  const staleness = await restartStaleServices(run, log);
  return { upgraded: true, scope: packages ? "selected" : "all", packages: packages ?? [], before, after, summary: summarizeAptOutput(result.stdout), packageStateRepaired: repair.ok, rebootRequired: await rebootRequired(), ...staleness };
}

/** Install packages without recommends. */
export async function aptInstall({ packages, refreshFirst = true } = {}, { run: baseRun = fixedRun, log = null } = {}) {
  const run = withLog(baseRun, log);
  const problem = validPackageList(packages); if (problem) throw new Error(`packages ${problem}`);
  await repairPackageState({ run });
  if (refreshFirst) await aptUpdate({}, { run });
  const before = await installedVersions(run, packages);
  const result = await run(aptGet, ["install", "--yes", "--no-install-recommends", ...packages], { timeout: 60 * 60_000, maxBuffer: 8 * 1024 * 1024, env: aptEnvironment });
  if (!result.ok) throw new Error(`apt-get install failed: ${result.stderr.split("\n").slice(-3).join(" ")}`);
  const after = await installedVersions(run, packages);
  const missing = packages.filter((name) => !after[name]);
  if (missing.length) throw new Error(`apt-get reported success but ${missing.join(", ")} is not installed`);
  const staleness = await restartStaleServices(run, log);
  return { installed: true, packages, before, after, summary: summarizeAptOutput(result.stdout), rebootRequired: await rebootRequired(), ...staleness };
}

/** Remove (or purge) packages, then autoremove what they pulled in. */
export async function aptRemove({ packages, purge = false, autoremove = true } = {}, { run: baseRun = fixedRun, log = null } = {}) {
  const run = withLog(baseRun, log);
  const problem = validPackageList(packages); if (problem) throw new Error(`packages ${problem}`);
  await repairPackageState({ run });
  const before = await installedVersions(run, packages);
  const result = await run(aptGet, [purge ? "purge" : "remove", "--yes", ...(autoremove ? ["--auto-remove"] : []), ...packages], { timeout: 30 * 60_000, maxBuffer: 8 * 1024 * 1024, env: aptEnvironment });
  if (!result.ok) throw new Error(`apt-get ${purge ? "purge" : "remove"} failed: ${result.stderr.split("\n").slice(-3).join(" ")}`);
  const after = await installedVersions(run, packages);
  const remaining = packages.filter((name) => after[name]);
  if (remaining.length) throw new Error(`apt-get reported success but ${remaining.join(", ")} is still installed`);
  return { removed: true, purged: purge, packages, before, after, summary: summarizeAptOutput(result.stdout), rebootRequired: await rebootRequired() };
}

/** `apt-get autoremove --purge`. */
export async function aptAutoremove(_parameters = {}, { run: baseRun = fixedRun, log = null } = {}) {
  const run = withLog(baseRun, log);
  const result = await run(aptGet, ["autoremove", "--yes", "--purge"], { timeout: 30 * 60_000, maxBuffer: 8 * 1024 * 1024, env: aptEnvironment });
  if (!result.ok) throw new Error(`apt-get autoremove failed: ${result.stderr.split("\n").slice(-3).join(" ")}`);
  return { autoremoved: true, summary: summarizeAptOutput(result.stdout), rebootRequired: await rebootRequired() };
}

const autoUpgradesPath = "/etc/apt/apt.conf.d/20auto-upgrades";

/** Turn nightly unattended security upgrades on or off, installing the package when needed. */
export async function aptUnattendedSet({ enabled } = {}, { run: baseRun = fixedRun, log = null, files = { writeFile }, exists = (target) => access(target).then(() => true, () => false) } = {}) {
  if (typeof enabled !== "boolean") throw new Error("enabled must be true or false");
  const run = withLog(baseRun, log);
  let installedNow = false;
  if (enabled && !(await exists("/usr/bin/unattended-upgrade"))) {
    await repairPackageState({ run });
    const install = await run(aptGet, ["install", "--yes", "--no-install-recommends", "unattended-upgrades"], { timeout: 30 * 60_000, maxBuffer: 8 * 1024 * 1024 , env: aptEnvironment });
    if (!install.ok) throw new Error(`Could not install unattended-upgrades: ${install.stderr.split("\n").slice(-3).join(" ")}`);
    installedNow = true;
  }
  const value = enabled ? "1" : "0";
  await files.writeFile(autoUpgradesPath, `APT::Periodic::Update-Package-Lists "${value}";\nAPT::Periodic::Unattended-Upgrade "${value}";\n`);
  log?.(`Wrote ${autoUpgradesPath} with Unattended-Upgrade "${value}"`, "stdout");
  return { enabled, installedNow, configPath: autoUpgradesPath };
}

export const aptTaskInternals = { installedVersions, summarizeAptOutput };
