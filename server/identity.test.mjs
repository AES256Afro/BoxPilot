import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 30_000 });
import { createIdentityService, isTailnetAddress, signinClientKey, tailnetClientAddress } from "./identity.mjs";
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

  it("believes only BoxPilot's socket once Tailscale Serve forwards to it", async () => {
    // A host-networked app is sent the owner's cookies and Serve's headers when the owner opens it
    // on this hostname; over the loopback port it could write the same headers and be believed.
    const state = await store();
    const socketPath = "/run/boxpilot-web/serve.sock";
    const serveTo = (target) => JSON.stringify({ Web: { "box.tail1234.ts.net:443": { Handlers: { "/": { Proxy: target } } } } });
    const identityFor = (target) => createIdentityService({ store: state, now: () => 1000, serveSocket: socketPath, run: vi.fn(async (_binary, args) => (args[0] === "serve"
      ? { ok: true, stdout: serveTo(typeof target === "function" ? target() : target), stderr: "" }
      : { ok: true, stdout: JSON.stringify({ UserProfile: { LoginName: "me@example.com" } }), stderr: "" })) });
    const headers = { "x-forwarded-for": "100.67.166.49", "tailscale-user-login": "me@example.com" };
    const overPort = req("127.0.0.1", headers);
    const overSocket = { ...req("127.0.0.1", headers), socket: { remoteAddress: "127.0.0.1", boxpilotServeSocket: true } };

    const viaSocket = identityFor(`unix:${socketPath}`);
    expect(await viaSocket.clientAddress(overSocket)).toBe("100.67.166.49");
    expect(await viaSocket.clientAddress(overPort)).toBeNull();
    expect(await viaSocket.tailscaleIdentity(overPort)).toMatchObject({ available: false, reason: "not-tailnet" });
    expect(await viaSocket.servePublishesControlPlane()).toBe(true);
    expect(await viaSocket.serveOverLoopbackOnly()).toBe(false);

    // Not moved yet: the loopback port is still how Serve reaches BoxPilot. The socket is believed
    // all the same (only root and BoxPilot can open it), so the minute before the cached Serve facts
    // see a move neither signs tailnet sessions out nor binds a sign-in to loopback.
    const viaPort = identityFor("http://127.0.0.1:8787");
    expect(await viaPort.clientAddress(overPort)).toBe("100.67.166.49");
    expect(await viaPort.clientAddress(overSocket)).toBe("100.67.166.49");
    expect(await viaPort.serveOverLoopbackOnly()).toBe(true);

    // Moving Serve forgets the cached facts, so the port stops being believed at once.
    let target = "http://127.0.0.1:8787";
    const moving = identityFor(() => target);
    expect(await moving.clientAddress(overPort)).toBe("100.67.166.49");
    target = `unix://${socketPath}`;
    expect(await moving.clientAddress(overPort)).toBe("100.67.166.49");   // still the cached facts
    moving.forgetServeState();
    expect(await moving.clientAddress(overPort)).toBeNull();
    expect(await moving.serveOverLoopbackOnly()).toBe(false);

    // Some other socket is not BoxPilot's.
    const elsewhere = identityFor("unix:/run/other/app.sock");
    expect(await elsewhere.servePublishesControlPlane()).toBe(false);
    expect(await elsewhere.clientAddress(overPort)).toBeNull();
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
    state.close();
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
      : { ok: true, json: async () => ({ error: "authorization_pending" }) });
    let clock = 1000;
    const identity = createIdentityService({ store: state, fetchImpl, now: () => clock });
    const start = (client) => { clock += 1; return identity.githubStart({ purpose: "signin", client }); };
    const first = await start("100.64.0.9");
    await start("100.64.0.9");
    await expect(start("100.64.0.9")).rejects.toThrow("from this device");
    // Four more callers hold two flows each: the table of ten is full.
    for (const client of ["a", "a", "b", "b", "c", "c", "d", "d"]) await start(client);
    // A newcomer is not refused: the oldest flow of a caller holding two gives way, and that is the
    // first one 100.64.0.9 started, the oldest of all of them.
    const newcomer = await start("honest");
    expect(await identity.githubPoll(first.flowId)).toEqual({ status: "expired" });
    // More newcomers take from the callers still holding two, never the first newcomer's only flow.
    for (const client of ["e", "f", "g"]) await start(client);
    expect(await identity.githubPoll(newcomer.flowId)).toMatchObject({ status: "pending" });
    // Even when its flow is the oldest, a caller holding one keeps it while another holds two.
    const fresh = createIdentityService({ store: state, fetchImpl, now: () => clock });
    const startFresh = (client) => { clock += 1; return fresh.githubStart({ purpose: "signin", client }); };
    const patient = await startFresh("patient");
    for (const client of ["w", "w", "x", "x", "y", "y", "z", "z", "solo"]) await startFresh(client);
    await startFresh("late");
    expect(await fresh.githubPoll(patient.flowId)).toMatchObject({ status: "pending" });
    // When every caller holds a single flow, a newcomer is refused rather than cancelling one: the
    // owner's flow in progress survives any number of restarts from other addresses.
    const singles = createIdentityService({ store: state, fetchImpl, now: () => clock });
    const startSingle = (client) => { clock += 1; return singles.githubStart({ purpose: "signin", client }); };
    const ownerFlow = await startSingle("owner-laptop");
    for (const client of ["s1", "s2", "s3", "s4", "s5", "s6", "s7", "s8", "s9"]) await startSingle(client);
    for (const client of ["s1", "s2", "s3", "s9"]) await expect(startSingle(client)).rejects.toThrow("Every GitHub sign-in slot is in use");
    expect(await singles.githubPoll(ownerFlow.flowId)).toMatchObject({ status: "pending" });
    // The owner can still start a link flow while sign-in slots are full.
    await expect(identity.githubStart({ purpose: "link", ownerId: owner.id, client: "e" })).resolves.toMatchObject({ userCode: "ABCD-EFGH" });
    state.close();
  });
});

describe("who a GitHub sign-in flow counts against", () => {
  it("counts an IPv6 caller by its /64, and a tailnet or IPv4 caller by its address", () => {
    expect(signinClientKey("2001:db8:1:2:aaaa::1")).toBe("2001:db8:1:2::/64");
    expect(signinClientKey("2001:0db8:0001:0002:ffff:eeee:dddd:cccc")).toBe("2001:db8:1:2::/64");
    expect(signinClientKey("2001:db8::7")).toBe("2001:db8:0:0::/64");
    expect(signinClientKey("::ffff:192.0.2.4")).toBe("192.0.2.4");
    expect(signinClientKey("100.64.0.9")).toBe("100.64.0.9");
    expect(signinClientKey("fd7a:115c:a1e0::1234")).toBe("fd7a:115c:a1e0::1234");
    expect(signinClientKey(null)).toBeNull();
  });

  it("holds two addresses in one /64 to one caller's two flows", async () => {
    const state = await store();
    state.setSetting("githubClientId", "Ov23liabcdefghijklmn");
    const fetchImpl = async () => ({ ok: true, json: async () => ({ device_code: "d", user_code: "ABCD-EFGH", verification_uri: "https://github.com/login/device", interval: 5, expires_in: 900 }) });
    const identity = createIdentityService({ store: state, fetchImpl, now: () => 1000 });
    await identity.githubStart({ purpose: "signin", client: "2001:db8:1:2::a" });
    await identity.githubStart({ purpose: "signin", client: "2001:db8:1:2::b" });
    await expect(identity.githubStart({ purpose: "signin", client: "2001:db8:1:2::c" })).rejects.toThrow("from this device");
    state.close();
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

describe("GitHub links and the device flow's answers", () => {
  it("never signs in through a link saved before ids were recorded, and keeps a login linked to one account", async () => {
    const state = await store();
    const owner = state.consumeBootstrapToken(state.createBootstrapToken().token, { username: "admin", passwordHash: "x" });
    const operator = state.createOwnerAccount({ username: "helper", passwordHash: "x", role: "operator", createdBy: owner.id });
    const identity = createIdentityService({ store: state, now: () => 1000 });
    // A link from before ids: GitHub may have given the name to someone else since.
    state.setSetting("githubLinks", { oldname: { ownerId: owner.id, login: "OldName" } }, { updatedBy: owner.id });
    expect(identity.githubAccountFor("OldName", 7)).toBeNull();
    expect(identity.githubAccountFor("OldName", null)).toBeNull();
    identity.linkGithub(owner.id, "Alex-GH", 7);
    expect(() => identity.linkGithub(operator.id, "alex-gh", 8)).toThrow("already linked to another account");
    expect(identity.githubAccountFor("ALEX-GH", 7)).toBe(owner.id);
    expect(() => identity.linkGithub(owner.id, "-bad login-", 9)).toThrow("looks invalid");
    state.close();
  });

  it("slows down when GitHub asks, and says expired, denied or failed without completing", async () => {
    const state = await store();
    const owner = state.consumeBootstrapToken(state.createBootstrapToken().token, { username: "admin", passwordHash: "x" });
    let answer = { error: "slow_down" };
    let profile = { ok: true, body: { login: "alex-gh", id: 7 } };
    const fetchImpl = vi.fn(async (url) => {
      if (url === "https://github.com/login/device/code") return { ok: true, status: 200, json: async () => ({ device_code: "dev", user_code: "AAAA-BBBB", verification_uri: "https://github.com/login/device", expires_in: 900, interval: 5 }) };
      if (url === "https://github.com/login/oauth/access_token") return { ok: true, status: 200, json: async () => answer };
      return { ok: profile.ok, status: profile.ok ? 200 : 401, json: async () => profile.body };
    });
    let clock = 0;
    const identity = createIdentityService({ store: state, fetchImpl, now: () => clock });
    identity.setGithubClientId(owner.id, "Iv1.abcdef1234567890");
    const start = () => identity.githubStart({ purpose: "signin", client: `c${clock}` });

    const slow = await start();
    expect(await identity.githubPoll(slow.flowId)).toMatchObject({ status: "pending" });
    clock += 6_000; // the old interval has passed, but slow_down added five seconds to it
    expect(await identity.githubPoll(slow.flowId)).toMatchObject({ status: "pending" });
    expect(fetchImpl.mock.calls.filter(([url]) => url.endsWith("access_token"))).toHaveLength(1);

    for (const [error, status] of [["expired_token", "expired"], ["access_denied", "denied"]]) {
      clock += 60_000; answer = { error };
      const flow = await start();
      expect(await identity.githubPoll(flow.flowId)).toMatchObject({ status });
      expect(await identity.githubPoll(flow.flowId)).toEqual({ status: "expired" });
    }
    clock += 60_000; answer = { error: "incorrect_client_credentials", error_description: "The client_id is not valid" };
    expect(await identity.githubPoll((await start()).flowId)).toMatchObject({ status: "error", error: "The client_id is not valid" });
    clock += 60_000; answer = { access_token: "gho_x" }; profile = { ok: false, body: { login: "alex-gh", id: 7, message: "Bad credentials" } };
    expect(await identity.githubPoll((await start()).flowId)).toMatchObject({ status: "error", error: "Could not read the GitHub profile" });
    state.close();
  });

  it("says why a flow could not start", async () => {
    const state = await store();
    const owner = state.consumeBootstrapToken(state.createBootstrapToken().token, { username: "admin", passwordHash: "x" });
    const identity = createIdentityService({ store: state, fetchImpl: async () => ({ ok: false, status: 404, json: async () => ({ error: "Not Found" }) }), now: () => 0 });
    identity.setGithubClientId(owner.id, "Iv1.abcdef1234567890");
    await expect(identity.githubStart({ purpose: "link", ownerId: owner.id })).rejects.toThrow("Not Found");
    state.close();
  });
});
