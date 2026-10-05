import { describe, expect, it } from "vitest";
import { formatDoctor, readWebHealth, runControllerDoctor } from "./boxpilot-controller-doctor.mjs";
describe("doctor outside Express", () => {
  it("includes independent database evidence when both services cannot answer", async () => {
    const databaseProbe = async () => ({ checks: [{ id: "database-quick-check", title: "SQLite quick check", status: "pass", detail: "ok" }] });
    const report = await runControllerDoctor({ includeDatabase: true, databaseProbe, inspect: async () => ({ checks: [], installedVersion: null }), webProbe: async () => { throw new Error("offline"); }, helperProbe: async () => { throw new Error("offline"); } });
    expect(report.checks.find((check) => check.id === "database-quick-check").status).toBe("pass");
    expect(report.counts.unknown).toBe(2);
    expect(report.status).toBe("incomplete");
  });
  it("retains file evidence when both network endpoints are unavailable", async () => {
    const report = await runControllerDoctor({ inspect: async () => ({ checkedAt: "2026-09-07T12:00:00Z", installedVersion: "1.2.3", checks: [{ id: "release", title: "Installed release", status: "pass", detail: "1.2.3" }] }), webProbe: async () => { throw new Error("offline"); }, helperProbe: async () => { throw new Error("offline"); } });
    expect(report.checks).toHaveLength(3);
    expect(report.status).toBe("incomplete");
    expect(formatDoctor(report)).toContain("[PASS] Installed release: 1.2.3");
    expect(formatDoctor(report)).toContain("2 unknown");
  });
  it("bounds web health responses and fixes the destination to loopback", async () => {
    const noEnvFile = async () => { throw Object.assign(new Error("no such file"), { code: "ENOENT" }); };
    await expect(readWebHealth({ port: "8787/path", readEnv: noEnvFile, fetchImpl: async () => new Response("{}") })).rejects.toThrow("Invalid");
    await expect(readWebHealth({ env: {}, host: "evil.example/x?", fetchImpl: async () => new Response("{}") })).rejects.toThrow("Invalid BoxPilot host");
    await expect(readWebHealth({ env: {}, readEnv: noEnvFile, fetchImpl: async (url, options) => { expect(url).toBe("http://127.0.0.1:8787/api/v1/health"); expect(options.redirect).toBe("error"); return new Response("x".repeat(40_000)); } })).rejects.toThrow("size limit");
    expect(await readWebHealth({ env: {}, readEnv: noEnvFile, fetchImpl: async () => new Response(JSON.stringify({ status: "ok", product: "BoxPilot" })) })).toMatchObject({ status: "ok" });
  });

  // Run with sudo, the doctor has none of the service's environment: on a box installed with
  // --port it asked 8787 and reported a healthy web service as down.
  it("asks the web service where its env file says it listens", async () => {
    const asked = async (envFile, env = {}) => {
      let url;
      await readWebHealth({ env, readEnv: async () => envFile, fetchImpl: async (target) => { url = target; return new Response("{}"); } });
      return url;
    };
    expect(await asked("BOXPILOT_HOST=127.0.0.1\nBOXPILOT_PORT=9000\n")).toBe("http://127.0.0.1:9000/api/v1/health");
    expect(await asked('BOXPILOT_HOST="0.0.0.0"\nBOXPILOT_PORT="9001"\n')).toBe("http://127.0.0.1:9001/api/v1/health");
    expect(await asked("BOXPILOT_HOST=192.0.2.10\nBOXPILOT_PORT=9002\n")).toBe("http://192.0.2.10:9002/api/v1/health");
    // As systemd reads the file: blanks around "=", CRLF, and the last line for a key wins.
    expect(await asked("BOXPILOT_PORT = 9003\r\n")).toBe("http://127.0.0.1:9003/api/v1/health");
    expect(await asked("BOXPILOT_PORT=8787\nBOXPILOT_HOST=127.0.0.1\nBOXPILOT_PORT=9004\n")).toBe("http://127.0.0.1:9004/api/v1/health");
    // Its own environment still wins, as it always did.
    expect(await asked("BOXPILOT_PORT=9000\n", { BOXPILOT_PORT: "9100", BOXPILOT_HOST: "127.0.0.1" })).toBe("http://127.0.0.1:9100/api/v1/health");
  });
});
