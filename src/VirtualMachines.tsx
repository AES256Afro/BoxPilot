import { useCallback, useEffect, useState } from "react";
import CloudVmForm from "./CloudVmForm";
import { useOperation } from "./ApproveDialog";
import {
  createLibvirtFoundationPlan,
  createVmLifecyclePlan,
  createVmExportPlan,
  createVmProtectionPlan,
  createVmRecoveryPlan,
  createVmRetentionPlan,
  createVmRestoreDrillPlan,
  createVmSnapshotPlan,
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
  type LibvirtFoundationPlan,
  type ConsoleGuidance,
  stageVmLifecyclePlan,
  stageLibvirtFoundationPlan,
  stageVmExportPlan,
  stageVmProtectionPlan,
  stageVmRecoveryPlan,
  stageVmRetentionPlan,
  stageVmRestoreDrillPlan,
  stageVmSnapshotPlan,
  type DomainList,
  type VirtualDomain,
  type VmLifecyclePlan,
  type VmExportArtifact,
  type VmExportPlan,
  type VmProtectedBackup,
  type VmProtectionDestination,
  type VmProtectionPlan,
  type VmRecoveryPlan,
  type VmRecoveryRecord,
  type VmRetentionPlan,
  type VmRetentionStatus,
  type VmRestoreDrillPlan,
  type VmSnapshotPlan,
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

export default function VirtualMachines({ csrfToken = "", onOpenRepair = () => {} }: { csrfToken?: string; onOpenRepair?: () => void }) {
  const [status, setStatus] = useState<VirtualizationStatus | null>(null);
  const [domainList, setDomainList] = useState<DomainList | null>(null);
  const [resources, setResources] = useState<LibvirtResources | null>(null);
  const [foundation, setFoundation] = useState<LibvirtFoundation | null>(null);
  const [foundationPlan, setFoundationPlan] = useState<LibvirtFoundationPlan | null>(null);
  const [consoleGuidance, setConsoleGuidance] = useState<ConsoleGuidance | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [plannerOpen, setPlannerOpen] = useState(false);
  const [actionPlan, setActionPlan] = useState<VmLifecyclePlan | null>(null);
  const [snapshotDomain, setSnapshotDomain] = useState<VirtualDomain | null>(null);
  const [snapshotName, setSnapshotName] = useState("");
  const [snapshotPlan, setSnapshotPlan] = useState<VmSnapshotPlan | null>(null);
  const [exports, setExports] = useState<VmExportArtifact[]>([]);
  const [exportPlan, setExportPlan] = useState<VmExportPlan | null>(null);
  const [protectionDestination, setProtectionDestination] = useState<VmProtectionDestination | null>(null);
  const [protectedBackups, setProtectedBackups] = useState<VmProtectedBackup[]>([]);
  const [protectionPlan, setProtectionPlan] = useState<VmProtectionPlan | null>(null);
  const [retentionStatus, setRetentionStatus] = useState<VmRetentionStatus | null>(null);
  const [retentionPlan, setRetentionPlan] = useState<VmRetentionPlan | null>(null);
  const [restoreDrillPlan, setRestoreDrillPlan] = useState<VmRestoreDrillPlan | null>(null);
  const [recoveries, setRecoveries] = useState<VmRecoveryRecord[]>([]);
  const [recoveryBackup, setRecoveryBackup] = useState<VmProtectedBackup | null>(null);
  const [recoveryName, setRecoveryName] = useState("");
  const [recoveryPlan, setRecoveryPlan] = useState<VmRecoveryPlan | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [[nextStatus, nextDomains, nextResources, nextConsoleGuidance], nextFoundation, nextExports, nextProtection, nextRecoveries, nextRetention] = await Promise.all([
        fetchVirtualization(),
        fetchLibvirtFoundation(),
        fetchVmExports(),
        fetchVmProtection(),
        fetchVmRecoveries(),
        fetchVmRetention(),
      ]);
      setStatus(nextStatus);
      setDomainList(nextDomains);
      setResources(nextResources);
      setFoundation(nextFoundation);
      setConsoleGuidance(nextConsoleGuidance);
      setExports(nextExports);
      setProtectionDestination(nextProtection?.destination ?? null);
      setProtectedBackups(Array.isArray(nextProtection?.backups) ? nextProtection.backups : []);
      setRecoveries(nextRecoveries);
      setRetentionStatus(nextRetention);
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
  const { start: startOperation, dialog: operationDialog } = useOperation(csrfToken, () => { void refresh(); });

  const copySetupCommands = async () => {
    if (!status) return;
    try {
      await navigator.clipboard.writeText(status.setupPlan.commands.join("\n"));
      setMessage("Setup commands copied. Review every command in the Ubuntu console before running it.");
    } catch {
      setMessage("Clipboard access was unavailable. Select the commands and copy them manually.");
    }
  };

  const planFoundation = async () => {
    setPending("foundation-plan");
    setMessage(null);
    try {
      setFoundationPlan(await createLibvirtFoundationPlan(csrfToken));
    } catch (foundationError) {
      setMessage(foundationError instanceof Error ? foundationError.message : "Unable to plan the libvirt foundation setup");
    } finally {
      setPending(null);
    }
  };

  const stageFoundation = async () => {
    if (!foundationPlan) return;
    setPending(`foundation-stage:${foundationPlan.id}`);
    setMessage(null);
    try {
      await stageLibvirtFoundationPlan(foundationPlan.id, foundationPlan.revision, csrfToken);
      setFoundationPlan(null);
      onOpenRepair();
    } catch (foundationError) {
      setMessage(foundationError instanceof Error ? foundationError.message : "Unable to stage the libvirt foundation job");
    } finally {
      setPending(null);
    }
  };

  const performAction = async (domain: VirtualDomain, action: string, label: string) => {
    const operation = `${domain.name}:${action}`;
    setPending(operation);
    setMessage(null);
    try {
      setActionPlan(await createVmLifecyclePlan(domain.name, action, csrfToken));
    } catch (actionError) {
      setMessage(actionError instanceof Error ? actionError.message : `Unable to plan ${label.toLowerCase()}`);
    } finally {
      setPending(null);
    }
  };

  const stageAction = async () => {
    if (!actionPlan) return;
    setPending(`stage:${actionPlan.id}`);
    setMessage(null);
    try {
      await stageVmLifecyclePlan(actionPlan.id, actionPlan.revision, csrfToken);
      setActionPlan(null);
      onOpenRepair();
    } catch (actionError) {
      setMessage(actionError instanceof Error ? actionError.message : "Unable to stage VM lifecycle action");
    } finally {
      setPending(null);
    }
  };

  const openSnapshotPlanner = (domain: VirtualDomain) => {
    setSnapshotDomain(domain);
    setSnapshotPlan(null);
    setSnapshotName(`checkpoint-${new Date().toISOString().slice(0, 10)}`);
    setMessage(null);
  };

  const planSnapshot = async () => {
    if (!snapshotDomain) return;
    setPending(`snapshot-plan:${snapshotDomain.name}`);
    setMessage(null);
    try {
      setSnapshotPlan(await createVmSnapshotPlan(snapshotDomain.name, snapshotName, csrfToken));
    } catch (snapshotError) {
      setMessage(snapshotError instanceof Error ? snapshotError.message : "Unable to plan offline snapshot");
    } finally {
      setPending(null);
    }
  };

  const stageSnapshot = async () => {
    if (!snapshotPlan) return;
    setPending(`snapshot-stage:${snapshotPlan.id}`);
    setMessage(null);
    try {
      await stageVmSnapshotPlan(snapshotPlan.id, snapshotPlan.revision, csrfToken);
      setSnapshotDomain(null);
      setSnapshotPlan(null);
      onOpenRepair();
    } catch (snapshotError) {
      setMessage(snapshotError instanceof Error ? snapshotError.message : "Unable to stage offline snapshot");
    } finally {
      setPending(null);
    }
  };

  const planExport = async (domain: VirtualDomain) => {
    setPending(`export-plan:${domain.name}`);
    setMessage(null);
    try {
      setExportPlan(await createVmExportPlan(domain.name, csrfToken));
    } catch (exportError) {
      setMessage(exportError instanceof Error ? exportError.message : "Unable to plan stopped VM export");
    } finally {
      setPending(null);
    }
  };

  const stageExport = async () => {
    if (!exportPlan) return;
    setPending(`export-stage:${exportPlan.id}`);
    setMessage(null);
    try {
      await stageVmExportPlan(exportPlan.id, exportPlan.revision, csrfToken);
      setExportPlan(null);
      onOpenRepair();
    } catch (exportError) {
      setMessage(exportError instanceof Error ? exportError.message : "Unable to stage stopped VM export");
    } finally {
      setPending(null);
    }
  };

  const planProtection = async (artifact: VmExportArtifact) => {
    setPending(`protection-plan:${artifact.id}`);
    setMessage(null);
    try {
      setProtectionPlan(await createVmProtectionPlan(artifact.id, csrfToken));
    } catch (protectionError) {
      setMessage(protectionError instanceof Error ? protectionError.message : "Unable to plan encrypted VM backup");
    } finally {
      setPending(null);
    }
  };

  const stageProtection = async () => {
    if (!protectionPlan) return;
    setPending(`protection-stage:${protectionPlan.id}`);
    setMessage(null);
    try {
      await stageVmProtectionPlan(protectionPlan.id, protectionPlan.revision, csrfToken);
      setProtectionPlan(null);
      onOpenRepair();
    } catch (protectionError) {
      setMessage(protectionError instanceof Error ? protectionError.message : "Unable to stage encrypted VM backup");
    } finally {
      setPending(null);
    }
  };

  const planRetention = async () => {
    setPending("retention-plan");
    setMessage(null);
    try {
      setRetentionPlan(await createVmRetentionPlan(csrfToken));
    } catch (retentionError) {
      setMessage(retentionError instanceof Error ? retentionError.message : "Unable to plan VM backup retention");
    } finally {
      setPending(null);
    }
  };

  const stageRetention = async () => {
    if (!retentionPlan) return;
    setPending(`retention-stage:${retentionPlan.id}`);
    setMessage(null);
    try {
      await stageVmRetentionPlan(retentionPlan.id, retentionPlan.revision, csrfToken);
      setRetentionPlan(null);
      onOpenRepair();
    } catch (retentionError) {
      setMessage(retentionError instanceof Error ? retentionError.message : "Unable to stage VM backup retention");
    } finally {
      setPending(null);
    }
  };

  const planRestoreDrill = async (backup: VmProtectedBackup) => {
    setPending(`restore-drill-plan:${backup.id}`);
    setMessage(null);
    try {
      setRestoreDrillPlan(await createVmRestoreDrillPlan(backup.id, csrfToken));
    } catch (restoreError) {
      setMessage(restoreError instanceof Error ? restoreError.message : "Unable to plan isolated restore drill");
    } finally {
      setPending(null);
    }
  };

  const stageRestoreDrill = async () => {
    if (!restoreDrillPlan) return;
    setPending(`restore-drill-stage:${restoreDrillPlan.id}`);
    setMessage(null);
    try {
      await stageVmRestoreDrillPlan(restoreDrillPlan.id, restoreDrillPlan.revision, csrfToken);
      setRestoreDrillPlan(null);
      onOpenRepair();
    } catch (restoreError) {
      setMessage(restoreError instanceof Error ? restoreError.message : "Unable to stage isolated restore drill");
    } finally {
      setPending(null);
    }
  };

  const openRecoveryPlanner = (backup: VmProtectedBackup) => {
    setRecoveryBackup(backup);
    setRecoveryName(`${backup.domainName}-recovery`);
    setRecoveryPlan(null);
    setMessage(null);
  };

  const planRecovery = async () => {
    if (!recoveryBackup) return;
    setPending(`recovery-plan:${recoveryBackup.id}`);
    setMessage(null);
    try {
      setRecoveryPlan(await createVmRecoveryPlan(recoveryBackup.id, recoveryName, csrfToken));
    } catch (recoveryError) {
      setMessage(recoveryError instanceof Error ? recoveryError.message : "Unable to plan guarded recovery clone");
    } finally {
      setPending(null);
    }
  };

  const stageRecovery = async () => {
    if (!recoveryPlan) return;
    setPending(`recovery-stage:${recoveryPlan.id}`);
    setMessage(null);
    try {
      await stageVmRecoveryPlan(recoveryPlan.id, recoveryPlan.revision, csrfToken);
      setRecoveryBackup(null);
      setRecoveryPlan(null);
      onOpenRepair();
    } catch (recoveryError) {
      setMessage(recoveryError instanceof Error ? recoveryError.message : "Unable to stage guarded recovery clone");
    } finally {
      setPending(null);
    }
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
            <div className="vm-empty"><strong>No virtual machines found</strong><p>The system connection works. Add a managed ISO, then use the guarded creation workflow.</p></div>
          ) : (
            <div className="vm-domain-list">
              {domains.map((domain) => (
                <article className="vm-domain" key={domain.uuid ?? domain.name}>
                  <div className="vm-domain-summary">
                    <div className="vm-domain-name"><span className="vm-icon">VM</span><div><strong>{domain.name}</strong><span>{domain.vcpus} vCPU | {formatMemory(domain.memoryKiB)} | {domain.autostart ? "Autostart on" : "Autostart off"}</span><span>{domain.guestAgent.available ? `Guest agent ready${domain.guestAgent.filesystemState ? ` | filesystems ${domain.guestAgent.filesystemState}` : ""}` : "Guest agent not reachable"}</span></div></div>
                    <span className={`status-pill status-${stateTone(domain.state)}`}>{domain.state}</span>
                  </div>
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
                        onClick={() => void performAction(domain, action, label)}
                      >
                        {pending === `${domain.name}:${action}` ? "Working..." : label}
                      </button>
                    ))}
                    {domain.state === "stopped" && <button type="button" className="text-button" disabled={pending !== null || !domain.managed || !domain.persistent} onClick={() => openSnapshotPlanner(domain)}>Plan snapshot</button>}
                    {domain.state === "stopped" && <button type="button" className="text-button" disabled={pending !== null || !domain.managed || !domain.persistent} onClick={() => void planExport(domain)}>{pending === `export-plan:${domain.name}` ? "Inspecting..." : "Plan export"}</button>}
                    {domain.state === "running" && <button type="button" className="text-button" disabled={pending !== null} onClick={() => startOperation({ operationId: "vm.force-off", title: `Force off ${domain.name}`, parameters: { name: domain.name }, preview: <span>Pulls the virtual power plug with <code>virsh destroy</code>. Unsaved data inside the guest is lost; start the VM again afterwards.</span> })}>Force off</button>}
                    {domain.state === "stopped" && <button type="button" className="text-button" disabled={pending !== null} onClick={() => startOperation({ operationId: "vm.delete", title: `Delete ${domain.name}`, parameters: { name: domain.name, deleteStorage: true }, preview: <span>Removes the VM definition and deletes its disks. Independent restic backups are kept. This cannot be undone from here.</span> })}>Delete VM</button>}
                  </div>
                  <details className="vm-domain-details">
                    <summary>Disks, network, and snapshots</summary>
                    <div className="vm-detail-grid">
                      <div><strong>Disks</strong>{domain.disks.length ? domain.disks.map((disk) => <span key={`${disk.target}-${disk.source}`}><code>{disk.target}</code>{disk.source}</span>) : <span>No block devices reported</span>}</div>
                      <div><strong>Interfaces</strong>{domain.interfaces.length ? domain.interfaces.map((networkInterface) => <span key={networkInterface.mac}><code>{networkInterface.interface}</code>{networkInterface.source} | {networkInterface.model ?? "default model"}</span>) : <span>No interfaces reported</span>}</div>
                      <div><strong>Snapshots</strong><span>{domain.snapshotCount === null ? "Unavailable" : `${domain.snapshotCount} reported | not independent backups`}</span>{domain.snapshots.map((snapshot) => (
                        <span key={snapshot.name}>
                          <code>{snapshot.name}</code>{snapshot.current ? "current" : snapshot.state ?? "state unavailable"} | {snapshot.location ?? "location unavailable"}
                          {domain.state === "stopped" && <button type="button" className="text-button" disabled={pending !== null} onClick={() => startOperation({ operationId: "vm.snapshot.revert", title: `Revert ${domain.name} to ${snapshot.name}`, parameters: { name: domain.name, snapshotName: snapshot.name }, preview: <span>Discards everything changed since <code>{snapshot.name}</code> and leaves the VM off.</span> })}>Revert</button>}
                          <button type="button" className="text-button" disabled={pending !== null} onClick={() => startOperation({ operationId: "vm.snapshot.delete", title: `Delete snapshot ${snapshot.name}`, parameters: { name: domain.name, snapshotName: snapshot.name }, preview: <span>Deletes the snapshot and merges its state into the disk. The VM itself is unchanged.</span> })}>Delete</button>
                        </span>
                      ))}</div>
                    </div>
                  </details>
                </article>
              ))}
            </div>
          )}

          <div className="vm-control-lock">
            <div><strong>Durable lifecycle approvals</strong><span>{status.actions.reason}</span></div>
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
          <div className="vm-control-lock"><div><strong>Guided initialization is available</strong><span>{foundation.changes.join(" | ")}. The job accepts no resource names or paths and rolls back only its own changes.</span></div><button type="button" className="primary-button" onClick={() => void planFoundation()} disabled={pending !== null}>{pending === "foundation-plan" ? "Inspecting..." : "Review setup plan"}</button></div>
        ) : (
          <div className="vm-plan-warnings"><strong>Setup is blocked</strong>{foundation?.conflicts.map((conflict) => <span key={conflict}>{conflict}</span>)}<button type="button" className="secondary-button" onClick={onOpenRepair}>Open prerequisite repairs</button></div>
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
        <header className="panel-header"><div><strong>VM integrity exports</strong><span>Local artifacts, not protected backups</span></div><span className="status-pill status-warning">Protection pending</span></header>
        <div className="vm-control-lock">
          <div><strong>Encrypted independent destination</strong><span>{protectionDestination?.ready ? `Ready with restic ${protectionDestination.resticVersion ?? "detected"} on ${protectionDestination.mount?.sourceType ?? "mounted storage"}` : "Setup is required before local exports can move toward protection"}</span></div>
          <span className={`status-pill status-${protectionDestination?.ready ? "good" : "warning"}`}>{protectionDestination?.ready ? "ready" : "setup required"}</span>
        </div>
        <div className="vm-control-lock">
          <div><strong>Guarded retention</strong><span>Keep at least {retentionStatus?.policy?.minimumCopiesPerDomain ?? 3} copies per VM and every copy under {retentionStatus?.policy?.minimumAgeDays ?? 30} days. Only restore-tested, unreferenced snapshots can qualify.</span></div>
          <button type="button" className="secondary-button" onClick={() => void planRetention()} disabled={pending !== null || !protectionDestination?.ready}>{pending === "retention-plan" ? "Inspecting..." : "Review retention"}</button>
        </div>
        {retentionStatus && <div className="vm-plan-warnings"><strong>Retention status</strong><span>{retentionStatus.candidates?.length ?? 0} currently eligible | {retentionStatus.beforeCount ?? 0} repository snapshot(s) | {retentionStatus.retentionRuns?.length ?? 0} completed run(s)</span>{retentionStatus.blockers?.map((blocker) => <span key={blocker}>{blocker}</span>)}<span>Prune is disabled, so retention does not claim reclaimed disk space.</span></div>}
        {!protectionDestination?.ready && protectionDestination && <div className="vm-plan-warnings"><strong>Destination blockers</strong>{protectionDestination.blockers.map((blocker) => <span key={blocker}>{blocker}</span>)}<span>Run from the server terminal: <code>{protectionDestination.setupCommand}</code></span><span>Keep a recovery copy of the repository password outside this server.</span></div>}
        {exports.length === 0 ? (
          <div className="vm-empty"><strong>No VM exports recorded</strong><p>Stop a managed persistent VM, then generate a reviewed export plan. Encryption, an independent destination, and an isolated restore boot are still required before BoxPilot will call it protected.</p></div>
        ) : (
          <div className="vm-resource-grid">
            {exports.map((artifact) => (
              <div className="vm-resource-row" key={artifact.id}>
                <strong>{artifact.domainName}</strong>
                <span>{formatBytes(artifact.sizeBytes)} | SHA-256 recorded | {new Date(artifact.createdAt).toLocaleString()}</span>
                <code>{artifact.id}</code>
                <span>{artifact.encrypted ? "Encrypted" : "Not encrypted"} | {artifact.protected ? "Protected" : "Not protected"} | {artifact.restoreDrill.passed ? "Restore drill passed" : "Restore drill not run"}</span>
                <button type="button" className="text-button" onClick={() => void planProtection(artifact)} disabled={pending !== null}>{pending === `protection-plan:${artifact.id}` ? "Inspecting..." : "Plan encrypted backup"}</button>
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
                  {backup.retained !== false && !backup.protected && <button type="button" className="text-button" onClick={() => void planRestoreDrill(backup)} disabled={pending !== null}>{pending === `restore-drill-plan:${backup.id}` ? "Inspecting..." : "Plan isolated restore drill"}</button>}
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
      {plannerOpen && <VmPlanner csrfToken={csrfToken} onClose={() => setPlannerOpen(false)} onOpenRepair={onOpenRepair} />}
      {foundationPlan && (
        <div className="vm-planner-backdrop" role="presentation">
          <section className="vm-planner-dialog vm-action-dialog" role="dialog" aria-modal="true" aria-labelledby="foundation-plan-title">
            <header className="vm-planner-header"><div><span className="eyebrow">Immutable foundation plan</span><h2 id="foundation-plan-title">Prepare default libvirt resources</h2><p>One password-approved job applies only this fixed NAT network and directory pool.</p></div><button type="button" className="modal-close" aria-label="Close foundation plan" onClick={() => setFoundationPlan(null)}>X</button></header>
            <dl className="vm-plan-summary"><div><dt>Network</dt><dd>default | NAT | virbr0 | 192.168.122.0/24</dd></div><div><dt>Storage</dt><dd>default | dir | /var/lib/libvirt/images</dd></div><div><dt>Rollback</dt><dd>Automatic, limited to this job</dd></div></dl>
            <div className="vm-plan-warnings"><strong>Planned changes</strong>{foundationPlan.output.changes.map((change) => <span key={change}>{change}</span>)}</div>
            <div className="vm-plan-warnings"><strong>Locked boundaries</strong>{foundationPlan.output.boundaries.map((boundary) => <span key={boundary}>{boundary}</span>)}</div>
            <p>{foundationPlan.output.recovery}</p>
            <div className="vm-planner-actions"><button type="button" className="secondary-button" onClick={() => setFoundationPlan(null)}>Cancel</button><button type="button" className="primary-button" onClick={() => void stageFoundation()} disabled={pending !== null}>{pending === `foundation-stage:${foundationPlan.id}` ? "Staging..." : "Stage approval job"}</button></div>
          </section>
        </div>
      )}
      {actionPlan && (
        <div className="vm-planner-backdrop" role="presentation">
          <section className="vm-planner-dialog vm-action-dialog" role="dialog" aria-modal="true" aria-labelledby="vm-action-title">
            <header className="vm-planner-header"><div><span className="eyebrow">Immutable lifecycle plan</span><h2 id="vm-action-title">{actionPlan.output.label} {actionPlan.input.name}</h2><p>Review current state, desired state, and recovery before creating an approval job.</p></div><button type="button" className="modal-close" aria-label="Close lifecycle plan" onClick={() => setActionPlan(null)}>X</button></header>
            <div className="vm-action-review">
              <dl className="vm-plan-summary">
                <div><dt>Current power</dt><dd>{actionPlan.output.current.state}</dd></div>
                <div><dt>Desired power</dt><dd>{actionPlan.output.desired.state}</dd></div>
                <div><dt>Current autostart</dt><dd>{actionPlan.output.current.autostart ? "enabled" : "disabled"}</dd></div>
                <div><dt>Desired autostart</dt><dd>{actionPlan.output.desired.autostart ? "enabled" : "disabled"}</dd></div>
              </dl>
              <div className="vm-plan-gates"><strong>Exact changes</strong><ol>{actionPlan.output.changes.map((change) => <li key={change}>{change}</li>)}</ol></div>
              <div className="vm-plan-warnings"><strong>Recovery boundary</strong><span>{actionPlan.output.recovery}</span></div>
              <p className="vm-action-revision">Plan revision <code>{actionPlan.revision}</code>. Host state will be checked again before staging and again after password approval.</p>
              <div className="vm-plan-form-actions"><button type="button" className="text-button" onClick={() => setActionPlan(null)}>Cancel</button><button type="button" className="primary-button" onClick={() => void stageAction()} disabled={pending !== null}>{pending ? "Revalidating..." : "Stage for password approval"}</button></div>
            </div>
          </section>
        </div>
      )}
      {snapshotDomain && (
        <div className="vm-planner-backdrop" role="presentation">
          <section className="vm-planner-dialog vm-action-dialog" role="dialog" aria-modal="true" aria-labelledby="vm-snapshot-title">
            <header className="vm-planner-header"><div><span className="eyebrow">Guarded offline snapshot</span><h2 id="vm-snapshot-title">Snapshot {snapshotDomain.name}</h2><p>Only stopped, persistent VMs with managed qcow2 disks can use this workflow.</p></div><button type="button" className="modal-close" aria-label="Close snapshot plan" onClick={() => { setSnapshotDomain(null); setSnapshotPlan(null); }}>X</button></header>
            <div className="vm-action-review">
              {!snapshotPlan ? (
                <form onSubmit={(event) => { event.preventDefault(); void planSnapshot(); }}>
                  <label className="vm-snapshot-name">Snapshot name<input value={snapshotName} onChange={(event) => setSnapshotName(event.target.value)} pattern="[A-Za-z0-9][A-Za-z0-9_.-]{0,62}" maxLength={63} required autoComplete="off" /><span>Use 1-63 letters, numbers, dots, underscores, or hyphens.</span></label>
                  <div className="vm-plan-warnings"><strong>Important boundary</strong><span>This creates an internal snapshot while the VM is stopped. It is not an independent backup. Revert and delete remain locked.</span></div>
                  <div className="vm-plan-form-actions"><button type="button" className="text-button" onClick={() => setSnapshotDomain(null)}>Cancel</button><button type="submit" className="primary-button" disabled={pending !== null}>{pending ? "Inspecting..." : "Generate reviewed plan"}</button></div>
                </form>
              ) : (
                <>
                  <dl className="vm-plan-summary"><div><dt>Consistency</dt><dd>offline-consistent</dd></div><div><dt>Independent backup</dt><dd>No</dd></div><div><dt>Existing snapshots</dt><dd>{snapshotPlan.output.currentSnapshotCount}</dd></div><div><dt>Managed disks</dt><dd>{snapshotPlan.output.diskTargets.join(", ")}</dd></div></dl>
                  <div className="vm-plan-gates"><strong>Exact changes</strong><ol>{snapshotPlan.output.changes.map((change) => <li key={change}>{change}</li>)}</ol></div>
                  <div className="vm-plan-warnings"><strong>Warnings</strong>{snapshotPlan.output.warnings.map((warning) => <span key={warning}>{warning}</span>)}</div>
                  <div className="vm-plan-warnings"><strong>Recovery boundary</strong><span>{snapshotPlan.output.recovery}</span></div>
                  <p className="vm-action-revision">Plan revision <code>{snapshotPlan.revision}</code>. Domain UUID, stopped state, disk confinement, and snapshot inventory will be checked again before execution.</p>
                  <div className="vm-plan-form-actions"><button type="button" className="text-button" onClick={() => setSnapshotPlan(null)}>Back</button><button type="button" className="primary-button" onClick={() => void stageSnapshot()} disabled={pending !== null}>{pending ? "Revalidating..." : "Stage for password approval"}</button></div>
                </>
              )}
            </div>
          </section>
        </div>
      )}
      {exportPlan && (
        <div className="vm-planner-backdrop" role="presentation">
          <section className="vm-planner-dialog vm-action-dialog" role="dialog" aria-modal="true" aria-labelledby="vm-export-title">
            <header className="vm-planner-header"><div><span className="eyebrow">Verified local VM export</span><h2 id="vm-export-title">Export {exportPlan.input.name}</h2><p>The VM must remain stopped. This produces an integrity-checked local artifact, not a protected backup.</p></div><button type="button" className="modal-close" aria-label="Close export plan" onClick={() => setExportPlan(null)}>X</button></header>
            <div className="vm-action-review">
              <dl className="vm-plan-summary"><div><dt>Source allocated</dt><dd>{formatBytes(exportPlan.output.sourceAllocatedBytes)}</dd></div><div><dt>Space required</dt><dd>{formatBytes(exportPlan.output.requiredBytes)}</dd></div><div><dt>Destination free</dt><dd>{formatBytes(exportPlan.output.destinationFreeBytes)}</dd></div><div><dt>Protected backup</dt><dd>No</dd></div></dl>
              {exportPlan.output.blockers.length > 0 && <div className="vm-plan-warnings"><strong>Blocked</strong>{exportPlan.output.blockers.map((blocker) => <span key={blocker}>{blocker}</span>)}</div>}
              <div className="vm-plan-gates"><strong>Exact changes</strong><ol>{exportPlan.output.changes.map((change) => <li key={change}>{change}</li>)}</ol></div>
              <div className="vm-plan-gates"><strong>Required verification</strong><ol>{exportPlan.output.verification.map((check) => <li key={check}>{check}</li>)}</ol></div>
              <div className="vm-plan-warnings"><strong>Protection boundary</strong>{exportPlan.output.warnings.map((warning) => <span key={warning}>{warning}</span>)}</div>
              <div className="vm-plan-warnings"><strong>Automatic recovery</strong><span>{exportPlan.output.recovery}</span></div>
              <p className="vm-action-revision">Plan revision <code>{exportPlan.revision}</code>. Domain UUID, stopped state, disks, snapshots, and capacity are checked again before execution.</p>
              <div className="vm-plan-form-actions"><button type="button" className="text-button" onClick={() => setExportPlan(null)}>Cancel</button><button type="button" className="primary-button" onClick={() => void stageExport()} disabled={pending !== null || !exportPlan.output.executable}>{pending ? "Revalidating..." : "Stage for password approval"}</button></div>
            </div>
          </section>
        </div>
      )}
      {protectionPlan && (
        <div className="vm-planner-backdrop" role="presentation">
          <section className="vm-planner-dialog vm-action-dialog" role="dialog" aria-modal="true" aria-labelledby="vm-protection-title">
            <header className="vm-planner-header"><div><span className="eyebrow">Encrypted independent VM backup</span><h2 id="vm-protection-title">Back up {protectionPlan.input.domainName}</h2><p>Move a verified local export into an encrypted independent restic repository. Protected status still requires an isolated restore boot.</p></div><button type="button" className="modal-close" aria-label="Close protection plan" onClick={() => setProtectionPlan(null)}>X</button></header>
            <div className="vm-action-review">
              <dl className="vm-plan-summary"><div><dt>Export size</dt><dd>{formatBytes(protectionPlan.input.expectedSizeBytes)}</dd></div><div><dt>Destination free</dt><dd>{protectionPlan.output.destinationFreeBytes ? formatBytes(protectionPlan.output.destinationFreeBytes) : "Unavailable"}</dd></div><div><dt>Encrypted</dt><dd>{protectionPlan.output.encrypted ? "Yes" : "No"}</dd></div><div><dt>Protected</dt><dd>No, restore drill pending</dd></div></dl>
              {protectionPlan.output.blockers.length > 0 && <div className="vm-plan-warnings"><strong>Blocked</strong>{protectionPlan.output.blockers.map((blocker) => <span key={blocker}>{blocker}</span>)}</div>}
              <div className="vm-plan-gates"><strong>Exact changes</strong><ol>{protectionPlan.output.changes.map((change) => <li key={change}>{change}</li>)}</ol></div>
              <div className="vm-plan-gates"><strong>Required verification</strong><ol>{protectionPlan.output.verification.map((check) => <li key={check}>{check}</li>)}</ol></div>
              <div className="vm-plan-warnings"><strong>Warnings</strong>{protectionPlan.output.warnings.map((warning) => <span key={warning}>{warning}</span>)}</div>
              <div className="vm-plan-warnings"><strong>Recovery boundary</strong><span>{protectionPlan.output.recovery}</span></div>
              <p className="vm-action-revision">Plan revision <code>{protectionPlan.revision}</code>. Export checksums, repository identity, independent mount, and capacity are checked again before execution.</p>
              <div className="vm-plan-form-actions"><button type="button" className="text-button" onClick={() => setProtectionPlan(null)}>Cancel</button><button type="button" className="primary-button" onClick={() => void stageProtection()} disabled={pending !== null || !protectionPlan.output.executable}>{pending ? "Revalidating..." : "Stage for password approval"}</button></div>
            </div>
          </section>
        </div>
      )}
      {retentionPlan && (
        <div className="vm-planner-backdrop" role="presentation">
          <section className="vm-planner-dialog vm-action-dialog" role="dialog" aria-modal="true" aria-labelledby="vm-retention-title">
            <header className="vm-planner-header"><div><span className="eyebrow">Guarded restic retention</span><h2 id="vm-retention-title">Forget {retentionPlan.output.candidates.length} old VM backup(s)</h2><p>Apply the fixed age, minimum-copy, restore-test, and recovery-reference policy to exact reviewed snapshot ids.</p></div><button type="button" className="modal-close" aria-label="Close retention plan" onClick={() => setRetentionPlan(null)}>X</button></header>
            <div className="vm-action-review">
              <dl className="vm-plan-summary"><div><dt>Before</dt><dd>{retentionPlan.output.beforeCount} snapshots</dd></div><div><dt>Forget</dt><dd>{retentionPlan.output.candidates.length} exact snapshots</dd></div><div><dt>Minimum copies</dt><dd>{retentionPlan.output.policy.minimumCopiesPerDomain} per VM</dd></div><div><dt>Minimum age</dt><dd>{retentionPlan.output.policy.minimumAgeDays} days</dd></div></dl>
              {retentionPlan.output.candidates.length > 0 && <div className="vm-plan-gates"><strong>Exact candidates</strong><ol>{retentionPlan.output.candidates.map((candidate) => <li key={candidate.backupId}>{candidate.domainName} | {candidate.ageDays} days old | {formatBytes(candidate.sizeBytes)} | <code>{candidate.snapshotId.slice(0, 12)}</code></li>)}</ol></div>}
              {retentionPlan.output.blockers.length > 0 && <div className="vm-plan-warnings"><strong>Blocked</strong>{retentionPlan.output.blockers.map((blocker) => <span key={blocker}>{blocker}</span>)}</div>}
              <div className="vm-plan-gates"><strong>Exact changes</strong><ol>{retentionPlan.output.changes.map((change) => <li key={change}>{change}</li>)}</ol></div>
              <div className="vm-plan-gates"><strong>Required verification</strong><ol>{retentionPlan.output.verification.map((check) => <li key={check}>{check}</li>)}</ol></div>
              <div className="vm-plan-warnings"><strong>High-risk warnings</strong>{retentionPlan.output.warnings.map((warning) => <span key={warning}>{warning}</span>)}</div>
              <div className="vm-plan-warnings"><strong>Recovery boundary</strong><span>{retentionPlan.output.recovery}</span></div>
              <p className="vm-action-revision">Plan revision <code>{retentionPlan.revision}</code>. Repository identity, exact snapshot set, protection evidence, age, copy floor, and recovery references are checked again before execution.</p>
              <div className="vm-plan-form-actions"><button type="button" className="text-button" onClick={() => setRetentionPlan(null)}>Cancel</button><button type="button" className="primary-button" onClick={() => void stageRetention()} disabled={pending !== null || !retentionPlan.output.executable}>{pending ? "Revalidating..." : "Stage high-risk approval"}</button></div>
            </div>
          </section>
        </div>
      )}
      {restoreDrillPlan && (
        <div className="vm-planner-backdrop" role="presentation">
          <section className="vm-planner-dialog vm-action-dialog" role="dialog" aria-modal="true" aria-labelledby="vm-restore-drill-title">
            <header className="vm-planner-header"><div><span className="eyebrow">Isolated VM restore drill</span><h2 id="vm-restore-drill-title">Validate {restoreDrillPlan.input.domainName}</h2><p>Restore the encrypted snapshot, boot it transiently with no network, and require guest-agent health before protected status.</p></div><button type="button" className="modal-close" aria-label="Close restore drill plan" onClick={() => setRestoreDrillPlan(null)}>X</button></header>
            <div className="vm-action-review">
              <dl className="vm-plan-summary"><div><dt>Restore size</dt><dd>{formatBytes(restoreDrillPlan.input.expectedSizeBytes)}</dd></div><div><dt>Temporary free</dt><dd>{restoreDrillPlan.output.restoreFreeBytes ? formatBytes(restoreDrillPlan.output.restoreFreeBytes) : "Unavailable"}</dd></div><div><dt>Guest resources</dt><dd>{restoreDrillPlan.output.vcpus} vCPU | {restoreDrillPlan.output.memoryMiB} MiB</dd></div><div><dt>Network</dt><dd>None</dd></div></dl>
              {restoreDrillPlan.output.blockers.length > 0 && <div className="vm-plan-warnings"><strong>Blocked</strong>{restoreDrillPlan.output.blockers.map((blocker) => <span key={blocker}>{blocker}</span>)}</div>}
              <div className="vm-plan-gates"><strong>Exact changes</strong><ol>{restoreDrillPlan.output.changes.map((change) => <li key={change}>{change}</li>)}</ol></div>
              <div className="vm-plan-gates"><strong>Required verification</strong><ol>{restoreDrillPlan.output.verification.map((check) => <li key={check}>{check}</li>)}</ol></div>
              <div className="vm-plan-warnings"><strong>Warnings</strong>{restoreDrillPlan.output.warnings.map((warning) => <span key={warning}>{warning}</span>)}</div>
              <div className="vm-plan-warnings"><strong>Recovery boundary</strong><span>{restoreDrillPlan.output.recovery}</span></div>
              <p className="vm-action-revision">Plan revision <code>{restoreDrillPlan.revision}</code>. Backup evidence, repository identity, temporary capacity, generated domain name, and isolation policy are checked again before execution.</p>
              <div className="vm-plan-form-actions"><button type="button" className="text-button" onClick={() => setRestoreDrillPlan(null)}>Cancel</button><button type="button" className="primary-button" onClick={() => void stageRestoreDrill()} disabled={pending !== null || !restoreDrillPlan.output.executable}>{pending ? "Revalidating..." : "Stage for password approval"}</button></div>
            </div>
          </section>
        </div>
      )}
      {recoveryBackup && (
        <div className="vm-planner-backdrop" role="presentation">
          <section className="vm-planner-dialog vm-action-dialog" role="dialog" aria-modal="true" aria-labelledby="vm-recovery-title">
            <header className="vm-planner-header"><div><span className="eyebrow">Guarded VM recovery clone</span><h2 id="vm-recovery-title">Recover {recoveryBackup.domainName}</h2><p>Create a separate persistent VM from the exact protected snapshot. The source and repository remain unchanged.</p></div><button type="button" className="modal-close" aria-label="Close recovery plan" onClick={() => { setRecoveryBackup(null); setRecoveryPlan(null); }}>X</button></header>
            <div className="vm-action-review">
              {!recoveryPlan ? (
                <form onSubmit={(event) => { event.preventDefault(); void planRecovery(); }}>
                  <label className="vm-snapshot-name">New VM name<input value={recoveryName} onChange={(event) => setRecoveryName(event.target.value)} pattern="[A-Za-z0-9][A-Za-z0-9_.-]{0,62}" maxLength={63} required autoComplete="off" /><span>The name must be available. The new VM will not replace the source.</span></label>
                  <div className="vm-plan-warnings"><strong>Safe initial state</strong><span>The clone will be stopped, persistent, autostart disabled, and have no network interface. Starting it later requires a separate password-approved action.</span></div>
                  <div className="vm-plan-form-actions"><button type="button" className="text-button" onClick={() => setRecoveryBackup(null)}>Cancel</button><button type="submit" className="primary-button" disabled={pending !== null}>{pending ? "Inspecting..." : "Generate reviewed plan"}</button></div>
                </form>
              ) : (
                <>
                  <dl className="vm-plan-summary"><div><dt>New domain</dt><dd>{recoveryPlan.input.targetDomainName}</dd></div><div><dt>Restore size</dt><dd>{formatBytes(recoveryPlan.input.expectedSizeBytes)}</dd></div><div><dt>Guest resources</dt><dd>{recoveryPlan.output.vcpus} vCPU | {recoveryPlan.output.memoryMiB} MiB</dd></div><div><dt>Initial isolation</dt><dd>Stopped | no network | no autostart</dd></div></dl>
                  {recoveryPlan.output.blockers.length > 0 && <div className="vm-plan-warnings"><strong>Blocked</strong>{recoveryPlan.output.blockers.map((blocker) => <span key={blocker}>{blocker}</span>)}</div>}
                  <div className="vm-plan-gates"><strong>Exact changes</strong><ol>{recoveryPlan.output.changes.map((change) => <li key={change}>{change}</li>)}</ol></div>
                  <div className="vm-plan-gates"><strong>Required verification</strong><ol>{recoveryPlan.output.verification.map((check) => <li key={check}>{check}</li>)}</ol></div>
                  <div className="vm-plan-warnings"><strong>Warnings</strong>{recoveryPlan.output.warnings.map((warning) => <span key={warning}>{warning}</span>)}</div>
                  <div className="vm-plan-warnings"><strong>Recovery boundary</strong><span>{recoveryPlan.output.recovery}</span></div>
                  <p className="vm-action-revision">Plan revision <code>{recoveryPlan.revision}</code>. Protected evidence, exact snapshot identity, capacity, target-name absence, and the no-network policy are checked again before execution.</p>
                  <div className="vm-plan-form-actions"><button type="button" className="text-button" onClick={() => setRecoveryPlan(null)}>Back</button><button type="button" className="primary-button" onClick={() => void stageRecovery()} disabled={pending !== null || !recoveryPlan.output.executable}>{pending ? "Revalidating..." : "Stage for password approval"}</button></div>
                </>
              )}
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
