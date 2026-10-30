/**
 * Publishing an app to the internet through Cloudflare Tunnel (M42, ADR-011): what the helper and
 * the root tasks share. The owner pastes a Cloudflare API token once; BoxPilot makes (or finds) one
 * remotely managed tunnel for this server, runs it in the catalog's Cloudflare Tunnel app, and adds
 * or removes one public name per app on request. Cloudflare Access (a login in front) is not here yet.
 *
 * Two credentials, both in the root-only store and never in a log, a job record, a result or the
 * state file: the owner's API token, which only the tasks in server/tasks/cloudflare.mjs read (they
 * have the network the helper does not), and the tunnel's run token, which the helper hands to the
 * Cloudflare Tunnel app as its TUNNEL_TOKEN.
 *
 * The state file says what BoxPilot made: the account, the tunnel, the domains the token covers, and
 * each name it published with the DNS record it made for it. It is root-only (0600) beside the
 * credential store. Unpublishing touches only what is recorded here, so a name or a record the
 * owner made in the Cloudflare dashboard is never removed by BoxPilot.
 */
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { writeFileDurably } from "./durable-file.mjs";

export const cloudflareApiCredential = "cloudflare-api-token";
export const cloudflareTunnelCredential = "cloudflare-tunnel-token";
/** The catalog app that runs the tunnel (catalog/cloudflared.yaml). */
export const tunnelAppId = "cloudflared";
export const defaultTunnelStateFile = process.env.BOXPILOT_CLOUDFLARE_STATE ?? "/var/lib/boxpilot-managed/cloudflare-tunnel.json";

/** One DNS label: the part before the domain, never the domain itself (the apex). */
export const dnsLabelPattern = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
/** A domain or a full name under one: lower-case labels joined by dots, at least two of them. */
export const hostnamePattern = /^(?=.{3,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
/** Where a published app is sent: always this server's loopback address, since the tunnel app shares the host's network. */
export const servicePattern = /^https?:\/\/127\.0\.0\.1:\d{1,5}$/;
/** The name BoxPilot gives the tunnel it makes. */
export const tunnelNamePattern = /^boxpilot-[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;

/** The tunnel's name for a server: boxpilot-<its host name>, made safe for Cloudflare. */
export function tunnelNameFor(hostname) {
  const safe = String(hostname ?? "").toLowerCase().split(".")[0].replace(/[^a-z0-9-]+/g, "-").replace(/-{2,}/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/, "");
  return `boxpilot-${safe || "server"}`;
}

/** Where a CNAME for a name in this tunnel points. */
export const tunnelTargetFor = (tunnelId) => `${tunnelId}.cfargotunnel.com`;
export const sameName = (a, b) => typeof a === "string" && typeof b === "string" && a.replace(/\.$/, "").toLowerCase() === b.replace(/\.$/, "").toLowerCase();

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value, limit = 253) => (typeof value === "string" && value.length && value.length <= limit ? value : null);

/** The state as read, with anything malformed in it dropped rather than trusted. */
export function normalizeTunnelState(raw) {
  if (!isObject(raw)) return null;
  const zones = (Array.isArray(raw.zones) ? raw.zones : []).filter((zone) => isObject(zone) && text(zone.id, 64) && text(zone.name)).map((zone) => ({ id: zone.id, name: zone.name }));
  const routes = (Array.isArray(raw.routes) ? raw.routes : []).filter((route) => isObject(route) && text(route.hostname) && text(route.zoneId, 64)).map((route) => ({
    hostname: route.hostname,
    zoneId: route.zoneId,
    dnsRecordId: text(route.dnsRecordId, 64),
    appId: text(route.appId, 64),
    portId: text(route.portId, 64),
    hostPort: Number.isInteger(route.hostPort) ? route.hostPort : null,
    service: text(route.service, 64),
    publishedAt: text(route.publishedAt, 40),
  }));
  return {
    accountId: text(raw.accountId, 64),
    accountName: text(raw.accountName, 200),
    tunnelId: text(raw.tunnelId, 64),
    tunnelName: text(raw.tunnelName, 64),
    zones,
    routes,
    connectedAt: text(raw.connectedAt, 40),
  };
}

/**
 * The state file: read (null when there is none yet) and written whole, synced and renamed into
 * place so a power cut never leaves half of it. A file that cannot be read is an error, not "not
 * connected": writing over it would forget every name BoxPilot published.
 */
export function createTunnelStateStore({ file = defaultTunnelStateFile } = {}) {
  async function read() {
    let raw;
    try {
      raw = await readFile(file, "utf8");
    } catch (error) {
      if (error?.code === "ENOENT") return null;
      throw new Error(`BoxPilot's Cloudflare record could not be read (${error?.code ?? "error"})`);
    }
    let parsed = null;
    try { parsed = JSON.parse(raw); } catch { parsed = null; }
    const state = normalizeTunnelState(parsed);
    if (!state) throw new Error(`BoxPilot's Cloudflare record (${file}) is damaged; connect Cloudflare again to write it afresh`);
    return state;
  }

  async function write(state) {
    const clean = normalizeTunnelState(state);
    if (!clean) throw new Error("Refusing to write an empty Cloudflare record");
    await mkdir(path.dirname(file), { recursive: true, mode: 0o755 });
    await writeFileDurably(file, `${JSON.stringify(clean, null, 2)}\n`, { mode: 0o600 });
    return clean;
  }

  return { file, read, write };
}
