import { act, cleanup, configure, fireEvent, getConfig, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import VmsPage from "./VmsPage";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  window.history.replaceState(null, "", "/");
});

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const status = {
  platform: "linux", architecture: "x64", connectionUri: "qemu:///system", ready: true,
  checks: [{ id: "kvm", label: "KVM device access", ok: true, detail: "/dev/kvm is ready" }],
  tailscale: { installed: true, connected: true, dnsName: "server.example.ts.net", serveUrls: ["https://server.example.ts.net"] },
  setupPlan: { title: "Setup", destructive: false, requiresConsoleApproval: true, commands: ["virsh list --all"], notes: ["Use NAT first."] },
  actions: { enabled: true },
};
const domains = {
  connected: true, error: null,
  domains: [{
    name: "ubuntu-lab", uuid: "one", state: "running", vcpus: 2, memoryKiB: 4194304, persistent: true, autostart: true, managed: true,
    addresses: [{ interface: "vnet0", protocol: "ipv4", address: "192.168.122.25/24" }],
    disks: [{ type: "file", device: "disk", target: "vda", source: "/var/lib/libvirt/images/ubuntu-lab.qcow2" }],
    interfaces: [{ interface: "vnet0", type: "network", source: "default", model: "virtio", mac: "52:54:00:aa:bb:cc" }],
    snapshotCount: 1,
    snapshots: [{ name: "clean-install", manageable: true, current: false, state: "stopped", location: "internal", parent: null, createdAt: "2026-08-15" }],
    guestAgent: { available: true, filesystemState: "thawed", addressDiscovery: true },
  }, {
    name: "snapshot-lab", uuid: "11111111-1111-4111-8111-111111111111", state: "stopped", vcpus: 1, memoryKiB: 2097152, persistent: true, autostart: false, managed: true,
    addresses: [], disks: [{ type: "file", device: "disk", target: "vda", source: "/var/lib/libvirt/images/snapshot-lab.qcow2" }], interfaces: [], snapshotCount: 1,
    snapshots: [{ name: "before-upgrade", manageable: true, current: true, state: "stopped", location: "internal", parent: null, createdAt: "2026-08-15" }],
    guestAgent: { available: false, filesystemState: null, addressDiscovery: false },
  }],
};
const resources = {
  connected: true, errors: [],
  networks: [{ name: "default", active: true, autostart: true, persistent: true, bridge: "virbr0" }],
  pools: [{ name: "default", active: true, autostart: true, persistent: true, type: "dir", targetPath: "/var/lib/libvirt/images", capacity: "100 GiB", allocation: "20 GiB", available: "80 GiB", availableBytes: 80 * 1024 ** 3 }],
};
const foundation = {
  connectionUri: "qemu:///system", connectionReady: true, ready: true, revision: "a".repeat(64), planAvailable: false, changes: [], conflicts: [],
  network: { name: "default", exists: true, active: true, autostart: true, persistent: true, compatible: true, bridge: "virbr0" },
  pool: { name: "default", exists: true, active: true, autostart: true, persistent: true, compatible: true, targetPath: "/var/lib/libvirt/images" },
  boundary: { networkCidr: "192.168.122.0/24", poolTarget: "/var/lib/libvirt/images", mutationPerformed: false, browserResourceAccepted: false },
};
const guidance = { nativeProxyAvailable: false, cockpit: { installed: false, active: false, enabled: false, port: 9090 }, tailscaleDnsName: null, privateUrl: null, accessNote: "No web console handoff is active." };
const exportArtifact = {
  id: "22222222-2222-4222-8222-222222222222", domainName: "snapshot-lab", domainUuid: "11111111-1111-4111-8111-111111111111",
  destination: "local-managed", artifactPath: "/var/lib/boxpilot-managed/vm-exports/2222", manifestChecksumSha256: "c".repeat(64), sizeBytes: 4096,
  protected: false, encrypted: false, restoreDrill: { passed: false, reason: "not run" }, createdAt: "2026-08-15T20:00:00Z",
};
const protection = {
  destination: {
    adapter: "mounted-restic", ready: true, encrypted: true, independent: true, resticVersion: "0.19.1",
    mount: { target: "/mnt/boxpilot-backup", sourceType: "ext4", independentFilesystem: true, writable: true },
    repositoryId: "d".repeat(64), destinationRevision: "e".repeat(64), destinationFreeBytes: 20 * 1024 ** 3, blockers: [], setupCommand: "sudo /opt/boxpilot/scripts/boxpilot-restic-setup.sh", recoveryKeyRequired: true,
  },
  backups: [{
    id: "55555555-5555-4555-8555-555555555555", exportId: exportArtifact.id, domainName: "snapshot-lab", domainUuid: exportArtifact.domainUuid, destination: "mounted-restic",
    repositoryId: "d".repeat(64), snapshotId: "f".repeat(64), sizeBytes: 4096, encrypted: true, independent: true, repositoryVerified: true, protected: false, retained: true, retention: null,
    restoreDrill: { passed: false, reason: "not run" }, createdAt: "2026-08-15T20:30:00Z",
  }, {
    id: "77777777-7777-4777-8777-777777777777", exportId: exportArtifact.id, domainName: "protected-lab", domainUuid: "88888888-8888-4888-8888-888888888888", destination: "mounted-restic",
    repositoryId: "d".repeat(64), snapshotId: "a".repeat(64), sizeBytes: 8192, encrypted: true, independent: true, repositoryVerified: true, protected: true, retained: true, retention: null,
    restoreDrill: { passed: true }, createdAt: "2026-08-15T20:45:00Z",
  }],
};
const retention = {
  executable: true, policy: { minimumCopiesPerDomain: 3, minimumAgeDays: 30, requiresProtectedRestoreDrill: true, preserveRecoverySources: true },
  repositoryId: "d".repeat(64), beforeCount: 6, unrecordedSnapshotIds: ["9".repeat(64)],
  candidates: [{ backupId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", snapshotId: "b".repeat(64), domainName: "archive-lab", domainUuid: "eeee", createdAt: "2026-06-01T00:00:00Z", ageDays: 75, sizeBytes: 4096 }],
  kept: [], blockers: [], changes: [], warnings: [], verification: [], prunePerformed: false, spaceReclaimed: false, recovery: "", retentionRuns: [],
};
const recoveries = [{
  id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", backupId: protection.backups[1].id, sourceDomainName: "protected-lab", sourceDomainUuid: protection.backups[1].domainUuid,
  domainName: "protected-lab-recovery-old", domainUuid: "cccc", destination: "managed-libvirt-recovery", sizeBytes: 8192, state: "stopped", network: "none", autostart: false, createdAt: "2026-08-15T21:00:00Z",
}];

/** The whole page's reads, plus every staged operation captured for the assertions. */
function serve(overrides: Record<string, unknown> = {}, confirmFor: Record<string, string> = {}) {
  const staged: Array<{ operationId: string; parameters: unknown }> = [];
  const bodies: Record<string, unknown> = {
    "/virtualization/status": status, "/virtualization/domains": domains, "/virtualization/resources": resources, "/virtualization/console-guidance": guidance,
    "/virtualization/foundation": foundation, "/virtualization/exports": { exports: [exportArtifact] }, "/virtualization/protection": protection,
    "/virtualization/retention": retention, "/virtualization/recoveries": { recoveries }, ...overrides,
  };
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input.toString();
    const operation = url.match(/\/api\/v1\/operations\/([^/]+)\/jobs$/);
    if (init?.method === "POST" && operation) {
      staged.push({ operationId: operation[1], parameters: JSON.parse(init.body as string).parameters });
      const tier = operation[1] === "vm.delete" || operation[1] === "vm.create" ? "high" : "medium";
      return json({
        job: { id: `job-${staged.length}`, type: `op:${operation[1]}`, title: "VM job", state: "awaiting_approval", risk: tier, error: null, result: null, steps: [], approvals: [] },
        approval: { tier, passwordRequired: tier === "high", elevated: false, mode: "tiered", reason: `${tier} risk`, confirmText: confirmFor[operation[1]] ?? null },
      }, 201);
    }
    if (url.endsWith("/operations/vm.stats.inspect/inspect")) return json({ operation: "vm.stats.inspect", result: { sampledAt: "2026-08-15T20:00:00Z", domains: [{ name: "ubuntu-lab", state: "running", cpuTimeNs: 5e9, vcpus: 2, memoryKiB: 2097152, memoryMaxKiB: 4194304, diskReadBytes: 0, diskWriteBytes: 0, netRxBytes: 0, netTxBytes: 0 }] } });
    const path = url.replace(/^.*\/api\/v1/, "");
    if (path in bodies) { const body = bodies[path]; return body instanceof Response ? body : json(body); }
    return json({ error: `unexpected ${url}` }, 404);
  }));
  return staged;
}

const closeDialog = () => fireEvent.click(screen.getByRole("button", { name: "Close dialog" }));

describe("Virtual machines page", () => {
  it("puts the verdict and the counts first, then the machines with their live use", async () => {
    serve();
    render(<VmsPage csrfToken="csrf" />);
    expect(await screen.findByText("ubuntu-lab")).toBeTruthy();
    expect(screen.getByRole("heading", { level: 1, name: "Virtual Machines" })).toBeTruthy();
    expect(screen.getByText("Host ready").closest(".ui-chip")?.getAttribute("data-status")).toBe("good");
    expect(document.querySelector(".ui-page-header__meta")?.textContent).toBe("2 VMs · 1 running · 1/1 checks · qemu:///system");
    const table = screen.getByRole("table", { name: "Virtual machines" });
    expect(within(table).getByText("192.168.122.25/24")).toBeTruthy();
    // The first stats sample gives memory; CPU needs a second one.
    expect(await within(table).findByText("2.0 GiB / 4.0 GiB")).toBeTruthy();
    // Running first, then stopped; each row with the actions its state allows, each with its tier.
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows[0].textContent).toContain("ubuntu-lab");
    expect(screen.getByRole("button", { name: "Reboot ubuntu-lab" }).getAttribute("data-risk")).toBe("medium");
    expect(screen.getByRole("button", { name: "Start snapshot-lab" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Start ubuntu-lab" })).toBeNull();
    // What the page is for, and what each action asks for, waits behind the info toggle.
    fireEvent.click(screen.getByRole("button", { name: "About Virtual Machines" }));
    expect(screen.getByText(/ask for your password and the VM's name typed out/)).toBeTruthy();
  });

  it("stages a lifecycle action from a row through the approval dialog", async () => {
    const staged = serve();
    render(<VmsPage csrfToken="csrf" />);
    fireEvent.click(await screen.findByRole("button", { name: "Reboot ubuntu-lab" }));
    expect(await screen.findByText("Reboot ubuntu-lab")).toBeTruthy();
    expect(screen.getByText("Requests a guest reboot through libvirt.")).toBeTruthy();
    expect(staged).toEqual([{ operationId: "vm.action", parameters: { name: "ubuntu-lab", action: "reboot" } }]);
  });

  // Each action is a findBy wait through a sheet and a dialog; under a loaded machine that is more
  // than testing-library's one second, so this test has a longer budget of its own.
  it("opens a stopped VM's sheet and stages its snapshot, export and delete, the delete asking for the name", async () => {
    const previous = getConfig().asyncUtilTimeout;
    configure({ asyncUtilTimeout: 5000 });
    try {
      const staged = serve({}, { "vm.delete": "snapshot-lab", "vm.snapshot.revert": "snapshot-lab" });
      render(<VmsPage csrfToken="csrf" />);
      const open = async () => { fireEvent.click(await screen.findByRole("button", { name: "Open snapshot-lab" })); return screen.findByRole("dialog", { name: "snapshot-lab" }); };

      let sheet = await open();
      expect(within(sheet).getByText("Persistent")).toBeTruthy();
      expect(within(sheet).getByText(/Revert asks for your password, then the name/)).toBeTruthy();
      expect(within(sheet).getByText(/Asks for your password, then the name/)).toBeTruthy();
      fireEvent.click(within(sheet).getByRole("button", { name: "Take snapshot" }));
      expect(await screen.findByText(/Snapshot snapshot-lab as checkpoint-/)).toBeTruthy();
      expect(screen.queryByRole("dialog", { name: "snapshot-lab" })).toBeNull();
      closeDialog();

      sheet = await open();
      fireEvent.click(within(sheet).getByRole("button", { name: "Export" }));
      expect(await screen.findByText("Export snapshot-lab")).toBeTruthy();
      expect(screen.getByText(/not yet a backup kept somewhere else/)).toBeTruthy();
      closeDialog();

      sheet = await open();
      const remove = within(sheet).getByRole("button", { name: /Delete VM/ });
      expect(remove.getAttribute("data-risk")).toBe("high");
      fireEvent.click(remove);
      expect(await screen.findByText("Delete snapshot-lab")).toBeTruthy();
      expect(await screen.findByLabelText("Typed confirmation")).toBeTruthy();
      expect(screen.getByLabelText("Approval password")).toBeTruthy();
      closeDialog();

      expect(staged).toEqual([
        { operationId: "vm.snapshot.create", parameters: { name: "snapshot-lab", snapshotName: expect.stringMatching(/^checkpoint-/) } },
        { operationId: "vm.export.create", parameters: { name: "snapshot-lab" } },
        { operationId: "vm.delete", parameters: { name: "snapshot-lab", deleteStorage: true } },
      ]);
    } finally {
      configure({ asyncUtilTimeout: previous });
    }
  }, 20_000);

  it("keeps backups on their own tab: protect, retention, test restore and a recovery clone", async () => {
    const previous = getConfig().asyncUtilTimeout;
    configure({ asyncUtilTimeout: 5000 });
    try {
      const staged = serve();
      render(<VmsPage csrfToken="csrf" />);
      await screen.findByText("ubuntu-lab");
      fireEvent.click(screen.getByRole("tab", { name: /Backups/ }));
      expect(window.location.search).toBe("?tab=backups");
      expect(await screen.findByText("protected-lab-recovery-old")).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "Keep a second copy" }));
      expect(await screen.findByText("Keep an encrypted copy of snapshot-lab")).toBeTruthy();
      closeDialog();
      fireEvent.click(screen.getByRole("button", { name: "Apply retention" }));
      expect(await screen.findByText("Apply VM backup retention")).toBeTruthy();
      expect(screen.getByText(/no space is reclaimed/)).toBeTruthy();
      closeDialog();
      fireEvent.click(screen.getByRole("button", { name: "Test the restore" }));
      expect(await screen.findByText("Restore drill for snapshot-lab")).toBeTruthy();
      closeDialog();
      fireEvent.click(screen.getByRole("button", { name: "Create recovery clone" }));
      const sheet = await screen.findByRole("dialog", { name: "Recover protected-lab" });
      expect((within(sheet).getByRole("textbox", { name: /New VM name/ }) as HTMLInputElement).value).toBe("protected-lab-recovery");
      fireEvent.click(within(sheet).getByRole("button", { name: /Continue to confirm/ }));
      expect(await screen.findByText("Recover protected-lab as protected-lab-recovery")).toBeTruthy();
      closeDialog();
      // Forgetting a snapshot with no record is the owner's, high risk, and says it asks for the id.
      expect(screen.getByRole("button", { name: /Forget 99999999/ }).getAttribute("data-risk")).toBe("high");
      expect(screen.getByText(/Forgetting one asks for your password/)).toBeTruthy();
      expect(staged).toEqual([
        { operationId: "vm.export.protect", parameters: { exportId: exportArtifact.id } },
        { operationId: "vm.backup.retention.apply", parameters: {} },
        { operationId: "vm.backup.restore-drill", parameters: { backupId: protection.backups[0].id } },
        { operationId: "vm.recovery.create", parameters: { backupId: protection.backups[1].id, targetDomainName: "protected-lab-recovery" } },
      ]);
    } finally {
      configure({ asyncUtilTimeout: previous });
    }
  }, 20_000);

  it("survives a foundation answer with no conflicts or changes listed, and shows the blocked setup on the Host tab", async () => {
    // A response without `conflicts` once threw and took the whole page blank. ready:false and
    // planAvailable:false is the branch that lists them.
    const bare = { ...foundation, ready: false, planAvailable: false, conflicts: undefined, changes: undefined };
    serve({ "/virtualization/foundation": bare, "/virtualization/domains": { connected: true, domains: [], error: null } });
    render(<VmsPage csrfToken="csrf" onOpenRepair={vi.fn()} />);
    expect(await screen.findByText("No virtual machines yet")).toBeTruthy();
    const host = screen.getByRole("tab", { name: /Host/ });
    expect(host.textContent).not.toBe("");
    fireEvent.click(host);
    expect(await screen.findByText("Setup is blocked")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Open Repair" })).toBeTruthy();
    expect(screen.queryByText("Virtualization status is unavailable")).toBeNull();
  });

  it("gives a viewer the machines and no actions", async () => {
    serve();
    render(<VmsPage csrfToken="csrf" role="viewer" />);
    const table = await screen.findByRole("table", { name: "Virtual machines" });
    await within(table).findByText("ubuntu-lab");
    const actions = within(table).queryAllByRole("button").filter((button) => !button.classList.contains("ui-table__sort") && !button.classList.contains("vms-open"));
    expect(actions.map((button) => button.textContent)).toEqual(["Open", "Open"]);
    expect(screen.queryByRole("button", { name: "From a cloud image" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Plan from an ISO" })).toBeNull();
  });

  it("gives an operator the medium-risk actions but not the high-risk ones", async () => {
    serve();
    render(<VmsPage csrfToken="csrf" role="operator" />);
    fireEvent.click(await screen.findByRole("button", { name: "Open snapshot-lab" }));
    const sheet = await screen.findByRole("dialog", { name: "snapshot-lab" });
    expect(within(sheet).getByRole("button", { name: "Take snapshot" })).toBeTruthy();
    expect(within(sheet).queryByRole("button", { name: /Delete VM/ })).toBeNull();
    expect(within(sheet).queryByRole("button", { name: /Revert/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "Plan from an ISO" })).toBeNull();
    expect(screen.getByRole("button", { name: "From a cloud image" })).toBeTruthy();
  });

  it("says when the host could not be read, and offers to try again", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ error: "The helper is not answering" }, 500)));
    render(<VmsPage csrfToken="csrf" />);
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getByText("Not read").closest(".ui-chip")?.getAttribute("data-status")).toBe("unknown");
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
  });

  it("creates a VM from a plan asking for the password and the new VM's name", async () => {
    const staged = serve({
      "/virtualization/planning-options": {
        mediaRoot: "/var/lib/libvirt/boot", mediaError: null, isoImages: [{ name: "ubuntu.iso", sizeBytes: 5 * 1024 ** 3, modifiedAt: "2026-08-14T12:00:00Z" }],
        hostCapacity: { cpuThreads: 8, memoryMiB: 32768 }, limits: { vcpus: { minimum: 1, maximum: 32 }, memoryMiB: { minimum: 1024, maximum: 131072 }, diskGiB: { minimum: 8, maximum: 4096 } },
        profiles: [{ id: "ubuntu-24.04", label: "Ubuntu 24.04 LTS", osVariant: "ubuntu24.04", minimumMemoryMiB: 2048, minimumDiskGiB: 20 }],
        networks: [{ name: "default", kind: "NAT", recommended: true }], firmware: ["uefi", "bios"],
      },
    });
    const plan = { id: "plan-1", revision: "revision12345678", stageable: true, input: { name: "new-lab", osProfile: "ubuntu-24.04", vcpus: 2, memoryMiB: 4096, diskGiB: 40, isoFile: "ubuntu.iso", network: "default", firmware: "uefi", autostart: false }, profile: { label: "Ubuntu 24.04 LTS", osVariant: "ubuntu24.04" }, media: { name: "ubuntu.iso", sizeBytes: 1, modifiedAt: "" }, warnings: [], command: { program: "virt-install", arguments: [], display: "virt-install --name new-lab" }, gates: ["Execute through the restricted libvirt helper"] };
    const base = globalThis.fetch;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => (input.toString().endsWith("/virtualization/plans") ? json({ ok: true, plan }) : base(input, init))));
    render(<VmsPage csrfToken="csrf" />);
    fireEvent.click(await screen.findByRole("button", { name: "Plan from an ISO" }));
    const sheet = await screen.findByRole("dialog", { name: "Plan from an ISO" });
    expect(await within(sheet).findByText("Host CPU threads")).toBeTruthy();
    fireEvent.change(within(sheet).getByLabelText(/VM name/), { target: { value: "new-lab" } });
    fireEvent.click(within(sheet).getByRole("button", { name: "Generate reviewed plan" }));
    expect(await within(sheet).findByText("Ready to create")).toBeTruthy();
    expect(within(sheet).getByText("virt-install --name new-lab")).toBeTruthy();
    expect(within(sheet).getByText(/Creating it asks for your password, then the name/)).toBeTruthy();
    const go = within(sheet).getByRole("button", { name: /Continue to approval/ });
    expect(go.getAttribute("data-risk")).toBe("high");
    fireEvent.click(go);
    expect(await screen.findByText("Create VM new-lab")).toBeTruthy();
    // The dialog's own words say what to type: the new VM's name.
    expect((await screen.findByLabelText("Typed confirmation")).closest("label")?.textContent).toBe("Type new-lab to confirm");
    expect(staged).toEqual([{ operationId: "vm.create", parameters: plan.input }]);
  });

  it("waits for each stats sample before the next, and pauses while the tab is hidden", async () => {
    vi.useFakeTimers();
    const answers: Array<() => void> = [];
    let samples = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      if (input.toString().endsWith("/operations/vm.stats.inspect/inspect")) {
        samples += 1;
        return new Promise<Response>((resolve) => { answers.push(() => resolve(json({ operation: "vm.stats.inspect", result: { sampledAt: new Date().toISOString(), domains: [] } }))); });
      }
      return new Promise<Response>(() => undefined); // the rest of the page stays loading; only stats matter here
    }));
    let hidden = false;
    const visibility = vi.spyOn(document, "hidden", "get").mockImplementation(() => hidden);
    render(<VmsPage csrfToken="csrf" />);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(samples).toBe(1);
    // A slow answer holds the next sample back instead of stacking requests.
    await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
    expect(samples).toBe(1);
    await act(async () => { answers.shift()?.(); await vi.advanceTimersByTimeAsync(5000); });
    expect(samples).toBe(2);
    await act(async () => { answers.shift()?.(); await vi.advanceTimersByTimeAsync(0); });
    hidden = true;
    await act(async () => { document.dispatchEvent(new Event("visibilitychange")); await vi.advanceTimersByTimeAsync(30_000); });
    expect(samples).toBe(2);
    hidden = false;
    await act(async () => { document.dispatchEvent(new Event("visibilitychange")); await vi.advanceTimersByTimeAsync(0); });
    expect(samples).toBe(3);
    visibility.mockRestore();
  });

  it("closes a VM's sheet on Escape and gives focus back to what opened it", async () => {
    serve();
    render(<VmsPage csrfToken="csrf" />);
    const opener = await screen.findByRole("button", { name: "Open ubuntu-lab" });
    opener.focus();
    fireEvent.click(opener);
    const sheet = await screen.findByRole("dialog", { name: "ubuntu-lab" });
    await waitFor(() => expect(document.activeElement).toBe(sheet));
    expect(within(sheet).getByText("clean-install")).toBeTruthy();
    fireEvent.keyDown(sheet, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(opener);
  });
});
