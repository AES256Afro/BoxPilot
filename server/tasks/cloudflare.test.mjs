import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { onWindows } from "../../test/platform.mjs";
import { createFakeCloudflare, fakeAccount, fakeTunnelKey } from "../../test/fake-cloudflare.mjs";
import { cloudflareApiCredential, cloudflareTunnelCredential, createTunnelStateStore, normalizeTunnelState, tunnelOfKey, tunnelTargetFor } from "../cloudflare-tunnel.mjs";
import { cloudflareCheck, cloudflareConnect, cloudflarePublish, cloudflareUnpublish } from "./cloudflare.mjs";

const token = "cf-test-token-0000000000000000000000";
const zone = { id: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", name: "example.com" };
const now = () => new Date("2026-10-03T12:00:00.000Z");

function credentialStore(initial = { [cloudflareApiCredential]: token }) {
  const values = new Map(Object.entries(initial));
  return { values, read: async (name) => values.get(name) ?? null, set: async ({ name, value }) => { values.set(name, value); return { name }; }, remove: async ({ name }) => { values.delete(name); return { name }; } };
}

function memoryState(initial = null) {
  let saved = initial ? normalizeTunnelState(initial) : null;
  return { read: async () => saved, write: async (state) => { saved = normalizeTunnelState(state); return saved; }, get current() { return saved; } };
}

const tunnelId = "00000000-0000-4000-8000-0000000000aa";
const connected = (routes = []) => ({ accountId: fakeAccount.id, accountName: fakeAccount.name, tunnelId, tunnelName: "boxpilot-homebox", zones: [zone], routes, connectedAt: "2026-10-01T09:00:00.000Z" });
const existingTunnel = { id: tunnelId, name: "boxpilot-homebox", account: fakeAccount.id, status: "healthy", remote_config: true, connections: [{ client_id: "c1", colo_name: "AMS" }, { client_id: "c1", colo_name: "FRA" }, { client_id: "c2", colo_name: "AMS" }] };
const publish = { hostname: "share.example.com", zoneId: zone.id, service: "http://127.0.0.1:3022", appId: "pingvin-share", portId: "web", hostPort: 3022 };

function setup({ state = memoryState(connected()), credentials = credentialStore(), ...fake } = {}) {
  const cloudflare = createFakeCloudflare({ token, tunnels: [existingTunnel], ...fake });
  const lines = [];
  const deps = { credentials, state, fetcher: cloudflare.fetcher, now, log: (line) => lines.push(line) };
  return { cloudflare, deps, lines, state, credentials };
}

/** Nothing a task returns or logs may hold the API token or the tunnel's key. */
function expectNoSecrets(cloudflare, ...things) {
  for (const thing of things) {
    const text = JSON.stringify(thing);
    expect(text).not.toContain(token);
    expect(text).not.toContain(cloudflare.runKey);
  }
}

const directories = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });

describe("connecting Cloudflare (M42)", () => {
  it("makes this server's tunnel when there is none, saves its key as a credential and records the account and domains", async () => {
    const { cloudflare, deps, lines, state, credentials } = setup({ state: memoryState(), tunnels: [] });
    const result = await cloudflareConnect({ tunnelName: "boxpilot-homebox" }, deps);
    expect(result).toMatchObject({ account: fakeAccount, tunnel: { name: "boxpilot-homebox", created: true }, zones: [zone] });
    expect(credentials.values.get(cloudflareTunnelCredential)).toBe(cloudflare.runKey);
    expect(state.current).toMatchObject({ accountId: fakeAccount.id, tunnelName: "boxpilot-homebox", zones: [zone], routes: [], connectedAt: now().toISOString() });
    expect(cloudflare.calls.filter((call) => call.method === "POST")).toHaveLength(1);
    expect(lines.join("\n")).toContain("Made the tunnel boxpilot-homebox");
    expectNoSecrets(cloudflare, result, lines, state.current);
  });

  it("uses the tunnel already there, keeps what was published through it, and asks for its key", async () => {
    const route = { ...publish, dnsRecordId: "rec1", publishedAt: "2026-10-01T10:00:00.000Z" };
    const { cloudflare, deps, state } = setup({ state: memoryState(connected([route])) });
    const result = await cloudflareConnect({ tunnelName: "boxpilot-homebox" }, deps);
    expect(result.tunnel).toEqual({ id: tunnelId, name: "boxpilot-homebox", created: false, adopted: false });
    expect(cloudflare.calls.some((call) => call.method === "POST")).toBe(false);
    expect(cloudflare.calls.some((call) => call.route.endsWith("/token"))).toBe(true);
    expect(state.current.routes.map((entry) => entry.hostname)).toEqual(["share.example.com"]);
  });

  it("refuses a token that covers no domain, a tunnel set up from a file, and a name that is not BoxPilot's", async () => {
    await expect(cloudflareConnect({ tunnelName: "boxpilot-homebox" }, setup({ zones: [] }).deps)).rejects.toThrow(/covers no active domain/);
    await expect(cloudflareConnect({ tunnelName: "boxpilot-homebox" }, setup({ tunnels: [{ ...existingTunnel, remote_config: false }] }).deps)).rejects.toThrow(/set up from a file/);
    await expect(cloudflareConnect({ tunnelName: "someone-elses" }, setup().deps)).rejects.toThrow(/boxpilot-/);
    await expect(cloudflareConnect({ tunnelName: "boxpilot-homebox" }, setup({ credentials: credentialStore({}) }).deps)).rejects.toThrow(/no Cloudflare API token/);
  });

  it("says a refused token plainly", async () => {
    const { deps } = setup({ credentials: credentialStore({ [cloudflareApiCredential]: "a-different-token-000000000" }) });
    const error = await cloudflareConnect({ tunnelName: "boxpilot-homebox" }, deps).catch((caught) => caught);
    expect(error.message).toMatch(/^Cloudflare did not accept this token/);
    expect(error.message).not.toContain("a-different-token");
  });
});

// M65.3. The Cloudflare Tunnel app ran the owner's own tunnel, made by hand, with their site on it.
// Connect looked only for boxpilot-<this server>, made it, and the app was given its key: 530.
describe("connecting when the Cloudflare Tunnel app already runs a tunnel (M65.3)", () => {
  const ownersTunnel = { id: "11111111-1111-4111-8111-111111111111", name: "home", account: fakeAccount.id, status: "healthy", remote_config: true, connections: [{ client_id: "c1", colo_name: "AMS" }] };
  // What the helper reads from the app's key and hands over: two ids, never the key.
  const running = tunnelOfKey(fakeTunnelKey(ownersTunnel.id));
  const otherAccount = "fedcba9876543210fedcba9876543210";
  const writes = (cloudflare) => cloudflare.calls.filter((call) => call.method !== "GET");

  it("takes the running tunnel as BoxPilot's: none is made, no key is asked for, and the record names it", async () => {
    const { cloudflare, deps, lines, state, credentials } = setup({ state: memoryState(), tunnels: [ownersTunnel] });
    const result = await cloudflareConnect({ tunnelName: "boxpilot-homebox", running }, deps);
    expect(running).toEqual({ tunnelId: ownersTunnel.id, accountTag: fakeAccount.id });
    expect(result).toEqual({ account: fakeAccount, tunnel: { id: ownersTunnel.id, name: "home", created: false, adopted: true }, zones: [zone], replacedRunning: false });
    expect(writes(cloudflare)).toEqual([]);
    expect(cloudflare.state.tunnels.map((tunnel) => tunnel.name)).toEqual(["home"]);
    // The app keeps the key it runs with, which the helper saves: the task neither asks Cloudflare for one nor saves one.
    expect(cloudflare.calls.some((call) => call.route.endsWith("/token"))).toBe(false);
    expect(credentials.values.has(cloudflareTunnelCredential)).toBe(false);
    expect(state.current).toMatchObject({ accountId: fakeAccount.id, tunnelId: ownersTunnel.id, tunnelName: "home", zones: [zone], routes: [], connectedAt: now().toISOString() });
    expect(lines).toContain("The Cloudflare Tunnel app is already running your tunnel home; BoxPilot will use it and leave its names as they are.");
    expect(lines).toContain("No tunnel is made, and the app keeps the key it runs with.");
    expectNoSecrets(cloudflare, result, lines, state.current);
  });

  it("goes back to the running tunnel from the empty one made before, which is left in Cloudflare and named in the log", async () => {
    const route = { ...publish, dnsRecordId: "rec1", publishedAt: "2026-10-01T10:00:00.000Z" };
    const { cloudflare, deps, lines, state } = setup({ state: memoryState(connected([route])), tunnels: [existingTunnel, ownersTunnel] });
    const result = await cloudflareConnect({ tunnelName: "boxpilot-homebox", running }, deps);
    expect(result.tunnel).toMatchObject({ id: ownersTunnel.id, name: "home", adopted: true });
    expect(writes(cloudflare)).toEqual([]);
    expect(cloudflare.state.tunnels.map((tunnel) => tunnel.name)).toEqual(["boxpilot-homebox", "home"]);
    expect(state.current).toMatchObject({ tunnelId: ownersTunnel.id, tunnelName: "home", routes: [] });
    const log = lines.join("\n");
    expect(log).toMatch(/The tunnel boxpilot-homebox that BoxPilot used before is no longer used, and nothing runs it\. It is still in your Cloudflare account: delete it there if you wish\./);
    expect(log).toMatch(/published through the tunnel boxpilot-homebox are not carried over: share\.example\.com/);
    // Connecting again changes nothing more, and what was published through it since is kept.
    await state.write({ ...state.current, routes: [route] });
    const again = await cloudflareConnect({ tunnelName: "boxpilot-homebox", running }, deps);
    expect(again.tunnel).toMatchObject({ id: ownersTunnel.id, adopted: true });
    expect(state.current.routes.map((entry) => entry.hostname)).toEqual(["share.example.com"]);
    expect(writes(cloudflare)).toEqual([]);
  });

  it("refuses, changing nothing, when the token cannot reach the running tunnel or its key names no tunnel", async () => {
    const elsewhere = { tunnelId: ownersTunnel.id, accountTag: otherAccount };
    const cases = [
      // In an account the token does not cover (403), not in the account its key names (404), and a key that is not one.
      { given: elsewhere, fake: { accounts: [fakeAccount.id], tunnels: [existingTunnel] }, says: new RegExp(`already running a tunnel this token cannot reach \\(tunnel ${ownersTunnel.id} in the Cloudflare account ${otherAccount}\\)`) },
      { given: running, fake: { tunnels: [existingTunnel] }, says: /already running a tunnel this token cannot reach/ },
      { given: { unreadable: true }, fake: { tunnels: [existingTunnel, ownersTunnel] }, says: /already on this server, and BoxPilot cannot tell which tunnel it runs: its token could not be read, or names no tunnel/ },
    ];
    for (const { given, fake, says } of cases) {
      const { cloudflare, deps, state, credentials } = setup({ state: memoryState(), ...fake });
      const error = await cloudflareConnect({ tunnelName: "boxpilot-homebox", running: given }, deps).catch((caught) => caught);
      expect(error.message).toMatch(says);
      // What happened, and the two ways on.
      // What happened, and the two ways on: both ones the Tunnel tab can take (it cannot send replaceRunningTunnel).
      expect(error.message).toMatch(/BoxPilot has not replaced it and nothing was changed\. Either .+ connect again.*; or, to move this server to boxpilot-homebox, (?:copy the app's token from its Settings somewhere safe, )?uninstall the Cloudflare Tunnel app and connect again: the names the old tunnel serves stop answering until they are moved\.$/);
      expect(error.message).not.toContain("replaceRunningTunnel");
      // A token that could not be read cannot be copied first.
      expect(error.message.includes("copy the app's token from its Settings somewhere safe")).toBe(given.unreadable !== true);
      expect(writes(cloudflare)).toEqual([]);
      expect(state.current).toBeNull();
      expect([...credentials.values.keys()]).toEqual([cloudflareApiCredential]);
    }
    expect((await cloudflareConnect({ tunnelName: "boxpilot-homebox", running: elsewhere }, setup({ accounts: [fakeAccount.id] }).deps).catch((caught) => caught)).message).toContain("give the token Account · Cloudflare Tunnel · Edit for that account");
    // Anything else Cloudflare says about the running tunnel is not "cannot reach": the connect fails as it is.
    const down = setup({ tunnels: [ownersTunnel], fail: ({ route }) => (route.endsWith(`/cfd_tunnel/${ownersTunnel.id}`) ? new Response("{}", { status: 502 }) : null) });
    await expect(cloudflareConnect({ tunnelName: "boxpilot-homebox", running, replaceRunningTunnel: true }, down.deps)).rejects.toThrow(/Cloudflare refused reading the tunnel/);
    expect(writes(down.cloudflare)).toEqual([]);
    await expect(cloudflareConnect({ tunnelName: "boxpilot-homebox", running: { tunnelId: "../zones", accountTag: fakeAccount.id } }, setup().deps)).rejects.toThrow(/not named in a way BoxPilot knows/);
  });

  it("replaces a running tunnel it cannot reach only when told to, and says which names stop answering", async () => {
    const { cloudflare, deps, lines, state, credentials } = setup({ state: memoryState(), tunnels: [], accounts: [fakeAccount.id] });
    const result = await cloudflareConnect({ tunnelName: "boxpilot-homebox", running: { tunnelId: ownersTunnel.id, accountTag: otherAccount }, replaceRunningTunnel: true }, deps);
    expect(result).toMatchObject({ tunnel: { name: "boxpilot-homebox", created: true, adopted: false }, replacedRunning: true });
    expect(writes(cloudflare).map((call) => call.body)).toEqual([{ name: "boxpilot-homebox", config_src: "cloudflare" }]);
    expect(credentials.values.get(cloudflareTunnelCredential)).toBe(cloudflare.runKey);
    expect(state.current).toMatchObject({ tunnelName: "boxpilot-homebox" });
    expect(lines).toContain("Replacing the tunnel the Cloudflare Tunnel app runs with boxpilot-homebox, as you chose. The names the old tunnel serves stop answering until they are moved to boxpilot-homebox in Cloudflare.");
  });

  it("reads this server's own tunnel's key again when that is the one running, as it always did", async () => {
    const { cloudflare, deps, lines, state, credentials } = setup();
    const result = await cloudflareConnect({ tunnelName: "boxpilot-homebox", running: { tunnelId, accountTag: fakeAccount.id } }, deps);
    expect(result).toMatchObject({ tunnel: { id: tunnelId, name: "boxpilot-homebox", created: false, adopted: false }, replacedRunning: false });
    expect(writes(cloudflare)).toEqual([]);
    expect(cloudflare.calls.some((call) => call.route.endsWith(`/cfd_tunnel/${tunnelId}/token`))).toBe(true);
    expect(credentials.values.get(cloudflareTunnelCredential)).toBe(cloudflare.runKey);
    expect(state.current).toMatchObject({ tunnelId, tunnelName: "boxpilot-homebox" });
    expect(lines.join("\n")).toContain("Using the tunnel boxpilot-homebox that is already in your Cloudflare account.");
    expect(lines.join("\n")).not.toContain("already running your tunnel");
  });

  it("does not hold on to a running tunnel that was deleted in Cloudflare: this server's tunnel is made", async () => {
    const { cloudflare, deps, lines } = setup({ state: memoryState(), tunnels: [{ ...ownersTunnel, deleted_at: "2026-09-01T00:00:00Z" }] });
    const result = await cloudflareConnect({ tunnelName: "boxpilot-homebox", running }, deps);
    expect(result).toMatchObject({ tunnel: { name: "boxpilot-homebox", created: true, adopted: false }, replacedRunning: false });
    expect(lines.join("\n")).toMatch(/key is for the tunnel home, which was deleted in Cloudflare/);
    expect(writes(cloudflare)).toHaveLength(1);
  });

  it("uses a running tunnel in the account its key names, whichever account the token's first domain is in", async () => {
    const other = { id: otherAccount, name: "Workshop" };
    const zones = [{ id: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", name: "example.net", account: fakeAccount }, { id: "cccccccccccccccccccccccccccccccc", name: "example.org", account: other }];
    const { deps, state, lines } = setup({ state: memoryState(), zones, tunnels: [{ ...ownersTunnel, account: otherAccount }] });
    const result = await cloudflareConnect({ tunnelName: "boxpilot-homebox", running: { tunnelId: ownersTunnel.id, accountTag: otherAccount } }, deps);
    expect(result).toMatchObject({ account: other, tunnel: { adopted: true }, zones: [{ id: zones[1].id, name: "example.org" }] });
    expect(state.current).toMatchObject({ accountId: otherAccount, accountName: "Workshop" });
    // A token that reaches the tunnel but no domain beside it: used all the same, and said.
    const bare = setup({ state: memoryState(), zones: [zones[0]], tunnels: [{ ...ownersTunnel, account: otherAccount }] });
    expect((await cloudflareConnect({ tunnelName: "boxpilot-homebox", running: { tunnelId: ownersTunnel.id, accountTag: otherAccount } }, bare.deps)).zones).toEqual([]);
    expect(bare.lines.join("\n")).toMatch(/covers no domain in the account the running tunnel is in .*no app can be published until it does/);
    expect(lines.join("\n")).toContain("1 domain in the account Workshop (example.org)");
  });

  // The owner's site was at the domain itself and at www, routed in Cloudflare's dashboard.
  const theirSite = [{ hostname: "example.com", service: "http://localhost:8080" }, { hostname: "www.example.com", service: "http://localhost:8080", originRequest: { httpHostHeader: "example.com" } }];
  const theirRecords = [
    { id: "recApex", zone: zone.id, type: "CNAME", name: "example.com", content: tunnelTargetFor(ownersTunnel.id), proxied: true },
    { id: "recWww", zone: zone.id, type: "CNAME", name: "www.example.com", content: tunnelTargetFor(ownersTunnel.id), proxied: true },
  ];

  it("publishes and unpublishes an app on the tunnel it took over without touching the routes and names already on it", async () => {
    const before = { ingress: [...theirSite, { service: "http_status:503" }], "warp-routing": { enabled: false } };
    const { cloudflare, deps, state } = setup({ state: memoryState(), tunnels: [ownersTunnel], configs: { [ownersTunnel.id]: before }, records: theirRecords });
    await cloudflareConnect({ tunnelName: "boxpilot-homebox", running }, deps);
    expect(cloudflare.state.configs[ownersTunnel.id]).toEqual(before);

    await cloudflarePublish(publish, deps);
    expect(cloudflare.state.configs[ownersTunnel.id]).toEqual({
      ingress: [...theirSite, { hostname: "share.example.com", service: "http://127.0.0.1:3022", originRequest: {} }, { service: "http_status:503" }],
      "warp-routing": { enabled: false },
    });
    expect(cloudflare.state.records.map((record) => record.id)).toEqual(["recApex", "recWww", state.current.routes[0].dnsRecordId]);
    expect(cloudflare.state.records.at(-1)).toMatchObject({ name: "share.example.com", content: tunnelTargetFor(ownersTunnel.id) });
    expect(cloudflare.state.tunnels.map((tunnel) => tunnel.name)).toEqual(["home"]);

    await cloudflareUnpublish({ hostname: "share.example.com" }, deps);
    expect(cloudflare.state.configs[ownersTunnel.id]).toEqual(before);
    expect(cloudflare.state.records).toEqual(theirRecords);
  });

  it("will not publish over a name the tunnel already routes somewhere else, nor take a DNS record it did not make for its own", async () => {
    const before = { ingress: [...theirSite, { service: "http_status:404" }] };
    const adopted = () => memoryState({ ...connected(), tunnelId: ownersTunnel.id, tunnelName: "home" });
    const { cloudflare, deps, state } = setup({ state: adopted(), tunnels: [ownersTunnel], configs: { [ownersTunnel.id]: before }, records: theirRecords });
    const www = { ...publish, hostname: "www.example.com" };
    await expect(cloudflarePublish(www, deps)).rejects.toThrow("www.example.com is already routed by your tunnel to http://localhost:8080, and BoxPilot did not add that route, so it will not replace it. Choose another name, or remove that route in Cloudflare first. Nothing was changed.");
    expect(writes(cloudflare)).toEqual([]);
    expect(state.current.routes).toEqual([]);

    // The review's probe (A4): their rule for the name going to the very address being published was taken
    // for a publish BoxPilot had begun. It lost its own settings, and a later unpublish removed it.
    const sameAddress = { ingress: [{ hostname: "www.example.com", service: "http://127.0.0.1:3022", originRequest: { httpHostHeader: "example.com" } }, { service: "http_status:404" }] };
    for (const records of [[theirRecords[1]], []]) {
      const same = setup({ state: adopted(), tunnels: [ownersTunnel], configs: { [ownersTunnel.id]: sameAddress }, records });
      await expect(cloudflarePublish(www, same.deps)).rejects.toThrow("www.example.com is already routed by your tunnel to http://127.0.0.1:3022, and BoxPilot did not add that route, so it will not replace it.");
      expect(writes(same.cloudflare)).toEqual([]);
      expect(same.cloudflare.state.configs[ownersTunnel.id]).toEqual(sameAddress);
      expect(same.state.current.routes).toEqual([]);
      await expect(cloudflareUnpublish({ hostname: "www.example.com" }, same.deps)).rejects.toThrow(/BoxPilot did not publish www\.example\.com/);
    }
    // Its own, when the record of it was lost: the same address, and the DNS record BoxPilot made for the name.
    const lost = setup({ state: adopted(), tunnels: [ownersTunnel], configs: { [ownersTunnel.id]: { ingress: [{ hostname: "www.example.com", service: "http://127.0.0.1:3022", originRequest: {} }, { service: "http_status:404" }] } }, records: [{ ...theirRecords[1], comment: "BoxPilot: pingvin-share" }] });
    expect(await cloudflarePublish(www, lost.deps)).toMatchObject({ dnsRecord: "kept" });
    expect(lost.state.current.routes).toMatchObject([{ hostname: "www.example.com", dnsRecordId: "recWww" }]);

    // A name with their DNS record and no route of its own (a wildcard's, say): the route is added, and the record stays theirs.
    const bare = setup({ state: adopted(), tunnels: [ownersTunnel], configs: { [ownersTunnel.id]: { ingress: [{ service: "http_status:404" }] } }, records: [theirRecords[1]] });
    expect(await cloudflarePublish(www, bare.deps)).toMatchObject({ dnsRecord: "kept" });
    expect(bare.state.current.routes[0]).toMatchObject({ hostname: "www.example.com", dnsRecordId: null });
    expect(bare.lines.join("\n")).toContain("through a DNS record BoxPilot did not make; kept it, and unpublishing will leave it");
    const gone = await cloudflareUnpublish({ hostname: "www.example.com" }, bare.deps);
    expect(gone).toMatchObject({ dnsRemoved: false, note: "www.example.com has a DNS record BoxPilot did not make, so BoxPilot left it." });
    expect(bare.cloudflare.state.records).toEqual([theirRecords[1]]);
    expect(bare.cloudflare.state.configs[ownersTunnel.id].ingress).toEqual([{ service: "http_status:404" }]);
  });

  // The review's probe (A3): added last, the name's rule stood behind their wildcard and was never reached.
  it("puts a published name before the wildcard rule that would otherwise answer for it", async () => {
    const wildcard = { hostname: "*.example.com", service: "http://localhost:8080" };
    const { cloudflare, deps } = setup({ state: memoryState({ ...connected(), tunnelId: ownersTunnel.id, tunnelName: "home" }), tunnels: [ownersTunnel], configs: { [ownersTunnel.id]: { ingress: [theirSite[0], wildcard, { service: "http_status:404" }] } } });
    await cloudflarePublish(publish, deps);
    expect(cloudflare.state.configs[ownersTunnel.id].ingress).toEqual([theirSite[0], { hostname: "share.example.com", service: "http://127.0.0.1:3022", originRequest: {} }, wildcard, { service: "http_status:404" }]);
    await cloudflareUnpublish({ hostname: "share.example.com" }, deps);
    expect(cloudflare.state.configs[ownersTunnel.id].ingress).toEqual([theirSite[0], wildcard, { service: "http_status:404" }]);
  });

  it("uses a running tunnel whose routes are kept in a file on a machine, and says plainly why it cannot add a name to it", async () => {
    const fromFile = { ...ownersTunnel, remote_config: false, config_src: "local" };
    const { cloudflare, deps, lines, state } = setup({ state: memoryState(), tunnels: [fromFile] });
    const result = await cloudflareConnect({ tunnelName: "boxpilot-homebox", running }, deps);
    expect(result.tunnel).toMatchObject({ name: "home", adopted: true });
    expect(lines).toContain("home is set up from a file on a machine rather than from Cloudflare, so BoxPilot keeps it running but cannot add a name to it.");
    await expect(cloudflarePublish(publish, deps)).rejects.toThrow("BoxPilot cannot add share.example.com to the tunnel home: its routes are kept in a file on the machine that set it up, not at Cloudflare, so they cannot be changed from here.");
    expect(writes(cloudflare)).toEqual([]);
    expect(state.current.routes).toEqual([]);
    // A tunnel Cloudflare says nothing about either way is not taken for one: Cloudflare's own answer decides.
    const unsaid = setup({ state: memoryState({ ...connected(), tunnelId: ownersTunnel.id, tunnelName: "home" }), tunnels: [{ id: ownersTunnel.id, name: "home", account: fakeAccount.id }] });
    expect(await cloudflarePublish(publish, unsaid.deps)).toMatchObject({ dnsRecord: "added" });
  });
});

describe("publishing an app (M42)", () => {
  it("routes the name to the app, keeps the routes BoxPilot did not make, adds the CNAME and records it", async () => {
    const foreign = { hostname: "wiki.example.com", service: "http://192.0.2.5:8080" };
    const { cloudflare, deps, lines, state } = setup({ configs: { [tunnelId]: { ingress: [foreign, { service: "http_status:404" }], "warp-routing": { enabled: false } } } });
    const result = await cloudflarePublish(publish, deps);
    expect(result).toEqual({ url: "https://share.example.com", hostname: "share.example.com", appId: "pingvin-share", dnsRecord: "added" });
    expect(cloudflare.state.configs[tunnelId]).toEqual({
      ingress: [foreign, { hostname: "share.example.com", service: "http://127.0.0.1:3022", originRequest: {} }, { service: "http_status:404" }],
      "warp-routing": { enabled: false },
    });
    const record = cloudflare.state.records.find((entry) => entry.name === "share.example.com");
    expect(record).toMatchObject({ type: "CNAME", content: tunnelTargetFor(tunnelId), proxied: true, comment: "BoxPilot: pingvin-share" });
    expect(state.current.routes).toEqual([{ ...publish, dnsRecordId: record.id, publishedAt: now().toISOString() }]);
    expect(lines.join("\n")).toContain("1 other route kept");
    expectNoSecrets(cloudflare, result, lines, state.current);
  });

  it("will not replace a name that points somewhere else, and changes nothing when it refuses", async () => {
    const { cloudflare, deps, state } = setup({ records: [{ id: "recA", zone: zone.id, type: "A", name: "share.example.com", content: "198.51.100.7", proxied: false }] });
    await expect(cloudflarePublish(publish, deps)).rejects.toThrow("share.example.com already points somewhere else; BoxPilot will not replace it");
    expect(cloudflare.calls.filter((call) => call.method !== "GET")).toEqual([]);
    expect(state.current.routes).toEqual([]);
    const elsewhere = setup({ records: [{ id: "recC", zone: zone.id, type: "CNAME", name: "share.example.com", content: "other.example.net", proxied: true }] });
    await expect(cloudflarePublish(publish, elsewhere.deps)).rejects.toThrow(/already points somewhere else/);
  });

  it("keeps its own CNAME when the name already points at this tunnel, and sends HTTPS without checking the app's certificate when asked", async () => {
    const { cloudflare, deps, state } = setup({ records: [{ id: "recOurs", zone: zone.id, type: "CNAME", name: "share.example.com", content: tunnelTargetFor(tunnelId), proxied: true, comment: "BoxPilot: pingvin-share" }] });
    const result = await cloudflarePublish({ ...publish, service: "https://127.0.0.1:3022", noTLSVerify: true }, deps);
    expect(result.dnsRecord).toBe("kept");
    expect(cloudflare.calls.some((call) => call.method === "POST")).toBe(false);
    expect(cloudflare.state.configs[tunnelId].ingress[0]).toEqual({ hostname: "share.example.com", service: "https://127.0.0.1:3022", originRequest: { noTLSVerify: true } });
    expect(state.current.routes[0].dnsRecordId).toBe("recOurs");
  });

  // The route goes in first, then the DNS name, then the record. A name Cloudflare would not add
  // left a route nobody recorded, which unpublishing then refused as "not published by BoxPilot".
  const tooManyRequests = () => new Response(JSON.stringify({ success: false, errors: [{ code: 10000, message: "Rate limited" }], messages: [], result: null }), { status: 429, headers: { "content-type": "application/json" } });

  it("takes its route back out of the tunnel when Cloudflare will not add the name", async () => {
    const foreign = { hostname: "wiki.example.com", service: "http://192.0.2.5:8080" };
    const before = { ingress: [foreign, { service: "http_status:404" }], "warp-routing": { enabled: false } };
    const { cloudflare, deps, lines, state } = setup({
      configs: { [tunnelId]: before },
      fail: ({ method, route }) => (method === "POST" && route.endsWith("/dns_records") ? tooManyRequests() : null),
    });
    const error = await cloudflarePublish(publish, deps).catch((caught) => caught);
    expect(error.message).toMatch(/^Cloudflare refused adding share\.example\.com to your domain: Rate limited/);
    expect(error.message).toMatch(/route .* was rolled back/);
    expect(error.rolledBack).toBe(true);
    expect(cloudflare.state.configs[tunnelId]).toEqual(before);
    expect(cloudflare.state.records).toEqual([]);
    expect(state.current.routes).toEqual([]);
    expect(lines.join("\n")).toContain("share.example.com");
    expectNoSecrets(cloudflare, error.message, lines);
  });

  it("says so, and how to clear it, when putting the routes back fails too", async () => {
    let puts = 0;
    let limited = true;
    const failing = () => setup({
      fail: ({ method, route }) => {
        if (!limited) return null;
        if (method === "POST" && route.endsWith("/dns_records")) return tooManyRequests();
        if (method === "PUT" && route.endsWith("/configurations") && ++puts > 1) return tooManyRequests();
        return null;
      },
    });
    const { cloudflare, deps, state } = failing();
    const error = await cloudflarePublish(publish, deps).catch((caught) => caught);
    expect(error.message).toMatch(/^Cloudflare refused adding share\.example\.com to your domain/);
    expect(error.message).toMatch(/taking its route back out of the tunnel also failed .*Rate limited/);
    expect(error.message).toContain("Publish it again to finish, or unpublish it to take the route out.");
    expect(error.rolledBack).toBe(false);
    expect(cloudflare.state.configs[tunnelId].ingress.map((rule) => rule.hostname ?? null)).toEqual(["share.example.com", null]);
    // The route left behind is recorded as BoxPilot's, with no DNS record: an unrecorded one would be
    // refused as someone else's (M65.3), and neither way on in the message would work.
    expect(state.current.routes).toEqual([{ ...publish, dnsRecordId: null, publishedAt: now().toISOString() }]);
    limited = false;
    expect(await cloudflarePublish(publish, deps)).toMatchObject({ dnsRecord: "added" });
    expect(state.current.routes).toMatchObject([{ hostname: "share.example.com", dnsRecordId: expect.stringMatching(/^rec/) }]);
    // Or unpublished: the route comes out, and there is no name to remove.
    limited = true; puts = 0;
    const other = failing();
    await cloudflarePublish(publish, other.deps).catch(() => {});
    limited = false;
    expect(await cloudflareUnpublish({ hostname: "share.example.com" }, other.deps)).toMatchObject({ dnsRemoved: false, note: "share.example.com was already gone from your domain." });
    expect(other.cloudflare.state.configs[tunnelId].ingress).toEqual([{ service: "http_status:404" }]);
    expect(other.state.current.routes).toEqual([]);
  });

  it("publishes a name again for another port, keeping the record it made for it", async () => {
    const route = { ...publish, dnsRecordId: "recOurs", publishedAt: "2026-10-01T10:00:00.000Z" };
    // The record lost its comment in Cloudflare: it is still the one BoxPilot recorded for this name.
    const records = [{ id: "recOurs", zone: zone.id, type: "CNAME", name: "share.example.com", content: tunnelTargetFor(tunnelId), proxied: true }];
    const { cloudflare, deps, state } = setup({ state: memoryState(connected([route])), records, configs: { [tunnelId]: { ingress: [{ hostname: "share.example.com", service: "http://127.0.0.1:3022" }, { service: "http_status:404" }] } } });
    await cloudflarePublish({ ...publish, service: "http://127.0.0.1:3030", hostPort: 3030 }, deps);
    expect(cloudflare.state.configs[tunnelId].ingress).toEqual([{ hostname: "share.example.com", service: "http://127.0.0.1:3030", originRequest: {} }, { service: "http_status:404" }]);
    expect(state.current.routes).toMatchObject([{ hostname: "share.example.com", dnsRecordId: "recOurs", hostPort: 3030 }]);
  });

  it("refuses a name outside the connected domains, an address off this server, and an unconnected server", async () => {
    await expect(cloudflarePublish({ ...publish, hostname: "share.example.org" }, setup().deps)).rejects.toThrow(/not a name under one of your connected domains/);
    await expect(cloudflarePublish({ ...publish, service: "http://192.0.2.5:3022" }, setup().deps)).rejects.toThrow(/loopback/);
    await expect(cloudflarePublish(publish, setup({ state: memoryState() }).deps)).rejects.toThrow(/not connected yet/);
  });
});

describe("unpublishing an app (M42)", () => {
  it("takes out only its route and deletes only the record BoxPilot made", async () => {
    const foreign = { hostname: "wiki.example.com", service: "http://192.0.2.5:8080" };
    const route = { ...publish, dnsRecordId: "recOurs", publishedAt: "2026-10-01T10:00:00.000Z" };
    const records = [
      { id: "recOurs", zone: zone.id, type: "CNAME", name: "share.example.com", content: tunnelTargetFor(tunnelId), proxied: true },
      { id: "recWiki", zone: zone.id, type: "CNAME", name: "wiki.example.com", content: tunnelTargetFor(tunnelId), proxied: true },
    ];
    const { cloudflare, deps, state } = setup({ state: memoryState(connected([route])), records, configs: { [tunnelId]: { ingress: [{ hostname: "share.example.com", service: "http://127.0.0.1:3022" }, foreign, { service: "http_status:404" }] } } });
    const result = await cloudflareUnpublish({ hostname: "share.example.com" }, deps);
    expect(result).toEqual({ hostname: "share.example.com", dnsRemoved: true });
    expect(cloudflare.state.configs[tunnelId].ingress).toEqual([foreign, { service: "http_status:404" }]);
    expect(cloudflare.state.records.map((record) => record.id)).toEqual(["recWiki"]);
    expect(state.current.routes).toEqual([]);
  });

  it("leaves a record that was changed to point elsewhere, and refuses a name BoxPilot did not publish", async () => {
    const route = { ...publish, dnsRecordId: "recOurs", publishedAt: "2026-10-01T10:00:00.000Z" };
    const records = [{ id: "recOurs", zone: zone.id, type: "CNAME", name: "share.example.com", content: "elsewhere.example.net", proxied: true }];
    const { cloudflare, deps, state } = setup({ state: memoryState(connected([route])), records });
    const result = await cloudflareUnpublish({ hostname: "share.example.com" }, deps);
    expect(result).toMatchObject({ dnsRemoved: false, note: expect.stringContaining("no longer points at this tunnel") });
    expect(cloudflare.calls.some((call) => call.method === "DELETE")).toBe(false);
    expect(state.current.routes).toEqual([]);
    await expect(cloudflareUnpublish({ hostname: "wiki.example.com" }, setup().deps)).rejects.toThrow(/BoxPilot did not publish wiki.example.com/);
  });
});

describe("checking the tunnel (M42)", () => {
  it("says its health, counts connectors rather than connections, and lists the names Cloudflare routes", async () => {
    const { cloudflare, deps } = setup({ configs: { [tunnelId]: { ingress: [{ hostname: "share.example.com", service: "http://127.0.0.1:3022" }, { hostname: "Wiki.example.com", service: "x" }, { service: "http_status:404" }] } } });
    const result = await cloudflareCheck({}, deps);
    expect(result).toEqual({ status: "healthy", connectors: 2, routesAtCloudflare: ["share.example.com", "wiki.example.com"], checkedAt: now().toISOString() });
    expect(cloudflare.calls.every((call) => call.method === "GET")).toBe(true);
  });
});

describe("BoxPilot's Cloudflare record", () => {
  async function storeInTemp() {
    const directory = await mkdtemp(path.join(os.tmpdir(), "boxpilot-cloudflare-"));
    directories.push(directory);
    const file = path.join(directory, "cloudflare-tunnel.json");
    return { file, store: createTunnelStateStore({ file }) };
  }
  const route = { ...publish, dnsRecordId: "rec1", publishedAt: "2026-10-01T10:00:00.000Z" };

  it("is written whole and read back; a damaged one is an error, not an empty record", async () => {
    const { file, store } = await storeInTemp();
    expect(await store.read()).toBeNull();
    await store.write(connected([route]));
    expect((await store.read()).routes[0].hostname).toBe("share.example.com");
    expect(await readFile(file, "utf8")).not.toContain(token);
    await writeFile(file, "{ not json");
    await expect(store.read()).rejects.toThrow(/damaged/);
  });

  // POSIX file modes: Linux CI checks the record is root's alone.
  it.skipIf(onWindows)("is readable by its owner only", async () => {
    const { file, store } = await storeInTemp();
    await store.write(connected([route]));
    expect((await stat(file)).mode & 0o777).toBe(0o600);
  });
});
