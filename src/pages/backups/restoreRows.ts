import type { DiscoveredSnapshots, SnapshotEntry, SnapshotSources } from "./types";

/*
 * The rows of the Restore list (M91). After a sync the server and the backup drive hold the same
 * snapshot files, so every snapshot was listed twice, "This server" and "Backup drive", with the same
 * date and size. One snapshot is one row, restored from the first place it was found (this server,
 * then the backup drive, then a drive found mounted), saying where else it is.
 */

/** A snapshot as listed, with how many of its apps had a data backup when it was taken (null when it does not say). */
type ListedSnapshot = SnapshotEntry & { withData?: number | null };

export interface RestoreOption {
  key: string;
  source: "local" | "mirror" | "discovered";
  root: string | null;
  where: string;
  snapshot: ListedSnapshot;
  /** The other places the very same snapshot is: by name and checksum, never by name alone. */
  alsoOn: string[];
}

export function restoreOptions(sources: SnapshotSources | null, discovered: DiscoveredSnapshots | null): RestoreOption[] {
  const listed = [
    ...(sources?.sources ?? []).flatMap((entry) => entry.snapshots.map((snapshot) => ({ source: entry.source, root: null, where: entry.source === "mirror" ? "Backup drive" : "This server", snapshot: snapshot as ListedSnapshot }))),
    ...(discovered?.locations ?? []).flatMap((location) => location.snapshots.map((snapshot) => ({ source: "discovered" as const, root: location.root, where: `${location.mount.source} (${location.mount.filesystem})`, snapshot: snapshot as ListedSnapshot }))),
  ];
  const options: RestoreOption[] = [];
  const byIdentity = new Map<string, RestoreOption>();
  for (const entry of listed) {
    // Without a checksum two files of one name are not known to be one snapshot: both are listed.
    const identity = entry.snapshot.checksumSha256 ? `${entry.snapshot.artifact}\u0000${entry.snapshot.checksumSha256}` : null;
    const same = identity ? byIdentity.get(identity) : undefined;
    if (same) {
      if (!same.alsoOn.includes(entry.where)) same.alsoOn.push(entry.where);
      if (same.snapshot.withData == null && entry.snapshot.withData != null) same.snapshot = { ...same.snapshot, withData: entry.snapshot.withData };
      continue;
    }
    // Keyed by position, not "source:artifact": a discovered root is a path, and splitting one on a
    // colon waits for the first drive mounted somewhere odd.
    const option: RestoreOption = { ...entry, key: String(options.length), alsoOn: [] };
    options.push(option);
    if (identity) byIdentity.set(identity, option);
  }
  return options;
}

/** "also on the backup drive", "also on //nas/backups (cifs)", or null. */
export function alsoOnWords(option: RestoreOption): string | null {
  if (!option.alsoOn.length) return null;
  return `also on ${option.alsoOn.map((where) => (where === "Backup drive" ? "the backup drive" : where === "This server" ? "this server" : where)).join(" and ")}`;
}
