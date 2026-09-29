import { describe, expect, it, vi } from "vitest";
import { registry } from "./index.mjs";
import { newTopic, subscribeAddress } from "./notifications.mjs";

/**
 * "Send alerts to the ntfy on this server" (M35): on the owner's server ntfy already ran from the
 * catalog while Repair said only "set a target under Settings".
 */
const operation = registry.get("notifications.ntfy.connect");

function deps({ installed = true, running = true, port = 8093, answer = { ok: true, status: 200 } } = {}) {
  const runTask = vi.fn(async () => answer);
  return {
    apps: { inspect: vi.fn(async () => ({ applications: [{ id: "ntfy", installed, container: { running }, urls: installed ? [{ id: "web", host: port, exposure: "lan" }] : [] }] })) },
    runUnit: { runTask },
    jobLog: { path: "/run/boxpilot/jobs/job-1.log" },
    progress: vi.fn(),
  };
}

describe("sending alerts to the ntfy on this server (M35)", () => {
  it("is the owner's, at the tier Settings asks for (the password), and takes no parameters from the page", () => {
    expect(operation).toMatchObject({ risk: "high", minimumRole: "owner" });
    expect(registry.validate("notifications.ntfy.connect", {})).toBeNull();
    expect(registry.validate("notifications.ntfy.connect", { url: "https://elsewhere.example" })).toContain("accepts no parameters");
  });

  it("makes a topic nobody can guess and sends the test to it from this server, over loopback", async () => {
    const given = deps();
    const result = await operation.run({}, given);
    expect(result).toMatchObject({ connected: true, kind: "ntfy", url: "http://127.0.0.1:8093", port: 8093 });
    expect(result.topic).toMatch(/^boxpilot-[A-Za-z0-9_-]{16}$/);
    // The helper has no network of its own: the request goes from the root task runner.
    expect(given.runUnit.runTask).toHaveBeenCalledWith("http.request", { url: `http://127.0.0.1:8093/${result.topic}`, method: "POST", body: expect.stringContaining("BoxPilot can reach you here"), contentType: "text/plain" }, expect.objectContaining({ logPath: "/run/boxpilot/jobs/job-1.log" }));
    expect(newTopic()).not.toBe(newTopic());
  });

  it("says where a phone subscribes over Tailscale: HTTPS through Serve, or the short name on the port", async () => {
    const given = deps();
    given.run = vi.fn(async (_binary, args) => (args[0] === "serve"
      ? { ok: true, stdout: JSON.stringify({ TCP: {}, Web: {} }), stderr: "" }
      : { ok: true, stdout: JSON.stringify({ Self: { DNSName: "homebox.tail0a1b.ts.net." } }), stderr: "" }));
    expect((await operation.run({}, given)).subscribeUrl).toBe("http://homebox:8093");
    expect(subscribeAddress({ port: 8093, serves: [{ port: 8093, dnsName: "homebox.tail0a1b.ts.net" }], dnsName: "homebox.tail0a1b.ts.net." })).toBe("https://homebox.tail0a1b.ts.net:8093");
    expect(subscribeAddress({ port: 8093, exposure: "loopback", dnsName: "homebox.tail0a1b.ts.net." })).toBeNull();
    expect(subscribeAddress({ port: 8093, dnsName: null })).toBeNull();
    // Without Tailscale the fix still works; the page tells the owner to use the address they open ntfy at.
    given.run = vi.fn(async () => ({ ok: false, stdout: "", stderr: "tailscale not running" }));
    expect((await operation.run({}, given)).subscribeUrl).toBeNull();
  });

  it("says what to do when ntfy is not there, not running, or asks for a login", async () => {
    await expect(operation.run({}, deps({ installed: false }))).rejects.toThrow("install it from the App catalog first");
    await expect(operation.run({}, deps({ running: false }))).rejects.toThrow("not running; start it");
    await expect(operation.run({}, deps({ answer: { ok: false, status: 403 } }))).rejects.toThrow("asks for a login (it answered 403)");
    await expect(operation.run({}, deps({ answer: { ok: false, status: 500 } }))).rejects.toThrow("did not accept the test (it answered 500). Nothing was changed.");
  });
});
