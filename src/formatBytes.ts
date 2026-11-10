/**
 * A byte count in IEC units: B, KiB, MiB, GiB, TiB.
 *
 * Each page used to carry its own copy, and they disagreed: one stopped at MiB (a 40 GB backup
 * read "40960.0 MiB"), one at KiB, and one divided by 1024 but printed KB/MB/GB. A missing size
 * shows `empty`.
 */
export function formatBytes(value: number | null | undefined, empty = "—"): string {
  if (value === null || value === undefined || !Number.isFinite(value) || value < 0) return empty;
  const units = ["B", "KiB", "MiB", "GiB", "TiB", "PiB"];
  let size = value;
  let index = 0;
  while (size >= 1024 && index < units.length - 1) { size /= 1024; index += 1; }
  // The unit is chosen after rounding: 1,048,575 bytes is "1.0 MiB", where it read "1024.0 KiB".
  if (index > 0 && index < units.length - 1 && size >= 1023.95) { size = 1; index += 1; }
  return `${size.toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}
