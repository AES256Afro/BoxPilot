import { describe, expect, it } from "vitest";
import { registry } from "./index.mjs";
import { canarySeen } from "./dns-resilience.mjs";
import { detectRemediations, dnsLeansOnThisServer } from "../remediations.mjs";
import { newCanary } from "../dns-resilience.mjs";

const pihole = { id: "pi-hole", label: "Pi-hole", queryLog: "/var/log/pihole/pihole.log", running: true };

describe("looking for the canary in the DNS app's log", () => {
  it("greps only for the names asked, and says which were there", async () => {
    const [first, second] = [newCanary(Buffer.alloc(8, 1)), newCanary(Buffer.alloc(8, 2))];
    const calls = [];
    const run = async (binary, args) => { calls.push([binary, ...args]); return { ok: true, code: 0, stdout: `${first}\n${first}\n` }; };
    expect(await canarySeen([first, second], { localDns: { internals: { platform: async () => pihole } }, run })).toEqual({ available: true, seen: { [first]: true, [second]: false } });
    expect(calls[0].slice(1)).toEqual(["exec", "bp-pi-hole", "grep", "-F", "-o", "-e", first, "-e", second, "/var/log/pihole/pihole.log"]);
    // grep's "nothing matched" is an answer; anything else is a log that could not be read.
    expect(await canarySeen([first], { localDns: { internals: { platform: async () => pihole } }, run: async () => ({ ok: false, code: 1, stdout: "" }) })).toEqual({ available: true, seen: { [first]: false } });
    expect(await canarySeen([first], { localDns: { internals: { platform: async () => pihole } }, run: async () => ({ ok: false, code: 2, stdout: "" }) })).toEqual({ available: false, seen: {} });
    expect(await canarySeen([first], { localDns: { internals: { platform: async () => ({ ...pihole, running: false }) } }, run })).toEqual({ available: false, seen: {} });
  });

  it("cannot be asked about any name but its own", () => {
    expect(registry.validate("dns.blocker.canary", { names: [newCanary()] })).toBeNull();
    expect(registry.validate("dns.blocker.canary", { names: ["doubleclick.net"] })).toMatch(/test names/);
    expect(registry.validate("dns.blocker.canary", { names: [newCanary(), newCanary(), newCanary()] })).toMatch(/test names/);
  });
});

describe("the rehearsal operation", () => {
  it("is a medium job that runs as a root task, for the DNS apps it knows", async () => {
    expect(registry.get("dns.fallback.rehearse")).toMatchObject({ risk: "medium", readOnly: false, minimumRole: null, rerunAfterInterrupt: false });
    expect(registry.validate("dns.fallback.rehearse", { router: "192.168.50.1", lanAddress: "192.168.50.20", app: "pi-hole" })).toBeNull();
    expect(registry.validate("dns.fallback.rehearse", { router: "192.168.50.1", lanAddress: "192.168.50.20", app: "jellyfin" })).toMatch(/must be one of/);
    const tasks = [];
    await registry.execute("dns.fallback.rehearse", { router: "192.168.50.1", lanAddress: "192.168.50.20", app: "pi-hole" }, { runUnit: { runTask: async (task, parameters, options) => { tasks.push({ task, parameters, timeoutMs: options.timeoutMs }); return {}; } } });
    expect(tasks).toEqual([{ task: "dns.fallback.rehearse", parameters: { router: "192.168.50.1", lanAddress: "192.168.50.20", app: "pi-hole" }, timeoutMs: 240_000 }]);
  });
});

describe("the finding on Home", () => {
  const servers = [{ address: "192.168.50.20", role: "this-server", label: "this server", verdict: "depends", note: "Goes when homebox goes." }];
  const apps = [{ id: "pi-hole", name: "Pi-hole", container: { running: true } }];

  it("says the house goes down with this server, points at the Network page, and offers no fix it cannot make", () => {
    const [found] = dnsLeansOnThisServer({ dnsResilience: { state: "single-point", headline: "If homebox goes down, every device on your network loses the internet", detail: "Your router hands out 192.168.50.20 (this server) as the only DNS server.", servers, via: "systemd-networkd", router: null, lanAddress: "192.168.50.20" }, apps });
    expect(found).toMatchObject({ id: "dns-single-point", severity: "warning", title: "If homebox goes down, every device on your network loses the internet", view: "network", fix: null, fixes: [] });
    expect(found.evidence).toEqual(["192.168.50.20 is this server: Goes when homebox goes.", "what the router hands out, read from systemd-networkd"]);
    expect(found.manual).toContain("GL.iNet");
  });

  it("offers the rehearsal when a router passing lookups here has not been tried", () => {
    const [found] = dnsLeansOnThisServer({ dnsResilience: { state: "unproven", headline: "Not known yet", detail: "…", servers: [{ address: "192.168.50.1", label: "your router", verdict: "unknown", note: "Passes lookups here." }], router: "192.168.50.1", lanAddress: "192.168.50.20" }, apps });
    expect(found).toMatchObject({ id: "dns-fallback-unproven", severity: "info", view: "network" });
    expect(found.fix).toMatchObject({ operationId: "dns.fallback.rehearse", parameters: { router: "192.168.50.1", lanAddress: "192.168.50.20", app: "pi-hole" }, label: "Rehearse it" });
    expect(found.fix.preview).toContain("up to a minute");
    // Without a running DNS app there is nothing to stop, so nothing to offer.
    expect(dnsLeansOnThisServer({ dnsResilience: { state: "unproven", servers: [], router: "192.168.50.1", lanAddress: "192.168.50.20" }, apps: [] })[0].fix).toBeNull();
  });

  it("says nothing when the house does not lean on this server, or nothing is known", () => {
    for (const state of ["resilient", "independent", "unknown"]) expect(dnsLeansOnThisServer({ dnsResilience: { state, servers: [] }, apps })).toEqual([]);
    expect(dnsLeansOnThisServer({})).toEqual([]);
    expect(detectRemediations({ dnsResilience: null }).findings.some((entry) => entry.id.startsWith("dns-"))).toBe(false);
  });
});
