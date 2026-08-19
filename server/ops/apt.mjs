import { access } from "node:fs/promises";
import { defineOperation } from "./registry.mjs";
import { validPackageList } from "../tasks/apt.mjs";

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
      id: "apt.upgradable.inspect", title: "List available package updates", risk: "low", readOnly: true,
      description: "Reads APT's view of upgradable packages without touching the network or the system.",
      run: async (_parameters, { run }) => {
        const result = await run("/usr/bin/apt", ["list", "--upgradable"], { timeout: 60_000, maxBuffer: 4 * 1024 * 1024 });
        if (!result.ok) throw new Error(`apt list failed: ${result.stderr.split("\n").slice(-2).join(" ")}`);
        const upgradable = parseUpgradable(result.stdout);
        const security = upgradable.filter((item) => /security/i.test(item.suite)).length;
        return { upgradable, count: upgradable.length, securityCount: security, rebootRequired: await rebootRequired() };
      },
    }),
    defineOperation({
      id: "apt.refresh", title: "Refresh package lists", risk: "low", timeoutMs: minutes(15),
      description: "Runs apt-get update so the list of available updates is current. Installs nothing.",
      run: (_parameters, { runUnit, jobLog }) => runUnit.runTask("apt.update", {}, { timeoutMs: minutes(10), logPath: jobLog?.path ?? null }),
    }),
    defineOperation({
      id: "apt.upgrade", title: "Install package updates", risk: "medium", timeoutMs: minutes(70),
      description: "Runs apt-get update then upgrades every package, or only the selected ones.",
      parameters: { fields: { packages: optionalPackagesField, refreshFirst: refreshField } },
      run: (parameters, { runUnit, jobLog }) => runUnit.runTask("apt.upgrade", { packages: parameters.packages ?? null, refreshFirst: parameters.refreshFirst ?? true }, { timeoutMs: minutes(65), logPath: jobLog?.path ?? null }),
    }),
    defineOperation({
      id: "apt.install", title: "Install packages", risk: "medium", timeoutMs: minutes(70),
      description: "Installs the listed APT packages without recommends.",
      parameters: { fields: { packages: packagesField, refreshFirst: refreshField } },
      run: (parameters, { runUnit, jobLog }) => runUnit.runTask("apt.install", { packages: parameters.packages, refreshFirst: parameters.refreshFirst ?? true }, { timeoutMs: minutes(65), logPath: jobLog?.path ?? null }),
    }),
    defineOperation({
      id: "apt.remove", title: "Remove packages", risk: "medium", timeoutMs: minutes(40),
      description: "Removes the listed packages and autoremoves what only they needed; configuration files are kept.",
      parameters: { fields: { packages: packagesField } },
      run: (parameters, { runUnit, jobLog }) => runUnit.runTask("apt.remove", { packages: parameters.packages, purge: false, autoremove: true }, { timeoutMs: minutes(35), logPath: jobLog?.path ?? null }),
    }),
    defineOperation({
      id: "apt.purge", title: "Purge packages", risk: "high", timeoutMs: minutes(40),
      description: "Removes the listed packages including their configuration files.",
      parameters: { fields: { packages: packagesField } },
      run: (parameters, { runUnit, jobLog }) => runUnit.runTask("apt.remove", { packages: parameters.packages, purge: true, autoremove: true }, { timeoutMs: minutes(35), logPath: jobLog?.path ?? null }),
    }),
    defineOperation({
      id: "apt.autoremove", title: "Remove unused packages", risk: "medium", timeoutMs: minutes(40),
      description: "Runs apt-get autoremove --purge.",
      run: (_parameters, { runUnit, jobLog }) => runUnit.runTask("apt.autoremove", {}, { timeoutMs: minutes(35), logPath: jobLog?.path ?? null }),
    }),
  ];
}
