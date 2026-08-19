import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createIdentityService, isTailnetAddress, tailnetClientAddress } from "./identity.mjs";
import { createStateStore } from "./state.mjs";

const directories = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((d) => rm(d, { recursive: true, force: true }))); });
async function store() { const directory = await mkdtemp(path.join(os.tmpdir(), "boxpilot-identity-")); directories.push(directory); return createStateStore({ stateDirectory: directory }); }
const req = (remote, headers = {}) => ({ socket: { remoteAddress: remote }, get: (name) => headers[name.toLowerCase()] ?? undefined, headers });

describe("tailnet addressing", () => {
  it("recognises tailnet addresses and trusts X-Forwarded-For only from loopback", () => {
    expect(isTailnetAddress("100.67.166.48")).toBe(true);
    expect(isTailnetAddress("::ffff:100.101.1.1")).toBe(true);
    expect(isTailnetAddress("fd7a:115c:a1e0::1")).toBe(true);
    expect(isTailnetAddress("192.168.8.10")).toBe(false);
    expect(isTailnetAddress("100.200.1.1")).toBe(false);
    expect(tailnetClientAddress(req("100.67.166.48"))).toBe("100.67.166.48");
    expect(tailnetClientAddress(req("127.0.0.1", { "x-forwarded-for": "100.67.166.49" }))).toBe("100.67.166.49");
    expect(tailnetClientAddress(req("192.168.8.20", { "x-forwarded-for": "100.67.166.49" }))).toBeNull();
    expect(tailnetClientAddress(req("127.0.0.1", { "x-forwarded-for": "203.0.113.5" }))).toBeNull();
    expect(tailnetClientAddress(req("192.168.8.20"))).toBeNull();
  });
});

describe("identity service", () => {
  it("resolves and links a Tailscale identity via whois", async () => {
    const state = await store();
    const owner = state.consumeBootstrapToken(state.createBootstrapToken().token, { username: "admin", passwordHash: "x" });
    const run = vi.fn(async (_binary, args) => args[0] === "whois" && args[2] === "100.67.166.49" ? { ok: true, stdout: JSON.stringify({ Node: { Name: "laptop.tail.ts.net." }, UserProfile: { LoginName: "me@example.com", DisplayName: "Me" } }), stderr: "" } : { ok: false, stdout: "", stderr: "no match" });
    const identity = createIdentityService({ store: state, run, now: () => 1000 });
    expect(await identity.tailscaleIdentity(req("192.168.8.20"))).toMatchObject({ available: false, reason: "not-tailnet" });
    expect(await identity.tailscaleIdentity(req("100.67.166.50"))).toMatchObject({ available: false, reason: "whois-unavailable" });
    const me = await identity.tailscaleIdentity(req("127.0.0.1", { "x-forwarded-for": "100.67.166.49" }));
    expect(me).toMatchObject({ available: true, login: "me@example.com", displayName: "Me", node: "laptop.tail.ts.net", linked: false });
    expect(identity.linkTailscale(owner.id, "me@example.com")).toEqual(["me@example.com"]);
    expect((await identity.tailscaleIdentity(req("100.67.166.49"))).linked).toBe(true);
    expect(run).toHaveBeenCalledTimes(2); // cached
    expect(identity.unlinkTailscale(owner.id, "me@example.com")).toEqual([]);
    expect(() => identity.linkTailscale(owner.id, "not-an-email")).toThrow("email");
    expect(state.listAudit().map((event) => event.type)).toEqual(expect.arrayContaining(["identity.tailscale.linked", "identity.tailscale.unlinked"]));
    state.close();
  });

  it("runs the GitHub device flow and links or signs in by login", async () => {
    const state = await store();
    const owner = state.consumeBootstrapToken(state.createBootstrapToken().token, { username: "admin", passwordHash: "x" });
    let polls = 0;
    const fetchImpl = vi.fn(async (url, init) => {
      if (url === "https://github.com/login/device/code") return { ok: true, status: 200, json: async () => ({ device_code: "dev-1", user_code: "ABCD-1234", verification_uri: "https://github.com/login/device", expires_in: 900, interval: 5 }) };
      if (url === "https://github.com/login/oauth/access_token") { polls += 1; return { ok: true, status: 200, json: async () => (polls < 2 ? { error: "authorization_pending" } : { access_token: "gho_x" }) }; }
      if (url === "https://api.github.com/user") { expect(init.headers.Authorization).toBe("Bearer gho_x"); return { ok: true, status: 200, json: async () => ({ login: "AES256Afro", id: 42 }) }; }
      throw new Error(`unexpected ${url}`);
    });
    let clock = 0;
    const identity = createIdentityService({ store: state, fetchImpl, now: () => clock });
    await expect(identity.githubStart()).rejects.toThrow("not configured");
    identity.setGithubClientId(owner.id, "Iv1.abcdef1234567890");
    expect(() => identity.setGithubClientId(owner.id, "bad id!")).toThrow("invalid");
    const flow = await identity.githubStart({ purpose: "link", ownerId: owner.id });
    expect(flow).toMatchObject({ userCode: "ABCD-1234", verificationUri: "https://github.com/login/device", intervalSeconds: 5 });
    expect(await identity.githubPoll(flow.flowId)).toMatchObject({ status: "pending" }); // first poll → authorization_pending
    expect(await identity.githubPoll(flow.flowId)).toMatchObject({ status: "pending" }); // rate limited locally
    clock += 6000;
    expect(await identity.githubPoll(flow.flowId)).toMatchObject({ status: "complete", login: "AES256Afro", purpose: "link", ownerId: owner.id });
    expect(await identity.githubPoll(flow.flowId)).toMatchObject({ status: "expired" });
    expect(identity.githubLinked("aes256afro")).toBe(false);
    identity.linkGithub(owner.id, "AES256Afro");
    expect(identity.githubLinked("aes256afro")).toBe(true);
    expect(identity.summary()).toMatchObject({ githubLogins: ["AES256Afro"], githubConfigured: true });
    identity.unlinkGithub(owner.id, "AES256Afro");
    expect(identity.summary().githubLogins).toEqual([]);
    state.close();
  });
});
