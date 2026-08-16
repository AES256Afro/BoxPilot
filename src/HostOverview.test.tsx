import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import HostOverview from "./HostOverview";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("live host overview", () => {
  it("renders authenticated inventory and sanitized Docker state", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      generatedAt: "2026-08-15T19:00:00Z",
      host: { hostname: "bigbox", operatingSystem: "Ubuntu 26.04 LTS", kernel: "7.0.0", architecture: "x64", uptimeSeconds: 90000 },
      compute: { cpuCount: 8, cpuModel: "fixture", load1: 1, loadPercent: 13, totalMemoryBytes: 32 * 1024 ** 3, usedMemoryBytes: 8 * 1024 ** 3, memoryUsedPercent: 25 },
      storage: {
        root: { totalBytes: 100 * 1024 ** 3, usedBytes: 20 * 1024 ** 3, freeBytes: 80 * 1024 ** 3, usedPercent: 20 },
        filesystems: { available: true, mounts: [{ target: "/", source: "/dev/mapper/ubuntu--vg-root", filesystem: "ext4", totalBytes: 100 * 1024 ** 3, usedBytes: 20 * 1024 ** 3, availableBytes: 80 * 1024 ** 3, usedPercent: 20, capacityState: "healthy", readOnly: false, optionNames: ["relatime", "rw"] }], summary: { healthy: 1, warning: 0, critical: 0, unavailable: 0 } },
        blockDevices: { available: true, devices: [{ name: "/dev/nvme0n1", parent: null, type: "disk", filesystem: null, sizeBytes: 1000, mountTargets: [], rotational: false, readOnly: false, transport: "nvme", model: "Safe SSD" }] },
        smart: { available: true, status: "healthy", reason: "fixed-root-scan", generatedAt: "2026-08-15T18:00:00Z", stale: false, disks: [{ device: "/dev/nvme0n1", health: "healthy", passed: true, temperatureCelsius: 42, powerOnHours: 100, percentageUsed: 4, mediaErrors: 0, unsafeShutdowns: 1 }] },
      },
      network: { addresses: [{ interface: "enp1s0", address: "192.168.8.10", cidr: "192.168.8.10/24" }], tailscale: { installed: true, connected: true, dnsName: "bigbox.example.ts.net" } },
      services: [{ unit: "boxpilot.service", load: "loaded", active: "active", sub: "running", enabled: "enabled" }],
      docker: { available: true, containers: [{ id: "abc", name: "uptime", image: "uptime:2", state: "running", status: "Up", ports: "127.0.0.1:3001", networks: "app" }], images: [], networks: [], volumes: [], projects: [] },
    }), { status: 200 })));
    render(<HostOverview />);
    expect(await screen.findByText("bigbox")).toBeTruthy();
    expect(screen.getByText("uptime")).toBeTruthy();
    expect(screen.getByText("Tailscale connected")).toBeTruthy();
    expect(screen.getByText(/192.168.8.10\/24/)).toBeTruthy();
    expect(screen.getByText("Storage and filesystem evidence")).toBeTruthy();
    expect(screen.getByText("1 real mounts")).toBeTruthy();
    expect(screen.getByText("1 disk results")).toBeTruthy();
    expect(screen.getByText(/42 C/)).toBeTruthy();
  });
});
