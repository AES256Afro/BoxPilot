import { Panel, Sparkline } from "../../ui";
import { gib, type Usage } from "./types";

/*
 * Where the space went (M31.4): the app-data sampler's daily sizes as a line per folder, so a
 * download folder growing 240 GB a week is a slope the owner can see, not only the sentence under
 * "Filling up". The folders that grew most across the days recorded, a shared folder once.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

export interface Grower { usage: Usage; grewBytes: number; days: number }

/** The folders that grew most across their recorded days, biggest first; shrinking and flat ones are left out. */
export function topGrowers(usage: Usage[], limit = 8): Grower[] {
  const seen = new Set<string>();
  const rows: Grower[] = [];
  for (const entry of usage) {
    const series = entry.series ?? [];
    if (series.length < 2) continue;
    const key = entry.sharedWith?.length ? `path:${entry.path}` : `${entry.appId}:${entry.path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const grewBytes = series[series.length - 1].bytes - series[0].bytes;
    if (grewBytes <= 0) continue;
    rows.push({ usage: entry, grewBytes, days: Math.max(1, Math.round((Date.parse(series[series.length - 1].at) - Date.parse(series[0].at)) / DAY_MS)) });
  }
  return rows.sort((left, right) => right.grewBytes - left.grewBytes).slice(0, limit);
}

export function SpaceOverTime({ usage, appName }: { usage: Usage[]; appName: (id: string | null) => string }) {
  const growers = topGrowers(usage);
  if (!growers.length) return null;
  return (
    <Panel title="Where the space went" count={growers.length} meta="each folder's size, read once a day · the last 30 days">
      <ul className="storage-rows storage-growth">
        {growers.map(({ usage: entry, grewBytes, days }) => (
          <li key={`${entry.appId}:${entry.path}`} className="storage-rows__item">
            <span className="storage-growth__who">
              <strong>{entry.sharedWith?.length ? entry.sharedWith.map((id) => appName(id)).join(", ") : appName(entry.appId)}</strong>
              <code className="storage-dim">{entry.path}</code>
            </span>
            {/* Bytes, not GiB: a line over the folder's own range, so a steady climb is a steady slope. */}
            <Sparkline values={(entry.series ?? []).map((sample) => sample.bytes)} />
            <span className="storage-growth__figure">grew <strong>{gib(grewBytes)}</strong> in {days} day{days === 1 ? "" : "s"} · holds {gib(entry.bytes)}</span>
          </li>
        ))}
      </ul>
    </Panel>
  );
}
