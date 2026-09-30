/*
 * "The server lost power" on Home (2026-09-29): said once, in the owner's own time and locale,
 * until someone says "Got it". The server records it (server/power-loss.mjs) and pushes its own
 * words to the notification target; these are the same words, drawn here so the time is the
 * browser's rather than the server's.
 */

export interface OutageFact {
  /** The boot that ended without a shutdown. */
  id: string;
  /** Its journal's last entry: when it stopped, near enough. */
  stoppedAt: string | null;
  /** When the boot after it began. */
  backAt: string | null;
  offForMs: number | null;
  /** power, overheated or power-button, from the processor's reset reason when it says more than "power". */
  cause: string;
  /** The DNS apps on the server (Pi-hole), which the house lost with it. */
  dnsApps: string[];
  ups: boolean;
  acknowledged: { at: string; by: string | null } | null;
}

/** "3 h 37 min", "12 min", "2 days 4 h". */
export function durationWords(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms) || ms < 60_000) return "less than a minute";
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours < 48) return rest ? `${hours} h ${rest} min` : `${hours} h`;
  const days = Math.floor(hours / 24);
  return `${days} days${hours % 24 ? ` ${hours % 24} h` : ""}`;
}

interface Clock { now: number; locale?: string; timeZone?: string }

/** "1:41 PM", or "1:41 PM on Tue 29 Sep" when it was not today. */
export function clockWords(iso: string, { now, locale, timeZone }: Clock): string {
  const at = new Date(iso);
  const day = (date: Date) => new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
  const time = new Intl.DateTimeFormat(locale, { timeZone, hour: "numeric", minute: "2-digit" }).format(at);
  if (day(at) === day(new Date(now))) return time;
  const parts = Object.fromEntries(new Intl.DateTimeFormat(locale, { timeZone, weekday: "short", day: "numeric", month: "short" }).formatToParts(at).map((part) => [part.type, part.value]));
  return `${time} on ${parts.weekday} ${parts.day} ${parts.month}`;
}

const causeWords: Record<string, string> = { power: "lost power (or froze)", overheated: "shut itself off because it overheated", "power-button": "was switched off by holding its power button" };

/** "homebox lost power (or froze) at 1:41 PM and was off for 3 h 37 min." */
export function outageTitle(outage: OutageFact, hostname: string, clock: Clock): string {
  const what = causeWords[outage.cause] ?? causeWords.power;
  const at = outage.stoppedAt ? ` at ${clockWords(outage.stoppedAt, clock)}` : "";
  const off = outage.offForMs !== null && Number.isFinite(outage.offForMs) ? ` and was off for ${durationWords(outage.offForMs)}` : "";
  return `${hostname} ${what}${at}${off}.`;
}

/** What went down with it, and what would help next time, in two sentences a row can hold. */
export function outageDetail(outage: OutageFact): string {
  const dns = outage.dnsApps;
  const down = dns.length ? `${dns.join(" and ")} ${dns.length === 1 ? "was" : "were"} down with it, so devices using ${dns.length === 1 ? "it" : "them"} had no DNS. ` : "";
  if (outage.cause === "overheated") return `${down}Check that its fans turn and its vents are free of dust.`;
  const steps = [
    "set “Restore on AC power loss” to Power On in its BIOS",
    outage.ups ? "check the UPS, which did not shut it down cleanly" : "add a UPS",
    ...(dns.length ? ["give your router a second DNS server"] : []),
  ];
  return `${down}Next time: ${steps.length > 1 ? `${steps.slice(0, -1).join(", ")} and ${steps.at(-1)}` : steps[0]}.`;
}
