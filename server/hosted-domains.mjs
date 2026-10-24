/**
 * Hosted domains (M42.2): every public name this server answers for, and whether it does right now.
 *
 * The names come from what BoxPilot already knows: the routes it published through the Cloudflare
 * tunnel (its own record), a hand-made cloudflared config and Nginx Proxy Manager's site files (read
 * by the helper), installed apps whose manifest says which setting holds their public address, and
 * names the owner typed in because nothing else could find them. For each: does it resolve, and to
 * Cloudflare when it should; does it answer from the internet's side, with what certificate; does
 * the app answer on this server where the tunnel sends visitors; is the Cloudflare Tunnel app up;
 * and is the app behind it backed up. One verdict per name, in words, with what to do.
 *
 * Checks run in the web process on a cadence the owner sets, like the release check and the health
 * round; the probes are server/hosted-domains-probes.mjs. A name down twice running, or a
 * certificate inside its last fortnight, goes through the health-alert ledger (one push, one
 * "resolved"). Everything here is pure except the service at the bottom, so the judgement is tested
 * without a network, and the service with probes a test hands it.
 */
import os from "node:os";
import { isIP } from "node:net";
import { hostnamePattern } from "./cloudflare-tunnel.mjs";
import { defaultProbes } from "./hosted-domains-probes.mjs";

export const settingKey = "hostedDomains";
export const historyKey = "hostedDomainsHistory";
export const snapshotKey = "hostedDomainsLast";
/** How often the names are checked, in minutes; the owner picks one on the page. */
export const intervalChoices = Object.freeze([5, 15, 30, 60]);
export const defaultIntervalMinutes = 15;
/** A certificate this close to its end is said, and pushed once (the task's fourteen days). */
export const certificateWarningDays = 14;
export const alertFamilies = Object.freeze({ down: "hosted.down", certificate: "hosted.cert" });
/** Seven days of checks at the shortest cadence, with a little room; older samples go. */
export const sampleLimit = 2200;
export const sampleMaxAgeMs = 7 * 24 * 3600_000;
export const manualLimit = 64;
/** The catalog's Cloudflare Tunnel app, which holds the tunnel up (cloudflare-tunnel.mjs says so too). */
const tunnelAppId = "cloudflared";
/** Where a manually added name is answered on this server: this server's own loopback, as the tunnel reaches apps. */
export const manualServicePattern = /^https?:\/\/(?:127\.0\.0\.1|localhost)(?::\d{1,5})?$/;
const appIdPattern = /^[a-z0-9][a-z0-9-]{1,62}$/;
const labelLimit = 80;
/** Names that are never on the internet, however a manifest's setting is filled in. */
const localSuffixes = [".lan", ".local", ".localhost", ".home.arpa", ".internal", ".ts.net", ".home", ".localdomain"];

const lower = (value) => String(value ?? "").trim().toLowerCase().replace(/\.$/, "");
const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

/** Whether a name is one the internet could know: a real hostname, not an address, not a house name. */
export function isPublicName(hostname) {
  const name = lower(hostname);
  if (!hostnamePattern.test(name) || isIP(name)) return false;
  return !localSuffixes.some((suffix) => name.endsWith(suffix));
}

/**
 * The public name in an app's setting: a URL (`https://notes.example.com/`), a bare name, or a
 * list of either (Nextcloud's trusted domains), of which the first public one is taken.
 */
export function publicHostnameOf(value) {
  if (typeof value !== "string") return null;
  for (const token of value.split(/[\s,]+/).map((part) => part.trim()).filter(Boolean)) {
    let candidate = token;
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(token)) {
      try { candidate = new URL(token).hostname; } catch { continue; }
    } else {
      candidate = token.split("/")[0].split(":")[0];
    }
    if (isPublicName(candidate)) return lower(candidate);
  }
  return null;
}

/** The port a loopback service address names, or null. */
function portOf(service) {
  try {
    const url = new URL(service);
    if (!["http:", "https:"].includes(url.protocol)) return null;
    const port = url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80;
    return { port, loopback: ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) };
  } catch { return null; }
}

/** An installed app's web port on this server, as the tunnel would reach it. */
function webPortOf(app) {
  const published = Array.isArray(app?.published) ? app.published : [];
  const port = published.find((entry) => entry.web && entry.protocol !== "udp") ?? published.find((entry) => entry.protocol !== "udp") ?? null;
  if (port && Number.isInteger(port.host)) return port.host;
  const url = Array.isArray(app?.urls) ? app.urls[0] : null;
  return url && Number.isInteger(url.host) ? url.host : null;
}

/** The installed app listening on this host port, when exactly one does. */
function appByPort(apps, port) {
  if (!Number.isInteger(port)) return null;
  const matches = apps.filter((app) => app?.installed && (Array.isArray(app.published) ? app.published : []).some((entry) => entry.host === port && entry.protocol !== "udp"));
  return matches.length === 1 ? matches[0] : null;
}

/** The names and what BoxPilot keeps about them, as the setting holds them; anything malformed dropped. */
export function normalizeSettings(raw) {
  const intervalMinutes = intervalChoices.includes(raw?.intervalMinutes) ? raw.intervalMinutes : defaultIntervalMinutes;
  const manual = [];
  const seen = new Set();
  for (const entry of Array.isArray(raw?.manual) ? raw.manual : []) {
    if (!isObject(entry)) continue;
    const hostname = lower(entry.hostname);
    if (!isPublicName(hostname) || seen.has(hostname)) continue;
    seen.add(hostname);
    manual.push({
      hostname,
      service: typeof entry.service === "string" && manualServicePattern.test(entry.service) ? entry.service : null,
      appId: typeof entry.appId === "string" && appIdPattern.test(entry.appId) ? entry.appId : null,
      label: typeof entry.label === "string" && entry.label.trim() ? entry.label.trim().slice(0, labelLimit) : null,
      expectedAddress: typeof entry.expectedAddress === "string" && isIP(entry.expectedAddress) ? entry.expectedAddress : null,
      addedAt: typeof entry.addedAt === "string" ? entry.addedAt : null,
      addedBy: typeof entry.addedBy === "string" ? entry.addedBy : null,
    });
    if (manual.length >= manualLimit) break;
  }
  return { intervalMinutes, manual };
}

/**
 * A name the owner typed, checked before it is kept: a public name, a loopback address for where it
 * is answered here (optional), an installed app it belongs to (optional), a few words, and the
 * address it should resolve to when it is not behind Cloudflare (optional). Throws with the words.
 */
export function validateManualEntry(raw) {
  if (!isObject(raw) || typeof raw.hostname !== "string") throw invalid("Say which name to watch");
  const hostname = lower(raw.hostname);
  if (!hostname) throw invalid("Say which name to watch");
  if (!hostnamePattern.test(hostname)) throw invalid(`${hostname.slice(0, 80)} is not a name on the internet: lower-case letters, digits and hyphens, with at least one dot`);
  if (!isPublicName(hostname)) throw invalid(`${hostname} is a name for your own network, not one the internet can reach`);
  const service = raw.service === undefined || raw.service === null || raw.service === "" ? null : raw.service;
  if (service !== null && !(typeof service === "string" && manualServicePattern.test(service))) throw invalid("Where it is answered on this server must be http://127.0.0.1:<port> (or https)");
  const appId = raw.appId === undefined || raw.appId === null || raw.appId === "" ? null : raw.appId;
  if (appId !== null && !(typeof appId === "string" && appIdPattern.test(appId))) throw invalid("The app must be one from the catalog");
  const label = raw.label === undefined || raw.label === null || raw.label === "" ? null : raw.label;
  if (label !== null && !(typeof label === "string" && label.trim().length <= labelLimit && !/[\r\n]/.test(label))) throw invalid(`A label is at most ${labelLimit} characters on one line`);
  const expectedAddress = raw.expectedAddress === undefined || raw.expectedAddress === null || raw.expectedAddress === "" ? null : raw.expectedAddress;
  if (expectedAddress !== null && !(typeof expectedAddress === "string" && isIP(expectedAddress))) throw invalid("The address it should resolve to must be an IP address");
  return { hostname, service, appId, label: label ? label.trim() : null, expectedAddress };
}

function invalid(message) {
  return Object.assign(new Error(message), { code: "invalid_domain" });
}

/**
 * Every public name this server serves, from every source BoxPilot has, one entry per name. The
 * first source to name it decides what it is; later ones add what the first did not know (the app,
 * the service). Order: BoxPilot's own tunnel record, a hand-made cloudflared config, the proxy
 * manager's sites, apps that say their public address, then the owner's own list.
 *
 * @param {{ tunnel?: any, apps?: any[], manifests?: any[], sources?: { cloudflared?: any[], proxyHosts?: any[] } | null, manual?: any[] }} facts
 */
export function discoverDomains({ tunnel = null, apps = [], manifests = [], sources = null, manual = [] } = {}) {
  const byId = new Map(apps.filter((app) => app && typeof app.id === "string").map((app) => [app.id, app]));
  const names = new Map(manifests.filter((manifest) => manifest && typeof manifest.id === "string").map((manifest) => [manifest.id, manifest.name ?? manifest.id]));
  const tunnelApp = byId.get(tunnelAppId) ?? null;
  const hasTunnel = Boolean(tunnel?.tunnel?.id) || Boolean(tunnelApp?.installed) || (sources?.cloudflared ?? []).length > 0;
  /** @type {Map<string, any>} */
  const found = new Map();
  const add = (hostname, source, { appId = null, service = null, expect = null, expectedAddress = null, label = null, wildcard = false } = {}) => {
    const name = lower(hostname);
    if (!name) return;
    const current = found.get(name);
    if (current) {
      if (!current.sources.includes(source)) current.sources.push(source);
      current.appId ??= appId;
      current.service ??= service;
      current.expect ??= expect;
      current.expectedAddress ??= expectedAddress;
      current.label ??= label;
      return;
    }
    found.set(name, { hostname: name, sources: [source], appId, service, expect, expectedAddress, label, wildcard });
  };

  for (const route of Array.isArray(tunnel?.routes) ? tunnel.routes : []) {
    if (!isObject(route) || typeof route.hostname !== "string" || !hostnamePattern.test(lower(route.hostname))) continue;
    const service = typeof route.service === "string" ? route.service : Number.isInteger(route.hostPort) ? `http://127.0.0.1:${route.hostPort}` : null;
    add(route.hostname, "tunnel", { appId: typeof route.appId === "string" ? route.appId : null, service, expect: "cloudflare" });
  }
  for (const config of sources?.cloudflared ?? []) {
    for (const rule of Array.isArray(config?.ingress) ? config.ingress : []) {
      if (!isObject(rule) || typeof rule.hostname !== "string") continue;
      const target = portOf(rule.service);
      const app = target?.loopback ? appByPort(apps, target.port) : null;
      add(rule.hostname, "cloudflared-config", { appId: app?.id ?? null, service: target?.loopback ? rule.service : null, expect: "cloudflare", wildcard: Boolean(rule.wildcard) });
    }
  }
  for (const site of sources?.proxyHosts ?? []) {
    if (!isObject(site)) continue;
    const target = typeof site.target === "string" ? portOf(site.target) : null;
    const app = target?.loopback ? appByPort(apps, target.port) : null;
    for (const hostname of Array.isArray(site.hostnames) ? site.hostnames : []) {
      if (typeof hostname !== "string") continue;
      add(hostname, "proxy", { appId: app?.id ?? null, service: target?.loopback ? site.target : null, expect: hasTunnel ? "cloudflare" : "any", wildcard: String(hostname).startsWith("*.") });
    }
  }
  for (const manifest of manifests) {
    const env = manifest?.publicHostname?.env;
    if (typeof env !== "string") continue;
    const app = byId.get(manifest.id);
    if (!app?.installed) continue;
    const hostname = publicHostnameOf(app.state?.values?.env?.[env]);
    if (!hostname) continue;
    const port = webPortOf(app);
    add(hostname, "catalog", { appId: manifest.id, service: port ? `http://127.0.0.1:${port}` : null, expect: hasTunnel ? "cloudflare" : "any" });
  }
  for (const entry of manual) {
    if (!isObject(entry) || typeof entry.hostname !== "string") continue;
    const app = entry.appId ? byId.get(entry.appId) : null;
    const port = app ? webPortOf(app) : null;
    add(entry.hostname, "manual", { appId: entry.appId ?? null, service: entry.service ?? (port ? `http://127.0.0.1:${port}` : null), expect: entry.expectedAddress ? "address" : hasTunnel ? "cloudflare" : "any", expectedAddress: entry.expectedAddress ?? null, label: entry.label ?? null });
  }

  return [...found.values()].map((domain) => {
    const app = domain.appId ? byId.get(domain.appId) ?? null : null;
    return {
      ...domain,
      expect: domain.expect ?? "any",
      appName: domain.appId ? names.get(domain.appId) ?? app?.name ?? domain.appId : null,
      app: app ? { installed: Boolean(app.installed), running: app.installed ? Boolean(app.container?.running) && app.container?.status !== "paused" : null } : domain.appId ? { installed: false, running: null } : null,
      manual: domain.sources.includes("manual"),
    };
  });
}

/**
 * What the Cloudflare Tunnel app's log says about its connections: cloudflared registers one
 * connection per Cloudflare location ("Registered tunnel connection connIndex=0 ...") and says when
 * one goes ("Unregistered tunnel connection connIndex=0"). The live ones, and since when.
 */
export function tunnelFromLog(lines = []) {
  /** @type {Map<string, string | null>} */
  const live = new Map();
  let lastProblem = null;
  for (const raw of Array.isArray(lines) ? lines : []) {
    const line = String(raw ?? "");
    const stamp = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)/.exec(line)?.[1] ?? null;
    const index = /connIndex=(\d+)/.exec(line)?.[1] ?? null;
    if (/Registered tunnel connection/.test(line) && index !== null) live.set(index, stamp);
    else if (/Unregistered tunnel connection/.test(line) && index !== null) live.delete(index);
    else if (/\b(ERR|WRN)\b/.test(line)) lastProblem = line.replace(/^\S+\s+(ERR|WRN)\s+/, "").slice(0, 200);
  }
  const stamps = [...live.values()].filter(Boolean).sort();
  return { connections: live.size, since: stamps[0] ?? null, lastProblem };
}

/** Whether a public name ever counted as reachable from the internet, over the last day and week. */
export function uptimeOf(samples, now = Date.now()) {
  const list = Array.isArray(samples) ? samples : [];
  const over = (ms) => {
    const recent = list.filter((sample) => Array.isArray(sample) && Number.isFinite(sample[0]) && now - sample[0] <= ms);
    if (!recent.length) return null;
    return Math.round((recent.filter((sample) => sample[1] === 1).length / recent.length) * 1000) / 10;
  };
  return { day: over(24 * 3600_000), week: over(sampleMaxAgeMs), checks: list.length };
}

/** The history with one more check in it, no older than a week and no longer than the limit. */
export function foldSample(samples, sample, now = Date.now()) {
  const kept = (Array.isArray(samples) ? samples : []).filter((entry) => Array.isArray(entry) && Number.isFinite(entry[0]) && now - entry[0] <= sampleMaxAgeMs);
  kept.push(sample);
  return kept.slice(-sampleLimit);
}

/**
 * How the app behind a name is backed up, from the helper's protection read and the schedules:
 * never, stale (nothing for a fortnight), ok, or none (it keeps no data worth a backup).
 */
export function backupStateOf(appId, protection, schedules = [], { now = Date.now(), staleAfterDays = 14 } = {}) {
  if (!appId) return null;
  if (!protection || protection.available === false || !Array.isArray(protection.apps)) return { state: "unknown", newestAt: null, scheduled: false, backups: 0 };
  const app = protection.apps.find((entry) => entry?.id === appId);
  const scheduled = (Array.isArray(schedules) ? schedules : []).some((schedule) => schedule?.operationId === "app.backup" && schedule.enabled !== false && (schedule.parameters?.id === appId || schedule.parameters?.subject === appId));
  if (!app || app.protectable === false) return { state: "none", newestAt: null, scheduled, backups: app?.backups ?? 0 };
  const newestAt = typeof app.newestAt === "string" ? app.newestAt : null;
  if (!app.backups || !newestAt) return { state: "never", newestAt: null, scheduled, backups: 0 };
  const ageDays = (now - Date.parse(newestAt)) / 86_400_000;
  return { state: ageDays > staleAfterDays ? "stale" : "ok", newestAt, scheduled, backups: app.backups };
}

const list = (addresses) => (Array.isArray(addresses) && addresses.length ? addresses.slice(0, 4).join(", ") : "nothing");
const plural = (count, word) => `${count} ${word}${count === 1 ? "" : "s"}`;

/**
 * One name's verdict from its checks: up, degraded (answers, but something needs a look) or down,
 * the headline in a few words, and what to do, said plainly. Pure.
 *
 * @param {{ hostname: string, appId?: string | null, appName?: string | null, service?: string | null, expect?: string, expectedAddress?: string | null, wildcard?: boolean }} domain
 * @param {{ dns?: any, certificate?: any, outside?: any, inside?: any, tunnel?: any, app?: any }} checks
 */
export function judgeDomain(domain, checks = {}, { now = new Date() } = {}) {
  const name = domain.hostname;
  const appName = domain.appName ?? domain.appId ?? "the app";
  const viaTunnel = domain.expect === "cloudflare";
  if (domain.wildcard) return { state: "unknown", headline: "Wildcard", advice: `${name} covers every name under it, so there is no one address to check. Add the names you actually use to watch them.`, problems: [] };

  /** @type {Array<{ severity: "down" | "degraded", text: string, advice: string }>} */
  const problems = [];
  const { dns = null, certificate = null, outside = null, inside = null, tunnel = null, app = null } = checks;
  const tunnelAdvice = tunnel?.installed && !tunnel.running
    ? "The Cloudflare Tunnel app is not running on this server, so Cloudflare has nowhere to send visitors. Start it from its Overview tab in the App catalog."
    : tunnel?.installed && tunnel.connections === 0
      ? "The Cloudflare Tunnel app is running but holds no connection to Cloudflare; its Logs on the App catalog page say why (the tunnel's token, or no way out to the internet)."
      : "Cloudflare could not reach the tunnel on this server. Check the Cloudflare Tunnel app is running and connected (its Logs on the App catalog page), and that this server has a way out to the internet.";

  if (!dns || !dns.resolved) {
    problems.push({ severity: "down", text: "does not resolve", advice: `${name} has no address in DNS, so nobody can reach it. ${viaTunnel ? "In Cloudflare's DNS it needs a proxied CNAME to the tunnel; publishing the app from the Cloudflare Tunnel app's Tunnel tab adds one." : "Add an A or CNAME record for it at your DNS provider."}` });
  } else if (dns.private) {
    problems.push({ severity: "degraded", text: "resolves to a private address", advice: `${name} resolves to ${list(dns.addresses)}, an address inside your network, so visitors on the internet cannot reach it and BoxPilot did not try. Point it at Cloudflare instead: a proxied CNAME to the tunnel.` });
  } else if (viaTunnel && !dns.viaCloudflare) {
    problems.push({ severity: "degraded", text: "not pointed at Cloudflare", advice: `${name} resolves to ${list(dns.addresses)} rather than to Cloudflare, so visitors go around the tunnel. In Cloudflare's DNS make its record a proxied CNAME to the tunnel (the orange cloud on).` });
  } else if (domain.expect === "address" && domain.expectedAddress && !dns.addresses.includes(domain.expectedAddress)) {
    problems.push({ severity: "degraded", text: "resolves elsewhere", advice: `${name} resolves to ${list(dns.addresses)} rather than ${domain.expectedAddress}, the address you expected. Check its DNS record.` });
  }

  const probed = outside && !outside.skipped;
  const answered = probed && outside.outcome === "answered";
  const status = answered ? outside.status ?? 0 : null;
  const healthy = answered && (status < 400 || status === 401 || status === 403);
  if (probed && !answered) {
    problems.push({ severity: "down", text: outside.outcome === "timeout" ? "no answer from the internet" : "unreachable from the internet", advice: `Asked from this server by its public name, ${name} ${outside.outcome === "timeout" ? "did not answer in time" : `could not be reached (${outside.error ?? "connection failed"})`}. ${viaTunnel ? tunnelAdvice : "Check the server it points at and the port forwarding or proxy in front of it."}` });
  } else if (answered && status >= 520 && status <= 530) {
    problems.push({ severity: "down", text: `Cloudflare cannot reach this server (HTTP ${status})`, advice: `Cloudflare answered for ${name} with HTTP ${status}, which means it could not get an answer from this server. ${tunnelAdvice}` });
  } else if (answered && status >= 500) {
    problems.push({ severity: "down", text: `answers with an error (HTTP ${status})`, advice: `${appName} answered visitors with HTTP ${status}. Open its Logs on the App catalog page; a restart from there often clears it.` });
  } else if (answered && status === 404) {
    problems.push({ severity: "degraded", text: "answers HTTP 404", advice: `${name} answers, but ${appName} says its front page does not exist. A tunnel route or proxy pointed at the wrong port on this server looks like this; check where ${name} is sent.` });
  } else if (answered && status >= 400 && status !== 401 && status !== 403) {
    problems.push({ severity: "degraded", text: `answers HTTP ${status}`, advice: `${name} answers, but with HTTP ${status} rather than a page. Open it in a browser to see what ${appName} says.` });
  }

  if (viaTunnel && tunnel?.installed && !tunnel.running) {
    problems.push({ severity: healthy ? "degraded" : "down", text: "the tunnel app is not running", advice: healthy ? `${name} still answers (Cloudflare serves a cached copy), but the Cloudflare Tunnel app is not running here, so anything not cached fails. Start it from its Overview tab in the App catalog.` : tunnelAdvice });
  } else if (viaTunnel && tunnel?.installed && tunnel.running && tunnel.connections === 0 && !healthy && !problems.some((problem) => problem.advice === tunnelAdvice)) {
    problems.push({ severity: "down", text: "the tunnel is not connected", advice: tunnelAdvice });
  }

  if (app?.installed && app.running === false) {
    problems.push({ severity: healthy ? "degraded" : "down", text: `${appName} is not running`, advice: `${appName} is stopped on this server${healthy ? ", so visitors get whatever Cloudflare cached and nothing more" : ", so there is nothing to show visitors"}. Start it from the App catalog.` });
  } else if (app && !app.installed && domain.appId) {
    problems.push({ severity: healthy ? "degraded" : "down", text: `${appName} is not installed`, advice: `${name} is set up to reach ${appName}, which is not installed on this server any more. Install it again, or stop publishing the name.` });
  }

  if (inside && inside.outcome !== "answered") {
    problems.push({ severity: healthy ? "degraded" : "down", text: `${appName} does not answer on this server`, advice: `BoxPilot asked ${domain.service} on this server itself, where the tunnel sends visitors, and got ${inside.error ?? "no answer"}. ${appName} may be starting, stopped or listening on another port.` });
  } else if (inside && (inside.status ?? 0) >= 500) {
    problems.push({ severity: "degraded", text: `${appName} answers with an error here (HTTP ${inside.status})`, advice: `Asked directly on this server, ${appName} answered HTTP ${inside.status}. Its Logs on the App catalog page say why.` });
  }

  if (certificate?.validTo) {
    const daysLeft = Math.floor((Date.parse(certificate.validTo) - now.getTime()) / 86_400_000);
    const ends = new Date(certificate.validTo).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
    if (daysLeft < 0) problems.push({ severity: "down", text: "certificate expired", advice: `The certificate ${name} shows expired on ${ends}; browsers refuse the page. ${viaTunnel ? "Cloudflare normally renews it on its own: check the name is still proxied (orange cloud) in Cloudflare's DNS." : "Renew it where it was issued."}` });
    else if (daysLeft <= certificateWarningDays) problems.push({ severity: "degraded", text: `certificate expires in ${plural(daysLeft, "day")}`, advice: `The certificate ${name} shows ends on ${ends}. ${viaTunnel ? "Cloudflare renews the one it serves on its own, usually inside the last two weeks; if the days keep falling, check the name is still proxied (orange cloud) in Cloudflare's DNS." : "Renew it before then."}` });
    if (certificate.authorized === false) problems.push({ severity: "degraded", text: "certificate not trusted", advice: `The certificate ${name} shows is not one browsers trust (${certificate.authorizationError ?? "it does not verify"}), so visitors see a warning first.` });
  }

  const state = problems.some((problem) => problem.severity === "down") ? "down" : problems.length ? "degraded" : "up";
  const first = problems.find((problem) => problem.severity === state) ?? problems[0] ?? null;
  const headline = state === "up" ? "Up" : first.text.charAt(0).toUpperCase() + first.text.slice(1);
  return { state, headline, advice: problems.length ? problems.map((problem) => problem.advice).join(" ") : null, problems: problems.map((problem) => problem.text) };
}

/** A pool of `width` at a time over `items`, in order of starting. */
async function eachLimited(items, width, work) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(width, items.length) }, async () => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await work(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * The service: reads the names, runs the checks on the owner's cadence, keeps the last verdicts and
 * a week of samples, and raises and clears the two alerts. `helper` and `catalog` are optional (a
 * test, or the demo, has neither); `probes` are the network's hands, replaced by a test.
 *
 * @param {{ store: any, helper?: any, catalog?: any, alerts?: any, notifications?: any, probes?: { resolve: Function, probe: Function }, now?: () => Date,
 *   initialDelayMs?: number, tickMs?: number, probeTimeoutMs?: number, concurrency?: number, hostname?: () => string,
 *   setTimeout?: typeof globalThis.setTimeout, setInterval?: typeof globalThis.setInterval, clearTimeout?: typeof globalThis.clearTimeout, clearInterval?: typeof globalThis.clearInterval }} options
 */
export function createHostedDomainsService({ store, helper = null, catalog = null, alerts = null, notifications = null, probes = defaultProbes, now = () => new Date(), initialDelayMs = 90_000, tickMs = 60_000, probeTimeoutMs = 10_000, concurrency = 6, hostname = () => os.hostname(), setTimeout: delay = globalThis.setTimeout, setInterval: schedule = globalThis.setInterval, clearTimeout: cancel = globalThis.clearTimeout, clearInterval: unschedule = globalThis.clearInterval }) {
  /** @type {Promise<any> | null} */
  let inflight = null;
  /** @type {Map<string, number>} how many checks running a name has been down, for the flap guard. */
  const downStreak = new Map();
  let dueAt = null;
  let lastRunAt = null;

  const settings = () => normalizeSettings(store.getSetting(settingKey, null));
  const writeSettings = (value, updatedBy) => store.setSetting(settingKey, value, { updatedBy });
  const readHistory = () => { const raw = store.getSetting(historyKey, {}); return isObject(raw) ? raw : {}; };
  const lastSnapshot = () => { const raw = store.getSetting(snapshotKey, null); return isObject(raw) ? raw : null; };
  const ask = (operation, parameters = {}, timeoutMs = 30_000) => (helper ? Promise.resolve(helper.request(operation, parameters, { timeoutMs })).catch(() => null) : Promise.resolve(null));

  /** Everything the checks start from, read in one go. A source that fails is simply absent. */
  async function gather() {
    const [tunnel, live, sources, protection, catalogRead] = await Promise.all([
      ask("cloudflare.tunnel.inspect"),
      ask("app.inspect", {}, 60_000),
      ask("hosted-domains.sources"),
      ask("app.backup.protection", {}, 60_000),
      catalog ? Promise.resolve(catalog.all()).catch(() => ({ manifests: [] })) : Promise.resolve({ manifests: [] }),
    ]);
    const apps = Array.isArray(live?.applications) ? live.applications : [];
    const manifests = Array.isArray(catalogRead?.manifests) ? catalogRead.manifests : [];
    const tunnelApp = apps.find((app) => app?.id === tunnelAppId) ?? null;
    const tunnelRunning = Boolean(tunnelApp?.installed) && Boolean(tunnelApp?.container?.running) && tunnelApp?.container?.status !== "paused";
    const log = tunnelRunning ? await ask("app.logs", { id: tunnelAppId, lines: 300 }, 60_000) : null;
    const fromLog = log && Array.isArray(log.lines) ? tunnelFromLog(log.lines) : null;
    const tunnelFacts = {
      installed: Boolean(tunnelApp?.installed),
      running: tunnelRunning,
      status: tunnelApp?.container?.status ?? null,
      since: fromLog?.since ?? (tunnelRunning && typeof tunnelApp?.container?.startedAt === "string" ? tunnelApp.container.startedAt : null),
      connections: fromLog ? fromLog.connections : null,
      lastProblem: fromLog?.lastProblem ?? null,
      cloudflare: tunnel ? { connected: Boolean(tunnel.connected), tunnelName: tunnel.tunnel?.name ?? null } : null,
    };
    const { manual } = settings();
    const domains = discoverDomains({ tunnel, apps, manifests, sources, manual });
    return { domains, tunnel: tunnelFacts, protection, schedules: typeof store.listSchedules === "function" ? store.listSchedules() : [] };
  }

  /** One name's checks, each with its own deadline, and its verdict. */
  async function checkOne(domain, facts, at) {
    const url = `https://${domain.hostname}/`;
    const dns = domain.wildcard ? null : await Promise.resolve(probes.resolve(domain.hostname, { timeoutMs: Math.min(probeTimeoutMs, 5000) })).catch((error) => ({ resolved: false, addresses: [], viaCloudflare: false, private: false, error: error?.message ?? "lookup failed" }));
    const skipped = domain.wildcard ? "wildcard" : !dns?.resolved ? "does not resolve" : dns.private ? "resolves to a private address" : null;
    const [outsideRaw, insideRaw] = await Promise.all([
      skipped ? Promise.resolve(null) : Promise.resolve(probes.probe({ url, timeoutMs: probeTimeoutMs })).catch((error) => ({ outcome: "error", status: null, ms: null, server: null, tls: null, error: error?.message ?? "probe failed" })),
      domain.service && portOf(domain.service)?.loopback ? Promise.resolve(probes.probe({ url: domain.service, hostHeader: domain.hostname, timeoutMs: probeTimeoutMs })).catch((error) => ({ outcome: "error", status: null, ms: null, server: null, tls: null, error: error?.message ?? "probe failed" })) : Promise.resolve(null),
    ]);
    const outside = skipped ? { outcome: "skipped", status: null, ms: null, server: null, error: null, skipped } : outsideRaw ? { outcome: outsideRaw.outcome, status: outsideRaw.status ?? null, ms: outsideRaw.ms ?? null, server: outsideRaw.server ?? null, error: outsideRaw.error ?? null, skipped: null } : null;
    const tls = outsideRaw?.tls ?? null;
    const certificate = tls?.validTo ? { validTo: tls.validTo, daysLeft: Math.floor((Date.parse(tls.validTo) - at.getTime()) / 86_400_000), issuer: tls.issuer ?? null, authorized: tls.authorized === true, authorizationError: tls.authorizationError ?? null } : null;
    const inside = insideRaw ? { outcome: insideRaw.outcome, status: insideRaw.status ?? null, ms: insideRaw.ms ?? null, error: insideRaw.error ?? null } : null;
    const verdict = judgeDomain(domain, { dns, certificate, outside, inside, tunnel: domain.expect === "cloudflare" ? facts.tunnel : null, app: domain.app }, { now: at });
    return {
      hostname: domain.hostname, url: `https://${domain.hostname}`, sources: domain.sources, appId: domain.appId, appName: domain.appName, service: domain.service, label: domain.label, manual: domain.manual, wildcard: Boolean(domain.wildcard), expect: domain.expect, expectedAddress: domain.expectedAddress ?? null,
      ...verdict,
      dns: dns ? { resolved: dns.resolved, addresses: dns.addresses.slice(0, 8), viaCloudflare: dns.viaCloudflare, private: dns.private, error: dns.error ?? null } : null,
      certificate, outside, inside,
      app: domain.app,
      backup: backupStateOf(domain.appId, facts.protection, facts.schedules, { now: at.getTime() }),
      checkedAt: at.toISOString(),
    };
  }

  /** The alerts a verdict earns or clears: down twice running (or once, at the slowest cadences), and a certificate in its last fortnight. */
  async function announce(result, intervalMinutes) {
    if (!alerts) return;
    const downKey = `${alertFamilies.down}:${result.hostname}`;
    const certificateKey = `${alertFamilies.certificate}:${result.hostname}`;
    const streak = result.state === "down" ? (downStreak.get(result.hostname) ?? 0) + 1 : 0;
    downStreak.set(result.hostname, streak);
    try {
      if (streak >= 2 || (streak === 1 && intervalMinutes >= 30)) await alerts.raise({ key: downKey, priority: "high", title: `${result.hostname} is down`, message: result.advice ?? `${result.hostname} does not answer from the internet.` });
      else if (streak === 0) await alerts.clear(downKey);
      const days = result.certificate?.daysLeft ?? null;
      if (days !== null && days <= certificateWarningDays) await alerts.raise({ key: certificateKey, priority: "default", title: days < 0 ? `${result.hostname}'s certificate has expired` : `${result.hostname}'s certificate expires in ${plural(days, "day")}`, message: result.advice ?? "" });
      else if (days !== null) await alerts.clear(certificateKey, { quietly: true });
    } catch { /* the verdict stands; the ledger's own audit says what failed */ }
  }

  /** One round: read the names, check each, keep the samples, raise or clear, save the snapshot. */
  async function run() {
    const at = now();
    const { intervalMinutes } = settings();
    let facts;
    try {
      facts = await gather();
    } catch (error) {
      const snapshot = { ...(lastSnapshot() ?? { domains: [] }), problem: `The names could not be read: ${error.message}`, checkedAt: at.toISOString() };
      store.setSetting(snapshotKey, snapshot, { updatedBy: null });
      return snapshot;
    }
    const results = await eachLimited(facts.domains, concurrency, (domain) => checkOne(domain, facts, at));
    const history = readHistory();
    const nextHistory = {};
    for (const result of results) {
      nextHistory[result.hostname] = result.wildcard ? history[result.hostname] ?? [] : foldSample(history[result.hostname], [at.getTime(), result.state === "down" ? 0 : 1, result.outside?.ms ?? null], at.getTime());
      result.uptime = uptimeOf(nextHistory[result.hostname], at.getTime());
    }
    store.setSetting(historyKey, nextHistory, { updatedBy: null });
    // Names that are gone take their alerts with them, quietly: nothing was fixed, it was removed.
    const present = new Set(results.map((result) => result.hostname));
    for (const hostname of Object.keys(history)) {
      if (present.has(hostname) || !alerts) continue;
      downStreak.delete(hostname);
      await Promise.resolve(alerts.clear(`${alertFamilies.down}:${hostname}`, { quietly: true })).catch(() => {});
      await Promise.resolve(alerts.clear(`${alertFamilies.certificate}:${hostname}`, { quietly: true })).catch(() => {});
    }
    for (const result of results) await announce(result, intervalMinutes);
    lastRunAt = at.getTime();
    dueAt = lastRunAt + intervalMinutes * 60_000;
    const snapshot = { domains: results, tunnel: facts.tunnel, checkedAt: at.toISOString(), problem: null };
    store.setSetting(snapshotKey, snapshot, { updatedBy: null });
    store.recordAudit?.("hosted.checked", { actorId: null, subjectId: hostname(), details: { domains: results.length, down: results.filter((result) => result.state === "down").map((result) => result.hostname), at: at.toISOString() } });
    return snapshot;
  }

  /** One round at a time, however many ask for one. */
  function check() {
    if (!inflight) inflight = run().finally(() => { inflight = null; });
    return inflight;
  }

  /** What the page shows: the last round's verdicts and the facts around them; `fresh` runs a round first. */
  async function status({ fresh = false } = {}) {
    if (fresh) await check();
    let snapshot = lastSnapshot();
    if (!snapshot && !fresh) { void check().catch(() => {}); snapshot = null; }
    const { intervalMinutes, manual } = settings();
    const checkedAt = snapshot?.checkedAt ?? null;
    return {
      domains: Array.isArray(snapshot?.domains) ? snapshot.domains : [],
      tunnel: snapshot?.tunnel ?? null,
      checkedAt,
      checking: inflight !== null,
      nextCheckAt: dueAt ? new Date(dueAt).toISOString() : checkedAt ? new Date(Date.parse(checkedAt) + intervalMinutes * 60_000).toISOString() : null,
      intervalMinutes,
      intervals: [...intervalChoices],
      manual,
      alertsTarget: Boolean(notifications?.getTarget?.()),
      problem: snapshot?.problem ?? null,
    };
  }

  function setIntervalMinutes(minutes, { updatedBy = null } = {}) {
    if (!intervalChoices.includes(minutes)) throw invalid(`The interval must be one of ${intervalChoices.join(", ")} minutes`);
    const current = settings();
    writeSettings({ ...current, intervalMinutes: minutes }, updatedBy);
    if (lastRunAt) dueAt = lastRunAt + minutes * 60_000;
    store.recordAudit?.("hosted.interval.set", { actorId: updatedBy, subjectId: String(minutes), details: { intervalMinutes: minutes } });
    return { intervalMinutes: minutes };
  }

  function addManual(raw, { updatedBy = null } = {}) {
    const entry = validateManualEntry(raw);
    const current = settings();
    if (!current.manual.some((existing) => existing.hostname === entry.hostname) && current.manual.length >= manualLimit) throw invalid(`At most ${manualLimit} names can be added by hand`);
    const manual = [...current.manual.filter((existing) => existing.hostname !== entry.hostname), { ...entry, addedAt: now().toISOString(), addedBy: updatedBy }];
    writeSettings({ ...current, manual }, updatedBy);
    dueAt = now().getTime(); // checked at the next tick, so the new name shows within the minute
    store.recordAudit?.("hosted.manual.added", { actorId: updatedBy, subjectId: entry.hostname, details: { service: entry.service, appId: entry.appId } });
    return { added: entry.hostname, manual };
  }

  async function removeManual(hostname, { updatedBy = null } = {}) {
    const name = lower(hostname);
    const current = settings();
    if (!current.manual.some((existing) => existing.hostname === name)) throw Object.assign(new Error(`${name} is not one of the names added by hand`), { code: "not_found" });
    writeSettings({ ...current, manual: current.manual.filter((existing) => existing.hostname !== name) }, updatedBy);
    // Its verdict and alerts go now, not at the next round: a name taken off the list is not "down".
    const snapshot = lastSnapshot();
    if (snapshot) store.setSetting(snapshotKey, { ...snapshot, domains: (snapshot.domains ?? []).filter((domain) => domain.hostname !== name || !domain.manual || domain.sources?.length > 1) }, { updatedBy: null });
    const history = readHistory();
    if (history[name]) { delete history[name]; store.setSetting(historyKey, history, { updatedBy: null }); }
    downStreak.delete(name);
    if (alerts) {
      await Promise.resolve(alerts.clear(`${alertFamilies.down}:${name}`, { quietly: true })).catch(() => {});
      await Promise.resolve(alerts.clear(`${alertFamilies.certificate}:${name}`, { quietly: true })).catch(() => {});
    }
    store.recordAudit?.("hosted.manual.removed", { actorId: updatedBy, subjectId: name, details: {} });
    dueAt = now().getTime();
    return { removed: name, manual: current.manual.filter((existing) => existing.hostname !== name) };
  }

  /** Something changed what is published (a publish, an unpublish): check again at the next tick. */
  function forget() { dueAt = now().getTime(); }

  /** Due when never run, when the cadence has passed, or when something asked for a look. */
  function tick() {
    const at = now().getTime();
    if (dueAt === null) dueAt = at;
    if (at < dueAt || inflight) return Promise.resolve(null);
    return check().catch(() => null);
  }

  function start() {
    const first = delay(() => { tick().catch(() => {}); }, initialDelayMs);
    first.unref?.();
    const timer = schedule(() => { tick().catch(() => {}); }, tickMs);
    timer.unref?.();
    return () => { cancel(first); unschedule(timer); };
  }

  return { settings, status, check, tick, start, forget, setIntervalMinutes, addManual, removeManual, gather };
}
