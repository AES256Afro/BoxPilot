/**
 * Where the Open buttons point.
 *
 * Both places that build these links had the same defect, and fixing one left the other pointing
 * at an address the browser could not reach — which is what this shared helper exists to stop.
 */
import { describe, expect, it } from "vitest";
import { appUrl, hostForAppLinks, appAddresses } from "./appLinks";

describe("choosing the host", () => {
  it("uses the address the page was reached on", () => {
    // That address demonstrably reaches this server: BoxPilot itself just came down it. Preferring
    // the LAN address sent every link into a network the browser may have no route to.
    expect(hostForAppLinks("192.168.1.10", "box.tail1234.ts.net")).toBe("box.tail1234.ts.net");
    expect(hostForAppLinks("192.168.1.10", "192.168.1.10")).toBe("192.168.1.10");
  });

  it("falls back to the LAN address only when the page came from loopback", () => {
    // Through an SSH tunnel the browser's host says nothing useful about where the apps are.
    expect(hostForAppLinks("192.168.1.10", "localhost")).toBe("192.168.1.10");
    expect(hostForAppLinks("192.168.1.10", "127.0.0.1")).toBe("192.168.1.10");
    expect(hostForAppLinks(null, "localhost")).toBe("localhost");
  });
});

describe("building an application URL", () => {
  const web = { host: 8096, exposure: "lan" };

  it("uses the HTTPS address for an app published on the tailnet", () => {
    // Tailscale Serve holds that port for HTTPS and answers plain HTTP with a 400.
    const serves = [{ dnsName: "box.tail1234.ts.net", port: 8096 }];
    expect(appUrl(web, { serves, browserHost: "box.tail1234.ts.net", lanAddress: "192.168.1.10" })).toBe("https://box.tail1234.ts.net:8096");
    // Even when the page was opened on loopback, the served address is the one that works.
    expect(appUrl(web, { serves, browserHost: "localhost", lanAddress: "192.168.1.10" })).toBe("https://box.tail1234.ts.net:8096");
  });

  it("keeps a loopback-only app on loopback, and honours an app that speaks HTTPS itself", () => {
    expect(appUrl({ host: 8085, exposure: "loopback" }, { browserHost: "box.tail1234.ts.net" })).toBe("http://127.0.0.1:8085");
    // Self-signed HTTPS on the preloaded ts.net name is refused with no bypass button; on the
    // short name the browser shows its ordinary warning and lets the owner through.
    expect(appUrl({ host: 9443, exposure: "lan" }, { browserHost: "box.tail1234.ts.net", https: true })).toBe("https://box:9443");
  });
});

describe("a sign-in page off the root", () => {
  it("lands on the app's sign-in path, on the LAN and on the tailnet alike", () => {
    // Pi-hole answers at /admin/; a link to the root is a link to a redirect at best.
    expect(appUrl({ host: 8084, exposure: "lan", path: "/admin/" }, { lanAddress: "192.168.1.10", browserHost: "192.168.1.10" })).toBe("http://192.168.1.10:8084/admin/");
    expect(appUrl({ host: 8084, exposure: "lan", path: "/admin/" }, { serves: [{ dnsName: "homebox.example.ts.net", port: 8084 }], browserHost: "homebox.example.ts.net" })).toBe("https://homebox.example.ts.net:8084/admin/");
    expect(appUrl({ host: 8084, exposure: "lan", path: null }, { browserHost: "192.168.1.10" })).toBe("http://192.168.1.10:8084");
  });
});

describe("every way to reach an app, not one guess", () => {
  const web = { host: 8096, exposure: "lan" as const, path: null };
  const options = { lanAddress: "192.168.1.10", tailnetDnsName: "homebox.tail0a1b.ts.net", browserHost: "192.168.1.10" };

  it("offers the LAN address and the short tailnet name, labelled", () => {
    // The full …ts.net name is on the browsers' HSTS preload list: a plain http link on it is
    // rewritten to https and opens nothing, and a self-signed https on it is refused with no
    // bypass. Every plain port therefore links the short MagicDNS name instead.
    const found = appAddresses(web, options);
    expect(found.map((address) => [address.kind, address.url])).toEqual([
      ["lan", "http://192.168.1.10:8096"],
      ["tailnet", "http://homebox:8096"],
    ]);
    expect(found[0].caveat).toBeNull();
    expect(found[1].caveat).toMatch(/needs Tailscale/);
  });

  it("never offers a plain-http link on the full ts.net name, even as the arrival route", () => {
    // Reached over Serve's HTTPS, the same hostname on an app's plain port is a dead link.
    const overTailnet = appAddresses(web, { ...options, browserHost: "homebox.tail0a1b.ts.net" });
    expect(overTailnet.map((address) => address.url)).toEqual(["http://192.168.1.10:8096", "http://homebox:8096"]);
    expect(overTailnet.find((address) => address.reachedThisPageBy)?.url).toBe("http://homebox:8096");
    expect(appUrl(web, { ...options, browserHost: "homebox.tail0a1b.ts.net" })).toBe("http://homebox:8096");
  });

  it("marks the one that demonstrably works, because this page arrived on it", () => {
    const overTailnet = appAddresses(web, { ...options, browserHost: "homebox.tail0a1b.ts.net" });
    expect(overTailnet.find((address) => address.reachedThisPageBy)?.kind).toBe("tailnet");
    expect(appAddresses(web, options).find((address) => address.reachedThisPageBy)?.kind).toBe("lan");
  });

  it("uses the HTTPS address when Serve holds the port, not a plain link that answers 400", () => {
    const found = appAddresses(web, { ...options, serves: [{ dnsName: "homebox.tail0a1b.ts.net", port: 8096 }] });
    expect(found[0]).toMatchObject({ kind: "tailnet-https", url: "https://homebox.tail0a1b.ts.net:8096" });
    // and it is not also offered over plain http, which would be a dead link beside a live one
    expect(found.filter((address) => address.kind === "tailnet")).toHaveLength(0);
  });

  it("does not offer a LAN address for a port that moved to the tailnet", () => {
    // "Reach only through Tailscale" binds the tailnet address; the LAN form is a dead link.
    const found = appAddresses({ host: 8115, exposure: "tailnet", path: null }, options);
    expect(found.map((address) => address.url)).toEqual(["http://homebox:8115"]);
  });

  it("does not offer a LAN address for a port bound to loopback", () => {
    // This is the lie worth avoiding: the app is running, the link looks fine, nothing connects.
    const found = appAddresses({ host: 8084, exposure: "loopback", path: "/admin/" }, options);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ kind: "loopback", url: "http://127.0.0.1:8084/admin/" });
    expect(found[0].caveat).toMatch(/not reachable from other devices/);
  });

  it("keeps the app's own path, so the link lands on the sign-in page", () => {
    const found = appAddresses({ host: 80, exposure: "lan", path: "/admin/" }, options);
    expect(found[0].url).toBe("http://192.168.1.10:80/admin/");
  });

  it("keeps a route that is neither the LAN address nor the tailnet name", () => {
    // Reached through a hostname, an mDNS name or a reverse proxy: that route provably works, so
    // dropping it in favour of two addresses that may not is the wrong trade.
    const found = appAddresses(web, { ...options, browserHost: "homebox.local" });
    expect(found[0]).toMatchObject({ url: "http://homebox.local:8096", reachedThisPageBy: true });
    expect(found.map((address) => address.kind)).toContain("lan");
  });
});

describe("browsing BoxPilot from the server itself", () => {
  it("does not offer loopback as a way to reach an app from elsewhere", () => {
    // Sitting at the server says nothing about how the rest of the network gets to the app, so
    // 127.0.0.1 must not head a list whose whole purpose is reaching it from somewhere else.
    const found = appAddresses({ host: 8096, exposure: "lan", path: null }, {
      lanAddress: "192.168.1.10", tailnetDnsName: "homebox.tail0a1b.ts.net", browserHost: "127.0.0.1",
    });
    expect(found.map((address) => address.kind)).toEqual(["lan", "tailnet"]);
    expect(found.some((address) => address.url.includes("127.0.0.1"))).toBe(false);
  });
});
