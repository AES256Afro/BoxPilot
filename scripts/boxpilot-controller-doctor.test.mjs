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
    await expect(readWebHealth({ port: "8787/path", fetchImpl: async () => new Response("{}") })).rejects.toThrow("Invalid");
    await expect(readWebHealth({ fetchImpl: async (url, options) => { expect(url).toBe("http://127.0.0.1:8787/api/v1/health"); expect(options.redirect).toBe("error"); return new Response("x".repeat(40_000)); } })).rejects.toThrow("size limit");
    expect(await readWebHealth({ fetchImpl: async () => new Response(JSON.stringify({ status: "ok", product: "BoxPilot" })) })).toMatchObject({ status: "ok" });
  });
});
