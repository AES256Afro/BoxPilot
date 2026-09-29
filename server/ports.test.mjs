import { describe, expect, it } from "vitest";
import { bindCollides, containersPublishing, coversEveryAddress, findPortConflicts, freePortNear, holderWords, isTailnetAddress, parseListeners, portHolders } from "./ports.mjs";

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

  it("matches the address a container published when asked", () => {
    expect(containersPublishing(containers, 11434, "tcp", "127.0.0.1").map((c) => c.name)).toEqual(["llmcoach-ollama-1"]);
    expect(containersPublishing(containers, 11434, "tcp", "0.0.0.0")).toEqual([]);
    expect(containersPublishing(containers, 8080, "tcp", "::").map((c) => c.name)).toEqual(["bp-pihole"]);
  });
});

describe("which listener a publish collides with (the Dockge port trap, 2026-09-29)", () => {
  // As `ss -H -l -n -t -u -p` prints them from the root task: the process is the last column.
  const withProcesses = `tcp   LISTEN 0      4096     100.64.0.10:5001       0.0.0.0:*    users:(("tailscaled",pid=812,fd=33))
tcp   LISTEN 0      4096 [fd7a:115c:a1e0::a]:5001     [::]:*    users:(("tailscaled",pid=812,fd=34))
tcp   LISTEN 0      4096       127.0.0.1:8080       0.0.0.0:*    users:(("docker-proxy",pid=2201,fd=7))
udp   UNCONN 0      0      127.0.0.53%lo:53         0.0.0.0:*    users:(("systemd-resolve",pid=610,fd=13))
tcp   LISTEN 0      511                *:8443             *:*    users:(("nginx",pid=4242,fd=6),("nginx",pid=4243,fd=6))`;

  it("reads the process ss -p names, and the interface a socket is bound to", () => {
    const listeners = parseListeners(withProcesses);
    expect(listeners).toContainEqual({ protocol: "tcp", address: "100.64.0.10", port: 5001, scope: "address", process: { name: "tailscaled", pid: 812 } });
    expect(listeners).toContainEqual({ protocol: "tcp", address: "fd7a:115c:a1e0::a", port: 5001, scope: "address", process: { name: "tailscaled", pid: 812 } });
    expect(listeners).toContainEqual({ protocol: "udp", address: "127.0.0.53", port: 53, scope: "loopback", device: "lo", process: { name: "systemd-resolve", pid: 610 } });
    expect(listeners).toContainEqual({ protocol: "tcp", address: "*", port: 8443, scope: "wildcard", process: { name: "nginx", pid: 4242 } });
  });

  it("follows Linux: every address collides with any one address, two different addresses never do", () => {
    const at = (address) => ({ address });
    // The owner's server: Serve on the tailnet address, Docker publishing on every address.
    expect(bindCollides("0.0.0.0", at("100.64.0.10"))).toBe(true);
    // Why every other served app works: loopback and the tailnet address are two addresses.
    expect(bindCollides("127.0.0.1", at("100.64.0.10"))).toBe(false);
    expect(bindCollides("192.168.1.10", at("100.64.0.10"))).toBe(false);
    // An IPv4 publish and an IPv6-only socket share nothing; a dual-stack one holds both.
    expect(bindCollides("0.0.0.0", at("fd7a:115c:a1e0::a"))).toBe(false);
    expect(bindCollides("0.0.0.0", at("*"))).toBe(true);
    expect(bindCollides("127.0.0.1", at("0.0.0.0"))).toBe(true);
    // Compose with no address publishes on both families.
    expect(bindCollides("", at("::1"))).toBe(true);
    // Pi-hole's DNS against systemd-resolved's stub, the classic one.
    expect(bindCollides("0.0.0.0", at("127.0.0.53"))).toBe(true);
    expect(bindCollides("127.0.0.1", at("127.0.0.53"))).toBe(false);
    expect(bindCollides("0.0.0.0", at("::ffff:100.64.0.10"))).toBe(true);
  });

  it("finds only the collisions the kernel would refuse when the bind address is known", () => {
    const listeners = parseListeners(withProcesses);
    const [dockge] = findPortConflicts([{ id: "dockge", host: 5001, protocol: "tcp", bind: "0.0.0.0" }], listeners);
    expect(dockge).toMatchObject({ port: 5001, bind: "0.0.0.0", listeners: ["100.64.0.10:5001"] });
    expect(findPortConflicts([{ id: "dockge", host: 5001, protocol: "tcp", bind: "127.0.0.1" }], listeners)).toEqual([]);
    expect(findPortConflicts([{ id: "dns", host: 53, protocol: "udp", bind: "0.0.0.0" }], listeners)).toHaveLength(1);
  });

  it("names who holds it: Serve for this app, another app's container, or a process", () => {
    const listeners = parseListeners(withProcesses);
    const serves = [{ dnsName: "homebox.tailXXXX.ts.net", port: 5001, target: "http://127.0.0.1:5001" }];
    const [dockge] = findPortConflicts([{ id: "dockge", host: 5001, protocol: "tcp", bind: "0.0.0.0" }], listeners);
    const [serve] = portHolders(dockge, { serves, selfPorts: [5001] });
    expect(serve).toMatchObject({ kind: "serve", self: true, url: "https://homebox.tailXXXX.ts.net:5001" });
    expect(holderWords(serve, { appName: "Dockge" })).toBe("on the tailnet address (100.64.0.10) by Tailscale Serve, which publishes Dockge itself at https://homebox.tailXXXX.ts.net:5001");

    const containers = [{ name: "bp-ntfy", ports: "127.0.0.1:8080->80/tcp", app: "ntfy" }];
    const [web] = findPortConflicts([{ id: "web", host: 8080, protocol: "tcp", bind: "0.0.0.0" }], listeners);
    const [held] = portHolders(web, { containers });
    expect(holderWords(held, { appName: "Demo", nameOf: (id) => (id === "ntfy" ? "ntfy" : null) })).toBe("on this server's loopback address (127.0.0.1) by container bp-ntfy (ntfy)");
    // The app's own container is never a conflict with itself.
    expect(portHolders(web, { containers, own: (container) => container.app === "ntfy" })).toEqual([]);

    const [tls] = findPortConflicts([{ id: "tls", host: 8443, protocol: "tcp", bind: "127.0.0.1" }], listeners);
    expect(holderWords(portHolders(tls)[0], { appName: "Demo" })).toBe("on every address by process nginx (pid 4242)");
  });

  it("tells Serve from Tailscale by the address when ss could not name the process", () => {
    // The web service's own ss, without -p: the tailnet address says whose it is.
    const listeners = parseListeners("tcp   LISTEN 0      4096     100.64.0.10:5001       0.0.0.0:*");
    const [conflict] = findPortConflicts([{ id: "web", host: 5001, protocol: "tcp", bind: "" }], listeners);
    expect(portHolders(conflict, { serves: [{ dnsName: "homebox.tailXXXX.ts.net", port: 5001, target: "http://127.0.0.1:5001" }], selfPorts: [5001] })[0]).toMatchObject({ kind: "serve", self: true });
    expect(portHolders(conflict, { serves: [] })[0]).toMatchObject({ kind: "tailscale" });
    expect(isTailnetAddress("100.64.0.10")).toBe(true);
    expect(isTailnetAddress("100.128.0.1")).toBe(false);
    expect(coversEveryAddress("0.0.0.0")).toBe(true);
    expect(coversEveryAddress("")).toBe(true);
    expect(coversEveryAddress("127.0.0.1")).toBe(false);
  });

  it("offers the nearest port nothing uses", () => {
    const listeners = [{ protocol: "tcp", address: "0.0.0.0", port: 5002 }];
    expect(freePortNear(5001, { listeners, taken: new Set(["5003/tcp"]), serves: [{ port: 5004 }] })).toBe(5005);
    expect(freePortNear(5001, { protocol: "udp", listeners, taken: new Set(["5003/tcp"]) })).toBe(5002);
    expect(freePortNear(65535)).toBeNull();
  });
});
