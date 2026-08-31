import { describe, expect, it } from "vitest";
import { buildReachability, portsHeldByApp } from "./host.mjs";

/**
 * Reconfiguring an installed app must not report it conflicting with itself. This went wrong for
 * the one kind of app where it matters most: a DNS server could never be reconfigured, because the
 * check asked which links were worth opening in a browser rather than which ports it holds.
 */
const piHole = {
  id: "pi-hole",
  ports: [
    { id: "dns-tcp", label: "DNS (TCP)", host: 53, protocol: "tcp", tailnet: "unchanged" },
    { id: "dns-udp", label: "DNS (UDP)", host: 53, protocol: "udp", tailnet: "unchanged" },
    { id: "web", label: "Admin UI", host: 8084, protocol: "tcp", tailnet: "serve" },
  ],
};
const installed = (ports) => ({ id: "pi-hole", installed: true, state: { values: { ports } }, urls: [{ id: "web", host: 8084 }] });

describe("the ports an app already holds", () => {
  it("includes UDP, which is what broke Pi-hole", () => {
    const held = portsHeldByApp(piHole, installed({ "dns-tcp": 53, "dns-udp": 53, web: 8084 }));
    expect(held.has("53/udp")).toBe(true);
    expect(held.has("53/tcp")).toBe(true);
    expect(held.has("8084/tcp")).toBe(true);
  });

  it("does not depend on urls, which leaves out everything that is not a web link", () => {
    // `urls` here lists only 8084. Reading it was the bug: 53/tcp and 53/udp were absent from it,
    // so Pi-hole was told its own DNS ports were taken and Apply refused every time.
    const own = installed({ "dns-tcp": 53, "dns-udp": 53, web: 8084 });
    expect(own.urls.map((url) => url.host)).toEqual([8084]);
    expect(portsHeldByApp(piHole, own).has("53/tcp")).toBe(true);
  });

  it("follows the ports the owner actually chose, not the manifest defaults", () => {
    const held = portsHeldByApp(piHole, installed({ "dns-tcp": 5353, "dns-udp": 5353, web: 9000 }));
    expect([...held].sort()).toEqual(["5353/tcp", "5353/udp", "9000/tcp"]);
  });

  it("falls back to the manifest port when a value was never stored", () => {
    expect(portsHeldByApp(piHole, installed({})).has("53/udp")).toBe(true);
  });

  it("holds nothing for an app that is not installed", () => {
    expect(portsHeldByApp(piHole, { id: "pi-hole", installed: false, state: null }).size).toBe(0);
    expect(portsHeldByApp(piHole, null).size).toBe(0);
  });
});

describe("every way to reach the control plane (M18.3)", () => {
  const tls = { provisioned: true, port: 8443, names: ["boxpilot.lan", "bigbox"], ipAddresses: ["192.168.50.20"] };

  it("shows only loopback when bound to localhost and Serve is not publishing us", () => {
    const result = buildReachability({ webHost: "127.0.0.1", webPort: 8787, lanIp: "192.168.50.20", dnsName: "homebox.example.ts.net", tls: { provisioned: false }, servePublished: false });
    expect(result.ways.map((way) => way.id)).toEqual(["loopback"]);
    expect(result.onLan).toBe(false);
  });

  it("adds the plain LAN URL once bound to the network", () => {
    const result = buildReachability({ webHost: "0.0.0.0", webPort: 8787, lanIp: "192.168.50.20", dnsName: null, tls: { provisioned: false }, servePublished: false });
    const lan = result.ways.find((way) => way.id === "lan");
    expect(lan.url).toBe("http://192.168.50.20:8787");
    expect(lan.encrypted).toBe(false);
    expect(lan.trusted).toBe(false);
  });

  it("adds an encrypted LAN URL per certificate name and address, but only when bound to the LAN", () => {
    const off = buildReachability({ webHost: "127.0.0.1", webPort: 8787, lanIp: "192.168.50.20", dnsName: null, tls, servePublished: false });
    expect(off.ways.some((way) => way.id.startsWith("lan-https"))).toBe(false); // loopback bind: no LAN HTTPS
    const on = buildReachability({ webHost: "0.0.0.0", webPort: 8787, lanIp: "192.168.50.20", dnsName: null, tls, servePublished: false });
    const https = on.ways.filter((way) => way.id.startsWith("lan-https"));
    expect(https.map((way) => way.url)).toEqual(["https://boxpilot.lan:8443", "https://bigbox:8443", "https://192.168.50.20:8443"]);
    expect(https.every((way) => way.encrypted && !way.trusted)).toBe(true);
  });

  it("adds the Tailscale URL only when Serve publishes us and there is a tailnet name", () => {
    const withoutServe = buildReachability({ webHost: "0.0.0.0", webPort: 8787, lanIp: null, dnsName: "homebox.example.ts.net", tls: { provisioned: false }, servePublished: false });
    expect(withoutServe.ways.some((way) => way.id === "tailnet")).toBe(false);
    const withServe = buildReachability({ webHost: "0.0.0.0", webPort: 8787, lanIp: null, dnsName: "homebox.example.ts.net", tls: { provisioned: false }, servePublished: true });
    const tailnet = withServe.ways.find((way) => way.id === "tailnet");
    expect(tailnet.url).toBe("https://homebox.example.ts.net");
    expect(tailnet.encrypted && tailnet.trusted).toBe(true);
  });
});

describe("GET /tls/ca.crt", () => {
  // The CA certificate is public and installing it is the whole point; the CA *key* is 0600 and
  // root-owned and must never be reachable. The filename is fixed in the route for that reason.
  const setup = async () => {
    const [{ default: express }, { createHostRouter }, { mkdtemp, writeFile }, os, path] = await Promise.all([
      import("express"), import("./host.mjs"), import("node:fs/promises"), import("node:os"), import("node:path"),
    ]);
    const tlsDir = await mkdtemp(path.default.join(os.default.tmpdir(), "boxpilot-tls-"));
    await writeFile(path.default.join(tlsDir, "ca.crt"), "-----BEGIN CERTIFICATE-----\nca\n-----END CERTIFICATE-----\n");
    await writeFile(path.default.join(tlsDir, "ca.key"), "-----BEGIN EC PRIVATE KEY-----\nSECRET\n-----END EC PRIVATE KEY-----\n");
    const app = express();
    app.use("/api/v1", createHostRouter({
      state: { getSetting: (_key, fallback) => fallback }, helper: { request: async () => ({}) },
      catalogService: { all: async () => ({ manifests: [], problems: [] }) }, inventory: { inspect: async () => ({}) },
      network: {}, controllerProtection: {}, controllerRetention: {}, githubProvenance: {}, releaseUpdates: {},
      setup: {}, supportBundle: {}, audit: {}, auth: { requireCsrf: (_q, _s, next) => next(), requireRole: () => (_q, _s, next) => next() },
      tlsDir,
    }));
    const server = app.listen(0);
    await new Promise((resolve) => server.once("listening", resolve));
    return { base: `http://127.0.0.1:${server.address().port}`, server, tlsDir };
  };

  it("serves the certificate as a download and has no path to the private key", async () => {
    const { base, server } = await setup();
    try {
      const response = await fetch(`${base}/api/v1/tls/ca.crt`);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-disposition")).toContain("boxpilot-ca.crt");
      expect(await response.text()).toContain("BEGIN CERTIFICATE");
      // No route spells any other filename, so the key cannot be requested at all.
      for (const attempt of ["ca.key", "ca.crt/../ca.key", "..%2Fca.key"]) {
        const leak = await fetch(`${base}/api/v1/tls/${attempt}`);
        expect(leak.status).toBe(404);
        expect(await leak.text()).not.toContain("SECRET");
      }
    } finally { server.close(); }
  });

  it("says so plainly when no certificate has been issued yet", async () => {
    const { base, server, tlsDir } = await setup();
    const { rm } = await import("node:fs/promises");
    const path = (await import("node:path")).default;
    await rm(path.join(tlsDir, "ca.crt"));
    try {
      const response = await fetch(`${base}/api/v1/tls/ca.crt`);
      expect(response.status).toBe(404);
      expect((await response.json()).code).toBe("tls_not_provisioned");
    } finally { server.close(); }
  });
});
