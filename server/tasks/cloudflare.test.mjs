import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { onWindows } from "../../test/platform.mjs";
import { createFakeCloudflare, fakeAccount } from "../../test/fake-cloudflare.mjs";
import { cloudflareApiCredential, cloudflareTunnelCredential, createTunnelStateStore, normalizeTunnelState, tunnelTargetFor } from "../cloudflare-tunnel.mjs";
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
    expect(result.tunnel).toEqual({ id: tunnelId, name: "boxpilot-homebox", created: false });
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
    const { cloudflare, deps, state } = setup({ records: [{ id: "recOurs", zone: zone.id, type: "CNAME", name: "share.example.com", content: tunnelTargetFor(tunnelId), proxied: true }] });
    const result = await cloudflarePublish({ ...publish, service: "https://127.0.0.1:3022", noTLSVerify: true }, deps);
    expect(result.dnsRecord).toBe("kept");
    expect(cloudflare.calls.some((call) => call.method === "POST")).toBe(false);
    expect(cloudflare.state.configs[tunnelId].ingress[0]).toEqual({ hostname: "share.example.com", service: "https://127.0.0.1:3022", originRequest: { noTLSVerify: true } });
    expect(state.current.routes[0].dnsRecordId).toBe("recOurs");
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
