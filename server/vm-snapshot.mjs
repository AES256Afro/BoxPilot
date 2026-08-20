import { createHash } from "node:crypto";

export function snapshotInventoryRevision(snapshots = []) {
  const names = snapshots.map((snapshot) => typeof snapshot === "string" ? snapshot : snapshot.name).filter((name) => typeof name === "string").sort();
  return createHash("sha256").update(JSON.stringify(names)).digest("hex");
}

export function snapshotDiskRevision(disks = []) {
  const normalized = disks.map((disk) => ({ type: disk.type, device: disk.device, target: disk.target, source: disk.source }))
    .sort((left, right) => left.target.localeCompare(right.target));
  return createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
}
