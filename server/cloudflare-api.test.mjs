import { describe, expect, it } from "vitest";
import { catchAllService, createCloudflareApi, routeNames, withoutRoute, withRoute } from "./cloudflare-api.mjs";
import { tunnelNameFor } from "./cloudflare-tunnel.mjs";
import { createFakeCloudflare, fakeAccount } from "../test/fake-cloudflare.mjs";

const token = "cf-test-token-0000000000000000000000";

describe("the Cloudflare client (M42)", () => {
  it("lists the active domains with their account, page by page, sending the token only as a bearer header", async () => {
    const zones = Array.from({ length: 60 }, (_, index) => ({ id: `zone${String(index).padStart(28, "0")}`, name: `example${index}.com`, account: fakeAccount }));
    const cloudflare = createFakeCloudflare({ token, zones });
    const api = createCloudflareApi({ token, fetcher: cloudflare.fetcher });
    const listed = await api.listZones();
    expect(listed).toHaveLength(60);
    expect(listed[0]).toEqual({ id: zones[0].id, name: "example0.com", account: fakeAccount });
    expect(cloudflare.calls.map((call) => call.query)).toEqual([{ per_page: "50", status: "active", page: "1" }, { per_page: "50", status: "active", page: "2" }]);
    // Never chased to another host with the token on board.
    expect(cloudflare.calls.every((call) => call.redirect === "manual")).toBe(true);
    expect(JSON.stringify(cloudflare.calls)).not.toContain(token);
  });

  it("says a refused token in plain words, and never repeats it", async () => {
    const cloudflare = createFakeCloudflare({ token: "the-right-token-000000000000" });
    const api = createCloudflareApi({ token, fetcher: cloudflare.fetcher });
    const error = await api.listZones().catch((caught) => caught);
    expect(error.message).toMatch(/^Cloudflare did not accept this token while listing your domains/);
    expect(error.message).toContain("Account · Cloudflare Tunnel · Edit");
    expect(error.message).not.toContain(token);
    const answering = (status) => createCloudflareApi({ token, fetcher: async () => new Response(JSON.stringify({ success: false, errors: [{ code: 10000, message: "Authentication error" }] }), { status }) });
    const forbidden = answering(403);
    await expect(forbidden.findTunnel(fakeAccount.id, "boxpilot-x")).rejects.toThrow(/did not accept this token while looking for the tunnel/);
    // The step says which of the three it needed: a token that reads tunnels and cannot make one is told Edit, not Read.
    await expect(forbidden.findTunnel(fakeAccount.id, "boxpilot-x")).rejects.toThrow(/This step needs Account · Cloudflare Tunnel · Edit\. Check/);
    await expect(forbidden.createTunnel(fakeAccount.id, "boxpilot-x")).rejects.toThrow(/while making the tunnel\. This step needs Account · Cloudflare Tunnel · Edit\. A token that may only read tunnels/);
    await expect(forbidden.listZones()).rejects.toThrow(/This step needs Zone · Zone · Read\./);
    // Reading the tunnel's key is a GET, and needs Edit as making one does.
    await expect(forbidden.tunnelRunKey(fakeAccount.id, "tunnel-1")).rejects.toThrow(/while reading the tunnel's key\. This step needs Account · Cloudflare Tunnel · Edit\. A token that may only read tunnels gets this far and no further: the permission must be Edit, not Read\./);
  });

  it("says a token Cloudflare does not know was not recognised, not that a permission is missing", async () => {
    const unknown = createCloudflareApi({ token, fetcher: async () => new Response(JSON.stringify({ success: false, errors: [{ code: 10000, message: "Authentication error" }] }), { status: 401 }) });
    for (const refused of [unknown.listZones(), unknown.createTunnel(fakeAccount.id, "boxpilot-x"), unknown.tunnelRunKey(fakeAccount.id, "tunnel-1")]) {
      const error = await refused.catch((caught) => caught);
      expect(error).toMatchObject({ status: 401, code: 10000 });
      expect(error.message).toMatch(/^Cloudflare did not accept this token while .+: it was not recognised, so it may have been revoked or not pasted whole\. Paste it again, or make a new one with the three permissions \(/);
      expect(error.message).not.toMatch(/This step needs|Edit, not Read/);
      expect(error.message).not.toContain(token);
    }
  });

  it("scrubs the token out of anything Cloudflare or the network says back", async () => {
    const echo = createCloudflareApi({ token, fetcher: async () => new Response(JSON.stringify({ success: false, errors: [{ code: 7003, message: `Could not route to ${token}` }] }), { status: 400 }) });
    const error = await echo.listZones().catch((caught) => caught);
    expect(error.message).toBe("Cloudflare refused listing your domains: Could not route to [token] (code 7003)");
    const unreachable = createCloudflareApi({ token, fetcher: async () => { throw Object.assign(new Error(`fetch failed ${token}`), { cause: { code: "ENOTFOUND" } }); } });
    await expect(unreachable.listZones()).rejects.toThrow("Could not reach Cloudflare while listing your domains (ENOTFOUND)");
    const redirected = createCloudflareApi({ token, fetcher: async () => new Response("", { status: 302, headers: { location: "https://elsewhere.example/" } }) });
    await expect(redirected.listZones()).rejects.toThrow(/redirect/);
  });

  it("makes a tunnel whose routes Cloudflare keeps, and reads its key", async () => {
    const cloudflare = createFakeCloudflare({ token });
    const api = createCloudflareApi({ token, fetcher: cloudflare.fetcher });
    expect(await api.findTunnel(fakeAccount.id, "boxpilot-homebox")).toBeNull();
    const made = await api.createTunnel(fakeAccount.id, "boxpilot-homebox");
    expect(made).toMatchObject({ name: "boxpilot-homebox", remoteConfig: true, runKey: cloudflare.runKey });
    expect(cloudflare.calls.at(-1)).toMatchObject({ method: "POST", route: `/accounts/${fakeAccount.id}/cfd_tunnel`, body: { name: "boxpilot-homebox", config_src: "cloudflare" } });
    expect(await api.findTunnel(fakeAccount.id, "boxpilot-homebox")).toMatchObject({ id: made.id });
    expect(await api.tunnelRunKey(fakeAccount.id, made.id)).toBe(cloudflare.runKey);
  });

  // M65.3: a tunnel BoxPilot did not make is read by its id, and may be set up from a file or deleted.
  it("reads one tunnel by its id, and says it is set up from a file or deleted only when Cloudflare does", async () => {
    const id = "11111111-1111-4111-8111-111111111111";
    const reading = async (fields) => {
      const cloudflare = createFakeCloudflare({ token, tunnels: [{ id, name: "home", account: fakeAccount.id, ...fields }] });
      return createCloudflareApi({ token, fetcher: cloudflare.fetcher }).tunnel(fakeAccount.id, id);
    };
    expect(await reading({ remote_config: true })).toMatchObject({ id, name: "home", remoteConfig: true, localConfig: false, deleted: false });
    expect(await reading({ config_src: "cloudflare", remote_config: false })).toMatchObject({ remoteConfig: true, localConfig: false });
    expect(await reading({ config_src: "local" })).toMatchObject({ remoteConfig: false, localConfig: true });
    expect(await reading({ remote_config: false })).toMatchObject({ remoteConfig: false, localConfig: true });
    expect(await reading({})).toMatchObject({ remoteConfig: false, localConfig: false });
    expect(await reading({ remote_config: true, deleted_at: "2026-09-01T00:00:00Z" })).toMatchObject({ deleted: true });
    // In another account, or not there: an error that carries the status, which Connect reads as "cannot reach".
    const cloudflare = createFakeCloudflare({ token, accounts: [fakeAccount.id] });
    const api = createCloudflareApi({ token, fetcher: cloudflare.fetcher });
    await expect(api.tunnel(fakeAccount.id, id)).rejects.toMatchObject({ name: "CloudflareError", status: 404 });
    await expect(api.tunnel("fedcba9876543210fedcba9876543210", id)).rejects.toMatchObject({ name: "CloudflareError", status: 403 });
  });

  it("says which DNS records carry a comment, so BoxPilot's own can be told from the owner's", async () => {
    const zone = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const cloudflare = createFakeCloudflare({ token, records: [{ id: "recTheirs", zone, type: "CNAME", name: "www.example.com", content: "x.cfargotunnel.com", proxied: true }] });
    const api = createCloudflareApi({ token, fetcher: cloudflare.fetcher });
    expect(await api.dnsRecords(zone, "www.example.com")).toEqual([{ id: "recTheirs", type: "CNAME", name: "www.example.com", content: "x.cfargotunnel.com", proxied: true, comment: "" }]);
    const made = await api.createCname(zone, { name: "share.example.com", target: "x.cfargotunnel.com", comment: "BoxPilot: pingvin-share" });
    expect(await api.dnsRecords(zone, "share.example.com")).toEqual([made]);
    expect(made.comment).toBe("BoxPilot: pingvin-share");
  });

  it("names the tunnel after the server, made safe", () => {
    expect(tunnelNameFor("HomeBox")).toBe("boxpilot-homebox");
    expect(tunnelNameFor("home_box.lan")).toBe("boxpilot-home-box");
    expect(tunnelNameFor("")).toBe("boxpilot-server");
    expect(tunnelNameFor("x".repeat(80))).toBe(`boxpilot-${"x".repeat(40)}`);
  });
});

describe("a tunnel's routes", () => {
  const foreign = { hostname: "wiki.example.com", service: "http://192.0.2.5:8080" };
  const pathRule = { hostname: "share.example.com", path: "^/api/admin", service: "http_status:403" };

  it("start with BoxPilot's route and the catch-all when the tunnel has none", () => {
    expect(withRoute(null, { hostname: "share.example.com", service: "http://127.0.0.1:3022" })).toEqual([
      { hostname: "share.example.com", service: "http://127.0.0.1:3022", originRequest: {} },
      { service: catchAllService },
    ]);
  });

  it("keep every rule BoxPilot did not make, in order, with the owner's own catch-all last", () => {
    const ingress = [foreign, { service: "http_status:503" }];
    const next = withRoute(ingress, { hostname: "share.example.com", service: "http://127.0.0.1:3022" });
    expect(next).toEqual([foreign, { hostname: "share.example.com", service: "http://127.0.0.1:3022", originRequest: {} }, { service: "http_status:503" }]);
    expect(routeNames(next)).toEqual(["wiki.example.com", "share.example.com"]);
  });

  it("replace a rule for the same name where it stood, leaving a rule for one of its paths alone", () => {
    const ingress = [pathRule, { hostname: "share.example.com", service: "http://127.0.0.1:9999" }, foreign, { service: catchAllService }];
    const next = withRoute(ingress, { hostname: "Share.Example.com", service: "https://127.0.0.1:3022", originRequest: { noTLSVerify: true } });
    expect(next).toEqual([pathRule, { hostname: "Share.Example.com", service: "https://127.0.0.1:3022", originRequest: { noTLSVerify: true } }, foreign, { service: catchAllService }]);
  });

  it("drop only BoxPilot's rule when it is taken out, and always end with a catch-all", () => {
    const ingress = [{ hostname: "share.example.com", service: "http://127.0.0.1:3022" }, foreign, pathRule];
    expect(withoutRoute(ingress, "share.example.com")).toEqual([foreign, pathRule, { service: catchAllService }]);
    expect(withoutRoute([{ hostname: "share.example.com", service: "x" }, { service: catchAllService }], "share.example.com")).toEqual([{ service: catchAllService }]);
  });
});
