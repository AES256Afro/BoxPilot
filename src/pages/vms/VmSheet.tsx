import { useState } from "react";
import { Button, EmptyState, Field, KeyValue, Notice, Panel, Sheet, StatusChip, Switch, Table, Tag, TextInput, mayStart, riskOf, type KeyValueItem } from "../../ui";
import { formatMemory, type VirtualDomain } from "../../virtualization";
import { gibFromKiB, rateLabel, type VmRate } from "./useVmStats";
import { AsksFor, deleteVm, exportVm, forceOff, isVmName, lifecycle, snapshotCreate, snapshotDelete, snapshotRevert, stateOf, unmanagedNote, unmanagedSnapshotNote, vmAction, vmNamePattern, when, type StartOperation } from "./vmActions";

type Snapshot = VirtualDomain["snapshots"][number];
type Disk = VirtualDomain["disks"][number];
type Interface = VirtualDomain["interfaces"][number];

function guestAgentWords(domain: VirtualDomain): string {
  if (!domain.guestAgent) return "Not checked";
  if (!domain.guestAgent.available) return "Not reachable";
  return `Ready${domain.guestAgent.filesystemState ? ` · filesystems ${domain.guestAgent.filesystemState}` : ""}`;
}

/**
 * One VM, beside the list (M33.12): its facts, what it is using now, its snapshots, disks and
 * interfaces, and every action on it with its tier. The high-risk ones (revert, delete) say before
 * the click that they ask for the password and the VM's name typed out. Starting any action closes
 * the sheet, so the approval dialog is the one thing on screen.
 */
export function VmSheet({ domain, rate, role, onClose, start }: { domain: VirtualDomain; rate?: VmRate; role: string; onClose: () => void; start: StartOperation }) {
  const [snapshotName, setSnapshotName] = useState(() => `checkpoint-${new Date().toISOString().slice(0, 10)}`);
  const state = stateOf(domain.state);
  const running = domain.state === "running";
  const stopped = domain.state === "stopped";
  const managed = domain.managed;
  const may = (operationId: string) => managed && mayStart(role, operationId);
  const snapshotValid = isVmName(snapshotName);

  const facts: KeyValueItem[] = [
    { id: "state", label: "State", value: <StatusChip status={state.status}>{state.label}</StatusChip> },
    { id: "cpu", label: "vCPUs", value: String(domain.vcpus), mono: true },
    { id: "memory", label: "Memory", value: formatMemory(domain.memoryKiB), mono: true },
    { id: "autostart", label: "Autostart", value: domain.autostart ? "On: starts when this server boots" : "Off" },
    { id: "persistent", label: "Definition", value: domain.persistent ? "Persistent" : "Transient: gone when it stops" },
    { id: "agent", label: "Guest agent", value: guestAgentWords(domain) },
    { id: "addresses", label: "Addresses", mono: true, value: domain.addresses.length ? domain.addresses.map((address) => address.address).join(", ") : "No leased IP reported" },
    { id: "snapshots", label: "Snapshots", value: domain.snapshotCount === null ? "Unavailable" : `${domain.snapshotCount} · not independent backups` },
  ];

  const snapshotColumns = [
    { id: "name", header: "Snapshot", cell: (snapshot: Snapshot) => <span className="vms-name"><code>{snapshot.name}</code>{snapshot.current && <Tag tone="info">current</Tag>}</span> },
    { id: "state", header: "State", cell: (snapshot: Snapshot) => snapshot.state ?? "unknown" },
    { id: "location", header: "Where", hideOnPhone: true, cell: (snapshot: Snapshot) => snapshot.location ?? "unknown" },
    { id: "taken", header: "Taken", hideOnPhone: true, cell: (snapshot: Snapshot) => when(snapshot.createdAt) },
    {
      id: "actions", header: <span className="ui-visually-hidden">Actions</span>, label: "Actions", className: "vms-actions-cell", cell: (snapshot: Snapshot) => (
        <span className="vms-actions">
          {stopped && may("vm.snapshot.revert") && <Button risk={riskOf("vm.snapshot.revert")} disabled={snapshot.manageable === false} title={snapshot.manageable === false ? unmanagedSnapshotNote : `Asks for your password, then ${domain.name} typed out`} onClick={() => start(snapshotRevert(domain, snapshot.name))} aria-label={`Revert ${domain.name} to ${snapshot.name}`}>Revert</Button>}
          {may("vm.snapshot.delete") && <Button risk={riskOf("vm.snapshot.delete")} disabled={snapshot.manageable === false} title={snapshot.manageable === false ? unmanagedSnapshotNote : undefined} onClick={() => start(snapshotDelete(domain, snapshot.name))} aria-label={`Delete snapshot ${snapshot.name}`}>Delete</Button>}
        </span>
      ),
    },
  ];

  const canPower = may("vm.action") || may("vm.force-off");
  return (
    <Sheet kicker="Virtual machine" title={domain.name} size="lg" onClose={onClose} className="vms-sheet">
      <KeyValue items={facts} />
      {!managed && <Notice tone="warning" title="Not one BoxPilot can act on">{unmanagedNote}</Notice>}

      {running && rate && (
        <section className="vms-live" aria-label={`Live resource use for ${domain.name}`}>
          <KeyValue layout="columns" items={[
            { id: "cpu", label: "CPU", mono: true, value: rate.cpuPercent === null ? "…" : `${rate.cpuPercent.toFixed(0)}%` },
            { id: "ram", label: "RAM", mono: true, value: rate.memoryKiB ? `${gibFromKiB(rate.memoryKiB)}${rate.memoryMaxKiB ? ` / ${gibFromKiB(rate.memoryMaxKiB)}` : ""}` : "—" },
            { id: "disk", label: "Disk", mono: true, value: rateLabel(rate.diskBytesPerSecond) },
            { id: "net", label: "Network", mono: true, value: rateLabel(rate.netBytesPerSecond) },
          ]} />
        </section>
      )}

      {canPower && (
        <Panel level={3} padded title="Power">
          <div className="vms-row">
            {may("vm.action") && stopped && <Button variant="primary" risk={riskOf("vm.action")} onClick={() => start(vmAction(domain, "start"))}>{lifecycle.start.label}</Button>}
            {may("vm.action") && running && <Button risk={riskOf("vm.action")} onClick={() => start(vmAction(domain, "shutdown"))}>{lifecycle.shutdown.label}</Button>}
            {may("vm.action") && running && <Button risk={riskOf("vm.action")} onClick={() => start(vmAction(domain, "reboot"))}>{lifecycle.reboot.label}</Button>}
            {may("vm.force-off") && running && <Button risk={riskOf("vm.force-off")} onClick={() => start(forceOff(domain))}>Force off</Button>}
          </div>
          {may("vm.action") && (
            <Switch
              label="Start with this server"
              description="Starts the VM when the server boots."
              checked={domain.autostart}
              risk={riskOf("vm.action")}
              onChange={(on) => start(vmAction(domain, on ? "autostart-on" : "autostart-off"))}
            />
          )}
        </Panel>
      )}

      <Panel level={3} title="Snapshots" count={domain.snapshotCount ?? undefined} meta="a quick undo on the same disk, not a backup"
        footer={stopped && domain.snapshots.length > 0 && may("vm.snapshot.revert") ? <AsksFor action="Revert" typed={domain.name} /> : undefined}>
        <Table
          caption={`Snapshots of ${domain.name}`}
          columns={snapshotColumns}
          rows={domain.snapshots}
          rowKey={(snapshot) => snapshot.name}
          empty={domain.snapshotCount === null ? "Snapshots could not be read." : <EmptyState title="No snapshots">{stopped ? "Take one below while the VM is stopped." : "A snapshot is taken while the VM is stopped."}</EmptyState>}
        />
        {stopped && domain.persistent && may("vm.snapshot.create") && (
          <form className="vms-inline-form" onSubmit={(event) => { event.preventDefault(); if (snapshotValid) start(snapshotCreate(domain, snapshotName)); }}>
            <Field label="Snapshot name" hint="1-63 letters, numbers, dots, underscores or hyphens. Only plain qcow2 disks can be snapshotted." error={snapshotName && !snapshotValid ? "Use letters, numbers, dots, underscores or hyphens" : undefined}>
              <TextInput mono value={snapshotName} onValueChange={setSnapshotName} pattern={vmNamePattern} maxLength={63} required autoComplete="off" />
            </Field>
            <Button type="submit" risk={riskOf("vm.snapshot.create")} disabled={!snapshotValid}>Take snapshot</Button>
          </form>
        )}
      </Panel>

      <Panel level={3} title="Disks" count={domain.disks.length}>
        <Table<Disk>
          caption={`Disks of ${domain.name}`}
          columns={[
            { id: "target", header: "Target", cell: (disk) => <code>{disk.target}</code> },
            { id: "source", header: "Source", cell: (disk) => <code className="vms-path">{disk.source}</code> },
          ]}
          rows={domain.disks}
          rowKey={(disk) => `${disk.target}-${disk.source}`}
          empty="No block devices reported."
        />
      </Panel>

      <Panel level={3} title="Interfaces" count={domain.interfaces.length}>
        <Table<Interface>
          caption={`Network interfaces of ${domain.name}`}
          columns={[
            { id: "interface", header: "Interface", cell: (entry) => <code>{entry.interface}</code> },
            { id: "source", header: "Network", cell: (entry) => entry.source },
            { id: "model", header: "Model", cell: (entry) => entry.model ?? "default model" },
            { id: "mac", header: "MAC", hideOnPhone: true, cell: (entry) => <code>{entry.mac}</code> },
          ]}
          rows={domain.interfaces}
          rowKey={(entry) => entry.mac}
          empty="No interfaces reported."
        />
      </Panel>

      {stopped && (may("vm.export.create") || may("vm.delete")) && (
        <Panel level={3} padded title="Copy or remove">
          {may("vm.export.create") && domain.persistent && (
            <div className="vms-choice">
              <div className="vms-choice__text"><strong>Export</strong><span>A checksummed local copy of its disks. It counts as a backup once the Backups tab keeps an encrypted copy elsewhere.</span></div>
              <Button risk={riskOf("vm.export.create")} onClick={() => start(exportVm(domain))}>Export</Button>
            </div>
          )}
          {may("vm.delete") && (
            <div className="vms-choice">
              <div className="vms-choice__text"><strong>Delete this VM</strong><span>Removes its definition and deletes its disks. Restic backups are kept.</span><AsksFor typed={domain.name} /></div>
              <Button risk={riskOf("vm.delete")} onClick={() => start(deleteVm(domain))}>Delete VM</Button>
            </div>
          )}
        </Panel>
      )}
    </Sheet>
  );
}
