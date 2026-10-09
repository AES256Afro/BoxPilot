import { describe, expect, it } from "vitest";
import { checkDnsAfterOutage, createOutageDnsWatch, getentLookup, latestOutageCheck, outageChecksSetting, powerOutagesSetting, previousBootEndedUncleanly, recordOutageCheck } from "./outage-dns.mjs";

const lanAddress = "192.168.50.20";
const pihole = { id: "pi-hole", name: "Pi-hole" };
const now = () => new Date("2026-09-29T22:21:00Z");

function memoryStore(initial = {}) {
  const settings = new Map(Object.entries(initial));
  return {
    settings,
    getSetting: (key, fallback) => (settings.has(key) ? settings.get(key) : fallback),
    updateSetting: (key, fallback, update) => { const { value } = update(settings.has(key) ? settings.get(key) : fallback); settings.set(key, value); },
  };
}

describe("the checks after an outage", () => {
  it("asks the DNS app on the LAN address and the host through NSS, as two lines", async () => {
    const result = await checkDnsAfterOutage({ lanAddress, dnsApp: pihole, now }, {
      verify: async ({ address }) => ({ address, answering: true, resolving: true, blocking: true }),
      lookupHost: async () => ({ ok: true, addresses: ["140.82.112.3"], error: null }),
    });
    expect(result).toEqual({ at: "2026-09-29T22:21:00.000Z", ok: true, checks: [
      { id: "dns-app-lan", ok: true, label: "Pi-hole answers on the LAN", detail: `A lookup sent to ${lanAddress}, as a device on your network sends it, came back.` },
      { id: "host-lookups", ok: true, label: "This server looks names up", detail: "github.com resolved through the system's resolver, as updates and image pulls resolve it." },
    ] });
  });

  it("says which half failed, and how", async () => {
    const result = await checkDnsAfterOutage({ lanAddress, dnsApp: pihole, now }, {
      verify: async () => ({ answering: false, resolving: false }),
      lookupHost: async () => ({ ok: false, addresses: [], error: "no such name, or no DNS server answered" }),
    });
    expect(result.ok).toBe(false);
    expect(result.checks.map((check) => check.label)).toEqual(["Pi-hole is not answering on the LAN", "This server cannot look names up"]);
    expect(result.checks[0].detail).toContain("Nothing answered a lookup on 192.168.50.20");
    const upstream = await checkDnsAfterOutage({ lanAddress, dnsApp: pihole, now }, { verify: async () => ({ answering: true, resolving: false }), lookupHost: async () => ({ ok: true }) });
    expect(upstream.checks[0].detail).toContain("its upstream is not reachable yet");
  });

  it("checks only the host when there is no DNS app here", async () => {
    const result = await checkDnsAfterOutage({ lanAddress, dnsApp: null, now }, { verify: async () => { throw new Error("must not ask"); }, lookupHost: async () => ({ ok: true }) });
    expect(result.checks.map((check) => check.id)).toEqual(["host-lookups"]);
  });

  it("reads getent's answer, and its exit 2 as no such name", async () => {
    const found = await getentLookup("github.com", { run: async () => ({ stdout: "140.82.112.3    STREAM github.com\n140.82.112.3    DGRAM\n" }) });
    expect(found).toEqual({ ok: true, addresses: ["140.82.112.3"], error: null });
    const missing = await getentLookup("github.com", { run: async () => { throw Object.assign(new Error("Command failed"), { code: 2 }); } });
    expect(missing).toMatchObject({ ok: false, error: "no such name, or no DNS server answered" });
  });
});

describe("knowing the boot before ended uncleanly", () => {
  const bootedAt = Date.parse("2026-09-29T22:18:00Z");

  it("asks power-loss's own function when it is there", async () => {
    const loadPowerLoss = async () => ({ previousBootEndedUncleanly: async () => ({ previousBootId: "a1b2c3", stoppedAt: "2026-09-29T18:41:00Z", backAt: "2026-09-29T22:18:00Z" }) });
    expect(await previousBootEndedUncleanly({ store: memoryStore(), bootedAt, loadPowerLoss })).toEqual({ id: "a1b2c3", stoppedAt: "2026-09-29T18:41:00Z", backAt: "2026-09-29T22:18:00Z" });
    expect(await previousBootEndedUncleanly({ store: memoryStore(), bootedAt, loadPowerLoss: async () => ({ previousBootEndedUncleanly: () => false }) })).toBeNull();
    expect((await previousBootEndedUncleanly({ store: memoryStore(), bootedAt, loadPowerLoss: async () => ({ previousBootEndedUncleanly: () => true }) })).id).toBe(`boot-${bootedAt}`);
  });

  it("otherwise reads the outage power-loss recorded, for this boot only", async () => {
    const missing = async () => { throw new Error("Cannot find module './power-loss.mjs'"); };
    const store = memoryStore({ [powerOutagesSetting]: [{ id: "a1b2c3", stoppedAt: "2026-09-29T18:41:00Z", backAt: "2026-09-29T22:18:00Z" }] });
    expect(await previousBootEndedUncleanly({ store, bootedAt, loadPowerLoss: missing })).toEqual({ id: "a1b2c3", stoppedAt: "2026-09-29T18:41:00Z", backAt: "2026-09-29T22:18:00Z" });
    // An outage from an earlier boot is not this one's.
    expect(await previousBootEndedUncleanly({ store, bootedAt: bootedAt + 3 * 86_400_000, loadPowerLoss: missing })).toBeNull();
    expect(await previousBootEndedUncleanly({ store: memoryStore(), bootedAt, loadPowerLoss: missing })).toBeNull();
  });
});

describe("the after-outage list", () => {
  it("puts the answer on the outage's record and keeps it here", () => {
    const store = memoryStore({ [powerOutagesSetting]: [{ id: "a1b2c3", stoppedAt: "x", acknowledged: null }, { id: "older" }] });
    const result = { at: "2026-09-29T22:21:00.000Z", ok: true, checks: [{ id: "host-lookups", ok: true, label: "This server looks names up", detail: "" }] };
    recordOutageCheck(store, { id: "a1b2c3", stoppedAt: "x", backAt: "y" }, result);
    expect(store.settings.get(powerOutagesSetting)[0]).toEqual({ id: "a1b2c3", stoppedAt: "x", acknowledged: null, dnsAfter: { at: result.at, ok: true, checks: result.checks } });
    expect(store.settings.get(powerOutagesSetting)[1]).toEqual({ id: "older" });
    expect(latestOutageCheck(store)).toMatchObject({ ok: true, outage: { id: "a1b2c3" } });
    expect(Object.keys(store.settings.get(outageChecksSetting))).toEqual(["a1b2c3"]);
  });

  it("checks a few minutes after a boot that followed an outage, and looks again while it fails", async () => {
    const store = memoryStore();
    const timers = [];
    let answers = [false, true];
    const watch = createOutageDnsWatch({
      store, network: { inspect: async () => ({ defaultRoutes: [{ interface: "eno1" }], eligibleLanAddresses: [{ interface: "eno1", address: lanAddress }] }) },
      dnsApp: async () => pihole, previous: async () => ({ id: "a1b2c3" }), uptimeSeconds: () => 180, now,
      check: async ({ lanAddress: address, dnsApp }) => ({ at: now().toISOString(), ok: answers.shift(), checks: [{ id: "dns-app-lan", ok: true, label: `${dnsApp.name} on ${address}`, detail: "" }] }),
      delay: (callback, ms) => { timers.push({ callback, ms }); return { unref() {} }; },
    });
    watch.start();
    expect(timers.map((timer) => timer.ms)).toEqual([180_000]);
    timers.shift().callback();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(latestOutageCheck(store).ok).toBe(false);
    expect(timers).toHaveLength(1);
    timers.shift().callback();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(latestOutageCheck(store).ok).toBe(true);
    expect(timers).toHaveLength(0);
  });

  it("leaves a boot that is hours old, and one that ended cleanly", async () => {
    const base = { store: memoryStore(), network: { inspect: async () => ({}) }, now, check: async () => { throw new Error("must not check"); } };
    expect(await createOutageDnsWatch({ ...base, uptimeSeconds: () => 5 * 3600, previous: async () => ({ id: "x" }) }).once()).toEqual({ state: "old-boot" });
    expect(await createOutageDnsWatch({ ...base, uptimeSeconds: () => 200, previous: async () => null }).once()).toEqual({ state: "no-outage" });
  });
});
