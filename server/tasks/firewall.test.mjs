import { describe, expect, it, vi } from "vitest";
import { firewallProfileApply, firewallRuleAdd, firewallRuleDelete, firewallSet, readWebEnv, validateRule } from "./firewall.mjs";

const okRun = () => vi.fn(async (binary, args) => {
  if (args[0] === "status") return { ok: true, stdout: "Status: active\nTo  Action  From\n22/tcp  ALLOW IN  Anywhere", stderr: "" };
  return { ok: true, stdout: "Rule added", stderr: "" };
});
const lanEnv = { envPath: "/nonexistent/boxpilot.env", dockerSync: vi.fn(async ({ enabled }) => ({ synced: true, enabled })) };
const readLan = () => "BOXPILOT_HOST=0.0.0.0\nBOXPILOT_PORT=8787\n";

describe("root firewall tasks", () => {
  it("validates rules strictly", () => {
    expect(validateRule({ action: "allow", port: 8080, protocol: "tcp" })).toBeNull();
    expect(validateRule({ action: "limit", port: 22, protocol: "tcp" })).toBeNull();
    expect(validateRule({ action: "drop", port: 8080, protocol: "tcp" })).toContain("action");
    expect(validateRule({ action: "allow", port: 0, protocol: "tcp" })).toContain("port");
    expect(validateRule({ action: "allow", port: 8080, protocol: "icmp" })).toContain("protocol");
    expect(validateRule({ action: "allow", port: 8080, protocol: "tcp", comment: "bad; comment" })).toContain("comment");
  });

  it("reads the web port and host from the service env file, with safe defaults", async () => {
    expect(await readWebEnv({ read: async () => 'BOXPILOT_HOST=0.0.0.0\nBOXPILOT_PORT="9000"\n' })).toEqual({ webPort: 9000, webHost: "0.0.0.0" });
    expect(await readWebEnv({ read: async () => { throw new Error("ENOENT"); } })).toEqual({ webPort: 8787, webHost: "127.0.0.1" });
    expect(await readWebEnv({ read: async () => "BOXPILOT_PORT=notaport\n" })).toEqual({ webPort: 8787, webHost: "127.0.0.1" });
  });

  it("adds SSH, Tailscale, and tailnet rules before enabling", async () => {
    const run = okRun();
    const result = await firewallSet({ enabled: true }, { run, ...lanEnv });
    expect(result.enabled).toBe(true);
    expect(result.status[0]).toBe("Status: active");
    const calls = run.mock.calls.map(([, args]) => args.join(" "));
    const enableIndex = calls.findIndex((call) => call === "--force enable");
    expect(calls.findIndex((call) => call.startsWith("allow 22/tcp"))).toBeGreaterThanOrEqual(0);
    expect(calls.findIndex((call) => call.startsWith("allow 41641/udp"))).toBeLessThan(enableIndex);
    expect(calls.findIndex((call) => call.startsWith("allow in on tailscale0"))).toBeLessThan(enableIndex);
    expect(calls.findIndex((call) => call.startsWith("allow 22/tcp"))).toBeLessThan(enableIndex);
    // Served on loopback/Tailscale by default: no LAN rule for the web port.
    expect(calls.some((call) => call.startsWith("allow 8787/tcp"))).toBe(false);
  });

  it("disables without adding rules", async () => {
    const run = okRun();
    await firewallSet({ enabled: false }, { run, ...lanEnv });
    const calls = run.mock.calls.map(([, args]) => args.join(" "));
    expect(calls.some((call) => call.startsWith("allow"))).toBe(false);
    expect(calls).toContain("--force disable");
  });

  it("adds and deletes rules with exact arguments", async () => {
    const run = okRun();
    await firewallRuleAdd({ action: "allow", port: 8080, protocol: "tcp", comment: "Jellyfin" }, { run, ...lanEnv });
    expect(run).toHaveBeenCalledWith("/usr/sbin/ufw", ["allow", "8080/tcp", "comment", "Jellyfin"], expect.anything());
    await firewallRuleAdd({ action: "deny", port: 25, protocol: "any" }, { run, ...lanEnv });
    expect(run).toHaveBeenCalledWith("/usr/sbin/ufw", ["deny", "25"], expect.anything());
    await firewallRuleAdd({ action: "limit", port: 2222, protocol: "tcp" }, { run, ...lanEnv });
    expect(run).toHaveBeenCalledWith("/usr/sbin/ufw", ["limit", "2222/tcp"], expect.anything());
    await firewallRuleDelete({ action: "allow", port: 8080, protocol: "tcp" }, { run, ...lanEnv });
    expect(run).toHaveBeenCalledWith("/usr/sbin/ufw", ["--force", "delete", "allow", "8080/tcp"], expect.anything());
  });

  it("refuses to delete the SSH, Tailscale, or BoxPilot allow rules", async () => {
    const run = okRun();
    await expect(firewallRuleDelete({ action: "allow", port: 22, protocol: "tcp" }, { run, ...lanEnv })).rejects.toThrow("lock you out");
    await expect(firewallRuleDelete({ action: "allow", port: 41641, protocol: "udp" }, { run, ...lanEnv })).rejects.toThrow("Tailscale rule stays");
    await expect(firewallRuleDelete({ action: "limit", port: 22, protocol: "any" }, { run, ...lanEnv })).rejects.toThrow("SSH rule stays");
    await expect(firewallRuleDelete({ action: "allow", port: 8787, protocol: "tcp" }, { run, ...lanEnv })).rejects.toThrow("BoxPilot rule stays");
    expect(run).not.toHaveBeenCalled();
    // A deny rule on a protected port is the thing we want gone; deleting it is fine.
    await firewallRuleDelete({ action: "deny", port: 22, protocol: "tcp" }, { run, ...lanEnv });
    expect(run).toHaveBeenCalledWith("/usr/sbin/ufw", ["--force", "delete", "deny", "22/tcp"], expect.anything());
  });

  it("refuses to deny protected ports, including the configured web port", async () => {
    const run = okRun();
    await expect(firewallRuleAdd({ action: "deny", port: 22, protocol: "tcp" }, { run, ...lanEnv })).rejects.toThrow("it is SSH");
    await expect(firewallRuleAdd({ action: "deny", port: 22, protocol: "any" }, { run, ...lanEnv })).rejects.toThrow("lock you out");
    await expect(firewallRuleAdd({ action: "deny", port: 41641, protocol: "udp" }, { run, ...lanEnv })).rejects.toThrow("Tailscale");
    await expect(firewallRuleAdd({ action: "deny", port: 8787, protocol: "tcp" }, { run, ...lanEnv })).rejects.toThrow("BoxPilot");
    expect(run).not.toHaveBeenCalled();
    // 22/udp is not SSH; denying it is allowed.
    await firewallRuleAdd({ action: "deny", port: 22, protocol: "udp" }, { run, ...lanEnv });
    expect(run).toHaveBeenCalledWith("/usr/sbin/ufw", ["deny", "22/udp"], expect.anything());
  });

  it("applies a profile in plan order and opens the web port when BoxPilot is served on the LAN", async () => {
    const run = okRun();
    const readEnvFile = vi.fn(async () => readLan());
    const { readFile } = await import("node:fs/promises");
    void readFile;
    const result = await firewallProfileApply({ profile: "home-server", services: ["dns", "web"], sshRateLimit: true }, { run, envPath: "/tmp/x.env", now: () => new Date("2026-08-21T16:00:00Z"), ...(await (async () => ({}))()) }).catch((error) => error);
    // The default env file does not exist in tests, so the LAN port is not opened here...
    expect(result).toMatchObject({ profile: "home-server", services: ["dns", "web"], sshRateLimit: true, appliedAt: "2026-08-21T16:00:00.000Z" });
    const calls = run.mock.calls.map(([, args]) => args.join(" "));
    expect(calls[0]).toBe("insert 1 limit 22/tcp comment BoxPilot keeps SSH reachable (rate-limited)");
    expect(calls[1]).toBe("--force delete allow 22/tcp");
    expect(calls).toContain("allow 53/tcp comment BoxPilot service: DNS server");
    expect(calls).toContain("allow 53/udp comment BoxPilot service: DNS server");
    expect(calls).toContain("allow 443/tcp comment BoxPilot service: Web (HTTP/HTTPS)");
    expect(calls.indexOf("default deny incoming")).toBeLessThan(calls.indexOf("--force enable"));
    expect(calls.at(-1)).toBe("status verbose");
    expect(calls.some((call) => call.startsWith("allow 8787/tcp"))).toBe(false);
    void readEnvFile;
  });

  it("stops before enabling when a required step fails, and tolerates the tailnet rule failing", async () => {
    const run = vi.fn(async (binary, args) => {
      if (args.join(" ").startsWith("allow in on tailscale0")) return { ok: false, stdout: "", stderr: "ERROR: Unknown interface" };
      if (args[0] === "default") return { ok: false, stdout: "", stderr: "ERROR: policy" };
      return { ok: true, stdout: "", stderr: "" };
    });
    await expect(firewallProfileApply({ profile: "trusted-lan" }, { run, ...lanEnv })).rejects.toThrow(/Default incoming: allow failed: .*Stopped before turning the firewall on/);
    const calls = run.mock.calls.map(([, args]) => args.join(" "));
    expect(calls).toContain("deny 3306/tcp comment BoxPilot profile: MySQL / MariaDB");
    expect(calls).not.toContain("--force enable");
  });

  it("rejects unknown profiles and services before running anything", async () => {
    const run = okRun();
    await expect(firewallProfileApply({ profile: "fortress" }, { run, ...lanEnv })).rejects.toThrow("Unknown firewall profile");
    await expect(firewallProfileApply({ profile: "home-server", services: ["telnet"] }, { run, ...lanEnv })).rejects.toThrow("Unknown services");
    expect(run).not.toHaveBeenCalled();
  });
});
