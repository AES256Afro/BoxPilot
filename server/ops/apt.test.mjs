import { describe, expect, it, vi } from "vitest";
import { aptOperations, curatedPackages, parseAutoUpgrades, parseDpkgQuery, parseNeedrestart, parseSourceMap, parseUpgradable } from "./apt.mjs";
import { createRegistry } from "./registry.mjs";

const registry = createRegistry([aptOperations]);

describe("apt operations", () => {
  it("parses apt list --upgradable output", () => {
    const output = "Listing...\nlibssl3t64/noble-security 3.0.13-0ubuntu3.5 amd64 [upgradable from: 3.0.13-0ubuntu3.4]\nhtop/noble 3.3.0-4 amd64 [upgradable from: 3.2.2-2]\nnoise line\n";
    expect(parseUpgradable(output)).toEqual([
      { name: "htop", suite: "noble", candidate: "3.3.0-4", architecture: "amd64", installed: "3.2.2-2" },
      { name: "libssl3t64", suite: "noble-security", candidate: "3.0.13-0ubuntu3.5", architecture: "amd64", installed: "3.0.13-0ubuntu3.4" },
    ]);
  });

  it("inspects upgradable packages in the helper and routes mutations through the root runner", async () => {
    const run = vi.fn(async () => ({ ok: true, stdout: "htop/noble 3.3.0-4 amd64 [upgradable from: 3.2.2-2]\nx/noble-security 2 amd64 [upgradable from: 1]", stderr: "" }));
    await expect(registry.execute("apt.upgradable.inspect", {}, { run })).resolves.toMatchObject({ count: 2, securityCount: 1 });
    const runUnit = { runTask: vi.fn(async (task, parameters) => ({ task, parameters })) };
    await expect(registry.execute("apt.upgrade", {}, { runUnit })).resolves.toEqual({ task: "apt.upgrade", parameters: { packages: null, refreshFirst: true } });
    await expect(registry.execute("apt.upgrade", { packages: ["htop"], refreshFirst: false }, { runUnit })).resolves.toEqual({ task: "apt.upgrade", parameters: { packages: ["htop"], refreshFirst: false } });
    await expect(registry.execute("apt.install", { packages: ["git", "htop"] }, { runUnit })).resolves.toMatchObject({ task: "apt.install", parameters: { packages: ["git", "htop"] } });
    await expect(registry.execute("apt.remove", { packages: ["git"] }, { runUnit })).resolves.toMatchObject({ task: "apt.remove", parameters: { purge: false } });
    await expect(registry.execute("apt.purge", { packages: ["git"] }, { runUnit })).resolves.toMatchObject({ task: "apt.remove", parameters: { purge: true } });
    await expect(registry.execute("apt.autoremove", {}, { runUnit })).resolves.toMatchObject({ task: "apt.autoremove" });
  });

  it("maps binary packages to sources and parses needrestart batch output", () => {
    expect(parseSourceMap("libssl3t64\topenssl\nhtop\thtop\nweird\tsrc (1.2-3)\n")).toEqual({ libssl3t64: "openssl", htop: "htop", weird: "src" });
    expect(parseNeedrestart("NEEDRESTART-VER: 3.6\nNEEDRESTART-KCUR: 6.8\nNEEDRESTART-SVC: ssh.service\nNEEDRESTART-SVC: cron.service\nNEEDRESTART-SVC: ssh.service\n"))
      .toEqual(["cron.service", "ssh.service"]);
    expect(parseNeedrestart("")).toEqual([]);
  });

  it("parses 20auto-upgrades and dpkg-query output", () => {
    expect(parseAutoUpgrades('APT::Periodic::Update-Package-Lists "1";\nAPT::Periodic::Unattended-Upgrade "1";\n')).toEqual({ updateLists: "1", unattendedUpgrade: "1" });
    expect(parseAutoUpgrades("")).toEqual({ updateLists: null, unattendedUpgrade: null });
    expect(parseDpkgQuery("htop\tinstall ok installed\t3.3.0-4\ngit\tdeinstall ok config-files\t2.43\n")).toEqual({ htop: "3.3.0-4" });
  });

  it("reports curated tool state from dpkg-query and stages the unattended toggle", async () => {
    const run = vi.fn(async () => ({ ok: false, stdout: "htop\tinstall ok installed\t3.3.0-4\n", stderr: "no packages found matching restic" }));
    const report = await registry.execute("packages.curated.inspect", {}, { run });
    expect(report.packages.find((entry) => entry.name === "htop")).toEqual({ name: "htop", installed: true, version: "3.3.0-4" });
    expect(report.packages.find((entry) => entry.name === "restic")).toEqual({ name: "restic", installed: false, version: null });
    expect(report.packages).toHaveLength(curatedPackages.length);
    const runUnit = { runTask: vi.fn(async (task, parameters) => ({ task, parameters })) };
    await expect(registry.execute("apt.unattended.set", { enabled: true }, { runUnit })).resolves.toEqual({ task: "apt.unattended", parameters: { enabled: true } });
    await expect(registry.execute("apt.unattended.set", { enabled: "yes" }, { runUnit })).rejects.toThrow("boolean");
  });

  it("rejects bad parameters before anything runs", async () => {
    const runUnit = { runTask: vi.fn() };
    await expect(registry.execute("apt.install", {}, { runUnit })).rejects.toThrow('requires parameter "packages"');
    await expect(registry.execute("apt.install", { packages: ["a b"] }, { runUnit })).rejects.toThrow("invalid package name");
    await expect(registry.execute("apt.install", { packages: ["git"], shell: "sh" }, { runUnit })).rejects.toThrow('does not accept parameter "shell"');
    await expect(registry.execute("apt.autoremove", { force: true }, { runUnit })).rejects.toThrow("accepts no parameters");
    expect(runUnit.runTask).not.toHaveBeenCalled();
    expect(registry.get("apt.purge").risk).toBe("high");
    expect(registry.get("apt.upgradable.inspect").readOnly).toBe(true);
  });
});
