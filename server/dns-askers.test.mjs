import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { askersSql, createDnsResilienceService, directAskersThreshold, inCidr, inferFromAskers, judgeResilience, parseAskerRows, summarizeAskers } from "./dns-resilience.mjs";
import { piholeAskers } from "./ops/dns-resilience.mjs";
import { registry } from "./ops/index.mjs";
import { dnsLeansOnThisServer } from "./remediations.mjs";

// The owner's shape, in the demo world's addresses: a server with a hand-set address at .20, the
// router at .1, and eight devices that were handed the server as their only DNS server.
const self = "192.168.50.20";
const router = "192.168.50.1";
const lanCidr = `${self}/24`;
const devices = Array.from({ length: 8 }, (_, index) => `192.168.50.${31 + index}`);
const now = new Date("2026-09-30T10:00:00Z");
const context = { router, lanCidr, selfAddresses: [self, "172.17.0.1", "100.101.102.103"] };

/** A Pi-hole v6 query database (test/fixtures/pihole) with the given clients' queries. */
function ftlDatabase(entries) {
  const database = new DatabaseSync(":memory:");
  database.exec(readFileSync("test/fixtures/pihole/ftl-v6-schema.sql", "utf8"));
  database.exec("INSERT INTO domain_by_id (id, domain) VALUES (1, 'example.com'), (2, 'doubleclick.net')");
  const clientIds = new Map();
  const clientId = (ip) => {
    if (!clientIds.has(ip)) { clientIds.set(ip, clientIds.size + 1); database.prepare("INSERT INTO client_by_id (id, ip, name) VALUES (?, ?, ?)").run(clientIds.get(ip), ip, `device-${clientIds.size}`); }
    return clientIds.get(ip);
  };
  const insert = database.prepare("INSERT INTO query_storage (timestamp, type, status, domain, client, forward) VALUES (CAST(strftime('%s','now') AS INTEGER) - ?, 1, 2, 1, ?, NULL)");
  for (const { client, agoSeconds, count = 1 } of entries) for (let index = 0; index < count; index += 1) insert.run(agoSeconds, clientId(client));
  return database;
}
/** What `pihole-FTL sqlite3` prints for the query: client|hour|day, one line each. */
const shellOutput = (database) => database.prepare(askersSql.replace(/;$/, "")).all().map((row) => Object.values(row).join("|")).join("\n");

describe("who asks Pi-hole, from its own database", () => {
  it("runs on Pi-hole v6's schema and counts the last hour, leaving out the older", () => {
    const database = ftlDatabase([
      ...devices.map((client) => ({ client, agoSeconds: 600, count: 5 })),
      { client: router, agoSeconds: 900, count: 3 },
      { client: self, agoSeconds: 300, count: 2 },
      { client: "127.0.0.1", agoSeconds: 60, count: 4 },
      { client: "100.64.0.7", agoSeconds: 1200 },          // a phone on the tailnet
      { client: "192.168.50.60", agoSeconds: 5 * 3600 },    // earlier today: not in the last hour
      { client: "192.168.50.61", agoSeconds: 3 * 86400 },   // days ago: not asked about at all
    ]);
    const rows = parseAskerRows(shellOutput(database));
    expect(rows.find((row) => row.client === "192.168.50.60")).toEqual({ client: "192.168.50.60", lastHour: 0, lastDay: 1 });
    expect(rows.some((row) => row.client === "192.168.50.61")).toBe(false);
    expect(summarizeAskers(rows, context)).toEqual({ window: "hour", queries: 50, lanClients: 8, routerQueries: 3, routerAsks: true, selfQueries: 6, tailnetClients: 1, bridgeClients: 0, otherClients: 0, unnamedQueries: 0 });
  });

  it("falls back to the last day when the last hour was quiet", () => {
    const summary = summarizeAskers(parseAskerRows("192.168.50.31|0|12\n192.168.50.1|0|4\n"), context);
    expect(summary).toMatchObject({ window: "day", queries: 16, lanClients: 1, routerAsks: true });
  });

  it("sets aside what it cannot place: Docker's bridge, hidden clients, other networks", () => {
    const summary = summarizeAskers(parseAskerRows("172.18.0.1|40|90\nhidden|5|5\n|3|3\n10.9.8.7|1|1\n"), context);
    expect(summary).toMatchObject({ lanClients: 0, routerAsks: false, bridgeClients: 1, unnamedQueries: 8, otherClients: 1 });
    expect(inCidr("192.168.50.31", lanCidr)).toBe(true);
    expect(inCidr("192.168.51.31", lanCidr)).toBe(false);
    expect(inCidr("192.168.50.31", "nonsense")).toBe(false);
  });
});

describe("what the askers say the router hands out", () => {
  const available = (fields) => ({ available: true, window: "hour", queries: 40, lanClients: 0, routerAsks: false, bridgeClients: 0, unnamedQueries: 0, ...fields });

  it("several devices asking directly: the router hands this server out", () => {
    expect(inferFromAskers(available({ lanClients: 8 }), { gateway: router, lanAddress: self }).handedOut).toEqual({ source: "pihole-log", via: "Pi-hole's query log", servers: [self], dhcpServer: router });
    // The router asking as well changes nothing: those devices still ask this server directly.
    expect(inferFromAskers(available({ lanClients: 8, routerAsks: true }), { gateway: router, lanAddress: self }).handedOut.servers).toEqual([self]);
  });

  it("only the router asking: the router passes lookups on", () => {
    expect(inferFromAskers(available({ routerAsks: true }), { gateway: router, lanAddress: self }).handedOut).toEqual({ source: "pihole-log", via: "Pi-hole's query log", servers: [router], dhcpServer: router });
  });

  it("says not known, and why, rather than guess", () => {
    const reason = (askers) => inferFromAskers(askers, { gateway: router, lanAddress: self });
    expect(reason(available({ lanClients: directAskersThreshold - 1 }))).toMatchObject({ handedOut: null, reason: expect.stringContaining("2 devices on your network asking it directly") });
    expect(reason(available({ queries: 0 })).reason).toContain("answered nothing in the last day");
    expect(reason(available({ bridgeClients: 1 })).reason).toContain("bridge mode");
    expect(reason(available({ unnamedQueries: 9 })).reason).toContain("privacy level");
    expect(reason({ available: false, reason: "Pi-hole is not running, so its log cannot be asked." }).reason).toBe("Pi-hole is not running, so its log cannot be asked.");
    expect(reason(null).reason).toBe("Pi-hole's query log could not be read.");
  });
});

describe("the verdict for a server with a hand-set address", () => {
  const judge = (facts) => judgeResilience({ selfAddresses: [self], gateway: router, servesDns: true, answers: {}, ...facts }, { now, hostname: "homebox" });
  const fromLog = (servers) => ({ source: "pihole-log", via: "Pi-hole's query log", servers, dhcpServer: router });

  it("fires the finding when eight devices ask Pi-hole directly", () => {
    const verdict = judge({ handedOut: fromLog([self]), askers: { available: true, window: "hour", lanClients: 8, routerAsks: false } });
    expect(verdict).toMatchObject({ state: "single-point", source: "pihole-log", headline: "If homebox goes down, every device on your network loses the internet", askers: { window: "hour", lanClients: 8, routerAsks: false } });
    expect(verdict.detail).toContain("Pi-hole's own log shows 8 devices on your network asking it directly in the last hour");
    const [found] = dnsLeansOnThisServer({ dnsResilience: { ...verdict, lanAddress: self }, apps: [] });
    expect(found).toMatchObject({ id: "dns-single-point", severity: "warning", view: "network" });
    expect(found.evidence[0]).toBe("8 devices on your network asked Pi-hole here directly in the last hour");
    expect(found.evidence.join(" ")).not.toContain("192.168.50.3");
  });

  it("judges a router that only passes lookups on as not proven, until rehearsed", () => {
    const verdict = judge({ handedOut: fromLog([router]), answers: { [router]: { answering: true, resolving: true, blocking: true } }, askers: { available: true, window: "hour", lanClients: 0, routerAsks: true } });
    expect(verdict).toMatchObject({ state: "unproven" });
    expect(verdict.detail).toContain("Only your router at 192.168.50.1 asks Pi-hole here");
  });

  it("says why it cannot tell", () => {
    const verdict = judge({ handedOut: { source: "configured", via: "systemd-networkd", servers: [self], dhcpServer: null }, askersReason: "Pi-hole's query log could not be read." });
    expect(verdict.state).toBe("unknown");
    expect(verdict.detail).toContain("Pi-hole's query log could not be read.");
  });
});

describe("the service on a server with a hand-set address", () => {
  const topology = {
    addresses: [{ interface: "eno1", address: self }, { interface: "docker0", address: "172.17.0.1" }],
    eligibleLanAddresses: [{ interface: "eno1", address: self, cidr: lanCidr }],
    defaultRoutes: [{ gateway: router, interface: "eno1", protocol: "static" }],
    resolverLinks: [{ interface: "eno1", servers: [{ address: self }] }],
    dnsListeners: [{ protocol: "udp", address: "0.0.0.0", port: 53, scope: "wildcard" }],
  };
  const staticLink = async () => ({ ok: true, stdout: JSON.stringify({ DNS: [{ Family: 2, Address: [192, 168, 50, 20], ConfigSource: "static" }] }) });
  const noFile = async () => { throw new Error("ENOENT"); };

  it("asks Pi-hole's log with the gateway, the LAN and this server's own addresses, and fires", async () => {
    const asked = [];
    const helper = { request: async (operation, parameters) => { asked.push({ operation, parameters }); return { available: true, reason: null, window: "hour", queries: 60, lanClients: 8, routerQueries: 0, routerAsks: false, selfQueries: 4, tailnetClients: 0, bridgeClients: 0, otherClients: 0, unnamedQueries: 0 }; } };
    const service = createDnsResilienceService({ network: { inspect: async () => topology }, helper, run: staticLink, readFile: noFile, ask: async () => ({ answering: true, resolving: true, blocking: true }), hostname: () => "homebox", now: () => now });
    const verdict = await service.check();
    expect(asked).toEqual([{ operation: "dns.blocker.askers", parameters: { router, lanCidr, selfAddresses: [self, "172.17.0.1"] } }]);
    expect(verdict).toMatchObject({ state: "single-point", source: "pihole-log", askers: { lanClients: 8 } });
  });

  it("stays not known when the log cannot be read", async () => {
    const helper = { request: async () => ({ available: false, reason: "Pi-hole's query log could not be read." }) };
    const verdict = await createDnsResilienceService({ network: { inspect: async () => topology }, helper, run: staticLink, readFile: noFile, ask: async () => ({ answering: true, resolving: true, blocking: true }), hostname: () => "homebox", now: () => now }).check();
    expect(verdict).toMatchObject({ state: "unknown", source: "configured" });
    expect(verdict.detail).toContain("Pi-hole's query log could not be read.");
  });

  it("does not ask the log when the lease already says", async () => {
    const helper = { request: async () => { throw new Error("must not ask"); } };
    const lease = async () => ({ ok: true, stdout: JSON.stringify({ DNS: [{ Family: 2, Address: [192, 168, 50, 20], ConfigSource: "DHCPv4" }] }) });
    const verdict = await createDnsResilienceService({ network: { inspect: async () => topology }, helper, run: lease, readFile: noFile, ask: async () => ({ answering: true, resolving: true, blocking: true }), hostname: () => "homebox", now: () => now }).check();
    expect(verdict).toMatchObject({ state: "single-point", source: "dhcp" });
  });
});

describe("the askers operation", () => {
  const pihole = { id: "pi-hole", label: "Pi-hole", running: true };
  const localDns = (spec) => ({ internals: { platform: async () => spec } });

  it("reads Pi-hole's database read-only inside its container, and returns counts, never addresses", async () => {
    const calls = [];
    const output = [...devices.map((client) => `${client}|5|9`), `${router}|3|7`, `${self}|2|2`].join("\n");
    const result = await piholeAskers(context, { localDns: localDns(pihole), run: async (binary, args) => { calls.push(args); return { ok: true, code: 0, stdout: output }; } });
    expect(calls[0].slice(0, 5)).toEqual(["exec", "bp-pi-hole", "pihole-FTL", "sqlite3", "-readonly"]);
    expect(calls[0]).toContain("/etc/pihole/pihole-FTL.db");
    expect(result).toMatchObject({ available: true, lanClients: 8, routerAsks: true, selfQueries: 2 });
    expect(JSON.stringify(result)).not.toMatch(/192\.168\.50\.(3\d|1\b|20)/);
  });

  it("says not known when Pi-hole is not BoxPilot's, not running, or its database cannot be read", async () => {
    const run = async () => ({ ok: false, code: 1, stdout: "", stderr: "Error: unable to open database" });
    expect(await piholeAskers(context, { localDns: localDns(null), run })).toMatchObject({ available: false, reason: expect.stringContaining("No Pi-hole that BoxPilot manages") });
    expect(await piholeAskers(context, { localDns: localDns({ ...pihole, running: false }), run })).toMatchObject({ available: false, reason: expect.stringContaining("not running") });
    expect(await piholeAskers(context, { localDns: localDns(pihole), run })).toEqual({ available: false, reason: "Pi-hole's query log could not be read." });
  });

  it("is an operator's read, taking only addresses", () => {
    expect(registry.get("dns.blocker.askers")).toMatchObject({ readOnly: true, risk: "low", minimumRole: "operator" });
    expect(registry.validate("dns.blocker.askers", context)).toBeNull();
    expect(registry.validate("dns.blocker.askers", { ...context, router: "router.lan" })).toMatch(/router/);
    expect(registry.validate("dns.blocker.askers", { ...context, selfAddresses: ["'; DROP TABLE queries; --"] })).toMatch(/selfAddresses/);
  });
});
