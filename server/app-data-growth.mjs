/**
 * Which app's data is filling the drive (M23.1).
 *
 * The forecast already says "/mnt/the-dump fills in about nine days". It does not say what is
 * filling it, which is the part the owner can act on: a download client with no ratio limit and a
 * media library that was tidied last year look identical from the outside. This keeps a small daily
 * history of how much each installed app's data folders hold, and turns it into "qBittorrent's
 * downloads grew 240 GB in the last week" - the sentence that leads to a decision.
 *
 * Pure and clock-injected, like the free-space forecast it sits beside. A background sampler feeds
 * it, because measuring a folder means walking it and that is not something a page load should do.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/** One sample per app folder per calendar day (the latest wins), older than `maxDays` dropped. */
export function appendUsageSample(history, { at, entries }, { maxDays = 30 } = {}) {
  const next = { ...(history && typeof history === "object" ? history : {}) };
  const today = at.slice(0, 10);
  const cutoff = Date.parse(at) - maxDays * DAY_MS;
  for (const entry of entries ?? []) {
    // A path that could not be measured is skipped rather than recorded as zero: "we did not look"
    // and "it is empty" are different, and recording the second would show a fictional collapse.
    if (typeof entry?.key !== "string" || !Number.isFinite(entry.bytes)) continue;
    const kept = (Array.isArray(next[entry.key]) ? next[entry.key] : [])
      .filter((sample) => Number.isFinite(Date.parse(sample.at)) && Date.parse(sample.at) >= cutoff && sample.at.slice(0, 10) !== today);
    kept.push({ at, bytes: entry.bytes, appId: entry.appId ?? null, path: entry.path ?? null, mount: entry.mount ?? null });
    next[entry.key] = kept.slice(-maxDays);
  }
  return next;
}

/**
 * How much a folder has grown across the window: the newest reading minus the oldest one still
 * inside it. Null when there is nothing to compare against, which is honest - a folder measured
 * once has no growth, it has a size.
 */
export function growthOverWindow(samples, { now, windowDays = 7 } = {}) {
  const at = now instanceof Date ? now.getTime() : Number(now);
  const inWindow = (Array.isArray(samples) ? samples : [])
    .filter((sample) => Number.isFinite(sample?.bytes) && Number.isFinite(Date.parse(sample?.at)) && at - Date.parse(sample.at) <= windowDays * DAY_MS)
    .sort((left, right) => Date.parse(left.at) - Date.parse(right.at));
  if (inWindow.length === 0) return null;
  const newest = inWindow.at(-1);
  if (inWindow.length === 1) return { bytes: newest.bytes, grewBytes: null, days: 0, from: newest.at, to: newest.at };
  const oldest = inWindow[0];
  const days = (Date.parse(newest.at) - Date.parse(oldest.at)) / DAY_MS;
  return { bytes: newest.bytes, grewBytes: newest.bytes - oldest.bytes, days, from: oldest.at, to: newest.at };
}

/**
 * What is filling a given mount, biggest grower first.
 *
 * Only folders on that mount are considered, so the answer to "what is filling /mnt/the-dump" never
 * includes something living somewhere else. Folders that shrank are kept - a library that was
 * cleared out is worth seeing next to one that doubled.
 */
export function growthByApp(history, { now, mount = null, windowDays = 7, limit = 6 } = {}) {
  const rows = [];
  for (const samples of Object.values(history && typeof history === "object" ? history : {})) {
    const newest = Array.isArray(samples) ? samples.at(-1) : null;
    if (!newest) continue;
    if (mount && newest.mount !== mount) continue;
    const growth = growthOverWindow(samples, { now, windowDays });
    if (!growth) continue;
    rows.push({ appId: newest.appId, path: newest.path, mount: newest.mount, ...growth });
  }
  return rows
    .sort((left, right) => (right.grewBytes ?? -Infinity) - (left.grewBytes ?? -Infinity) || right.bytes - left.bytes)
    .slice(0, limit);
}

/** The folders worth measuring for one installed app: owner-facing data, not its config directory. */
export function measurableFolders(application) {
  const { manifest, live } = application ?? {};
  if (!live?.installed || !manifest) return [];
  const chosen = live?.state?.values?.volumes ?? {};
  const seen = new Set();
  return (manifest.volumes ?? [])
    .filter((volume) => !volume.readOnly)
    .map((volume) => ({ appId: manifest.id, label: volume.label ?? volume.id, path: chosen[volume.id] ?? volume.hostPath }))
    // Only the drives the owner put data on. An app's config directory is small, always on the root
    // filesystem, and never the answer to "what filled my media drive".
    .filter((entry) => typeof entry.path === "string" && (entry.path.startsWith("/mnt/") || entry.path.startsWith("/srv/")))
    .filter((entry) => (seen.has(entry.path) ? false : seen.add(entry.path)));
}

/** Which mount a path sits on: the longest mount point it starts with. */
export function mountFor(path, mounts) {
  let best = null;
  for (const target of mounts ?? []) {
    if (typeof target !== "string") continue;
    if (path === target || path.startsWith(target.endsWith("/") ? target : `${target}/`)) {
      if (!best || target.length > best.length) best = target;
    }
  }
  return best;
}

/**
 * Background sampler: once a day, record how much each app's data folders hold.
 *
 * Daily rather than the forecast's six-hourly, and much later after boot, because this one walks
 * the disk instead of reading a number off it. A run that fails is dropped: a gap in the history is
 * a comparison that cannot be made, which the growth window already handles, and is far better than
 * a fabricated reading.
 */
export function createAppDataSampler({ helper, store, now = () => new Date(), intervalMs = 24 * 60 * 60 * 1000, initialDelayMs = 20 * 60 * 1000, minimumGapMs = 20 * 60 * 60 * 1000, maxDays = 30, timeoutMs = 40 * 60_000, report = (message) => console.warn(message), setInterval: schedule = globalThis.setInterval, setTimeout: delay = globalThis.setTimeout, clearInterval: unschedule = globalThis.clearInterval, clearTimeout: cancel = globalThis.clearTimeout } = {}) {
  /** The newest reading anywhere in the history, so a restart cannot start the clock over. */
  function lastSampledAt(history) {
    let newest = null;
    for (const samples of Object.values(history ?? {})) {
      const at = Date.parse(Array.isArray(samples) ? samples.at(-1)?.at : null);
      if (Number.isFinite(at) && (newest === null || at > newest)) newest = at;
    }
    return newest;
  }

  async function sample({ force = false } = {}) {
    // The owner restarts this service several times on a day they are updating, and each restart
    // re-arms the timer below. Walking every data folder on the disk once per deploy is not what
    // "once a day" means, so the history itself decides whether it is due.
    const history = store.getSetting("appDataUsageHistory", {}) ?? {};
    const previous = lastSampledAt(history);
    if (!force && previous !== null && now().getTime() - previous < minimumGapMs) return { sampled: 0, skipped: "measured recently" };
    const usage = await helper.request("app.data.usage", {}, { timeoutMs });
    const entries = usage?.entries ?? [];
    if (!entries.length) return { sampled: 0 };
    const next = appendUsageSample(history, { at: now().toISOString(), entries }, { maxDays });
    store.setSetting("appDataUsageHistory", next, { updatedBy: null });
    const sampled = entries.filter((entry) => Number.isFinite(entry.bytes)).length;
    // What happened last night, kept where the page can show it. A sweep that has been failing for
    // a fortnight otherwise looks exactly like one that has never had anything to measure.
    const unmeasured = entries.length - sampled;
    store.setSetting("appDataUsageLastRun", { at: now().toISOString(), sampled, unmeasured, error: null }, { updatedBy: null });
    return { sampled, unmeasured };
  }
  function start() {
    // One line a night, on success as well as failure. "Did last night's sweep run?" is a question
    // the journal should be able to answer without anyone opening a page or a database.
    const safeSample = () => sample().then((result) => {
      if (result.sampled) report(`[boxpilot] measured ${result.sampled} application data folder(s)${result.unmeasured ? `, ${result.unmeasured} not measured` : ""}`);
    }).catch((error) => {
      // Never throw out of a timer, but never swallow it either: the owner is told on the Storage
      // page and the reason goes to the journal, so a sweep failing every night is findable.
      try { store.setSetting("appDataUsageLastRun", { at: now().toISOString(), sampled: 0, unmeasured: 0, error: error.message }, { updatedBy: null }); } catch { /* the failure itself must not fail */ }
      report(`[boxpilot] could not measure application data folders: ${error.message}`);
    });
    const first = delay(safeSample, initialDelayMs);
    first.unref?.();
    const timer = schedule(safeSample, intervalMs);
    timer.unref?.();
    return () => { cancel(first); unschedule(timer); };
  }
  return { sample, start };
}
