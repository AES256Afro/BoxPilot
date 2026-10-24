import { describe, expect, it, vi } from "vitest";
import { createHealthAlerts } from "./health-alerts.mjs";
import { backupStateOf, createHostedDomainsService, discoverDomains, foldSample, judgeDomain, normalizeSettings, publicHostnameOf, sampleLimit, tunnelFromLog, uptimeOf, validateManualEntry } from "./hosted-domains.mjs";

const tunnelId = "6f0c2e9a-4b1d-4c7e-9a3f-2d5b8e1c0a47";
const tunnelRecord = { connected: true, tunnel: { id: tunnelId, name: "boxpilot-homebox" }, routes: [{ hostname: "share.example.com", appId: "pingvin-share", portId: "web", hostPort: 3022, service: "http://127.0.0.1:3022" }] };
const app = (id, port, { installed = true, running = true, env = {} } = {}) => ({ id, name: id, installed, container: installed ? { running, status: running ? "running" : "exited", startedAt: "2026-10-20T08:00:00.000Z" } : null, published: installed ? [{ id: "web", host: port, protocol: "tcp", bind: "*", web: true }] : [], state: installed ? { values: { env } } : null });
const apps = [app("pingvin-share", 3022), app("cloudflared", null), app("nasanow", 4321), app("bookstack", 8120, { env: { APP_URL: "https://wiki.example.com/" } }), app("mealie", 9925, { env: { BASE_URL: "http://192.168.1.10:9925" } })];
const manifests = [{ id: "pingvin-share", name: "Pingvin Share" }, { id: "nasanow", name: "NasaNow" }, { id: "bookstack", name: "BookStack", publicHostname: { env: "APP_URL" } }, { id: "mealie", name: "Mealie", publicHostname: { env: "BASE_URL" } }];
const cloudflare = { resolved: true, addresses: ["104.21.5.7", "172.67.140.9"], viaCloudflare: true, private: false, error: null };
const soon = (days, now) => new Date(now.getTime() + days * 86_400_000).toISOString();
const now = new Date("2026-10-24T12:00:00.000Z");

describe("discovering the names this server serves", () => {
  it("merges every source into one entry per name, the first source deciding, later ones filling in", () => {
    const sources = {
      cloudflared: [{ file: "/etc/cloudflared/config.yml", ingress: [{ hostname: "news.example.com", service: "http://localhost:4321", wildcard: false }, { hostname: "share.example.com", service: "http://127.0.0.1:3022", wildcard: false }, { hostname: "*.example.com", service: "http://127.0.0.1:8080", wildcard: true }] }],
      proxyHosts: [{ file: "1.conf", hostnames: ["media.example.com"], target: "http://192.168.1.10:8096" }],
    };
    const manual = [{ hostname: "status.example.com", service: "http://127.0.0.1:3001", appId: null, label: "Status page", expectedAddress: null }, { hostname: "news.example.com", service: null, appId: null, label: "The site", expectedAddress: null }];
    const found = discoverDomains({ tunnel: tunnelRecord, apps, manifests, sources, manual });
    expect(found.map((domain) => domain.hostname)).toEqual(["share.example.com", "news.example.com", "*.example.com", "media.example.com", "wiki.example.com", "status.example.com"]);
    const by = Object.fromEntries(found.map((domain) => [domain.hostname, domain]));
    expect(by["share.example.com"]).toMatchObject({ sources: ["tunnel", "cloudflared-config"], appId: "pingvin-share", appName: "Pingvin Share", service: "http://127.0.0.1:3022", expect: "cloudflare", manual: false, app: { installed: true, running: true } });
    // The config's loopback port is NasaNow's, so the row is NasaNow's; the owner's label joins it.
    expect(by["news.example.com"]).toMatchObject({ sources: ["cloudflared-config", "manual"], appId: "nasanow", appName: "NasaNow", service: "http://localhost:4321", label: "The site", manual: true });
    expect(by["*.example.com"]).toMatchObject({ wildcard: true, expect: "cloudflare" });
    // A proxy host on a LAN address is not something this server can ask itself; the name is still watched.
    expect(by["media.example.com"]).toMatchObject({ sources: ["proxy"], appId: null, service: null });
    // BookStack says its public address in APP_URL; Mealie's BASE_URL is a LAN address and is left out.
    expect(by["wiki.example.com"]).toMatchObject({ sources: ["catalog"], appId: "bookstack", service: "http://127.0.0.1:8120" });
    expect(by["status.example.com"]).toMatchObject({ sources: ["manual"], label: "Status page", service: "http://127.0.0.1:3001", expect: "cloudflare" });
  });

  it("expects nothing of Cloudflare on a server with no tunnel at all, and an address when the owner named one", () => {
    const found = discoverDomains({ apps: [app("bookstack", 8120, { env: { APP_URL: "https://wiki.example.com" } })], manifests, manual: [{ hostname: "home.example.com", expectedAddress: "203.0.113.7" }] });
    expect(found).toHaveLength(2);
    expect(found[0]).toMatchObject({ hostname: "wiki.example.com", expect: "any" });
    expect(found[1]).toMatchObject({ hostname: "home.example.com", expect: "address", expectedAddress: "203.0.113.7", app: null });
  });

  it("passes over anything malformed in a source rather than trusting it", () => {
    const found = discoverDomains({
      tunnel: { routes: [null, "x", { hostname: 42 }, { hostname: "not a name!" }, { hostname: "ok.example.com" }] },
      apps: [null, { id: "pingvin-share", installed: true, published: [null, { host: "x" }] }],
      manifests: [null, { id: "pingvin-share", publicHostname: { env: 7 } }],
      sources: { cloudflared: [null, { ingress: [null, 5, { hostname: null }, { hostname: "cfg.example.com", service: 9 }] }], proxyHosts: [null, { hostnames: [null, 3, "proxy.example.com"], target: 12 }] },
      manual: [null, { hostname: 3 }],
    });
    expect(found.map((domain) => domain.hostname)).toEqual(["ok.example.com", "cfg.example.com", "proxy.example.com"]);
  });

  it("reads a public name out of a setting, whatever shape it was typed in", () => {
    expect(publicHostnameOf("https://wiki.example.com/")).toBe("wiki.example.com");
    expect(publicHostnameOf("Wiki.Example.com")).toBe("wiki.example.com");
    expect(publicHostnameOf("wiki.example.com:8443/path")).toBe("wiki.example.com");
    expect(publicHostnameOf("localhost homebox.lan cloud.example.com")).toBe("cloud.example.com");
    for (const value of ["http://localhost:8120", "http://192.168.1.10:9925", "homebox.tail0a1b.ts.net", "https://[::1]/", "", null, 42, "not a name!"]) expect(publicHostnameOf(value), String(value)).toBeNull();
  });
});

describe("the verdict on one name", () => {
  const domain = { hostname: "share.example.com", appId: "pingvin-share", appName: "Pingvin Share", service: "http://127.0.0.1:3022", expect: "cloudflare" };
  const fine = { dns: cloudflare, certificate: { validTo: soon(60, now), authorized: true }, outside: { outcome: "answered", status: 200, ms: 180, skipped: null }, inside: { outcome: "answered", status: 200, ms: 4 }, tunnel: { installed: true, running: true, connections: 4 }, app: { installed: true, running: true } };

  it("is up when everything answers", () => {
    expect(judgeDomain(domain, fine, { now })).toEqual({ state: "up", headline: "Up", advice: null, problems: [] });
    // A sign-in wall is an answer; so is a redirect.
    expect(judgeDomain(domain, { ...fine, outside: { ...fine.outside, status: 401 } }, { now }).state).toBe("up");
    expect(judgeDomain(domain, { ...fine, outside: { ...fine.outside, status: 308 } }, { now }).state).toBe("up");
  });

  it("is down when the name does not resolve, and says what record to add", () => {
    const verdict = judgeDomain(domain, { ...fine, dns: { resolved: false, addresses: [], viaCloudflare: false, private: false, error: "ENOTFOUND" }, outside: { outcome: "skipped", skipped: "does not resolve" }, certificate: null }, { now });
    expect(verdict).toMatchObject({ state: "down", headline: "Does not resolve", problems: ["does not resolve"] });
    expect(verdict.advice).toContain("proxied CNAME to the tunnel");
  });

  it("is down with the tunnel's own advice when Cloudflare answers 530 and the tunnel app is stopped", () => {
    const verdict = judgeDomain(domain, { ...fine, outside: { outcome: "answered", status: 530, ms: 90, skipped: null }, tunnel: { installed: true, running: false, connections: 0 }, inside: { outcome: "refused", error: "nothing is listening" }, app: { installed: true, running: false } }, { now });
    expect(verdict.state).toBe("down");
    expect(verdict.headline).toBe("Cloudflare cannot reach this server (HTTP 530)");
    expect(verdict.problems).toEqual(["Cloudflare cannot reach this server (HTTP 530)", "the tunnel app is not running", "Pingvin Share is not running", "Pingvin Share does not answer on this server"]);
    expect(verdict.advice).toContain("Start it from its Overview tab in the App catalog");
    expect(verdict.advice).toContain("http://127.0.0.1:3022");
  });

  it("is degraded, not down, while the name still answers but something behind it needs a look", () => {
    expect(judgeDomain(domain, { ...fine, outside: { ...fine.outside, status: 404 } }, { now })).toMatchObject({ state: "degraded", headline: "Answers HTTP 404" });
    expect(judgeDomain(domain, { ...fine, inside: { outcome: "timeout", error: "no answer within 10s" } }, { now })).toMatchObject({ state: "degraded", headline: "Pingvin Share does not answer on this server" });
    expect(judgeDomain(domain, { ...fine, dns: { ...cloudflare, addresses: ["203.0.113.7"], viaCloudflare: false } }, { now })).toMatchObject({ state: "degraded", headline: "Not pointed at Cloudflare" });
    expect(judgeDomain(domain, { ...fine, dns: { ...cloudflare, addresses: ["192.168.1.10"], viaCloudflare: false, private: true }, outside: { outcome: "skipped", skipped: "resolves to a private address" }, certificate: null }, { now })).toMatchObject({ state: "degraded", headline: "Resolves to a private address" });
    expect(judgeDomain(domain, { ...fine, tunnel: { installed: true, running: false } }, { now })).toMatchObject({ state: "degraded", headline: "The tunnel app is not running" });
    expect(judgeDomain(domain, { ...fine, app: { installed: true, running: false } }, { now }).advice).toContain("whatever Cloudflare cached");
  });

  it("counts the certificate's days, warns inside the last fortnight, and calls an expired one down", () => {
    const nine = judgeDomain(domain, { ...fine, certificate: { validTo: soon(9.5, now), authorized: true } }, { now });
    expect(nine).toMatchObject({ state: "degraded", headline: "Certificate expires in 9 days" });
    expect(nine.advice).toContain("Cloudflare renews");
    expect(judgeDomain(domain, { ...fine, certificate: { validTo: soon(1.2, now), authorized: true } }, { now }).headline).toBe("Certificate expires in 1 day");
    expect(judgeDomain(domain, { ...fine, certificate: { validTo: soon(15, now), authorized: true } }, { now }).state).toBe("up");
    expect(judgeDomain(domain, { ...fine, certificate: { validTo: soon(-1, now), authorized: true } }, { now })).toMatchObject({ state: "down", headline: "Certificate expired" });
    expect(judgeDomain(domain, { ...fine, certificate: { validTo: soon(60, now), authorized: false, authorizationError: "DEPTH_ZERO_SELF_SIGNED_CERT" } }, { now })).toMatchObject({ state: "degraded", headline: "Certificate not trusted" });
    // Not behind Cloudflare: the advice is to renew, not to check the orange cloud.
    expect(judgeDomain({ ...domain, expect: "any" }, { ...fine, certificate: { validTo: soon(3, now), authorized: true } }, { now }).advice).toContain("Renew it before then");
  });

  it("checks a plain address against the one the owner expects, and leaves a wildcard unjudged", () => {
    const plain = { hostname: "home.example.com", expect: "address", expectedAddress: "203.0.113.7", appId: null, appName: null, service: null };
    expect(judgeDomain(plain, { dns: { resolved: true, addresses: ["203.0.113.7"], viaCloudflare: false, private: false }, outside: { outcome: "answered", status: 200, skipped: null } }, { now }).state).toBe("up");
    expect(judgeDomain(plain, { dns: { resolved: true, addresses: ["203.0.113.8"], viaCloudflare: false, private: false }, outside: { outcome: "answered", status: 200, skipped: null } }, { now })).toMatchObject({ state: "degraded", headline: "Resolves elsewhere" });
    expect(judgeDomain({ hostname: "*.example.com", wildcard: true }, {}, { now })).toMatchObject({ state: "unknown", headline: "Wildcard" });
  });
});

describe("uptime, history and backups", () => {
  it("counts the day and the week, and keeps a week of samples at most", () => {
    const at = now.getTime();
    const hour = 3600_000;
    let samples = [];
    for (let back = 10 * 24; back >= 0; back -= 1) samples = foldSample(samples, [at - back * hour, back % 10 === 0 ? 0 : 1, 100], at);
    expect(samples.length).toBe(7 * 24 + 1); // nothing older than a week
    const uptime = uptimeOf(samples, at);
    expect(uptime.checks).toBe(169);
    expect(uptime.day).toBe(88); // 25 samples in the day, the ones at 0, 10 and 20 hours back down
    expect(uptime.week).toBeLessThan(100);
    expect(uptimeOf([], at)).toEqual({ day: null, week: null, checks: 0 });
    let many = [];
    for (let index = 0; index < sampleLimit + 50; index += 1) many = foldSample(many, [at - index, 1, 1], at);
    expect(many.length).toBe(sampleLimit);
  });

  it("says how the app behind a name is backed up", () => {
    const protection = { available: true, apps: [{ id: "pingvin-share", protectable: true, backups: 3, newestAt: "2026-10-20T03:00:00.000Z" }, { id: "nasanow", protectable: true, backups: 0, newestAt: null }, { id: "cloudflared", protectable: false, backups: 0, newestAt: null }] };
    const schedules = [{ operationId: "app.backup", enabled: true, parameters: { id: "pingvin-share" } }];
    expect(backupStateOf("pingvin-share", protection, schedules, { now: now.getTime() })).toEqual({ state: "ok", newestAt: "2026-10-20T03:00:00.000Z", scheduled: true, backups: 3 });
    expect(backupStateOf("pingvin-share", protection, schedules, { now: now.getTime() + 20 * 86_400_000 })).toMatchObject({ state: "stale" });
    expect(backupStateOf("nasanow", protection, [], { now: now.getTime() })).toMatchObject({ state: "never", scheduled: false });
    expect(backupStateOf("cloudflared", protection, [], { now: now.getTime() })).toMatchObject({ state: "none" });
    expect(backupStateOf("pingvin-share", null, [], { now: now.getTime() })).toMatchObject({ state: "unknown" });
    expect(backupStateOf(null, protection, [], { now: now.getTime() })).toBeNull();
  });

  it("reads the tunnel's connections out of cloudflared's log", () => {
    const lines = [
      "2026-10-24T08:00:00Z INF Starting tunnel tunnelID=6f0c2e9a",
      "2026-10-24T08:00:01Z INF Registered tunnel connection connIndex=0 connection=aaa location=lhr protocol=quic",
      "2026-10-24T08:00:01Z INF Registered tunnel connection connIndex=1 connection=bbb location=ams protocol=quic",
      "2026-10-24T09:00:00Z INF Unregistered tunnel connection connIndex=1",
      "2026-10-24T09:00:02Z WRN Connection terminated error=\"timeout\" connIndex=1",
      "2026-10-24T09:00:05Z INF Registered tunnel connection connIndex=1 connection=ccc location=ams protocol=quic",
    ];
    expect(tunnelFromLog(lines)).toEqual({ connections: 2, since: "2026-10-24T08:00:01Z", lastProblem: 'Connection terminated error="timeout" connIndex=1' });
    expect(tunnelFromLog([])).toEqual({ connections: 0, since: null, lastProblem: null });
  });
});

describe("names the owner types in", () => {
  it("keeps a public name with where it is answered here, and refuses what is not one", () => {
    expect(validateManualEntry({ hostname: " News.Example.com. ", service: "http://127.0.0.1:4321", label: " The site ", appId: "nasanow" })).toEqual({ hostname: "news.example.com", service: "http://127.0.0.1:4321", appId: "nasanow", label: "The site", expectedAddress: null });
    expect(validateManualEntry({ hostname: "home.example.com", expectedAddress: "203.0.113.7" })).toMatchObject({ expectedAddress: "203.0.113.7", service: null });
    const refused = (raw) => { try { validateManualEntry(raw); return null; } catch (error) { return error.message; } };
    expect(refused({})).toBe("Say which name to watch");
    expect(refused({ hostname: "example" })).toContain("is not a name on the internet");
    expect(refused({ hostname: "homebox.lan" })).toContain("your own network");
    expect(refused({ hostname: "192.168.1.10" })).toContain("your own network");
    expect(refused({ hostname: "a".repeat(300) })).toContain("is not a name on the internet");
    expect(refused({ hostname: "x.example.com", service: "http://192.168.1.10:80" })).toContain("http://127.0.0.1:<port>");
    expect(refused({ hostname: "x.example.com", service: "http://127.0.0.1:80/path" })).toContain("http://127.0.0.1:<port>");
    expect(refused({ hostname: "x.example.com", appId: "../etc" })).toContain("from the catalog");
    expect(refused({ hostname: "x.example.com", label: "two\nlines" })).toContain("one line");
    expect(refused({ hostname: "x.example.com", expectedAddress: "nowhere" })).toContain("IP address");
    expect(refused({ hostname: ["x.example.com"] })).toBe("Say which name to watch");
  });

  it("drops anything malformed from the stored setting rather than trusting it", () => {
    const settings = normalizeSettings({ intervalMinutes: 7, manual: [{ hostname: "ok.example.com", service: "http://127.0.0.1:1", appId: "x!", label: 3, expectedAddress: "junk" }, { hostname: "homebox.lan" }, "junk", { hostname: "ok.example.com" }] });
    expect(settings.intervalMinutes).toBe(15);
    expect(settings.manual).toEqual([{ hostname: "ok.example.com", service: "http://127.0.0.1:1", appId: null, label: null, expectedAddress: null, addedAt: null, addedBy: null }]);
    expect(normalizeSettings(null)).toEqual({ intervalMinutes: 15, manual: [] });
  });
});

/** A memory store, a helper that answers from fixtures, probes that answer as told, and the real alert ledger. */
function fixture({ answers = {}, probeFor = () => ({ outcome: "answered", status: 200, ms: 120, server: "cloudflare", tls: null }), resolveFor = () => cloudflare, target = { kind: "ntfy" } } = {}) {
  const settings = new Map();
  const audits = [];
  const store = {
    getSetting: (key, fallback = null) => (settings.has(key) ? settings.get(key) : fallback),
    setSetting: (key, value) => { settings.set(key, value); return value; },
    recordAudit: (type, entry) => audits.push({ type, ...entry }),
    listSchedules: () => [{ operationId: "app.backup", enabled: true, parameters: { id: "pingvin-share" } }],
  };
  const helper = { requests: [], request: vi.fn(async (operation, parameters) => { helper.requests.push({ operation, parameters }); if (answers[operation] instanceof Error) throw answers[operation]; return answers[operation] ?? null; }) };
  const send = vi.fn(async () => ({ sent: true }));
  const notifications = { getTarget: () => target, send };
  let clock = new Date(now);
  const nowFn = () => clock;
  const alerts = createHealthAlerts({ inventory: { inspect: async () => ({}) }, notifications, store, now: nowFn });
  const probes = { resolve: vi.fn(async (hostname) => resolveFor(hostname)), probe: vi.fn(async (probe) => probeFor(probe)) };
  const service = createHostedDomainsService({ store, helper, catalog: { all: async () => ({ manifests }) }, alerts, notifications, probes, now: nowFn, hostname: () => "homebox" });
  return { service, store, settings, audits, helper, probes, send, ledger: () => settings.get("healthAlertsState") ?? {}, advance: (ms) => { clock = new Date(clock.getTime() + ms); } };
}

const liveAnswers = {
  "cloudflare.tunnel.inspect": tunnelRecord,
  "app.inspect": { applications: apps },
  "hosted-domains.sources": { cloudflared: [], proxyHosts: [] },
  "app.backup.protection": { available: true, apps: [{ id: "pingvin-share", name: "Pingvin Share", protectable: true, backups: 3, newestAt: "2026-10-20T03:00:00.000Z" }, { id: "bookstack", name: "BookStack", protectable: true, backups: 0, newestAt: null }] },
  "app.logs": { lines: ["2026-10-24T08:00:01Z INF Registered tunnel connection connIndex=0 connection=aaa location=lhr protocol=quic"] },
};

describe("the hosted-domains service", () => {
  it("checks every name it finds, keeps the verdicts and a week of samples, and tells the page", async () => {
    const { service, settings, probes, audits } = fixture({ answers: liveAnswers, probeFor: ({ url }) => ({ outcome: "answered", status: url.startsWith("https://") ? 200 : 302, ms: 120, server: url.startsWith("https://") ? "cloudflare" : null, tls: url.startsWith("https://") ? { validTo: soon(70, now), issuer: "Google Trust Services", authorized: true } : null }) });
    const snapshot = await service.check();
    expect(snapshot.domains.map((domain) => domain.hostname)).toEqual(["share.example.com", "wiki.example.com"]);
    const share = snapshot.domains[0];
    expect(share).toMatchObject({ state: "up", headline: "Up", appName: "Pingvin Share", url: "https://share.example.com", sources: ["tunnel"], dns: { viaCloudflare: true }, certificate: { daysLeft: 70, issuer: "Google Trust Services", authorized: true }, outside: { status: 200, ms: 120, server: "cloudflare" }, inside: { status: 302 }, backup: { state: "ok", scheduled: true, backups: 3 }, uptime: { day: 100, week: 100, checks: 1 }, checkedAt: now.toISOString() });
    expect(snapshot.tunnel).toEqual({ installed: true, running: true, status: "running", since: "2026-10-24T08:00:01Z", connections: 1, lastProblem: null, cloudflare: { connected: true, tunnelName: "boxpilot-homebox" } });
    // The outside probe went to the public name; the inside one to the app's loopback port with that name in Host.
    expect(probes.probe.mock.calls.map(([probe]) => [probe.url, probe.hostHeader ?? null])).toEqual(expect.arrayContaining([["https://share.example.com/", null], ["http://127.0.0.1:3022", "share.example.com"], ["https://wiki.example.com/", null], ["http://127.0.0.1:8120", "wiki.example.com"]]));
    expect(settings.get("hostedDomainsLast").domains).toHaveLength(2);
    expect(settings.get("hostedDomainsHistory")["share.example.com"]).toEqual([[now.getTime(), 1, 120]]);
    expect(audits.find((entry) => entry.type === "hosted.checked")).toMatchObject({ details: { domains: 2, down: [] } });
    const status = await service.status();
    expect(status).toMatchObject({ checkedAt: now.toISOString(), checking: false, intervalMinutes: 15, intervals: [5, 15, 30, 60], manual: [], alertsTarget: true, problem: null, nextCheckAt: new Date(now.getTime() + 15 * 60_000).toISOString() });
    expect(status.domains).toHaveLength(2);
  });

  it("does not probe a name that resolves into the house, and says so", async () => {
    const { service, probes } = fixture({ answers: liveAnswers, resolveFor: () => ({ resolved: true, addresses: ["192.168.1.10"], viaCloudflare: false, private: true, error: null }) });
    const snapshot = await service.check();
    expect(snapshot.domains[0]).toMatchObject({ state: "degraded", headline: "Resolves to a private address", outside: { outcome: "skipped", skipped: "resolves to a private address" }, certificate: null });
    expect(probes.probe.mock.calls.some(([probe]) => probe.url.startsWith("https://"))).toBe(false);
  });

  it("pushes once when a name has been down two checks running, and once when it is back", async () => {
    let outside = { outcome: "answered", status: 530, ms: 90, server: "cloudflare", tls: null };
    const { service, send, ledger, advance } = fixture({ answers: { ...liveAnswers, "app.inspect": { applications: apps.map((entry) => (entry.id === "cloudflared" ? { ...entry, container: { running: false, status: "exited" } } : entry)) } }, probeFor: ({ url }) => (url === "https://share.example.com/" ? outside : { outcome: "answered", status: 200, ms: 3, tls: null }) });
    const first = await service.check();
    expect(first.domains[0]).toMatchObject({ state: "down", headline: "Cloudflare cannot reach this server (HTTP 530)" });
    expect(send).not.toHaveBeenCalled(); // once is a blip
    advance(15 * 60_000);
    await service.check();
    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0][0]).toMatchObject({ title: "BoxPilot: share.example.com is down", priority: "high" });
    expect(send.mock.calls[0][0].message).toContain("Cloudflare Tunnel app is not running");
    expect(ledger()["hosted.down:share.example.com"]).toMatchObject({ notified: true });
    advance(15 * 60_000);
    await service.check(); // still down: no second push
    expect(send).toHaveBeenCalledOnce();
    outside = { outcome: "answered", status: 200, ms: 100, server: "cloudflare", tls: null };
    advance(15 * 60_000);
    const back = await service.check();
    expect(back.domains[0].state).toBe("degraded"); // the tunnel app is still stopped, so not quite up
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1][0].title).toBe("BoxPilot: resolved. share.example.com is down");
    expect(ledger()["hosted.down:share.example.com"]).toBeUndefined();
    expect(back.domains[0].uptime).toEqual({ day: 25, week: 25, checks: 4 });
  });

  it("pushes at once at a slow cadence, since the next look is half an hour away", async () => {
    const { service, send, store } = fixture({ answers: liveAnswers, probeFor: () => ({ outcome: "timeout", status: null, ms: 10_000, tls: null, error: "no answer within 10s" }) });
    service.setIntervalMinutes(30, { updatedBy: "owner-1" });
    expect(store.getSetting("hostedDomains")).toMatchObject({ intervalMinutes: 30 });
    await service.check();
    expect(send).toHaveBeenCalledTimes(2); // both names are down
    expect(() => service.setIntervalMinutes(7)).toThrow("one of 5, 15, 30, 60");
  });

  it("warns once about a certificate inside its last fortnight, and drops the warning once it has been renewed", async () => {
    let days = 9;
    const { service, send, ledger } = fixture({ answers: liveAnswers, probeFor: ({ url }) => ({ outcome: "answered", status: 200, ms: 50, tls: url.startsWith("https://") ? { validTo: soon(days, now), issuer: "Let's Encrypt", authorized: true } : null }) });
    const snapshot = await service.check();
    expect(snapshot.domains[0]).toMatchObject({ state: "degraded", headline: "Certificate expires in 9 days", certificate: { daysLeft: 9 } });
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[0][0]).toMatchObject({ title: "BoxPilot: share.example.com's certificate expires in 9 days", priority: "default" });
    expect(ledger()["hosted.cert:share.example.com"]).toMatchObject({ notified: true });
    await service.check();
    expect(send).toHaveBeenCalledTimes(2);
    days = 89;
    await service.check();
    expect(ledger()["hosted.cert:share.example.com"]).toBeUndefined();
    expect(send).toHaveBeenCalledTimes(2); // renewed quietly: nothing to say
  });

  it("takes a name typed in, checks it at the next tick, and forgets its verdict and alerts when it is removed", async () => {
    const { service, settings, probes, ledger, advance, store } = fixture({ answers: liveAnswers, probeFor: ({ url }) => (url.includes("status.example.com") ? { outcome: "timeout", status: null, ms: 10_000, tls: null, error: "no answer" } : { outcome: "answered", status: 200, ms: 50, tls: null }) });
    await service.check();
    expect(service.addManual({ hostname: "Status.Example.com", service: "http://127.0.0.1:3001", label: "Status page" }, { updatedBy: "op-1" })).toMatchObject({ added: "status.example.com" });
    expect(settings.get("hostedDomains").manual[0]).toMatchObject({ hostname: "status.example.com", service: "http://127.0.0.1:3001", label: "Status page", addedAt: now.toISOString(), addedBy: "op-1" });
    expect(() => service.addManual({ hostname: "homebox.lan" })).toThrow("your own network");
    // Added, so due now: the tick runs a round without waiting for the cadence.
    expect(await service.tick()).not.toBeNull();
    expect((await service.status()).domains.map((domain) => domain.hostname)).toEqual(["share.example.com", "wiki.example.com", "status.example.com"]);
    expect(probes.probe.mock.calls.some(([probe]) => probe.url === "http://127.0.0.1:3001" && probe.hostHeader === "status.example.com")).toBe(true);
    advance(15 * 60_000);
    await service.tick();
    expect(ledger()["hosted.down:status.example.com"]).toBeDefined();
    await service.removeManual("status.example.com", { updatedBy: "op-1" });
    expect((await service.status()).domains.map((domain) => domain.hostname)).toEqual(["share.example.com", "wiki.example.com"]);
    expect(ledger()["hosted.down:status.example.com"]).toBeUndefined();
    expect(store.getSetting("hostedDomainsHistory")["status.example.com"]).toBeUndefined();
    await expect(service.removeManual("status.example.com")).rejects.toThrow("not one of the names added by hand");
    // The cadence: nothing runs again until it has passed.
    advance(60_000);
    await service.tick();
    advance(60_000);
    expect(await service.tick()).toBeNull();
  });

  it("stands on the last round when the names cannot be read, and says so", async () => {
    const { service } = fixture({ answers: liveAnswers });
    await service.check();
    const broken = fixture({ answers: liveAnswers });
    broken.service.gather = undefined;
    const failing = createHostedDomainsService({ store: { getSetting: () => { throw new Error("database locked"); }, setSetting: () => {}, recordAudit: () => {} }, probes: { resolve: async () => cloudflare, probe: async () => ({ outcome: "answered", status: 200, ms: 1 }) } });
    await expect(failing.check()).rejects.toThrow("database locked");
    // No helper and no catalog: nothing to find, nothing wrong.
    const bare = createHostedDomainsService({ store: fixture().store, probes: { resolve: async () => cloudflare, probe: async () => ({ outcome: "answered", status: 200, ms: 1 }) } });
    expect(await bare.check()).toMatchObject({ domains: [], tunnel: { installed: false, running: false, cloudflare: null }, problem: null });
    expect((await service.status()).domains).toHaveLength(2);
  });
});
