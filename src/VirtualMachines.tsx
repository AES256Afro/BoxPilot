import { useCallback, useEffect, useState } from "react";
import {
  createVmLifecyclePlan,
  createVmSnapshotPlan,
  fetchVirtualization,
  formatMemory,
  type LibvirtResources,
  type ConsoleGuidance,
  stageVmLifecyclePlan,
  stageVmSnapshotPlan,
  type DomainList,
  type VirtualDomain,
  type VmLifecyclePlan,
  type VmSnapshotPlan,
  type VirtualizationStatus,
} from "./virtualization";
import VmPlanner from "./VmPlanner";

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

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [nextStatus, nextDomains, nextResources, nextConsoleGuidance] = await fetchVirtualization();
      setStatus(nextStatus);
      setDomainList(nextDomains);
      setResources(nextResources);
      setConsoleGuidance(nextConsoleGuidance);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Unable to load virtualization status");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const copySetupCommands = async () => {
    if (!status) return;
    try {
      await navigator.clipboard.writeText(status.setupPlan.commands.join("\n"));
      setMessage("Setup commands copied. Review every command in the Ubuntu console before running it.");
    } catch {
      setMessage("Clipboard access was unavailable. Select the commands and copy them manually.");
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
                  </div>
                  <details className="vm-domain-details">
                    <summary>Disks, network, and snapshots</summary>
                    <div className="vm-detail-grid">
                      <div><strong>Disks</strong>{domain.disks.length ? domain.disks.map((disk) => <span key={`${disk.target}-${disk.source}`}><code>{disk.target}</code>{disk.source}</span>) : <span>No block devices reported</span>}</div>
                      <div><strong>Interfaces</strong>{domain.interfaces.length ? domain.interfaces.map((networkInterface) => <span key={networkInterface.mac}><code>{networkInterface.interface}</code>{networkInterface.source} | {networkInterface.model ?? "default model"}</span>) : <span>No interfaces reported</span>}</div>
                      <div><strong>Snapshots</strong><span>{domain.snapshotCount === null ? "Unavailable" : `${domain.snapshotCount} reported | not independent backups`}</span>{domain.snapshots.map((snapshot) => <span key={snapshot.name}><code>{snapshot.name}</code>{snapshot.current ? "current" : snapshot.state ?? "state unavailable"} | {snapshot.location ?? "location unavailable"}</span>)}</div>
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

      <section className="panel vm-resources-panel">
        <header className="panel-header"><div><strong>Libvirt resources</strong><span>Live networks and storage pools</span></div><span className={`status-pill ${resources?.connected ? "status-good" : "status-warning"}`}>{resources?.connected ? "Connected" : "Unavailable"}</span></header>
        <div className="vm-resource-grid">
          <div><span className="eyebrow">Networks</span>{resources?.networks.length ? resources.networks.map((network) => <div className="vm-resource-row" key={network.name}><strong>{network.name}</strong><span>{network.active ? "Active" : "Inactive"} | {network.bridge ?? "no bridge"} | {network.autostart ? "autostart" : "manual"}</span></div>) : <p>No libvirt networks reported.</p>}</div>
          <div><span className="eyebrow">Storage pools</span>{resources?.pools.length ? resources.pools.map((pool) => <div className="vm-resource-row" key={pool.name}><strong>{pool.name}</strong><span>{pool.active ? "Active" : "Inactive"} | {pool.available ?? "free space unavailable"}</span><code>{pool.targetPath ?? "target path unavailable"}</code></div>) : <p>No storage pools reported.</p>}</div>
        </div>
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
    </div>
  );
}
