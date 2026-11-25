import { describe, expect, it, vi } from "vitest";
import { setEnvValue, webBindSet } from "./web-bind.mjs";

describe("setting the control plane's listening address", () => {
  it("replaces or appends BOXPILOT_HOST without disturbing the rest of the env", () => {
    expect(setEnvValue("BOXPILOT_HOST=127.0.0.1\nBOXPILOT_PORT=8787\n", "BOXPILOT_HOST", "0.0.0.0"))
      .toBe("BOXPILOT_HOST=0.0.0.0\nBOXPILOT_PORT=8787\n");
    // Absent key is appended, keeping the trailing newline tidy.
    expect(setEnvValue("BOXPILOT_PORT=8787\n", "BOXPILOT_HOST", "0.0.0.0"))
      .toBe("BOXPILOT_PORT=8787\nBOXPILOT_HOST=0.0.0.0\n");
    expect(setEnvValue("", "BOXPILOT_HOST", "127.0.0.1")).toBe("BOXPILOT_HOST=127.0.0.1\n");
  });

  it("binds the LAN, opens the firewall for the web port, and schedules a deferred restart", async () => {
    let written = null;
    const run = vi.fn(async () => ({ ok: true, stdout: "", stderr: "" }));
    const files = { readFile: async () => "BOXPILOT_HOST=127.0.0.1\nBOXPILOT_PORT=8787\n", writeFile: async (_p, text) => { written = text; } };
    const result = await webBindSet({ scope: "lan" }, { run, files });
    expect(result).toMatchObject({ scope: "lan", host: "0.0.0.0", port: "8787", restartScheduled: true });
    expect(written).toContain("BOXPILOT_HOST=0.0.0.0");
    // Firewall opened for the actual configured port, and the restart deferred (not immediate).
    expect(run).toHaveBeenCalledWith("/usr/sbin/ufw", ["allow", "8787/tcp"], expect.anything());
    const restart = run.mock.calls.find(([binary]) => binary === "/usr/bin/systemd-run");
    expect(restart[1]).toEqual(expect.arrayContaining(["--on-active", "5", "restart", "boxpilot.service"]));
  });

  // Both readers took the first `^KEY=` line literally: the port opened was not the one systemd
  // started the service on, and a second BOXPILOT_HOST line kept the old address in force.
  it("reads the port and rewrites the address as systemd reads the env file", async () => {
    let written = null;
    const run = vi.fn(async () => ({ ok: true, stdout: "", stderr: "" }));
    const before = "BOXPILOT_HOST=127.0.0.1\nBOXPILOT_PORT=8787\n  BOXPILOT_PORT = 9000\r\nBOXPILOT_HOST = 127.0.0.1\n";
    const files = { readFile: async () => before, writeFile: async (_p, text) => { written = text; } };
    const result = await webBindSet({ scope: "lan" }, { run, files });
    expect(result).toMatchObject({ host: "0.0.0.0", port: "9000" });
    expect(run).toHaveBeenCalledWith("/usr/sbin/ufw", ["allow", "9000/tcp"], expect.anything());
    expect(written.split("\n").filter((line) => line.includes("BOXPILOT_HOST"))).toEqual(["BOXPILOT_HOST=0.0.0.0", "BOXPILOT_HOST=0.0.0.0"]);
  });

  it("returning to loopback removes the firewall opening", async () => {
    const run = vi.fn(async () => ({ ok: true, stdout: "", stderr: "" }));
    const files = { readFile: async () => "BOXPILOT_HOST=0.0.0.0\nBOXPILOT_PORT=9000\n", writeFile: async () => {} };
    const result = await webBindSet({ scope: "loopback" }, { run, files });
    expect(result.host).toBe("127.0.0.1");
    expect(run).toHaveBeenCalledWith("/usr/sbin/ufw", ["--force", "delete", "allow", "9000/tcp"], expect.anything());
  });

  // M90: the HTTPS listener binds the same address as HTTP, so turning LAN access off left 8443 open
  // to a listener that answered on loopback only, and turning it on again never reopened it.
  it("closes the HTTPS port with LAN access, and reopens it, when HTTPS on the LAN is set up", async () => {
    const tlsEnv = "BOXPILOT_HOST=0.0.0.0\nBOXPILOT_PORT=8787\nBOXPILOT_TLS_CERT=/etc/boxpilot/tls/leaf.crt\nBOXPILOT_TLS_KEY=/etc/boxpilot/tls/leaf.key\nBOXPILOT_TLS_PORT=9443\n";
    const ok = async () => ({ ok: true, stdout: "", stderr: "" });
    const off = vi.fn(ok);
    const closed = await webBindSet({ scope: "loopback" }, { run: off, files: { readFile: async () => tlsEnv, writeFile: async () => {} } });
    expect(off).toHaveBeenCalledWith("/usr/sbin/ufw", ["--force", "delete", "allow", "8787/tcp"], expect.anything());
    expect(off).toHaveBeenCalledWith("/usr/sbin/ufw", ["--force", "delete", "allow", "9443/tcp"], expect.anything());
    expect(closed.tlsPort).toBe("9443");
    const on = vi.fn(ok);
    await webBindSet({ scope: "lan" }, { run: on, files: { readFile: async () => tlsEnv.replace("0.0.0.0", "127.0.0.1"), writeFile: async () => {} } });
    expect(on).toHaveBeenCalledWith("/usr/sbin/ufw", ["allow", "9443/tcp"], expect.anything());
    // The HTTPS port's failure to open is said, naming it, like the web port's.
    const failing = vi.fn(async (binary, args) => (binary === "/usr/sbin/ufw" && args.includes("9443/tcp") ? { ok: false, stdout: "", stderr: "ERROR: problem running iptables" } : { ok: true, stdout: "", stderr: "" }));
    const warned = await webBindSet({ scope: "lan" }, { run: failing, files: { readFile: async () => tlsEnv, writeFile: async () => {} } });
    expect(warned.warnings).toEqual([expect.stringContaining("its HTTPS port 9443")]);
  });

  it("leaves a port it did not open alone when HTTPS on the LAN is not set up", async () => {
    const run = vi.fn(async () => ({ ok: true, stdout: "", stderr: "" }));
    const result = await webBindSet({ scope: "loopback" }, { run, files: { readFile: async () => "BOXPILOT_HOST=0.0.0.0\nBOXPILOT_TLS_PORT=8443\n", writeFile: async () => {} } });
    expect(run.mock.calls.filter(([binary]) => binary === "/usr/sbin/ufw").map(([, args]) => args.at(-1))).toEqual(["8787/tcp"]);
    expect(result).not.toHaveProperty("tlsPort");
  });

  it("warns when the firewall cannot be opened for the LAN, and only logs a rule it could not remove (M73)", async () => {
    const run = vi.fn(async (binary) => (binary === "/usr/sbin/ufw" ? { ok: false, stdout: "", stderr: "ERROR: problem running iptables" } : { ok: true, stdout: "", stderr: "" }));
    const files = { readFile: async () => "BOXPILOT_PORT=8787\n", writeFile: async () => {} };
    const lan = await webBindSet({ scope: "lan" }, { run, files });
    expect(lan.warnings).toEqual([expect.stringContaining("the firewall could not be opened for port 8787")]);
    const log = vi.fn();
    const loopback = await webBindSet({ scope: "loopback" }, { run, files, log });
    expect(loopback).not.toHaveProperty("warnings");
    expect(log).toHaveBeenCalledWith(expect.stringContaining("Could not remove the firewall rule for 8787/tcp"), "stderr");
  });

  it("refuses an unknown scope and reports a failed restart schedule", async () => {
    await expect(webBindSet({ scope: "everywhere" }, {})).rejects.toThrow(/scope must be/);
    const run = vi.fn(async (binary) => (binary === "/usr/bin/systemd-run" ? { ok: false, stdout: "", stderr: "dbus down" } : { ok: true, stdout: "", stderr: "" }));
    const files = { readFile: async () => "", writeFile: async () => {} };
    await expect(webBindSet({ scope: "lan" }, { run, files })).rejects.toThrow(/could not schedule the restart/);
  });
});
