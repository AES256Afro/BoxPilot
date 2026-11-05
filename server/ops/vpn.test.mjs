import { describe, expect, it, vi } from "vitest";
import { vpnOperations } from "./vpn.mjs";

/**
 * The two VPN-profile operations no test named (M56.2): removing the saved profile, and reading it
 * back without its secrets. Both are the owner's, because the profile is a credential for a service
 * the owner pays for and the described form still names the provider and the countries.
 */
const operation = (id) => vpnOperations().find((entry) => entry.id === id);

describe("removing the VPN profile", () => {
  it("clears the stored profile and is the owner's, at medium", async () => {
    const found = operation("vpn.profile.clear");
    expect(found).toMatchObject({ risk: "medium", minimumRole: "owner", readOnly: false });
    expect(Object.keys(found.parameters?.fields ?? {})).toEqual([]);
    const vpnProfile = { clear: vi.fn(async () => ({ cleared: true })) };
    await expect(found.run({}, { vpnProfile })).resolves.toEqual({ cleared: true });
    expect(vpnProfile.clear).toHaveBeenCalledTimes(1);
  });

  it("says plainly what it does to the apps still using it", () => {
    const { description } = operation("vpn.profile.clear");
    expect(description).toContain("keep running");
    expect(description).toContain("refuse to redeploy");
  });
});

describe("reading the VPN profile", () => {
  it("is a read, the owner's, and hands back what the store describes", async () => {
    const found = operation("vpn.profile.inspect");
    expect(found).toMatchObject({ risk: "low", readOnly: true, minimumRole: "owner" });
    const described = { configured: true, provider: "mullvad", protocol: "wireguard", countries: ["se"], keyStored: true };
    const vpnProfile = { describe: vi.fn(async () => described) };
    await expect(found.run({}, { vpnProfile })).resolves.toEqual(described);
  });
});
