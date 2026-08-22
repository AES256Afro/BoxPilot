import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 30_000 });
import { createIdentityService, isTailnetAddress, tailnetClientAddress } from "./identity.mjs";
import { createStateStore } from "./state.mjs";

const directories = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((d) => rm(d, { recursive: true, force: true }))); });
async function store() { const directory = await mkdtemp(path.join(os.tmpdir(), "boxpilot-identity-")); directories.push(directory); return createStateStore({ stateDirectory: directory }); }
const req = (remote, headers = {}) => ({ socket: { remoteAddress: remote }, get: (name) => headers[name.toLowerCase()] ?? undefined, headers });

describe("tailnet addressing", () => {
  it("recognises tailnet addresses, and only tailnet addresses", () => {
    expect(isTailnetAddress("100.67.166.48")).toBe(true);
    expect(isTailnetAddress("::ffff:100.101.1.1")).toBe(true);
    expect(isTailnetAddress("fd7a:115c:a1e0::1")).toBe(true);
    expect(isTailnetAddress("192.168.1.10")).toBe(false);
    expect(isTailnetAddress("100.200.1.1")).toBe(false);
    // The marker followed by anything at all used to pass, so a caller could mint an unlimited
    // supply of distinct "addresses" — each one a whois subprocess and a permanent cache entry.
    expect(isTailnetAddress(`fd7a:115c:a1e0:${"9".repeat(4000)}`)).toBe(false);
  });

  it("believes a forwarded address only when told the proxy in front is trustworthy", () => {
    expect(tailnetClientAddress(req("100.67.166.48"))).toBe("100.67.166.48");
    // Loopback alone proves nothing: an SSH tunnel or a container on this box reaches loopback too.
    expect(tailnetClientAddress(req("127.0.0.1", { "x-forwarded-for": "100.67.166.49" }))).toBeNull();
    expect(tailnetClientAddress(req("127.0.0.1", { "x-forwarded-for": "100.67.166.49" }), { trustForwarded: true })).toBe("100.67.166.49");
    expect(tailnetClientAddress(req("192.168.1.20", { "x-forwarded-for": "100.67.166.49" }), { trustForwarded: true })).toBeNull();
    expect(tailnetClientAddress(req("127.0.0.1", { "x-forwarded-for": "203.0.113.5" }), { trustForwarded: true })).toBeNull();
    expect(tailnetClientAddress(req("192.168.1.20"))).toBeNull();
  });
});

describe("identity service", () => {
  it("resolves and links a Tailscale identity via whois", async () => {
    const state = await store();
    const owner = state.consumeBootstrapToken(state.createBootstrapToken().token, { username: "admin", passwordHash: "x" });
    // Serve is proxying this port, which is what makes a forwarded address believable.
    const serveStatus = JSON.stringify({ Web: { "box.tail1234.ts.net:443": { Handlers: { "/": { Proxy: "http://127.0.0.1:8787" } } } } });
    const run = vi.fn(async (_binary, args) => {
      if (args[0] === "serve") return { ok: true, stdout: serveStatus, stderr: "" };
      return args[0] === "whois" && args[2] === "100.67.166.49"
        ? { ok: true, stdout: JSON.stringify({ Node: { Name: "laptop.tail.ts.net." }, UserProfile: { LoginName: "me@example.com", DisplayName: "Me" } }), stderr: "" }
        : { ok: false, stdout: "", stderr: "no match" };
    });
    const identity = createIdentityService({ store: state, run, now: () => 1000 });
    expect(await identity.tailscaleIdentity(req("192.168.1.20"))).toMatchObject({ available: false, reason: "not-tailnet" });
    expect(await identity.tailscaleIdentity(req("100.67.166.50"))).toMatchObject({ available: false, reason: "whois-unavailable" });
    // Through Serve: it forwards the address and labels the request with the user it came from.
    const me = await identity.tailscaleIdentity(req("127.0.0.1", { "x-forwarded-for": "100.67.166.49", "tailscale-user-login": "me@example.com" }));
    expect(me).toMatchObject({ available: true, login: "me@example.com", displayName: "Me", node: "laptop.tail.ts.net", linked: false });
    expect(identity.linkTailscale(owner.id, "me@example.com")).toEqual(["me@example.com"]);
    expect((await identity.tailscaleIdentity(req("100.67.166.49"))).linked).toBe(true);
    expect(run.mock.calls.filter(([, args]) => args[0] === "whois")).toHaveLength(2); // cached
    expect(identity.unlinkTailscale(owner.id, "me@example.com")).toEqual([]);
    expect(() => identity.linkTailscale(owner.id, "not-an-email")).toThrow("email");

    // Without Serve in front, a loopback caller's X-Forwarded-For is just a header they wrote:
    // an SSH tunnel or any container on the box could otherwise claim to be any tailnet peer.
    const withoutServe = createIdentityService({ store: state, now: () => 1000, run: vi.fn(async (_binary, args) => (args[0] === "serve" ? { ok: true, stdout: "{}", stderr: "" } : { ok: true, stdout: JSON.stringify({ UserProfile: { LoginName: "me@example.com" } }), stderr: "" })) });
    expect(await withoutServe.tailscaleIdentity(req("127.0.0.1", { "x-forwarded-for": "100.67.166.49", "tailscale-user-login": "me@example.com" }))).toMatchObject({ available: false, reason: "not-tailnet" });
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
    expect(identity.githubLinked("aes256afro", 4242)).toBe(false);
    identity.linkGithub(owner.id, "AES256Afro", 4242);
    // The numeric id is what identifies the account: GitHub releases a login when an account is
    // renamed or deleted, and whoever registers it next must not inherit the link.
    expect(identity.githubLinked("aes256afro", 4242)).toBe(true);
    expect(identity.githubLinked("aes256afro", 9999)).toBe(false);
    expect(identity.summary()).toMatchObject({ githubLogins: ["AES256Afro"], githubConfigured: true });
    identity.unlinkGithub(owner.id, "AES256Afro");
    expect(identity.summary().githubLogins).toEqual([]);
    state.close();
  });
});

describe("per-account identity links", () => {
  it("signs identity logins in as the account that linked them, never the first owner by default", async () => {
    const state = await store();
    const owner = state.consumeBootstrapToken(state.createBootstrapToken().token, { username: "admin", passwordHash: "x" });
    const operator = state.createOwnerAccount({ username: "helper", passwordHash: "x", role: "operator", createdBy: owner.id });
    const identity = createIdentityService({ store: state, run: vi.fn(async () => ({ ok: false, stdout: "", stderr: "" })), now: () => 1000 });
    identity.linkTailscale(operator.id, "helper@example.com");
    expect(identity.tailscaleAccountFor("helper@example.com")).toBe(operator.id);
    expect(identity.tailscaleAccountFor("nobody@example.com")).toBeNull();
    // Links recorded before per-account links existed belong to the first owner.
    state.setSetting("tailscaleLogins", ["legacy@example.com"]);
    expect(identity.tailscaleAccountFor("legacy@example.com")).toBe(owner.id);
    expect(() => identity.linkTailscale(owner.id, "helper@example.com")).toThrow("another account");
    expect(() => identity.unlinkTailscale(owner.id, "helper@example.com")).toThrow("Only the owner");
    expect(identity.unlinkTailscale(owner.id, "helper@example.com", { force: true })).not.toContain("helper@example.com");
    identity.linkGithub(operator.id, "HelperDev", 4242);
    expect(identity.githubAccountFor("helperdev", 4242)).toBe(operator.id);
    expect(identity.githubAccountFor("helperdev", 9999)).toBeNull(); // a renamed login reused by someone else
    expect(identity.githubLinked("HelperDev", 4242)).toBe(true);
    // A bare login recorded before ids were kept is not an authentication source any more: the
    // owner re-links it from Settings rather than have a released name sign in as the first owner.
    state.setSetting("githubLogins", ["legacydev"]);
    expect(identity.githubAccountFor("legacydev", 1234)).toBeNull();
  });
});

describe("GitHub device-flow limits", () => {
  it("caps anonymous sign-in flows per client and keeps headroom for the owner's link flow", async () => {
    const state = await store();
    const owner = state.consumeBootstrapToken(state.createBootstrapToken().token, { username: "admin", passwordHash: "x" });
    state.setSetting("githubClientId", "Ov23liabcdefghijklmn");
    let issued = 0;
    const fetchImpl = async (url) => (String(url).includes("device/code")
      ? { ok: true, json: async () => ({ device_code: `d${issued++}`, user_code: "ABCD-EFGH", verification_uri: "https://github.com/login/device", interval: 5, expires_in: 900 }) }
      : { ok: false, json: async () => ({}) });
    const identity = createIdentityService({ store: state, fetchImpl, now: () => 1000 });
    await identity.githubStart({ purpose: "signin", client: "100.64.0.9" });
    await identity.githubStart({ purpose: "signin", client: "100.64.0.9" });
    await expect(identity.githubStart({ purpose: "signin", client: "100.64.0.9" })).rejects.toThrow("from this device");
    for (const client of ["a", "b", "c"]) await identity.githubStart({ purpose: "signin", client });
    await expect(identity.githubStart({ purpose: "signin", client: "d" })).rejects.toThrow("sign-in attempts in progress");
    // The owner can still start a link flow while sign-in slots are full.
    await expect(identity.githubStart({ purpose: "link", ownerId: owner.id, client: "e" })).resolves.toMatchObject({ userCode: "ABCD-EFGH" });
  });
});

describe("Tailscale Serve's own identity header", () => {
  const serveStatus = JSON.stringify({ Web: { "box.tail1234.ts.net:443": { Handlers: { "/": { Proxy: "http://127.0.0.1:8787" } } } } });
  const whoisJson = JSON.stringify({ Node: { Name: "laptop.tail.ts.net." }, UserProfile: { LoginName: "me@example.com", DisplayName: "Me" } });
  const run = () => vi.fn(async (_binary, args) => (args[0] === "serve" ? { ok: true, stdout: serveStatus, stderr: "" } : { ok: true, stdout: whoisJson, stderr: "" }));

  it("accepts a request whose header agrees with the address", async () => {
    const state = await store();
    const identity = createIdentityService({ store: state, run: run(), now: () => 1000 });
    const result = await identity.tailscaleIdentity(req("127.0.0.1", { "x-forwarded-for": "100.67.166.49", "tailscale-user-login": "me@example.com" }));
    expect(result).toMatchObject({ available: true, login: "me@example.com" });
    state.close();
  });

  it("refuses a request whose header names somebody else", async () => {
    // Two independent statements about who is calling; they have to agree.
    const state = await store();
    const identity = createIdentityService({ store: state, run: run(), now: () => 1000 });
    const result = await identity.tailscaleIdentity(req("127.0.0.1", { "x-forwarded-for": "100.67.166.49", "tailscale-user-login": "someone.else@example.com" }));
    expect(result).toMatchObject({ available: false, reason: "identity-mismatch" });
    state.close();
  });
});

describe("a forwarded address with no label from the proxy", () => {
  it("is refused, because that is what a process on this box can produce", async () => {
    // Serve labels every request it forwards. An address forwarded without one did not come
    // through Serve — it came from something local, and loopback alone cannot tell them apart.
    const state = await store();
    const serveStatus = JSON.stringify({ Web: { "box.tail1234.ts.net:443": { Handlers: { "/": { Proxy: "http://127.0.0.1:8787" } } } } });
    const identity = createIdentityService({ store: state, now: () => 1000, run: vi.fn(async (_binary, args) => (args[0] === "serve" ? { ok: true, stdout: serveStatus, stderr: "" } : { ok: true, stdout: JSON.stringify({ UserProfile: { LoginName: "me@example.com" } }), stderr: "" })) });
    expect(await identity.tailscaleIdentity(req("127.0.0.1", { "x-forwarded-for": "100.67.166.49" }))).toMatchObject({ available: false, reason: "not-tailnet" });
    state.close();
  });
});

describe("administering a GitHub link", () => {
  it("knows who a link belongs to without being told the account number", async () => {
    // Signing in needs the immutable id; deciding whose link it is does not, and asking the
    // sign-in question without an id always answered "nobody" — which silently made the
    // ownership guard useless and hid an operator's own link from their settings page.
    const state = await store();
    const owner = state.consumeBootstrapToken(state.createBootstrapToken().token, { username: "admin", passwordHash: "x" });
    const operator = state.createOwnerAccount({ username: "helper", passwordHash: "x", role: "operator", createdBy: owner.id });
    const identity = createIdentityService({ store: state, run: vi.fn(async () => ({ ok: false, stdout: "", stderr: "" })), now: () => 1000 });
    identity.linkGithub(operator.id, "HelperDev", 4242);

    expect(identity.githubOwnerFor("helperdev")).toBe(operator.id);
    // The operator can see and manage their own link...
    expect(identity.summary(operator.id).githubLogins).toEqual(["HelperDev"]);
    // ...and cannot remove somebody else's.
    identity.linkGithub(owner.id, "OwnerDev", 99);
    expect(() => identity.unlinkGithub(operator.id, "OwnerDev")).toThrow(/Only the owner/);
    expect(identity.summary(operator.id).githubLogins).toEqual(["HelperDev"]);
    state.close();
  });
});

describe("recognising this service behind Tailscale Serve", () => {
  const forge = async (target, webPort) => {
    const run = vi.fn(async (_binary, args) => (args[0] === "serve"
      ? { ok: true, stdout: JSON.stringify({ Web: { "box:443": { Handlers: { "/": { Proxy: target } } } } }), stderr: "" }
      : { ok: true, stdout: JSON.stringify({ UserProfile: { LoginName: "me@example.com" } }), stderr: "" }));
    const state = await store();
    const identity = createIdentityService({ store: state, run, now: () => 1000, webPort });
    const result = await identity.tailscaleIdentity(req("127.0.0.1", { "x-forwarded-for": "100.67.166.49", "tailscale-user-login": "me@example.com" }));
    state.close();
    return result.available;
  };

  it("accepts the loopback forms Serve actually records", async () => {
    // `tailscale serve` keeps the target as the owner typed it, so refusing "localhost:8787"
    // would quietly stop zero-password sign-in on a perfectly ordinary setup.
    expect(await forge("http://127.0.0.1:8787", 8787)).toBe(true);
    expect(await forge("localhost:8787", 8787)).toBe(true);
    expect(await forge("http://[::1]:8787", 8787)).toBe(true);
    expect(await forge("https://127.0.0.1", 443)).toBe(true); // the default port is written as blank
  });

  it("refuses a target that is not this service on this machine", async () => {
    expect(await forge("http://127.0.0.1:18787", 8787)).toBe(false);
    expect(await forge("http://192.168.1.50:8787", 8787)).toBe(false);
    expect(await forge("https://other.example:8787/x", 8787)).toBe(false);
    expect(await forge("http://127.0.0.1:8787@evil.example:9", 8787)).toBe(false);
  });
});
