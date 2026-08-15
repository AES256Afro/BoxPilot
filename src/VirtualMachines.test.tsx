import { cleanup, fireEvent, render, screen } from "@testing-library/react";
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
      actions: { enabled: true, reason: "Lifecycle actions use immutable plans and approval" },
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
        snapshots: [{ name: "clean-install", manageable: true, current: false, state: "stopped", location: "internal", parent: null, createdAt: "2026-08-15" }],
        guestAgent: { available: true, filesystemState: "thawed", addressDiscovery: true },
      }, {
        name: "snapshot-lab", uuid: "11111111-1111-4111-8111-111111111111", state: "stopped", vcpus: 1, memoryKiB: 2097152, persistent: true, autostart: false, managed: true,
        addresses: [], disks: [{ type: "file", device: "disk", target: "vda", source: "/var/lib/libvirt/images/snapshot-lab.qcow2" }], interfaces: [], snapshotCount: 0, snapshots: [],
        guestAgent: { available: false, filesystemState: null, addressDiscovery: false },
      }],
    };
    const resources = {
      connected: true,
      networks: [{ name: "default", active: true, autostart: true, persistent: true, bridge: "virbr0" }],
      pools: [{ name: "default", active: true, autostart: true, persistent: true, type: "dir", targetPath: "/var/lib/libvirt/images", capacity: "100 GiB", allocation: "20 GiB", available: "80 GiB" }],
      errors: [],
    };
    const consoleGuidance = { nativeProxyAvailable: false, cockpit: { installed: false, active: false, enabled: false, port: 9090 }, tailscaleDnsName: null, privateUrl: null, accessNote: "No web console handoff is active." };
    const actionPlan = {
      id: "plan-1", revision: "revision-1", status: "draft", expiresAt: "2026-08-15T21:00:00Z",
      input: { name: "ubuntu-lab", action: "reboot", expectedState: "running", expectedAutostart: true },
      output: { executable: true, action: "reboot", label: "Reboot", current: { state: "running", autostart: true }, desired: { state: "running", autostart: true }, changes: ["Request a guest reboot"], recovery: "Use the guest console if health does not return." },
    };
    const snapshotPlan = {
      id: "snapshot-plan-1", revision: "snapshot-revision-1", status: "draft", expiresAt: "2026-08-15T21:00:00Z",
      input: { name: "snapshot-lab", snapshotName: "checkpoint-2026-08-15", expectedUuid: "11111111-1111-4111-8111-111111111111", expectedState: "stopped", expectedDiskRevision: "b".repeat(64), expectedSnapshotRevision: "a".repeat(64) },
      output: { executable: true, consistency: "offline-consistent", independentBackup: false, currentSnapshotCount: 0, diskTargets: ["vda"], changes: ["Create one internal snapshot"], warnings: ["A snapshot is not an independent backup."], recovery: "Leave the VM stopped and inspect it." },
    };
    const exportPlan = {
      id: "export-plan-1", revision: "export-revision-1", status: "draft", expiresAt: "2026-08-15T21:00:00Z",
      input: { name: "snapshot-lab", exportId: "22222222-2222-4222-8222-222222222222", expectedUuid: "11111111-1111-4111-8111-111111111111", expectedState: "stopped", expectedDiskRevision: "b".repeat(64), expectedSnapshotRevision: "a".repeat(64) },
      output: { executable: true, destination: "local-managed", diskTargets: ["vda"], sourceAllocatedBytes: 4096, requiredBytes: 1073746740, destinationFreeBytes: 10737418240, blockers: [], changes: ["Write a root-only export"], verification: ["Per-disk content comparison"], protected: false, encrypted: false, restoreDrill: { passed: false, reason: "not run" }, warnings: ["This local export is not a protected backup."], recovery: "Remove only the new export directory." },
    };
    const exportArtifact = {
      id: "22222222-2222-4222-8222-222222222222", domainName: "snapshot-lab", domainUuid: "11111111-1111-4111-8111-111111111111",
      destination: "local-managed", artifactPath: "/var/lib/boxpilot-managed/vm-exports/22222222-2222-4222-8222-222222222222",
      manifestChecksumSha256: "c".repeat(64), sizeBytes: 4096, protected: false, encrypted: false,
      restoreDrill: { passed: false, reason: "not run" }, createdAt: "2026-08-15T20:00:00Z",
    };
    const protection = {
      destination: {
        adapter: "mounted-restic", ready: true, encrypted: true, independent: true, resticVersion: "0.19.1",
        mount: { target: "/mnt/boxpilot-backup", sourceType: "ext4", independentFilesystem: true, writable: true },
        repositoryId: "d".repeat(64), destinationRevision: "e".repeat(64), destinationFreeBytes: 20 * 1024 ** 3,
        blockers: [], setupCommand: "sudo /opt/boxpilot/scripts/boxpilot-restic-setup.sh", recoveryKeyRequired: true,
      },
      backups: [],
    };
    const protectionPlan = {
      id: "protection-plan-1", revision: "protection-revision-1", status: "draft", expiresAt: "2026-08-15T21:00:00Z",
      input: {
        backupId: "33333333-3333-4333-8333-333333333333", exportId: exportArtifact.id, domainName: "snapshot-lab",
        domainUuid: exportArtifact.domainUuid, expectedManifestChecksumSha256: exportArtifact.manifestChecksumSha256,
        expectedSizeBytes: exportArtifact.sizeBytes, expectedDestinationRevision: "e".repeat(64),
      },
      output: {
        executable: true, destination: "mounted-restic", resticVersion: "0.19.1", repositoryId: "d".repeat(64),
        destinationFreeBytes: 20 * 1024 ** 3, blockers: [], changes: ["Write an encrypted restic snapshot"],
        verification: ["Full repository data check"], encrypted: true, independent: true, repositoryVerified: false,
        protected: false, restoreDrill: { passed: false, reason: "not run" },
        warnings: ["Keep a recovery copy outside Bigbox."], recovery: "The local export remains unchanged.",
      },
    };
    const onOpenRepair = vi.fn();
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const body = init?.method === "POST"
        ? url.endsWith("/stage")
          ? { job: { id: "job-1", state: "awaiting_approval", title: "Reviewed VM job" } }
          : { plan: url.endsWith("/snapshot-plans") ? snapshotPlan : url.endsWith("/export-plans") ? exportPlan : url.endsWith("/protection-plans") ? protectionPlan : actionPlan }
        : url.endsWith("/status") ? status : url.endsWith("/resources") ? resources : url.endsWith("/console-guidance") ? consoleGuidance : url.endsWith("/protection") ? protection : url.endsWith("/exports") ? { exports: [exportArtifact] } : domains;
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }));

    render(<VirtualMachines csrfToken="csrf" onOpenRepair={onOpenRepair} />);

    expect(await screen.findByText("KVM host is ready")).toBeTruthy();
    expect(screen.getByText("ubuntu-lab")).toBeTruthy();
    expect(screen.getByText("192.168.122.25/24")).toBeTruthy();
    expect(screen.getByText("Libvirt resources")).toBeTruthy();
    expect(screen.getByText("No web console handoff is active.")).toBeTruthy();
    expect(screen.getByText(/80 GiB/)).toBeTruthy();
    expect((screen.getByRole("button", { name: "Reboot" }) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Reboot" }));
    expect(await screen.findByText("Immutable lifecycle plan")).toBeTruthy();
    expect(screen.getByText("Use the guest console if health does not return.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Stage for password approval" }));
    await vi.waitFor(() => expect(onOpenRepair).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("button", { name: "Plan snapshot" }));
    expect(await screen.findByText("Guarded offline snapshot")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Generate reviewed plan" }));
    expect(await screen.findByText("offline-consistent")).toBeTruthy();
    expect(screen.getByText("A snapshot is not an independent backup.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Stage for password approval" }));
    await vi.waitFor(() => expect(onOpenRepair).toHaveBeenCalledTimes(2));
    fireEvent.click(screen.getByRole("button", { name: "Plan export" }));
    expect(await screen.findByText("Verified local VM export")).toBeTruthy();
    expect(screen.getByText("This local export is not a protected backup.")).toBeTruthy();
    expect(screen.getByText("Per-disk content comparison")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Stage for password approval" }));
    await vi.waitFor(() => expect(onOpenRepair).toHaveBeenCalledTimes(3));
    fireEvent.click(screen.getByRole("button", { name: "Plan encrypted backup" }));
    expect(await screen.findByText("Encrypted independent VM backup")).toBeTruthy();
    expect(screen.getByText("Full repository data check")).toBeTruthy();
    expect(screen.getByText("Keep a recovery copy outside Bigbox.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Stage for password approval" }));
    await vi.waitFor(() => expect(onOpenRepair).toHaveBeenCalledTimes(4));
  });
});
