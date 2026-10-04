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
    const forbidden = createCloudflareApi({ token, fetcher: async () => new Response(JSON.stringify({ success: false, errors: [{ code: 10000, message: "Authentication error" }] }), { status: 401 }) });
    await expect(forbidden.findTunnel(fakeAccount.id, "boxpilot-x")).rejects.toThrow(/did not accept this token while looking for the tunnel/);
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
