import { useState } from "react";
import { useOperation } from "../../ApproveDialog";
import { Button, EmptyState, Field, Notice, Panel, Select, Sheet, Table, Tag, TextInput, mayStart, riskOf, type TableColumn } from "../../ui";
import { gib, when, type FsSnapshots, type SnapshotRow, type StorageReport } from "./types";

/*
 * Snapshots (M33.9): restore points for a whole volume. LVM snapshots of the mounted volumes, taken
 * before a big update and rolled back if it goes wrong; then the btrfs and ZFS snapshots on this
 * server. Taking one is a sheet; rolling back asks for the snapshot's name, as it always has.
 */

export interface SnapshotsTabProps {
  csrfToken: string;
  role: string;
  report: StorageReport | null;
  loading: boolean;
  fsSnapshots: FsSnapshots | null;
  onChanged: () => void;
}

interface FsRow { kind: "btrfs" | "zfs"; target: string; where: string; name: string; path: string; used: string | null }
interface FsTarget { kind: "btrfs" | "zfs"; target: string; label: string }

const fsNameValid = (name: string) => /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/.test(name);

export default function SnapshotsTab({ csrfToken, role, report, loading, fsSnapshots, onChanged }: SnapshotsTabProps) {
  const { start, dialog } = useOperation(csrfToken, () => onChanged());
  const may = (operationId: string) => mayStart(role, operationId);
  const [lvmForm, setLvmForm] = useState<{ origin: string; size: number; label: string } | null>(null);
  const [fsForm, setFsForm] = useState<{ key: string; name: string } | null>(null);

  const origins = (report?.volumeGroups ?? []).flatMap((group) => group.logicalVolumes.filter((volume) => !volume.snapshot && volume.mountpoints.length > 0).map((volume) => ({ group, volume })));
  const snapshots = report?.snapshots ?? [];
  const defaultOrigin = origins.find((entry) => entry.volume.mountpoints.includes("/")) ?? origins[0];
  const chosen = lvmForm ? origins.find((entry) => entry.volume.path === lvmForm.origin) ?? defaultOrigin : defaultOrigin;
  const freeGiB = chosen ? Math.floor(chosen.group.freeBytes / 1024 ** 3) : 0;
  const sizeValid = lvmForm ? Number.isInteger(lvmForm.size) && lvmForm.size >= 1 && lvmForm.size <= Math.max(1, freeGiB) : false;
  const labelValid = lvmForm ? lvmForm.label === "" || /^[a-z0-9-]{1,24}$/.test(lvmForm.label) : false;

  const takeLvm = () => {
    if (!lvmForm || !chosen || !sizeValid || !labelValid || freeGiB < 1) return;
    const { size, label } = lvmForm;
    setLvmForm(null);
    start({
      operationId: "storage.lvm.snapshot.create",
      title: `Take a snapshot of ${chosen.volume.mountpoints[0]}`,
      parameters: { path: chosen.volume.path, sizeGiB: size, ...(label ? { suffix: label } : {}) },
      preview: <span>Runs <code>lvcreate -s -L {size}G -n boxpilot-snap-&lt;time&gt;{label ? `-${label}` : ""} {chosen.volume.path}</code>. Reserves {size} GiB for changes; if the original changes by more than that, the snapshot becomes invalid (it never harms the original). Remove snapshots you no longer need.</span>,
    });
  };

  const lvmColumns: Array<TableColumn<SnapshotRow>> = [
    {
      id: "snapshot", header: "Snapshot", sortValue: (snapshot) => snapshot.createdAt ?? snapshot.name, cell: (snapshot) => (
        <span className="storage-name">
          <strong className="storage-name__main">{snapshot.suffix ?? snapshot.name.replace(/^boxpilot-snap-/, "")}</strong>
          <code className="storage-name__sub">{snapshot.name}</code>
        </span>
      ),
    },
    { id: "origin", header: "Of", cell: (snapshot) => (snapshot.origin ? <code>{snapshot.origin}</code> : <span className="storage-dim">not recorded</span>) },
    { id: "reserved", header: "Reserved", numeric: true, cell: (snapshot) => (snapshot.sizeGiB ? `${snapshot.sizeGiB} GiB` : gib(snapshot.sizeBytes)) },
    { id: "taken", header: "Taken", sortValue: (snapshot) => snapshot.createdAt ?? "", cell: (snapshot) => when(snapshot.createdAt) },
    {
      id: "actions", header: <span className="ui-visually-hidden">Actions</span>, label: "Actions", className: "storage-actions-cell", cell: (snapshot) => (
        <span className="storage-actions">
          {may("storage.lvm.snapshot.rollback") && (
            <Button risk={riskOf("storage.lvm.snapshot.rollback")} disabled={!snapshot.origin} title={snapshot.origin ? undefined : "BoxPilot has no record of which volume this snapshot came from"} aria-label={`Roll back to ${snapshot.name}`} onClick={() => start({
              operationId: "storage.lvm.snapshot.rollback",
              title: `Roll back to ${snapshot.name}`,
              parameters: { path: snapshot.path },
              confirmText: snapshot.name,
              preview: <span>Runs <code>lvconvert --merge {snapshot.path}</code>. <strong>Everything written to {snapshot.origin ?? "the volume"} since {snapshot.createdAt ? new Date(snapshot.createdAt).toLocaleString() : "the snapshot"} is discarded.</strong> For the root volume the merge runs during the next reboot, so reboot the server when convenient. The snapshot is consumed by the merge.</span>,
            })}>Roll back</Button>
          )}
          {may("storage.lvm.snapshot.delete") && (
            <Button risk={riskOf("storage.lvm.snapshot.delete")} aria-label={`Remove ${snapshot.name}`} onClick={() => start({ operationId: "storage.lvm.snapshot.delete", title: `Remove snapshot ${snapshot.name}`, parameters: { path: snapshot.path }, preview: <span>Runs <code>lvremove -f {snapshot.path}</code> and frees its space. The original volume is untouched.</span> })}>Remove</Button>
          )}
        </span>
      ),
    },
  ];

  const targets: FsTarget[] = fsSnapshots?.supported ? [
    ...(fsSnapshots.btrfs?.filesystems ?? []).map((filesystem) => ({ kind: "btrfs" as const, target: filesystem.target, label: `${filesystem.target} (btrfs${filesystem.source ? ` · ${filesystem.source}` : ""})` })),
    ...(fsSnapshots.zfs?.datasets ?? []).map((dataset) => ({ kind: "zfs" as const, target: dataset.name, label: `${dataset.name} (ZFS${dataset.mountpoint ? ` · ${dataset.mountpoint}` : ""})` })),
  ] : [];
  const fsRows: FsRow[] = fsSnapshots?.supported ? [
    ...(fsSnapshots.btrfs?.filesystems ?? []).flatMap((filesystem) => filesystem.snapshots.map((snapshot) => ({ kind: "btrfs" as const, target: filesystem.target, where: filesystem.source ?? filesystem.target, name: snapshot.name, path: snapshot.path, used: null }))),
    ...(fsSnapshots.zfs?.datasets ?? []).flatMap((dataset) => dataset.snapshots.map((snapshot) => ({ kind: "zfs" as const, target: dataset.name, where: dataset.mountpoint ?? dataset.name, name: snapshot.name, path: snapshot.path, used: snapshot.used ?? null }))),
  ] : [];
  const fsTarget = fsForm ? targets.find((entry) => `${entry.kind}:${entry.target}` === fsForm.key) ?? null : null;
  const takeFs = () => {
    if (!fsForm || !fsTarget || !fsNameValid(fsForm.name)) return;
    const { name } = fsForm;
    setFsForm(null);
    start({
      operationId: "storage.fs-snapshot.create",
      title: `Snapshot ${fsTarget.target}`,
      parameters: { kind: fsTarget.kind, target: fsTarget.target, name },
      preview: <span>{fsTarget.kind === "btrfs" ? <>Creates a read-only btrfs snapshot at <code>{fsTarget.target}/.boxpilot-snapshots/{name}</code>.</> : <>Creates the ZFS snapshot <code>{fsTarget.target}@{name}</code>.</>} Instant, and shares space with the live data until it changes.</span>,
    });
  };
  const fsColumns: Array<TableColumn<FsRow>> = [
    { id: "snapshot", header: "Snapshot", sortValue: (row) => row.name, cell: (row) => <code className="storage-name__main">{row.name}</code> },
    { id: "of", header: "Of", sortValue: (row) => row.target, cell: (row) => <span className="storage-name__line"><code>{row.target}</code><Tag>{row.kind === "zfs" ? "ZFS" : "btrfs"}</Tag></span> },
    { id: "used", header: "Holds", numeric: true, hideOnPhone: true, cell: (row) => row.used ?? "—" },
    {
      id: "actions", header: <span className="ui-visually-hidden">Actions</span>, label: "Actions", className: "storage-actions-cell", cell: (row) => (
        <span className="storage-actions">
          {may("storage.fs-snapshot.delete") && (
            <Button risk={riskOf("storage.fs-snapshot.delete")} aria-label={`Delete snapshot ${row.name} of ${row.target}`} onClick={() => start({
              operationId: "storage.fs-snapshot.delete",
              title: `Delete snapshot ${row.name}`,
              parameters: { kind: row.kind, target: row.target, name: row.name },
              confirmText: row.name,
              preview: <span>Removes the snapshot <code>{row.path}</code>. The filesystem's live data is untouched; only this restore point disappears.</span>,
            })}>Delete</Button>
          )}
        </span>
      ),
    },
  ];

  const takeButton = may("storage.lvm.snapshot.create") && origins.length > 0
    ? <Button variant="primary" risk={riskOf("storage.lvm.snapshot.create")} onClick={() => setLvmForm({ origin: defaultOrigin?.volume.path ?? "", size: 10, label: "" })}>Take a snapshot</Button>
    : null;

  return (
    <>
      {dialog}
      <Panel
        title="LVM snapshots"
        count={report ? snapshots.length : undefined}
        meta={defaultOrigin ? <><b>{gib(defaultOrigin.group.freeBytes)}</b> free in {defaultOrigin.group.name ?? "the volume group"} for changes</> : undefined}
        actions={takeButton}
      >
        <Table
          caption="LVM snapshots"
          columns={lvmColumns}
          rows={snapshots}
          rowKey={(snapshot) => snapshot.path}
          defaultSort={{ column: "taken", direction: "descending" }}
          empty={!report
            ? (loading ? "Reading the volumes…" : "The volumes could not be read.")
            : origins.length === 0
              ? <EmptyState title="No LVM volume to snapshot">Snapshots here are of mounted LVM volumes, which this server does not have.</EmptyState>
              : <EmptyState title="No snapshots yet" action={takeButton}>Take one before a big update and roll back if it goes wrong. It uses free space in the volume group and fills as the original changes.</EmptyState>}
        />
      </Panel>

      {fsSnapshots?.supported && (
        <Panel
          title="btrfs and ZFS snapshots"
          count={fsRows.length}
          meta={<><b>{targets.length}</b> {targets.length === 1 ? "filesystem" : "filesystems"} · deleting one never touches the live data</>}
          actions={may("storage.fs-snapshot.create") && targets.length > 0 ? <Button risk={riskOf("storage.fs-snapshot.create")} onClick={() => setFsForm({ key: `${targets[0].kind}:${targets[0].target}`, name: "" })}>Take a snapshot</Button> : undefined}
        >
          <Table
            caption="btrfs and ZFS snapshots"
            columns={fsColumns}
            rows={fsRows}
            rowKey={(row) => `${row.kind}:${row.target}:${row.name}`}
            empty={<EmptyState title="No filesystem snapshots yet">btrfs and ZFS snapshots are instant and share space with the live data until it changes.</EmptyState>}
          />
        </Panel>
      )}

      {lvmForm && (
        <Sheet
          kicker="LVM snapshot"
          title="Take a snapshot"
          onClose={() => setLvmForm(null)}
          footer={<>
            <Button variant="ghost" onClick={() => setLvmForm(null)}>Cancel</Button>
            <Button variant="primary" risk={riskOf("storage.lvm.snapshot.create")} disabled={!chosen || !sizeValid || !labelValid || freeGiB < 1} onClick={takeLvm}>Take a snapshot</Button>
          </>}
        >
          {freeGiB < 1 && <Notice tone="warning" title="No free space in the volume group">Remove a snapshot, or keep some space unallocated.</Notice>}
          <Field label="Volume">
            <Select mono value={chosen?.volume.path ?? ""} onValueChange={(value) => setLvmForm({ ...lvmForm, origin: value })} options={origins.map((entry) => ({ value: entry.volume.path, label: `${entry.volume.mountpoints[0]} (${gib(entry.volume.sizeBytes)}, ${entry.group.name})` }))} />
          </Field>
          <Field label="Space for changes (GiB)" hint={`Up to ${Math.max(1, freeGiB)} GiB free. If the original changes by more than this, the snapshot becomes invalid; it never harms the original.`} error={!sizeValid ? `A whole number from 1 to ${Math.max(1, freeGiB)}.` : undefined}>
            <TextInput mono type="number" min={1} max={Math.max(1, freeGiB)} value={String(lvmForm.size)} onValueChange={(value) => setLvmForm({ ...lvmForm, size: Number.parseInt(value, 10) || 1 })} />
          </Field>
          <Field label="Label" optional hint="Lower case letters, digits and dashes, up to 24." error={!labelValid ? "Lower case letters, digits and dashes, up to 24." : undefined}>
            <TextInput mono placeholder="before-upgrade" value={lvmForm.label} onValueChange={(value) => setLvmForm({ ...lvmForm, label: value.toLowerCase() })} />
          </Field>
        </Sheet>
      )}

      {fsForm && (
        <Sheet
          side="center"
          size="sm"
          kicker="btrfs or ZFS snapshot"
          title="Take a snapshot"
          onClose={() => setFsForm(null)}
          footer={<>
            <Button variant="ghost" onClick={() => setFsForm(null)}>Cancel</Button>
            <Button variant="primary" risk={riskOf("storage.fs-snapshot.create")} disabled={!fsTarget || !fsNameValid(fsForm.name)} onClick={takeFs}>Take a snapshot</Button>
          </>}
        >
          <Field label="Filesystem">
            <Select mono value={fsForm.key} onValueChange={(value) => setFsForm({ ...fsForm, key: value })} options={targets.map((entry) => ({ value: `${entry.kind}:${entry.target}`, label: entry.label }))} />
          </Field>
          <Field label="Name" hint="Letters, digits, dots, dashes and underscores, up to 32.">
            <TextInput mono placeholder="before-upgrade" value={fsForm.name} onValueChange={(value) => setFsForm({ ...fsForm, name: value })} />
          </Field>
        </Sheet>
      )}
    </>
  );
}
