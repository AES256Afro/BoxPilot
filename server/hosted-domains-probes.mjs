/**
 * The hosted-domains page's hands (M42.2): the three things it asks the network about a public
 * name. Does the name resolve, and to what; does the name answer over HTTPS from the internet's
 * side (through Cloudflare and back down the tunnel into this server), and what certificate does
 * it show; does the app answer on this server at the address the tunnel sends visitors to.
 *
 * In the web process, not the helper: the helper runs with PrivateNetwork=true, and these are the
 * same outbound requests the notifier and the release check already make from here. Every probe is
 * one GET with a short deadline; redirects are an answer, not a path to follow. A public name that
 * resolves to a private address is reported and never probed: BoxPilot does not become a way to
 * knock on doors inside the house from a name somebody typed.
 */
import { Resolver } from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import { isIP, isIPv4 } from "node:net";
import { productVersion } from "./version.mjs";

/**
 * Cloudflare's published address ranges (https://www.cloudflare.com/ips/): a proxied name resolves
 * to one of these, never to the tunnel's CNAME, which Cloudflare keeps to itself. Cloudflare's own
 * network, not anybody's host: the one external constant this page needs.
 */
export const cloudflareRanges = Object.freeze([
  "173.245.48.0/20", "103.21.244.0/22", "103.22.200.0/22", "103.31.4.0/22", "141.101.64.0/18", "108.162.192.0/18", "190.93.240.0/20",
  "188.114.96.0/20", "197.234.240.0/22", "198.41.128.0/17", "162.158.0.0/15", "104.16.0.0/13", "104.24.0.0/14", "172.64.0.0/13", "131.0.72.0/22",
  "2400:cb00::/32", "2606:4700::/32", "2803:f800::/32", "2405:b500::/32", "2405:8100::/32", "2a06:98c0::/29", "2c0f:f248::/32",
]);

/** Addresses nothing on the internet should resolve to: the house, the box itself, the link, the tailnet. */
const privateRanges = Object.freeze(["0.0.0.0/8", "10.0.0.0/8", "100.64.0.0/10", "127.0.0.0/8", "169.254.0.0/16", "172.16.0.0/12", "192.168.0.0/16", "::/128", "::1/128", "fc00::/7", "fe80::/10"]);

/** An address as a 128-bit number, IPv4 mapped into the v6 space so one comparison serves both. */
function toBigInt(address) {
  const text = String(address ?? "").trim();
  if (isIPv4(text)) return BigInt(text.split(".").reduce((sum, part) => sum * 256 + Number(part), 0)) + (0xffffn << 32n);
  if (isIP(text) !== 6) return null;
  let body = text;
  if (body.startsWith("[") && body.endsWith("]")) body = body.slice(1, -1);
  // An IPv4-mapped tail (::ffff:192.168.1.10) becomes two groups.
  const mapped = /^(.*:)(\d+\.\d+\.\d+\.\d+)$/.exec(body);
  if (mapped) {
    const value = mapped[2].split(".").reduce((sum, part) => sum * 256 + Number(part), 0);
    body = `${mapped[1]}${(value >>> 16).toString(16)}:${(value & 0xffff).toString(16)}`;
  }
  const halves = body.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const groups = halves.length === 2 ? [...head, ...Array(8 - head.length - tail.length).fill("0"), ...tail] : head;
  if (groups.length !== 8) return null;
  return groups.reduce((sum, group) => (sum << 16n) + BigInt(Number.parseInt(group || "0", 16)), 0n);
}

function inRange(address, cidr) {
  const [base, bitsText] = cidr.split("/");
  const value = toBigInt(address);
  const start = toBigInt(base);
  if (value === null || start === null) return false;
  const v4 = isIPv4(base);
  const bits = BigInt(Number(bitsText) + (v4 ? 96 : 0));
  const mask = bits >= 128n ? (1n << 128n) - 1n : ((1n << 128n) - 1n) ^ ((1n << (128n - bits)) - 1n);
  return (value & mask) === (start & mask);
}

export const isCloudflareAddress = (address) => cloudflareRanges.some((range) => inRange(address, range));
export const isPrivateAddress = (address) => isIP(String(address ?? "")) !== 0 && privateRanges.some((range) => inRange(address, range));

/**
 * What a name resolves to right now, from this server's own resolvers: its addresses, or that it
 * has none. ENODATA on one family is not an error (an IPv4-only name is a name).
 * @param {string} hostname
 * @param {{ resolver?: { resolve4: (name: string) => Promise<string[]>, resolve6: (name: string) => Promise<string[]> }, timeoutMs?: number }} [options]
 */
export async function resolveName(hostname, { resolver = null, timeoutMs = 5000 } = {}) {
  const asked = resolver ?? new Resolver({ timeout: timeoutMs, tries: 2 });
  const addresses = [];
  let error = null;
  for (const family of ["resolve4", "resolve6"]) {
    try {
      const found = await asked[family](hostname);
      // Only addresses: a resolver's answer is data, and anything else in it is not an address.
      addresses.push(...(Array.isArray(found) ? found : []).filter((entry) => typeof entry === "string" && isIP(entry)));
    } catch (caught) {
      const code = typeof caught?.code === "string" ? caught.code : "";
      // No records of this family is an answer; anything else (SERVFAIL, a timeout) is a failed lookup.
      if (code !== "ENODATA" && code !== "ENOTFOUND") error = code || (typeof caught?.message === "string" && caught.message) || "lookup failed";
    }
  }
  const unique = [...new Set(addresses)];
  return { resolved: unique.length > 0, addresses: unique, viaCloudflare: unique.length > 0 && unique.every(isCloudflareAddress), private: unique.some(isPrivateAddress), error: unique.length ? null : (error ?? "ENOTFOUND") };
}

/** The certificate a TLS socket showed, in the few fields the page reads. Nothing that could be mistaken for a key. */
function describeCertificate(socket) {
  const peer = typeof socket.getPeerCertificate === "function" ? socket.getPeerCertificate() : null;
  if (!peer || !peer.valid_to) return null;
  const validTo = new Date(peer.valid_to);
  return {
    validTo: Number.isNaN(validTo.getTime()) ? null : validTo.toISOString(),
    validFrom: peer.valid_from && !Number.isNaN(new Date(peer.valid_from).getTime()) ? new Date(peer.valid_from).toISOString() : null,
    issuer: peer.issuer?.O ?? peer.issuer?.CN ?? null,
    subject: peer.subject?.CN ?? null,
    altNames: typeof peer.subjectaltname === "string" ? peer.subjectaltname.split(",").map((entry) => entry.trim().replace(/^DNS:/, "")).filter((entry) => entry && !entry.startsWith("IP")) : [],
    authorized: socket.authorized === true,
    authorizationError: socket.authorized ? null : (socket.authorizationError?.code ?? socket.authorizationError?.message ?? String(socket.authorizationError ?? "")) || null,
  };
}

/**
 * One GET. `hostHeader` is the name the request is for when the address is not it: the app on this
 * server is asked at 127.0.0.1 with the public name in Host, the way the tunnel asks it. A redirect
 * is reported with its status and not followed; a certificate that would not verify is reported,
 * not refused, because "answers, but a browser will warn" is the finding.
 * @param {{ url: string, hostHeader?: string | null, timeoutMs?: number }} probe
 * @returns {Promise<{ outcome: "answered" | "timeout" | "refused" | "error", status: number | null, ms: number, server: string | null, tls: ReturnType<typeof describeCertificate> | null, error: string | null }>}
 */
export function probeUrl({ url, hostHeader = null, timeoutMs = 10_000 }) {
  return new Promise((resolve) => {
    let target;
    try { target = new URL(url); } catch { return resolve({ outcome: "error", status: null, ms: 0, server: null, tls: null, error: "not a valid address" }); }
    if (!["http:", "https:"].includes(target.protocol)) return resolve({ outcome: "error", status: null, ms: 0, server: null, tls: null, error: "only http and https are probed" });
    const started = Date.now();
    const secure = target.protocol === "https:";
    const transport = secure ? https : http;
    let tls = null;
    let settled = false;
    const finish = (result) => { if (!settled) { settled = true; resolve(result); } };
    const headers = { "user-agent": `BoxPilot/${productVersion} (hosted-domains check)`, accept: "text/html,*/*;q=0.5", ...(hostHeader ? { host: hostHeader } : {}) };
    const request = transport.request(target, { method: "GET", headers, timeout: timeoutMs, rejectUnauthorized: false, servername: secure ? (hostHeader ?? target.hostname) : undefined, agent: false }, (response) => {
      response.resume();
      finish({ outcome: "answered", status: response.statusCode ?? null, ms: Date.now() - started, server: typeof response.headers.server === "string" ? response.headers.server.slice(0, 40) : null, tls, error: null });
    });
    request.on("socket", (socket) => {
      if (secure) socket.once("secureConnect", () => { tls = describeCertificate(socket); });
    });
    request.on("timeout", () => { request.destroy(new Error("timeout")); });
    request.on("error", (/** @type {NodeJS.ErrnoException} */ error) => {
      const ms = Date.now() - started;
      if (error.message === "timeout") return finish({ outcome: "timeout", status: null, ms, server: null, tls, error: `no answer within ${Math.round(timeoutMs / 1000)}s` });
      if (error.code === "ECONNREFUSED") return finish({ outcome: "refused", status: null, ms, server: null, tls, error: "nothing is listening" });
      finish({ outcome: "error", status: null, ms, server: null, tls, error: error.code ?? error.message });
    });
    request.end();
  });
}

/** The probes the service runs by default; a test hands it its own. */
export const defaultProbes = Object.freeze({ resolve: resolveName, probe: probeUrl });
