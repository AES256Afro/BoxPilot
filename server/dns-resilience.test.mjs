import { describe, expect, it } from "vitest";
import { canaryPattern, createDnsResilienceService, isPrivateIpv4, judgeResilience, newCanary, parseDhclientLeases, parseNetworkctlDns, parseNetworkdLease, parseNmcliDhcp, readHandedOut, rehearsalSetting, roleOf } from "./dns-resilience.mjs";

// The demo world's network (scripts/boxpilot-demo.mjs): homebox at .20, the router at .1.
const self = "192.168.50.20";
const router = "192.168.50.1";
const now = new Date("2026-09-30T10:00:00Z");
const lease = (servers, via = "systemd-networkd", dhcpServer = router) => ({ source: "dhcp", via, servers, dhcpServer });
const healthy = (blocking) => ({ answering: true, resolving: true, blocking, error: null });
const silent = { answering: false, resolving: false, blocking: false, error: "ETIMEOUT" };

describe("reading what the router hands out", () => {
  it("takes the DHCPv4 servers from networkctl's JSON, addresses as bytes, and leaves static ones aside", () => {
    const json = JSON.stringify({ Name: "eno1", DHCPv4Client: { Lease: { LeaseTimestampUSec: 1 } }, DNS: [
      { Family: 2, Address: [192, 168, 50, 20], ConfigSource: "DHCPv4", ConfigProvider: [192, 168, 50, 1] },
      { Family: 2, Address: [9, 9, 9, 9], ConfigSource: "DHCPv4", ConfigProvider: [192, 168, 50, 1] },
      { Family: 10, Address: [254, 128, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1], ConfigSource: "DHCPv6" },
      { Family: 2, Address: [1, 1, 1, 1], ConfigSource: "static" },
    ] });
    expect(parseNetworkctlDns(json)).toEqual({ dhcp: [self, "9.9.9.9"], configured: ["1.1.1.1"], dhcpServer: router, dhcpClient: true });
    expect(parseNetworkctlDns("not json")).toBeNull();
    expect(parseNetworkctlDns(JSON.stringify({ Interfaces: [{ DNS: [{ Address: router, ConfigSource: "DHCPv4" }] }] })).dhcp).toEqual([router]);
  });

  it("reads networkd's lease file, NetworkManager's options and dhclient's last lease", () => {
    expect(parseNetworkdLease(`# This is private data. Do not parse.\nADDRESS=${self}\nSERVER_ADDRESS=${router}\nDNS=${router} 9.9.9.9\n`)).toEqual({ dns: [router, "9.9.9.9"], server: router });
    expect(parseNmcliDhcp(`DHCP4.OPTION[1]:dhcp_server_identifier = ${router}\nDHCP4.OPTION[7]:domain_name_servers = ${self}`)).toEqual({ dns: [self], server: router });
    const dhclient = `lease {\n  option domain-name-servers 10.0.0.1;\n}\nlease {\n  option dhcp-server-identifier ${router};\n  option domain-name-servers ${self},9.9.9.9;\n}\n`;
    expect(parseDhclientLeases(dhclient)).toEqual({ dns: [self, "9.9.9.9"], server: router });
  });

  it("tries each reader in turn, and says a hand-set address is not the router's answer", async () => {
    const files = { [`/sys/class/net/eno1/ifindex`]: "2\n", "/run/systemd/netif/leases/2": `DNS=${self}\nSERVER_ADDRESS=${router}\n` };
    const readFile = async (file) => { if (files[file] === undefined) throw new Error("ENOENT"); return files[file]; };
    const noNetworkd = async () => ({ ok: false, stdout: "" });
    expect(await readHandedOut({ interface: "eno1", run: noNetworkd, readFile })).toEqual({ source: "dhcp", via: "systemd-networkd's lease", servers: [self], dhcpServer: router });

    const nothing = async () => { throw new Error("ENOENT"); };
    const staticLink = async (command) => (command === "networkctl" ? { ok: true, stdout: JSON.stringify({ DNS: [{ Family: 2, Address: [192, 168, 50, 20], ConfigSource: "static" }] }) } : { ok: false, stdout: "" });
    expect(await readHandedOut({ interface: "eno1", run: staticLink, readFile: nothing })).toEqual({ source: "configured", via: "systemd-networkd", servers: [self], dhcpServer: null });
    expect(await readHandedOut({ interface: "eno1", run: noNetworkd, readFile: nothing, resolverLinks: [{ interface: "eno1", servers: [{ address: router }] }] })).toMatchObject({ source: "configured", via: "systemd-resolved", servers: [router] });
    expect(await readHandedOut({ interface: "eno1", run: noNetworkd, readFile: nothing })).toEqual({ source: "none", via: null, servers: [], dhcpServer: null });
    // An interface name that is not one never reaches argv or a path.
    const calls = [];
    expect((await readHandedOut({ interface: "../etc", run: async (...args) => { calls.push(args); return { ok: false }; }, readFile: nothing })).source).toBe("none");
    expect(calls).toEqual([]);
  });
});

describe("who each server is", () => {
  it("tells this server, the router, the tailnet, the LAN and the internet apart", () => {
    const context = { selfAddresses: [self, "100.101.102.103"], gateway: router, dhcpServer: router };
    expect(roleOf(self, context)).toBe("this-server");
    expect(roleOf("127.0.0.53", context)).toBe("this-server");
    expect(roleOf(router, context)).toBe("router");
    expect(roleOf("100.100.100.100", context)).toBe("tailscale");
    expect(roleOf("192.168.50.30", context)).toBe("lan");
    expect(roleOf("9.9.9.9", context)).toBe("public");
    expect(isPrivateIpv4("172.20.1.1")).toBe(true);
    expect(isPrivateIpv4("172.32.1.1")).toBe(false);
  });

  it("makes canaries only in its own shape", () => {
    expect(newCanary(Buffer.alloc(8, 0xab))).toBe("bp-canary-abababababababab.example.com");
    expect(canaryPattern.test(newCanary())).toBe(true);
    expect(canaryPattern.test("doubleclick.net")).toBe(false);
  });
});

describe("the verdict", () => {
  const judge = (facts) => judgeResilience({ selfAddresses: [self], gateway: router, servesDns: true, ...facts }, { now, hostname: "homebox" });

  it("says the house goes down with this server when the lease names nothing else", () => {
    const verdict = judge({ handedOut: lease([self]), answers: { [self]: healthy(true) } });
    expect(verdict).toMatchObject({ state: "single-point", status: "danger", headline: "If homebox goes down, every device on your network loses the internet" });
    expect(verdict.detail).toContain(`hands out ${self} (this server) as the only DNS server`);
  });

  it("does not count a second server that does not answer", () => {
    const verdict = judge({ handedOut: lease([self, "192.168.50.30"]), answers: { [self]: healthy(true), "192.168.50.30": silent } });
    expect(verdict.state).toBe("single-point");
    expect(verdict.detail).toContain("192.168.50.30, but that one did not answer a lookup from here");
    expect(verdict.servers.map((server) => server.verdict)).toEqual(["depends", "broken"]);
  });

  it("counts a second server that answers on its own, and says when it skips the blocking", () => {
    const publicSecond = judge({ handedOut: lease([self, "9.9.9.9"]), answers: { [self]: healthy(true), "9.9.9.9": healthy(false) } });
    expect(publicSecond).toMatchObject({ state: "resilient", status: "good", skipsBlocking: true });
    expect(publicSecond.detail).toContain("sometimes skip the blocking here");
    const secondBlocker = judge({ handedOut: lease([self, "192.168.50.30"]), answers: { [self]: healthy(true), "192.168.50.30": healthy(true) } });
    expect(secondBlocker).toMatchObject({ state: "resilient", skipsBlocking: false });
  });

  it("does not claim the worst about a router passing lookups here that nobody has rehearsed", () => {
    const verdict = judge({ handedOut: lease([router]), answers: { [router]: healthy(true) }, canary: { router, forwards: true } });
    expect(verdict).toMatchObject({ state: "unproven", status: "warning", router });
    expect(verdict.detail).toContain("passes their lookups to the DNS server here");
    // An unreadable canary is not proof either way.
    expect(judge({ handedOut: lease([router]), answers: { [router]: healthy(true) }, canary: { router, forwards: null } }).state).toBe("unproven");
  });

  it("takes a router whose canary never reached this server as answering on its own", () => {
    const verdict = judge({ handedOut: lease([router]), answers: { [router]: healthy(true) }, canary: { router, forwards: false } });
    expect(verdict.state).toBe("independent");
  });

  it("goes by the rehearsal: kept answering is resilient, stopped answering is the single point", () => {
    const rehearsal = (passed, at = "2026-09-29T12:00:00Z") => ({ router, passed, at, appName: "Pi-hole" });
    const passed = judge({ handedOut: lease([router]), answers: { [router]: healthy(true) }, canary: { router, forwards: true }, rehearsal: rehearsal(true) });
    expect(passed).toMatchObject({ state: "resilient", status: "good" });
    expect(passed.detail).toContain("kept answering when the DNS server here was stopped");
    const failed = judge({ handedOut: lease([router]), answers: { [router]: healthy(true) }, rehearsal: rehearsal(false) });
    expect(failed).toMatchObject({ state: "single-point" });
    expect(failed.detail).toContain("the router answered nothing");
    // Ninety days on, or for another router, or inconclusive, it is not evidence any more.
    expect(judge({ handedOut: lease([router]), answers: { [router]: healthy(true) }, rehearsal: rehearsal(true, "2026-06-01T00:00:00Z") })).toMatchObject({ state: "unproven", rehearsalStale: true });
    expect(judge({ handedOut: lease([router]), answers: { [router]: healthy(true) }, rehearsal: { ...rehearsal(true), router: "192.168.50.2" } }).state).toBe("unproven");
    expect(judge({ handedOut: lease([router]), answers: { [router]: healthy(true) }, rehearsal: rehearsal(null) }).state).toBe("unproven");
  });

  it("says the house does not lean on this server when nothing handed out does", () => {
    expect(judge({ handedOut: lease(["9.9.9.9", "149.112.112.112"]), answers: { "9.9.9.9": healthy(false), "149.112.112.112": healthy(false) } }).state).toBe("independent");
    // A router with nothing here to lean on answers on its own.
    expect(judgeResilience({ handedOut: lease([router]), selfAddresses: [self], gateway: router, servesDns: false, answers: { [router]: healthy(false) } }, { now }).state).toBe("independent");
  });

  it("never guesses from this server's own hand-set DNS, or with nothing to read", () => {
    const configured = judge({ handedOut: { source: "configured", via: "systemd-networkd", servers: [self], dhcpServer: null }, answers: {} });
    expect(configured).toMatchObject({ state: "unknown", status: "unknown" });
    expect(configured.detail).toContain("ipconfig /all");
    expect(judge({ handedOut: { source: "none", servers: [] } }).state).toBe("unknown");
  });

  it("counts a router handed out beside this server that resolves on its own, and says it skips the blocking", () => {
    const verdict = judge({ handedOut: lease([self, router]), answers: { [self]: healthy(true), [router]: healthy(false) }, canary: { router, forwards: false } });
    expect(verdict).toMatchObject({ state: "resilient", skipsBlocking: true });
    expect(verdict.detail).toContain(`${router} (your router) answers lookups on its own`);
  });

  it("claims nothing when no server it is given answers at all", () => {
    const verdict = judge({ handedOut: lease([router]), answers: { [router]: silent } });
    expect(verdict).toMatchObject({ state: "unknown", headline: "No DNS server your devices are given answered from here" });
  });

  it("leaves Tailscale's resolver out of the count", () => {
    const verdict = judge({ handedOut: lease([self, "100.100.100.100"]), answers: { [self]: healthy(true) } });
    expect(verdict.state).toBe("single-point");
    expect(verdict.servers.find((server) => server.role === "tailscale").verdict).toBe("skipped");
  });
});

describe("the service", () => {
  const topology = {
    addresses: [{ interface: "eno1", address: self }, { interface: "tailscale0", address: "100.101.102.103" }],
    eligibleLanAddresses: [{ interface: "eno1", address: self, cidr: `${self}/24` }],
    defaultRoutes: [{ gateway: router, interface: "eno1" }],
    resolverLinks: [],
    dnsListeners: [{ protocol: "udp", address: "0.0.0.0", port: 53, scope: "wildcard" }],
  };
  const networkctl = (servers) => async () => ({ ok: true, stdout: JSON.stringify({ DNS: servers.map((address) => ({ Family: 2, Address: address.split(".").map(Number), ConfigSource: "DHCPv4", ConfigProvider: [192, 168, 50, 1] })) }) });

  it("asks each server once, keeps the answer ten minutes, and reads again when asked to", async () => {
    let clock = now.getTime();
    const asked = [];
    const service = createDnsResilienceService({ network: { inspect: async () => topology }, run: networkctl([self]), ask: async (address) => { asked.push(address); return healthy(true); }, now: () => new Date(clock), hostname: () => "homebox" });
    const first = await service.check();
    expect(first).toMatchObject({ state: "single-point", lanAddress: self, gateway: router });
    await service.check();
    expect(asked).toEqual([self]);
    clock += 11 * 60_000;
    await service.check();
    await service.check({ fresh: true });
    expect(asked).toEqual([self, self, self]);
  });

  it("sends a canary through the router and one straight here, and believes the log only when the straight one is in it", async () => {
    const requests = [];
    const helper = (seen) => ({ request: async (operation, parameters) => { requests.push({ operation, parameters }); return seen(parameters.names); } });
    const make = (seen) => createDnsResilienceService({
      network: { inspect: async () => topology }, run: networkctl([router]), helper: helper(seen), store: { getSetting: () => null },
      ask: async () => healthy(true), askOne: async () => ({ answered: true }), sleep: async () => {}, hostname: () => "homebox", now: () => now,
    });
    const forwards = await make(([viaRouter, direct]) => ({ available: true, seen: { [viaRouter]: true, [direct]: true } })).check();
    expect(forwards).toMatchObject({ state: "unproven", canary: { router, forwards: true } });
    expect(requests[0].operation).toBe("dns.blocker.canary");
    expect(requests[0].parameters.names.every((name) => canaryPattern.test(name))).toBe(true);

    expect((await make(([viaRouter, direct]) => ({ available: true, seen: { [viaRouter]: false, [direct]: true } })).check())).toMatchObject({ state: "independent", canary: { forwards: false } });
    // The log is not being written: nothing is concluded from silence.
    expect((await make(([viaRouter, direct]) => ({ available: true, seen: { [viaRouter]: false, [direct]: false } })).check())).toMatchObject({ state: "unproven", canary: { forwards: null } });
  });

  it("reads the last rehearsal from its setting", async () => {
    const store = { getSetting: (key) => (key === rehearsalSetting ? { router, passed: true, at: "2026-09-29T12:00:00Z", appName: "Pi-hole" } : null) };
    const service = createDnsResilienceService({ network: { inspect: async () => topology }, run: networkctl([router]), store, ask: async () => healthy(true), askOne: async () => ({ answered: false }), hostname: () => "homebox", now: () => now });
    expect(await service.check()).toMatchObject({ state: "resilient", rehearsal: { passed: true } });
  });
});
