/**
 * Predict when a filesystem will fill (M23.1).
 *
 * The health alerts already shout at 90% and 95%, but for a media box that fills steadily those
 * thresholds arrive with little runway. This keeps a small daily history of free space per mount and
 * fits a line through it, so "at this rate, /mnt/media fills in about nine days" can be said before
 * it is urgent. Pure and clock-injected; a background sampler feeds it.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Append today's readings to the per-mount history, one sample per calendar day (the latest wins),
 * dropping anything older than `maxDays`. Pure: returns a new history object.
 */
export function appendSample(history, { at, entries }, { maxDays = 30 } = {}) {
  const next = { ...(history && typeof history === "object" ? history : {}) };
  const today = at.slice(0, 10);
  const cutoff = Date.parse(at) - maxDays * DAY_MS;
  for (const entry of entries ?? []) {
    if (typeof entry?.target !== "string" || !Number.isFinite(entry.availableBytes)) continue;
    const kept = (Array.isArray(next[entry.target]) ? next[entry.target] : [])
      .filter((sample) => Number.isFinite(Date.parse(sample.at)) && Date.parse(sample.at) >= cutoff && sample.at.slice(0, 10) !== today);
    kept.push({ at, availableBytes: entry.availableBytes, totalBytes: Number.isFinite(entry.totalBytes) ? entry.totalBytes : null });
    next[entry.target] = kept.slice(-maxDays);
  }
  return next;
}

/**
 * Days until free space reaches zero at the recent fill rate, or null when it is not filling (or
 * there is not enough spread of data to say). A least-squares line through free-space over time.
 */
export function projectDaysToFull(samples, { now, minSamples = 3, minSpanDays = 2, windowDays = 21 } = {}) {
  const at = now instanceof Date ? now.getTime() : Number(now);
  const recent = (Array.isArray(samples) ? samples : [])
    .filter((sample) => Number.isFinite(Date.parse(sample?.at)) && Number.isFinite(sample?.availableBytes) && at - Date.parse(sample.at) <= windowDays * DAY_MS)
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  if (recent.length < minSamples) return null;
  const first = Date.parse(recent[0].at);
  const last = Date.parse(recent[recent.length - 1].at);
  if ((last - first) / DAY_MS < minSpanDays) return null;
  const xs = recent.map((sample) => (Date.parse(sample.at) - first) / DAY_MS);
  const ys = recent.map((sample) => sample.availableBytes);
  const n = xs.length;
  const meanX = xs.reduce((sum, value) => sum + value, 0) / n;
  const meanY = ys.reduce((sum, value) => sum + value, 0) / n;
  let numerator = 0;
  let denominator = 0;
  for (let index = 0; index < n; index += 1) {
    numerator += (xs[index] - meanX) * (ys[index] - meanY);
    denominator += (xs[index] - meanX) ** 2;
  }
  if (denominator === 0) return null;
  const slopePerDay = numerator / denominator; // bytes/day; negative means filling
  if (slopePerDay >= 0) return null; // holding steady or freeing up
  const availableNow = ys[ys.length - 1] + slopePerDay * ((at - last) / DAY_MS);
  if (availableNow <= 0) return 0;
  return availableNow / -slopePerDay;
}

/** Alerts for mounts projected to fill within `warnWithinDays`. Same shape as the health checks. */
export function evaluateDiskForecast(history, { now, warnWithinDays = 14 } = {}) {
  const alerts = [];
  for (const [target, samples] of Object.entries(history ?? {})) {
    const days = projectDaysToFull(samples, { now });
    if (days === null || days > warnWithinDays) continue;
    const rounded = Math.max(0, Math.round(days));
    alerts.push({
      key: `storage.forecast:${target}`,
      priority: days <= 3 ? "high" : "default",
      title: rounded <= 0 ? `${target} is about to run out of space` : `${target} will fill in about ${rounded} day${rounded === 1 ? "" : "s"}`,
      message: `At the recent rate, ${target} runs out of free space in roughly ${rounded} day${rounded === 1 ? "" : "s"}. Clear space or add storage before then — Housekeeping on the System page finds what nothing needs any more.`,
    });
  }
  return alerts;
}

/** The mounts worth tracking from an inventory snapshot: the root and every real filesystem. */
export function forecastEntriesFromInventory(inventory) {
  const entries = [];
  const mounts = inventory?.storage?.filesystems?.mounts ?? [];
  const seen = new Set();
  for (const mount of mounts) {
    if (typeof mount?.target !== "string" || !Number.isFinite(mount.availableBytes)) continue;
    if (mount.readOnly) continue; // a read-only mount never fills
    entries.push({ target: mount.target, availableBytes: mount.availableBytes, totalBytes: mount.totalBytes ?? null });
    seen.add(mount.target);
  }
  const root = inventory?.storage?.root;
  if (root && Number.isFinite(root.freeBytes) && !seen.has("/")) entries.push({ target: "/", availableBytes: root.freeBytes, totalBytes: root.totalBytes ?? null });
  return entries;
}

/** Background sampler: once a day, record free space per mount so the forecast has something to fit. */
export function createDiskSampler({ inventory, store, now = () => new Date(), intervalMs = 6 * 60 * 60 * 1000, initialDelayMs = 4 * 60 * 1000, maxDays = 30, setInterval: schedule = globalThis.setInterval, setTimeout: delay = globalThis.setTimeout, clearInterval: unschedule = globalThis.clearInterval, clearTimeout: cancel = globalThis.clearTimeout } = {}) {
  async function sample() {
    const snapshot = await inventory.inspect();
    const entries = forecastEntriesFromInventory(snapshot);
    if (!entries.length) return { sampled: 0 };
    const history = store.getSetting("diskUsageHistory", {}) ?? {};
    const next = appendSample(history, { at: now().toISOString(), entries }, { maxDays });
    store.setSetting("diskUsageHistory", next, { updatedBy: null });
    return { sampled: entries.length };
  }
  function start() {
    const safeSample = () => sample().catch(() => {});
    const first = delay(safeSample, initialDelayMs);
    first.unref?.();
    const timer = schedule(safeSample, intervalMs);
    timer.unref?.();
    return () => { cancel(first); unschedule(timer); };
  }
  return { sample, start };
}
