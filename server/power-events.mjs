/**
 * The power-event log (M39.1): on battery, back on mains, low battery, the shutdown and what it
 * did. NUT's monitor writes a line for each event it sees through the notify script BoxPilot
 * installs (server/tasks/ups.mjs), and the shutdown command adds how the apps and drives were
 * put away before the power-off. The web process reads it for the System page and Home.
 *
 * One event per line, written by a shell script as the `nut` user and by root at shutdown:
 *
 *   2026-09-29T18:41:02Z on-battery charge=100 runtime=1260
 *
 * Only known event names and numeric fields are read back; anything else on a line is ignored, so
 * a hand edit or a torn write costs that line and nothing more. The file is world-readable: it
 * holds power states and times, which Home already shows live, and nothing about the UPS itself.
 */
import { appendFile, readFile } from "node:fs/promises";
import os from "node:os";

export const powerEventsDirectory = process.env.BOXPILOT_POWER_EVENTS_DIRECTORY ?? "/var/lib/boxpilot-power";
export const powerEventsPath = `${powerEventsDirectory}/events.log`;
/** What BoxPilot set up, for the pages to show without reading NUT's files (they hold the monitor password). */
export const powerPolicyPath = `${powerEventsDirectory}/policy.json`;

/**
 * NUT's notify types and the name each is logged under. NOCOMM (never reached) reads as a lost
 * contact; the rest of NUT's types (CAL, OFF, BYPASS, ...) are not power events for a home server.
 */
export const notifyEvents = Object.freeze({
  ONBATT: "on-battery",
  ONLINE: "on-mains",
  LOWBATT: "low-battery",
  FSD: "forced-shutdown",
  SHUTDOWN: "shutdown",
  COMMBAD: "contact-lost",
  NOCOMM: "contact-lost",
  COMMOK: "contact-back",
  REPLBATT: "replace-battery",
});

/** Every event name a line may carry: NUT's, and what BoxPilot itself writes. */
export const powerEventNames = Object.freeze([...new Set([
  ...Object.values(notifyEvents),
  "watching", // BoxPilot set up (or set up again) the UPS monitor
  "apps-stopped", // the shutdown put the apps and drives away (fields say how many)
  "apps-not-stopped", // the shutdown could not, and powered off regardless
  "power-off", // the last line before the power-off
  "shutdown-skipped", // the battery ran low with shutdown turned off
])]);

const fieldNames = new Set(["charge", "runtime", "containers", "drives", "busy"]);
const linePattern = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ) ([a-z-]{2,32})((?: [a-z]{2,16}=[0-9]{1,9}(?:\.[0-9]{1,3})?)*)\s*$/;

/** The events in `text`, oldest first. Unknown names, malformed lines and unknown fields are skipped. */
export function parsePowerEvents(text) {
  const events = [];
  for (const line of String(text ?? "").split("\n")) {
    const match = linePattern.exec(line.trim());
    if (!match || !powerEventNames.includes(match[2])) continue;
    const at = new Date(match[1]);
    if (Number.isNaN(at.getTime())) continue;
    const event = { at: at.toISOString(), event: match[2] };
    for (const pair of match[3].trim().split(" ").filter(Boolean)) {
      const [key, value] = pair.split("=");
      if (fieldNames.has(key)) event[key] = Number(value);
    }
    events.push(event);
  }
  return events;
}

/** One line of the log, as the scripts write it. */
export function formatPowerEvent(event, fields = {}, now = new Date()) {
  if (!powerEventNames.includes(event)) throw new Error(`Unknown power event ${event}`);
  const parts = [now.toISOString().replace(/\.\d{3}Z$/, "Z"), event];
  for (const [key, value] of Object.entries(fields)) if (fieldNames.has(key) && Number.isFinite(value) && value >= 0) parts.push(`${key}=${Math.round(value * 1000) / 1000}`);
  return `${parts.join(" ")}\n`;
}

/** Add one event (root, at shutdown). Never throws: a log that cannot be written must not stop a power-off. */
export async function appendPowerEvent(event, fields = {}, { path = powerEventsPath, append = appendFile, now = new Date() } = {}) {
  try { await append(path, formatPowerEvent(event, fields, now), { mode: 0o644 }); return true; } catch { return false; }
}

/**
 * The newest events, newest first, at most `limit`. When the last thing logged is the power-off and
 * this boot began after it, a synthetic "started" event says when the server came back: nothing in
 * NUT reports it, and it is the other half of the story on the page.
 */
export async function readPowerEvents({ path = powerEventsPath, read = (file) => readFile(file, "utf8"), limit = 30, bootTime = new Date(Date.now() - os.uptime() * 1000) } = {}) {
  let text;
  try { text = await read(path); } catch (error) { return { available: error?.code === "ENOENT" ? "none" : "unreadable", events: [] }; }
  // The log is kept short by the notify script; a larger one is read from its end.
  const events = parsePowerEvents(String(text).slice(-256 * 1024));
  const last = events.at(-1);
  if (last && ["power-off", "apps-not-stopped", "apps-stopped", "shutdown"].includes(last.event) && bootTime instanceof Date && !Number.isNaN(bootTime.getTime()) && bootTime.getTime() > Date.parse(last.at)) {
    events.push({ at: new Date(Math.floor(bootTime.getTime() / 1000) * 1000).toISOString(), event: "started" });
  }
  return { available: "yes", events: events.slice(-limit).reverse() };
}

/** What BoxPilot set up for the UPS, from the file the setup writes; null before any setup. */
export async function readPowerPolicy({ path = powerPolicyPath, read = (file) => readFile(file, "utf8") } = {}) {
  try {
    const value = JSON.parse(await read(path));
    if (!value || typeof value !== "object") return null;
    const number = (item, low, high) => (Number.isFinite(item) && item >= low && item <= high ? item : null);
    return {
      shutdownAtLowBattery: value.shutdownAtLowBattery === true,
      lowBatteryPercent: number(value.lowBatteryPercent, 5, 95),
      lowRuntimeSeconds: number(value.lowRuntimeSeconds, 30, 3600),
      preparationSeconds: number(value.preparationSeconds, 10, 600),
      configuredAt: typeof value.configuredAt === "string" && !Number.isNaN(Date.parse(value.configuredAt)) ? value.configuredAt : null,
    };
  } catch {
    return null;
  }
}
