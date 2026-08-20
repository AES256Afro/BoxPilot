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
    const foundation = {
      connectionUri: "qemu:///system", connectionReady: true, ready: true, revision: "a".repeat(64), planAvailable: false, changes: [], conflicts: [],
      network: { name: "default", exists: true, active: true, autostart: true, persistent: true, compatible: true, bridge: "virbr0", forwardMode: "nat", address: "192.168.122.1", rangeStart: "192.168.122.2", rangeEnd: "192.168.122.254" },
      pool: { name: "default", exists: true, active: true, autostart: true, persistent: true, compatible: true, type: "dir", targetPath: "/var/lib/libvirt/images", target: { exists: true, directory: true, symbolicLink: false } },
      boundary: { networkCidr: "192.168.122.0/24", poolTarget: "/var/lib/libvirt/images", mutationPerformed: false, browserResourceAccepted: false },
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
      backups: [{
        id: "55555555-5555-4555-8555-555555555555", exportId: exportArtifact.id, domainName: "snapshot-lab", domainUuid: exportArtifact.domainUuid,
        destination: "mounted-restic", repositoryId: "d".repeat(64), snapshotId: "f".repeat(64), sizeBytes: 4096,
        encrypted: true, independent: true, repositoryVerified: true, protected: false, retained: true, retention: null, restoreDrill: { passed: false, reason: "not run" }, createdAt: "2026-08-15T20:30:00Z",
      }, {
        id: "77777777-7777-4777-8777-777777777777", exportId: exportArtifact.id, domainName: "protected-lab", domainUuid: "88888888-8888-4888-8888-888888888888",
        destination: "mounted-restic", repositoryId: "d".repeat(64), snapshotId: "a".repeat(64), sizeBytes: 8192,
        encrypted: true, independent: true, repositoryVerified: true, protected: true, retained: true, retention: null,
        restoreDrill: { passed: true, drillId: "99999999-9999-4999-8999-999999999999" }, createdAt: "2026-08-15T20:45:00Z",
      }],
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
        warnings: ["Keep a recovery copy outside this server."], recovery: "The local export remains unchanged.",
      },
    };
    const retentionStatus = {
      executable: true,
      policy: { minimumCopiesPerDomain: 3, minimumAgeDays: 30, requiresProtectedRestoreDrill: true, preserveRecoverySources: true },
      repositoryId: "d".repeat(64), beforeCount: 6,
      candidates: [{ backupId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", snapshotId: "b".repeat(64), domainName: "archive-lab", domainUuid: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", createdAt: "2026-06-01T00:00:00Z", ageDays: 75, sizeBytes: 4096 }],
      kept: [], blockers: [], changes: ["Forget exactly 1 reviewed restic snapshot metadata record(s)"],
      warnings: ["This release deliberately does not run restic prune."], verification: ["Every noncandidate id still present"],
      prunePerformed: false, spaceReclaimed: false, recovery: "Restore from another retained protected snapshot.", retentionRuns: [],
    };
    const retentionPlan = {
      id: "retention-plan-1", revision: "retention-revision-1", status: "draft", expiresAt: "2026-08-15T22:00:00Z",
      input: { retentionId: "ffffffff-ffff-4fff-8fff-ffffffffffff", repositoryId: "d".repeat(64), expectedDestinationRevision: "e".repeat(64), expectedSnapshotSetRevision: "c".repeat(64), forgetSnapshotIds: ["b".repeat(64)] },
      output: { ...retentionStatus },
    };
    const restoreDrillPlan = {
      id: "restore-drill-plan-1", revision: "restore-drill-revision-1", status: "draft", expiresAt: "2026-08-15T22:00:00Z",
      input: {
        drillId: "66666666-6666-4666-8666-666666666666", backupId: protection.backups[0].id, exportId: exportArtifact.id,
        domainName: "snapshot-lab", domainUuid: exportArtifact.domainUuid, repositoryId: "d".repeat(64), snapshotId: "f".repeat(64),
        expectedManifestChecksumSha256: exportArtifact.manifestChecksumSha256, expectedSizeBytes: 4096, expectedDestinationRevision: "e".repeat(64),
      },
      output: {
        executable: true, drillDomain: "boxpilot-drill-66666666666646668666666666666666", network: "none", transient: true, memoryMiB: 2048, vcpus: 2,
        restoreFreeBytes: 20 * 1024 ** 3, requiredBytes: 1024 ** 3 + 4096, blockers: [],
        changes: ["Boot the restored disks as a fixed transient libvirt domain with no network interface"],
        verification: ["Repeated QEMU guest-agent health signal"], protected: false, protectedOnSuccess: true,
        warnings: ["The source guest must contain and enable qemu-guest-agent or this drill will fail safely."],
        recovery: "Remove only the server-generated transient drill domain.",
      },
    };
    const recoveryPlan = {
      id: "recovery-plan-1", revision: "recovery-revision-1", status: "draft", expiresAt: "2026-08-15T23:00:00Z",
      input: {
        restoreId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", backupId: protection.backups[1].id, exportId: exportArtifact.id,
        sourceDomainName: "protected-lab", sourceDomainUuid: protection.backups[1].domainUuid, targetDomainName: "protected-lab-recovery",
        restoreDrillId: "99999999-9999-4999-8999-999999999999", repositoryId: "d".repeat(64), snapshotId: "a".repeat(64),
        expectedManifestChecksumSha256: exportArtifact.manifestChecksumSha256, expectedSizeBytes: 8192, expectedDestinationRevision: "e".repeat(64),
      },
      output: {
        executable: true, targetDomainName: "protected-lab-recovery", destination: "managed-libvirt-recovery", network: "none", persistent: true,
        initialState: "stopped", autostart: false, memoryMiB: 2048, vcpus: 2, blockers: [],
        changes: ["Define a new persistent domain with no network interface"], verification: ["Exact protected snapshot identity and recovered disk checksums"],
        warnings: ["The source VM remains unchanged."], recovery: "Remove only the new domain and its generated recovery directory after exact validation.",
      },
    };
    const recoveries = [{
      id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", backupId: protection.backups[1].id, sourceDomainName: "protected-lab", sourceDomainUuid: protection.backups[1].domainUuid,
      domainName: "protected-lab-recovery-old", domainUuid: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", destination: "managed-libvirt-recovery", sizeBytes: 8192,
      state: "stopped", network: "none", autostart: false, createdAt: "2026-08-15T21:00:00Z",
    }];
    const onOpenRepair = vi.fn();
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const body = init?.method === "POST"
        ? url.endsWith("/stage")
          ? { job: { id: "job-1", state: "awaiting_approval", title: "Reviewed VM job" } }
          : { plan: url.endsWith("/snapshot-plans") ? snapshotPlan : url.endsWith("/export-plans") ? exportPlan : url.endsWith("/protection-plans") ? protectionPlan : url.endsWith("/retention-plans") ? retentionPlan : url.endsWith("/restore-drill-plans") ? restoreDrillPlan : url.endsWith("/recovery-plans") ? recoveryPlan : actionPlan }
        : url.endsWith("/status") ? status : url.endsWith("/resources") ? resources : url.endsWith("/foundation") ? foundation : url.endsWith("/console-guidance") ? consoleGuidance : url.endsWith("/protection") ? protection : url.endsWith("/retention") ? retentionStatus : url.endsWith("/exports") ? { exports: [exportArtifact] } : url.endsWith("/recoveries") ? { recoveries } : domains;
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
    expect(screen.getByText("Default VM foundation")).toBeTruthy();
    expect(screen.getByText("VM creation foundation verified")).toBeTruthy();
    expect(screen.getByText("No web console handoff is active.")).toBeTruthy();
    expect(screen.getByText(/80 GiB/)).toBeTruthy();
    expect((screen.getByRole("button", { name: "Reboot" }) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Reboot" }));
    // Lifecycle verbs stage op:vm.action through the shared risk-tiered dialog now.
    expect(await screen.findByText("Reboot ubuntu-lab")).toBeTruthy();
    expect(screen.getByText("Requests a guest reboot through libvirt.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Close dialog" }));
    fireEvent.click(screen.getByRole("button", { name: "Plan snapshot" }));
    expect(await screen.findByText("Guarded offline snapshot")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Generate reviewed plan" }));
    expect(await screen.findByText("offline-consistent")).toBeTruthy();
    expect(screen.getByText("A snapshot is not an independent backup.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Stage for password approval" }));
    await vi.waitFor(() => expect(onOpenRepair).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: "Plan export" }));
    expect(await screen.findByText("Verified local VM export")).toBeTruthy();
    expect(screen.getByText("This local export is not a protected backup.")).toBeTruthy();
    expect(screen.getByText("Per-disk content comparison")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Stage for password approval" }));
    await vi.waitFor(() => expect(onOpenRepair).toHaveBeenCalledTimes(2));
    fireEvent.click(screen.getByRole("button", { name: "Plan encrypted backup" }));
    expect(await screen.findByText("Encrypted independent VM backup")).toBeTruthy();
    expect(screen.getByText("Full repository data check")).toBeTruthy();
    expect(screen.getByText("Keep a recovery copy outside this server.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Stage for password approval" }));
    await vi.waitFor(() => expect(onOpenRepair).toHaveBeenCalledTimes(3));
    fireEvent.click(screen.getByRole("button", { name: "Review retention" }));
    expect(await screen.findByText("Guarded restic retention")).toBeTruthy();
    expect(screen.getByText(/archive-lab \| 75 days old/)).toBeTruthy();
    expect(screen.getByText("This release deliberately does not run restic prune.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Stage high-risk approval" }));
    await vi.waitFor(() => expect(onOpenRepair).toHaveBeenCalledTimes(4));
    fireEvent.click(screen.getByRole("button", { name: "Plan isolated restore drill" }));
    expect(await screen.findByText("Isolated VM restore drill")).toBeTruthy();
    expect(screen.getByText("Repeated QEMU guest-agent health signal")).toBeTruthy();
    expect(screen.getByText("The source guest must contain and enable qemu-guest-agent or this drill will fail safely.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Stage for password approval" }));
    await vi.waitFor(() => expect(onOpenRepair).toHaveBeenCalledTimes(5));
    expect(screen.getByText("protected-lab-recovery-old")).toBeTruthy();
    expect(screen.getByText(/Persistent \| network none \| autostart off/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Create recovery clone" }));
    expect(await screen.findByText("Guarded VM recovery clone")).toBeTruthy();
    expect((screen.getByRole("textbox", { name: /New VM name/ }) as HTMLInputElement).value).toBe("protected-lab-recovery");
    fireEvent.click(screen.getByRole("button", { name: "Generate reviewed plan" }));
    expect(await screen.findByText("Exact protected snapshot identity and recovered disk checksums")).toBeTruthy();
    expect(screen.getByText("The source VM remains unchanged.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Stage for password approval" }));
    await vi.waitFor(() => expect(onOpenRepair).toHaveBeenCalledTimes(6));
  });
});
