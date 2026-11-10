import { relativeTime } from "../home/format";

export interface RelativeTimeProps {
  /** The moment: an ISO string or milliseconds since the epoch. Nothing is drawn but the fallback when it is missing or unreadable. */
  at: string | number | null | undefined;
  /** The clock to count from, in milliseconds: the page's own, so a test holds it still. */
  now: number;
  /** What to say when there is no moment: "never", "not yet". */
  fallback?: string;
  className?: string;
}

/**
 * A moment in relative words ("3 minutes ago", "in 2 hours") that still gives the exact time: the
 * `<time>` carries the ISO moment for a machine and the local date and time as its tooltip, so
 * "checked 27 hours ago" can be pinned to the minute without leaving the page.
 */
export function RelativeTime({ at, now, fallback, className }: RelativeTimeProps) {
  const moment = typeof at === "number" ? new Date(at) : typeof at === "string" && at ? new Date(at) : null;
  const iso = moment && Number.isFinite(moment.getTime()) ? moment.toISOString() : null;
  const words = iso ? relativeTime(iso, now) : null;
  if (!moment || !iso || !words) return fallback ? <span className={className}>{fallback}</span> : null;
  return <time className={className} dateTime={iso} title={moment.toLocaleString()}>{words}</time>;
}
