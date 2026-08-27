import { describe, expect, it } from "vitest";
import { parseExit, parseForwardedPort } from "./vpn-exit.mjs";

describe("reading the tunnel exit from gluetun's own log", () => {
  const log = [
    "2026-08-27T13:32:55Z INFO [wireguard] Wireguard setup is complete.",
    "2026-08-27T13:33:05Z INFO [ip getter] Public IP address is 212.92.104.227 (Netherlands, North Brabant, Breda - source: ipinfo+ifconfig.co)",
    "2026-08-27T13:33:05Z ERROR [vpn] getting public IP address information: persisting public ip address: open /tmp/gluetun/ip: permission denied",
  ].join("\n");

  it("finds the newest exit line and keeps only the place", () => {
    expect(parseExit(log)).toEqual({ ip: "212.92.104.227", location: "Netherlands, North Brabant, Breda", at: "2026-08-27T13:33:05Z" });
  });

  it("takes the last report when the tunnel reconnected", () => {
    const twice = log + "\n2026-08-27T14:10:00Z INFO [ip getter] Public IP address is 185.107.56.1 (Switzerland, Zurich - source: ipinfo)";
    expect(parseExit(twice)?.ip).toBe("185.107.56.1");
    expect(parseExit(twice)?.location).toBe("Switzerland, Zurich");
  });

  it("answers null before the tunnel has reported anything", () => {
    expect(parseExit("2026-08-27T13:32:55Z INFO starting")).toBeNull();
    expect(parseExit("")).toBeNull();
  });
});

describe("the forwarded port, from the same log", () => {
  it("reads the newest port and reports null when forwarding is off or unproven", () => {
    const log = [
      "2026-08-27T13:33:05Z INFO [ip getter] Public IP address is 212.92.104.227 (Netherlands)",
      "2026-08-27T13:33:20Z INFO [port forwarding] port forwarded is 41956",
      "2026-08-27T18:01:00Z INFO [port forwarding] port forwarded is 52001",
    ].join("\n");
    expect(parseForwardedPort(log)).toBe(52001);          // a reconnect can change it; newest wins
    expect(parseForwardedPort("nothing about ports")).toBeNull();
    expect(parseForwardedPort("")).toBeNull();
  });
});
