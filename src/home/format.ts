import { countOf } from "../data";
import type { Status } from "../ui/types";
import type { MountFact } from "./facts";

/*
 * Small formatters Home and Ops share. The clock is always passed in, so a test can hold it still.
 */

/** "just now", "5 minutes ago", "3 hours ago", "2 days ago"; "in 4 hours" for a time ahead. Null when not a time. */
export function relativeTime(iso: string | null | undefined, now: number): string | null {
  if (!iso) return null;
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return null;
  const ahead = at > now;
  const minutes = Math.floor(Math.abs(now - at) / 60_000);
  if (minutes < 1) return ahead ? "in a moment" : "just now";
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  const amount = minutes < 60 ? countOf(minutes, "minute") : hours < 48 ? countOf(hours, "hour") : countOf(days, "day");
  return ahead ? `in ${amount}` : `${amount} ago`;
}

/** The same, short, for a dense table: "5m", "3h", "2d". */
export function shortAge(iso: string | null | undefined, now: number): string | null {
  if (!iso) return null;
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return null;
  const minutes = Math.max(0, Math.floor((now - at) / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return hours < 48 ? `${hours}h` : `${Math.floor(hours / 24)}d`;
}

/** A job's length: "41s", "3m 12s", "1h 04m". */
export function elapsed(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

/** Uptime as "19d 4h", "5h 12m". */
export function uptime(seconds: number): string {
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3600);
  return days > 0 ? `${days}d ${hours}h` : `${hours}h ${Math.floor((seconds % 3600) / 60)}m`;
}

/** Bytes as the gigabytes a person reads a disk or memory in: "11.0 GB", "412 MB". */
export function size(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes)) return "—";
  const gib = bytes / 1024 ** 3;
  if (gib >= 1000) return `${(gib / 1024).toFixed(1)} TB`;
  if (gib >= 1) return `${gib.toFixed(1)} GB`;
  return `${Math.round(bytes / 1024 ** 2)} MB`;
}

/** How full or busy, as a status: amber from `warn`, red from `danger`; not read is unknown. */
export function loadStatus(percent: number | null | undefined, warn: number, danger: number): Status {
  if (percent === null || percent === undefined || !Number.isFinite(percent)) return "unknown";
  return percent >= danger ? "danger" : percent >= warn ? "warning" : "good";
}

/** A filesystem's fullness as the inventory judged it. */
export function mountStatus(mount: MountFact): Status {
  if (mount.state === "critical") return "danger";
  if (mount.state === "warning") return "warning";
  if (mount.state === "healthy") return "good";
  return "unknown";
}

/** "/" is the system disk; anything else is named by where it is mounted. */
export const mountName = (target: string) => (target === "/" ? "System disk" : target);

/**
 * A processor's name as a person says it: "AMD Ryzen 7 7800X3D 8-Core Processor" is "AMD Ryzen 7
 * 7800X3D", "Intel(R) Core(TM) i5-8500T CPU @ 2.10GHz" is "Intel Core i5-8500T". Empty stays empty.
 */
export function shortCpu(model: string): string {
  return model
    .replace(/\((R|TM|C)\)/gi, "")
    .replace(/@\s*[\d.]+\s*GHz/i, "")
    .replace(/\b\d+-Core\b/gi, "")
    .replace(/\b(Processor|CPU|with Radeon Graphics)\b/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Good morning, afternoon or evening, by the browser's own clock. */
export function greeting(now: number): string {
  const hour = new Date(now).getHours();
  if (hour >= 5 && hour < 12) return "Good morning";
  if (hour >= 12 && hour < 18) return "Good afternoon";
  return "Good evening";
}
