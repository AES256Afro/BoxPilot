import { useCallback, useEffect, useRef, useState } from "react";
import { sentenceList, countOf } from "./data";
import { inspectOperation } from "./operations";
import CloudVmForm from "./CloudVmForm";
import { useOperation } from "./ApproveDialog";
import {
  fetchVmExports,
  fetchLibvirtFoundation,
  fetchVmProtection,
  fetchVmRecoveries,
  fetchVmRetention,
  fetchVirtualization,
  formatBytes,
  formatMemory,
  type LibvirtResources,
  type LibvirtFoundation,
  type ConsoleGuidance,
  type DomainList,
  type VirtualDomain,
  type VmExportArtifact,
  type VmProtectedBackup,
  type VmProtectionDestination,
  type VmRecoveryRecord,
  type VmRetentionStatus,
  type VirtualizationStatus,
} from "./virtualization";
import VmPlanner from "./VmPlanner";
import VmMediaLibrary from "./VmMediaLibrary";

function stateTone(state: string): string {
  if (state === "running") return "good";
  if (state === "stopped") return "neutral";
  return "warning";
}

function availableActions(domain: VirtualDomain) {
  const actions: Array<[string, string]> = [];
  if (domain.state === "running") {
    actions.push(
        ["shutdown", "Shut down"],
        ["reboot", "Reboot"],
    );
  } else if (domain.state === "stopped") {
    actions.push(["start", "Start"]);
  }
  actions.push([
    domain.autostart ? "autostart-off" : "autostart-on",
    domain.autostart ? "Disable autostart" : "Enable autostart",
  ]);
  return actions;
}

// libvirt.mjs marks a domain or snapshot unmanageable when its name is one BoxPilot's operations
// will refuse; saying so is better than staging a job that fails with a validator string.
const unmanagedNote = "This VM's name is not one BoxPilot can act on. Manage it with virsh.";
const unmanagedSnapshotNote = "This snapshot's name is not one BoxPilot can act on. Manage it with virsh.";

export default function VirtualMachines({ csrfToken = "", onOpenRepair = () => {} }: { csrfToken?: string; onOpenRepair?: () => void }) {
  const [status, setStatus] = useState<VirtualizationStatus | null>(null);
  const [domainList, setDomainList] = useState<DomainList | null>(null);
  const [resources, setResources] = useState<LibvirtResources | null>(null);
  const [foundation, setFoundation] = useState<LibvirtFoundation | null>(null);
  const [consoleGuidance, setConsoleGuidance] = useState<ConsoleGuidance | null>(null);
  const [loading, setLoading] = useState(true);
  // Which of the page's extra reads failed, so their panels say so instead of showing an empty list.
  const [unread, setUnread] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [plannerOpen, setPlannerOpen] = useState(false);
  const [snapshotDomain, setSnapshotDomain] = useState<VirtualDomain | null>(null);
  const [snapshotName, setSnapshotName] = useState("");
  const [exports, setExports] = useState<VmExportArtifact[]>([]);
  const [protectionDestination, setProtectionDestination] = useState<VmProtectionDestination | null>(null);
  const [protectedBackups, setProtectedBackups] = useState<VmProtectedBackup[]>([]);
  const [retentionStatus, setRetentionStatus] = useState<VmRetentionStatus | null>(null);
  const [recoveries, setRecoveries] = useState<VmRecoveryRecord[]>([]);
  const [recoveryBackup, setRecoveryBackup] = useState<VmProtectedBackup | null>(null);
  const [recoveryName, setRecoveryName] = useState("");
  // Live resource use (M7.8): two domstats samples → rates. Polled only while the page is open.
  interface DomainStats { name: string; state: string; cpuTimeNs: number; vcpus: number | null; memoryKiB: number | null; memoryMaxKiB: number | null; diskReadBytes: number; diskWriteBytes: number; netRxBytes: number; netTxBytes: number }
  const [rates, setRates] = useState<Record<string, { cpuPercent: number | null; memoryKiB: number | null; memoryMaxKiB: number | null; diskBytesPerSecond: number | null; netBytesPerSecond: number | null }>>({});
  const previousSample = useRef<{ at: number; domains: DomainStats[] } | null>(null);
  useEffect(() => {
    let cancelled = false;
    const sample = async () => {
      try {
        const { result } = await inspectOperation<{ sampledAt: string; domains: DomainStats[] }>("vm.stats.inspect");
        const at = Date.parse(result.sampledAt) || Date.now();
        const previous = previousSample.current;
        const next: typeof rates = {};
        for (const domain of result.domains) {
          const before = previous?.domains.find((entry) => entry.name === domain.name);
          const seconds = previous ? (at - previous.at) / 1000 : 0;
          const cpuPercent = before && seconds > 0 && domain.state === "running" ? Math.max(0, Math.min(100, ((domain.cpuTimeNs - before.cpuTimeNs) / 1e9 / seconds / Math.max(1, domain.vcpus ?? 1)) * 100)) : null;
          const diskBytesPerSecond = before && seconds > 0 ? Math.max(0, (domain.diskReadBytes + domain.diskWriteBytes - before.diskReadBytes - before.diskWriteBytes) / seconds) : null;
          const netBytesPerSecond = before && seconds > 0 ? Math.max(0, (domain.netRxBytes + domain.netTxBytes - before.netRxBytes - before.netTxBytes) / seconds) : null;
          next[domain.name] = { cpuPercent, memoryKiB: domain.memoryKiB, memoryMaxKiB: domain.memoryMaxKiB, diskBytesPerSecond, netBytesPerSecond };
        }
        previousSample.current = { at, domains: result.domains };
        if (!cancelled) setRates(next);
      } catch { /* stats are a convenience; the page works without them */ }
    };
    void sample();
    const timer = window.setInterval(() => { void sample(); }, 5000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, []);
  const rateLabel = (bytesPerSecond: number | null) => (bytesPerSecond === null ? "—" : bytesPerSecond >= 1024 ** 2 ? `${(bytesPerSecond / 1024 ** 2).toFixed(1)} MiB/s` : `${(bytesPerSecond / 1024).toFixed(0)} KiB/s`);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [[nextStatus, nextDomains, nextResources, nextConsoleGuidance], nextFoundation, nextExports, nextProtection, nextRecoveries, nextRetention] = await Promise.all([
        fetchVirtualization(),
        fetchLibvirtFoundation(),
        // These four are extras: if one cannot be read the page still shows the VMs.
        fetchVmExports().then((value) => ({ read: true, value }), () => ({ read: false, value: null })),
        fetchVmProtection().then((value) => ({ read: true, value }), () => ({ read: false, value: null })),
        fetchVmRecoveries().then((value) => ({ read: true, value }), () => ({ read: false, value: null })),
        fetchVmRetention().then((value) => ({ read: true, value }), () => ({ read: false, value: null })),
      ]);
      setStatus(nextStatus);
      setDomainList(nextDomains);
      setResources(nextResources);
      setFoundation(nextFoundation);
      setConsoleGuidance(nextConsoleGuidance);
      setExports(nextExports.value ?? []);
      setProtectionDestination(nextProtection.value?.destination ?? null);
      setProtectedBackups(Array.isArray(nextProtection.value?.backups) ? nextProtection.value.backups : []);
      setRecoveries(nextRecoveries.value ?? []);
      setRetentionStatus(nextRetention.value);
      setUnread([
        ...(nextExports.read ? [] : ["exports"]),
        ...(nextProtection.read ? [] : ["the encrypted destination"]),
        ...(nextRecoveries.read ? [] : ["recoveries"]),
        ...(nextRetention.read ? [] : ["retention"]),
      ]);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Unable to load virtualization status");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // The direct lifecycle verbs (force off, delete, snapshot revert/delete) use the shared
  // risk-tiered ApproveDialog instead of the legacy plan/stage path.
  const { start: rawStart, dialog: operationDialog } = useOperation(csrfToken, () => { void refresh(); setPending(null); });
  /** Marks the page busy while an approval dialog is open, so the disabled guards actually hold. */
  const startOperation: typeof rawStart = (operation) => { setPending(operation.title); rawStart(operation); };
  // The page is busy exactly while an approval dialog is open — including when it is dismissed.
  useEffect(() => { if (!operationDialog) setPending(null); }, [operationDialog]);

  const copySetupCommands = async () => {
    if (!status) return;
    try {
      await navigator.clipboard.writeText(status.setupPlan.commands.join("\n"));
      setMessage("Setup commands copied. Review every command in the Ubuntu console before running it.");
    } catch {
      setMessage("Clipboard access was unavailable. Select the commands and copy them manually.");
    }
  };

  const initializeFoundation = () => {
    startOperation({
      operationId: "vm.foundation.initialize",
      title: "Initialize the libvirt foundation",
      parameters: {},
      preview: <span>Defines, starts, and autostarts only the missing canonical default NAT network and default storage pool. Failure rolls back only this job's changes.</span>,
    });
  };

  const actionPreviews: Record<string, string> = {
    start: "Starts the VM and verifies libvirt reports it running.",
    shutdown: "Requests a graceful ACPI shutdown and waits up to two minutes. The plug is never pulled. Force off exists for that.",
    reboot: "Requests a guest reboot through libvirt.",
    "autostart-on": "The VM will start automatically when this server boots.",
    "autostart-off": "The VM will no longer start automatically when this server boots.",
  };

  const performAction = (domain: VirtualDomain, action: string, label: string) => {
    startOperation({ operationId: "vm.action", title: `${label} ${domain.name}`, parameters: { name: domain.name, action }, preview: <span>{actionPreviews[action] ?? label}</span> });
  };


  const openSnapshotPlanner = (domain: VirtualDomain) => {
    setSnapshotDomain(domain);
    setSnapshotName(`checkpoint-${new Date().toISOString().slice(0, 10)}`);
    setMessage(null);
  };

  const createSnapshot = () => {
    if (!snapshotDomain) return;
    const domain = snapshotDomain;
    setSnapshotDomain(null);
    startOperation({
      operationId: "vm.snapshot.create",
      title: `Snapshot ${domain.name} as ${snapshotName}`,
      parameters: { name: domain.name, snapshotName },
      preview: <span>Creates an offline internal snapshot of the stopped VM. Only plain qcow2 disks qualify. Checked before anything runs, and a snapshot is not an independent backup.</span>,
    });
  };

  // The export/protect/retention/drill/recovery workflows stage registry operations. The server
  // pins the live evidence (disk revisions, checksums, candidate sets) when the job is created,
  // and the helper revalidates everything again at execution time.
  const startExport = (domain: VirtualDomain) => {
    startOperation({
      operationId: "vm.export.create",
      title: `Export ${domain.name}`,
      parameters: { name: domain.name },
      preview: <span>Flattens the stopped VM's disks into standalone qcow2 files with SHA-256 evidence, verified against the source. This is a local integrity-checked artifact, not yet a protected backup. The source VM is unchanged and must stay stopped.</span>,
    });
  };

  const startProtection = (artifact: VmExportArtifact) => {
    startOperation({
      operationId: "vm.export.protect",
      title: `Back up ${artifact.domainName} independently`,
      parameters: { exportId: artifact.id },
      preview: <span>Reverifies the local export, writes an encrypted restic snapshot to the independent destination, and reads the whole repository back. Protected status still requires the isolated restore drill afterwards.</span>,
    });
  };

  const startRetention = () => {
    startOperation({
      operationId: "vm.backup.retention.apply",
      title: "Apply VM backup retention",
      parameters: {},
      preview: <span>Forgets only the currently eligible old snapshots. Restore-tested, unreferenced, over the age floor, and never below {retentionStatus?.policy?.minimumCopiesPerDomain ?? 3} copies per VM. Then verifies the repository. Prune never runs, so no space is reclaimed.</span>,
    });
  };

  const startRestoreDrill = (backup: VmProtectedBackup) => {
    startOperation({
      operationId: "vm.backup.restore-drill",
      title: `Restore drill for ${backup.domainName}`,
      parameters: { backupId: backup.id },
      preview: <span>Restores the encrypted snapshot to a temporary workspace, boots it as a transient VM with no network, and requires guest-agent health before marking the backup protected. Everything transient is cleaned up afterwards.</span>,
    });
  };

  const openRecoveryPlanner = (backup: VmProtectedBackup) => {
    setRecoveryBackup(backup);
    setRecoveryName(`${backup.domainName}-recovery`);
    setMessage(null);
  };

  const startRecovery = () => {
    if (!recoveryBackup) return;
    const backup = recoveryBackup;
    const targetDomainName = recoveryName;
    setRecoveryBackup(null);
    startOperation({
      operationId: "vm.recovery.create",
      title: `Recover ${backup.domainName} as ${targetDomainName}`,
      parameters: { backupId: backup.id, targetDomainName },
      preview: <span>Restores the protected snapshot into a new persistent VM named <code>{targetDomainName}</code>. Stopped, no network, autostart off. The source VM, backup, and repository are unchanged.</span>,
    });
  };

  if (loading && !status) {
    return <section className="vm-loading" aria-live="polite">Inspecting QEMU, KVM, and libvirt...</section>;
  }

  if (error || !status) {
    return (
      <section className="vm-error">
        <strong>Virtualization status is unavailable</strong>
        <span>{error ?? "The server did not return virtualization status."}</span>
        <button type="button" className="secondary-button" onClick={() => void refresh()}>Try again</button>
      </section>
    );
  }

  const domains = domainList?.domains ?? [];
  const firstServeUrl = status.tailscale.serveUrls[0] ?? null;

  return (
    <div className="vm-page">
      {operationDialog}
      {status.ready && <CloudVmForm csrfToken={csrfToken} onCreated={() => { void refresh(); }} />}
      <section className={`vm-readiness ${status.ready ? "vm-ready" : "vm-setup-required"}`}>
        <div>
          <span className="eyebrow">Live host inspection</span>
          <strong>{status.ready ? "KVM host is ready" : "KVM setup needs attention"}</strong>
          <p>{status.connectionUri} | {status.platform}/{status.architecture} | {domains.length} VM{domains.length === 1 ? "" : "s"} discovered</p>
        </div>
        <button type="button" className="secondary-button" onClick={() => void refresh()} disabled={loading}>
          {loading ? "Refreshing..." : "Refresh host"}
        </button>
      </section>

      <div className="vm-layout">
        <section className="panel vm-domains-panel">
          <header className="panel-header">
            <div><strong>Virtual machines</strong><span>Live from libvirt</span></div>
            <button type="button" className="secondary-button" onClick={() => setPlannerOpen(true)}>Plan new VM</button>
          </header>

          {!domainList?.connected ? (
            <div className="vm-empty"><strong>libvirt is not connected</strong><p>{domainList?.error ?? "Complete the host setup checklist, then refresh."}</p></div>
          ) : domains.length === 0 ? (
            <div className="vm-empty"><strong>No virtual machines yet</strong><p>Add installation media below. A cloud image or an ISO. Then <strong>Plan new VM</strong> to choose its CPUs, memory and disk. BoxPilot shows you the machine it will define before it defines it.</p></div>
          ) : (
            <div className="vm-domain-list">
              {domains.map((domain) => (
                <article className="vm-domain" key={domain.uuid ?? domain.name}>
                  <div className="vm-domain-summary">
                    <div className="vm-domain-name"><span className="vm-icon">VM</span><div><strong>{domain.name}</strong><span>{domain.vcpus} vCPU | {formatMemory(domain.memoryKiB)} | {domain.autostart ? "Autostart on" : "Autostart off"}</span><span>{!domain.guestAgent ? "Guest agent not checked" : domain.guestAgent.available ? `Guest agent ready${domain.guestAgent.filesystemState ? ` | filesystems ${domain.guestAgent.filesystemState}` : ""}` : "Guest agent not reachable"}</span></div></div>
                    <span className={`status-pill status-${stateTone(domain.state)}`}>{domain.state}</span>
                  </div>
                  {rates[domain.name] && domain.state === "running" && (
                    <div className="vm-addresses vm-live-stats" aria-label={`Live resource use for ${domain.name}`}>
                      <code>CPU {rates[domain.name].cpuPercent === null ? "…" : `${rates[domain.name].cpuPercent!.toFixed(0)}%`}</code>
                      <code>RAM {rates[domain.name].memoryKiB ? `${(rates[domain.name].memoryKiB! / 1024 / 1024).toFixed(1)} GiB` : "—"}{rates[domain.name].memoryMaxKiB ? ` / ${(rates[domain.name].memoryMaxKiB! / 1024 / 1024).toFixed(1)} GiB` : ""}</code>
                      <code>disk {rateLabel(rates[domain.name].diskBytesPerSecond)}</code>
                      <code>net {rateLabel(rates[domain.name].netBytesPerSecond)}</code>
                    </div>
                  )}
                  <div className="vm-addresses">
                    {domain.addresses.length
                      ? domain.addresses.map((address) => <code key={`${address.interface}-${address.address}`}>{address.address}</code>)
                      : <span>No leased IP reported</span>}
                  </div>
                  <div className="vm-actions">
                    {availableActions(domain).map(([action, label]) => (
                      <button
                        type="button"
                        className="text-button"
                        key={action}
                        disabled={pending !== null || !domain.managed}
                        onClick={() => performAction(domain, action, label)}
                      >
                        {pending === `${domain.name}:${action}` ? "Working..." : label}
                      </button>
                    ))}
                    {domain.state === "stopped" && <button type="button" className="text-button" disabled={pending !== null || !domain.managed || !domain.persistent} onClick={() => openSnapshotPlanner(domain)}>Plan snapshot</button>}
                    {domain.state === "stopped" && <button type="button" className="text-button" disabled={pending !== null || !domain.managed || !domain.persistent} onClick={() => startExport(domain)}>Export</button>}
                    {domain.state === "running" && <button type="button" className="text-button" disabled={pending !== null || !domain.managed} title={domain.managed ? undefined : unmanagedNote} onClick={() => startOperation({ operationId: "vm.force-off", title: `Force off ${domain.name}`, parameters: { name: domain.name }, preview: <span>Pulls the virtual power plug with <code>virsh destroy</code>. Unsaved data inside the guest is lost; start the VM again afterwards.</span> })}>Force off</button>}
                    {domain.state === "stopped" && <button type="button" className="text-button" disabled={pending !== null || !domain.managed} title={domain.managed ? undefined : unmanagedNote} onClick={() => startOperation({ operationId: "vm.delete", title: `Delete ${domain.name}`, parameters: { name: domain.name, deleteStorage: true }, preview: <span>Removes the VM definition and deletes its disks. Independent restic backups are kept. This cannot be undone from here.</span> })}>Delete VM</button>}
                  </div>
                  <details className="vm-domain-details">
                    <summary>Disks, network, and snapshots</summary>
                    <div className="vm-detail-grid">
                      <div><strong>Disks</strong>{domain.disks.length ? domain.disks.map((disk) => <span key={`${disk.target}-${disk.source}`}><code>{disk.target}</code>{disk.source}</span>) : <span>No block devices reported</span>}</div>
                      <div><strong>Interfaces</strong>{domain.interfaces.length ? domain.interfaces.map((networkInterface) => <span key={networkInterface.mac}><code>{networkInterface.interface}</code>{networkInterface.source} | {networkInterface.model ?? "default model"}</span>) : <span>No interfaces reported</span>}</div>
                      <div><strong>Snapshots</strong><span>{domain.snapshotCount === null ? "Unavailable" : `${domain.snapshotCount} reported | not independent backups`}</span>{domain.snapshots.map((snapshot) => (
                        <span key={snapshot.name}>
                          <code>{snapshot.name}</code>{snapshot.current ? "current" : snapshot.state ?? "state unavailable"} | {snapshot.location ?? "location unavailable"}
                          {domain.state === "stopped" && <button type="button" className="text-button" disabled={pending !== null || snapshot.manageable === false} title={snapshot.manageable === false ? unmanagedSnapshotNote : undefined} onClick={() => startOperation({ operationId: "vm.snapshot.revert", title: `Revert ${domain.name} to ${snapshot.name}`, parameters: { name: domain.name, snapshotName: snapshot.name }, preview: <span>Discards everything changed since <code>{snapshot.name}</code> and leaves the VM off.</span> })}>Revert</button>}
                          <button type="button" className="text-button" disabled={pending !== null || snapshot.manageable === false} title={snapshot.manageable === false ? unmanagedSnapshotNote : undefined} onClick={() => startOperation({ operationId: "vm.snapshot.delete", title: `Delete snapshot ${snapshot.name}`, parameters: { name: domain.name, snapshotName: snapshot.name }, preview: <span>Deletes the snapshot and merges its state into the disk. The VM itself is unchanged.</span> })}>Delete</button>
                        </span>
                      ))}</div>
                    </div>
                  </details>
                </article>
              ))}
            </div>
          )}

          <div className="vm-control-lock">
            <div><strong>What each action asks for</strong><span>Starting, stopping and restarting a VM asks you to confirm, with the exact change shown first. Creating or deleting one asks for your password and the machine\u2019s name typed out.</span></div>
          </div>
        </section>

        <aside className="panel vm-preflight-panel">
          <header className="panel-header"><div><strong>Host preflight</strong><span>{status.checks.filter((check) => check.ok).length} of {status.checks.length} passed</span></div></header>
          <div className="vm-checks">
            {status.checks.map((check) => (
              <div className="vm-check" key={check.id}><i className={check.ok ? "check-pass" : "check-fail"}>{check.ok ? "OK" : "!"}</i><div><strong>{check.label}</strong><span>{check.detail}</span></div></div>
            ))}
          </div>
        </aside>
      </div>

      <VmMediaLibrary csrfToken={csrfToken} onOpenRepair={onOpenRepair} />

      <section className="panel vm-resources-panel">
        <header className="panel-header">
          <div><strong>Default VM foundation</strong><span>Platform-managed NAT network and storage pool</span></div>
          <span className={`status-pill status-${foundation?.ready ? "good" : foundation?.planAvailable ? "warning" : "neutral"}`}>{foundation?.ready ? "Ready" : foundation?.planAvailable ? "Setup available" : "Blocked"}</span>
        </header>
        <div className="vm-resource-grid">
          <div>
            <span className="eyebrow">Default NAT network</span>
            <div className="vm-resource-row"><strong>{foundation?.network.name ?? "default"}</strong><span>{foundation?.network.exists ? foundation.network.active ? "Active" : "Inactive" : "Not defined"} | {foundation?.network.autostart ? "autostart" : "manual"} | virbr0</span><code>192.168.122.0/24</code></div>
          </div>
          <div>
            <span className="eyebrow">Default storage pool</span>
            <div className="vm-resource-row"><strong>{foundation?.pool.name ?? "default"}</strong><span>{foundation?.pool.exists ? foundation.pool.active ? "Active" : "Inactive" : "Not defined"} | {foundation?.pool.autostart ? "autostart" : "manual"}</span><code>{foundation?.pool.targetPath ?? "/var/lib/libvirt/images"}</code></div>
          </div>
        </div>
        {foundation?.ready ? (
          <div className="vm-control-lock"><div><strong>VM creation foundation verified</strong><span>Both canonical resources are persistent, active, compatible, and enabled at boot. Other networks and pools remain untouched.</span></div><button type="button" className="secondary-button" onClick={() => void refresh()} disabled={pending !== null}>Refresh</button></div>
        ) : foundation?.planAvailable ? (
          <div className="vm-control-lock"><div><strong>Guided initialization is available</strong><span>{(foundation.changes ?? []).join(" | ")}. The job accepts no resource names or paths and rolls back only its own changes.</span></div><button type="button" className="primary-button" onClick={() => initializeFoundation()} disabled={pending !== null}>{pending === "foundation-plan" ? "Inspecting..." : "Review setup plan"}</button></div>
        ) : (
          <div className="vm-plan-warnings"><strong>Setup is blocked</strong>{(foundation?.conflicts ?? []).map((conflict) => <span key={conflict}>{conflict}</span>)}<button type="button" className="secondary-button" onClick={onOpenRepair}>Open prerequisite repairs</button></div>
        )}
      </section>

      <section className="panel vm-resources-panel">
        <header className="panel-header"><div><strong>Libvirt resources</strong><span>Live networks and storage pools</span></div><span className={`status-pill ${resources?.connected ? "status-good" : "status-warning"}`}>{resources?.connected ? "Connected" : "Unavailable"}</span></header>
        <div className="vm-resource-grid">
          <div><span className="eyebrow">Networks</span>{resources?.networks.length ? resources.networks.map((network) => <div className="vm-resource-row" key={network.name}><strong>{network.name}</strong><span>{network.active ? "Active" : "Inactive"} | {network.bridge ?? "no bridge"} | {network.autostart ? "autostart" : "manual"}</span></div>) : <p>No libvirt networks reported.</p>}</div>
          <div><span className="eyebrow">Storage pools</span>{resources?.pools.length ? resources.pools.map((pool) => <div className="vm-resource-row" key={pool.name}><strong>{pool.name}</strong><span>{pool.active ? "Active" : "Inactive"} | {pool.available ?? "free space unavailable"}</span><code>{pool.targetPath ?? "target path unavailable"}</code></div>) : <p>No storage pools reported.</p>}</div>
        </div>
      </section>

      <section className="panel vm-resources-panel">
        <header className="panel-header"><div><strong>VM integrity exports</strong><span>Local artifacts, not protected backups</span></div><span className={`status-pill ${protectedBackups.length ? "status-good" : "status-warning"}`}>{protectedBackups.length ? `${protectedBackups.length} protected` : "Protection pending"}</span></header>
        {unread.length > 0 && <div className="vm-plan-warnings"><strong>Not everything on this page could be read</strong><span>BoxPilot could not read {sentenceList(unread)} just now, so what is shown for those is not a complete picture. Refresh in a moment.</span></div>}
        <div className="vm-control-lock">
          <div><strong>Encrypted independent destination</strong><span>{protectionDestination?.ready ? `Ready with restic ${protectionDestination.resticVersion ?? "detected"} on ${protectionDestination.mount?.sourceType ?? "mounted storage"}` : "Setup is required before local exports can move toward protection"}</span></div>
          <span className={`status-pill status-${protectionDestination?.ready ? "good" : "warning"}`}>{protectionDestination?.ready ? "ready" : "setup required"}</span>
        </div>
        <div className="vm-control-lock">
          <div><strong>Retention</strong><span>{retentionStatus ? `Keep at least ${countOf(retentionStatus.policy?.minimumCopiesPerDomain ?? 3, "copy", "copies")} per VM and every copy under ${countOf(retentionStatus.policy?.minimumAgeDays ?? 30, "day")}. Only restore-tested, unreferenced snapshots can qualify.` : "The retention policy could not be read just now."}</span></div>
          <button type="button" className="secondary-button" onClick={() => startRetention()} disabled={pending !== null || !protectionDestination?.ready || (retentionStatus?.candidates?.length ?? 0) === 0}>Apply retention</button>
        </div>
        {retentionStatus && <div className="vm-plan-warnings"><strong>Retention status</strong><span>{retentionStatus.candidates?.length ?? 0} currently eligible | {retentionStatus.beforeCount ?? 0} repository snapshot(s) | {retentionStatus.retentionRuns?.length ?? 0} completed run(s)</span>{retentionStatus.blockers?.map((blocker) => <span key={blocker}>{blocker}</span>)}<span>Prune is disabled, so retention does not claim reclaimed disk space.</span></div>}
        {retentionStatus?.unrecordedSnapshotIds?.length ? (
          <div className="vm-control-lock">
            <div><strong>Snapshots with no local record</strong><span>Usually a backup that was written and then failed its check. Retention will not run while they are there, because it cannot account for them.</span></div>
            <div className="recovery-actions">
              {retentionStatus.unrecordedSnapshotIds.map((snapshotId) => (
                <button key={snapshotId} type="button" className="text-button" disabled={pending !== null} onClick={() => startOperation({
                  operationId: "vm.backup.snapshot.forget",
                  title: `Forget snapshot ${snapshotId.slice(0, 8)}`,
                  parameters: { snapshotId },
                  confirmText: snapshotId.slice(0, 8),
                  preview: <span>Removes snapshot <code>{snapshotId.slice(0, 12)}</code> from the encrypted repository. It has no local backup record, so nothing BoxPilot knows about is lost, but if it is in fact a copy you want, this cannot be undone. Nothing is pruned.</span>,
                })}>Forget {snapshotId.slice(0, 8)}</button>
              ))}
            </div>
          </div>
        ) : null}
        {!protectionDestination?.ready && protectionDestination && <div className="vm-plan-warnings"><strong>Destination blockers</strong>{protectionDestination.blockers.map((blocker) => <span key={blocker}>{blocker}</span>)}<span>Run from the server terminal: <code>{protectionDestination.setupCommand}</code></span><span>Keep a recovery copy of the repository password outside this server.</span></div>}
        {exports.length === 0 ? (
          <div className="vm-empty">
            <strong>{unread.includes("exports") ? "Exports could not be read" : "No VM exports recorded"}</strong>
            <p>{unread.includes("exports") ? "This does not mean there is nothing here. BoxPilot could not read the list just now. Refresh in a moment." : "Stop a managed persistent VM, then generate a reviewed export plan. Encryption, an independent destination, and an isolated restore boot are still required before BoxPilot will call it protected."}</p>
          </div>
        ) : (
          <div className="vm-resource-grid">
            {exports.map((artifact) => (
              <div className="vm-resource-row" key={artifact.id}>
                <strong>{artifact.domainName}</strong>
                <span>{formatBytes(artifact.sizeBytes)} | SHA-256 recorded | {new Date(artifact.createdAt).toLocaleString()}</span>
                <code>{artifact.id}</code>
                <span>{artifact.encrypted ? "Encrypted" : "Not encrypted"} | {artifact.protected ? "Protected" : "Not protected"} | {artifact.restoreDrill.passed ? "Restore drill passed" : "Restore drill not run"}</span>
                <button type="button" className="text-button" onClick={() => startProtection(artifact)} disabled={pending !== null || !protectionDestination?.ready}>Back up independently</button>
              </div>
            ))}
          </div>
        )}
        {protectedBackups.length > 0 && (
          <div className="vm-domain-list">
            {protectedBackups.map((backup) => (
              <article className="vm-domain" key={backup.id}>
                <div className="vm-domain-summary">
                  <div className="vm-domain-name"><span className="vm-icon">BK</span><div><strong>{backup.domainName}</strong><span>{formatBytes(backup.sizeBytes)} | encrypted independent restic snapshot</span><span>{backup.repositoryVerified ? "Repository data verified" : "Repository verification missing"} | {backup.restoreDrill.passed ? "isolated restore drill passed" : "isolated restore still required"}</span></div></div>
                  <span className={`status-pill status-${backup.retained === false ? "warning" : backup.protected ? "good" : "warning"}`}>{backup.retained === false ? "forgotten" : backup.protected ? "protected" : "not protected"}</span>
                </div>
                <div className="vm-actions">
                  {backup.retained !== false && !backup.protected && <button type="button" className="text-button" onClick={() => startRestoreDrill(backup)} disabled={pending !== null}>Run isolated restore drill</button>}
                  {backup.retained !== false && backup.protected && <button type="button" className="text-button" onClick={() => openRecoveryPlanner(backup)} disabled={pending !== null}>Create recovery clone</button>}
                  {backup.retained === false && <span>Snapshot metadata forgotten {backup.retention?.forgottenAt ? new Date(backup.retention.forgottenAt).toLocaleString() : "by retention"}</span>}
                </div>
              </article>
            ))}
          </div>
        )}
        {recoveries.length > 0 && (
          <div className="vm-domain-list">
            {recoveries.map((recovery) => (
              <article className="vm-domain" key={recovery.id}>
                <div className="vm-domain-summary">
                  <div className="vm-domain-name"><span className="vm-icon">RC</span><div><strong>{recovery.domainName}</strong><span>Recovered from {recovery.sourceDomainName} | {formatBytes(recovery.sizeBytes)}</span><span>Persistent | network none | autostart off | {new Date(recovery.createdAt).toLocaleString()}</span></div></div>
                  <span className="status-pill status-neutral">stopped recovery</span>
                </div>
              </article>
            ))}
          </div>
        )}
      </section>

      <div className="vm-bottom-grid">
        <section className="panel vm-setup-panel">
          <header className="panel-header"><div><strong>Guided Ubuntu setup</strong><span>Review in the physical or SSH console</span></div><button type="button" className="secondary-button" onClick={() => void copySetupCommands()}>Copy commands</button></header>
          <ol>{status.setupPlan.commands.map((command) => <li key={command}><code>{command}</code></li>)}</ol>
          <div className="vm-notes">{status.setupPlan.notes.map((note) => <span key={note}>{note}</span>)}</div>
        </section>

        <aside className="panel vm-access-panel">
          <span className="eyebrow">Remote access</span>
          <h3>Tailscale link guidance</h3>
          {firstServeUrl
            ? <a href={firstServeUrl}>{firstServeUrl}</a>
            : <p>{status.tailscale.connected ? `Tailscale is connected${status.tailscale.dnsName ? ` as ${status.tailscale.dnsName}` : ""}, but no Serve HTTPS URL was reported.` : "Tailscale is not connected on this host."}</p>}
          {consoleGuidance?.privateUrl && <a href={consoleGuidance.privateUrl} target="_blank" rel="noreferrer">Open Cockpit console handoff</a>}
          <p>{consoleGuidance?.accessNote ?? "BoxPilot console guidance is unavailable."}</p>
          <p>For a service inside a VM, install Tailscale in the guest or use a deliberately planned LAN address. BoxPilot does not proxy guest console traffic in this release.</p>
        </aside>
      </div>

      {message && <p className="vm-message" aria-live="polite">{message}</p>}
      {plannerOpen && <VmPlanner csrfToken={csrfToken} onClose={() => setPlannerOpen(false)} onStage={(input) => { setPlannerOpen(false); startOperation({ operationId: "vm.create", title: `Create VM ${input.name}`, parameters: { ...input }, preview: <span>Creates <code>{input.name}</code> exactly as planned through the restricted helper, {input.vcpus} vCPU, {formatMemory(input.memoryMiB * 1024)} RAM, {input.diskGiB} GiB disk from <code>{input.isoFile}</code>. Revalidated against the live host first. Failure rolls back the new domain and its storage.</span> }); }} />}
      {snapshotDomain && (
        <div className="vm-planner-backdrop" role="presentation">
          <section className="vm-planner-dialog vm-action-dialog" role="dialog" aria-modal="true" aria-labelledby="vm-snapshot-title">
            <header className="vm-planner-header"><div><span className="eyebrow">Offline snapshot</span><h2 id="vm-snapshot-title">Snapshot {snapshotDomain.name}</h2><p>Only stopped, persistent VMs with plain qcow2 disks can use this workflow.</p></div><button type="button" className="modal-close" aria-label="Close snapshot plan" onClick={() => setSnapshotDomain(null)}>X</button></header>
            <div className="vm-action-review">
              <form onSubmit={(event) => { event.preventDefault(); createSnapshot(); }}>
                <label className="vm-snapshot-name">Snapshot name<input value={snapshotName} onChange={(event) => setSnapshotName(event.target.value)} pattern="[A-Za-z0-9][A-Za-z0-9_.-]{0,62}" maxLength={63} required autoComplete="off" /><span>Use 1-63 letters, numbers, dots, underscores, or hyphens.</span></label>
                <div className="vm-plan-warnings"><strong>Worth knowing</strong><span>This snapshot lives inside the VM's own disk while it is stopped. It is a quick undo, not a backup you could restore after a disk failure.</span></div>
                <div className="vm-plan-form-actions"><button type="button" className="text-button" onClick={() => setSnapshotDomain(null)}>Cancel</button><button type="submit" className="primary-button" disabled={pending !== null}>Continue to confirm</button></div>
              </form>
            </div>
          </section>
        </div>
      )}
      {recoveryBackup && (
        <div className="vm-planner-backdrop" role="presentation">
          <section className="vm-planner-dialog vm-action-dialog" role="dialog" aria-modal="true" aria-labelledby="vm-recovery-title">
            <header className="vm-planner-header"><div><span className="eyebrow">Recovery clone</span><h2 id="vm-recovery-title">Recover {recoveryBackup.domainName}</h2><p>Create a separate persistent VM from the exact protected snapshot. The source and repository remain unchanged.</p></div><button type="button" className="modal-close" aria-label="Close recovery plan" onClick={() => setRecoveryBackup(null)}>X</button></header>
            <div className="vm-action-review">
              <form onSubmit={(event) => { event.preventDefault(); startRecovery(); }}>
                <label className="vm-snapshot-name">New VM name<input value={recoveryName} onChange={(event) => setRecoveryName(event.target.value)} pattern="[A-Za-z0-9][A-Za-z0-9_.-]{0,62}" maxLength={63} required autoComplete="off" /><span>The name must be available. The new VM will not replace the source.</span></label>
                <div className="vm-plan-warnings"><strong>Safe initial state</strong><span>The clone will be stopped, persistent, autostart disabled, and have no network interface. Starting it later requires a separate approved action.</span></div>
                <div className="vm-plan-form-actions"><button type="button" className="text-button" onClick={() => setRecoveryBackup(null)}>Cancel</button><button type="submit" className="primary-button" disabled={pending !== null}>Continue to confirm</button></div>
              </form>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
