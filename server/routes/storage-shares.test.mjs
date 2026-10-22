import express from "express";
import { afterEach, describe, expect, it } from "vitest";
import { createStorageRouter } from "./storage.mjs";

/*
 * Listing and finding shares on other machines runs smbclient, showmount and a LAN sweep for the
 * caller. What reaches those commands is checked first, a password goes on stdin and never into
 * argv, and what samba.inspect reads as root reaches only an operator or the owner (ADR-003).
 */

const accounts = { alex: { id: "alex", role: "owner" }, olly: { id: "olly", role: "operator" }, vic: { id: "vic", role: "viewer" } };
const servers = [];
afterEach(async () => { for (const server of servers.splice(0)) { server.closeAllConnections?.(); await new Promise((resolve) => server.close(resolve)); } });

async function serve({ answer = () => ({ ok: true, stdout: "Disk|Media|Films\nDisk|IPC$|hidden\nPrinter|Laser|\n", stderr: "" }), probe = async () => false } = {}) {
  const runs = [];
  const helper = { request: async () => ({ installed: true, running: true, configured: true, config: { managed: true, shares: [{ name: "media", path: "/srv/media", recycleBytes: 123, ownerUid: 1000 }] }, users: [] }) };
  const auth = {
    requireCsrf: (request, response, next) => (request.get("x-boxpilot-csrf") === "csrf" ? next() : response.status(403).json({ code: "csrf_required" })),
    requireRole: (...roles) => (request, response, next) => (roles.includes(request.boxpilotSession.owner.role) ? next() : response.status(403).json({ code: "forbidden" })),
  };
  const run = async (binary, args, options) => { runs.push({ binary, args, input: options?.input ?? null }); return answer(binary, args); };
  const app = express();
  app.use(express.json());
  app.use((request, _response, next) => { request.boxpilotSession = { owner: accounts[request.get("x-test-session")] }; next(); });
  app.use(createStorageRouter({ auth, helper, run, probe, reverse: async () => [], sweepLimit: 4 }));
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  servers.push(server);
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, url, { as = "alex", body, csrf = true } = {}) => {
    const response = await fetch(`${base}${url}`, { method, headers: { "Content-Type": "application/json", "x-test-session": as, ...(csrf ? { "x-boxpilot-csrf": "csrf" } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: response.status, body: await response.json() };
  };
  return { call, runs };
}

describe("listing another machine's shares", () => {
  it("puts the password on stdin and never in the arguments, and lists only disk shares", async () => {
    const { call, runs } = await serve();
    expect(await call("POST", "/storage/shares/list", { body: { kind: "smb", host: "nas.local", username: "alex", domain: "HOME", password: "hunter2 secret" } })).toEqual({ status: 200, body: { shares: [{ name: "Media", comment: "Films" }] } });
    expect(runs).toEqual([{ binary: "/usr/bin/smbclient", args: ["-L", "//nas.local", "-g", "-U", "HOME\\alex"], input: "hunter2 secret\n" }]);
    expect(JSON.stringify(runs[0].args)).not.toContain("hunter2");
    await call("POST", "/storage/shares/list", { body: { kind: "smb", host: "192.168.1.20" } });
    expect(runs[1]).toEqual({ binary: "/usr/bin/smbclient", args: ["-L", "//192.168.1.20", "-g", "-N"], input: null });
  });

  it("refuses a host, user or domain that could become an option or another command, before running anything", async () => {
    const { call, runs } = await serve();
    const bodies = [
      { kind: "smb", host: "-oProxyCommand=sh" },
      { kind: "smb", host: "nas.local; reboot" },
      { kind: "nfs", host: "nas local" },
      { kind: "ssh", host: "nas.local" },
      { kind: "smb", host: "nas.local", username: "alex -c id" },
      { kind: "smb", host: "nas.local", username: "alex", domain: "HOME\nX" },
      { kind: "smb", host: ["nas.local"] },
    ];
    for (const body of bodies) expect(await call("POST", "/storage/shares/list", { body })).toMatchObject({ status: 400, body: { code: "invalid_request" } });
    expect(runs).toEqual([]);
  });

  it("names why a listing failed, and lists NFS exports with showmount", async () => {
    const refused = await serve({ answer: () => ({ ok: false, stdout: "", stderr: "session setup failed: NT_STATUS_LOGON_FAILURE" }) });
    expect((await refused.call("POST", "/storage/shares/list", { body: { kind: "smb", host: "nas.local", username: "alex", password: "x" } })).body.error).toMatch(/refused these credentials/);
    const nfs = await serve({ answer: () => ({ ok: true, stdout: "/volume1/media 192.168.1.0/24\n", stderr: "" }) });
    expect(await nfs.call("POST", "/storage/shares/list", { body: { kind: "nfs", host: "nas.local" } })).toEqual({ status: 200, body: { shares: [{ name: "/volume1/media", comment: "allowed: 192.168.1.0/24" }] } });
    expect(nfs.runs[0]).toMatchObject({ binary: "/usr/sbin/showmount", args: ["-e", "--no-headers", "nas.local"] });
  });

  it("needs the CSRF token, and runs at most twelve listings a minute per account", async () => {
    const { call, runs } = await serve();
    expect((await call("POST", "/storage/shares/list", { csrf: false, body: { kind: "smb", host: "nas.local" } })).status).toBe(403);
    for (let index = 0; index < 12; index += 1) expect((await call("POST", "/storage/shares/list", { as: "olly", body: { kind: "smb", host: "nas.local" } })).status).toBe(200);
    expect((await call("POST", "/storage/shares/list", { as: "olly", body: { kind: "smb", host: "nas.local" } })).status).toBe(429);
    expect(runs).toHaveLength(12);
  });
});

describe("finding shares and reading this server's file server", () => {
  it("sweeps the LAN for an operator or the owner, never a viewer", async () => {
    const answer = (binary, args) => (args.includes("address")
      ? { ok: true, stdout: JSON.stringify([{ ifname: "eth0", addr_info: [{ family: "inet", scope: "global", local: "192.168.1.10", prefixlen: 24 }] }, { ifname: "docker0", addr_info: [{ family: "inet", scope: "global", local: "172.17.0.1", prefixlen: 24 }] }]), stderr: "" }
      : { ok: true, stdout: "[]", stderr: "" });
    const probed = [];
    const { call } = await serve({ answer, probe: async (host, port) => { probed.push(host); return host === "192.168.1.2" && port === 445; } });
    expect((await call("GET", "/storage/shares/discover", { as: "vic" })).status).toBe(403);
    expect(probed).toEqual([]);
    const found = await call("GET", "/storage/shares/discover", { as: "olly" });
    expect(found.body).toMatchObject({ devices: [{ address: "192.168.1.2", smb: true, nfs: false }], scanned: 4, interfaces: ["eth0 192.168.1.10/24"] });
    expect(probed.every((host) => host.startsWith("192.168.1."))).toBe(true);
  });

  it("keeps what samba.inspect reads as root from a viewer", async () => {
    const { call } = await serve();
    expect((await call("GET", "/storage/samba", { as: "olly" })).body.config.shares[0]).toEqual({ name: "media", path: "/srv/media", recycleBytes: 123, ownerUid: 1000 });
    expect((await call("GET", "/storage/samba", { as: "vic" })).body.config.shares[0]).toEqual({ name: "media", path: "/srv/media" });
  });
});
