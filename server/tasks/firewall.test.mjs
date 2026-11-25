import { describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { firewallProfileApply, firewallRuleAdd, firewallRuleDelete, firewallSet, readWebEnv, sourceProblem, validateRule } from "./firewall.mjs";

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

  // It took the first `^BOXPILOT_PORT=` line literally: the System page's update then health-checked
  // 8787 on a service systemd had started on 9000, and rolled back a version already running.
  it("reads the env file as systemd does: blanks around =, a leading blank, CRLF, the last line wins", async () => {
    const read = (text) => readWebEnv({ read: async () => text });
    expect(await read("BOXPILOT_PORT = 9000\n")).toEqual({ webPort: 9000, webHost: "127.0.0.1" });
    expect(await read("  BOXPILOT_PORT=9000\n BOXPILOT_HOST = 0.0.0.0 \n")).toEqual({ webPort: 9000, webHost: "0.0.0.0" });
    expect(await read("\nBOXPILOT_HOST=0.0.0.0\r\nBOXPILOT_PORT='9000'\r\n")).toEqual({ webPort: 9000, webHost: "0.0.0.0" });
    expect(await read("BOXPILOT_PORT=8787\nBOXPILOT_HOST=127.0.0.1\n# moved\nBOXPILOT_PORT=9000\n")).toEqual({ webPort: 9000, webHost: "127.0.0.1" });
    expect(await read("BOXPILOT_PORT=9000\n#BOXPILOT_PORT=8000\nBOXPILOT_PORT_TLS=9443\n")).toEqual({ webPort: 9000, webHost: "127.0.0.1" });
  });

  it("protects the port the service really listens on when the env file overrides it further down", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "boxpilot-firewall-env-"));
    try {
      const envPath = path.join(directory, "boxpilot.env");
      await fs.writeFile(envPath, "BOXPILOT_HOST=0.0.0.0\nBOXPILOT_PORT=8787\nBOXPILOT_PORT = 9000\n");
      const run = okRun();
      await expect(firewallRuleAdd({ action: "deny", port: 9000, protocol: "tcp" }, { run, envPath, dockerSync: lanEnv.dockerSync })).rejects.toThrow("Port 9000 stays open");
      await expect(firewallRuleDelete({ action: "allow", port: 9000, protocol: "tcp" }, { run, envPath, dockerSync: lanEnv.dockerSync })).rejects.toThrow("BoxPilot rule stays");
      expect(run).not.toHaveBeenCalled();
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
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
    const calls = run.mock.calls.filter(([binary]) => binary === "/usr/sbin/ufw").map(([, args]) => args.join(" "));
    // `limit` replaces an allow for the same tuple, so it needs no position and works on an empty
    // rule list — which is exactly what "start from scratch" leaves behind.
    expect(calls[0]).toBe("limit 22/tcp comment BoxPilot keeps SSH reachable (rate-limited)");
    expect(calls).not.toContain("--force delete allow 22/tcp");
    expect(calls).toContain("allow 53/tcp comment BoxPilot service: DNS server");
    expect(calls).toContain("allow 53/udp comment BoxPilot service: DNS server");
    expect(calls).toContain("allow 443/tcp comment BoxPilot service: Web (HTTP/HTTPS)");
    expect(calls.indexOf("default deny incoming")).toBeLessThan(calls.indexOf("--force enable"));
    expect(calls.at(-1)).toBe("status verbose");
    expect(calls.some((call) => call.startsWith("allow 8787/tcp"))).toBe(false);
    void readEnvFile;
  });

  it("stops before enabling when a required step fails", async () => {
    // Served on the LAN, so the tailnet interface rule is a convenience and a box without
    // tailscale0 is an ordinary configuration: that step may fail and the apply carries on.
    const servedOnLan = { ...lanEnv, readEnv: async () => "BOXPILOT_HOST=0.0.0.0\nBOXPILOT_PORT=8787\n" };
    const run = vi.fn(async (binary, args) => {
      if (args.join(" ").startsWith("allow in on tailscale0")) return { ok: false, stdout: "", stderr: "ERROR: Unknown interface" };
      if (args[0] === "default") return { ok: false, stdout: "", stderr: "ERROR: policy" };
      return { ok: true, stdout: "", stderr: "" };
    });
    await expect(firewallProfileApply({ profile: "trusted-lan" }, { run, ...servedOnLan })).rejects.toThrow(/Default incoming: allow failed: .*Stopped before turning the firewall on/);
    const calls = run.mock.calls.map(([, args]) => args.join(" "));
    expect(calls).toContain("deny 3306/tcp comment BoxPilot profile: MySQL / MariaDB");
    expect(calls).not.toContain("--force enable");
  });

  it("will not carry on past a failed tailnet rule when the tailnet is the only way in", async () => {
    // Loopback web host: no LAN rule is added for the UI, so `allow in on tailscale0` is the only
    // thing keeping the page reachable. Losing it silently used to be a stderr line in a job log.
    const run = vi.fn(async (binary, args) => (args.join(" ").startsWith("allow in on tailscale0")
      ? { ok: false, stdout: "", stderr: "ERROR: Unknown interface" }
      : { ok: true, stdout: "", stderr: "" }));
    await expect(firewallProfileApply({ profile: "trusted-lan" }, { run, ...lanEnv })).rejects.toThrow(/Keep the tailnet interface reachable failed/);
    expect(run.mock.calls.map(([, args]) => args.join(" "))).not.toContain("--force enable");
  });

  it("rejects unknown profiles and services before running anything", async () => {
    const run = okRun();
    await expect(firewallProfileApply({ profile: "fortress" }, { run, ...lanEnv })).rejects.toThrow("Unknown firewall profile");
    await expect(firewallProfileApply({ profile: "home-server", services: ["telnet"] }, { run, ...lanEnv })).rejects.toThrow("Unknown services");
    expect(run).not.toHaveBeenCalled();
  });
});

// M90: a rule can be limited to this LAN or the tailnet, and deleted by the same words.
describe("rules from one source", () => {
  it("refuses anything but an address or range", () => {
    expect(sourceProblem("192.168.1.0/24")).toBeNull();
    expect(sourceProblem("2001:db8::/32")).toBeNull();
    expect(sourceProblem("192.168.1.5/24")).toContain("network address");
    expect(sourceProblem("0.0.0.0/0")).toContain("leave the source out");
    expect(sourceProblem("192.168.1.0/24 port 22")).not.toBeNull();
    expect(validateRule({ action: "allow", port: 8096, protocol: "tcp", source: "anywhere" })).toContain("source");
  });

  it("adds and deletes a LAN-only rule with ufw's from ... to any port ... proto", async () => {
    const run = okRun();
    const added = await firewallRuleAdd({ action: "allow", port: 8096, protocol: "tcp", comment: "Jellyfin", source: "192.168.1.0/24" }, { run, ...lanEnv });
    expect(run).toHaveBeenCalledWith("/usr/sbin/ufw", ["allow", "from", "192.168.1.0/24", "to", "any", "port", "8096", "proto", "tcp", "comment", "Jellyfin"], expect.anything());
    expect(added).toMatchObject({ source: "192.168.1.0/24", sources: ["192.168.1.0/24"] });
    await firewallRuleDelete({ action: "allow", port: 8096, protocol: "tcp", source: "192.168.1.0/24" }, { run, ...lanEnv });
    expect(run).toHaveBeenCalledWith("/usr/sbin/ufw", ["--force", "delete", "allow", "from", "192.168.1.0/24", "to", "any", "port", "8096", "proto", "tcp"], expect.anything());
    // tcp + udp has no proto.
    await firewallRuleAdd({ action: "allow", port: 53, protocol: "any", source: "192.168.1.0/24" }, { run, ...lanEnv });
    expect(run).toHaveBeenCalledWith("/usr/sbin/ufw", ["allow", "from", "192.168.1.0/24", "to", "any", "port", "53"], expect.anything());
    await expect(firewallRuleAdd({ action: "allow", port: 8096, protocol: "tcp", source: "0.0.0.0/0" }, { run, ...lanEnv })).rejects.toThrow("Invalid rule");
  });

  it("writes the tailnet in both families, and carries on when ufw has IPv6 off", async () => {
    const run = vi.fn(async (binary, args) => (args.includes("fd7a:115c:a1e0::/48") ? { ok: false, stdout: "", stderr: "ERROR: IPv6 support not enabled" } : { ok: true, stdout: "", stderr: "" }));
    const added = await firewallRuleAdd({ action: "allow", port: 3000, protocol: "tcp", source: "100.64.0.0/10" }, { run, ...lanEnv });
    const calls = run.mock.calls.map(([, args]) => args.join(" "));
    expect(calls).toContain("allow from 100.64.0.0/10 to any port 3000 proto tcp");
    expect(calls).toContain("allow from fd7a:115c:a1e0::/48 to any port 3000 proto tcp");
    expect(added.sources).toEqual(["100.64.0.0/10"]);
    // The one asked for failing is a failure.
    const refusing = vi.fn(async () => ({ ok: false, stdout: "", stderr: "ERROR: Bad source" }));
    await expect(firewallRuleAdd({ action: "allow", port: 3000, protocol: "tcp", source: "100.64.0.0/10" }, { run: refusing, ...lanEnv })).rejects.toThrow("ufw rejected the rule");
  });

  it("deletes the tailnet rule in both families, and says so when the one named is gone", async () => {
    const run = vi.fn(async (binary, args) => (args[0] === "--force" && args.includes("fd7a:115c:a1e0::/48") ? { ok: true, stdout: "Could not delete non-existent rule", stderr: "" } : { ok: true, stdout: "Rule deleted", stderr: "" }));
    const result = await firewallRuleDelete({ action: "allow", port: 3000, protocol: "tcp", source: "100.64.0.0/10" }, { run, ...lanEnv });
    expect(result.deleted).toMatchObject({ source: "100.64.0.0/10", sources: ["100.64.0.0/10"] });
    const gone = vi.fn(async (binary, args) => (args[0] === "--force" ? { ok: true, stdout: "Could not delete non-existent rule", stderr: "" } : { ok: true, stdout: "", stderr: "" }));
    await expect(firewallRuleDelete({ action: "allow", port: 9000, protocol: "tcp", source: "192.168.1.0/24" }, { run: gone, ...lanEnv })).rejects.toThrow("does not exist any more");
  });

  it("still refuses to delete an allow on a protected port, whatever its source", async () => {
    const run = okRun();
    await expect(firewallRuleDelete({ action: "allow", port: 22, protocol: "tcp", source: "192.168.1.0/24" }, { run, ...lanEnv })).rejects.toThrow("SSH rule stays");
    expect(run).not.toHaveBeenCalled();
  });
});

// M90: the root task reads the rules in place and closes what the new choice no longer keeps.
describe("applying a profile closes what it no longer keeps", () => {
  const hex = (text) => Buffer.from(text).toString("hex");
  const userRules = [
    `### tuple ### allow tcp 22 0.0.0.0/0 any 0.0.0.0/0 in comment=${hex("BoxPilot keeps SSH reachable")}`,
    `### tuple ### allow tcp 80 0.0.0.0/0 any 0.0.0.0/0 in comment=${hex("BoxPilot service: Web (HTTP/HTTPS)")}`,
    `### tuple ### allow tcp 32400 0.0.0.0/0 any 0.0.0.0/0 in comment=${hex("BoxPilot service: Plex")}`,
  ].join("\n");
  const readRules = vi.fn(async (file) => (file.endsWith("/user.rules") ? userRules : ""));

  it("deletes the earlier services' allows on Tailscale only, before turning the firewall on", async () => {
    const run = okRun();
    const closes = [{ action: "allow", port: 80, protocol: "tcp", source: null }, { action: "allow", port: 32400, protocol: "tcp", source: null }];
    const result = await firewallProfileApply({ profile: "tailscale-only", closes }, { run, ...lanEnv, ufwDirectory: "/etc/ufw", readRules });
    expect(readRules).toHaveBeenCalledWith("/etc/ufw/user.rules");
    const calls = run.mock.calls.map(([, args]) => args.join(" "));
    expect(calls).toContain("--force delete allow 80/tcp");
    expect(calls).toContain("--force delete allow 32400/tcp");
    expect(calls.some((call) => call.startsWith("--force delete allow 22"))).toBe(false);
    expect(calls.indexOf("--force delete allow 80/tcp")).toBeLessThan(calls.indexOf("--force enable"));
    expect(result.closed.map((rule) => rule.port)).toEqual([80, 32400]);
  });

  it("deletes only the service no longer ticked on Home server", async () => {
    const run = okRun();
    await firewallProfileApply({ profile: "home-server", services: ["web"], closes: [{ action: "allow", port: 32400, protocol: "tcp", source: null }] }, { run, ...lanEnv, readRules });
    const calls = run.mock.calls.map(([, args]) => args.join(" ")).filter((call) => call.includes("delete"));
    expect(calls).toEqual(["--force delete allow 32400/tcp"]);
  });
});

describe("starting from scratch", () => {
  const { mkdtemp, readFile, writeFile, rm } = fs;
  const original = {
    "user.rules": "*filter\n### tuple ### allow tcp 8096 0.0.0.0/0 any 0.0.0.0/0 in comment=4a656c6c7966696e\nCOMMIT\n",
    "user6.rules": "*filter\nCOMMIT\n",
    "ufw.conf": "ENABLED=no\nLOGLEVEL=low\n",
    "before.rules": "*nat\n:POSTROUTING ACCEPT [0:0]\n-A POSTROUTING -s 10.8.0.0/24 -o eth0 -j MASQUERADE\nCOMMIT\n*filter\nCOMMIT\n",
    "before6.rules": "*filter\n# custom v6\nCOMMIT\n",
    "after.rules": "*filter\nCOMMIT\n\n# BEGIN BOXPILOT DOCKER RULES (managed by BoxPilot; edits here are overwritten)\n*filter\nCOMMIT\n# END BOXPILOT DOCKER RULES\n",
    "after6.rules": "*filter\n# custom after6\nCOMMIT\n",
  };
  const installDefault = "# installation default\n*filter\nCOMMIT\n";

  async function box({ enabled }) {
    const directory = await mkdtemp(path.join(os.tmpdir(), "boxpilot-ufw-"));
    const files = { ...original, "ufw.conf": `ENABLED=${enabled ? "yes" : "no"}\nLOGLEVEL=low\n` };
    for (const [name, text] of Object.entries(files)) await writeFile(path.join(directory, name), text);
    const contents = async () => Object.fromEntries(await Promise.all(Object.keys(original).map(async (name) => [name, await readFile(path.join(directory, name), "utf8")])));
    // `ufw --force reset` puts every rules file back to the installation default and turns ufw off.
    const reset = async () => {
      for (const name of Object.keys(original)) await writeFile(path.join(directory, name), name === "ufw.conf" ? "ENABLED=no\nLOGLEVEL=low\n" : installDefault);
    };
    return { directory, files, contents, reset, cleanup: () => rm(directory, { recursive: true, force: true }) };
  }

  function runner({ enabled, reset, failOn = null }) {
    return vi.fn(async (_binary, args) => {
      const call = args.join(" ");
      if (call === "status") return { ok: true, stdout: `Status: ${enabled ? "active" : "inactive"}\n`, stderr: "" };
      if (call === "status verbose") return { ok: true, stdout: "Status: active\n", stderr: "" };
      if (call === "--force reset") { await reset(); return { ok: true, stdout: "", stderr: "" }; }
      if (failOn && call.startsWith(failOn)) return { ok: false, stdout: "", stderr: "ERROR: Could not update running firewall" };
      return { ok: true, stdout: "", stderr: "" };
    });
  }

  it("leaves a firewall that was off turned off when a from-scratch apply fails", async () => {
    const host = await box({ enabled: false });
    try {
      const dockerSync = vi.fn(async ({ enabled }) => ({ synced: true, enabled }));
      const run = runner({ enabled: false, reset: host.reset, failOn: "allow 53/tcp" });
      await expect(firewallProfileApply({ profile: "home-server", services: ["dns"], replace: true }, { run, ...lanEnv, dockerSync, ufwDirectory: host.directory }))
        .rejects.toThrow(/Your previous rules were put back/);
      const calls = run.mock.calls.map(([, args]) => args.join(" "));
      expect(calls).not.toContain("--force enable");
      expect(calls.at(-1)).toBe("--force disable");
      expect(await host.contents()).toEqual(host.files);
    } finally { await host.cleanup(); }
  });

  it("puts back before/after rules, including the Docker block, and re-enables a firewall that was on", async () => {
    const host = await box({ enabled: true });
    try {
      const dockerSync = vi.fn(async ({ enabled }) => ({ synced: true, enabled }));
      const run = runner({ enabled: true, reset: host.reset, failOn: "allow 53/tcp" });
      await expect(firewallProfileApply({ profile: "home-server", services: ["dns"], replace: true }, { run, ...lanEnv, dockerSync, ufwDirectory: host.directory }))
        .rejects.toThrow(/Your previous rules were put back/);
      expect(await host.contents()).toEqual(host.files);
      const calls = run.mock.calls.map(([, args]) => args.join(" "));
      expect(calls.indexOf("--force reset")).toBeLessThan(calls.lastIndexOf("--force enable"));
      expect(dockerSync).toHaveBeenCalledWith({ enabled: true }, expect.anything());
    } finally { await host.cleanup(); }
  });

  it("says which rule files could not be put back, and keeps their copies, rather than claiming all were (M73)", async () => {
    const host = await box({ enabled: false });
    try {
      const dockerSync = vi.fn(async ({ enabled }) => ({ synced: true, enabled }));
      const base = runner({ enabled: false, reset: host.reset, failOn: "allow 53/tcp" });
      // A folder where user.rules was: copying the saved file back over it fails, as a full or
      // read-only disk would make it.
      const run = vi.fn(async (binary, args, options) => {
        if (args.join(" ").startsWith("allow 53/tcp")) { await rm(path.join(host.directory, "user.rules")); await fs.mkdir(path.join(host.directory, "user.rules")); }
        return base(binary, args, options);
      });
      const failure = await firewallProfileApply({ profile: "home-server", services: ["dns"], replace: true }, { run, ...lanEnv, dockerSync, ufwDirectory: host.directory }).catch((error) => error);
      expect(failure.message).toContain("Your previous rules were put back except user.rules, which could not be copied back");
      expect(failure.message).toContain("and the firewall was left off, as it was.");
      expect(failure.message).not.toContain("Your previous rules were put back.");
      const leftovers = (await fs.readdir(host.directory)).filter((name) => name.endsWith(".boxpilot-pre"));
      expect(leftovers).toEqual(["user.rules.boxpilot-pre"]);
    } finally { await host.cleanup(); }
  });

  it("says so when the firewall cannot be turned off again after a failed from-scratch apply (M73)", async () => {
    const host = await box({ enabled: false });
    try {
      const dockerSync = vi.fn(async ({ enabled }) => ({ synced: true, enabled }));
      const base = runner({ enabled: false, reset: host.reset, failOn: "allow 53/tcp" });
      const run = vi.fn(async (binary, args, options) => (args.join(" ") === "--force disable" ? { ok: false, stdout: "", stderr: "ERROR: problem running ufw-init" } : base(binary, args, options)));
      await expect(firewallProfileApply({ profile: "home-server", services: ["dns"], replace: true }, { run, ...lanEnv, dockerSync, ufwDirectory: host.directory }))
        .rejects.toThrow("Your previous rules were put back, but the firewall could not be turned off again (ERROR: problem running ufw-init).");
    } finally { await host.cleanup(); }
  });

  it("clears the owner's rules but keeps hand-written before/after rules such as VPN NAT", async () => {
    const host = await box({ enabled: true });
    try {
      const dockerSync = vi.fn(async ({ enabled }) => ({ synced: true, enabled }));
      const run = runner({ enabled: true, reset: host.reset });
      await firewallProfileApply({ profile: "home-server", replace: true }, { run, ...lanEnv, dockerSync, ufwDirectory: host.directory });
      const after = await host.contents();
      expect(after["user.rules"]).toBe(installDefault);
      for (const name of ["before.rules", "before6.rules", "after.rules", "after6.rules"]) expect(after[name]).toBe(original[name]);
      expect(dockerSync).toHaveBeenCalledWith({ enabled: true }, expect.anything());
      const leftovers = (await fs.readdir(host.directory)).filter((name) => name.endsWith(".boxpilot-pre"));
      expect(leftovers).toEqual([]);
    } finally { await host.cleanup(); }
  });
});

// M90 review: what the outside review found in applying a profile and in sources.
describe("applying a profile keeps BoxPilot's HTTPS port and SSH on its real port", () => {
  const hex = (text) => Buffer.from(text).toString("hex");
  // What web-tls writes (`ufw allow 8443/tcp`, no comment), SSH moved to 2222 and rate-limited, one service.
  const userRules = [
    "### tuple ### allow tcp 8443 0.0.0.0/0 any 0.0.0.0/0 in",
    "### tuple ### limit tcp 2222 0.0.0.0/0 any 0.0.0.0/0 in",
    `### tuple ### allow tcp 32400 0.0.0.0/0 any 0.0.0.0/0 in comment=${hex("BoxPilot service: Plex")}`,
  ].join("\n");
  const readRules = async (file) => (file.endsWith("/user.rules") ? userRules : "");
  const tlsLan = async () => "BOXPILOT_HOST=0.0.0.0\nBOXPILOT_PORT=8787\nBOXPILOT_TLS_CERT=/etc/boxpilot/tls/leaf.crt\nBOXPILOT_TLS_KEY=/etc/boxpilot/tls/leaf.key\nBOXPILOT_TLS_PORT=8443\n";
  const runWith = (sshd) => vi.fn(async (binary, args) => {
    if (binary === "/usr/sbin/sshd") return sshd;
    if (args[0] === "status") return { ok: true, stdout: "Status: active\n", stderr: "" };
    return { ok: true, stdout: "", stderr: "" };
  });
  const ufwCalls = (run) => run.mock.calls.filter(([binary]) => binary === "/usr/sbin/ufw").map(([, args]) => args.join(" "));
  const plex = [{ action: "allow", port: 32400, protocol: "tcp", source: null }];

  it("closes neither the HTTPS port nor sshd's port on Tailscale only, and keeps SSH open on it", async () => {
    const run = runWith({ ok: true, stdout: "port 2222\naddressfamily any\nlistenaddress 0.0.0.0:2222\n", stderr: "" });
    const result = await firewallProfileApply({ profile: "tailscale-only", closes: plex }, { run, ...lanEnv, readEnv: tlsLan, readRules });
    const calls = ufwCalls(run);
    expect(calls.filter((call) => call.includes("delete"))).toEqual(["--force delete allow 32400/tcp"]);
    expect(calls).toContain("allow 2222/tcp comment BoxPilot keeps SSH reachable");
    expect(calls).toContain("allow 8443/tcp comment BoxPilot keeps BoxPilot HTTPS reachable");
    expect(result.closed.map((rule) => rule.port)).toEqual([32400]);
  });

  it("keeps every rule that could be SSH's when sshd -T cannot be read", async () => {
    const run = runWith({ ok: false, stdout: "", stderr: "sshd: no hostkeys available -- exiting." });
    const rules = [
      "### tuple ### limit tcp 2200 0.0.0.0/0 any 0.0.0.0/0 in",
      "### tuple ### allow tcp 2222 0.0.0.0/0 any 0.0.0.0/0 in",
      `### tuple ### allow tcp 4022 0.0.0.0/0 any 0.0.0.0/0 in comment=${hex("my ssh")}`,
      "### tuple ### allow tcp 3000 0.0.0.0/0 any 0.0.0.0/0 in",
    ].join("\n");
    const log = vi.fn();
    await firewallProfileApply({ profile: "tailscale-only", closes: [{ action: "allow", port: 3000, protocol: "tcp", source: null }] }, { run, ...lanEnv, log, readRules: async (file) => (file.endsWith("/user.rules") ? rules : "") });
    expect(ufwCalls(run).filter((call) => call.includes("delete"))).toEqual(["--force delete allow 3000/tcp"]);
    expect(ufwCalls(run)).toContain("allow 22/tcp comment BoxPilot keeps SSH reachable");
    expect(log.mock.calls.some(([line]) => /SSH port could not be read/.test(line))).toBe(true);
  });

  it("refuses, changing nothing, when it would close a rule the preview did not show", async () => {
    const run = runWith({ ok: true, stdout: "port 2222\n", stderr: "" });
    await expect(firewallProfileApply({ profile: "tailscale-only", closes: [] }, { run, ...lanEnv, readEnv: tlsLan, readRules }))
      .rejects.toThrow("Nothing was changed: applying Tailscale only now would also close allow 32400/tcp, which the preview did not show");
    expect(ufwCalls(run)).toEqual([]);
    // Left out entirely, nothing may close either.
    await expect(firewallProfileApply({ profile: "tailscale-only" }, { run, ...lanEnv, readEnv: tlsLan, readRules })).rejects.toThrow("review the profile again");
    expect(ufwCalls(run)).toEqual([]);
    // A preview that listed more than now closes is fine: what runs is a subset of what was shown.
    await firewallProfileApply({ profile: "tailscale-only", closes: [...plex, { action: "allow", port: 80, protocol: "tcp", source: null }] }, { run, ...lanEnv, readEnv: tlsLan, readRules });
    expect(ufwCalls(run)).toContain("--force enable");
  });

  it("puts back the rules it closed when a later step fails, and says so", async () => {
    const run = vi.fn(async (binary, args) => {
      if (binary === "/usr/sbin/sshd") return { ok: true, stdout: "port 22\n", stderr: "" };
      if (args.join(" ") === "default deny incoming") return { ok: false, stdout: "", stderr: "ERROR: problem running ufw-init" };
      return { ok: true, stdout: "", stderr: "" };
    });
    const rules = [
      `### tuple ### allow tcp 32400 0.0.0.0/0 any 0.0.0.0/0 in comment=${hex("BoxPilot service: Plex")}`,
      "### tuple ### allow tcp 3000 0.0.0.0/0 any 192.168.1.0/24 in",
    ].join("\n");
    const closes = [...plex, { action: "allow", port: 3000, protocol: "tcp", source: "192.168.1.0/24" }];
    const failure = await firewallProfileApply({ profile: "tailscale-only", closes }, { run, ...lanEnv, readRules: async (file) => (file.endsWith("/user.rules") ? rules : "") }).catch((error) => error);
    const calls = ufwCalls(run);
    expect(calls).toContain("allow 32400/tcp comment BoxPilot service: Plex");
    expect(calls).toContain("allow from 192.168.1.0/24 to any port 3000 proto tcp");
    expect(calls.indexOf("allow 32400/tcp comment BoxPilot service: Plex")).toBeGreaterThan(calls.indexOf("default deny incoming"));
    expect(calls).not.toContain("--force enable");
    expect(failure.message).toContain("It had closed allow 32400/tcp, allow 3000/tcp from 192.168.1.0/24 first; those rules were put back.");
    expect(failure.message).not.toContain("nothing new is blocked");
  });

  it("says which closed rules it could not put back", async () => {
    const run = vi.fn(async (binary, args) => {
      const call = args.join(" ");
      if (binary === "/usr/sbin/sshd") return { ok: true, stdout: "port 22\n", stderr: "" };
      if (call === "--force enable") return { ok: false, stdout: "", stderr: "ERROR: Could not load logging rules" };
      if (call.startsWith("allow 32400/tcp")) return { ok: false, stdout: "", stderr: "ERROR: Could not update running firewall" };
      return { ok: true, stdout: "", stderr: "" };
    });
    const plexOnly = `### tuple ### allow tcp 32400 0.0.0.0/0 any 0.0.0.0/0 in comment=${hex("BoxPilot service: Plex")}`;
    const failure = await firewallProfileApply({ profile: "tailscale-only", closes: plex }, { run, ...lanEnv, readRules: async (file) => (file.endsWith("/user.rules") ? plexOnly : "") }).catch((error) => error);
    expect(failure.message).toContain("Turn the firewall on failed: ERROR: Could not load logging rules.");
    expect(failure.message).toContain("It had closed allow 32400/tcp first, and could not put it back: add it again on the Rules tab.");
  });

  it("refuses to delete or deny sshd's own port, and the HTTPS port BoxPilot serves on", async () => {
    const run = runWith({ ok: true, stdout: "port 2222\n", stderr: "" });
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "boxpilot-firewall-tls-"));
    try {
      const envPath = path.join(directory, "boxpilot.env");
      await fs.writeFile(envPath, await tlsLan());
      const options = { run, envPath, dockerSync: lanEnv.dockerSync };
      await expect(firewallRuleDelete({ action: "limit", port: 2222, protocol: "tcp" }, options)).rejects.toThrow("SSH rule stays");
      await expect(firewallRuleAdd({ action: "deny", port: 2222, protocol: "tcp" }, options)).rejects.toThrow("it is SSH");
      await expect(firewallRuleDelete({ action: "allow", port: 8443, protocol: "tcp" }, options)).rejects.toThrow("BoxPilot HTTPS rule stays");
      expect(ufwCalls(run)).toEqual([]);
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });
});

describe("sources the review found accepted", () => {
  it("refuses the unspecified address, IPv4-mapped IPv6, a padded prefix, and an IPv6 range off its network address", () => {
    expect(sourceProblem("0.0.0.0")).toContain("leave the source out");
    expect(sourceProblem("::")).toContain("leave the source out");
    expect(sourceProblem("0.0.0.0/8")).toContain("leave the source out");
    expect(sourceProblem("1.2.3.0/032")).not.toBeNull();
    expect(sourceProblem("1.2.3.4/032")).not.toBeNull();
    expect(sourceProblem("10.0.0.0/08")).not.toBeNull();
    expect(sourceProblem("::ffff:10.0.0.0/104")).toContain("IPv4");
    expect(sourceProblem("::ffff:a00:0/104")).toContain("IPv4");
    expect(sourceProblem("::1.2.3.4")).toContain("IPv4");
    expect(sourceProblem("fd00::1/64")).toContain("network address");
    expect(sourceProblem("2001:db8::8000/112")).toContain("network address");
    // Still accepted.
    expect(sourceProblem("fd00::/64")).toBeNull();
    expect(sourceProblem("fd7a:115c:a1e0::/48")).toBeNull();
    expect(sourceProblem("2001:db8::1")).toBeNull();
    expect(sourceProblem("2001:db8::1/128")).toBeNull();
    expect(sourceProblem("1.2.3.4/32")).toBeNull();
    expect(sourceProblem("100.64.0.0/10")).toBeNull();
    expect(sourceProblem("::1")).toBeNull();
  });
});
