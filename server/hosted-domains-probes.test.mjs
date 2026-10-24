import http from "node:http";
import https from "node:https";
import { afterAll, describe, expect, it } from "vitest";
import { isCloudflareAddress, isPrivateAddress, probeUrl, resolveName } from "./hosted-domains-probes.mjs";
import { selfSignedCertificate } from "../test/self-signed-certificate.mjs";

const servers = [];
afterAll(async () => { await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve)))); });
async function listen(server) {
  servers.push(server);
  server.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  return server.address().port;
}

describe("telling Cloudflare's and the house's addresses apart", () => {
  it("knows Cloudflare's ranges, in both families", () => {
    expect(isCloudflareAddress("104.21.5.7")).toBe(true);
    expect(isCloudflareAddress("172.67.140.9")).toBe(true);
    expect(isCloudflareAddress("2606:4700:3030::ac43:8c09")).toBe(true);
    expect(isCloudflareAddress("93.184.216.34")).toBe(false);
    expect(isCloudflareAddress("172.16.0.1")).toBe(false); // 172.64/13 is Cloudflare's; 172.16/12 is the house's
    expect(isCloudflareAddress("not an address")).toBe(false);
  });

  it("knows the house: private, loopback, link-local, the tailnet's CGNAT range, and their IPv6 kin", () => {
    for (const address of ["10.1.2.3", "172.31.255.1", "192.168.50.20", "127.0.0.1", "169.254.169.254", "100.101.102.103", "::1", "fd7a:115c:a1e0::1", "fe80::1", "::ffff:192.168.1.10"]) expect(isPrivateAddress(address), address).toBe(true);
    for (const address of ["93.184.216.34", "104.21.5.7", "2606:4700::1", "8.8.8.8", "example.com", ""]) expect(isPrivateAddress(address), address).toBe(false);
  });
});

describe("resolving a name", () => {
  const failing = (code) => async () => { throw Object.assign(new Error(code), { code }); };
  it("gives the addresses of both families, and says a Cloudflare-only answer is one", async () => {
    const resolver = { resolve4: async () => ["104.21.5.7", "172.67.140.9"], resolve6: async () => ["2606:4700:3030::ac43:8c09"] };
    expect(await resolveName("news.example.com", { resolver })).toEqual({ resolved: true, addresses: ["104.21.5.7", "172.67.140.9", "2606:4700:3030::ac43:8c09"], viaCloudflare: true, private: false, error: null });
  });
  it("treats no records of one family as an answer, and none at all as not resolving", async () => {
    expect(await resolveName("v4.example.com", { resolver: { resolve4: async () => ["93.184.216.34"], resolve6: failing("ENODATA") } })).toMatchObject({ resolved: true, addresses: ["93.184.216.34"], viaCloudflare: false, private: false });
    expect(await resolveName("gone.example.com", { resolver: { resolve4: failing("ENOTFOUND"), resolve6: failing("ENOTFOUND") } })).toEqual({ resolved: false, addresses: [], viaCloudflare: false, private: false, error: "ENOTFOUND" });
    expect(await resolveName("broken.example.com", { resolver: { resolve4: failing("ESERVFAIL"), resolve6: failing("ENODATA") } })).toMatchObject({ resolved: false, error: "ESERVFAIL" });
  });
  it("keeps only addresses from a resolver's answer, and says a strange failure in words", async () => {
    expect(await resolveName("odd.example.com", { resolver: { resolve4: async () => ["93.184.216.34", "not an address", 5], resolve6: async () => "nothing" } })).toMatchObject({ resolved: true, addresses: ["93.184.216.34"] });
    expect(await resolveName("odd.example.com", { resolver: { resolve4: async () => { throw { code: 42 }; }, resolve6: async () => { throw "string"; } } })).toMatchObject({ resolved: false, error: "lookup failed" });
  });
  it("marks a name that points into the house", async () => {
    expect(await resolveName("inside.example.com", { resolver: { resolve4: async () => ["192.168.1.10"], resolve6: failing("ENODATA") } })).toMatchObject({ resolved: true, private: true, viaCloudflare: false });
  });
});

describe("one GET", () => {
  it("reports the status, the time and the server, and sends the public name as Host when asked", async () => {
    let seenHost = null;
    const port = await listen(http.createServer((request, response) => { seenHost = request.headers.host; response.setHeader("Server", "nginx"); response.writeHead(302, { Location: "/login" }); response.end(); }));
    const result = await probeUrl({ url: `http://127.0.0.1:${port}/`, hostHeader: "news.example.com", timeoutMs: 2000 });
    expect(result).toMatchObject({ outcome: "answered", status: 302, server: "nginx", tls: null, error: null });
    expect(result.ms).toBeGreaterThanOrEqual(0);
    expect(seenHost).toBe("news.example.com");
  });

  it("says when nothing listens, when nothing answers in time, and when the address is not one", async () => {
    const closed = http.createServer();
    const port = await listen(closed);
    await new Promise((resolve) => closed.close(resolve));
    servers.splice(servers.indexOf(closed), 1);
    expect(await probeUrl({ url: `http://127.0.0.1:${port}/`, timeoutMs: 2000 })).toMatchObject({ outcome: "refused", status: null, error: "nothing is listening" });
    const silent = await listen(http.createServer(() => { /* never answers */ }));
    expect(await probeUrl({ url: `http://127.0.0.1:${silent}/`, timeoutMs: 150 })).toMatchObject({ outcome: "timeout", status: null, error: "no answer within 0s" });
    expect(await probeUrl({ url: "ftp://example.com/", timeoutMs: 100 })).toMatchObject({ outcome: "error", error: "only http and https are probed" });
    expect(await probeUrl({ url: "not a url", timeoutMs: 100 })).toMatchObject({ outcome: "error", error: "not a valid address" });
  });

  it("reads the certificate an HTTPS server shows, and says a self-signed one is not trusted rather than refusing it", async () => {
    const now = Date.now();
    const { cert, key } = selfSignedCertificate({ commonName: "localhost", now });
    const port = await listen(https.createServer({ cert, key }, (_request, response) => { response.writeHead(200); response.end("ok"); }));
    const result = await probeUrl({ url: `https://127.0.0.1:${port}/`, hostHeader: "localhost", timeoutMs: 3000 });
    expect(result).toMatchObject({ outcome: "answered", status: 200 });
    expect(result.tls).toMatchObject({ subject: "localhost", issuer: "localhost", authorized: false });
    expect(typeof result.tls.authorizationError).toBe("string");
    // Valid until a day from its making, said as an ISO stamp the page can count days from.
    expect(Math.abs(Date.parse(result.tls.validTo) - (now + 86_400_000))).toBeLessThan(2000);
    expect(result.tls.validFrom).toBeTruthy();
    expect(JSON.stringify(result)).not.toContain("PRIVATE KEY");
  });
});
