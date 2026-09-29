import { useState, type CSSProperties } from "react";
import { useOperation } from "../../ApproveDialog";
import { autoReconnectRule, type AutoReconnectControl } from "../../AutoReconnect";
import { mountpointFor } from "../../mountpoints";
import type { MapApp, MapSambaShare } from "../../storageMap";
import { Button, Checkbox, EmptyState, Field, KeyValue, Notice, Panel, Sheet, Table, Tag, TextInput, mayStart, riskOf, type TableColumn } from "../../ui";
import { ReconnectSwitch, UsageMeter } from "./parts";
import { checkableFs, gib, managedMounts, nameValid, percentUsed, permissionlessFs, slug, type DeviceRow, type MountRow, type StorageReport } from "./types";

/*
 * Drives (M33.9): the drives BoxPilot mounted, each with its check, its unmount and whether it
 * reconnects by itself when it drops; then every disk and partition, where a new drive is mounted
 * or an empty one formatted. Claiming LVM space the installer left unused is said first, as the one
 * thing here that is an opportunity rather than a fact.
 */

export interface DrivesTabProps {
  csrfToken: string;
  role: string;
  report: StorageReport | null;
  loading: boolean;
  autoReconnect: AutoReconnectControl;
  /** Apps and the folders they mount, for what a check pauses. */
  mapApps: MapApp[];
  /** Samba's shares, for which computers a check disconnects. */
  sambaShares: MapSambaShare[];
  onChanged: () => void;
  /** "Share on network": open File sharing's Add a share with this folder filled in. */
  onShareFolder: (prefill: { name: string; path: string }) => void;
}

interface MountForm { device: DeviceRow; name: string; readOnly: boolean; appWritable: boolean }

// storage.lvm.extend keeps 32 GiB unallocated for snapshots and does nothing below 256 MiB of real
// growth, so the offer only appears when there is something to claim.
const snapshotReserveBytes = 32 * 1024 ** 3;

const canMount = (device: DeviceRow) => Boolean(!device.protected && device.uuid && device.fstype && device.fstype !== "swap" && device.mountpoints.length === 0 && !device.readOnly);
const canFormat = (device: DeviceRow) => Boolean(!device.protected && device.path && !device.readOnly && ["disk", "part"].includes(device.type ?? "") && device.mountpoints.length === 0);
const dataMountpoint = (device: DeviceRow) => device.mountpoints.find((point) => point.startsWith("/mnt/") || point.startsWith("/srv/"));

function filesystemOf(device: DeviceRow) {
  if (device.type === "lvm" && device.volumeGroup) return <>LVM volume <code>{device.volumeGroup}/{device.logicalVolume}</code>{device.fstype ? ` · ${device.fstype}` : ""}</>;
  if (device.fstype === "LVM2_member") return <>LVM physical volume{device.holdsVolumeGroups.length ? <> for <code>{device.holdsVolumeGroups.join(", ")}</code></> : null}</>;
  return <>{device.fstype ?? "—"}{device.label ? ` (${device.label})` : ""}</>;
}

export default function DrivesTab({ csrfToken, role, report, loading, autoReconnect, mapApps, sambaShares, onChanged, onShareFolder }: DrivesTabProps) {
  const { start, dialog } = useOperation(csrfToken, () => onChanged());
  const [form, setForm] = useState<MountForm | null>(null);

  const managed = managedMounts(report);
  const drives = (report?.mounts ?? []).flatMap((mount) => { const name = managed.get(mount.target); return name ? [{ name, mount }] : []; });
  const growable = (report?.volumeGroups ?? []).flatMap((group) => group.logicalVolumes.filter((volume) => volume.growable).map((volume) => ({ group, volume }))).filter(({ group }) => group.freeBytes - snapshotReserveBytes >= 256 * 1024 ** 2);
  const devices = report?.devices ?? [];

  const may = (operationId: string) => mayStart(role, operationId);

  // The check Repair offers after a drop or an unclean unmount, on demand for any drive BoxPilot
  // mounted. The preview names the apps it pauses, since those are what the owner will notice.
  const checkDrive = (name: string, mount: MountRow) => {
    const on = (path: string) => path === mount.target || path.startsWith(`${mount.target}/`);
    const users = mapApps.filter((app) => app.paths.some(on)).map((app) => app.name);
    // A share of a folder on the drive, or of one above it, keeps it busy while a PC has it open.
    const shares = sambaShares.filter((share) => on(share.path) || mount.target.startsWith(`${share.path.replace(/\/+$/, "")}/`)).map((share) => share.name);
    const checker = mount.fstype === "exfat" ? "fsck.exfat -n" : mount.fstype === "vfat" ? "fsck.fat -n" : "e2fsck -fn";
    start({
      operationId: "storage.check",
      title: `Check ${mount.target}`,
      parameters: { name },
      preview: <span>{users.length ? `Pauses ${users.join(", ")} while ` : "No app uses it, so nothing is paused while "}<code>{mount.target}</code> is unmounted, runs {checker} on it, then mounts it again{users.length ? " and starts them" : ""}.{shares.length ? ` Computers using the ${shares.join(", ")} share${shares.length === 1 ? "" : "s"} are disconnected for it and reconnect by themselves.` : ""} The check only reads: nothing on the drive is repaired or written.</span>,
    });
  };
  const unmount = (name: string, mount: MountRow) => start({
    operationId: "storage.unmount",
    title: `Unmount ${mount.target}`,
    parameters: { name },
    preview: <span>Unmounts <code>{mount.target}</code> and removes its fstab entry. Data on the disk and the empty directory are kept.</span>,
  });
  const format = (device: DeviceRow) => start({
    operationId: "storage.format",
    title: `Erase and format ${device.path}`,
    parameters: { device: device.path },
    confirmText: device.path ?? "",
    preview: <span>Runs <code>wipefs -a</code> then <code>mkfs.ext4</code> on <code>{device.path}</code> ({gib(device.sizeBytes)}{device.model ? `, ${device.model}` : ""}). <strong>Everything on it is destroyed.</strong></span>,
  });
  const openMount = (device: DeviceRow) => setForm({ device, name: device.label ? slug(device.label) : "", readOnly: false, appWritable: permissionlessFs(device.fstype) });
  const submitMount = () => {
    if (!form || !nameValid(form.name)) return;
    const { device, name, readOnly, appWritable } = form;
    setForm(null);
    start({
      operationId: "storage.mount",
      title: `Mount ${device.path} at ${mountpointFor(name)}`,
      parameters: { uuid: device.uuid, name, ...(readOnly ? { readOnly: true } : {}), ...(appWritable && !readOnly ? { appWritable: true } : {}) },
      preview: <span>Mounts <code>{device.path}</code> ({device.fstype ?? "auto"}) at <code>{mountpointFor(name)}</code> with a <code>nofail</code> fstab entry, so a missing disk never blocks boot.{readOnly ? " Read-only." : appWritable ? (permissionlessFs(device.fstype) ? " Owned by your apps user so containers and shares can write to it." : " The top folder is handed to your apps user so containers can write to it.") : ""}</span>,
    });
  };

  const armable = drives.some(({ name, mount }) => mount.target === mountpointFor(name));
  const driveColumns: Array<TableColumn<{ name: string; mount: MountRow }>> = [
    {
      id: "drive", header: "Drive", sortValue: ({ mount }) => mount.target, cell: ({ mount }) => (
        <span className="storage-name">
          <code className="storage-name__main">{mount.target}</code>
          <span className="storage-name__sub">{mount.source} · {mount.fstype}</span>
        </span>
      ),
    },
    { id: "used", header: "Used", sortValue: ({ mount }) => percentUsed(mount.usedBytes, mount.sizeBytes), cell: ({ mount }) => <UsageMeter used={mount.usedBytes} size={mount.sizeBytes} label={mount.target} /> },
    {
      id: "reconnect", header: "If it drops", label: "If it drops", cell: ({ name, mount }) => (mount.target === mountpointFor(name)
        ? <ReconnectSwitch drive={name} control={autoReconnect} canChange={may("storage.remount")} />
        : <span className="storage-dim">—</span>),
    },
    {
      id: "actions", header: <span className="ui-visually-hidden">Actions</span>, label: "Actions", className: "storage-actions-cell", cell: ({ name, mount }) => (
        <span className="storage-actions">
          {may("storage.check") && mount.target === mountpointFor(name) && checkableFs(mount.fstype) && (
            <Button risk={riskOf("storage.check")} aria-label={`Check this drive: ${mount.target}`} onClick={() => checkDrive(name, mount)}>Check</Button>
          )}
          {may("storage.unmount") && <Button risk={riskOf("storage.unmount")} aria-label={`Unmount ${mount.target}`} onClick={() => unmount(name, mount)}>Unmount</Button>}
        </span>
      ),
    },
  ];

  const deviceColumns: Array<TableColumn<DeviceRow>> = [
    {
      id: "device", header: "Device", cell: (device) => (
        <span className="storage-device" style={{ "--storage-depth": device.depth } as CSSProperties}>
          <code className="storage-name__main">{device.path}</code>
          {device.model && <span className="storage-name__sub">{device.model}</span>}
          {device.removable && <Tag>removable</Tag>}
          {device.protected && <Tag title={device.protectedReason ?? undefined}>{device.protectedReason === "system disk" ? "system" : "protected"}</Tag>}
        </span>
      ),
    },
    { id: "size", header: "Size", numeric: true, cell: (device) => gib(device.sizeBytes) },
    { id: "filesystem", header: "Filesystem", cell: (device) => <span className="storage-wrap">{filesystemOf(device)}</span> },
    {
      id: "mounted", header: "Mounted at", cell: (device) => (device.mountpoints.length
        ? <span className="storage-wrap">{device.mountpoints.map((point) => <code key={point}>{point}</code>)}</span>
        : device.mountedBelow.length ? <span className="storage-dim">holds {device.mountedBelow.join(", ")}</span> : <span className="storage-dim">—</span>),
    },
    {
      id: "actions", header: <span className="ui-visually-hidden">Actions</span>, label: "Actions", className: "storage-actions-cell", cell: (device) => {
        const point = dataMountpoint(device);
        return (
          <span className="storage-actions">
            {may("storage.mount") && canMount(device) && <Button risk={riskOf("storage.mount")} aria-label={`Mount ${device.path}`} onClick={() => openMount(device)}>Mount…</Button>}
            {may("samba.apply") && !device.protected && point && (
              <Button variant="ghost" aria-label={`Share ${point} on the network`} onClick={() => onShareFolder({ name: slug(device.label || point.split("/").filter(Boolean).pop() || "share"), path: point })}>Share…</Button>
            )}
            {may("storage.format") && canFormat(device) && <Button risk={riskOf("storage.format")} aria-label={`Erase and format ${device.path}`} onClick={() => format(device)}>Format</Button>}
          </span>
        );
      },
    },
  ];

  return (
    <>
      {dialog}
      {growable.map(({ group, volume }) => (
        <Notice
          key={volume.path}
          tone="info"
          title={`${gib(group.freeBytes)} of ${group.name ?? "the volume group"} is not in use`}
          action={may("storage.lvm.extend") ? (
            <Button risk={riskOf("storage.lvm.extend")} variant="primary" onClick={() => start({
              operationId: "storage.lvm.extend",
              title: `Grow ${volume.mountpoints[0]} by ${gib(group.freeBytes - snapshotReserveBytes)}`,
              parameters: { path: volume.path },
              preview: <span>Grows the logical volume into the free space of {group.name ?? "its group"} and resizes the {volume.fstype} filesystem while mounted (<code>lvextend -r</code>), keeping <strong>32 GiB</strong> unallocated for snapshots. Existing data is untouched.</span>,
            })}>Use the rest of the disk</Button>
          ) : undefined}
        >
          The volume at <code>{volume.mountpoints[0]}</code> has {gib(volume.sizeBytes)} of the {gib(group.sizeBytes)} group on {group.physicalVolumes.join(", ")}. Claiming the rest is done online: no reboot, nothing erased.
        </Notice>
      ))}

      <Panel
        title="BoxPilot's drives"
        count={report ? drives.length : undefined}
        meta={report ? <>mounted by BoxPilot · <b>{drives.filter(({ name }) => autoReconnect.status?.drives[name]).length}</b> reconnect by themselves</> : undefined}
        footer={autoReconnect.status && armable ? <span className="storage-rule">{autoReconnectRule(autoReconnect.status.limits)}</span> : undefined}
      >
        <Table
          caption="Drives BoxPilot mounted"
          columns={driveColumns}
          rows={drives}
          rowKey={({ mount }) => mount.target}
          rowStatus={({ mount }) => ((percentUsed(mount.usedBytes, mount.sizeBytes) ?? 0) >= 90 ? "danger" : undefined)}
          empty={!report
            ? (loading ? "Reading the drives…" : "The drives could not be read.")
            : <EmptyState title="No drive mounted by BoxPilot">Mount one from the disks below: it is checked first and mounts again at every boot, and a missing drive never stops the server starting.</EmptyState>}
        />
      </Panel>

      <Panel
        title="Disks and partitions"
        count={report ? devices.filter((device) => device.type === "disk").length : undefined}
        meta={report ? <><b>{devices.filter((device) => device.type === "disk" && device.removable).length}</b> removable · the system disk is never offered</> : undefined}
      >
        <Table
          caption="Disks, partitions and volumes"
          columns={deviceColumns}
          rows={devices}
          rowKey={(device) => device.path ?? `${device.type}-${device.uuid}`}
          empty={!report ? (loading ? "Reading block devices…" : "The block devices could not be read.") : "No block devices were listed."}
        />
      </Panel>

      {form && (
        <Sheet
          className="storage-sheet"
          kicker="Mount a drive"
          title={form.device.path ?? "Drive"}
          onClose={() => setForm(null)}
          footer={<>
            <Button variant="ghost" onClick={() => setForm(null)}>Cancel</Button>
            <Button variant="primary" risk={riskOf("storage.mount")} disabled={!nameValid(form.name)} onClick={submitMount}>Mount</Button>
          </>}
        >
          <KeyValue items={[
            { id: "fs", label: "Filesystem", value: form.device.fstype ?? "auto", mono: true },
            { id: "size", label: "Size", value: gib(form.device.sizeBytes), mono: true },
            ...(form.device.label ? [{ id: "label", label: "Label", value: form.device.label, mono: true }] : []),
            ...(form.device.model ? [{ id: "model", label: "Model", value: form.device.model }] : []),
          ]} />
          <Field
            label="Mount name"
            hint={<>Mounts at <code>{nameValid(form.name) ? mountpointFor(form.name) : "/mnt/<name>"}</code> and again at every boot; a missing drive never blocks it.</>}
            error={form.name && !nameValid(form.name) ? (form.name === "boxpilot" ? "boxpilot is the backup destination's folder." : "Lower case letters, digits and dashes, starting with a letter or digit.") : undefined}
          >
            <TextInput mono placeholder="data" autoComplete="off" value={form.name} onValueChange={(value) => setForm({ ...form, name: value.toLowerCase() })} />
          </Field>
          <Checkbox label="Read-only" checked={form.readOnly} onChange={(checked) => setForm({ ...form, readOnly: checked, appWritable: checked ? false : form.appWritable })} />
          <Checkbox
            label="Writable by my apps"
            description="Hands the drive to your apps' user (1000) so containers and network shares can write to it. Without it an exFAT or NTFS drive is read-only for apps."
            checked={form.appWritable}
            disabled={form.readOnly}
            onChange={(checked) => setForm({ ...form, appWritable: checked })}
          />
        </Sheet>
      )}
    </>
  );
}
