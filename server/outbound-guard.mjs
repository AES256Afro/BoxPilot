/**
 * Where an outbound request from this server may not go (M50): the link-local range. The cloud
 * metadata service lives there and hands out instance credentials; nothing a home server talks to
 * does. Loopback and LAN stay open on purpose, since the owner's own ntfy, Uptime Kuma and webhooks
 * are the point of these requests.
 *
 * Before M50 each caller matched the hostname's text, so three forms got through: an IPv4-mapped
 * IPv6 literal (`[::ffff:169.254.169.254]`), a name that resolves there, and a redirect there. Here
 * a literal is read as an address, a name is resolved first and every address it has is checked,
 * and `fetchGuarded` follows redirects by hand and checks each hop. The resolve-then-connect window
 * remains; the metadata service does not answer a name a public resolver can rebind within it.
 */
import { lookup as dnsLookup } from "node:dns/promises";
import net from "node:net";

const metadataNames = new Set(["metadata.google.internal", "metadata", "instance-data"]);

/** Whether an IP address is link-local: 169.254.0.0/16, fe80::/10, or either in IPv4-mapped form. */
export function isLinkLocalAddress(address) {
  const bare = String(address ?? "").replace(/^\[|\]$/g, "").toLowerCase();
  if (net.isIPv4(bare)) return bare.startsWith("169.254.");
  if (!net.isIPv6(bare)) return false;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(bare);
  if (mapped) return isLinkLocalAddress(mapped[1]);
  // Node also prints the mapped form as hex: ::ffff:a9fe:a9fe.
  const hexMapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(bare);
  if (hexMapped) return Number.parseInt(hexMapped[1], 16) >>> 8 === 0xa9 && (Number.parseInt(hexMapped[1], 16) & 0xff) === 0xfe;
  const first = Number.parseInt(bare.split(":")[0] || "0", 16);
  return (first & 0xffc0) === 0xfe80;
}

/**
 * The reason a URL may not be requested, or null. A literal address is judged as one; a name is
 * resolved and refused if any of its addresses is link-local. A name that does not resolve is let
 * through: the request itself then fails with the resolver's own error, and nothing was reached.
 */
export async function linkLocalProblem(url, { lookup = dnsLookup } = {}) {
  let parsed;
  try { parsed = url instanceof URL ? url : new URL(String(url)); } catch { return "is not an address"; }
  const host = parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (metadataNames.has(host) || host.endsWith(".metadata.google.internal")) return "is the cloud metadata service, which this server never asks";
  if (net.isIP(host)) return isLinkLocalAddress(host) ? "is a link-local address, which this server never asks" : null;
  const addresses = await lookup(host, { all: true }).catch(() => []);
  return addresses.some((entry) => isLinkLocalAddress(entry.address)) ? "resolves to a link-local address, which this server never asks" : null;
}

const redirectStatuses = new Set([301, 302, 303, 307, 308]);

/**
 * fetch with the link-local check on the first address and on every redirect. With
 * `followRedirects` false (a credential rides along) a 3xx is returned as it is, never chased. A
 * 303, or a 301/302 answering a POST, is followed as a GET without the body, as browsers do.
 *
 * @param {string | URL} url
 * @param {RequestInit} [options]
 * @param {{ fetcher?: typeof fetch, lookup?: typeof dnsLookup, followRedirects?: boolean, maxRedirects?: number }} [deps]
 */
export async function fetchGuarded(url, options = {}, { fetcher = fetch, lookup = dnsLookup, followRedirects = true, maxRedirects = 5 } = {}) {
  let current = new URL(String(url));
  /** @type {RequestInit} */
  let request = { ...options, redirect: "manual" };
  for (let hop = 0; ; hop += 1) {
    const problem = await linkLocalProblem(current, { lookup });
    if (problem) throw new Error(`The address ${hop ? "it redirects to " : ""}${problem}`);
    const response = await fetcher(current.href, request);
    if (!followRedirects || !redirectStatuses.has(response.status)) return response;
    const location = response.headers.get("location");
    if (!location) return response;
    if (hop >= maxRedirects) throw new Error("Too many redirects");
    await response.body?.cancel?.().catch(() => {});
    let next;
    try { next = new URL(location, current); } catch { throw new Error("The address it redirects to is not an address"); }
    if (!["http:", "https:"].includes(next.protocol)) throw new Error("The address it redirects to is not http(s)");
    current = next;
    const method = String(request.method ?? "GET").toUpperCase();
    if (response.status === 303 || ((response.status === 301 || response.status === 302) && method === "POST")) {
      const { body: _body, ...rest } = request;
      const headers = { ...(rest.headers ?? {}) };
      for (const name of Object.keys(headers)) if (/^content-(type|length)$/i.test(name)) delete headers[name];
      request = { ...rest, method: "GET", headers };
    }
  }
}
