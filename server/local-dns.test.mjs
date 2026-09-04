import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createLocalDnsService, nameFor, parseHostsFile, renderHostsFile, managedHostsFile } from "./local-dns.mjs";

const directories = [];
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });

async function fixture({ piholeInstalled = true, running = true } = {}) {
  const catalogRoot = await mkdtemp(path.join(os.tmpdir(), "boxpilot-dns-"));
  directories.push(catalogRoot);
  // The hosts directory belongs to the DNS app's managed volume, and a person's own records live
  // beside BoxPilot's in custom.list.
  const hosts = path.join(catalogRoot, "pi-hole", "etc-pihole", "hosts");
  await mkdir(hosts, { recursive: true });
  await writeFile(path.join(hosts, "custom.list"), "# mine\n192.168.1.99 printer.lan\n");

  const applications = [
    ...(piholeInstalled ? [{ id: "pi-hole", name: "Pi-hole", installed: true, container: { running, status: running ? "running" : "exited" }, urls: [{ id: "web", host: 8084 }] }] : []),
    { id: "jellyfin", name: "Jellyfin", installed: true, container: { running: true, status: "running" }, urls: [{ id: "web", host: 8096 }] },
    { id: "immich", name: "Immich", installed: true, container: { running: true, status: "running" }, urls: [{ id: "web", host: 2283 }] },
    { id: "valkey", name: "Valkey", installed: true, container: { running: true, status: "running" }, urls: [] },       // nothing to open
    { id: "sonarr", name: "Sonarr", installed: false, container: { running: false, status: "absent" }, urls: [] },      // not installed
  ];
  const runDocker = vi.fn(async () => ({ ok: true, stdout: "", stderr: "" }));
  const service = createLocalDnsService({
    catalogRoot, runDocker, apps: { inspect: async () => ({ applications }) }, now: () => new Date("2026-08-25T18:00:00.000Z"),
  });
  return { service, catalogRoot, hosts, runDocker };
}

describe("naming the apps on this server", () => {
  it("makes a hostname per app and leaves out what cannot be opened", async () => {
    expect(nameFor("open-webui", "lan")).toBe("open-webui.lan");
    expect(nameFor("Pi_Hole", "home.arpa")).toBe("pi-hole.home.arpa");
    const { service } = await fixture();
    const report = await service.inspect();
    // Valkey has no web port and Sonarr is not installed, so neither gets a name.
    expect(report.apps.map((app) => app.id).sort()).toEqual(["immich", "jellyfin", "pi-hole"]);
  });

  it("writes its own file and never touches the records a person added", async () => {
    const { service, hosts } = await fixture();
    const result = await service.apply({ address: "192.168.1.10", domain: "lan" });
    expect(result.records.map((record) => record.name).sort()).toEqual(["immich.lan", "jellyfin.lan", "pi-hole.lan"]);

    const written = await readFile(path.join(hosts, managedHostsFile), "utf8");
    expect(written).toContain("192.168.1.10 jellyfin.lan");
    expect(written).toMatch(/^# Managed by BoxPilot/);

    // custom.list is where Pi-hole's own interface puts hand-written records. It stays exactly as it was.
    expect(await readFile(path.join(hosts, "custom.list"), "utf8")).toBe("# mine\n192.168.1.99 printer.lan\n");
  });

  it("rewrites the file rather than appending, so a removed app loses its name", async () => {
    const { service, hosts } = await fixture();
    await service.apply({ address: "192.168.1.10", domain: "lan" });
    await service.apply({ address: "192.168.1.10", domain: "lan", ids: ["jellyfin"] });
    const written = parseHostsFile(await readFile(path.join(hosts, managedHostsFile), "utf8"));
    expect(written).toEqual([{ address: "192.168.1.10", name: "jellyfin.lan" }]);
  });

  it("asks the DNS server to reload, and does not fail when it will not", async () => {
    const { service, runDocker } = await fixture();
    await service.apply({ address: "192.168.1.10", domain: "lan" });
    expect(runDocker.mock.calls[0][1]).toEqual(["exec", "bp-pi-hole", "pihole", "reloaddns"]);

    // dnsmasq watches the directory, so a refused reload is not a failed operation.
    const stubborn = await fixture();
    stubborn.runDocker.mockResolvedValue({ ok: false, stderr: "not running" });
    await expect(stubborn.service.apply({ address: "192.168.1.10", domain: "lan" })).resolves.toMatchObject({ applied: true, reloaded: false });
  });

  it("refuses an address that is not one, and a domain that is not offered", async () => {
    const { service } = await fixture();
    await expect(service.apply({ address: "not-an-address" })).rejects.toThrow("LAN address");
    await expect(service.apply({ address: "192.168.1.10", domain: "example.com" })).rejects.toThrow("Domain must be");
  });

  it("says what is missing when no DNS server is installed, rather than failing quietly", async () => {
    const { service } = await fixture({ piholeInstalled: false });
    const report = await service.inspect();
    expect(report).toMatchObject({ available: false, platform: null });
    expect(report.reason).toMatch(/Install Pi-hole/);
    await expect(service.apply({ address: "192.168.1.10" })).rejects.toThrow("No DNS server");
  });

  it("takes its own names back out without disturbing the rest", async () => {
    const { service, hosts } = await fixture();
    await service.apply({ address: "192.168.1.10", domain: "lan" });
    await service.clear();
    expect(await readFile(path.join(hosts, managedHostsFile), "utf8").catch(() => null)).toBeNull();
    expect(await readFile(path.join(hosts, "custom.list"), "utf8")).toContain("printer.lan");
  });

  it("reads back what is in force, ignoring comments and blank lines", () => {
    const text = renderHostsFile([{ address: "10.0.0.1", name: "a.lan" }, { address: "10.0.0.1", name: "b.lan" }], { generatedAt: "2026-08-25T18:00:00.000Z" });
    expect(parseHostsFile(text)).toEqual([{ address: "10.0.0.1", name: "a.lan" }, { address: "10.0.0.1", name: "b.lan" }]);
    expect(parseHostsFile("")).toEqual([]);
  });
});

describe("who is actually using the blocker", () => {
  const log = [
    "Aug 26 13:18:54 dnsmasq[52]: query[A] ipv6.msftconnecttest.com from 192.168.1.129",
    "Aug 26 13:18:54 dnsmasq[52]: cached ipv6.msftconnecttest.com is <CNAME>",
    "Aug 26 13:18:56 dnsmasq[52]: query[A] example.com from 192.168.1.129",
    "Aug 26 13:19:01 dnsmasq[52]: query[A] example.com from 192.168.1.10",
    "Aug 26 13:19:02 dnsmasq[52]: query[A] doubleclick.net from 127.0.0.1",
    "Aug 26 13:19:40 dnsmasq[52]: query[A] github.com from 192.168.1.55",
  ].join("\n");

  it("names the devices and leaves out this server's own checks", async () => {
    // BoxPilot's own verification queries come from loopback and the server's LAN address. Counting
    // those would report a blocker as busy on the strength of its own health checks.
    const { service, runDocker } = await fixture();
    runDocker.mockResolvedValue({ ok: true, stdout: log, stderr: "" });
    const report = await service.clients({ selfAddress: "192.168.1.10" });
    expect(report.clients).toEqual([{ address: "192.168.1.129", queries: 2 }, { address: "192.168.1.55", queries: 1 }]);
    expect(report.self).toBe(2);
    expect(runDocker.mock.calls[0][1]).toEqual(["exec", "bp-pi-hole", "tail", "-n", "4000", "/var/log/pihole/pihole.log"]);
  });

  it("reports nobody when nobody has asked, which is the case worth catching", async () => {
    // Healthy, answering, blocking — and every device on the network still pointed somewhere else.
    const { service, runDocker } = await fixture();
    runDocker.mockResolvedValue({ ok: true, stdout: "Aug 26 13:19:02 dnsmasq[52]: query[A] example.com from 127.0.0.1", stderr: "" });
    const report = await service.clients({ selfAddress: "192.168.1.10" });
    expect(report).toMatchObject({ available: true, clients: [], self: 1 });
  });

  it("says it could not read rather than claiming nobody uses it", async () => {
    const { service, runDocker } = await fixture();
    runDocker.mockResolvedValue({ ok: false, stdout: "", stderr: "no such file" });
    const report = await service.clients({});
    expect(report).toMatchObject({ available: false, clients: [] });
    expect(report.reason).toMatch(/Could not read/);
  });

  it("says the blocker is stopped rather than reading an empty log", async () => {
    const { service } = await fixture({ running: false });
    const report = await service.clients({});
    expect(report).toMatchObject({ available: false, clients: [] });
    expect(report.reason).toMatch(/not running/);
  });

  it("says what is missing when no blocker is installed", async () => {
    const { service } = await fixture({ piholeInstalled: false });
    expect(await service.clients({})).toMatchObject({ available: false, platform: null, clients: [] });
  });
});
