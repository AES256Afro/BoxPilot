import { Suspense, lazy, type ComponentType, type LazyExoticComponent } from "react";
import type { AutoReconnectControl } from "../AutoReconnect";
import type { ViewName } from "../data";
import type { MapSambaShare } from "../storageMap";
import type { Forecast, FsSnapshots, StorageReport } from "../pages/storage/types";
import type { LookId } from "./looks";
import { useDrawnLook } from "./drawnLook";

/*
 * What a look puts at the top of Storage (M41), above the tabs: Home + Ops draws the disks to scale
 * (docs/design-directions/05-looks: blend-storage), the Launcher a glance at the drives, what needs
 * you, the shared folders and the snapshots (launcher-storage). The tabs below are the same in every
 * look; a look with nothing to add draws nothing here.
 */

export interface StorageLeadProps {
  csrfToken: string;
  role: string;
  report: StorageReport | null;
  loading: boolean;
  forecasts: Forecast[];
  fsSnapshots: FsSnapshots | null;
  sambaShares: MapSambaShare[];
  shareHost: string | null;
  autoReconnect: AutoReconnectControl;
  onTab: (tab: "drives" | "shares" | "sharing" | "snapshots" | "mounts") => void;
  onNavigate?: (view: ViewName) => void;
  onChanged: () => void;
}

const leads: Partial<Record<LookId, LazyExoticComponent<ComponentType<StorageLeadProps>>>> = {
  blend: lazy(() => import("./blend/StorageLead")),
  launcher: lazy(() => import("./launcher/StorageLead")),
};

export function StorageLead(props: StorageLeadProps) {
  const look = useDrawnLook();
  const Lead = leads[look];
  if (!Lead) return null;
  return <Suspense fallback={null}><Lead {...props} /></Suspense>;
}
