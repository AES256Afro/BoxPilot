import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createVpnProfileStore, normalizeVpnProfile, profileConnectionEnv, profileSecurityEnv, describeVpnProfile } from "./vpn-profile.mjs";

const dirs = [];
async function tempFile() {
  const dir = await mkdtemp(path.join(tmpdir(), "bp-vpn-"));
  dirs.push(dir);
  return path.join(dir, "vpn-profile.json");
}
afterEach(async () => { while (dirs.length) await rm(dirs.pop(), { recursive: true, force: true }); });

const clock = () => new Date("2026-08-28T12:00:00Z");

describe("normalizeVpnProfile", () => {
  it("keeps a WireGuard profile and applies the security defaults", () => {
    const profile = normalizeVpnProfile({ provider: "mullvad", type: "wireguard", wireguardPrivateKey: "KEY==", countries: "Sweden" });
    expect(profile.provider).toBe("mullvad");
    expect(profile.dot).toBe("on");
    expect(profile.blockMalicious).toBe("on");
    expect(profile.blockAds).toBe("off");
    expect(profile.portForwarding).toBe("off");
  });

  it("refuses WireGuard with no key and OpenVPN with no username or password", () => {
    expect(() => normalizeVpnProfile({ type: "wireguard" })).toThrow(/private key/i);
    expect(() => normalizeVpnProfile({ type: "openvpn", openvpnUser: "me" })).toThrow(/username and password/i);
  });

  it("rejects an unknown provider and a bad subnet list", () => {
    expect(() => normalizeVpnProfile({ provider: "nope", type: "wireguard", wireguardPrivateKey: "K" })).toThrow(/provider/i);
    expect(() => normalizeVpnProfile({ type: "wireguard", wireguardPrivateKey: "K", outboundSubnets: "not-a-subnet" })).toThrow(/CIDR/i);
  });

  it("keeps the previous secret when a save leaves it blank", () => {
    const previous = normalizeVpnProfile({ type: "wireguard", wireguardPrivateKey: "ORIGINAL==" });
    const next = normalizeVpnProfile({ type: "wireguard", wireguardPrivateKey: "", countries: "Norway" }, previous);
    expect(next.wireguardPrivateKey).toBe("ORIGINAL==");
    expect(next.countries).toBe("Norway");
  });
});

describe("profile env mapping", () => {
  const profile = normalizeVpnProfile({ provider: "protonvpn", type: "wireguard", wireguardPrivateKey: "K==", wireguardAddresses: "10.2.0.2/32", countries: "Switzerland", portForwarding: "on", blockAds: "on", dnsAddress: "94.140.14.14", outboundSubnets: "192.168.5.0/24", healthTargetAddress: "1.1.1.1:443" });

  it("maps connection fields to the Gluetun variable names", () => {
    expect(profileConnectionEnv(profile)).toMatchObject({ VPN_SERVICE_PROVIDER: "protonvpn", VPN_TYPE: "wireguard", WIREGUARD_PRIVATE_KEY: "K==", WIREGUARD_ADDRESSES: "10.2.0.2/32", SERVER_COUNTRIES: "Switzerland", VPN_PORT_FORWARDING: "on" });
  });

  it("emits security env, leaving empty optional fields out", () => {
    const security = profileSecurityEnv(profile);
    expect(security).toMatchObject({ DOT: "on", BLOCK_MALICIOUS: "on", BLOCK_ADS: "on", DNS_ADDRESS: "94.140.14.14", FIREWALL_OUTBOUND_SUBNETS: "192.168.5.0/24", HEALTH_TARGET_ADDRESS: "1.1.1.1:443" });
    const bare = profileSecurityEnv(normalizeVpnProfile({ type: "wireguard", wireguardPrivateKey: "K" }));
    expect("DNS_ADDRESS" in bare).toBe(false);
    expect("FIREWALL_OUTBOUND_SUBNETS" in bare).toBe(false);
  });

  it("describes a profile without leaking its secrets", () => {
    const described = describeVpnProfile(profile);
    expect(described.configured).toBe(true);
    expect(described.hasWireguardKey).toBe(true);
    expect(described).not.toHaveProperty("wireguardPrivateKey");
    expect(describeVpnProfile(null)).toEqual({ configured: false });
  });
});

describe("createVpnProfileStore", () => {
  it("saves to a 0600 file, reads it back, and clears it", async () => {
    const file = await tempFile();
    const store = createVpnProfileStore({ file, now: clock });
    expect(await store.describe()).toEqual({ configured: false });

    const described = await store.set({ provider: "mullvad", type: "wireguard", wireguardPrivateKey: "SECRET==", countries: "Sweden" });
    expect(described.hasWireguardKey).toBe(true);
    expect(described).not.toHaveProperty("wireguardPrivateKey");

    const onDisk = await store.read();
    expect(onDisk.wireguardPrivateKey).toBe("SECRET==");
    expect(onDisk.updatedAt).toBe("2026-08-28T12:00:00.000Z");
    expect((await stat(file)).mode & 0o777).toBe(0o600);

    await store.clear();
    expect(await store.read()).toBe(null);
    await expect(stat(file)).rejects.toThrow();
  });

  it("keeps the stored key when a later save omits it", async () => {
    const store = createVpnProfileStore({ file: await tempFile(), now: clock });
    await store.set({ type: "wireguard", wireguardPrivateKey: "FIRST==" });
    await store.set({ type: "wireguard", countries: "Norway" });
    const onDisk = await store.read();
    expect(onDisk.wireguardPrivateKey).toBe("FIRST==");
    expect(onDisk.countries).toBe("Norway");
  });
});
