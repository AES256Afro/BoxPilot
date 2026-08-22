import { describe, expect, it, vi } from "vitest";
import { createDeviceResolver } from "./devices.mjs";

const manifests = {
  scrutiny: { id: "scrutiny", devices: ["/dev/sd?", "/dev/nvme?"] },
  esphome: { id: "esphome", devices: ["/dev/ttyUSB?", "/dev/ttyACM?"] },
  jellyfin: { id: "jellyfin", devices: [] },
  vaultwarden: { id: "vaultwarden" },
  fixed: { id: "fixed", devices: ["/dev/net/tun"] },
};

describe("device resolver", () => {
  const catalog = { get: async (id) => manifests[id] ?? null };
  const listDirectory = vi.fn(async (directory) => (directory === "/dev" ? ["null", "sda", "sdb", "nvme0", "ttyUSB0", "zero"] : []));

  it("resolves globs against the host, leaves everything else alone", async () => {
    const resolve = createDeviceResolver({ catalog, listDirectory });
    expect(await resolve({ id: "scrutiny", values: {} })).toEqual({ id: "scrutiny", values: {}, devices: ["/dev/sda", "/dev/sdb", "/dev/nvme0"] });
    expect(await resolve({ id: "esphome" })).toEqual({ id: "esphome", devices: ["/dev/ttyUSB0"] });
    // No globs, no manifest, or no devices at all: the parameters are handed on unchanged.
    expect(await resolve({ id: "jellyfin", values: {} })).toEqual({ id: "jellyfin", values: {} });
    expect(await resolve({ id: "vaultwarden" })).toEqual({ id: "vaultwarden" });
    expect(await resolve({ id: "fixed" })).toEqual({ id: "fixed" });
    expect(await resolve({ id: "not-in-catalog" })).toEqual({ id: "not-in-catalog" });
  });

  it("returns an empty list when the host has no matching device, so the job fails with a clear reason", async () => {
    const resolve = createDeviceResolver({ catalog, listDirectory: async () => ["null", "zero"] });
    expect(await resolve({ id: "scrutiny" })).toEqual({ id: "scrutiny", devices: [] });
  });

  it("survives a catalog that cannot be read", async () => {
    const resolve = createDeviceResolver({ catalog: { get: async () => { throw new Error("catalog unavailable"); } }, listDirectory });
    expect(await resolve({ id: "scrutiny", values: { env: {} } })).toEqual({ id: "scrutiny", values: { env: {} } });
  });
});
