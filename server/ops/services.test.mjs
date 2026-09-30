import { describe, expect, it, vi } from "vitest";
import { isCriticalUnit, mergeUnitLists, serviceOperations } from "./services.mjs";
import { createRegistry } from "./registry.mjs";

const registry = createRegistry([serviceOperations]);

describe("service operations", () => {
  it("marks critical units and merges unit lists", () => {
    expect(isCriticalUnit("boxpilot.service")).toBe(true);
    expect(isCriticalUnit("ssh.service")).toBe(true);
    expect(isCriticalUnit("systemd-resolved.service")).toBe(true);
    expect(isCriticalUnit("docker.service")).toBe(false);
    const merged = mergeUnitLists(JSON.stringify([{ unit: "docker.service", description: "Docker", load: "loaded", active: "active", sub: "running" }, { unit: "weird name", description: "x" }]), JSON.stringify([{ unit_file: "docker.service", state: "enabled" }, { unit_file: "cron.service", state: "disabled" }, { unit_file: "getty@.service", state: "enabled-runtime" }]));
    expect(merged).toEqual([
      { unit: "cron.service", description: "", load: "not-loaded", active: "inactive", sub: "dead", enabled: "disabled", guarded: null, critical: false },
      { unit: "docker.service", description: "Docker", load: "loaded", active: "active", sub: "running", enabled: "enabled", guarded: null, critical: false },
    ]);
  });

  it("lists, reads journals, and controls units; refuses to stop protected units", async () => {
    const run = vi.fn(async (binary, args) => {
      if (args[0] === "list-units") return { ok: true, stdout: JSON.stringify([{ unit: "docker.service", description: "Docker", load: "loaded", active: "active", sub: "running" }]), stderr: "" };
      if (args[0] === "list-unit-files") return { ok: true, stdout: JSON.stringify([{ unit_file: "docker.service", state: "enabled" }]), stderr: "" };
      if (binary.endsWith("journalctl")) return { ok: true, stdout: "2026-08-19 line one password=abc\n2026-08-19 line two", stderr: "" };
      if (args[0] === "show") return { ok: true, stdout: "ActiveState=active\nSubState=running\nUnitFileState=enabled\nResult=success", stderr: "" };
      return { ok: true, stdout: "", stderr: "" };
    });
    await expect(registry.execute("service.list", {}, { run })).resolves.toMatchObject({ counts: { total: 1, active: 1, failed: 0 }, units: [{ unit: "docker.service", enabled: "enabled" }] });
    await expect(registry.execute("service.journal", { unit: "docker.service", lines: 10 }, { run })).resolves.toEqual({ unit: "docker.service", lines: ["2026-08-19 line one password=[REDACTED]", "2026-08-19 line two"] });
    await expect(registry.execute("service.action", { unit: "docker.service", action: "restart" }, { run })).resolves.toMatchObject({ unit: "docker.service", action: "restart", activeState: "active" });
    expect(run).toHaveBeenCalledWith(expect.stringContaining("systemctl"), ["restart", "docker.service"], expect.anything());
    await expect(registry.execute("service.action", { unit: "ssh.service", action: "stop" }, { run })).rejects.toThrow("protected");
    await expect(registry.execute("service.action", { unit: "boxpilot-helper.service", action: "disable" }, { run })).rejects.toThrow("protected");
    await expect(registry.execute("service.action", { unit: "ssh.service", action: "restart" }, { run })).resolves.toMatchObject({ action: "restart" });
    await expect(registry.execute("service.action", { unit: "../../etc/passwd", action: "start" }, { run })).rejects.toThrow("invalid value");
    await expect(registry.execute("service.action", { unit: "docker.service", action: "mask" }, { run })).rejects.toThrow("must be one of");
  });
});

describe("units with a high-risk equivalent", () => {
  it("refuses to stop or disable ufw and fail2ban from the Services page", async () => {
    const { registry } = await import("./index.mjs");
    const action = registry.get("service.action");
    const run = async (unit, act) => action.run({ unit, action: act }, { run: async () => ({ ok: true, stdout: "", stderr: "" }), progress: () => {} });
    await expect(run("ufw.service", "disable")).rejects.toThrow("Firewall page");
    await expect(run("fail2ban.service", "stop")).rejects.toThrow("Firewall page");
    await expect(run("ssh.service", "stop")).rejects.toThrow("protected");
    // Restarting them is still fine — that is not a way around the firewall's own approval.
    await expect(run("ufw.service", "restart")).resolves.toBeTruthy();
  });

  it("leaves a drive or share under /mnt to Storage, whose operations prove the mount and stop its apps", async () => {
    const { registry } = await import("./index.mjs");
    const action = registry.get("service.action");
    const calls = [];
    const run = async (unit, act) => action.run({ unit, action: act }, { run: async (binary, args) => { calls.push(args.join(" ")); return { ok: true, stdout: "ActiveState=active\n", stderr: "" }; }, progress: () => {} });
    for (const act of ["start", "stop", "restart"]) await expect(run("mnt-media.mount", act)).rejects.toThrow("Reconnect or unmount it from Storage or Repair");
    await expect(run("mnt-boxpilot-backup.mount", "stop")).rejects.toThrow("drive or share under /mnt");
    expect(calls).toEqual([]);
    await expect(run("var-lib-docker.mount", "restart")).resolves.toMatchObject({ activeState: "active" });
  });

  it("fails a start that systemd reports failed, which systemctl start of a simple service does not", async () => {
    const { registry } = await import("./index.mjs");
    const action = registry.get("service.action");
    const run = async (binary, args) => (args[0] === "show" ? { ok: true, stdout: "ActiveState=failed\nSubState=failed\nResult=exit-code\n", stderr: "" } : { ok: true, stdout: "", stderr: "" });
    await expect(action.run({ unit: "gitea.service", action: "start" }, { run, progress: () => {} })).rejects.toThrow("gitea.service did not stay up after the start: systemd reports it failed (exit-code)");
    await expect(action.run({ unit: "gitea.service", action: "stop" }, { run, progress: () => {} })).resolves.toMatchObject({ activeState: "failed" });
  });
});
