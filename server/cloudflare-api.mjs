/**
 * The few calls to Cloudflare's API (v4) that publishing an app needs (M42, ADR-011), and the rules
 * for changing a tunnel's routes without disturbing the ones BoxPilot did not make.
 *
 * Only the root tasks in server/tasks/cloudflare.mjs use this: they have the network the helper does
 * not, and they read the owner's API token from the credential store themselves. The token goes
 * into one header and nowhere else. Redirects are never followed while it rides along, and every
 * error is said in plain words, with the token scrubbed out of anything Cloudflare sent back.
 */
import { sameName } from "./cloudflare-tunnel.mjs";

export const cloudflareApiBase = "https://api.cloudflare.com/client/v4";
/** What the last rule of a tunnel's routes answers when no name matched. */
export const catchAllService = "http_status:404";
/** What a token needs, said the way Cloudflare's token page lists them. */
export const tokenPermissions = Object.freeze(["Account · Cloudflare Tunnel · Edit", "Zone · DNS · Edit", "Zone · Zone · Read"]);

const rejected = "Cloudflare did not accept this token";

export class CloudflareError extends Error {
  constructor(message, { status = null, code = null } = {}) {
    super(message);
    this.name = "CloudflareError";
    this.status = status;
    this.code = code;
  }
}

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const segment = (value) => encodeURIComponent(String(value ?? ""));

/**
 * A client for one token. `fetcher` is injectable so tests never touch the network. Each call is
 * bounded by `timeoutMs`; `what` names the step for the error ("listing your domains").
 */
export function createCloudflareApi({ token, fetcher = fetch, timeoutMs = 20_000, base = cloudflareApiBase } = {}) {
  if (typeof token !== "string" || !token) throw new Error("No Cloudflare API token is saved; connect Cloudflare first");
  const scrub = (message) => String(message ?? "").split(token).join("[token]").slice(0, 300);

  async function call(method, route, { query = null, body = null, what = "asking Cloudflare" } = {}) {
    const url = new URL(`${base}${route}`);
    for (const [key, value] of Object.entries(query ?? {})) url.searchParams.set(key, String(value));
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    let raw = "";
    try {
      response = await fetcher(url.toString(), {
        method,
        headers: { Authorization: `Bearer ${token}`, Accept: "application/json", ...(body !== null ? { "Content-Type": "application/json" } : {}) },
        ...(body !== null ? { body: JSON.stringify(body) } : {}),
        // The token is in a header: a redirect is returned, never chased to another host.
        redirect: "manual",
        signal: controller.signal,
      });
      raw = await response.text();
    } catch (error) {
      throw new CloudflareError(error?.name === "AbortError"
        ? `Cloudflare did not answer within ${Math.round(timeoutMs / 1000)} seconds while ${what}`
        : `Could not reach Cloudflare while ${what} (${scrub(error?.cause?.code ?? error?.message ?? "network error")})`);
    } finally {
      clearTimeout(timer);
    }
    let payload = null;
    try { payload = JSON.parse(raw); } catch { payload = null; }
    const first = Array.isArray(payload?.errors) ? payload.errors.find(isObject) ?? null : null;
    if (response.status === 401 || response.status === 403) {
      throw new CloudflareError(`${rejected} while ${what}. Check that it has the three permissions (${tokenPermissions.join("; ")}) and covers this account and domain.`, { status: response.status, code: first?.code ?? null });
    }
    if (response.status >= 300 && response.status < 400) throw new CloudflareError(`Cloudflare answered with a redirect while ${what}, which BoxPilot does not follow with your token`, { status: response.status });
    if (response.ok && !isObject(payload)) throw new CloudflareError(`Cloudflare sent an answer BoxPilot could not read while ${what}`, { status: response.status });
    if (!response.ok || payload.success === false) {
      const said = first?.message ? `: ${scrub(first.message)}${first.code ? ` (code ${first.code})` : ""}` : ` (HTTP ${response.status})`;
      throw new CloudflareError(`Cloudflare refused ${what}${said}`, { status: response.status, code: first?.code ?? null });
    }
    return payload;
  }

  /** Every active domain the token can read, with the account each belongs to. */
  async function listZones() {
    const zones = [];
    for (let page = 1; page <= 10; page += 1) {
      const payload = await call("GET", "/zones", { query: { per_page: 50, status: "active", page }, what: "listing your domains" });
      for (const zone of Array.isArray(payload.result) ? payload.result : []) {
        if (isObject(zone) && typeof zone.id === "string" && typeof zone.name === "string") {
          zones.push({ id: zone.id, name: zone.name.toLowerCase(), account: isObject(zone.account) && typeof zone.account.id === "string" ? { id: zone.account.id, name: typeof zone.account.name === "string" ? zone.account.name : zone.account.id } : null });
        }
      }
      const pages = Number(payload.result_info?.total_pages ?? 1);
      if (!Number.isFinite(pages) || page >= pages) break;
    }
    return zones;
  }

  const describeTunnel = (tunnel) => ({
    id: tunnel.id,
    name: tunnel.name,
    status: typeof tunnel.status === "string" ? tunnel.status : null,
    remoteConfig: tunnel.remote_config === true || tunnel.config_src === "cloudflare",
    connections: Array.isArray(tunnel.connections) ? tunnel.connections.filter(isObject) : [],
    ...(typeof tunnel.token === "string" ? { runKey: tunnel.token } : {}),
  });

  /** The tunnel with exactly this name, not deleted, or null. */
  async function findTunnel(accountId, name) {
    const payload = await call("GET", `/accounts/${segment(accountId)}/cfd_tunnel`, { query: { name, is_deleted: "false" }, what: "looking for the tunnel" });
    const found = (Array.isArray(payload.result) ? payload.result : []).find((tunnel) => isObject(tunnel) && tunnel.name === name && !tunnel.deleted_at && typeof tunnel.id === "string");
    return found ? describeTunnel(found) : null;
  }

  /** A new tunnel whose routes are kept at Cloudflare (so BoxPilot can change them through this API). */
  async function createTunnel(accountId, name) {
    const payload = await call("POST", `/accounts/${segment(accountId)}/cfd_tunnel`, { body: { name, config_src: "cloudflare" }, what: "making the tunnel" });
    if (!isObject(payload.result) || typeof payload.result.id !== "string") throw new CloudflareError("Cloudflare made no tunnel");
    return describeTunnel(payload.result);
  }

  /** The key a connector runs the tunnel with (cloudflared's TUNNEL_TOKEN). */
  async function tunnelRunKey(accountId, tunnelId) {
    const payload = await call("GET", `/accounts/${segment(accountId)}/cfd_tunnel/${segment(tunnelId)}/token`, { what: "reading the tunnel's key" });
    if (typeof payload.result !== "string" || payload.result.length < 20) throw new CloudflareError("Cloudflare gave no key for the tunnel");
    return payload.result;
  }

  async function tunnel(accountId, tunnelId) {
    const payload = await call("GET", `/accounts/${segment(accountId)}/cfd_tunnel/${segment(tunnelId)}`, { what: "reading the tunnel" });
    if (!isObject(payload.result)) throw new CloudflareError("Cloudflare did not describe the tunnel");
    return describeTunnel(payload.result);
  }

  /** The tunnel's configuration as Cloudflare keeps it, and its routes (empty when it has none). */
  async function configuration(accountId, tunnelId) {
    const payload = await call("GET", `/accounts/${segment(accountId)}/cfd_tunnel/${segment(tunnelId)}/configurations`, { what: "reading the tunnel's routes" });
    const config = isObject(payload.result?.config) ? payload.result.config : {};
    return { config, ingress: Array.isArray(config.ingress) ? config.ingress.filter(isObject) : [] };
  }

  async function setConfiguration(accountId, tunnelId, config) {
    await call("PUT", `/accounts/${segment(accountId)}/cfd_tunnel/${segment(tunnelId)}/configurations`, { body: { config }, what: "changing the tunnel's routes" });
  }

  async function dnsRecords(zoneId, name) {
    const payload = await call("GET", `/zones/${segment(zoneId)}/dns_records`, { query: { name }, what: `looking up ${name}` });
    return (Array.isArray(payload.result) ? payload.result : []).filter((record) => isObject(record) && typeof record.id === "string" && sameName(record.name, name))
      .map((record) => ({ id: record.id, type: String(record.type ?? ""), name: record.name, content: String(record.content ?? ""), proxied: record.proxied === true }));
  }

  async function createCname(zoneId, { name, target, comment }) {
    const payload = await call("POST", `/zones/${segment(zoneId)}/dns_records`, { body: { type: "CNAME", name, content: target, proxied: true, comment }, what: `adding ${name} to your domain` });
    if (!isObject(payload.result) || typeof payload.result.id !== "string") throw new CloudflareError(`Cloudflare did not add ${name}`);
    return { id: payload.result.id, type: "CNAME", name, content: target, proxied: true };
  }

  async function deleteDnsRecord(zoneId, recordId) {
    await call("DELETE", `/zones/${segment(zoneId)}/dns_records/${segment(recordId)}`, { what: "removing the name from your domain" });
  }

  return { listZones, findTunnel, createTunnel, tunnelRunKey, tunnel, configuration, setConfiguration, dnsRecords, createCname, deleteDnsRecord };
}

/** The last rule, which every tunnel's routes end with: no name, no path. */
const isCatchAll = (rule) => !rule?.hostname && !rule?.path;
/** One of BoxPilot's rules for this name: the whole name, no path. */
const isRuleFor = (rule, hostname) => sameName(rule?.hostname, hostname) && !rule?.path;

function split(ingress) {
  const rules = (Array.isArray(ingress) ? ingress : []).filter(isObject);
  // The owner's own catch-all is kept (they may answer with something other than 404); one is added if there is none.
  const catchAll = [...rules].reverse().find(isCatchAll) ?? { service: catchAllService };
  return { rules: rules.filter((rule) => !isCatchAll(rule)), catchAll };
}

/**
 * The routes with this name sent to `service`: a rule for the same name is replaced where it stood,
 * otherwise the new one goes last; every other rule stays as it is, in its order, and the catch-all
 * is last, as Cloudflare requires.
 */
export function withRoute(ingress, { hostname, service, originRequest = {} }) {
  const { rules, catchAll } = split(ingress);
  const ours = { hostname, service, originRequest };
  const at = rules.findIndex((rule) => isRuleFor(rule, hostname));
  const next = at < 0 ? [...rules, ours] : rules.flatMap((rule, index) => (index === at ? [ours] : isRuleFor(rule, hostname) ? [] : [rule]));
  return [...next, catchAll];
}

/** The routes without this name's rule; everything else as it was, the catch-all last. */
export function withoutRoute(ingress, hostname) {
  const { rules, catchAll } = split(ingress);
  return [...rules.filter((rule) => !isRuleFor(rule, hostname)), catchAll];
}

/** The names a tunnel's routes answer for. */
export const routeNames = (ingress) => (Array.isArray(ingress) ? ingress : []).filter((rule) => isObject(rule) && typeof rule.hostname === "string" && rule.hostname).map((rule) => rule.hostname.toLowerCase());
