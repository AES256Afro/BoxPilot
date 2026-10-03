/**
 * A stand-in for the few Cloudflare API (v4) endpoints BoxPilot calls (M42), as a `fetch` function:
 * tests of the client, the tasks and the operations use it, and nothing ever reaches the network.
 * It answers as Cloudflare does ({ success, errors, result, result_info }), checks the bearer
 * token, and records every call (method, path, query, body) so a test can say what was asked.
 */
export const fakeAccount = { id: "0123456789abcdef0123456789abcdef", name: "Example household" };

export function createFakeCloudflare({
  token = "cf-test-token-0000000000000000000000",
  zones = [{ id: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", name: "example.com", account: fakeAccount }],
  tunnels = [],
  configs = {},
  records = [],
  runKey = "eyJhIjoiZmFrZS1ydW4ta2V5LWZvci10ZXN0cyJ9",
  fail = null,
} = {}) {
  const calls = [];
  const state = { tunnels: tunnels.map((tunnel) => ({ ...tunnel })), configs: { ...configs }, records: records.map((record) => ({ ...record })), nextId: 1 };
  const answer = (result, status = 200, extra = {}) => new Response(JSON.stringify({ success: status < 400, errors: status < 400 ? [] : [{ code: 1000 + status, message: extra.message ?? "refused" }], messages: [], result, ...extra.envelope }), { status, headers: { "content-type": "application/json" } });

  async function fetcher(input, init = {}) {
    const url = new URL(String(input));
    const method = init.method ?? "GET";
    const route = url.pathname.replace(/^\/client\/v4/, "");
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ method, route, query: Object.fromEntries(url.searchParams), body, redirect: init.redirect ?? null });
    if (init.headers?.Authorization !== `Bearer ${token}`) return answer(null, 403, { message: "Authentication error" });
    const failure = typeof fail === "function" ? fail({ method, route, body }) : null;
    if (failure) return failure;

    let match;
    if (method === "GET" && route === "/zones") {
      const page = Number(url.searchParams.get("page") ?? 1);
      const per = Number(url.searchParams.get("per_page") ?? 50);
      return answer(zones.slice((page - 1) * per, page * per), 200, { envelope: { result_info: { page, per_page: per, total_pages: Math.max(1, Math.ceil(zones.length / per)), count: zones.length } } });
    }
    if ((match = /^\/accounts\/([^/]+)\/cfd_tunnel$/.exec(route))) {
      if (method === "GET") return answer(state.tunnels.filter((tunnel) => tunnel.account === match[1] && (!url.searchParams.get("name") || tunnel.name === url.searchParams.get("name")) && !tunnel.deleted_at));
      if (method === "POST") {
        const tunnel = { id: `00000000-0000-4000-8000-${String(state.nextId++).padStart(12, "0")}`, name: body.name, account: match[1], status: "inactive", remote_config: body.config_src === "cloudflare", config_src: body.config_src, connections: [], token: runKey };
        state.tunnels.push(tunnel);
        return answer(tunnel);
      }
    }
    if ((match = /^\/accounts\/([^/]+)\/cfd_tunnel\/([^/]+)\/token$/.exec(route)) && method === "GET") return answer(runKey);
    if ((match = /^\/accounts\/([^/]+)\/cfd_tunnel\/([^/]+)\/configurations$/.exec(route))) {
      if (method === "GET") return answer({ tunnel_id: match[2], version: 1, config: state.configs[match[2]] ?? null, source: "cloudflare" });
      if (method === "PUT") { state.configs[match[2]] = body.config; return answer({ tunnel_id: match[2], version: 2, config: body.config }); }
    }
    if ((match = /^\/accounts\/([^/]+)\/cfd_tunnel\/([^/]+)$/.exec(route)) && method === "GET") {
      const tunnel = state.tunnels.find((entry) => entry.id === match[2]);
      return tunnel ? answer(tunnel) : answer(null, 404, { message: "Tunnel not found" });
    }
    if ((match = /^\/zones\/([^/]+)\/dns_records$/.exec(route))) {
      if (method === "GET") return answer(state.records.filter((record) => record.zone === match[1] && (!url.searchParams.get("name") || record.name === url.searchParams.get("name"))));
      if (method === "POST") {
        const record = { id: `rec${String(state.nextId++).padStart(29, "0")}`, zone: match[1], ...body };
        state.records.push(record);
        return answer(record);
      }
    }
    if ((match = /^\/zones\/([^/]+)\/dns_records\/([^/]+)$/.exec(route)) && method === "DELETE") {
      const before = state.records.length;
      state.records = state.records.filter((record) => record.id !== match[2]);
      return before === state.records.length ? answer(null, 404, { message: "Record not found" }) : answer({ id: match[2] });
    }
    return answer(null, 404, { message: `No route ${method} ${route}` });
  }

  return { fetcher, calls, state, token, runKey };
}
