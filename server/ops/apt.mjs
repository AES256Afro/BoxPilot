import { access, readFile } from "node:fs/promises";
import { defineOperation } from "./registry.mjs";
import { validPackageList } from "../tasks/apt.mjs";
import { needrestartScanner } from "../needrestart.mjs";
import { inspectPackageHealth } from "../package-health.mjs";
export { parseNeedrestart } from "../needrestart.mjs";

/** Common server tools offered on the Updates & packages page (M2.2). */
/** Package work changes what needs restarting: the next inspection must ask again. */
export function clearNeedrestartCache() { needrestartScanner.forget(); }
/** Run a package task, then forget what needed restarting before it. */
const withCacheReset = (task) => task.finally(() => clearNeedrestartCache());

export const curatedPackages = Object.freeze([
  "htop", "btop", "tmux", "git", "curl", "wget", "jq", "ncdu", "tree", "ripgrep", "zsh",
  "unzip", "net-tools", "dnsutils", "iotop", "smartmontools", "restic", "nfs-common", "cifs-utils", "smbclient", "samba", "nfs-kernel-server", "nut", "fail2ban", "rclone", "needrestart",
]);

/** Parse `APT::Periodic::<name> "<value>";` lines from 20auto-upgrades. */
export function parseAutoUpgrades(content) {
  const value = (name) => String(content ?? "").match(new RegExp(`APT::Periodic::${name}\\s+"(\\d+)"`, "i"))?.[1] ?? null;
  return { updateLists: value("Update-Package-Lists"), unattendedUpgrade: value("Unattended-Upgrade") };
}

/** Parse `dpkg-query -W -f'${Package}\\t${Status}\\t${Version}\\n'` output. */
export function parseDpkgQuery(stdout) {
  const installed = {};
  for (const line of String(stdout ?? "").split("\n")) {
    const [name, status, version] = line.split("\t");
    if (name && status === "install ok installed") installed[name] = version ?? "";
  }
  return installed;
}

/** Parse `dpkg-query -W -f'${Package}\\t${source:Package}\\n'`: binary → source package. */
export function parseSourceMap(stdout) {
  const sources = {};
  for (const line of String(stdout ?? "").split("\n")) {
    const [name, source] = line.split("\t");
    if (name) sources[name] = (source ?? name).split(" ")[0] || name;
  }
  return sources;
}

const minutes = (value) => value * 60_000;
const packagesField = { type: "array", validate: (value) => validPackageList(value) };
const optionalPackagesField = { type: "array", optional: true, nullable: true, validate: (value) => validPackageList(value) };
const refreshField = { type: "boolean", optional: true };

/** Parse `apt list --upgradable` lines: `name/suite newver arch [upgradable from: old]`. */
export function parseUpgradable(stdout) {
  const items = [];
  for (const line of String(stdout ?? "").split("\n")) {
    const match = line.match(/^([^/\s]+)\/(\S+)\s+(\S+)\s+(\S+)\s+\[upgradable from:\s*([^\]]+)\]/);
    if (match) items.push({ name: match[1], suite: match[2], candidate: match[3], architecture: match[4], installed: match[5].trim() });
  }
  return items.sort((a, b) => a.name.localeCompare(b.name));
}

async function rebootRequired() {
  try { await access("/run/reboot-required"); return true; } catch { return false; }
}

/** APT operations. Mutations run through the generic root runner (`runUnit`); inspection runs in the helper. */
export function aptOperations() {
  return [
    defineOperation({
      id: "apt.health.inspect", title: "Check package recovery", risk: "low", readOnly: true, minimumRole: "operator", timeoutMs: 90_000,
      description: "Checks interrupted package configuration, dependency repair and active package-manager locks.",
      run: (_parameters, { run }) => inspectPackageHealth({ run }),
    }),
    defineOperation({
      id: "apt.repair", title: "Repair interrupted packages", risk: "medium", minimumRole: "operator", timeoutMs: minutes(60),
      description: "Finishes pending package configuration and installs missing dependencies, then verifies the package database. Package scripts may restart services. Stops if dependency repair requires package removal.",
      run: (_parameters, { runUnit, jobLog }) => withCacheReset(runUnit.runTask("apt.repair", {}, { timeoutMs: minutes(55), logPath: jobLog?.path ?? null })),
    }),
    defineOperation({
      id: "system.manager.reexec", title: "Refresh systemd manager", risk: "medium", timeoutMs: 60_000,
      description: "Re-executes the systemd manager to pick up upgraded libraries while preserving its state.",
      run: async (_parameters, { run, progress }) => {
        progress?.("$ systemctl daemon-reexec", "stdout");
        const result = await run("/usr/bin/systemctl", ["daemon-reexec"], { timeout: 45_000 });
        if (!result.ok) throw new Error(`systemctl daemon-reexec failed: ${result.stderr || "see the system journal"}`);
        clearNeedrestartCache();
        return { reexecuted: true };
      },
    }),
    defineOperation({
      id: "apt.upgradable.inspect", title: "List available package updates", risk: "low", readOnly: true, timeoutMs: 3 * 60_000,
      description: "Reads APT's view of upgradable packages, plus which running services still use pre-upgrade libraries (needrestart, when installed).",
      run: async (_parameters, { run }) => {
        const result = await run("/usr/bin/apt", ["list", "--upgradable"], { timeout: 60_000, maxBuffer: 4 * 1024 * 1024 });
        if (!result.ok) throw new Error(`apt list failed: ${result.stderr.split("\n").slice(-2).join(" ")}`);
        const upgradable = parseUpgradable(result.stdout);
        const security = upgradable.filter((item) => /security/i.test(item.suite)).length;
        if (upgradable.length) {
          const sources = await run("/usr/bin/dpkg-query", ["-W", "-f", "${Package}\\t${source:Package}\\n", ...upgradable.map((item) => item.name)], { timeout: 30_000, maxBuffer: 2 * 1024 * 1024 });
          const map = parseSourceMap(sources.stdout);
          for (const item of upgradable) item.source = map[item.name] ?? item.name;
        }
        const needrestartPresent = await access("/usr/sbin/needrestart").then(() => true, () => false);
        const restartScan = needrestartPresent ? await needrestartScanner.inspect(run).catch(() => null) : null;
        return { upgradable, count: upgradable.length, securityCount: security, rebootRequired: await rebootRequired(), needrestartPresent, servicesNeedingRestart: restartScan?.services ?? null, needrestartCheckedAt: restartScan?.checkedAt ?? null };

      },
    }),
    defineOperation({
      id: "apt.refresh", title: "Refresh package lists", risk: "low", timeoutMs: minutes(15),
      description: "Runs apt-get update so the list of available updates is current. Installs nothing.",
      run: (_parameters, { runUnit, jobLog }) => runUnit.runTask("apt.update", {}, { timeoutMs: minutes(10), logPath: jobLog?.path ?? null }),
    }),
    defineOperation({
      id: "apt.upgrade", title: "Install package updates", risk: "medium", timeoutMs: minutes(185),
      description: "Runs apt-get update then upgrades every package, or only the selected ones.",
      parameters: { fields: { packages: optionalPackagesField, refreshFirst: refreshField } },
      run: (parameters, { runUnit, jobLog }) => withCacheReset(runUnit.runTask("apt.upgrade", { packages: parameters.packages ?? null, refreshFirst: parameters.refreshFirst ?? true }, { timeoutMs: minutes(180), logPath: jobLog?.path ?? null })),
    }),
    defineOperation({
      id: "apt.install", title: "Install packages", risk: "medium", timeoutMs: minutes(70),
      description: "Installs the listed APT packages without recommends.",
      parameters: { fields: { packages: packagesField, refreshFirst: refreshField } },
      run: (parameters, { runUnit, jobLog }) => withCacheReset(runUnit.runTask("apt.install", { packages: parameters.packages, refreshFirst: parameters.refreshFirst ?? true }, { timeoutMs: minutes(65), logPath: jobLog?.path ?? null })),
    }),
    defineOperation({
      id: "apt.remove", title: "Remove packages", risk: "medium", timeoutMs: minutes(40),
      description: "Removes the listed packages and autoremoves what only they needed; configuration files are kept.",
      parameters: { fields: { packages: packagesField } },
      run: (parameters, { runUnit, jobLog }) => withCacheReset(runUnit.runTask("apt.remove", { packages: parameters.packages, purge: false, autoremove: true }, { timeoutMs: minutes(35), logPath: jobLog?.path ?? null })),
    }),
    defineOperation({
      id: "apt.purge", title: "Purge packages", risk: "high", timeoutMs: minutes(40),
      description: "Removes the listed packages including their configuration files.",
      parameters: { fields: { packages: packagesField } },
      run: (parameters, { runUnit, jobLog }) => withCacheReset(runUnit.runTask("apt.remove", { packages: parameters.packages, purge: true, autoremove: true }, { timeoutMs: minutes(35), logPath: jobLog?.path ?? null })),
    }),
    defineOperation({
      id: "apt.autoremove", title: "Remove unused packages", risk: "medium", timeoutMs: minutes(40),
      description: "Runs apt-get autoremove --purge.",
      run: (_parameters, { runUnit, jobLog }) => withCacheReset(runUnit.runTask("apt.autoremove", {}, { timeoutMs: minutes(35), logPath: jobLog?.path ?? null })),
    }),
    defineOperation({
      id: "apt.unattended.inspect", title: "Read automatic update settings", risk: "low", readOnly: true,
      description: "Whether unattended-upgrades is installed and the nightly security upgrade is switched on.",
      run: async () => {
        const installed = await access("/usr/bin/unattended-upgrade").then(() => true, () => false);
        const config = parseAutoUpgrades(await readFile("/etc/apt/apt.conf.d/20auto-upgrades", "utf8").catch(() => ""));
        return { installed, enabled: installed && config.unattendedUpgrade === "1", config };
      },
    }),
    defineOperation({
      id: "apt.unattended.set", title: "Change automatic security updates", risk: "medium", timeoutMs: minutes(40),
      description: "Turns nightly unattended security upgrades on or off, installing unattended-upgrades first when needed.",
      parameters: { fields: { enabled: { type: "boolean" } } },
      run: (parameters, { runUnit, jobLog }) => runUnit.runTask("apt.unattended", { enabled: parameters.enabled }, { timeoutMs: minutes(35), logPath: jobLog?.path ?? null }),
    }),
    defineOperation({
      id: "packages.curated.inspect", title: "Read common tool state", risk: "low", readOnly: true,
      description: "Which of the curated common server tools are installed, and their versions.",
      run: async (_parameters, { run }) => {
        const result = await run("/usr/bin/dpkg-query", ["-W", "-f", "${Package}\\t${Status}\\t${Version}\\n", ...curatedPackages], { timeout: 30_000, maxBuffer: 2 * 1024 * 1024 });
        const installed = parseDpkgQuery(result.stdout);
        return { packages: curatedPackages.map((name) => ({ name, installed: name in installed, version: installed[name] ?? null })) };
      },
    }),
  ];
}
