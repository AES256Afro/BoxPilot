import { describe, expect, it } from "vitest";
import { findPortConflicts, parseListeners } from "./ports.mjs";

const ss = `udp   UNCONN 0      0          127.0.0.54:53        0.0.0.0:*
udp   UNCONN 0      0      192.168.8.10:53        0.0.0.0:*
tcp   LISTEN 0      511       127.0.0.1:8787      0.0.0.0:*
tcp   LISTEN 0      4096         0.0.0.0:3000      0.0.0.0:*
tcp   LISTEN 0      4096            [::]:22           [::]:*
tcp   LISTEN 0      4096 [::ffff:100.1.2.3]:443   *:*`;

describe("port inventory", () => {
  it("parses ss output into listeners with scopes", () => {
    const listeners = parseListeners(ss);
    expect(listeners).toContainEqual({ protocol: "udp", address: "127.0.0.54", port: 53, scope: "loopback" });
    expect(listeners).toContainEqual({ protocol: "tcp", address: "0.0.0.0", port: 3000, scope: "wildcard" });
    expect(listeners).toContainEqual({ protocol: "tcp", address: "::", port: 22, scope: "wildcard" });
    expect(listeners).toContainEqual({ protocol: "tcp", address: "::ffff:100.1.2.3", port: 443, scope: "address" });
  });

  it("finds conflicts honouring exposure", () => {
    const listeners = parseListeners(ss);
    expect(findPortConflicts([{ id: "web", host: 3000, protocol: "tcp", exposure: "lan" }], listeners)).toEqual([{ id: "web", port: 3000, protocol: "tcp", listeners: ["0.0.0.0:3000"] }]);
    expect(findPortConflicts([{ id: "web", host: 3001, protocol: "tcp", exposure: "lan" }], listeners)).toEqual([]);
    expect(findPortConflicts([{ id: "api", host: 8787, protocol: "tcp", exposure: "loopback" }], listeners)).toHaveLength(1);
    expect(findPortConflicts([{ id: "dns", host: 53, protocol: "udp", exposure: "loopback" }], listeners)).toHaveLength(1);
    expect(findPortConflicts([{ id: "x", host: 443, protocol: "tcp", exposure: "loopback" }], listeners)).toEqual([]);
  });
});
