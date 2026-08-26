import { describe, expect, it } from "vitest";
import { parseServeStatus, strandedServes } from "./tailscale-serve.mjs";

describe("reading what the tailnet publishes", () => {
  it("pulls the name, port and target out of serve status", () => {
    const status = JSON.stringify({ Web: { "host.ts.net:8096": { Handlers: { "/": { Proxy: "http://127.0.0.1:8096" } } } } });
    expect(parseServeStatus(status)).toEqual([{ dnsName: "host.ts.net", port: 8096, target: "http://127.0.0.1:8096" }]);
  });

  it("returns nothing rather than throwing on output it cannot read", () => {
    expect(parseServeStatus("not json")).toEqual([]);
    expect(parseServeStatus("{}")).toEqual([]);
  });
});

describe("tailnet addresses left behind", () => {
  const apps = [
    { id: "pi-hole", name: "Pi-hole", ports: [{ port: 80 }, { port: 53 }] },
    { id: "jellyfin", name: "Jellyfin", ports: [{ port: 8096 }] },
  ];

  it("finds the one pointing at a port its app no longer uses", () => {
    // Pi-hole moved from 8084 to 80 when it switched to host networking. Publishing recorded 8084
    // and nothing moved that record, so the tailnet address kept forwarding to a dead port — and
    // "stop publishing" withdraws the port the app has now, so it could not be reached at all.
    const stranded = strandedServes([
      { dnsName: "host", port: 8084, target: "http://127.0.0.1:8084" },
      { dnsName: "host", port: 8096, target: "http://127.0.0.1:8096" },
    ], apps);
    expect(stranded.map((serve) => serve.port)).toEqual([8084]);
  });

  it("leaves alone an address that still reaches its app", () => {
    expect(strandedServes([{ dnsName: "host", port: 80, target: "http://127.0.0.1:80" }], apps)).toEqual([]);
  });

  it("reads the port it forwards to, not only the port it answers on", () => {
    expect(strandedServes([{ dnsName: "host", port: 443, target: "http://127.0.0.1:8096" }], apps)).toEqual([]);
    expect(strandedServes([{ dnsName: "host", port: 443, target: "http://127.0.0.1:9999" }], apps).map((s) => s.port)).toEqual([443]);
  });

  it("accepts either shape an app's ports arrive in", () => {
    // The catalog carries `urls` with `host`; the helper carries `ports` with `port`.
    const viaUrls = [{ id: "jellyfin", name: "Jellyfin", urls: [{ host: 8096 }] }];
    expect(strandedServes([{ dnsName: "host", port: 8096, target: "http://127.0.0.1:8096" }], viaUrls)).toEqual([]);
  });

  it("says nothing when there is nothing published", () => {
    expect(strandedServes([], apps)).toEqual([]);
    expect(strandedServes()).toEqual([]);
  });
});
