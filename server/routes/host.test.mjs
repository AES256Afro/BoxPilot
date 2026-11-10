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
  const tls = { provisioned: true, port: 8443, names: ["boxpilot.lan", "homebox"], ipAddresses: ["192.168.50.20"] };

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
    expect(https.map((way) => way.url)).toEqual(["https://boxpilot.lan:8443", "https://homebox:8443", "https://192.168.50.20:8443"]);
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


describe("the catalog summary view", () => {
  const manifest = { id: "qbittorrent", name: "qBittorrent", category: "Downloads", icon: "qb", website: "https://x", description: "d", image: { reference: "x:1", version: "1" },
    ports: [{ id: "web", label: "Web", host: 8080, protocol: "tcp", exposure: "lan", container: 8080 }],
    volumes: [{ id: "data", label: "Data", hostPath: "/mnt/dump", configurable: true, container: "/data" }, { id: "config", container: "/config", path: "config", backup: true }],
    env: [{ name: "BIG", default: "x".repeat(2000) }], notes: "long".repeat(500), setup: [{ step: 1 }], files: [{ path: "a" }], sha256: "f".repeat(64) };

  const serve = async ({ settings = {}, live = [], catalogService = { all: async () => ({ manifests: [manifest], problems: [] }) } } = {}) => {
    const [{ default: express }, { createHostRouter }] = await Promise.all([import("express"), import("./host.mjs")]);
    const app = express();
    app.use("/api/v1", createHostRouter({
      state: { getSetting: (key, fallback) => settings[key] ?? fallback }, helper: { request: async () => ({ applications: live }) },
      catalogService, inventory: { inspect: async () => ({}) },
      network: {}, controllerProtection: {}, controllerRetention: {}, githubProvenance: {}, releaseUpdates: {},
      setup: {}, supportBundle: {}, audit: {}, auth: { requireCsrf: (_q, _s, next) => next(), requireRole: () => (_q, _s, next) => next() },
    }));
    const server = app.listen(0);
    await new Promise((resolve) => server.once("listening", resolve));
    return { base: `http://127.0.0.1:${server.address().port}`, close: () => { server.closeAllConnections?.(); server.close(); } };
  };

  it("keeps what the five non-catalog pages read and drops the rest", async () => {
    const { base, close } = await serve();
    try {
      const full = await (await fetch(`${base}/api/v1/catalog`)).json();
      const summary = await (await fetch(`${base}/api/v1/catalog?view=summary`)).json();
      expect(full.applications[0].manifest.env).toBeTruthy();
      const slim = summary.applications[0].manifest;
      expect(slim).toMatchObject({ id: "qbittorrent", name: "qBittorrent", category: "Downloads", icon: "qb", image: { version: "1" } });
      expect(slim.volumes).toEqual([{ id: "data", label: "Data", hostPath: "/mnt/dump", configurable: true, readOnly: false }, { id: "config", label: null, hostPath: null, configurable: false, readOnly: false }]);
      // M36: whether an app backup archives anything of it, which the command bar reads.
      expect(slim.keepsBackup).toBe(true);
      expect(slim.ports[0]).toEqual({ id: "web", label: "Web", host: 8080, protocol: "tcp", exposure: "lan" });
      for (const dropped of ["env", "notes", "setup", "files", "sha256"]) expect(slim[dropped]).toBeUndefined();
      expect(JSON.stringify(summary).length).toBeLessThan(JSON.stringify(full).length / 4);
    } finally { close(); }
  });

  it("summarises a loaded catalog once, gives the same bytes every time, and matches each app's live row by id", async () => {
    // Every Overview and Storage load built every manifest's summary again and searched the live rows once per manifest.
    let summarised = 0;
    const counted = (id) => ({ ...manifest, id, name: id, get ports() { summarised += 1; return manifest.ports; } });
    let catalog = { manifests: [counted("alpha"), counted("beta"), counted("gamma")], problems: [] };
    const live = [{ id: "gamma", installed: true, container: { running: true } }, { id: "alpha", installed: true, container: { running: false } }, { id: "alpha", installed: false }, { id: "not-in-the-catalog", installed: true }];
    const { base, close } = await serve({ live, catalogService: { all: async () => catalog } });
    try {
      const first = await (await fetch(`${base}/api/v1/catalog?view=summary`)).text();
      expect(summarised).toBe(3);
      expect(await (await fetch(`${base}/api/v1/catalog?view=summary`)).text()).toBe(first);
      expect(summarised).toBe(3);
      const applications = JSON.parse(first).applications;
      expect(applications.map((entry) => [entry.manifest.id, entry.live?.installed ?? null, entry.live?.container?.running ?? null])).toEqual([["alpha", true, false], ["beta", null, null], ["gamma", true, true]]);
      expect(applications[1].live).toBeNull();
      // The full view is the manifests themselves, and is not what was held for the summary.
      const full = JSON.parse(await (await fetch(`${base}/api/v1/catalog`)).text());
      expect(full.applications[0].manifest.env).toBeTruthy();
      expect(full.applications.map((entry) => entry.live?.installed ?? null)).toEqual([true, null, true]);
      // The catalog loaded again (a manifest changed on disk) is summarised again.
      catalog = { manifests: [counted("alpha"), counted("delta")], problems: [] };
      summarised = 0;
      const reloaded = JSON.parse(await (await fetch(`${base}/api/v1/catalog?view=summary`)).text());
      expect(reloaded.applications.map((entry) => entry.manifest.id)).toEqual(["alpha", "delta"]);
      expect(summarised).toBe(2);
    } finally { close(); }
  });

  it("leaves the full manifest alone when no view is asked for", async () => {
    const { base, close } = await serve();
    try {
      const full = await (await fetch(`${base}/api/v1/catalog?view=everything-else`)).json();
      expect(full.applications[0].manifest.notes).toBeTruthy();
    } finally { close(); }
  });

  it("says which apps the owner stopped on purpose, so Home does not call them down", async () => {
    const stopped = { settings: { appStops: { qbittorrent: { at: "2026-09-28T22:11:09.000Z", by: "owner-1" } } }, live: [{ id: "qbittorrent", installed: true, container: { running: false, status: "exited" } }] };
    let server = await serve(stopped);
    try {
      const summary = await (await fetch(`${server.base}/api/v1/catalog?view=summary`)).json();
      expect(summary.applications[0].live.stoppedOnPurpose).toEqual({ at: "2026-09-28T22:11:09.000Z" });
    } finally { server.close(); }
    server = await serve({ live: stopped.live });
    try {
      const summary = await (await fetch(`${server.base}/api/v1/catalog?view=summary`)).json();
      expect(summary.applications[0].live.stoppedOnPurpose).toBeNull();
    } finally { server.close(); }
  });
});

describe("the install and settings precheck", () => {
  const serve = async ({ live = [], listeners = [] } = {}) => {
    const [{ default: express }, { createHostRouter }, { createCatalogService }] = await Promise.all([import("express"), import("./host.mjs"), import("../catalog/index.mjs")]);
    const app = express();
    app.use(express.json());
    app.use("/api/v1", createHostRouter({
      state: { getSetting: (_key, fallback) => fallback },
      helper: { request: async (operation) => (operation === "app.inspect" ? { applications: live } : { containers: [] }) },
      catalogService: createCatalogService(), inventory: { inspect: async () => ({}) },
      network: {}, controllerProtection: {}, controllerRetention: {}, githubProvenance: {}, releaseUpdates: {},
      setup: {}, supportBundle: {}, audit: {}, auth: { requireCsrf: (_q, _s, next) => next(), requireRole: () => (_q, _s, next) => next() },
      readListeners: async () => listeners,
    }));
    const server = app.listen(0);
    await new Promise((resolve) => server.once("listening", resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const precheck = async (id, values) => {
      const response = await fetch(`${base}/api/v1/catalog/${id}/precheck`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ values }) });
      return { status: response.status, body: await response.json() };
    };
    return { precheck, close: () => { server.closeAllConnections?.(); server.close(); } };
  };
  const installedApp = (id, values = { ports: {}, env: {}, volumes: {} }, extra = {}) => ({ id, installed: true, state: { values }, published: [], ...extra });

  // R2B3-3: saved settings never hold a secret, so the Settings form sends the Cloudflare Tunnel's
  // token blank, and the precheck refused what the change itself takes from the app's .env.
  it("takes a required secret of an installed app as the one it already has", async () => {
    const { precheck, close } = await serve({ live: [installedApp("cloudflared"), installedApp("cloudflare-ddns", { ports: {}, env: { DOMAINS: "home.example.com" }, volumes: {} })] });
    try {
      expect(await precheck("cloudflared", {})).toEqual({ status: 200, body: { ok: true, errors: [], conflicts: [] } });
      expect(await precheck("cloudflare-ddns", { env: { DOMAINS: "home.example.com", CLOUDFLARE_API_TOKEN: "" } })).toEqual({ status: 200, body: { ok: true, errors: [], conflicts: [] } });
      // A setting that is not a secret is still required.
      expect((await precheck("cloudflare-ddns", { env: {} })).body.errors).toEqual(["values.env.DOMAINS: is required"]);
    } finally { close(); }
  });

  it("still asks for it when the app is not installed", async () => {
    const { precheck, close } = await serve();
    try {
      expect(await precheck("cloudflared", {})).toEqual({ status: 400, body: { ok: false, errors: ["values.env.TUNNEL_TOKEN: is required"], conflicts: [] } });
      expect((await precheck("cloudflare-ddns", { env: { DOMAINS: "home.example.com" } })).body.errors).toEqual(["values.env.CLOUDFLARE_API_TOKEN: is required"]);
    } finally { close(); }
  });

  // R2B3-4: on the host's own network an app binds its container ports, not the ones it would publish.
  it("checks Pi-hole on the host network at the ports it binds there, not the ones it publishes on its own", async () => {
    const program = (port, address = "0.0.0.0") => ({ protocol: "tcp", address, port, scope: address === "0.0.0.0" ? "wildcard" : "loopback" });
    const { precheck, close } = await serve({ listeners: [program(53, "127.0.0.53"), program(80), program(8084)] });
    try {
      const host = await precheck("pi-hole", { networkMode: "host" });
      // Port 80 is its admin page's, which Pi-hole starts without: the install says so, it does not refuse.
      expect(host.body.conflicts.map((conflict) => `${conflict.port}/${conflict.protocol}`)).toEqual(["53/tcp"]);
      // On its own network it publishes 8084 for the admin page, and binds nothing on 80.
      const bridge = await precheck("pi-hole", { networkMode: "bridge" });
      expect(bridge.body.conflicts.map((conflict) => `${conflict.port}/${conflict.protocol}`)).toEqual(["53/tcp", "8084/tcp"]);
    } finally { close(); }
  });

  it("does not report Pi-hole on the host network as conflicting with itself", async () => {
    const own = installedApp("pi-hole", { ports: {}, env: {}, volumes: {}, networkMode: "host" }, {
      published: [{ id: "dns-tcp", host: 53, protocol: "tcp", bind: "*", hostNetwork: true }, { id: "dns-udp", host: 53, protocol: "udp", bind: "*", hostNetwork: true }, { id: "web", host: 80, protocol: "tcp", bind: "*", hostNetwork: true }],
    });
    const { precheck, close } = await serve({ live: [own], listeners: [{ protocol: "tcp", address: "0.0.0.0", port: 53, scope: "wildcard" }] });
    try {
      expect((await precheck("pi-hole", { networkMode: "host" })).body).toEqual({ ok: true, errors: [], conflicts: [] });
    } finally { close(); }
  });
});

describe("a port to use instead, with each conflict the precheck reports", () => {
  const program = (port, protocol = "tcp") => ({ protocol, address: "0.0.0.0", port, scope: "wildcard" });
  const serveWith = async (listeners) => {
    const [{ default: express }, { createHostRouter }, { createCatalogService }] = await Promise.all([import("express"), import("./host.mjs"), import("../catalog/index.mjs")]);
    const app = express();
    app.use(express.json());
    app.use("/api/v1", createHostRouter({
      state: { getSetting: (_key, fallback) => fallback }, helper: { request: async (operation) => (operation === "app.inspect" ? { applications: [] } : { containers: [] }) },
      catalogService: createCatalogService(), inventory: { inspect: async () => ({}) },
      network: {}, controllerProtection: {}, controllerRetention: {}, githubProvenance: {}, releaseUpdates: {},
      setup: {}, supportBundle: {}, audit: {}, auth: { requireCsrf: (_q, _s, next) => next(), requireRole: () => (_q, _s, next) => next() },
      readListeners: async () => listeners,
    }));
    const server = app.listen(0);
    await new Promise((resolve) => server.once("listening", resolve));
    const precheck = async (id, values) => (await (await fetch(`http://127.0.0.1:${server.address().port}/api/v1/catalog/${id}/precheck`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ values }) })).json()).conflicts.map((conflict) => [`${conflict.port}/${conflict.protocol}`, conflict.suggested]);
    return { precheck, close: () => { server.closeAllConnections?.(); server.close(); } };
  };

  it("is the next one above that nothing listens on, never below 1024, and none on the host's own network", async () => {
    // 8084 is Pi-hole's admin page; 8085 and 8086 are taken too. 53 is below 1024, and 1024 is in use.
    const { precheck, close } = await serveWith([program(53), program(53, "udp"), program(1024), program(8084), program(8085), program(8086)]);
    try {
      expect(await precheck("pi-hole", { networkMode: "bridge" })).toEqual([["53/tcp", 1025], ["53/udp", 1024], ["8084/tcp", 8087]]);
      expect(await precheck("pi-hole", { networkMode: "host" })).toEqual([["53/tcp", null], ["53/udp", null]]);
    } finally { close(); }
  });

  it("is not a port another part of the same install asks for, nor one already offered, and is null when none is near", async () => {
    // Both of Pi-hole's DNS ports moved to 5300 and its page to 5301: the page's port is spoken for,
    // so the first free one is 5302, for TCP and, separately, for UDP.
    const first = await serveWith([program(5300), program(5300, "udp")]);
    try {
      expect(await first.precheck("pi-hole", { networkMode: "bridge", ports: { "dns-tcp": 5300, "dns-udp": 5300, web: 5301 } })).toEqual([["5300/tcp", 5302], ["5300/udp", 5301]]);
    } finally { first.close(); }
    const full = await serveWith(Array.from({ length: 201 }, (_unused, index) => program(8084 + index)));
    try {
      expect(await full.precheck("pi-hole", { networkMode: "bridge" })).toEqual([["8084/tcp", null]]);
    } finally { full.close(); }
    const top = await serveWith([program(65535)]);
    try {
      expect(await top.precheck("pi-hole", { networkMode: "bridge", ports: { web: 65535 } })).toEqual([["65535/tcp", null]]);
    } finally { top.close(); }
  });
});

describe("the ports an app on the host network already holds", () => {
  it("are the ones it binds there, as the app's own record lists them", () => {
    const own = { installed: true, state: { values: { ports: {} } }, published: [{ id: "web", host: 80, protocol: "tcp", bind: "*", hostNetwork: true }] };
    expect(portsHeldByApp(piHole, own).has("80/tcp")).toBe(true);
  });
});