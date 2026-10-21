import { useEffect, useState } from "react";
import { readJson } from "../../http";
import { Panel, Sparkline, StatusChip, Table, type Status, type TableColumn } from "../../ui";

/*
 * Drive health over time (M31.2): the SMART figures the daily sampler keeps (server/smart-trends.mjs),
 * one row a drive. Temperature is drawn as a line; wear and media errors are said with how far they
 * moved, since a climbing error count is the warning sign and the alert already names it.
 */

export interface SmartSample { at: string; temperatureCelsius: number | null; percentageUsed: number | null; mediaErrors: number | null }
export interface SmartTrend { device: string; samples: SmartSample[]; days: number; wearChange: number | null; errorChange: number | null }

const latest = (samples: SmartSample[], key: keyof Omit<SmartSample, "at">) => [...samples].reverse().find((sample) => sample[key] !== null)?.[key] ?? null;
const span = (days: number) => (days <= 0 ? "today" : `${days} day${days === 1 ? "" : "s"}`);

/** Wear in words: where it is, and how far it moved across the days recorded. */
export function wearWords(trend: SmartTrend): string {
  const now = latest(trend.samples, "percentageUsed");
  if (now === null) return "—";
  if (trend.wearChange === null || trend.days <= 0) return `${now}%`;
  return trend.wearChange > 0 ? `${now}%, up ${trend.wearChange} in ${span(trend.days)}` : `${now}%, steady`;
}

/** Media errors in words, and whether they say the drive is failing: any rise is. */
export function errorWords(trend: SmartTrend): { text: string; status: Status } {
  const now = latest(trend.samples, "mediaErrors");
  if (now === null) return { text: "—", status: "neutral" };
  if (trend.errorChange !== null && trend.errorChange > 0) return { text: `${now}, up ${trend.errorChange} in ${span(trend.days)}`, status: "danger" };
  return { text: now === 0 ? "none" : `${now}, not rising`, status: now === 0 ? "good" : "warning" };
}

export function DriveHealthPanel() {
  const [disks, setDisks] = useState<SmartTrend[] | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    fetch("/api/v1/storage/smart-history").then((response) => readJson<{ disks?: SmartTrend[] }>(response))
      .then((body) => { if (live) { setDisks(Array.isArray(body?.disks) ? body.disks : []); setFailed(false); } })
      .catch(() => { if (live) setFailed(true); });
    return () => { live = false; };
  }, []);

  const columns: Array<TableColumn<SmartTrend>> = [
    { id: "drive", header: "Drive", cell: (disk) => <code>{disk.device.replace(/^\/dev\//, "")}</code> },
    { id: "temp", header: "Temperature", cell: (disk) => {
      const now = latest(disk.samples, "temperatureCelsius");
      return <span className="storage-trend">{now === null ? "—" : `${now}°C`} <Sparkline values={disk.samples.map((sample) => sample.temperatureCelsius)} floor={10} /></span>;
    } },
    { id: "wear", header: "Wear", cell: (disk) => wearWords(disk) },
    { id: "errors", header: "Media errors", cell: (disk) => { const words = errorWords(disk); return <StatusChip status={words.status}>{words.text}</StatusChip>; } },
    { id: "days", header: "Recorded", numeric: true, hideOnPhone: true, cell: (disk) => span(disk.days) },
  ];

  return (
    <Panel title="Drive health over time" count={disks ? disks.length : undefined} meta={<>SMART, read once a day · the last 45 days</>}>
      <Table
        caption="Each drive's SMART readings over time"
        columns={columns}
        rows={disks ?? []}
        rowKey={(disk) => disk.device}
        rowStatus={(disk) => (errorWords(disk).status === "danger" ? "danger" : undefined)}
        empty={failed ? "The drive history could not be read." : disks === null ? "Reading the drive history…" : "No readings yet. SMART is read once a day, so the first appears within a day of setting up smartmontools."}
      />
    </Panel>
  );
}
