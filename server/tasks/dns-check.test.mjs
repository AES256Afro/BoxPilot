import { describe, it, expect } from "vitest";
import { dnsBlockerVerify, controlDomain, probeDomain, impossibleResolvers } from "./dns-check.mjs";

/**
 * The ways this goes wrong need different fixes, so they are reported apart rather than flattened
 * into one "working" boolean: nothing answering is a firewall or a loopback binding, a dead upstream
 * takes the whole network offline, unloaded lists block nothing, and a network that answers every
 * DNS query itself breaks recursion no matter what the blocker does.
 */
const answers = (map) => async (domain) => {
  const value = map[domain];
  if (value instanceof Error) throw value;
  return value ?? [];
};
const failing = (code) => Object.assign(new Error(code), { code });
/** Nothing answers the impossible addresses; the healthy case, and it keeps these off the network. */
const quiet = async () => { throw failing("ETIMEOUT"); };
/** Something answers them, which is what a network intercepting DNS looks like. */
const interceptor = async () => ["104.20.23.154"];

describe("checking the DNS blocker the way a laptop would", () => {
  it("is happy when it answers, resolves, and refuses what it should", async () => {
    const report = await dnsBlockerVerify({ address: "192.168.1.10" }, {
      resolveVia: quiet,
      resolve: answers({ [controlDomain]: ["93.184.216.34"], [probeDomain]: ["0.0.0.0"] }),
    });
    expect(report).toMatchObject({ answering: true, resolving: true, blocking: true, intercepted: false, reason: null });
  });

  it("treats NXDOMAIN as a refusal, which is how some blockers answer", async () => {
    const report = await dnsBlockerVerify({ address: "192.168.1.10" }, {
      resolveVia: quiet,
      resolve: answers({ [controlDomain]: ["93.184.216.34"], [probeDomain]: failing("ENOTFOUND") }),
    });
    expect(report.blocking).toBe(true);
  });

  it("says nothing answered, rather than saying it is not blocking", async () => {
    // A firewall closing port 53 and a blocker with empty lists look identical in one boolean.
    const report = await dnsBlockerVerify({ address: "192.168.1.10" }, {
      resolveVia: quiet, resolve: answers({ [controlDomain]: failing("ETIMEOUT") }),
    });
    expect(report).toMatchObject({ answering: false, resolving: false, blocking: false });
    expect(report.reason).toMatch(/port 53 is not open|only listening on this server/);
  });

  it("separates a dead upstream from a blocker that is not blocking", async () => {
    const dead = await dnsBlockerVerify({ address: "192.168.1.10" }, {
      resolveVia: quiet, resolve: answers({ [controlDomain]: failing("ESERVFAIL"), [probeDomain]: ["0.0.0.0"] }),
    });
    expect(dead).toMatchObject({ answering: true, resolving: false });
    expect(dead.reason).toMatch(/upstream resolver is not working/);

    const notBlocking = await dnsBlockerVerify({ address: "192.168.1.10" }, {
      resolveVia: quiet, resolve: answers({ [controlDomain]: ["93.184.216.34"], [probeDomain]: ["142.250.187.238"] }),
    });
    expect(notBlocking).toMatchObject({ answering: true, resolving: true, blocking: false });
    expect(notBlocking.reason).toMatch(/lists may not have loaded/);
  });

  it("notices when something is answering for addresses that cannot run a resolver", async () => {
    // The real fault on a live network: the blocker answers and blocks, but every recursive lookup
    // fails, because something upstream replies to everything and the reply does not validate.
    // Without this the report blames the blocklists, which is the wrong thing to go and fix.
    const report = await dnsBlockerVerify({ address: "192.168.1.10" }, {
      resolveVia: interceptor,
      resolve: answers({ [controlDomain]: failing("ESERVFAIL"), [probeDomain]: ["0.0.0.0"] }),
    });
    expect(report.intercepted).toBe(true);
    expect(report.reason).toMatch(/answering every DNS query itself/);
    // Naming the control is the difference between advice and a shrug; the owner's router calls it
    // "Override DNS Settings of All Clients", and other firmware calls it Force DNS or DNS Redirect.
    expect(report.reason).toMatch(/Override DNS Settings of All Clients/);
    expect(report.reason).toMatch(/Force DNS|DNS Redirect/);
    expect(report.reason).toMatch(/devices on your network reach that thing rather than this blocker/);
  });

  it("does not blame interception for a blocker that is working", async () => {
    const report = await dnsBlockerVerify({ address: "192.168.1.10" }, {
      resolveVia: interceptor,
      resolve: answers({ [controlDomain]: ["93.184.216.34"], [probeDomain]: ["0.0.0.0"] }),
    });
    expect(report).toMatchObject({ intercepted: true, resolving: true, blocking: true, reason: null });
  });

  it("asks two reserved addresses, so one stray answer is enough to notice", () => {
    expect(impossibleResolvers).toHaveLength(2);
    for (const address of impossibleResolvers) expect(address).toMatch(/^(192\.0\.2|198\.51\.100)\./);
  });

  it("refuses anything that is not a LAN address", async () => {
    await expect(dnsBlockerVerify({ address: "not-an-address" })).rejects.toThrow(/LAN address/);
    await expect(dnsBlockerVerify({})).rejects.toThrow(/LAN address/);
  });
});
