import type { Status } from "./ui/types";

/*
 * The power-event log in words (M39.1): what happened to the mains, the UPS and the server, for
 * the System page's list and Home's news. Pure, so the wording is tested without a page. Events
 * arrive newest first, as server/power-events.mjs reads them.
 */

export interface PowerEvent {
  at: string;
  event: string;
  charge?: number;
  runtime?: number;
  containers?: number;
  drives?: number;
  busy?: number;
}

export interface PowerEventWords { title: string; detail: string | null; status: Status }

/** "45 s", "3 min", "1 h 12 min". */
export function durationWords(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return minutes % 60 ? `${hours} h ${minutes % 60} min` : `${hours} h`;
}

const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

/** The battery as it stood: "battery 87%, about 21 min left". */
export function batteryWords(event: PowerEvent): string | null {
  const parts = [
    typeof event.charge === "number" ? `battery ${Math.round(event.charge)}%` : null,
    typeof event.runtime === "number" ? `about ${durationWords(event.runtime * 1000)} left` : null,
  ].filter(Boolean);
  return parts.length ? parts.join(", ") : null;
}

/** The newest earlier event of one of these kinds, in a newest-first list. */
function earlier(events: PowerEvent[], index: number, kinds: string[]): PowerEvent | null {
  return events.slice(index + 1).find((entry) => kinds.includes(entry.event)) ?? null;
}

/** One event in words. `events` and `index` place it in the list, for "after 3 min" and "off for 55 min". */
export function powerEventWords(event: PowerEvent, events: PowerEvent[] = [event], index = events.indexOf(event)): PowerEventWords {
  const battery = batteryWords(event);
  switch (event.event) {
    case "on-battery": return { title: "The power went out; the UPS took over", detail: battery, status: "warning" };
    case "on-mains": {
      const out = earlier(events, index, ["on-battery", "on-mains"]);
      const lasted = out?.event === "on-battery" ? Date.parse(event.at) - Date.parse(out.at) : null;
      return { title: lasted !== null && lasted >= 0 ? `The power came back after ${durationWords(lasted)}` : "The power came back", detail: battery, status: "good" };
    }
    case "low-battery": return { title: "The UPS battery ran low", detail: battery, status: "danger" };
    case "forced-shutdown": return { title: "The UPS asked for a shutdown", detail: battery, status: "danger" };
    case "shutdown": return { title: "The server began shutting down, before the battery ran out", detail: battery, status: "danger" };
    case "apps-stopped": {
      const apps = event.containers ?? 0;
      const drives = event.drives ?? 0;
      const busy = event.busy ?? 0;
      const parts = [apps ? `${plural(apps, "app")} stopped` : "no app was running", drives ? `${plural(drives, "drive")} unmounted` : null, busy ? `${plural(busy, "drive")} still in use, left to the shutdown` : null].filter(Boolean);
      return { title: "Apps and drives were put away", detail: parts.join(", "), status: busy ? "warning" : "neutral" };
    }
    case "apps-not-stopped": return { title: "The apps could not all be stopped in time; the server switched off anyway", detail: null, status: "warning" };
    case "power-off": return { title: "The server switched itself off", detail: null, status: "neutral" };
    case "started": {
      const off = earlier(events, index, ["power-off"]);
      const lasted = off ? Date.parse(event.at) - Date.parse(off.at) : null;
      return { title: "The server started again", detail: lasted !== null && lasted >= 0 ? `off for ${durationWords(lasted)}` : null, status: "good" };
    }
    case "shutdown-skipped": return { title: "The battery ran low; shutting down is turned off, so the server kept running", detail: battery, status: "warning" };
    case "contact-lost": return { title: "BoxPilot lost contact with the UPS", detail: "check its USB cable", status: "warning" };
    case "contact-back": return { title: "Contact with the UPS is back", detail: null, status: "good" };
    case "replace-battery": return { title: "The UPS says its battery needs replacing", detail: null, status: "warning" };
    case "watching": return { title: "BoxPilot started watching the UPS", detail: battery, status: "neutral" };
    default: return { title: event.event, detail: null, status: "unknown" };
  }
}

/** What Home tells as news: the outages and what the server did, not the routine. */
const newsworthy = new Set(["on-battery", "on-mains", "low-battery", "shutdown", "apps-not-stopped", "power-off", "started", "shutdown-skipped", "replace-battery"]);

/** Home's power news: the newest few newsworthy events of the last `days` days, in words. */
export function powerNews(events: PowerEvent[], now: number, { days = 7, limit = 3 }: { days?: number; limit?: number } = {}): Array<PowerEvent & PowerEventWords> {
  const since = now - days * 86_400_000;
  return events
    .map((event, index) => ({ event, index }))
    .filter(({ event }) => newsworthy.has(event.event) && Date.parse(event.at) >= since && Date.parse(event.at) <= now + 60_000)
    .slice(0, limit)
    .map(({ event, index }) => ({ ...event, ...powerEventWords(event, events, index) }));
}

/** The UPS's state in a word or two, as NUT's reader names it. */
export function upsStateWords(state: string | null | undefined): { status: Status; label: string } {
  switch (state) {
    case "online": return { status: "good", label: "On mains" };
    case "on-battery": return { status: "warning", label: "On battery" };
    case "low-battery": return { status: "danger", label: "Battery low" };
    case "forced-shutdown": return { status: "danger", label: "Shutting down" };
    case "bypass": return { status: "warning", label: "Bypass" };
    case "offline": return { status: "warning", label: "Off" };
    default: return { status: "unknown", label: "Not answering" };
  }
}
