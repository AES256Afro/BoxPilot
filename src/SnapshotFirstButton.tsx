import { useEffect, useState } from "react";
import type { PendingOperation } from "./ApproveDialog";

interface Overview { volumeGroups?: Array<{ name: string | null; freeBytes: number; logicalVolumes: Array<{ path: string; mountpoints: string[]; growable: boolean; snapshot?: boolean }> }> }

/** "Take a snapshot first": an LVM restore point of the root volume before a big upgrade. Renders nothing without LVM or free space. */
export default function SnapshotFirstButton({ start, suffix = "before-upgrade" }: { start: (operation: PendingOperation) => void; suffix?: string }) {
  const [target, setTarget] = useState<{ path: string; mountpoint: string; sizeGiB: number; group: string } | null>(null);
  useEffect(() => {
    let cancelled = false;
    fetch("/api/v1/storage/overview").then((response) => (response.ok ? response.json() : null)).then((overview: Overview | null) => {
      if (cancelled || !overview?.volumeGroups) return;
      for (const group of overview.volumeGroups) {
        const root = group.logicalVolumes.find((volume) => !volume.snapshot && volume.mountpoints.includes("/")) ?? group.logicalVolumes.find((volume) => volume.growable);
        const freeGiB = Math.floor(group.freeBytes / 1024 ** 3);
        if (root && freeGiB >= 2) { setTarget({ path: root.path, mountpoint: root.mountpoints[0] ?? "/", sizeGiB: Math.min(10, freeGiB), group: group.name ?? "the volume group" }); return; }
      }
    }).catch(() => {});
    return () => { cancelled = true; };
  }, []);
  if (!target) return null;
  return (
    <button className="secondary-button" type="button" onClick={() => start({
      operationId: "storage.lvm.snapshot.create",
      title: `Take a snapshot of ${target.mountpoint} first`,
      parameters: { path: target.path, sizeGiB: target.sizeGiB, suffix },
      preview: <span>Creates an LVM snapshot of <code>{target.mountpoint}</code> reserving {target.sizeGiB} GiB in {target.group}. If the upgrade goes wrong, roll back from the Storage page (the root volume merges during a reboot). Remove the snapshot once you are happy with the result.</span>,
    })}>Take a snapshot first</button>
  );
}
