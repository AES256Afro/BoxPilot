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

  it("returning to loopback removes the firewall opening", async () => {
    const run = vi.fn(async () => ({ ok: true, stdout: "", stderr: "" }));
    const files = { readFile: async () => "BOXPILOT_HOST=0.0.0.0\nBOXPILOT_PORT=9000\n", writeFile: async () => {} };
    const result = await webBindSet({ scope: "loopback" }, { run, files });
    expect(result.host).toBe("127.0.0.1");
    expect(run).toHaveBeenCalledWith("/usr/sbin/ufw", ["--force", "delete", "allow", "9000/tcp"], expect.anything());
  });

  it("refuses an unknown scope and reports a failed restart schedule", async () => {
    await expect(webBindSet({ scope: "everywhere" }, {})).rejects.toThrow(/scope must be/);
    const run = vi.fn(async (binary) => (binary === "/usr/bin/systemd-run" ? { ok: false, stdout: "", stderr: "dbus down" } : { ok: true, stdout: "", stderr: "" }));
    const files = { readFile: async () => "", writeFile: async () => {} };
    await expect(webBindSet({ scope: "lan" }, { run, files })).rejects.toThrow(/could not schedule the restart/);
  });
});
