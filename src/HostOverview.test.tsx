import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import HostOverview from "./HostOverview";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("live host overview", () => {
  it("renders the live inventory and Docker state", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      generatedAt: "2026-08-15T19:00:00Z",
      host: { hostname: "homebox", operatingSystem: "Ubuntu 26.04 LTS", kernel: "7.0.0", architecture: "x64", uptimeSeconds: 90000 },
      compute: { cpuCount: 8, cpuModel: "fixture", load1: 1, loadPercent: 13, totalMemoryBytes: 32 * 1024 ** 3, usedMemoryBytes: 8 * 1024 ** 3, memoryUsedPercent: 25 },
      storage: {
        root: { totalBytes: 100 * 1024 ** 3, usedBytes: 20 * 1024 ** 3, freeBytes: 80 * 1024 ** 3, usedPercent: 20 },
        filesystems: { available: true, mounts: [{ target: "/", source: "/dev/mapper/ubuntu--vg-root", filesystem: "ext4", totalBytes: 100 * 1024 ** 3, usedBytes: 20 * 1024 ** 3, availableBytes: 80 * 1024 ** 3, usedPercent: 20, capacityState: "healthy", readOnly: false, optionNames: ["relatime", "rw"], errorEvidence: { supported: true, state: "healthy", errorsCount: 0, source: "ext4-sysfs-errors-count", reason: "ok" } }], summary: { healthy: 1, warning: 0, critical: 0, unavailable: 0 }, errors: { healthy: 1, critical: 0, unavailable: 0, unsupported: 0 } },
        blockDevices: { available: true, devices: [{ name: "/dev/nvme0n1", parent: null, type: "disk", filesystem: null, sizeBytes: 1000, mountTargets: [], rotational: false, readOnly: false, transport: "nvme", model: "Safe SSD" }] },
        smart: { available: true, status: "healthy", reason: "fixed-root-scan", generatedAt: "2026-08-15T18:00:00Z", stale: false, disks: [{ device: "/dev/nvme0n1", health: "healthy", passed: true, temperatureCelsius: 42, powerOnHours: 100, percentageUsed: 4, mediaErrors: 0, unsafeShutdowns: 1 }] },
      },
      maintenance: { system: { available: true, state: "running", failedServiceCount: 0, failedServiceCountTruncated: false }, reboot: { available: true, required: false }, packageManager: { available: true, state: "ready", pendingUpdateFragments: 0, countTruncated: false }, aptMetadata: { available: true, state: "current", updatedAt: "2026-08-15T18:00:00Z", ageHours: 1 }, automaticSecurityUpdates: { available: true, state: "enabled-active", enabled: true, active: true } },
      power: { ups: { installed: true, configured: true, available: true, state: "online", reason: "ok", deviceCount: 1, statusTokens: ["CHRG", "OL"], batteryChargePercent: 96, estimatedRuntimeSeconds: 2700, loadPercent: 23, source: "nut-localhost-fixed", boundary: { mutationPerformed: false, powerCommandAvailable: false, shutdownPolicyChanged: false, localhostOnly: true, remoteNetworkProbePerformed: false, browserTargetAccepted: false, rawOutputIncluded: false, deviceNameIncluded: false, serialIncluded: false } } },
      network: { addresses: [{ interface: "enp1s0", address: "192.168.8.10", cidr: "192.168.8.10/24" }], tailscale: { installed: true, connected: true, dnsName: "homebox.example.ts.net" } },
      services: [{ unit: "boxpilot.service", load: "loaded", active: "active", sub: "running", enabled: "enabled" }],
      docker: { available: true, containers: [{ id: "abc", name: "uptime", image: "uptime:2", state: "running", status: "Up", ports: "127.0.0.1:3001", networks: "app" }], images: [], networks: [], volumes: [], projects: [] },
    }), { status: 200 })));
    render(<HostOverview />);
    expect(await screen.findByText("homebox")).toBeTruthy();
    expect(screen.getByText("uptime")).toBeTruthy();
    expect(screen.getByText("Tailscale connected")).toBeTruthy();
    expect(screen.getByText(/192.168.8.10\/24/)).toBeTruthy();
    expect(screen.getByText("Disks and filesystems")).toBeTruthy();
    expect(screen.getByText("1 real mounts")).toBeTruthy();
    expect(screen.getByText("1 disk results")).toBeTruthy();
    expect(screen.getByText(/42 C/)).toBeTruthy();
    expect(screen.getByText("ext4 kernel errors: 0")).toBeTruthy();
    expect(screen.getByText("UPS power protection")).toBeTruthy();
    expect(screen.getByText("Host maintenance readiness")).toBeTruthy();
    expect(screen.getByText("Not required")).toBeTruthy();
    expect(screen.getByText("enabled active")).toBeTruthy();
    expect(screen.getByText("Local UPS is online")).toBeTruthy();
    expect(screen.getByText("96%")).toBeTruthy();
    expect(screen.getByText(/45m estimated runtime/)).toBeTruthy();
    expect(screen.getByText("23%")).toBeTruthy();
  });
});
