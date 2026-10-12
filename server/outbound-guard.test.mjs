import { describe, expect, it } from "vitest";
import { fetchGuarded, isLinkLocalAddress, linkLocalProblem } from "./outbound-guard.mjs";

const lookupOf = (table) => async (host) => {
  if (!(host in table)) throw Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" });
  return table[host].map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
};

describe("link-local addresses", () => {
  it("knows the range in every spelling", () => {
    for (const address of ["169.254.169.254", "169.254.0.1", "fe80::1", "FE80::abcd", "::ffff:169.254.169.254", "::ffff:a9fe:a9fe", "[::ffff:169.254.1.1]"]) expect(isLinkLocalAddress(address), address).toBe(true);
    for (const address of ["127.0.0.1", "10.1.2.3", "192.168.1.1", "100.64.0.1", "8.8.8.8", "::1", "fd00::1", "2001:db8::1", "::ffff:10.0.0.1", "not-an-address"]) expect(isLinkLocalAddress(address), address).toBe(false);
  });

  it("refuses a literal, a mapped literal, the metadata names and a name that resolves there; lets LAN, loopback and unknown names through", async () => {
    const lookup = lookupOf({ "meta.example": ["169.254.169.254"], "both.example": ["93.184.216.34", "fe80::1"], "kuma.lan": ["192.168.1.20"] });
    expect(await linkLocalProblem("http://169.254.169.254/latest", { lookup })).toMatch(/link-local/);
    expect(await linkLocalProblem("http://[::ffff:169.254.169.254]/", { lookup })).toMatch(/link-local/);
    expect(await linkLocalProblem("http://metadata.google.internal/computeMetadata", { lookup })).toMatch(/metadata/);
    expect(await linkLocalProblem("http://meta.example/", { lookup })).toMatch(/resolves to a link-local/);
    expect(await linkLocalProblem("http://both.example/", { lookup })).toMatch(/resolves to a link-local/);
    expect(await linkLocalProblem("http://kuma.lan:3001/api/push/abc", { lookup })).toBeNull();
    expect(await linkLocalProblem("http://127.0.0.1:8080/", { lookup })).toBeNull();
    expect(await linkLocalProblem("https://ntfy.sh/topic", { lookup })).toBeNull();
    expect(await linkLocalProblem("nope", { lookup })).toBe("is not an address");
  });
});

describe("fetchGuarded", () => {
  const redirect = (status, location) => new Response(null, { status, headers: { location } });

  it("checks every hop and refuses one that lands on link-local", async () => {
    const lookup = lookupOf({ "hooks.example": ["93.184.216.34"], "meta.example": ["169.254.169.254"] });
    const seen = [];
    const fetcher = async (url, options) => { seen.push([url, options.method ?? "GET", options.redirect]); return url.startsWith("https://hooks.example") ? redirect(302, "http://meta.example/latest") : new Response("ok"); };
    await expect(fetchGuarded("https://hooks.example/a", { method: "POST", body: "{}" }, { fetcher, lookup })).rejects.toThrow(/redirects to resolves to a link-local/);
    expect(seen).toEqual([["https://hooks.example/a", "POST", "manual"]]);
  });

  it("follows a safe redirect, as a GET without the body after a 303 or a 302 to a POST, and gives up after too many", async () => {
    const lookup = lookupOf({ "a.example": ["93.184.216.34"], "b.example": ["93.184.216.35"] });
    const seen = [];
    const fetcher = async (url, options) => { seen.push({ url, method: options.method ?? "GET", body: options.body ?? null, type: options.headers?.["Content-Type"] ?? null }); return url === "https://a.example/post" ? redirect(303, "https://b.example/done") : new Response("done", { status: 200 }); };
    const response = await fetchGuarded("https://a.example/post", { method: "POST", body: "{}", headers: { "Content-Type": "application/json", Title: "t" } }, { fetcher, lookup });
    expect(response.status).toBe(200);
    expect(seen).toEqual([{ url: "https://a.example/post", method: "POST", body: "{}", type: "application/json" }, { url: "https://b.example/done", method: "GET", body: null, type: null }]);
    const loop = async (url) => redirect(302, url.endsWith("/1") ? "https://a.example/2" : "https://a.example/1");
    await expect(fetchGuarded("https://a.example/1", {}, { fetcher: loop, lookup, maxRedirects: 3 })).rejects.toThrow(/Too many redirects/);
  });

  it("returns a 3xx as it is when told not to follow, so a credential never travels on", async () => {
    const lookup = lookupOf({ "a.example": ["93.184.216.34"] });
    const response = await fetchGuarded("https://a.example/x", { headers: { Authorization: "Bearer t" } }, { fetcher: async () => redirect(302, "https://evil.example/"), lookup, followRedirects: false });
    expect(response.status).toBe(302);
  });
});
