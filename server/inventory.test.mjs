import { describe, expect, it, vi } from "vitest";
import { readFile } from "node:fs/promises";
import { createInventoryService } from "./inventory.mjs";
import { parseMountInventory } from "./storage-evidence.mjs";

describe("sanitized host inventory", () => {
  it("collects host, service, Tailscale self, and helper-backed Docker state without peers or labels", async () => {
    const helper = { request: vi.fn(async () => ({ available: true, containers: [{ name: "app", image: "app:1", state: "running" }], images: [], networks: [], volumes: [], projects: [] })) };
    const runCommand = vi.fn(async (command, args) => {
      if (command === "tailscale") return { ok: true, stdout: JSON.stringify({ BackendState: "Running", Self: { DNSName: "bigbox.example.ts.net." }, Peer: { secret: "peer-secret" } }) };
      return { ok: true, stdout: `Id=${args[1]}\nLoadState=loaded\nActiveState=active\nSubState=running\nUnitFileState=enabled` };
    });
    const service = createInventoryService({
      helper,
      runCommand,
      readOsRelease: vi.fn(async () => 'PRETTY_NAME="Ubuntu 26.04 LTS"\n'),
      getFilesystem: vi.fn(async () => ({ blocks: 1000, bavail: 250, bsize: 4096 })),
      getNetworkInterfaces: vi.fn(() => ({ eth0: [{ internal: false, family: "IPv4", address: "192.168.8.10", cidr: "192.168.8.10/24" }] })),
      readStorageHealth: vi.fn(async () => JSON.stringify({ schemaVersion: 1, generatedAt: new Date().toISOString(), available: true, reason: "fixed-root-scan", disks: [{ device: "/dev/nvme0n1", health: "healthy", passed: true, reason: "ok" }] })),
    });

    const result = await service.inspect();

    expect(result).toMatchObject({ host: { operatingSystem: "Ubuntu 26.04 LTS" }, storage: { root: { usedPercent: 75 }, smart: { available: true, status: "healthy" } }, network: { tailscale: { connected: true, dnsName: "bigbox.example.ts.net" } }, docker: { available: true, containers: [{ name: "app" }] } });
    expect(result.services).toHaveLength(6);
    expect(JSON.stringify(result)).not.toContain("peer-secret");
    expect(helper.request).toHaveBeenCalledWith("container.docker.inventory", {});
  });

  it("degrades Docker and OS collectors independently", async () => {
    const service = createInventoryService({
      helper: { request: vi.fn(async () => { throw new Error("offline"); }) },
      runCommand: vi.fn(async () => ({ ok: false, stdout: "" })),
      readOsRelease: vi.fn(async () => { throw new Error("missing"); }),
      getFilesystem: vi.fn(async () => { throw new Error("missing"); }),
      getNetworkInterfaces: vi.fn(() => ({})),
      readStorageHealth: vi.fn(async () => { throw new Error("missing"); }),
    });
    const result = await service.inspect();
    expect(result.docker).toMatchObject({ available: false, error: expect.stringContaining("unavailable") });
    expect(result.storage.root).toBeNull();
    expect(result.storage.filesystems.available).toBe(false);
    expect(result.storage.blockDevices.available).toBe(false);
    expect(result.storage.smart).toMatchObject({ available: false, status: "unavailable" });
  });

  it("normalizes Ubuntu 22.04, 24.04, and 26.04 LTS storage fixtures", async () => {
    const fixtures = JSON.parse(await readFile("test/fixtures/ubuntu-lts-inventory.json", "utf8"));
    expect(fixtures.map((fixture) => fixture.release)).toEqual(["22.04", "24.04", "26.04"]);
    for (const fixture of fixtures) {
      const runCommand = vi.fn(async (command) => {
        if (command === "findmnt") return { ok: true, stdout: JSON.stringify(fixture.findmnt) };
        if (command === "lsblk") return { ok: true, stdout: JSON.stringify(fixture.lsblk) };
        if (command === "tailscale") return { ok: false, stdout: "" };
        return { ok: true, stdout: "Id=fixture.service\nLoadState=loaded\nActiveState=active\nSubState=running\nUnitFileState=enabled" };
      });
      const inventory = await createInventoryService({
        helper: { request: vi.fn(async () => ({ available: true, containers: [], images: [], networks: [], volumes: [], projects: [] })) },
        runCommand,
        readOsRelease: vi.fn(async () => fixture.osRelease),
        getFilesystem: vi.fn(async () => ({ blocks: 1000, bavail: 500, bsize: 4096 })),
        getNetworkInterfaces: vi.fn(() => ({})),
        now: () => new Date("2026-08-16T05:01:00.000Z"),
        readStorageHealth: vi.fn(async () => JSON.stringify({
          schemaVersion: 1,
          generatedAt: "2026-08-16T05:00:00.000Z",
          available: false,
          reason: "no-supported-disks",
          disks: [],
          filesystems: { ...parseMountInventory(JSON.stringify(fixture.findmnt)), namespace: "host-pid1" },
        })),
      }).inspect();
      expect(inventory.host.operatingSystem).toContain(`Ubuntu ${fixture.release}`);
      expect(inventory.storage.filesystems.available).toBe(true);
      expect(inventory.storage.filesystems.mounts.length).toBeGreaterThan(0);
      expect(inventory.storage.blockDevices.available).toBe(true);
      expect(runCommand).not.toHaveBeenCalledWith("findmnt", expect.anything());
      expect(JSON.stringify(inventory)).not.toContain("UUID");
      expect(inventory.storage.blockDevices.devices.every((device) => !("serial" in device))).toBe(true);
    }
  });
});
