/**
 * Where a model may live (M34, kept for M37): on this server or the owner's own network, never a
 * cloud service. Every model client - the OpenAI-compatible one the agents and the assistant use,
 * and the legacy Ollama one - goes through these rules: the address must be a loopback, private,
 * link-local or tailnet (100.64.0.0/10) address, or a name that resolves only to those, checked
 * when it is saved and again before every request, and a redirect is refused rather than followed
 * somewhere else. It lives in the harness since M45.8, so the CLI's local provider keeps the same
 * rules as BoxPilot's.
 */
import { lookup as dnsLookup } from "node:dns/promises";
import net from "node:net";

const privateV4 = [["127.0.0.0", 8], ["10.0.0.0", 8], ["172.16.0.0", 12], ["192.168.0.0", 16], ["169.254.0.0", 16], ["100.64.0.0", 10]];
const v4ToInt = (address) => address.split(".").reduce((value, part) => ((value << 8) | Number(part)) >>> 0, 0);
// Names that only ever mean something on a home network or a tailnet. A single label ("gpu-box")
// is resolved by the LAN's own DNS; anything else must resolve to a private address anyway.
const localSuffixes = [".local", ".lan", ".home", ".internal", ".home.arpa", ".localdomain", ".ts.net"];

/** Whether an IP address is on this machine, the LAN, a link, or the tailnet. */
export function isLocalAddress(address) {
  const bare = String(address ?? "").replace(/^\[|\]$/g, "");
  if (net.isIPv4(bare)) {
    const value = v4ToInt(bare);
    return privateV4.some(([base, bits]) => ((value ^ v4ToInt(base)) >>> (32 - bits)) === 0);
  }
  if (net.isIPv6(bare)) {
    const lower = bare.toLowerCase();
    if (lower === "::1") return true;
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
    if (mapped) return isLocalAddress(mapped[1]);
    const first = Number.parseInt(lower.split(":")[0] || "0", 16);
    // fc00::/7 (unique local) and fe80::/10 (link-local).
    return (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80;
  }
  return false;
}

/** Whether an address is this machine itself: the only place an agent's model may run (M37). */
export function isLoopbackAddress(address) {
  const bare = String(address ?? "").replace(/^\[|\]$/g, "").toLowerCase();
  if (net.isIPv4(bare)) return bare.startsWith("127.");
  return bare === "::1" || /^::ffff:127\./.test(bare);
}

export function isLocalName(hostname) {
  const name = hostname.toLowerCase();
  if (name === "localhost" || name.endsWith(".localhost")) return true;
  if (/^[a-z0-9](?:[a-z0-9-]{0,62})$/.test(name)) return true;
  return localSuffixes.some((suffix) => name.endsWith(suffix) && name.length > suffix.length);
}

/**
 * The address as it is stored: `http(s)://host:port`, nothing more. Throws with a sentence the
 * Settings page can show when it is not an address on this server or the owner's network.
 */
export function normalizeEndpoint(input) {
  if (typeof input !== "string" || !input.trim() || input.length > 200) throw new Error("Give the model server's address, like http://127.0.0.1:11434");
  let url;
  try { url = new URL(input.trim()); } catch { throw new Error("That is not an address. Use the form http://192.168.1.20:11434"); }
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("The address must start with http:// or https://");
  if (url.username || url.password) throw new Error("The address must not carry a user name or password; a local model server needs none");
  if (url.search || url.hash || !["", "/"].includes(url.pathname)) throw new Error("Give the address only, like http://192.168.1.20:11434, with no path");
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const literal = net.isIP(hostname) !== 0;
  if (literal ? !isLocalAddress(hostname) : !isLocalName(hostname)) throw new Error("The assistant only talks to a model on this server or your own network: use a private, tailnet or loopback address");
  return url.origin;
}

/**
 * A guard that resolves an endpoint's name before each request and refuses one that resolves
 * anywhere public, even if it looked local when it was saved. Names are remembered for a minute.
 * `loopbackOnly` narrows it to this machine: an agent's model is started by the agents runner and
 * listens on 127.0.0.1 only.
 */
export function createEndpointGuard({ lookup = dnsLookup, now = () => Date.now(), resolveTtlMs = 60_000, loopbackOnly = false } = {}) {
  const resolved = new Map();
  const allowed = loopbackOnly ? isLoopbackAddress : isLocalAddress;
  return async function guard(endpoint) {
    const url = new URL(normalizeEndpoint(endpoint));
    const hostname = url.hostname.replace(/^\[|\]$/g, "");
    if (net.isIP(hostname)) {
      if (!allowed(hostname)) throw new Error(`${hostname} is not on this server`);
      return url.origin;
    }
    const cached = resolved.get(hostname);
    if (cached && now() - cached.at < resolveTtlMs) {
      if (!cached.ok) throw new Error(`${hostname} does not resolve to an address on this network`);
      return url.origin;
    }
    const addresses = await lookup(hostname, { all: true }).catch(() => []);
    const ok = addresses.length > 0 && addresses.every((entry) => allowed(entry.address));
    resolved.set(hostname, { at: now(), ok });
    if (resolved.size > 64) resolved.delete(resolved.keys().next().value);
    if (!ok) throw new Error(`${hostname} does not resolve to an address on this network`);
    return url.origin;
  };
}

/** Read at most `maxBytes` of a response body as text; a larger body is an error, not a truncation. */
export async function readBounded(response, maxBytes) {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const decoder = new TextDecoder();
  let text = ""; let bytes = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) throw new Error("The model server sent more than expected");
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return text + decoder.decode();
}
