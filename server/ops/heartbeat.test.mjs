import { describe, expect, it } from "vitest";
import { registry } from "./index.mjs";
import { secretPaths } from "./registry.mjs";
import { inspectHeartbeat } from "./heartbeat.mjs";
import { heartbeatCredential } from "../heartbeat.mjs";

const url = "https://hc-ping.com/5a3f1c2e-0000-4000-8000-00000000abcd";

function credentialStore(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    values,
    read: async (name) => values.get(name) ?? null,
    set: async ({ name, value }) => { values.set(name, value); return { name }; },
    remove: async ({ name }) => { values.delete(name); return { name, removed: true }; },
  };
}

describe("the heartbeat operations", () => {
  it("are the owner's, at honest tiers, and the address is a secret wherever the job is kept", async () => {
    expect(registry.get("heartbeat.set")).toMatchObject({ risk: "medium", minimumRole: "owner", readOnly: false });
    expect(registry.get("heartbeat.test")).toMatchObject({ risk: "low", minimumRole: "owner", readOnly: false });
    expect(registry.get("heartbeat.inspect")).toMatchObject({ risk: "low", minimumRole: "owner", readOnly: true });
    expect(await secretPaths(registry.get("heartbeat.set"), { enabled: true, url, intervalMinutes: 5 })).toEqual([["url"]]);
    expect(registry.validate("heartbeat.set", { enabled: true, url: "ftp://nope", intervalMinutes: 5 })).toMatch(/url/);
    expect(registry.validate("heartbeat.set", { enabled: true, intervalMinutes: 3 })).toMatch(/intervalMinutes/);
    expect(registry.validate("heartbeat.set", { enabled: true, url, intervalMinutes: 5 })).toBeNull();
  });

  it("saves the address as a credential, then turns the timer on through the root task", async () => {
    const credentials = credentialStore();
    const tasks = [];
    const runUnit = { runTask: async (task, parameters) => { tasks.push({ task, parameters }); return { enabled: true, intervalMinutes: parameters.intervalMinutes, last: null }; } };
    const lines = [];
    await registry.execute("heartbeat.set", { enabled: true, url, intervalMinutes: 5 }, { credentials, runUnit, progress: (line) => lines.push(line) });
    expect(credentials.values.get(heartbeatCredential)).toBe(url);
    expect(tasks).toEqual([{ task: "heartbeat.configure", parameters: { enabled: true, intervalMinutes: 5 } }]);
    // The log says where it goes, never the address.
    expect(lines.join("\n")).toContain("hc-ping.com");
    expect(lines.join("\n")).not.toContain("5a3f1c2e");
  });

  it("will not turn on with no address, and forgets it only when turned off", async () => {
    const runUnit = { runTask: async (_task, parameters) => ({ ...parameters }) };
    await expect(registry.execute("heartbeat.set", { enabled: true, intervalMinutes: 5 }, { credentials: credentialStore(), runUnit })).rejects.toThrow(/Paste the address/);
    await expect(registry.execute("heartbeat.set", { enabled: true, forget: true }, { credentials: credentialStore({ [heartbeatCredential]: url }), runUnit })).rejects.toThrow(/cannot be forgotten while/);
    const credentials = credentialStore({ [heartbeatCredential]: url });
    await registry.execute("heartbeat.set", { enabled: false, forget: true }, { credentials, runUnit });
    expect(credentials.values.has(heartbeatCredential)).toBe(false);
  });

  it("tells the page the host and the state, never the address", async () => {
    const run = async () => ({ ok: true, stdout: "LoadState=loaded\nUnitFileState=enabled\nActiveState=active\n" });
    const read = async () => "[Timer]\nOnUnitActiveSec=\nOnUnitActiveSec=5min\n";
    const status = async () => ({ at: "2026-09-30T10:00:00.000Z", ok: true, status: 200, ms: 90, error: null });
    const inspected = await inspectHeartbeat({ credentials: credentialStore({ [heartbeatCredential]: url }), run, read, status });
    expect(inspected).toMatchObject({ configured: true, host: "hc-ping.com", installed: true, enabled: true, intervalMinutes: 5, last: { ok: true } });
    expect(JSON.stringify(inspected)).not.toContain("5a3f1c2e");
    const off = await inspectHeartbeat({ credentials: credentialStore(), run: async () => ({ ok: false, stdout: "" }), read: async () => { throw new Error("ENOENT"); }, status: async () => null });
    expect(off).toMatchObject({ configured: false, host: null, installed: false, enabled: false, intervalMinutes: null, last: null });
  });
});
