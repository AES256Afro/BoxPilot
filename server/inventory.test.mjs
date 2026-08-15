import { describe, expect, it, vi } from "vitest";
import { createInventoryService } from "./inventory.mjs";

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
    });

    const result = await service.inspect();

    expect(result).toMatchObject({ host: { operatingSystem: "Ubuntu 26.04 LTS" }, storage: { root: { usedPercent: 75 } }, network: { tailscale: { connected: true, dnsName: "bigbox.example.ts.net" } }, docker: { available: true, containers: [{ name: "app" }] } });
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
    });
    const result = await service.inspect();
    expect(result.docker).toMatchObject({ available: false, error: expect.stringContaining("unavailable") });
    expect(result.storage.root).toBeNull();
  });
});
