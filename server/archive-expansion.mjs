import { statfs } from "node:fs/promises";

/**
 * What an archive holds once unpacked, added up from its listing before anything is extracted. An
 * archive on a drive or a mirror is only as trustworthy as whoever last held it, and unpacked as root
 * a small one that inflates past the free space fills the filesystem, root's reserved blocks included.
 */

/** Free bytes for root's use on the filesystem holding `directory`. */
export async function freeBytesOf(directory) {
  const capacity = await statfs(directory);
  return Number(capacity.bavail) * Number(capacity.bsize);
}

export const gib = (bytes) => `${(Math.max(0, bytes) / 1024 ** 3).toFixed(1)} GiB`;

/**
 * The bytes the archive (or just `members` of it) holds once unpacked; throws when it cannot be listed.
 *
 * Summed a line at a time as tar prints them (M73): buffered whole under a 64 MiB cap, a listing
 * past ~690k files had tar killed for overflowing it, and the restore was refused as an unreadable
 * archive. The runner's `onLine` streams the listing, so only the running total is kept.
 * @param {(binary: string, args: string[], options?: { timeout?: number, onLine?: (line: string, stream: string) => void }) => Promise<{ ok: boolean, stdout?: string, stderr?: string }>} run
 * @param {string} tarBinary
 * @param {string} artifactPath
 * @param {string[]} [members]
 */
export async function expandedBytes(run, tarBinary, artifactPath, members = []) {
  let total = 0;
  const listing = await run(tarBinary, ["-tvzf", artifactPath, "--numeric-owner", ...(members.length ? ["--", ...members] : [])], {
    timeout: 30 * 60_000,
    onLine: (line, stream) => {
      if (stream !== "stdout") return;   // tar warns on stderr; a warning is not an archive member
      total += Number(/^\S+\s+\S+\s+(\d+)\s/.exec(String(line ?? ""))?.[1] ?? 0);
    },
  });
  if (!listing.ok) throw new Error(`Could not read the archive: ${String(listing.stderr ?? "").split("\n").slice(-2).join(" ")}`);
  return total;
}

/**
 * Throw, with nothing changed, when unpacking would leave less than `reserveBytes` free where it goes.
 * @param {{ run: Parameters<typeof expandedBytes>[0], tarBinary: string, artifactPath: string, directory: string, members?: string[], reserveBytes?: number, free?: (directory: string) => Promise<number>, what?: string }} options
 */
export async function assertArchiveFits({ run, tarBinary, artifactPath, directory, members = [], reserveBytes = 1024 ** 3, free = freeBytesOf, what = "The archive" }) {
  const expanded = await expandedBytes(run, tarBinary, artifactPath, members);
  const available = await free(directory);
  if (expanded > available - reserveBytes) throw new Error(`${what} unpacks to ${gib(expanded)}, more than this server can take while keeping ${gib(reserveBytes)} free (${gib(available)} free now). Nothing was changed.`);
  return expanded;
}
