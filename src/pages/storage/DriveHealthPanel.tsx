import { useEffect, useState } from "react";
import { readJson } from "../../http";
import { Panel, Sparkline, StatusChip, Table, type Status, type TableColumn } from "../../ui";
import { healthChip, reportsPassFailOnly, type DriveHealth } from "./types";

/*
 * Drive health over time (M31.2): the SMART figures the daily sampler keeps (server/smart-trends.mjs),
 * one row a drive. Temperature is drawn as a line; wear and media errors are said with how far they
 * moved, since a climbing error count is the warning sign and the alert already names it. Each row
 * carries the drive's health as the storage scan last read it (M91), so a drive whose SMART says
 * FAILED is red here whether or not its numbers moved, and a SATA disk's bad sectors are named by kind.
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

/** A SATA disk's bad sectors by kind, for under its error count: what could not be read, and what was remapped. */
function badSectorWords(disk: DriveHealth | undefined): string | null {
  const ata = disk?.ataErrors;
  if (!ata) return null;
  // A count the drive names as something else (an MX500's 197) is not a bad sector.
  const count = (field: "reallocated" | "reportedUncorrectable" | "pending" | "offlineUncorrectable") => (ata.notSectorCounts?.includes(field) ? 0 : ata[field] ?? 0);
  return `${count("pending") + count("offlineUncorrectable") + count("reportedUncorrectable")} unreadable · ${count("reallocated")} remapped`;
}

/**
 * Errors in words, and whether they say the drive is failing: any rise is. For a SATA disk the count
 * is its bad sectors. A drive that reports only SMART's pass or fail says so, rather than promising
 * a figure that never comes.
 */
export function errorWords(trend: SmartTrend, current?: DriveHealth): { text: string; status: Status } {
  const now = latest(trend.samples, "mediaErrors") ?? current?.mediaErrors ?? null;
  if (now === null) return current && reportsPassFailOnly(current) ? { text: "reports pass/fail only", status: "neutral" } : { text: "—", status: "neutral" };
  if (trend.errorChange !== null && trend.errorChange > 0) return { text: `${now}, up ${trend.errorChange} in ${span(trend.days)}`, status: "danger" };
  return { text: now === 0 ? "none" : `${now}, not rising`, status: now === 0 ? "good" : "warning" };
}

interface Row extends SmartTrend { current?: DriveHealth }

/** The sampler's history and the latest reading, one row a drive: a drive read today but not yet sampled is listed too. */
function rowsOf(trends: SmartTrend[], health: DriveHealth[]): Row[] {
  const byDevice = new Map(health.map((disk) => [disk.device, disk]));
  const rows: Row[] = trends.map((trend) => ({ ...trend, current: byDevice.get(trend.device) }));
  for (const disk of health) {
    if (!rows.some((row) => row.device === disk.device)) rows.push({ device: disk.device, samples: [], days: 0, wearChange: null, errorChange: null, current: disk });
  }
  return rows.sort((left, right) => left.device.localeCompare(right.device));
}

export interface DriveHealthPanelProps {
  /** Each drive's health as the storage scan last read it. */
  health?: DriveHealth[];
  /** The mounts BoxPilot made on a disk, so "backup" is found by its device name. */
  mountsOf?: (device: string) => string[];
}

export function DriveHealthPanel({ health = [], mountsOf = () => [] }: DriveHealthPanelProps = {}) {
  const [disks, setDisks] = useState<SmartTrend[] | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    fetch("/api/v1/storage/smart-history").then((response) => readJson<{ disks?: SmartTrend[] }>(response))
      .then((body) => { if (live) { setDisks(Array.isArray(body?.disks) ? body.disks : []); setFailed(false); } })
      .catch(() => { if (live) setFailed(true); });
    return () => { live = false; };
  }, []);

  const columns: Array<TableColumn<Row>> = [
    { id: "drive", header: "Drive", cell: (disk) => {
      const mounts = mountsOf(disk.device);
      return <span className="storage-name"><code className="storage-name__main">{disk.device.replace(/^\/dev\//, "")}</code>{mounts.length > 0 && <span className="storage-name__sub">{mounts.join(", ")}</span>}</span>;
    } },
    { id: "health", header: "Health", cell: (disk) => {
      if (!disk.current) return <span className="storage-dim">—</span>;
      const chip = healthChip(disk.current);
      return <StatusChip status={chip.status}>{chip.label}</StatusChip>;
    } },
    { id: "temp", header: "Temperature", cell: (disk) => {
      const now = latest(disk.samples, "temperatureCelsius") ?? disk.current?.temperatureCelsius ?? null;
      return <span className="storage-trend">{now === null ? "—" : `${now}°C`} <Sparkline values={disk.samples.map((sample) => sample.temperatureCelsius)} floor={10} /></span>;
    } },
    { id: "wear", header: "Wear", cell: (disk) => (disk.samples.length === 0 && disk.current?.percentageUsed != null ? `${disk.current.percentageUsed}%` : wearWords(disk)) },
    { id: "errors", header: "Errors", cell: (disk) => {
      const words = errorWords(disk, disk.current);
      const sectors = badSectorWords(disk.current);
      return <span className="storage-name"><StatusChip status={words.status}>{words.text}</StatusChip>{sectors && <span className="storage-name__sub">{sectors}</span>}</span>;
    } },
    { id: "days", header: "Recorded", numeric: true, hideOnPhone: true, cell: (disk) => (disk.samples.length ? span(disk.days) : <span className="storage-dim">not yet</span>) },
  ];

  const rows = rowsOf(disks ?? [], health);
  return (
    <Panel title="Drive health over time" count={disks || health.length ? rows.length : undefined} meta={<>SMART, read once a day · the last 45 days</>}>
      <Table
        caption="Each drive's SMART readings over time"
        columns={columns}
        rows={rows}
        rowKey={(disk) => disk.device}
        rowStatus={(disk) => {
          const chip = disk.current ? healthChip(disk.current).status : undefined;
          return errorWords(disk, disk.current).status === "danger" || chip === "danger" ? "danger" : chip === "warning" ? "warning" : undefined;
        }}
        empty={failed ? "The drive history could not be read." : disks === null ? "Reading the drive history…" : "No readings yet. Each drive is listed once the storage scan has read its SMART health, which needs smartmontools."}
      />
    </Panel>
  );
}
