import { describe, expect, it, vi } from "vitest";
import { createDeviceResolver, createSnapshotDeviceResolver } from "./devices.mjs";
import { registry } from "../ops/index.mjs";

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

// R2B3-1: a machine snapshot restore installs apps too, and was given no devices: ESPHome, OctoPrint,
// Scrutiny, Zigbee2MQTT and Z-Wave JS UI refused ("needs a device matching /dev/ttyUSB?") and their
// data restore was skipped; Tdarr came back without its GPU.
describe("devices for the apps a machine snapshot restore installs", () => {
  const catalog = { all: async () => ({ manifests: [...Object.values(manifests), { id: "tdarr", devices: [], optionalDevices: ["/dev/dri/renderD*"] }] }) };
  const listDirectory = vi.fn(async (directory) => ({ "/dev": ["null", "sda", "ttyUSB0"], "/dev/dri": ["card0", "renderD128"] })[directory] ?? []);

  it("resolves every catalog app that globs for one, here, where /dev is real", async () => {
    const resolve = createSnapshotDeviceResolver({ catalog, listDirectory });
    const prepared = await resolve({ source: "local", artifact: "machine-snapshot-20260821T020000Z-abcdef12.tar.gz" });
    expect(prepared).toEqual({ source: "local", artifact: "machine-snapshot-20260821T020000Z-abcdef12.tar.gz", devicesByApp: { scrutiny: ["/dev/sda"], esphome: ["/dev/ttyUSB0"], tdarr: ["/dev/dri/renderD128"] } });
    expect(registry.validate("host.snapshot.restore", prepared)).toBeNull();
  });

  it("only the apps chosen, and never a list the browser sent", async () => {
    const resolve = createSnapshotDeviceResolver({ catalog, listDirectory });
    const prepared = await resolve({ source: "local", artifact: "a", apps: ["esphome", "vaultwarden"], devicesByApp: { esphome: ["/dev/sda"], vaultwarden: ["/dev/mem"] } });
    expect(prepared.devicesByApp).toEqual({ esphome: ["/dev/ttyUSB0"] });
  });

  it("survives a catalog that cannot be read", async () => {
    const resolve = createSnapshotDeviceResolver({ catalog: { all: async () => { throw new Error("catalog unavailable"); } }, listDirectory });
    expect(await resolve({ source: "local", artifact: "a" })).toEqual({ source: "local", artifact: "a", devicesByApp: {} });
  });

  it("are checked like any other parameter", () => {
    const base = { source: "local", artifact: "machine-snapshot-20260821T020000Z-abcdef12.tar.gz" };
    expect(registry.validate("host.snapshot.restore", { ...base, devicesByApp: { esphome: ["/dev/ttyUSB0"] } })).toBeNull();
    for (const devicesByApp of [{ esphome: ["/etc/shadow"] }, { "../x": ["/dev/sda"] }, { esphome: "/dev/sda" }, { esphome: Array.from({ length: 33 }, (_, index) => `/dev/sd${index}`) }, []]) {
      expect(registry.validate("host.snapshot.restore", { ...base, devicesByApp }), JSON.stringify(devicesByApp)).toMatch(/devicesByApp/);
    }
  });
});