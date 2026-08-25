import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import VirtualMachines from "./VirtualMachines";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Virtual Machines", () => {
  it("survives a foundation answer with no conflicts or changes listed", async () => {
    // `foundation?.conflicts.map(...)` stopped one level too early, so a response without that
    // array threw and took the entire page blank — the same shape as the Logs and Repair Center
    // crashes. It stayed hidden because the demo could not render this page at all.
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
    // ready:false and planAvailable:false is the branch that maps over `conflicts`; the other two
    // branches never touch it, which is why an earlier version of this test passed with the bug in.
    const bare = { connectionUri: "qemu:///system", connectionReady: true, ready: false, revision: null, planAvailable: false,
      network: { name: "default", exists: false, active: false, autostart: false, persistent: false, compatible: false, bridge: "virbr0" },
      pool: { name: "default", exists: false, active: false, autostart: false, persistent: false, compatible: false, targetPath: "/var/lib/libvirt/images" },
      boundary: { mutationPerformed: false, browserResourceAccepted: false } }; // no conflicts, no changes
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.endsWith("/virtualization/status")) return json({ platform: "linux", architecture: "x86_64", connectionUri: "qemu:///system", ready: true, checks: [], tailscale: { installed: false, connected: false, dnsName: null, serveUrls: [] }, setupPlan: { title: "", destructive: false, requiresConsoleApproval: false, commands: [], notes: [] }, actions: { enabled: true, reason: "" } });
      if (url.endsWith("/virtualization/domains")) return json({ connected: true, domains: [], error: null });
      if (url.endsWith("/virtualization/resources")) return json({ connected: true, networks: [], pools: [], errors: [] });
      if (url.endsWith("/virtualization/console-guidance")) return json({ nativeProxyAvailable: false, cockpit: { installed: false, active: false, enabled: false, port: 9090 }, tailscaleDnsName: null, privateUrl: null, accessNote: "" });
      if (url.endsWith("/virtualization/foundation")) return json(bare);
      return json({ error: "unexpected" }, 503);
    }));
    render(<VirtualMachines csrfToken="csrf" onOpenRepair={vi.fn()} />);
    // The page renders rather than going blank, and offers its setup path.
    expect(await screen.findByText("Setup is blocked")).toBeTruthy();
    expect(screen.queryByText("Virtualization status is unavailable")).toBeNull();
  });

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
    const retentionStatus = {
      executable: true,
      policy: { minimumCopiesPerDomain: 3, minimumAgeDays: 30, requiresProtectedRestoreDrill: true, preserveRecoverySources: true },
      repositoryId: "d".repeat(64), beforeCount: 6,
      candidates: [{ backupId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", snapshotId: "b".repeat(64), domainName: "archive-lab", domainUuid: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", createdAt: "2026-06-01T00:00:00Z", ageDays: 75, sizeBytes: 4096 }],
      kept: [], blockers: [], changes: ["Forget exactly 1 reviewed restic snapshot metadata record(s)"],
      warnings: ["This release deliberately does not run restic prune."], verification: ["Every noncandidate id still present"],
      prunePerformed: false, spaceReclaimed: false, recovery: "Restore from another retained protected snapshot.", retentionRuns: [],
    };
    const recoveries = [{
      id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", backupId: protection.backups[1].id, sourceDomainName: "protected-lab", sourceDomainUuid: protection.backups[1].domainUuid,
      domainName: "protected-lab-recovery-old", domainUuid: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", destination: "managed-libvirt-recovery", sizeBytes: 8192,
      state: "stopped", network: "none", autostart: false, createdAt: "2026-08-15T21:00:00Z",
    }];
    // Every mutating flow stages a registry operation; capture each POST for assertions.
    const stagedOperations: Array<{ operationId: string; parameters: unknown }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const operationMatch = url.match(/\/api\/v1\/operations\/([^/]+)\/jobs$/);
      if (init?.method === "POST" && operationMatch) {
        stagedOperations.push({ operationId: operationMatch[1], parameters: JSON.parse(init.body as string).parameters });
        return new Response(JSON.stringify({
          job: { id: `job-${stagedOperations.length}`, type: `op:${operationMatch[1]}`, title: "Reviewed VM job", state: "awaiting_approval", risk: "medium", error: null, result: null, steps: [], approvals: [] },
          approval: { tier: "medium", passwordRequired: false, elevated: false, mode: "tiered", reason: "medium risk" },
        }), { status: 201, headers: { "Content-Type": "application/json" } });
      }
      if (url.endsWith("/operations/vm.stats.inspect/inspect")) return new Response(JSON.stringify({ operation: "vm.stats.inspect", result: { sampledAt: "2026-08-15T20:00:00Z", domains: [{ name: "ubuntu-lab", state: "running", cpuTimeNs: 5e9, vcpus: 2, memoryKiB: 2097152, memoryMaxKiB: 4194304, diskReadBytes: 0, diskWriteBytes: 0, netRxBytes: 0, netTxBytes: 0 }] } }), { status: 200, headers: { "Content-Type": "application/json" } });
      const body = url.endsWith("/status") ? status : url.endsWith("/resources") ? resources : url.endsWith("/foundation") ? foundation : url.endsWith("/console-guidance") ? consoleGuidance : url.endsWith("/protection") ? protection : url.endsWith("/retention") ? retentionStatus : url.endsWith("/exports") ? { exports: [exportArtifact] } : url.endsWith("/recoveries") ? { recoveries } : domains;
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }));

    render(<VirtualMachines csrfToken="csrf" onOpenRepair={vi.fn()} />);

    expect(await screen.findByText("KVM host is ready")).toBeTruthy();
    expect(screen.getByText("ubuntu-lab")).toBeTruthy();
    expect(screen.getByText("192.168.122.25/24")).toBeTruthy();
    expect(await screen.findByLabelText("Live resource use for ubuntu-lab")).toBeTruthy();
    expect(screen.getByText("RAM 2.0 GiB / 4.0 GiB")).toBeTruthy();
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
    // Name entry hands off to the shared dialog, which stages op:vm.snapshot.create.
    fireEvent.submit(screen.getByRole("button", { name: "Continue to confirm" }).closest("form") as HTMLFormElement);
    expect(await screen.findByText(/Snapshot snapshot-lab as checkpoint-/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Close dialog" }));
    fireEvent.click(screen.getByRole("button", { name: "Export" }));
    expect(await screen.findByText("Export snapshot-lab")).toBeTruthy();
    expect(screen.getByText(/not yet a protected backup/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Close dialog" }));
    fireEvent.click(screen.getByRole("button", { name: "Back up independently" }));
    expect(await screen.findByText("Back up snapshot-lab independently")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Close dialog" }));
    fireEvent.click(screen.getByRole("button", { name: "Apply retention" }));
    expect(await screen.findByText("Apply VM backup retention")).toBeTruthy();
    expect(screen.getByText(/Prune never runs/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Close dialog" }));
    fireEvent.click(screen.getByRole("button", { name: "Run isolated restore drill" }));
    expect(await screen.findByText("Restore drill for snapshot-lab")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Close dialog" }));
    expect(screen.getByText("protected-lab-recovery-old")).toBeTruthy();
    expect(screen.getByText(/Persistent \| network none \| autostart off/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Create recovery clone" }));
    expect(await screen.findByText("Guarded VM recovery clone")).toBeTruthy();
    expect((screen.getByRole("textbox", { name: /New VM name/ }) as HTMLInputElement).value).toBe("protected-lab-recovery");
    fireEvent.submit(screen.getByRole("button", { name: "Continue to confirm" }).closest("form") as HTMLFormElement);
    expect(await screen.findByText("Recover protected-lab as protected-lab-recovery")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Close dialog" }));
    // The browser names only the subject; the server pins the recorded evidence at staging time.
    expect(stagedOperations).toEqual([
      { operationId: "vm.action", parameters: { name: "ubuntu-lab", action: "reboot" } },
      { operationId: "vm.snapshot.create", parameters: { name: "snapshot-lab", snapshotName: expect.stringMatching(/^checkpoint-/) } },
      { operationId: "vm.export.create", parameters: { name: "snapshot-lab" } },
      { operationId: "vm.export.protect", parameters: { exportId: exportArtifact.id } },
      { operationId: "vm.backup.retention.apply", parameters: {} },
      { operationId: "vm.backup.restore-drill", parameters: { backupId: protection.backups[0].id } },
      { operationId: "vm.recovery.create", parameters: { backupId: protection.backups[1].id, targetDomainName: "protected-lab-recovery" } },
    ]);
  });
});
