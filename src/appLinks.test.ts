/**
 * Where the Open buttons point.
 *
 * Both places that build these links had the same defect, and fixing one left the other pointing
 * at an address the browser could not reach — which is what this shared helper exists to stop.
 */
import { describe, expect, it } from "vitest";
import { appUrl, hostForAppLinks } from "./appLinks";

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
    expect(appUrl({ host: 9443, exposure: "lan" }, { browserHost: "box.tail1234.ts.net", https: true })).toBe("https://box.tail1234.ts.net:9443");
  });
});
