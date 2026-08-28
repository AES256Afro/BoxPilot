/**
 * Catch a drive that is going bad before it fails outright (M23.3).
 *
 * The health check already alerts when SMART says a disk is failing. But a disk usually degrades
 * first: its media-error count climbs, or an SSD approaches the write-endurance it is rated for,
 * while smartctl still reports "healthy". This keeps a small daily history of the numbers that move
 * and alerts on the movement — errors that are climbing, or wear on track to reach the limit — so
 * there is time to copy data off and order a replacement. Pure and clock-injected; a sampler feeds it.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const WEAR_WARN_DAYS = 180; // an SSD projected to hit its endurance limit within six months
const WEAR_WARN_PERCENT = 90; // or one already this far through its rated writes

/** The trendable numbers for each disk in an inventory snapshot. */
export function smartEntriesFromInventory(inventory) {
  const disks = inventory?.storage?.smart?.disks ?? [];
  return disks
    .filter((disk) => typeof disk?.device === "string" && disk.health !== "unavailable")
    .map((disk) => ({
      device: disk.device,
      mediaErrors: Number.isFinite(disk.mediaErrors) ? disk.mediaErrors : null,
      percentageUsed: Number.isFinite(disk.percentageUsed) ? disk.percentageUsed : null,
      temperatureCelsius: Number.isFinite(disk.temperatureCelsius) ? disk.temperatureCelsius : null,
    }));
}

/** Append today's readings, one sample per calendar day per device, pruning beyond `maxDays`. Pure. */
export function appendSmartSample(history, { at, entries }, { maxDays = 45 } = {}) {
  const next = { ...(history && typeof history === "object" ? history : {}) };
  const today = at.slice(0, 10);
  const cutoff = Date.parse(at) - maxDays * DAY_MS;
  for (const entry of entries ?? []) {
    if (typeof entry?.device !== "string") continue;
    const kept = (Array.isArray(next[entry.device]) ? next[entry.device] : [])
      .filter((sample) => Number.isFinite(Date.parse(sample.at)) && Date.parse(sample.at) >= cutoff && sample.at.slice(0, 10) !== today);
    kept.push({ at, mediaErrors: entry.mediaErrors, percentageUsed: entry.percentageUsed, temperatureCelsius: entry.temperatureCelsius });
    next[entry.device] = kept.slice(-maxDays);
  }
  return next;
}

/** Least-squares change-per-day of a numeric field across samples, or null if too little data. */
function slopePerDay(samples, key, { now, minSamples = 3, minSpanDays = 2, windowDays = 30 }) {
  const at = now instanceof Date ? now.getTime() : Number(now);
  const points = (Array.isArray(samples) ? samples : [])
    .filter((sample) => Number.isFinite(sample?.[key]) && Number.isFinite(Date.parse(sample?.at)) && at - Date.parse(sample.at) <= windowDays * DAY_MS)
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  if (points.length < minSamples) return null;
  const first = Date.parse(points[0].at);
  const last = Date.parse(points[points.length - 1].at);
  if ((last - first) / DAY_MS < minSpanDays) return null;
  const xs = points.map((sample) => (Date.parse(sample.at) - first) / DAY_MS);
  const ys = points.map((sample) => sample[key]);
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
  return { slope: numerator / denominator, latest: ys[ys.length - 1], first: ys[0], daysSinceLast: (at - last) / DAY_MS };
}

/** Alerts for disks whose SMART numbers are trending toward failure. Same shape as the health checks. */
export function evaluateSmartTrends(history, { now } = {}) {
  const alerts = [];
  for (const [device, samples] of Object.entries(history ?? {})) {
    // Media errors climbing: any increase, while non-zero, is a disk actively developing faults.
    const errorTrend = slopePerDay(samples, "mediaErrors", { now });
    if (errorTrend && errorTrend.latest > 0 && errorTrend.latest > errorTrend.first) {
      alerts.push({
        key: `smart.errors:${device}`,
        priority: "high",
        title: `${device} is developing errors`,
        message: `Its media-error count has climbed to ${errorTrend.latest} (was ${errorTrend.first} a few weeks ago). A drive whose errors are rising is starting to fail — copy anything important off it and plan a replacement.`,
      });
    }
    // SSD wear approaching the rated endurance, either already high or projected there soon.
    const wearTrend = slopePerDay(samples, "percentageUsed", { now });
    if (wearTrend) {
      const wearNow = wearTrend.latest + (wearTrend.slope > 0 ? wearTrend.slope * wearTrend.daysSinceLast : 0);
      const daysToLimit = wearTrend.slope > 0 ? (100 - wearNow) / wearTrend.slope : Infinity;
      if (wearNow >= WEAR_WARN_PERCENT || daysToLimit <= WEAR_WARN_DAYS) {
        const months = Number.isFinite(daysToLimit) ? Math.max(0, Math.round(daysToLimit / 30)) : null;
        alerts.push({
          key: `smart.wear:${device}`,
          priority: wearNow >= 95 ? "high" : "default",
          title: `${device} is wearing out`,
          message: `This SSD has used about ${Math.round(wearNow)}% of its rated write endurance${months !== null ? `, on track to reach the limit in roughly ${months} month${months === 1 ? "" : "s"}` : ""}. Plan a replacement before it becomes read-only or unreliable.`,
        });
      }
    }
  }
  return alerts;
}

/** Background sampler: once a day, record SMART numbers so the trends have something to fit. */
export function createSmartSampler({ inventory, store, now = () => new Date(), intervalMs = 6 * 60 * 60 * 1000, initialDelayMs = 6 * 60 * 1000, maxDays = 45, setInterval: schedule = globalThis.setInterval, setTimeout: delay = globalThis.setTimeout, clearInterval: unschedule = globalThis.clearInterval, clearTimeout: cancel = globalThis.clearTimeout } = {}) {
  async function sample() {
    const snapshot = await inventory.inspect();
    const entries = smartEntriesFromInventory(snapshot);
    if (!entries.length) return { sampled: 0 };
    const history = store.getSetting("smartHistory", {}) ?? {};
    store.setSetting("smartHistory", appendSmartSample(history, { at: now().toISOString(), entries }, { maxDays }), { updatedBy: null });
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
