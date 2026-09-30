/**
 * "The server lost power" (2026-09-29).
 *
 * Power went at 18:41 UTC. The owner's server has no UPS, and its BIOS leaves it off after the power
 * comes back, so it stayed off until somebody pressed the button at 22:18. Pi-hole runs on it as
 * the house's DNS, so the whole home network lost name lookups for 3.6 hours, and all the owner
 * saw was "the network is broken". Nothing on the server said what had happened: the journal of
 * the boot before simply stops, with no shutdown in it.
 *
 * So once per start, BoxPilot asks the helper (which can read the journal) how the previous boot
 * ended. A clean end - a reboot, a shutdown, even one that hung - leaves systemd's shutdown in the
 * journal: "Shutting down.", systemd-shutdown's lines, journald's "Journal stopped". An unclean one
 * leaves none of it, and the next boot says so for itself: journald finds its file "corrupted or
 * uncleanly shut down", ext4 replays its journal or cleans up orphans, FAT says "Volume was not
 * properly unmounted". Both halves are needed before this says anything: no shutdown in the old
 * boot's tail, and a sign of it in the new boot. A tail that merely looks odd is not an outage.
 *
 * What it found is recorded once per boot (setting `powerOutages`) and raised as a condition in the
 * health ledger, which pushes it to the notification target once and keeps it until someone says
 * "Got it" on Home, so it does not nag after that and does not come back at the next restart.
 */

/** The previous boot is news for this long after this one began; older than that it is history. */
export const newsWindowMs = 14 * 24 * 60 * 60_000;
export const outagesSetting = "powerOutages";
export const outageFamily = "power.lost";
export const keptOutages = 10;
/** The catalog's DNS servers: when one runs here, the house's lookups went down with the server. */
export const dnsAppIds = Object.freeze(["pi-hole", "adguard-home", "technitium-dns"]);

const journalctl = () => process.env.BOXPILOT_JOURNALCTL_BINARY ?? "/usr/bin/journalctl";

/** One journal entry per line of `journalctl -o json`, reduced to what is read here. */
export function parseJournalJson(stdout) {
  const entries = [];
  for (const line of String(stdout ?? "").split("\n")) {
    if (!line.trim().startsWith("{")) continue;
    let raw;
    try { raw = JSON.parse(line); } catch { continue; }
    const realtime = Number(raw.__REALTIME_TIMESTAMP);
    // A message that is not valid UTF-8 arrives as an array of bytes.
    const message = Array.isArray(raw.MESSAGE) ? Buffer.from(raw.MESSAGE.filter((byte) => Number.isInteger(byte))).toString("utf8") : typeof raw.MESSAGE === "string" ? raw.MESSAGE : "";
    entries.push({
      at: Number.isFinite(realtime) ? new Date(Math.floor(realtime / 1000)).toISOString() : null,
      identifier: typeof raw.SYSLOG_IDENTIFIER === "string" ? raw.SYSLOG_IDENTIFIER : typeof raw._COMM === "string" ? raw._COMM : null,
      pid: raw._PID !== undefined ? Number(raw._PID) : raw.SYSLOG_PID !== undefined ? Number(raw.SYSLOG_PID) : null,
      kernel: raw._TRANSPORT === "kernel",
      bootId: typeof raw._BOOT_ID === "string" ? raw._BOOT_ID : null,
      message: message.slice(0, 500),
    });
  }
  return entries;
}

/** A `--list-boots` timestamp in UTC ("Tue 2026-09-29 18:41:02 UTC"), as ISO. */
function bootStamp(text) {
  const match = String(text ?? "").match(/(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) (UTC|GMT|Z)/);
  return match ? new Date(`${match[1]}T${match[2]}Z`).toISOString() : null;
}

/**
 * `journalctl --list-boots`: JSON on systemd 251 and later, a table before that (run with TZ=UTC so
 * its times can be read). Oldest first, as journalctl lists them.
 */
export function parseListBoots(stdout) {
  const text = String(stdout ?? "").trim();
  if (text.startsWith("[")) {
    try {
      return JSON.parse(text).filter((boot) => typeof boot?.boot_id === "string").map((boot) => ({
        index: Number(boot.index),
        bootId: boot.boot_id,
        firstAt: Number.isFinite(Number(boot.first_entry)) ? new Date(Math.floor(Number(boot.first_entry) / 1000)).toISOString() : null,
        lastAt: Number.isFinite(Number(boot.last_entry)) ? new Date(Math.floor(Number(boot.last_entry) / 1000)).toISOString() : null,
      }));
    } catch { return []; }
  }
  return text.split("\n").map((line) => line.match(/^\s*(-?\d+)\s+([0-9a-f]{32})\s+(.+)$/)).filter(Boolean).map(([, index, bootId, rest]) => {
    const stamps = [...rest.matchAll(/\w{3} \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} [A-Za-z]+/g)].map((match) => bootStamp(match[0]));
    return { index: Number(index), bootId, firstAt: stamps[0] ?? null, lastAt: stamps[1] ?? null };
  });
}

/**
 * What a shutdown that ran leaves at the end of a boot's journal, whether a reboot, a power-off, a
 * halt or a kexec. Any one of them, anywhere in the tail, means the boot ended on purpose: a
 * shutdown that hung, or one that the power went out in the middle of, is not "lost power".
 */
const shutdownMarkers = [
  { test: (entry) => entry.identifier === "systemd-journald" && /^Journal stopped/.test(entry.message), words: "journald: Journal stopped" },
  { test: (entry) => /Received SIGTERM from PID 1 \(systemd-shutdown\)/.test(entry.message), words: "journald was stopped by systemd-shutdown" },
  { test: (entry) => entry.identifier === "systemd-shutdown", words: "systemd-shutdown ran" },
  // PID 1 only: a user's own systemd reaches its "Shutdown" target whenever their last session ends.
  { test: (entry) => entry.identifier === "systemd" && entry.pid === 1 && /^Shutting down\.?$/.test(entry.message), words: "systemd: Shutting down." },
  { test: (entry) => entry.identifier === "systemd" && entry.pid === 1 && /^Reached target .*(Shutdown|Power[- ]?Off|Reboot|Halt|[Kk]exec)/i.test(entry.message), words: null },
  // "now" only: "The system will reboot at 03:00" is a shutdown that may yet be cancelled.
  { test: (entry) => entry.identifier === "systemd-logind" && /System is (powering down|rebooting|halting)|The system will (power off|reboot|halt) now/i.test(entry.message), words: null },
];

/**
 * The first thing in a boot's tail that says it was shut down, in words; null when nothing does.
 * Only after journald last started: restarting journald (a systemd upgrade does) logs "Journal
 * stopped" too, then "Journal started", and the boot carries on.
 */
export function shutdownMarkerIn(entries = []) {
  const lastStart = entries.findLastIndex((entry) => entry.identifier === "systemd-journald" && /^Journal started/.test(entry.message));
  for (const entry of entries.slice(lastStart + 1)) {
    for (const marker of shutdownMarkers) if (marker.test(entry)) return marker.words ?? `${entry.identifier}: ${entry.message}`;
  }
  return null;
}

/** What a boot says, near its start, about the one before having ended without a shutdown. */
const uncleanSigns = [
  { pattern: /corrupted or uncleanly shut down/i, kind: "journal" },
  { pattern: /orphan cleanup|\d+ orphan inodes? deleted/i, kind: "filesystem" },
  { pattern: /recovery complete|recovery required/i, kind: "filesystem" },
  { pattern: /Volume was not properly unmounted/i, kind: "filesystem" },
  { pattern: /mounting fs with errors|volume is dirty/i, kind: "filesystem" },
];
export const uncleanSignPattern = "corrupted or uncleanly shut down|orphan cleanup|orphan inode|recovery complete|recovery required|not properly unmounted|mounting fs with errors|volume is dirty|Previous system reset reason";

export function uncleanSignsIn(entries = []) {
  const signs = [];
  for (const entry of entries) {
    const sign = uncleanSigns.find(({ pattern }) => pattern.test(entry.message));
    // journald's own early lines come through the kernel's log (kmsg) but keep its name.
    if (sign && signs.length < 8) signs.push({ at: entry.at, kind: sign.kind, message: `${entry.identifier ?? (entry.kernel ? "kernel" : "?")}: ${entry.message}` });
  }
  return signs;
}

/**
 * The reason an AMD processor gives for its last reset (Linux 6.16+): "x86/amd: Previous system
 * reset reason [0x00200800]: ACPI power state transition occurred". A plain power cut and a normal
 * power-off both read as an ACPI power state transition, so it names a cause only when it says
 * something more: an overheat, or the power button held down.
 */
export function resetReasonIn(entries = []) {
  for (const entry of entries) {
    const match = entry.message.match(/Previous system reset reason \[(0x[0-9a-f]+)\]:\s*(.+)$/i);
    if (match) return { code: match[1], text: match[2].trim().replace(/\.$/, "") };
  }
  return null;
}

export function causeOf(resetReason) {
  const text = resetReason?.text ?? "";
  if (/thermal/i.test(text)) return "overheated";
  if (/power button was pressed for 4 seconds/i.test(text)) return "power-button";
  return "power";
}

/**
 * How the boot before this one ended. Pure.
 *
 * `boots` is `--list-boots`, `tail` the previous boot's last entries, `signs` this boot's entries
 * that match uncleanSignPattern, and `bootedAt` when this boot began. `state` is "none" (no boot
 * before this one in the journal), "clean", "unclean", or "unknown" (no shutdown in the tail, and
 * nothing in this boot saying there was not one either: not enough to call it an outage).
 */
export function judgePreviousBoot({ boots = [], tail = [], signs = [], bootedAt = null, currentBootId = null } = {}) {
  const ordered = [...boots].sort((left, right) => left.index - right.index);
  const current = ordered.find((boot) => boot.index === 0) ?? (currentBootId ? ordered.find((boot) => boot.bootId === currentBootId) : null) ?? ordered.at(-1) ?? null;
  const previous = ordered.find((boot) => boot.index === -1) ?? (current ? ordered[ordered.indexOf(current) - 1] : null) ?? null;
  const lastEntry = [...tail].reverse().find((entry) => entry.at) ?? null;
  const previousBootId = previous?.bootId ?? tail.find((entry) => entry.bootId)?.bootId ?? null;
  if (!previousBootId && !tail.length) return { state: "none" };
  const stoppedAt = lastEntry?.at ?? previous?.lastAt ?? null;
  const backAt = bootedAt ?? current?.firstAt ?? null;
  const base = { previousBootId, stoppedAt, backAt, offForMs: stoppedAt && backAt ? Math.max(0, Date.parse(backAt) - Date.parse(stoppedAt)) : null };
  const marker = shutdownMarkerIn(tail);
  if (marker) return { ...base, state: "clean", marker };
  const found = uncleanSignsIn(signs);
  const resetReason = resetReasonIn(signs);
  if (!found.length) return { ...base, state: "unknown", resetReason };
  return {
    ...base,
    state: "unclean",
    cause: causeOf(resetReason),
    resetReason,
    evidence: [
      ...(stoppedAt ? [`the journal of the boot before stops at ${stoppedAt}, with no shutdown in it`] : []),
      ...(lastEntry ? [`its last entry: ${lastEntry.identifier ?? "?"}: ${lastEntry.message.slice(0, 160)}`] : []),
      ...found.map((sign) => sign.message.slice(0, 200)),
      ...(resetReason ? [`the processor's reset reason: ${resetReason.text} (${resetReason.code})`] : []),
    ].slice(0, 10),
  };
}

/**
 * Ask the journal (in the helper: it can read it, and has no network to need). Four reads, the
 * last only when the tail has no shutdown in it, which on a healthy server is never.
 */
export async function inspectBoots({ run, now = () => new Date(), uptimeSeconds = null, bootId = null } = {}) {
  const options = { timeout: 60_000, maxBuffer: 8 * 1024 * 1024, env: { TZ: "UTC" } };
  const listed = await run(journalctl(), ["--list-boots", "-o", "json", "--no-pager"], options);
  let boots = listed.ok ? parseListBoots(listed.stdout) : [];
  // systemd before 251 has no JSON list: the table, in UTC.
  if (!listed.ok || !boots.length) {
    const table = await run(journalctl(), ["--list-boots", "--no-pager"], options);
    boots = table.ok ? parseListBoots(table.stdout) : [];
  }
  const bootedAt = Number.isFinite(uptimeSeconds) ? new Date(now().getTime() - uptimeSeconds * 1000).toISOString() : null;
  if (boots.length < 2) return { available: listed.ok || boots.length > 0, bootedAt, judgement: { state: "none" }, boots: boots.length };
  const fields = "--output-fields=MESSAGE,SYSLOG_IDENTIFIER,_COMM,_PID,SYSLOG_PID,_TRANSPORT,_BOOT_ID";
  const tailRead = await run(journalctl(), ["--boot=-1", "-n", "300", "-o", "json", fields, "--no-pager"], options);
  const tail = parseJournalJson(tailRead.stdout);
  let signs = [];
  if (!shutdownMarkerIn(tail)) {
    // Only the first minutes of this boot, where the signs are: a boot weeks old is a large journal.
    const until = bootedAt ? `@${Math.floor(Date.parse(bootedAt) / 1000) + 20 * 60}` : null;
    const grep = await run(journalctl(), ["--boot=0", ...(until ? ["--until", until] : []), "-o", "json", fields, "--no-pager", "-g", uncleanSignPattern], options);
    signs = parseJournalJson(grep.stdout);
  }
  return { available: true, bootedAt, judgement: judgePreviousBoot({ boots, tail, signs, bootedAt, currentBootId: bootId }), boots: boots.length };
}

/** "3 h 37 min", "12 min", "2 days 4 h". */
export function durationWords(ms) {
  if (!Number.isFinite(ms) || ms < 60_000) return "less than a minute";
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours < 48) return rest ? `${hours} h ${rest} min` : `${hours} h`;
  const days = Math.floor(hours / 24);
  const hoursLeft = hours % 24;
  return `${days} days${hoursLeft ? ` ${hoursLeft} h` : ""}`;
}

/** "1:41 PM", or "1:41 PM on Tue 29 Sep" when it was not today, in `timeZone`. */
export function clockWords(iso, { now = new Date(), timeZone = undefined, locale = "en-US" } = {}) {
  const at = new Date(iso);
  const day = (date) => new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
  const time = new Intl.DateTimeFormat(locale, { timeZone, hour: "numeric", minute: "2-digit" }).format(at);
  if (day(at) === day(now)) return time;
  // "Tue 29 Sep", put together from its parts: ICU's own orders differ by locale and version.
  const parts = Object.fromEntries(new Intl.DateTimeFormat(locale, { timeZone, weekday: "short", day: "numeric", month: "short" }).formatToParts(at).map((part) => [part.type, part.value]));
  return `${time} on ${parts.weekday} ${parts.day} ${parts.month}`;
}

const causeWords = { power: "lost power (or froze)", overheated: "shut itself off because it overheated", "power-button": "was switched off by holding its power button" };

/** The one sentence: "homebox lost power (or froze) at 1:41 PM and was off for 3 h 37 min." */
export function outageTitle(outage, { hostname = "The server", now = new Date(), timeZone = undefined } = {}) {
  const what = causeWords[outage.cause] ?? causeWords.power;
  const at = outage.stoppedAt ? ` at ${clockWords(outage.stoppedAt, { now, timeZone })}` : "";
  const off = Number.isFinite(outage.offForMs) ? ` and was off for ${durationWords(outage.offForMs)}` : "";
  return `${hostname} ${what}${at}${off}.`;
}

/** What it took down with it, and what would help next time: words, not operations. */
export function outageAdvice(outage, { hostname = "the server" } = {}) {
  const dns = outage.dnsApps ?? [];
  const name = dns[0] ?? null;
  return [
    outage.cause === "overheated"
      ? `Check that ${hostname}'s fans turn and its vents are free of dust.`
      : `In ${hostname}'s BIOS, set "Restore on AC power loss" to Power On, so it starts again by itself when the power comes back.`,
    outage.ups
      ? "It has a UPS, and still went down without shutting down cleanly: check the UPS's battery, and that BoxPilot shuts the server down when it runs low."
      : "A small UPS would keep it running through short cuts and shut it down cleanly in long ones; BoxPilot watches one plugged in by USB (System, Power).",
    ...(name ? [`Consider a second DNS server in your router, so devices can still look names up while ${hostname} is off; they will sometimes skip ${name}'s blocking.`] : []),
  ];
}

/** The detail under the title: what went down with it, then the advice. */
export function outageMessage(outage, options = {}) {
  const dns = outage.dnsApps ?? [];
  const down = dns.length ? `${dns.join(" and ")} ${dns.length === 1 ? "was" : "were"} down with it, so devices using ${dns.length === 1 ? "it" : "them"} had no DNS. ` : "";
  return `${down}${outageAdvice(outage, options).join(" ")}`;
}

export const outageKey = (id) => `${outageFamily}:${String(id).slice(0, 12)}`;

/**
 * Once per start: how did the previous boot end? An unclean end not seen before is recorded and
 * raised; one already recorded (BoxPilot restarted since, or it was acknowledged) is left alone.
 * The helper may not be up yet at start, so the read is tried again a few times.
 */
export function createPowerLossWatch({ helper, store, alerts, hostname = "The server", dnsApps = async () => [], ups = async () => false, now = () => new Date(), timeZone = undefined, delay = globalThis.setTimeout, firstDelayMs = 45_000, retryMs = 2 * 60_000, attempts = 5 } = {}) {
  async function check() {
    const read = await helper.request("system.boots.inspect", {}, { timeoutMs: 120_000 });
    const judgement = read?.judgement ?? { state: "none" };
    if (judgement.state !== "unclean" || !judgement.previousBootId) return { state: judgement.state, recorded: false };
    if (judgement.backAt && now().getTime() - Date.parse(judgement.backAt) > newsWindowMs) return { state: judgement.state, recorded: false, old: true };
    const known = (store.getSetting(outagesSetting, []) ?? []).some((entry) => entry.id === judgement.previousBootId);
    if (known) return { state: judgement.state, recorded: false, known: true };
    const [apps, hasUps] = await Promise.all([dnsApps().catch(() => []), ups().catch(() => false)]);
    const outage = {
      id: judgement.previousBootId, stoppedAt: judgement.stoppedAt, backAt: judgement.backAt, offForMs: judgement.offForMs,
      cause: judgement.cause ?? "power", resetReason: judgement.resetReason ?? null, evidence: judgement.evidence ?? [],
      // `acknowledged.by` is masked for everyone but the owner by withOwnActors, as every "who" is.
      dnsApps: apps, ups: Boolean(hasUps), detectedAt: now().toISOString(), acknowledged: null,
    };
    // Written before it is raised: a push that hangs must not let the next start raise it again.
    let added = false;
    store.updateSetting(outagesSetting, [], (entries) => {
      const list = Array.isArray(entries) ? entries : [];
      if (list.some((entry) => entry.id === outage.id)) return { value: list };
      added = true;
      return { value: [outage, ...list].slice(0, keptOutages) };
    }, null);
    if (!added) return { state: judgement.state, recorded: false, known: true };
    await alerts?.raise({ key: outageKey(outage.id), title: outageTitle(outage, { hostname, now: now(), timeZone }), message: outageMessage(outage, { hostname }), priority: "high" });
    return { state: judgement.state, recorded: true, outage };
  }

  function start() {
    let left = attempts;
    const attempt = () => {
      left -= 1;
      check().catch((error) => {
        if (left > 0) { const again = delay(attempt, retryMs); again?.unref?.(); } else console.warn(`[boxpilot] could not read how the previous boot ended: ${error.message}`);
      });
    };
    const first = delay(attempt, firstDelayMs);
    first?.unref?.();
  }

  return { check, start };
}

/** Someone said "Got it": the outage stays on record, and leaves Home and the health ledger. */
export async function acknowledgeOutage({ store, alerts, id, by = null, now = () => new Date() }) {
  let found = null;
  store.updateSetting(outagesSetting, [], (entries) => {
    const list = Array.isArray(entries) ? entries : [];
    return { value: list.map((entry) => {
      if (entry.id !== id) return entry;
      found = entry.acknowledged ? entry : { ...entry, acknowledged: { at: now().toISOString(), by } };
      return found;
    }) };
  }, by);
  if (!found) return null;
  await alerts?.clear(outageKey(id), { quietly: true }).catch(() => {});
  return found;
}
