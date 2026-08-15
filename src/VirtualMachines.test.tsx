import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import VirtualMachines from "./VirtualMachines";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Virtual Machines", () => {
  it("renders live libvirt readiness and discovered domains", async () => {
    const status = {
      platform: "linux",
      architecture: "x64",
      connectionUri: "qemu:///system",
      ready: true,
      checks: [{ id: "kvm", label: "KVM device access", ok: true, detail: "/dev/kvm is ready" }],
      tailscale: { installed: true, connected: true, dnsName: "ubuntu-server.example.ts.net", serveUrls: ["https://ubuntu-server.example.ts.net"] },
      setupPlan: { title: "Setup", destructive: false, requiresConsoleApproval: true, commands: ["virsh list --all"], notes: ["Use NAT first."] },
      actions: { enabled: false, reason: "VM actions are disabled by configuration" },
    };
    const domains = {
      connected: true,
      error: null,
      domains: [{
        name: "ubuntu-lab",
        uuid: "one",
        state: "running",
        vcpus: 2,
        memoryKiB: 4194304,
        persistent: true,
        autostart: true,
        managed: true,
        addresses: [{ interface: "vnet0", protocol: "ipv4", address: "192.168.122.25/24" }],
        disks: [{ type: "file", device: "disk", target: "vda", source: "/var/lib/libvirt/images/ubuntu-lab.qcow2" }],
        interfaces: [{ interface: "vnet0", type: "network", source: "default", model: "virtio", mac: "52:54:00:aa:bb:cc" }],
        snapshotCount: 2,
      }],
    };
    const resources = {
      connected: true,
      networks: [{ name: "default", active: true, autostart: true, persistent: true, bridge: "virbr0" }],
      pools: [{ name: "default", active: true, autostart: true, persistent: true, type: "dir", targetPath: "/var/lib/libvirt/images", capacity: "100 GiB", allocation: "20 GiB", available: "80 GiB" }],
      errors: [],
    };
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = input.toString();
      const body = url.endsWith("/status") ? status : url.endsWith("/resources") ? resources : domains;
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }));

    render(<VirtualMachines />);

    expect(await screen.findByText("KVM host is ready")).toBeTruthy();
    expect(screen.getByText("ubuntu-lab")).toBeTruthy();
    expect(screen.getByText("192.168.122.25/24")).toBeTruthy();
    expect(screen.getByText("Libvirt resources")).toBeTruthy();
    expect(screen.getByText(/80 GiB/)).toBeTruthy();
    expect((screen.getByRole("button", { name: "Reboot" }) as HTMLButtonElement).disabled).toBe(true);
  });
});
