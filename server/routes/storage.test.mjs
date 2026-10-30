import { describe, expect, it } from "vitest";
import { parseShowmount, parseSmbclientList, subnetHosts } from "./storage.mjs";

describe("storage route helpers", () => {
  it("enumerates a /24 without the server's own address and refuses big subnets", () => {
    const hosts = subnetHosts("192.168.1.10", 24);
    expect(hosts).toHaveLength(253);
    expect(hosts[0]).toBe("192.168.1.1");
    expect(hosts).not.toContain("192.168.1.10");
    expect(hosts.at(-1)).toBe("192.168.1.254");
    expect(subnetHosts("10.0.0.5", 30)).toEqual(["10.0.0.6"]);
    expect(subnetHosts("10.0.0.5", 16)).toEqual([]);
    expect(subnetHosts("garbage", 24)).toEqual([]);
  });

  it("parses smbclient -g and showmount output", () => {
    expect(parseSmbclientList("Disk|Public|Public Share\nDisk|TimeMachineBackup|\nIPC|IPC$|IPC Service\nDisk|admin$|hidden\nPrinter|HP|")).toEqual([
      { name: "Public", comment: "Public Share" },
      { name: "TimeMachineBackup", comment: null },
    ]);
    expect(parseShowmount("/volume1/media 192.168.1.0/24\n/volume1/backup *\n")).toEqual([
      { name: "/volume1/media", comment: "allowed: 192.168.1.0/24" },
      { name: "/volume1/backup", comment: "allowed: *" },
    ]);
    expect(parseShowmount("")).toEqual([]);
  });
});

describe("the SMART history route (M31.2)", () => {
  it("answers each disk's readings over the last weeks, from the sampler's history", async () => {
    const { default: express } = await import("express");
    const { createStorageRouter } = await import("./storage.mjs");
    const now = Date.parse("2026-10-18T06:00:00Z");
    const state = { getSetting: (key) => (key === "smartHistory" ? { "/dev/sda": [{ at: "2026-10-17T06:00:00Z", temperatureCelsius: 40, percentageUsed: 5, mediaErrors: 0 }, { at: "2026-10-18T05:00:00Z", temperatureCelsius: 42, percentageUsed: 6, mediaErrors: 0 }] } : {}) };
    const app = express();
    app.use("/api/v1", createStorageRouter({ auth: { requireRole: () => (_request, _response, next) => next(), requireCsrf: (_request, _response, next) => next() }, state, now: () => now }));
    const server = app.listen(0, "127.0.0.1");
    await new Promise((resolve) => server.once("listening", resolve));
    try {
      const body = await (await fetch(`http://127.0.0.1:${server.address().port}/api/v1/storage/smart-history`)).json();
      expect(body.disks).toEqual([expect.objectContaining({ device: "/dev/sda", days: 1, wearChange: 1, errorChange: 0 })]);
      expect(body.disks[0].samples).toHaveLength(2);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
