import { describe, expect, it } from "vitest";
import { portsHeldByApp } from "./host.mjs";

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
