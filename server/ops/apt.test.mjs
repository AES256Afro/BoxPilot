import { describe, expect, it, vi } from "vitest";
import { aptOperations, parseUpgradable } from "./apt.mjs";
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
