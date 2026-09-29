import type { AppProtection } from "../backupProtection";
import { countOf, type ViewName } from "../data";
import type { PendingOperation } from "../shell/ApproveDialog";
import { ExternalIcon } from "../shell/areaIcons";
import "../shell/look.css";
import { AppIcon, Button, KeyValue, Sheet, StatusChip, mayStart, riskOf } from "../ui";
import type { AppFact } from "./facts";
import { relativeTime } from "./format";
import { appHealth, reachOf } from "./needs";

/*
 * An app's sheet (M33.2): what the Launcher shows when a tile is pressed. Its state, who can reach
 * it, its update and its backups, with the app's own page one click away and the few things worth
 * doing from here, each with its tier. Everything else is on its card in the App catalog.
 *
 * M33.14 draws it on the kit's Sheet, in the console's look (look-console): Home's root keeps the
 * Launcher's tokens, and this is the same drawer the approval dialog it hands over to sits beside.
 */

export interface AppSheetProps {
  app: AppFact;
  protection: AppProtection | undefined;
  now: number;
  role: string;
  onClose: () => void;
  onNavigate: (view: ViewName, options?: { app?: string }) => void;
  onStart: (operation: PendingOperation) => void;
}

export function AppSheet({ app, protection, now, role, onClose, onNavigate, onStart }: AppSheetProps) {
  const health = appHealth(app, protection, now);
  const state = app.vpnLeaked ? "Running, but it sent traffic outside its VPN"
    : app.paused ? "Paused: it keeps its memory and uses no processor"
      : !app.running ? (app.status === "restarting" ? "Restarting over and over" : app.status === "absent" ? "No container: listed as installed, but Docker has none for it" : app.stoppedOnPurpose ? "Stopped from BoxPilot; it stays off until you start it" : "Not running")
        : app.troubledSidecar ? `Running, but its ${app.troubledSidecar.id} container is ${app.troubledSidecar.status === "restarting" ? "restarting" : "down"}`
          : app.health === "unhealthy" ? "Running, but Docker's health check fails"
            : app.health === "healthy" ? "Running and healthy" : "Running";
  const backups = !protection ? "Not known"
    : !protection.protectable ? "Nothing to back up: its data can be downloaded again"
      : protection.backups === 0 ? "Never backed up"
        : `${countOf(protection.backups, "backup")}, the newest ${relativeTime(protection.newestAt, now) ?? "at an unknown time"}`;
  const drill = !app.drill ? "Not rehearsed" : `${app.drill.verified ? "Restored cleanly" : "Failed"} ${relativeTime(app.drill.checkedAt, now) ?? ""}`.trim();

  const act = (operation: PendingOperation) => { onClose(); onStart(operation); };
  const actions = [
    app.updateAvailable && mayStart(role, "app.update") ? <Button key="update" risk={riskOf("app.update")} onClick={() => act({ operationId: "app.update", title: `Update ${app.name}`, parameters: { id: app.id }, preview: <span>Pulls the image and recreates the container. The previous image is restored if the new one fails to become healthy.</span> })}>Update</Button> : null,
    !app.running && !app.paused && mayStart(role, "app.action") ? <Button key="start" risk={riskOf("app.action")} onClick={() => act({ operationId: "app.action", title: `Start ${app.name}`, parameters: { id: app.id, action: "start" }, preview: <span>Starts {app.name}.</span> })}>Start</Button> : null,
    app.paused && mayStart(role, "app.action") ? <Button key="resume" risk={riskOf("app.action")} onClick={() => act({ operationId: "app.action", title: `Resume ${app.name}`, parameters: { id: app.id, action: "unpause" }, preview: <span>Thaws {app.name} exactly where it left off.</span> })}>Resume</Button> : null,
    protection?.protectable && mayStart(role, "app.backup") ? <Button key="backup" risk={riskOf("app.backup")} onClick={() => act({ operationId: "app.backup", title: `Back up ${app.name}`, parameters: { id: app.id }, preview: <span>Stops {app.name} briefly, archives its data and configuration, restarts it, and keeps the newest 5 copies.</span> })}>Back up now</Button> : null,
  ].filter(Boolean);

  return (
    <Sheet kicker="App" title={app.name} size="sm" className="look-console app-sheet" onClose={onClose}
      footer={<>
        <Button variant="ghost" onClick={() => { onClose(); onNavigate("catalog", { app: app.id }); }}>Manage in the App catalog</Button>
        {actions}
        {app.url && (app.running || app.paused) && (
          <a className="ui-button ui-button--primary app-sheet__open" href={app.url} target="_blank" rel="noreferrer">
            <span className="ui-button__label">Open {app.name}</span><ExternalIcon aria-hidden="true" />
          </a>
        )}
      </>}>
      <div className="app-sheet__head">
        <AppIcon id={app.id} name={app.name} icon={app.icon} size="lg" />
        <StatusChip status={health.status}>{health.label}</StatusChip>
      </div>
      <KeyValue layout="rows" items={[
        { id: "state", label: "State", value: state },
        { id: "reach", label: "Reach", value: app.port === null ? "No web page" : `${reachOf(app)}, port ${app.port}` },
        { id: "update", label: "Update", value: app.updateAvailable ? "A new version is ready" : "Up to date" },
        { id: "backups", label: "Backups", value: backups },
        { id: "drill", label: "Restore drill", value: drill },
      ]} />
    </Sheet>
  );
}
