import { buildStorageMap, type MapApp, type MapSambaShare, type StorageMapEntry } from "../../storageMap";
import { connectPaths } from "../../sharePaths";
import { EmptyState, Panel, StatusChip, Table, Tag, type TableColumn } from "../../ui";
import { CopyLines, UsageMeter } from "./parts";
import { gib, managedMounts, percentUsed, type Forecast, type LastMeasured, type MountRow, type StorageReport, type Usage } from "./types";

/*
 * Mounts (M33.9): where the data lives and how much room is left. What is filling up first, with
 * the folder that is filling it; then each place data lives with the apps that use it and how it is
 * shared; then every mounted filesystem with its use.
 */

export interface MountsTabProps {
  report: StorageReport | null;
  loading: boolean;
  forecasts: Forecast[];
  usage: Usage[];
  lastMeasured: LastMeasured | null;
  mapApps: MapApp[];
  mapShares: MapSambaShare[];
  /** The address other computers use to reach this server's shares, when Samba says. */
  shareHost: string | null;
}

/** Whether the sizes on the map can be trusted, in a few words. */
function measured(lastMeasured: LastMeasured | null) {
  if (!lastMeasured) return null;
  if (lastMeasured.deferred) return `measurement deferred: ${lastMeasured.deferred}; retried in 30 minutes`;
  if (lastMeasured.error) return `sizes out of date: ${new Date(lastMeasured.at).toLocaleDateString()} failed (${lastMeasured.error})`;
  return `sizes measured ${new Date(lastMeasured.at).toLocaleDateString()}${lastMeasured.unmeasured > 0 ? `; ${lastMeasured.unmeasured} folder${lastMeasured.unmeasured === 1 ? "" : "s"} not measured` : ""}`;
}

function PlaceCard({ entry, shareHost }: { entry: StorageMapEntry; shareHost: string | null }) {
  const counted = new Set<string>();
  return (
    <article className="storage-place" aria-label={entry.label}>
      <header className="storage-place__head">
        <code className="storage-name__main">{entry.label}</code>
        <span className="storage-name__sub">{entry.kind === "network" ? `network share · ${entry.source}` : entry.kind === "drive" ? `${entry.fstype ?? "drive"} · ${entry.source}` : "everything not on a mounted drive"}</span>
      </header>
      {entry.sizeBytes && entry.availableBytes !== null
        ? <UsageMeter used={entry.sizeBytes - entry.availableBytes} size={entry.sizeBytes} label={entry.label} />
        : null}
      {entry.daysToFull !== null && entry.daysToFull <= 90 && <span className="storage-place__fills ui-marked" data-status={entry.daysToFull <= 14 ? "warning" : "neutral"}><span className="ui-mark" aria-hidden="true" />fills in ~{entry.daysToFull} days</span>}
      <dl className="storage-place__facts">
        <div>
          <dt>Apps</dt>
          <dd>
            {entry.apps.length ? entry.apps.map((app) => {
              // Several apps can mount one folder (the download client writes where the library
              // reads). Its size belongs to the folder, so it is shown once; the others say whose.
              const first = !counted.has(app.path);
              counted.add(app.path);
              const sharedWith = entry.apps.filter((other) => other.path === app.path && other.id !== app.id);
              return (
                <Tag key={app.id + app.path} title={sharedWith.length ? `${app.path}, shared with ${sharedWith.map((other) => other.name).join(", ")}` : app.path}>
                  {app.name}{app.bytes !== null ? (first ? ` · ${gib(app.bytes)}` : " · same folder") : ""}
                </Tag>
              );
            }) : <span className="storage-dim">none yet</span>}
          </dd>
        </div>
        <div>
          <dt>Shared as</dt>
          <dd>{entry.shares.length ? entry.shares.map((share) => <Tag key={share.name}>{share.name}{share.recycle ? " · recycle bin" : ""}</Tag>) : <span className="storage-dim">not shared</span>}</dd>
        </div>
      </dl>
      {entry.shares.length > 0 && shareHost && (
        <details className="storage-disclose">
          <summary>How to open {entry.shares.length === 1 ? "it" : "these"} from another computer</summary>
          {entry.shares.map((share) => <CopyLines key={share.name} subject={share.name} lines={connectPaths({ host: shareHost, share: share.name })} />)}
        </details>
      )}
    </article>
  );
}

export default function MountsTab({ report, loading, forecasts, usage, lastMeasured, mapApps, mapShares, shareHost }: MountsTabProps) {
  const managed = managedMounts(report);
  const filling = forecasts.filter((forecast) => forecast.daysToFull <= 90).sort((left, right) => left.daysToFull - right.daysToFull);
  const map = report ? buildStorageMap({ mounts: report.mounts, sambaShares: mapShares, apps: mapApps, forecasts, usage, networkTargets: report.shares.map((entry) => entry.mountpoint) }) : [];
  const appName = (id: string | null) => mapApps.find((app) => app.id === id)?.name ?? id ?? "Unknown";

  const columns: Array<TableColumn<MountRow>> = [
    {
      id: "target", header: "Mounted at", sortValue: (mount) => mount.target, cell: (mount) => (
        <span className="storage-name__line"><code className="storage-name__main">{mount.target}</code>{managed.has(mount.target) && <Tag>managed</Tag>}</span>
      ),
    },
    { id: "source", header: "Device", cell: (mount) => <code className="storage-wrap">{mount.source}</code> },
    { id: "type", header: "Type", sortValue: (mount) => mount.fstype, cell: (mount) => mount.fstype },
    { id: "used", header: "Used", sortValue: (mount) => percentUsed(mount.usedBytes, mount.sizeBytes), cell: (mount) => <UsageMeter used={mount.usedBytes} size={mount.sizeBytes} label={mount.target} /> },
    { id: "free", header: "Free", numeric: true, hideOnPhone: true, sortValue: (mount) => mount.availableBytes, cell: (mount) => gib(mount.availableBytes) },
  ];

  return (
    <>
      {filling.length > 0 && (
        <Panel title="Filling up" count={{ status: filling.some((forecast) => forecast.daysToFull <= 14) ? "warning" : "neutral", label: filling.length }} meta="at the rate free space has been dropping">
          <ul className="storage-rows">
            {filling.map((forecast) => {
              // Which app is filling it: a drive that fills in nine days is a problem; the downloads
              // folder that grew 240 GB this week is something to act on. Only folders that grew.
              const growing = usage.filter((entry) => entry.mount === forecast.target && (entry.grewBytes ?? 0) > 0).filter((entry, index, entries) => !entry.sharedWith?.length || entries.findIndex((other) => other.path === entry.path) === index);
              return (
                <li key={forecast.target} className="storage-rows__item storage-rows__item--stack">
                  <span className="storage-name__line">
                    <code className="storage-name__main">{forecast.target}</code>
                    {forecast.availableBytes !== null && <span className="storage-dim">{gib(forecast.availableBytes)} free now</span>}
                    <StatusChip status={forecast.daysToFull <= 14 ? "warning" : "neutral"} className="storage-push">{forecast.daysToFull <= 0 ? "full very soon" : `~${forecast.daysToFull} day${forecast.daysToFull === 1 ? "" : "s"} left`}</StatusChip>
                  </span>
                  {growing.length > 0 && (
                    <ul className="storage-blame">
                      {growing.map((entry) => (
                        <li key={`${entry.appId}:${entry.path}`}>
                          {entry.sharedWith?.length ? <>Shared folder used by <strong>{entry.sharedWith.map((id) => appName(id)).join(", ")}</strong></> : <><strong>{appName(entry.appId)}</strong>'s folder</>} grew <strong>{gib(entry.grewBytes ?? 0)}</strong>
                          {entry.days >= 1 ? ` in the last ${Math.round(entry.days)} day${Math.round(entry.days) === 1 ? "" : "s"}` : ""}
                          {" · "}<code>{entry.path}</code> holds {gib(entry.bytes)}
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              );
            })}
          </ul>
        </Panel>
      )}

      {map.length > 0 && (
        <Panel title="Where data lives" count={map.length} meta={measured(lastMeasured) ?? undefined} label="Where data lives: each place, what uses it and how it is shared">
          <div className="storage-places">
            {map.map((entry) => <PlaceCard key={entry.id} entry={entry} shareHost={shareHost} />)}
          </div>
        </Panel>
      )}

      <Panel title="Mounted filesystems" count={report ? report.mounts.length : undefined} meta={report ? <><b>{managed.size}</b> added by BoxPilot · the rest stay yours</> : undefined}>
        <Table
          caption="Mounted filesystems"
          columns={columns}
          rows={report?.mounts ?? []}
          rowKey={(mount) => mount.target}
          rowStatus={(mount) => ((percentUsed(mount.usedBytes, mount.sizeBytes) ?? 0) >= 90 ? "danger" : undefined)}
          empty={!report ? (loading ? "Reading the mounts…" : "The mounts could not be read.") : <EmptyState title="Nothing mounted" />}
        />
      </Panel>
    </>
  );
}
