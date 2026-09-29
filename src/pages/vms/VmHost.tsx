import { Button, CodeBlock, EmptyState, KeyValue, Panel, StatusChip, Table, mayStart, riskOf, type Status } from "../../ui";
import type { ConsoleGuidance, LibvirtFoundation, LibvirtResources, VirtualizationCheck, VirtualizationStatus } from "../../virtualization";
import type { StartOperation } from "./vmActions";

type Network = LibvirtResources["networks"][number];
type Pool = LibvirtResources["pools"][number];

export function foundationState(foundation: LibvirtFoundation | null): { status: Status; label: string } {
  if (!foundation) return { status: "unknown", label: "Not read" };
  if (foundation.ready) return { status: "good", label: "Ready" };
  return foundation.planAvailable ? { status: "warning", label: "Setup available" } : { status: "danger", label: "Blocked" };
}

const onOff = (exists: boolean | undefined, active: boolean | undefined) => (!exists ? "Not defined" : active ? "Active" : "Inactive");

/**
 * The host under the VMs (M33.12): whether KVM, QEMU and libvirt are ready, the default network and
 * storage pool BoxPilot sets up, what libvirt has, the commands for a console, and how to reach a
 * VM from elsewhere.
 */
export function VmHost({ status, foundation, resources, guidance, role, start, onOpenRepair }: {
  status: VirtualizationStatus;
  foundation: LibvirtFoundation | null;
  resources: LibvirtResources | null;
  guidance: ConsoleGuidance | null;
  role: string;
  start: StartOperation;
  onOpenRepair: () => void;
}) {
  const passed = status.checks.filter((check) => check.ok).length;
  const setup = foundationState(foundation);
  const serveUrl = status.tailscale.serveUrls[0] ?? null;

  const initialize = () => start({
    operationId: "vm.foundation.initialize",
    title: "Set up the default VM network and storage",
    parameters: {},
    preview: <span>Defines, starts, and autostarts only the missing canonical default NAT network and default storage pool. Failure rolls back only this job's changes.</span>,
  });

  return (
    <>
      <Panel title="Preflight" count={{ status: passed === status.checks.length ? "good" : "warning", label: `${passed} of ${status.checks.length}` }} meta={<>{status.connectionUri} · {status.platform}/{status.architecture}</>}>
        <Table<VirtualizationCheck>
          caption="Virtualization host checks"
          columns={[
            { id: "check", header: "Check", cell: (check) => <strong>{check.label}</strong> },
            { id: "result", header: "Result", cell: (check) => <StatusChip status={check.ok ? "good" : "danger"}>{check.ok ? "OK" : "Fails"}</StatusChip> },
            { id: "detail", header: "Detail", cell: (check) => <span className="vms-detail">{check.detail}</span> },
          ]}
          rows={status.checks}
          rowKey={(check) => check.id}
          rowStatus={(check) => (check.ok ? undefined : "danger")}
          empty="No checks reported."
        />
      </Panel>

      <Panel padded title="Default network and storage pool" count={{ status: setup.status, label: setup.label }}
        actions={foundation?.planAvailable && !foundation.ready && mayStart(role, "vm.foundation.initialize") ? <Button variant="primary" risk={riskOf("vm.foundation.initialize")} onClick={initialize}>Set them up</Button> : undefined}>
        <KeyValue items={[
          { id: "network", label: "NAT network", mono: true, value: <>{foundation?.network.name ?? "default"} · {onOff(foundation?.network.exists, foundation?.network.active)} · {foundation?.network.autostart ? "autostart" : "manual"} · {foundation?.network.bridge ?? "virbr0"}</>, hint: foundation?.boundary.networkCidr ?? "192.168.122.0/24" },
          { id: "pool", label: "Storage pool", mono: true, value: <>{foundation?.pool.name ?? "default"} · {onOff(foundation?.pool.exists, foundation?.pool.active)} · {foundation?.pool.autostart ? "autostart" : "manual"}</>, hint: foundation?.pool.targetPath ?? "/var/lib/libvirt/images" },
        ]} />
        {foundation?.ready && <p className="vms-note">Both are set up and start at boot: VMs can be created.</p>}
        {foundation && !foundation.ready && foundation.planAvailable && (
          <>
            <ul className="vms-list">{(foundation.changes ?? []).map((change) => <li key={change}>{change}</li>)}</ul>
            <p className="vms-note">The job takes no names or paths and rolls back only its own changes.</p>
          </>
        )}
        {foundation && !foundation.ready && !foundation.planAvailable && (
          <div className="vms-blocked">
            <strong>Setup is blocked</strong>
            <ul className="vms-list">{(foundation.conflicts ?? []).map((conflict) => <li key={conflict}>{conflict}</li>)}</ul>
            <Button onClick={onOpenRepair}>Open Repair</Button>
          </div>
        )}
        {!foundation && <p className="vms-note">The default network and pool could not be read.</p>}
      </Panel>

      <Panel title="libvirt resources" count={resources ? { status: resources.connected ? "good" : "warning", label: resources.connected ? "connected" : "unavailable" } : { status: "unknown", label: "not read" }}>
        <div className="vms-pair">
          <Table<Network>
            caption="Networks"
            showCaption
            columns={[
              { id: "name", header: "Network", cell: (network) => <code>{network.name}</code> },
              { id: "state", header: "State", cell: (network) => <StatusChip status={network.active ? "good" : "neutral"}>{network.active ? "active" : "inactive"}</StatusChip> },
              { id: "bridge", header: "Bridge", cell: (network) => network.bridge ?? "no bridge" },
              { id: "boot", header: "Boot", hideOnPhone: true, cell: (network) => (network.autostart ? "autostart" : "manual") },
            ]}
            rows={resources?.networks ?? []}
            rowKey={(network) => network.name}
            empty="No libvirt networks reported."
          />
          <Table<Pool>
            caption="Storage pools"
            showCaption
            columns={[
              { id: "name", header: "Pool", cell: (pool) => <span className="vms-cell"><code>{pool.name}</code><code className="vms-sub">{pool.targetPath ?? "target path unavailable"}</code></span> },
              { id: "state", header: "State", cell: (pool) => <StatusChip status={pool.active ? "good" : "neutral"}>{pool.active ? "active" : "inactive"}</StatusChip> },
              { id: "free", header: "Free", numeric: true, cell: (pool) => pool.available ?? "—" },
            ]}
            rows={resources?.pools ?? []}
            rowKey={(pool) => pool.name}
            empty="No storage pools reported."
          />
        </div>
        {(resources?.errors?.length ?? 0) > 0 && <ul className="vms-list vms-errors">{resources!.errors.map((error) => <li key={error}>{error}</li>)}</ul>}
      </Panel>

      <Panel padded title="Ubuntu setup commands" meta="review them in the server's own console or over SSH">
        {status.setupPlan.commands.length
          ? <CodeBlock label={status.setupPlan.title || "Setup commands"} meta={`${status.setupPlan.commands.length} commands`}>{status.setupPlan.commands.join("\n")}</CodeBlock>
          : <EmptyState title="Nothing to run">{status.setupPlan.title || "Everything needed is already installed."}</EmptyState>}
        {status.setupPlan.notes.length > 0 && <ul className="vms-list">{status.setupPlan.notes.map((note) => <li key={note}>{note}</li>)}</ul>}
      </Panel>

      <Panel padded title="Remote access">
        <KeyValue items={[
          { id: "tailscale", label: "Tailscale", value: serveUrl ? <a className="vms-link" href={serveUrl}>{serveUrl}</a> : status.tailscale.connected ? `Connected${status.tailscale.dnsName ? ` as ${status.tailscale.dnsName}` : ""}; no Serve address` : "Not connected on this host" },
          { id: "console", label: "Console", value: guidance?.privateUrl ? <a className="vms-link" href={guidance.privateUrl} target="_blank" rel="noreferrer">Open the Cockpit console</a> : guidance?.cockpit.installed ? "Cockpit installed, not reachable yet" : "No web console" },
        ]} />
        <p className="vms-note">{guidance?.accessNote || "Console guidance is unavailable."} For a service inside a VM, install Tailscale in the guest or give it a planned LAN address; BoxPilot does not proxy a guest's console.</p>
      </Panel>
    </>
  );
}
