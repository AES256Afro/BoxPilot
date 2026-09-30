/**
 * Whether the house keeps its DNS while this server is off (M39.2, ADR-008).
 *
 * On 2026-09-29 the owner's server lost power for three and a half hours. Pi-hole ran on it and was
 * the only DNS server the network knew, so every device in the house lost name lookups at once, and
 * the owner found out because "the network" broke and they had to type a public resolver into their
 * PC by hand. Nothing on any page had said that the whole house leaned on this one machine.
 *
 * So this answers three questions, read-only:
 *
 *   1. What does the router hand out? Read from this server's own DHCP lease, because the router
 *      gives every device on the LAN the same DNS options: systemd-networkd's view of the link
 *      (`networkctl status --json`), its lease file, NetworkManager's DHCP options, or dhclient's
 *      lease file, whichever this server has. A server whose address is set by hand has no lease,
 *      and its own DNS setting says nothing about the devices, so then the answer is "not known",
 *      never a guess.
 *   2. Does each of those servers still answer with this server out of the picture? Asked the way a
 *      device asks when this server is off: directly. A second server on another box, or a public
 *      one, answers or it does not. The router is the hard case, since it may only be passing
 *      lookups to Pi-hole here. A canary tells whether it does: one made-up name asked of the router,
 *      then looked for in Pi-hole's own query log, beside a second asked of Pi-hole directly to prove
 *      the log is being written at all. Whether a router that does pass lookups here falls back to
 *      anything else can only be seen by taking Pi-hole away, which the rehearsal does
 *      (`dns.fallback.rehearse`, a job the owner approves); its last result is kept and read here.
 *   3. Which of those facts add up to "if this server goes down, every device loses the internet"?
 *      Only a lease that names nothing but this server, a router whose rehearsal failed, or second
 *      servers that do not answer. Anything less certain is said as not proven, never as broken.
 *
 * Read in the web service, unprivileged: networkctl, two files, nmcli, and DNS queries sent by node's
 * resolver to explicit servers. Nothing here depends on ping, dig or tcpdump, which an Ubuntu 26.04
 * server may not have, and nothing changes anything. A healthy LAN costs one networkctl call and a
 * DNS query or two per server; the answer is kept for ten minutes.
 */
import { execFile as execFileCallback } from "node:child_process";
import { randomBytes } from "node:crypto";
import { Resolver as DnsResolver } from "node:dns/promises";
import { readFile as fsReadFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import { promisify } from "node:util";
import { controlDomain, dnsBlockerVerify } from "./tasks/dns-check.mjs";

const execFile = promisify(execFileCallback);

/** Tailscale's MagicDNS resolver: the tailnet's, not something the router hands out. */
export const tailscaleResolver = "100.100.100.100";
/** How long a rehearsal's verdict stands. A router's settings change rarely; a firmware update can. */
export const rehearsalFreshForMs = 90 * 24 * 60 * 60_000;
/** The setting the rehearsal's record hook writes (server/index.mjs). */
export const rehearsalSetting = "dnsFallbackRehearsal";
/** How long one answer is kept: Home and Repair ask on every load. */
export const cacheForMs = 10 * 60_000;
/** The DNS apps BoxPilot can install that answer for the LAN on port 53, and so could be the house's DNS. */
export const dnsAppIds = Object.freeze(["pi-hole", "adguard-home", "technitium-dns"]);
/** A name the canary asks: random, under a domain reserved for examples, never cached anywhere. */
export const canaryPattern = /^bp-canary-[0-9a-f]{16}\.example\.com$/;
export const newCanary = (bytes = randomBytes(8)) => `bp-canary-${bytes.toString("hex")}.example.com`;

const interfacePattern = /^[A-Za-z0-9_.:@-]{1,15}$/;
const isIpv4 = (value) => net.isIP(String(value ?? "")) === 4;
const unique = (values) => [...new Set(values)];

function ipv4Number(value) {
  return String(value).split(".").reduce((number, part) => ((number << 8) | Number(part)) >>> 0, 0);
}
function inRange(address, base, prefix) {
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (ipv4Number(address) & mask) === (ipv4Number(base) & mask);
}

/** Addresses that never leave a home: RFC 1918, carrier-grade NAT (Tailscale's range), link-local, loopback. */
export function isPrivateIpv4(address) {
  if (!isIpv4(address)) return false;
  return [["10.0.0.0", 8], ["172.16.0.0", 12], ["192.168.0.0", 16], ["100.64.0.0", 10], ["169.254.0.0", 16], ["127.0.0.0", 8]]
    .some(([base, prefix]) => inRange(address, base, prefix));
}

/** systemd's JSON writes an address as its bytes; older builds and other tools as a string. */
function addressFrom(value) {
  if (Array.isArray(value) && value.length === 4 && value.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255)) return value.join(".");
  return isIpv4(value) ? String(value) : null;
}

/**
 * `networkctl status <link> --json=short`: the link's DNS servers, each with where it came from.
 * DHCPv4 is the router's answer; anything else (static, from a .network file) is this server's own.
 * Null when it is not JSON networkd wrote, so the next reader is tried.
 */
export function parseNetworkctlDns(stdout) {
  let parsed;
  try { parsed = JSON.parse(stdout); } catch { return null; }
  const link = Array.isArray(parsed?.Interfaces) ? parsed.Interfaces[0] : parsed;
  if (!link || typeof link !== "object" || Array.isArray(link)) return null;
  const dhcp = [];
  const configured = [];
  let server = null;
  for (const entry of Array.isArray(link.DNS) ? link.DNS : []) {
    if (entry?.Family !== undefined && entry.Family !== 2) continue;
    const address = addressFrom(entry?.Address);
    if (!address) continue;
    if (/^DHCPv4$/i.test(String(entry.ConfigSource ?? ""))) {
      dhcp.push(address);
      server ??= addressFrom(entry.ConfigProvider);
    } else configured.push(address);
  }
  return { dhcp: unique(dhcp), configured: unique(configured), dhcpServer: server, dhcpClient: Boolean(link.DHCPv4Client) };
}

/** systemd-networkd's lease file, /run/systemd/netif/leases/<ifindex>: KEY=value lines. */
export function parseNetworkdLease(text) {
  const fields = Object.fromEntries(String(text ?? "").split("\n").map((line) => line.trim()).filter((line) => line && !line.startsWith("#") && line.includes("=")).map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]));
  const dns = unique(String(fields.DNS ?? "").split(/\s+/).filter(isIpv4));
  return { dns, server: isIpv4(fields.SERVER_ADDRESS) ? fields.SERVER_ADDRESS : null };
}

/** `nmcli -t -f DHCP4 device show <link>`: `DHCP4.OPTION[7]:domain_name_servers = 192.0.2.1 192.0.2.2`. */
export function parseNmcliDhcp(stdout) {
  const options = {};
  for (const line of String(stdout ?? "").split("\n")) {
    const match = /^DHCP4\.OPTION\[\d+\]:\s*([a-z0-9_]+)\s*=\s*(.*)$/.exec(line.trim());
    if (match) options[match[1]] = match[2].trim();
  }
  const dns = unique(String(options.domain_name_servers ?? "").split(/[\s,]+/).filter(isIpv4));
  return { dns, server: isIpv4(options.dhcp_server_identifier) ? options.dhcp_server_identifier : null };
}

/** dhclient's lease file: the last `lease { ... }` block is the one in force. */
export function parseDhclientLeases(text) {
  const blocks = String(text ?? "").split(/\blease\s*\{/).slice(1);
  const last = blocks.at(-1) ?? "";
  const dns = unique((/option\s+domain-name-servers\s+([^;]+);/.exec(last)?.[1] ?? "").split(/[\s,]+/).filter(isIpv4));
  const server = /option\s+dhcp-server-identifier\s+([0-9.]+);/.exec(last)?.[1] ?? null;
  return { dns, server: isIpv4(server) ? server : null };
}

async function fixedCommand(command, args, { timeout = 5000 } = {}) {
  try {
    const result = await execFile(command, args, { timeout, maxBuffer: 512 * 1024, encoding: "utf8", env: { PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin", LANG: "C.UTF-8", LC_ALL: "C.UTF-8", SYSTEMD_PAGER: "", SYSTEMD_COLORS: "0" } });
    return { ok: true, stdout: result.stdout };
  } catch (error) {
    return { ok: false, stdout: typeof error.stdout === "string" ? error.stdout : "", code: error.code ?? null };
  }
}

/**
 * What the router hands out, as this server sees it, and from where. `source` is "dhcp" (a lease:
 * the router's own answer), "configured" (this server's DNS is set by hand, which says nothing about
 * the devices), or "none". Every reader that fails hands over to the next.
 */
export async function readHandedOut({ interface: link, resolverLinks = [], run = fixedCommand, readFile = fsReadFile } = {}) {
  if (typeof link !== "string" || !interfacePattern.test(link)) return { source: "none", via: null, servers: [], dhcpServer: null };
  const networkctl = await run("networkctl", ["status", link, "--json=short", "--no-pager"]).catch(() => ({ ok: false }));
  const networkd = networkctl.ok ? parseNetworkctlDns(networkctl.stdout) : null;
  if (networkd?.dhcp.length) return { source: "dhcp", via: "systemd-networkd", servers: networkd.dhcp, dhcpServer: networkd.dhcpServer };

  const index = Number.parseInt(await readFile(`/sys/class/net/${link}/ifindex`, "utf8").catch(() => ""), 10);
  if (Number.isInteger(index) && index > 0) {
    const lease = parseNetworkdLease(await readFile(`/run/systemd/netif/leases/${index}`, "utf8").catch(() => ""));
    if (lease.dns.length) return { source: "dhcp", via: "systemd-networkd's lease", servers: lease.dns, dhcpServer: lease.server };
  }

  const nmcli = await run("nmcli", ["-t", "-f", "DHCP4", "device", "show", link]).catch(() => ({ ok: false }));
  const manager = nmcli.ok ? parseNmcliDhcp(nmcli.stdout) : null;
  if (manager?.dns.length) return { source: "dhcp", via: "NetworkManager", servers: manager.dns, dhcpServer: manager.server };

  for (const file of [`/var/lib/dhcp/dhclient.${link}.leases`, "/var/lib/dhcp/dhclient.leases"]) {
    const leased = parseDhclientLeases(await readFile(file, "utf8").catch(() => ""));
    if (leased.dns.length) return { source: "dhcp", via: "dhclient", servers: leased.dns, dhcpServer: leased.server };
  }

  const configured = unique([...(networkd?.configured ?? []), ...resolverLinks.filter((entry) => entry.interface === link).flatMap((entry) => (entry.servers ?? []).map((server) => server.address))]).filter(isIpv4);
  if (configured.length) return { source: "configured", via: networkd?.configured.length ? "systemd-networkd" : "systemd-resolved", servers: configured, dhcpServer: null };
  return { source: "none", via: null, servers: [], dhcpServer: null };
}

/** Who a DNS server is, from here: this server, the router, another box on the LAN, the tailnet, or the internet. */
export function roleOf(address, { selfAddresses = [], gateway = null, dhcpServer = null } = {}) {
  if (selfAddresses.includes(address) || address.startsWith("127.")) return "this-server";
  if (address === tailscaleResolver) return "tailscale";
  if (address === gateway || address === dhcpServer) return "router";
  return isPrivateIpv4(address) ? "lan" : "public";
}

const roleWords = { "this-server": "this server", router: "your router", lan: "another device on your network", public: "a public resolver", tailscale: "Tailscale's resolver" };

/**
 * One server asked directly, as a device asks it: does anything answer, does it resolve a name that
 * exists, and does it refuse one every blocklist carries.
 */
export async function askServer(address, { timeoutMs = 3000, verify = dnsBlockerVerify } = {}) {
  const started = Date.now();
  try {
    const report = await verify({ address, timeoutMs, checkInterception: false });
    return { answering: report.answering, resolving: report.resolving, blocking: report.blocking, error: report.control?.error ?? null, ms: Date.now() - started };
  } catch (error) {
    return { answering: false, resolving: false, blocking: false, error: String(error?.message ?? error), ms: Date.now() - started };
  }
}

/** One lookup of one name at one server: answered (an address, or a clean "no such name") or not, and how long it took. */
export async function askName(server, name, { timeoutMs = 3000, tries = 1, Resolver = DnsResolver } = {}) {
  const resolver = new Resolver({ timeout: timeoutMs, tries });
  resolver.setServers([server]);
  const started = Date.now();
  try {
    const addresses = await resolver.resolve4(name);
    return { answered: true, addresses, error: null, ms: Date.now() - started };
  } catch (error) {
    const code = String(error?.code ?? error?.message ?? error);
    // NXDOMAIN and "no A record" are answers: something resolved the question and said no.
    return { answered: code === "ENOTFOUND" || code === "ENODATA", addresses: [], error: code, ms: Date.now() - started };
  }
}

/**
 * The verdict, from facts gathered elsewhere. Pure.
 *
 * Each server handed out is `depends` (it is this server, or a router shown to ask only this one),
 * `independent` (it answers with this server out of the picture), `broken` (it did not answer at
 * all), `unknown` (a router passing lookups here whose fallback nobody has rehearsed) or `skipped`
 * (Tailscale's own resolver). The house survives this server going down when one is independent.
 */
export function judgeResilience(facts, { now = new Date(), hostname = "This server" } = {}) {
  const { handedOut = { source: "none", servers: [] }, selfAddresses = [], gateway = null, servesDns = false, answers = {}, canary = null, rehearsal = null } = facts ?? {};
  const at = now instanceof Date ? now.getTime() : Number(now);
  const fresh = rehearsal && Number.isFinite(Date.parse(rehearsal.at)) && at - Date.parse(rehearsal.at) <= rehearsalFreshForMs ? rehearsal : null;
  const servers = handedOut.servers.map((address) => {
    const role = roleOf(address, { selfAddresses, gateway, dhcpServer: handedOut.dhcpServer });
    const answer = answers[address] ?? null;
    const base = { address, role, label: roleWords[role], answering: answer?.answering ?? null, resolving: answer?.resolving ?? null, blocking: answer?.blocking ?? null, error: answer?.error ?? null };
    if (role === "tailscale") return { ...base, verdict: "skipped", note: "Tailscale's resolver answers tailnet devices, not the house." };
    if (role === "this-server") return { ...base, verdict: "depends", note: `Goes when ${hostname} goes.` };
    if (!answer || !answer.answering) return { ...base, verdict: "broken", note: "Did not answer a lookup from here." };
    if (!answer.resolving) return { ...base, verdict: "broken", note: "Answered, but could not look up a name that exists." };
    if (role !== "router") return { ...base, verdict: "independent", note: answer.blocking ? "Answers on its own, and blocks too." : "Answers on its own, without blocking." };
    // The router: independent unless it passes lookups to this server, and then only a rehearsal can tell.
    if (!servesDns) return { ...base, verdict: "independent", note: "Answers on its own: nothing on this server answers DNS for it to lean on." };
    // `leansHere`: while this server is up, the router's lookups go to it (and are blocked there).
    if (fresh && fresh.router === address && typeof fresh.passed === "boolean") {
      return fresh.passed
        ? { ...base, verdict: "independent", leansHere: true, note: `Kept answering with ${fresh.appName ?? "Pi-hole"} stopped (rehearsed ${new Date(fresh.at).toISOString().slice(0, 10)}).` }
        : { ...base, verdict: "depends", leansHere: true, note: `Stopped answering with ${fresh.appName ?? "Pi-hole"} stopped (rehearsed ${new Date(fresh.at).toISOString().slice(0, 10)}).` };
    }
    if (canary?.router === address && canary.forwards === false) return { ...base, verdict: "independent", note: "Answers without asking this server: a made-up name asked of it never reached the DNS server here." };
    return { ...base, verdict: "unknown", leansHere: true, forwards: canary?.router === address ? canary.forwards : null, note: canary?.router === address && canary.forwards ? "Passes lookups to the DNS server here. Whether it falls back to anything else when that is off is not known until rehearsed." : "Whether it leans on the DNS server here is not known." };
  });

  const counted = servers.filter((server) => server.verdict !== "skipped");
  const independent = counted.filter((server) => server.verdict === "independent");
  const unknown = counted.filter((server) => server.verdict === "unknown");
  const dependsHere = counted.some((server) => server.role === "this-server" || server.leansHere === true);
  // A server handed out next to the blocker that answers without blocking: devices use either at any time.
  const skipsBlocking = independent.some((server) => !server.leansHere && server.blocking === false) && counted.some((server) => server.role === "this-server");
  const router = counted.find((server) => server.role === "router")?.address ?? null;
  const list = (entries) => entries.map((server) => server.address).join(" and ");
  const base = { source: handedOut.source, via: handedOut.via ?? null, dhcpServer: handedOut.dhcpServer ?? null, servers, router, skipsBlocking, rehearsal: fresh ?? rehearsal ?? null, rehearsalStale: Boolean(rehearsal && !fresh), servesDns: Boolean(servesDns) };

  if (handedOut.source !== "dhcp" || counted.length === 0) {
    return {
      ...base, state: "unknown", status: "unknown",
      headline: "Not known what your router hands out",
      detail: handedOut.source === "configured"
        ? `This server's address and DNS are set by hand (${list(counted.length ? counted : servers)}), so it has no lease to show what the router gives your devices. A device's network details show it: on Windows, ipconfig /all; on an iPhone, Settings, Wi-Fi, the (i) beside the network.`
        : "This server has no DHCP lease to read, so what the router gives your devices cannot be seen from here.",
    };
  }
  if (counted.every((server) => server.verdict === "broken")) {
    return { ...base, state: "unknown", status: "unknown", headline: "No DNS server your devices are given answered from here", detail: `${list(counted)} did not answer a lookup sent from this server, so how the house would fare without it cannot be told. Check again in a minute; if it stays this way, devices on your network are probably not resolving names either.` };
  }
  if (!dependsHere) {
    return { ...base, state: "independent", status: "neutral", headline: `Your network's DNS does not depend on ${hostname}`, detail: `Devices are given ${list(counted)}, and none of them leans on this server.` };
  }
  if (independent.length) {
    const fallback = independent[0];
    return {
      ...base, state: "resilient", status: "good",
      headline: `Your network keeps working when ${hostname} is off`,
      detail: fallback.role === "router" && fallback.leansHere
        ? `Devices ask your router at ${fallback.address}, and it kept answering when the DNS server here was stopped.`
        : `${fallback.address} (${fallback.label}) answers lookups on its own, so devices still resolve names while this server is off.${skipsBlocking ? " Devices can use it at any time, though, so they sometimes skip the blocking here." : ""}`,
    };
  }
  if (unknown.length) {
    return {
      ...base, state: "unproven", status: "warning",
      headline: `Not known yet whether your network keeps working when ${hostname} is off`,
      detail: `Devices ask your router at ${unknown[0].address}${unknown[0].forwards ? ", and the router passes their lookups to the DNS server here" : ""}. Whether it falls back to another resolver when this server is off can only be seen by trying: rehearse it.`,
    };
  }
  const broken = counted.filter((server) => server.verdict === "broken");
  const only = counted.filter((server) => server.role === "this-server");
  const routerFailed = counted.find((server) => server.role === "router" && server.verdict === "depends");
  return {
    ...base, state: "single-point", status: "danger",
    headline: `If ${hostname} goes down, every device on your network loses the internet`,
    detail: routerFailed
      ? `Devices ask your router at ${routerFailed.address}, and the router only asks the DNS server here: when it was stopped for the rehearsal, the router answered nothing.`
      : broken.length
        ? `${only.length ? `Your router hands out ${list(only)} (this server) and ${list(broken)}, but ${broken.length === 1 ? "that one" : "those"} did not` : `${list(broken)} did not`} answer a lookup from here, so ${broken.length === 1 ? "it" : "they"} would not help while this server is off.`
        : `Your router hands out ${list(only)} (this server) as the only DNS server, so every lookup in the house goes to the DNS server here. While this server is off, names stop resolving and the internet looks down on every device.`,
  };
}

/**
 * The service the Network page and Repair's scan read. `network` is server/network.mjs's service (for
 * the addresses, the gateway, the port 53 listeners); `helper` asks the DNS app's own query log about
 * the canary; `store` holds the last rehearsal.
 */
export function createDnsResilienceService({ network, helper = null, store = null, run = fixedCommand, readFile = fsReadFile, ask = askServer, askOne = askName, hostname = () => os.hostname().split(".")[0], now = () => new Date(), cacheMs = cacheForMs, canaryDelayMs = 400, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = {}) {
  let cached = null;
  let inflight = null;

  /** Does the router pass lookups to the DNS app here? A canary through it, and one straight to the app to prove the log is written. */
  async function routerCanary(routerAddress, lanAddress) {
    if (!helper || !lanAddress) return null;
    const viaRouter = newCanary();
    const direct = newCanary();
    const [routed, straight] = await Promise.all([askOne(routerAddress, viaRouter), askOne(lanAddress, direct)]);
    if (!routed.answered || !straight.answered) return { router: routerAddress, forwards: null };
    await sleep(canaryDelayMs);
    const seen = await helper.request("dns.blocker.canary", { names: [viaRouter, direct] }, { timeoutMs: 30_000 }).catch(() => null);
    // Not written for the direct one either: the log is off or unreadable, and silence proves nothing.
    if (!seen?.available || !seen.seen?.[direct]) return { router: routerAddress, forwards: null };
    return { router: routerAddress, forwards: Boolean(seen.seen[viaRouter]) };
  }

  async function gather() {
    const topology = await network.inspect();
    const route = topology.defaultRoutes?.[0] ?? null;
    const eligible = topology.eligibleLanAddresses ?? [];
    const lan = eligible.find((entry) => entry.interface === route?.interface) ?? eligible[0] ?? null;
    const selfAddresses = unique((topology.addresses ?? []).map((entry) => entry.address).filter(isIpv4));
    const handedOut = await readHandedOut({ interface: lan?.interface ?? route?.interface, resolverLinks: topology.resolverLinks ?? [], run, readFile });
    // Something here answers DNS for the LAN: a listener on every address or on the LAN address.
    const servesDns = (topology.dnsListeners ?? []).some((listener) => listener.scope === "wildcard" || listener.address === lan?.address);
    const gateway = route?.gateway ?? null;
    const asked = handedOut.servers.filter((address) => address !== tailscaleResolver).slice(0, 4);
    const answers = Object.fromEntries(await Promise.all(asked.map(async (address) => [address, await ask(address)])));
    const routerAddress = handedOut.servers.find((address) => roleOf(address, { selfAddresses, gateway, dhcpServer: handedOut.dhcpServer }) === "router") ?? null;
    const canary = routerAddress && servesDns && answers[routerAddress]?.answering ? await routerCanary(routerAddress, lan?.address ?? null).catch(() => null) : null;
    const rehearsal = store?.getSetting?.(rehearsalSetting, null) ?? null;
    const facts = { handedOut, selfAddresses, gateway, servesDns, answers, canary, rehearsal };
    const verdict = judgeResilience(facts, { now: now(), hostname: hostname() });
    return { ...verdict, checkedAt: now().toISOString(), lanAddress: lan?.address ?? null, gateway, canary };
  }

  /** The answer, at most ten minutes old unless `fresh`; one read at a time however many ask. */
  async function check({ fresh = false } = {}) {
    if (!fresh && cached && now().getTime() - cached.at < cacheMs) return cached.result;
    if (inflight) return inflight;
    inflight = gather()
      .then((result) => { cached = { at: now().getTime(), result }; return result; })
      .finally(() => { inflight = null; });
    return inflight;
  }

  /** A rehearsal or a router change makes the kept answer stale. */
  function forget() { cached = null; }

  return { check, forget, internals: { gather, routerCanary } };
}

export { controlDomain };
