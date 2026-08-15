import { describe, expect, it, vi } from "vitest";
import { buildConsoleGuidanceResponse, createHelperLibvirtService } from "./helper-libvirt.mjs";

describe("helper-backed libvirt client", () => {
  it("uses only fixed inventory scopes and exact domain matching", async () => {
    const helper = {
      request: vi.fn(async (_operation, parameters) => parameters.scope === "domains"
        ? { connected: true, domains: [{ name: "ubuntu-lab" }], error: null }
        : { ready: true }),
    };
    const libvirt = createHelperLibvirtService({ helper });

    await expect(libvirt.getStatus()).resolves.toEqual({ ready: true });
    await expect(libvirt.getDomain("ubuntu-lab")).resolves.toEqual({ name: "ubuntu-lab" });
    await expect(libvirt.getDomain("../../etc")).resolves.toBeNull();
    expect(helper.request).toHaveBeenCalledWith("virtualization.inventory.inspect", { scope: "status" });
    expect(helper.request).toHaveBeenCalledWith("virtualization.inventory.inspect", { scope: "domains" });
  });

  it("degrades discovery safely when the helper is unavailable", async () => {
    const helper = { request: vi.fn(async () => { throw new Error("socket down"); }) };
    const libvirt = createHelperLibvirtService({ helper });
    await expect(libvirt.getStatus()).resolves.toMatchObject({ ready: false, checks: [{ id: "helper", ok: false }] });
    await expect(libvirt.listDomains()).resolves.toMatchObject({ connected: false, domains: [] });
    await expect(libvirt.listResources()).resolves.toMatchObject({ connected: false, networks: [], pools: [] });
    await expect(libvirt.getDomain("ubuntu-lab")).rejects.toThrow("Restricted virtualization helper is unavailable");
  });

  it("builds only a fixed Cockpit URL from a constrained Tailscale name", () => {
    const guidance = { nativeProxyAvailable: false, cockpit: { installed: true, active: true, enabled: true, port: 9090 } };
    expect(buildConsoleGuidanceResponse({ ...guidance, tailscaleDnsName: "bigbox.example.ts.net" }).privateUrl).toBe("https://bigbox.example.ts.net:9090/");
    expect(buildConsoleGuidanceResponse({ ...guidance, tailscaleDnsName: "evil/name" }).privateUrl).toBeNull();
    expect(buildConsoleGuidanceResponse({ ...guidance, cockpit: { ...guidance.cockpit, port: 22 }, tailscaleDnsName: "bigbox.example.ts.net" }).privateUrl).toBeNull();
  });
});
