import type { PendingOperation } from "../../ApproveDialog";

/** What system.settings.inspect reads: the name, the clock, the language, memory and swap, trim. */
export interface SystemSettings {
  hostname: { static: string | null; live: string | null };
  timezone: string | null;
  timezones: string[];
  locale?: string | null;
  locales?: string[];
  swappiness: number | null;
  swap: Array<{ device: string; type: string; sizeKiB: number; usedKiB: number; priority: number }>;
  memory: { memTotalKiB: number | null; memAvailableKiB: number | null; swapTotalKiB: number | null; swapFreeKiB: number | null };
  fstrim: { active: string | null; enabled: string | null; nextRun: string | null };
}

export interface HousekeepingCategory { id: string; title: string; summary: string; items: number | null; bytes: number; humanBytes: string; detail: string[]; keeping: string[]; safe: boolean; unavailable?: string | null }
export interface Housekeeping { generatedAt: string; categories: HousekeepingCategory[]; totalBytes: number; totalHumanBytes: string }
export interface DockerDisk { available: boolean; rows: Array<{ type: string; total: number | string | null; active: number | string | null; size: string | null; reclaimable: string | null }>; logging?: { configured: boolean; logDriver: string | null; maxSize: string | null; liveRestore: boolean } }

export interface ReleaseUpdate { current: { version: string }; latest: { tag: string; version: string; name?: string; url: string; publishedAt: string | null; prerelease?: boolean; notes?: string | null } | null; updateAvailable: boolean; checkedAt: string; error: string | null }
export interface UpdateStatus { units?: Array<{ unit: string; active: string; sub: string }>; log: string[]; outcome?: "running" | "live" | "failed" | null }

export interface DetectedUps { vendorId: string; productId: string; manufacturer: string | null; product: string | null; driver: string; confidence: "vendor-id" | "name"; sysfs: string }
export interface UpsDetection { devices: DetectedUps[]; nutInstalled: boolean }

export type StartOperation = (operation: PendingOperation) => void;

/** "15.6 GiB" from KiB, or a dash. */
export function gib(kib: number | null | undefined): string {
  if (kib === null || kib === undefined) return "—";
  return `${(kib / 1024 / 1024).toFixed(1)} GiB`;
}

/** An IEC size from bytes, "nothing" for none. */
export function bytesWords(bytes: number): string {
  if (bytes <= 0) return "nothing";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  const index = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / 1024 ** index).toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

/** The UPS's name as people know it: its maker and model, or its USB ids. */
export function upsLabel(device: DetectedUps): string {
  return [device.manufacturer, device.product].filter(Boolean).join(" ") || `USB ${device.vendorId}:${device.productId}`;
}
