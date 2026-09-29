import { useCallback, useEffect, useState } from "react";
import { useAutoReconnect } from "../../AutoReconnect";
import type { ViewName } from "../../data";
import { readJson } from "../../http";
import { appFolders, type MapApp, type MapSambaShare } from "../../storageMap";
import { useTailnetHosts } from "../../tailnetHosts";
import { Button, Notice, PageHeader, Tabs, useUrlParam, type Status, type TabItem } from "../../ui";
import DrivesTab from "./DrivesTab";
import FileSharingTab from "./FileSharingTab";
import MountsTab from "./MountsTab";
import SharesTab from "./SharesTab";
import SnapshotsTab from "./SnapshotsTab";
import { gib, percentUsed, shareableFolders, type Forecast, type FsSnapshots, type LastMeasured, type StorageReport, type Usage } from "./types";
import { useNfs, useSamba } from "./useSharing";
import "./storage.css";

/*
 * Storage (M33.9), rebuilt on the kit in the console's look with every feature the Classic page
 * had. Facts first: whether anything is filling up, then the disks, mounts, shares and free LVM
 * space in mono, then the tabs by what the owner does: the drives BoxPilot mounted and every disk
 * (Drives), folders mounted from a NAS (Shares), this server's own file servers (File sharing),
 * restore points (Snapshots), and where the data lives and how full it is (Mounts). Long forms are
 * sheets; what the page is for is behind the header's info toggle.
 */

export interface StoragePageProps {
  csrfToken: string;
  /** Who is signed in: the actions a role cannot start are left out (docs/UI-PAGES.md). */
  role?: string;
  onNavigate?: (view: ViewName) => void;
}

type TabId = "drives" | "shares" | "sharing" | "snapshots" | "mounts";
const tabIds: readonly TabId[] = ["drives", "shares", "sharing", "snapshots", "mounts"];

export default function StoragePage({ csrfToken, role = "owner", onNavigate }: StoragePageProps) {
  const [tab, setTab] = useUrlParam<TabId>("tab", tabIds, "drives");
  const [report, setReport] = useState<StorageReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [forecasts, setForecasts] = useState<Forecast[]>([]);
  const [usage, setUsage] = useState<Usage[]>([]);
  const [lastMeasured, setLastMeasured] = useState<LastMeasured | null>(null);
  const [mapApps, setMapApps] = useState<MapApp[]>([]);
  const [fsSnapshots, setFsSnapshots] = useState<FsSnapshots | null>(null);
  const [sharePrefill, setSharePrefill] = useState<{ name: string; path: string; key: number } | null>(null);
  const tailnetHosts = useTailnetHosts();
  const samba = useSamba(csrfToken);
  const nfs = useNfs();
  const autoReconnect = useAutoReconnect(csrfToken);

  const readOverview = useCallback(async () => {
    setLoading(true);
    try {
      setReport(await readJson<StorageReport>(await fetch("/api/v1/storage/overview")));
      setError(null);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "The storage state could not be read");
    } finally {
      setLoading(false);
    }
  }, []);
  // What the map and the forecasts add; each on its own, so one that fails costs only itself.
  const readExtras = useCallback(() => {
    fetch("/api/v1/storage/forecast").then((response) => (response.ok ? response.json() : {})).then((body: { forecasts?: Forecast[]; usage?: Usage[]; lastMeasured?: LastMeasured | null }) => { setForecasts(body.forecasts ?? []); setUsage(body.usage ?? []); setLastMeasured(body.lastMeasured ?? null); }).catch(() => {});
    fetch("/api/v1/catalog?view=summary").then((response) => (response.ok ? response.json() : null)).then((body: { applications?: Parameters<typeof appFolders>[0] } | null) => setMapApps(body?.applications ? appFolders(body.applications) : [])).catch(() => {});
    fetch("/api/v1/operations/storage.fs-snapshots.inspect/inspect").then((response) => (response.ok ? response.json() : null)).then((body: { result?: FsSnapshots } | null) => setFsSnapshots(body?.result ?? null)).catch(() => {});
  }, []);
  useEffect(() => { void readOverview(); readExtras(); }, [readOverview, readExtras]);

  const { refresh: refreshSamba } = samba;
  const { refresh: refreshNfs } = nfs;
  const { refresh: refreshReconnect } = autoReconnect;
  const refreshAll = useCallback(() => {
    void readOverview();
    readExtras();
    void refreshSamba();
    void refreshNfs();
    void refreshReconnect();
  }, [readOverview, readExtras, refreshSamba, refreshNfs, refreshReconnect]);

  const mapShares: MapSambaShare[] = samba.state?.config?.shares ?? [];
  const shareHost = samba.state ? (samba.state.config?.scope === "lan" ? samba.state.lanAddress ?? samba.state.tailscaleDnsName : samba.state.tailscaleDnsName ?? samba.state.lanAddress) ?? null : null;

  const disks = (report?.devices ?? []).filter((device) => device.type === "disk");
  const mounts = report?.mounts ?? [];
  const shares = report?.shares ?? [];
  const full = mounts.filter((mount) => (percentUsed(mount.usedBytes, mount.sizeBytes) ?? 0) >= 90);
  const soon = forecasts.filter((forecast) => forecast.daysToFull <= 14).sort((left, right) => left.daysToFull - right.daysToFull);
  const dropped = shares.filter((entry) => !entry.mounted && !entry.automount);
  const unallocated = (report?.volumeGroups ?? []).reduce((sum, group) => sum + group.freeBytes, 0);
  const lvmSnapshots = report?.snapshots?.length ?? 0;
  const fsSnapshotCount = fsSnapshots?.supported ? (fsSnapshots.btrfs?.filesystems ?? []).reduce((sum, entry) => sum + entry.snapshots.length, 0) + (fsSnapshots.zfs?.datasets ?? []).reduce((sum, entry) => sum + entry.snapshots.length, 0) : 0;

  // Never green about something unread (M28.5): no report, no verdict.
  const verdict: { status: Status; label: string } = error && !report ? { status: "unknown", label: "Not read" }
    : !report ? { status: "unknown", label: "Reading…" }
      : full.length ? { status: "danger", label: `${full.length} nearly full` }
        : soon.length ? { status: "warning", label: soon[0].daysToFull <= 0 ? "Full very soon" : `Fills in ~${soon[0].daysToFull} days` }
          : dropped.length ? { status: "warning", label: `${dropped.length} share${dropped.length === 1 ? "" : "s"} not connected` }
            : { status: "good", label: "Room to spare" };

  const sambaStatus: Status | undefined = samba.state?.installed && samba.state.configured && samba.state.running === false ? "warning" : undefined;
  const tabs: Array<TabItem<TabId>> = [
    { id: "drives", label: "Drives", count: report ? disks.length : undefined },
    { id: "shares", label: "Shares", count: report ? shares.length : undefined, status: dropped.length ? "warning" : undefined, statusLabel: dropped.length ? `${dropped.length} not connected` : undefined },
    { id: "sharing", label: "File sharing", count: samba.state || nfs.state ? (samba.state?.config?.shares.length ?? 0) + (nfs.state?.config?.exports.length ?? 0) : undefined, status: sambaStatus, statusLabel: sambaStatus ? "Samba is stopped" : undefined },
    { id: "snapshots", label: "Snapshots", count: report ? lvmSnapshots + fsSnapshotCount : undefined },
    { id: "mounts", label: "Mounts", count: report ? mounts.length : undefined, status: full.length ? "danger" : soon.length ? "warning" : undefined, statusLabel: full.length ? `${full.length} nearly full` : soon.length ? "filling up" : undefined },
  ];

  const shareFolder = (prefill: { name: string; path: string }) => {
    setSharePrefill({ ...prefill, key: Date.now() });
    setTab("sharing");
  };

  return (
    <div className="storage-page">
      <PageHeader
        title="Storage"
        status={verdict}
        meta={report ? <>
          <b>{disks.length}</b> {disks.length === 1 ? "disk" : "disks"} · <b>{disks.filter((disk) => disk.removable).length}</b> removable · <b>{mounts.length}</b> mounted · <b>{shares.length}</b> {shares.length === 1 ? "network share" : "network shares"} (<b>{shares.filter((entry) => entry.mounted).length}</b> connected) · <b>{gib(unallocated)}</b> unallocated
        </> : undefined}
        actions={<Button variant="ghost" busy={loading && Boolean(report)} onClick={refreshAll}>Read again</Button>}
        about={<>
          <p>The disks in this server and what is mounted from them, folders mounted from a NAS, the folders this server shares with your other devices, and snapshots to roll back to.</p>
          <p>A drive is checked before it is mounted and mounts again at every boot; a missing drive or a NAS that is off never stops the server starting. Format erases everything on a drive, and the system disk is never offered. Mounting a share only connects out: nothing is opened to your LAN.</p>
          <p>To reach shares from your phone or laptop anywhere, install File Browser from the App catalog, point it at <code>/mnt</code>, and serve it on your tailnet: nothing is exposed on your LAN or the internet.</p>
        </>}
      />

      {error && <Notice tone="danger" live title="The storage state could not be read" action={<Button onClick={refreshAll}>Try again</Button>}>{error}</Notice>}

      <Tabs<TabId> label="Storage" tabs={tabs} value={tab} onChange={setTab}>
        {(current) => {
          if (current === "shares") return <SharesTab csrfToken={csrfToken} role={role} report={report} loading={loading} tailnetHosts={tailnetHosts} onChanged={refreshAll} />;
          if (current === "sharing") return <FileSharingTab csrfToken={csrfToken} role={role} samba={samba} nfs={nfs} folders={shareableFolders(report)} prefill={sharePrefill} onPrefillUsed={() => setSharePrefill(null)} onChanged={refreshAll} onNavigate={onNavigate} />;
          if (current === "snapshots") return <SnapshotsTab csrfToken={csrfToken} role={role} report={report} loading={loading} fsSnapshots={fsSnapshots} onChanged={refreshAll} />;
          if (current === "mounts") return <MountsTab report={report} loading={loading} forecasts={forecasts} usage={usage} lastMeasured={lastMeasured} mapApps={mapApps} mapShares={mapShares} shareHost={shareHost} />;
          return <DrivesTab csrfToken={csrfToken} role={role} report={report} loading={loading} autoReconnect={autoReconnect} mapApps={mapApps} sambaShares={mapShares} onChanged={refreshAll} onShareFolder={shareFolder} />;
        }}
      </Tabs>
    </div>
  );
}
