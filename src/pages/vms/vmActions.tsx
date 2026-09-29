import type { PendingOperation } from "../../ApproveDialog";
import { LockIcon } from "../../ui/icons";
import type { Status } from "../../ui";
import type { VirtualDomain } from "../../virtualization";

/*
 * What each VM action stages, in one place, so a row's buttons and a VM's sheet stage exactly the
 * same operation with the same preview. The browser names only the subject; the server pins the
 * live evidence when the job is staged, and the helper checks it again when it runs.
 */

export type StartOperation = (operation: PendingOperation) => void;

/** libvirt.mjs marks a VM or snapshot unmanageable when its name is one BoxPilot's operations refuse. */
export const unmanagedNote = "This VM's name is not one BoxPilot can act on. Manage it with virsh.";
export const unmanagedSnapshotNote = "This snapshot's name is not one BoxPilot can act on. Manage it with virsh.";

/** A name the VM operations accept: 1-63 letters, numbers, dots, underscores or hyphens. */
export const vmNamePattern = "[A-Za-z0-9][A-Za-z0-9_.-]{0,62}";
export const isVmName = (name: string) => new RegExp(`^${vmNamePattern}$`).test(name);

export function stateOf(state: string): { status: Status; label: string } {
  if (state === "running") return { status: "good", label: "running" };
  if (state === "stopped") return { status: "neutral", label: "stopped" };
  return { status: "warning", label: state || "unknown" };
}

export type LifecycleAction = "start" | "shutdown" | "reboot" | "autostart-on" | "autostart-off";

export const lifecycle: Record<LifecycleAction, { label: string; preview: string }> = {
  start: { label: "Start", preview: "Starts the VM and verifies libvirt reports it running." },
  shutdown: { label: "Shut down", preview: "Requests a graceful ACPI shutdown and waits up to two minutes. The plug is never pulled. Force off exists for that." },
  reboot: { label: "Reboot", preview: "Requests a guest reboot through libvirt." },
  "autostart-on": { label: "Enable autostart", preview: "The VM will start automatically when this server boots." },
  "autostart-off": { label: "Disable autostart", preview: "The VM will no longer start automatically when this server boots." },
};

export const vmAction = (domain: VirtualDomain, action: LifecycleAction): PendingOperation => ({
  operationId: "vm.action",
  title: `${lifecycle[action].label} ${domain.name}`,
  parameters: { name: domain.name, action },
  preview: <span>{lifecycle[action].preview}</span>,
});

export const forceOff = (domain: VirtualDomain): PendingOperation => ({
  operationId: "vm.force-off",
  title: `Force off ${domain.name}`,
  parameters: { name: domain.name },
  preview: <span>Pulls the virtual power plug with <code>virsh destroy</code>. Unsaved data inside the guest is lost; start the VM again afterwards.</span>,
});

export const deleteVm = (domain: VirtualDomain): PendingOperation => ({
  operationId: "vm.delete",
  title: `Delete ${domain.name}`,
  parameters: { name: domain.name, deleteStorage: true },
  preview: <span>Removes the VM definition and deletes its disks. Independent restic backups are kept. This cannot be undone from here.</span>,
});

export const snapshotCreate = (domain: VirtualDomain, snapshotName: string): PendingOperation => ({
  operationId: "vm.snapshot.create",
  title: `Snapshot ${domain.name} as ${snapshotName}`,
  parameters: { name: domain.name, snapshotName },
  preview: <span>Takes a point-in-time snapshot of the stopped VM you can roll back to. Only plain qcow2 disks can do this, and it is checked first. A snapshot lives on the same disk, so it is not a backup.</span>,
});

export const snapshotRevert = (domain: VirtualDomain, snapshotName: string): PendingOperation => ({
  operationId: "vm.snapshot.revert",
  title: `Revert ${domain.name} to ${snapshotName}`,
  parameters: { name: domain.name, snapshotName },
  preview: <span>Discards everything changed since <code>{snapshotName}</code> and leaves the VM off.</span>,
});

export const snapshotDelete = (domain: VirtualDomain, snapshotName: string): PendingOperation => ({
  operationId: "vm.snapshot.delete",
  title: `Delete snapshot ${snapshotName}`,
  parameters: { name: domain.name, snapshotName },
  preview: <span>Deletes the snapshot and merges its state into the disk. The VM itself is unchanged.</span>,
});

export const exportVm = (domain: VirtualDomain): PendingOperation => ({
  operationId: "vm.export.create",
  title: `Export ${domain.name}`,
  parameters: { name: domain.name },
  preview: <span>Copies the stopped VM's disks into standalone files, checksummed and checked against the originals. This is a local copy on the same server, not yet a backup kept somewhere else. The VM itself is untouched and must stay stopped.</span>,
});

/**
 * What a high-risk action will ask for, said beside its button before the click: the password, and
 * the name to type. The button's own lock and "Password" say the first; this says the second.
 */
export function AsksFor({ typed, what, action }: { /** The name to type, shown exactly. */ typed?: string; /** What to type, in words, when it is not one name. */ what?: string; action?: string }) {
  return (
    <p className="vms-asks">
      <LockIcon className="vms-asks__lock" />
      <span>{action ? `${action} asks` : "Asks"} for your password, then {typed ? <>the name <code>{typed}</code></> : `the ${what ?? "name"}`} typed out.</span>
    </p>
  );
}

/** A date and time, or what to say when there is none. */
export function when(iso: string | null | undefined, missing = "—"): string {
  const time = Date.parse(iso ?? "");
  return Number.isFinite(time) ? new Date(time).toLocaleString([], { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : missing;
}
