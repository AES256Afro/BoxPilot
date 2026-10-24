import { vi } from "vitest";
import type { HostedDomain, HostedStatus } from "./types";

/*
 * One fictional server with three public names (M42.2): the route the page reads, and a fetch that
 * answers it and records what it was sent. Names are under example.com; nothing here is a real host.
 */

export const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
export const now = () => Date.parse("2026-10-24T12:00:00.000Z");
const at = (hoursAgo: number) => new Date(now() - hoursAgo * 3600_000).toISOString();

export const domain = (hostname: string, overrides: Partial<HostedDomain> = {}): HostedDomain => ({
  hostname, url: `https://${hostname}`, sources: ["tunnel"], appId: "pingvin-share", appName: "Pingvin Share", service: "http://127.0.0.1:3022", label: null, manual: false, wildcard: false, expect: "cloudflare", expectedAddress: null,
  state: "up", headline: "Up", advice: null, problems: [],
  dns: { resolved: true, addresses: ["104.16.132.229", "104.16.133.229"], viaCloudflare: true, private: false, error: null },
  certificate: { validTo: at(-24 * 71), daysLeft: 71, issuer: "Google Trust Services", authorized: true, authorizationError: null },
  outside: { outcome: "answered", status: 200, ms: 184, server: "cloudflare", error: null, skipped: null },
  inside: { outcome: "answered", status: 200, ms: 6, error: null },
  app: { installed: true, running: true },
  backup: { state: "ok", newestAt: at(27), scheduled: true, backups: 6 },
  uptime: { day: 100, week: 99.9, checks: 672 },
  checkedAt: at(0.05),
  ...overrides,
});

export const share = domain("share.example.com");
export const news = domain("news.example.com", {
  sources: ["cloudflared-config", "manual"], appId: "nasanow", appName: "Space news", service: "http://127.0.0.1:4321", label: "The site", manual: true,
  state: "down", headline: "Cloudflare cannot reach this server (HTTP 530)", problems: ["Cloudflare cannot reach this server (HTTP 530)", "the tunnel app is not running"],
  advice: "Cloudflare answered for news.example.com with HTTP 530, which means it could not get an answer from this server. The Cloudflare Tunnel app is not running on this server, so Cloudflare has nowhere to send visitors. Start it from its Overview tab in the App catalog.",
  outside: { outcome: "answered", status: 530, ms: 92, server: "cloudflare", error: null, skipped: null },
  inside: { outcome: "answered", status: 200, ms: 4, error: null },
  backup: { state: "never", newestAt: null, scheduled: false, backups: 0 },
  uptime: { day: 87.5, week: 98.2, checks: 672 },
});
export const wiki = domain("wiki.example.com", {
  sources: ["catalog"], appId: "bookstack", appName: "BookStack", service: "http://127.0.0.1:8120",
  state: "degraded", headline: "Certificate expires in 9 days", problems: ["certificate expires in 9 days"],
  advice: "The certificate wiki.example.com shows ends on 2 Nov 2026. Cloudflare renews the one it serves on its own, usually inside the last two weeks; if the days keep falling, check the name is still proxied (orange cloud) in Cloudflare's DNS.",
  certificate: { validTo: at(-24 * 9), daysLeft: 9, issuer: "Let's Encrypt", authorized: true, authorizationError: null },
  backup: { state: "stale", newestAt: at(24 * 20), scheduled: false, backups: 2 },
});

export const hostedStatus: HostedStatus = {
  domains: [share, news, wiki],
  tunnel: { installed: true, running: true, status: "running", since: at(31), connections: 4, lastProblem: null, cloudflare: { connected: true, tunnelName: "boxpilot-homebox" } },
  checkedAt: at(0.05), checking: false, nextCheckAt: at(-0.2), intervalMinutes: 15, intervals: [5, 15, 30, 60],
  manual: [{ hostname: "news.example.com", service: "http://127.0.0.1:4321", appId: "nasanow", label: "The site", expectedAddress: null, addedAt: at(48) }],
  alertsTarget: true, problem: null,
};

export const catalogSummary = { applications: [{ manifest: { id: "pingvin-share", name: "Pingvin Share" }, live: { installed: true } }, { manifest: { id: "bookstack", name: "BookStack" }, live: { installed: true } }, { manifest: { id: "jellyfin", name: "Jellyfin" }, live: { installed: false } }] };

export type Answer = unknown | Response | ((init?: RequestInit) => Response);

/** The routes the page reads, with any overridden; every change is recorded by method and path. */
export function mockFetch(routes: Record<string, Answer> = {}, sent: Array<{ method: string; url: string; body: unknown; headers: Record<string, string> }> = []) {
  const table: Record<string, Answer> = {
    "/api/v1/hosted-domains": hostedStatus,
    "/api/v1/hosted-domains?fresh=1": hostedStatus,
    "/api/v1/catalog?view=summary": catalogSummary,
    ...routes,
  };
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input.toString();
    const method = (init?.method ?? "GET").toUpperCase();
    if (method !== "GET") sent.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : null, headers: (init?.headers ?? {}) as Record<string, string> });
    const key = method === "GET" ? url : `${method} ${url}`;
    const answer = key in table ? table[key] : url in table && method === "GET" ? table[url] : undefined;
    if (answer !== undefined) {
      if (answer instanceof Response) return answer.clone();
      if (typeof answer === "function") return (answer as (init?: RequestInit) => Response)(init);
      return json(answer);
    }
    if (method === "POST" && url === "/api/v1/hosted-domains/manual") return json({ added: "x", manual: [] }, 201);
    if (method === "DELETE" && url.startsWith("/api/v1/hosted-domains/manual/")) return json({ removed: "x", manual: [] });
    if (method === "PUT" && url === "/api/v1/hosted-domains/settings") return json({ intervalMinutes: 30 });
    return json({ error: `unexpected ${method} ${url}` }, 404);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}
