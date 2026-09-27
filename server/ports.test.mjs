import { describe, expect, it } from "vitest";
import { containersPublishing, findPortConflicts, parseListeners } from "./ports.mjs";

const ss = `udp   UNCONN 0      0          127.0.0.54:53        0.0.0.0:*
udp   UNCONN 0      0      192.168.1.10:53        0.0.0.0:*
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

describe("port owners", () => {
  const containers = [
    { name: "llmcoach-ollama-1", ports: "127.0.0.1:11434->11434/tcp", app: null, composeProject: "llmcoach" },
    { name: "bp-pihole", ports: "0.0.0.0:53->53/udp, 0.0.0.0:53->53/tcp, [::]:8080->80/tcp", app: "pihole", composeProject: "bp-pihole" },
    { name: "range", ports: "0.0.0.0:6881-6889->6881-6889/tcp", app: null, composeProject: null },
  ];

  it("finds the container publishing a port, per protocol", () => {
    expect(containersPublishing(containers, 11434, "tcp")).toEqual([{ name: "llmcoach-ollama-1", app: null, composeProject: "llmcoach" }]);
    expect(containersPublishing(containers, 53, "udp").map((c) => c.name)).toEqual(["bp-pihole"]);
    expect(containersPublishing(containers, 8080, "tcp").map((c) => c.name)).toEqual(["bp-pihole"]);
    expect(containersPublishing(containers, 80, "tcp")).toEqual([]); // container side, not published
    expect(containersPublishing(containers, 1143, "tcp")).toEqual([]); // no prefix matches
    expect(containersPublishing(containers, 6881, "tcp").map((c) => c.name)).toEqual(["range"]);
  });

  it("attaches owners to conflicts only when the inventory is available", () => {
    const listeners = parseListeners("tcp   LISTEN 0      4096       127.0.0.1:11434      0.0.0.0:*");
    const requested = [{ id: "api", host: 11434, protocol: "tcp", exposure: "lan" }];
    expect(findPortConflicts(requested, listeners)[0].containers).toBeUndefined();
    expect(findPortConflicts(requested, listeners, containers)[0].containers[0].composeProject).toBe("llmcoach");
  });
});
