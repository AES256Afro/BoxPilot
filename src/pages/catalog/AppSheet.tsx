import { useState, type ReactNode } from "react";
import { AppIcon, Button, KeyValue, Notice, Panel, Sheet, StatusChip, Tabs, mayStart, riskOf, type KeyValueItem, type TabItem } from "../../ui";
import { AccessTab } from "./AccessTab";
import { BackupsTab } from "./BackupsTab";
import { ConfigTab } from "./ConfigTab";
import { LogsTab } from "./LogsTab";
import { ModelsTab } from "./ModelsTab";
import { ReachTab, reachOf } from "./ReachTab";
import { appStatus, drillFailed, installTier, isPaused, isRunning, troubledSidecar } from "./appState";
import type { CatalogContext, Entry } from "./types";

/*
 * An app's sheet (M33.11): everything about one app, opened from its tile, its card, Home's app
 * sheet or a link (?view=catalog&app=<id>). Its state and facts first, then a tab for each thing
 * the Classic card did behind a button: who can reach it and how, its backups and restore drills,
 * its VPN and kill switch, its logs, its configuration, its models, and signing in to it. Every
 * action closes the sheet and goes through the approval dialog at its tier, as before.
 */

export type SheetTab = "overview" | "reach" | "backups" | "vpn" | "logs" | "config" | "models" | "signin" | "secrets";

export interface AppSheetProps {
  entry: Entry;
  ctx: CatalogContext;
  tab?: SheetTab;
  /** Told when another tab opens, so the address can keep it. */
  onTab?: (tab: SheetTab) => void;
  onClose: () => void;
}

/** What an installed app is doing, in a sentence, as Home's app sheet says it. */
function stateWords(entry: Entry): string {
  const { live } = entry;
  if (!live?.installed) return live?.dataPresent ? "Not installed; its data is kept" : "Not installed";
  if (live.killSwitchDrill?.leaked) return "Running, but it sent traffic outside its VPN";
  if (isPaused(live)) return "Paused: it keeps its memory and uses no processor";
  if (!live.container.running) return live.container.status === "restarting" ? "Restarting over and over" : live.container.status === "absent" ? "No container: listed as installed, but Docker has none for it" : "Stopped";
  const troubled = troubledSidecar(live);
  if (troubled) return `Running, but its ${troubled.id} container is ${troubled.status === "restarting" ? "restarting" : "down"}`;
  if (live.container.health === "unhealthy") return "Running, but Docker's health check fails";
  return live.container.health === "healthy" ? "Running and healthy" : "Running";
}

export function AppSheet({ entry, ctx, tab: firstTab = "overview", onTab, onClose }: AppSheetProps) {
  const { manifest, live } = entry;
  const { role } = ctx;
  const installed = Boolean(live?.installed);
  const canRead = role === "owner" || role === "operator";
  const owner = role === "owner";
  const status = appStatus(live);
  const tabs: Array<TabItem<SheetTab>> = [
    { id: "overview", label: "Overview" },
    ...(installed ? [{ id: "reach" as const, label: "Reach" }] : []),
    ...((installed || live?.dataPresent) && canRead ? [{ id: "backups" as const, label: "Backups", status: live?.backupVerification && !live.backupVerification.verified ? "danger" as const : undefined, statusLabel: live?.backupVerification && !live.backupVerification.verified ? "last rehearsal failed" : undefined }] : []),
    ...(installed && manifest.networkVia ? [{ id: "vpn" as const, label: "VPN", status: live?.killSwitchDrill?.leaked ? "danger" as const : undefined, statusLabel: live?.killSwitchDrill?.leaked ? "leaked" : undefined }] : []),
    ...(installed && canRead ? [{ id: "logs" as const, label: "Logs" }] : []),
    ...(installed ? [{ id: "config" as const, label: "Config" }] : []),
    ...(installed && manifest.modelRunner && canRead ? [{ id: "models" as const, label: "Models" }] : []),
    ...(installed && manifest.signIn ? [{ id: "signin" as const, label: "Sign-in" }] : []),
    ...(installed && owner && manifest.env.some((env) => env.secret) ? [{ id: "secrets" as const, label: "Secrets" }] : []),
  ];
  const [tab, setOpenTab] = useState<SheetTab>(tabs.some((item) => item.id === firstTab) ? firstTab : "overview");
  const setTab = (next: SheetTab) => { setOpenTab(next); onTab?.(next); };

  const content = (current: SheetTab): ReactNode => {
    if (current === "reach") return <ReachTab entry={entry} ctx={ctx} />;
    if (current === "backups") return <BackupsTab entry={entry} ctx={ctx} />;
    if (current === "vpn") return <VpnTab entry={entry} ctx={ctx} />;
    if (current === "logs") return <LogsTab entry={entry} ctx={ctx} />;
    if (current === "config") return <ConfigTab entry={entry} ctx={ctx} />;
    if (current === "models") return <ModelsTab entry={entry} ctx={ctx} />;
    if (current === "signin") return <AccessTab entry={entry} ctx={ctx} mode="signin" />;
    if (current === "secrets") return <AccessTab entry={entry} ctx={ctx} mode="secrets" />;
    return <Overview entry={entry} ctx={ctx} onTab={setTab} />;
  };

  return (
    <Sheet kicker={manifest.category} title={manifest.name} size="lg" onClose={onClose} className="catalog-sheet">
      <div className="catalog-sheet__head">
        <AppIcon id={manifest.id} name={manifest.name} icon={manifest.icon} size="lg" />
        <div className="catalog-sheet__lead">
          <StatusChip status={status.status}>{status.label}</StatusChip>
          <p className="catalog-sheet__meta"><code>{manifest.image.reference}</code>{manifest.image.digestPinned ? " · digest pinned" : ""}</p>
          <p className="catalog-sheet__description">{manifest.description}</p>
        </div>
      </div>
      {tabs.length > 1
        ? <Tabs<SheetTab> label={`${manifest.name}`} tabs={tabs} value={tab} onChange={setTab} className="catalog-sheet__tabs">{content}</Tabs>
        : content("overview")}
    </Sheet>
  );
}

function Overview({ entry, ctx, onTab }: { entry: Entry; ctx: CatalogContext; onTab: (tab: SheetTab) => void }) {
  const { manifest, live } = entry;
  const { role, act, stats, tunnels, rehearsal, killswitch } = ctx;
  const may = (operationId: string) => mayStart(role, operationId);
  const installed = Boolean(live?.installed);
  const running = isRunning(live);
  const paused = isPaused(live);
  const name = manifest.name;
  const lifecycle = (action: "start" | "stop" | "restart" | "unpause", title: string, preview?: ReactNode) => act({ operationId: "app.action", title, parameters: { id: manifest.id, action }, ...(preview ? { preview } : {}) });
  const ownFolders = manifest.volumes.filter((volume) => volume.hostPath).map((volume) => volume.hostPath).join(", ");

  // Where this app's data actually lives, on installed apps that let you choose. Seeing the drive
  // at a glance is what makes a download client saving to the wrong disk obvious instead of a
  // mystery. Only owner-facing folders under /mnt or /srv; its own config directory is not.
  const folders = installed ? manifest.volumes
    .filter((volume) => volume.configurable && !volume.readOnly)
    .map((volume) => ({ label: volume.label, path: live?.state?.values?.volumes?.[volume.id] ?? volume.hostPath }))
    .filter((folder): folder is { label: string; path: string } => typeof folder.path === "string" && (folder.path.startsWith("/mnt/") || folder.path.startsWith("/srv/"))) : [];
  const stat = stats?.[manifest.id];
  const tunnel = tunnels[manifest.id];
  const verification = live?.backupVerification ?? null;
  const reach = installed && live ? reachOf(entry) : null;
  const history = (live?.updateHistory ?? []).filter((update) => update.from?.[manifest.id]);

  const facts: KeyValueItem[] = [
    // The container's own state here; a folder it cannot write to is said above, in its notice.
    { id: "state", label: "State", value: stateWords(entry), status: appStatus(live ? { ...live, folderProblems: [] } : live).status, hint: live && installed && live.container.restarts > 0 ? `${live.container.restarts} restarts` : undefined },
    { id: "version", label: "Version", mono: true, value: manifest.image.version ?? manifest.image.reference, hint: live?.updateAvailable ? `update ready: ${live.installedImage ?? "installed image"} → ${manifest.image.reference}` : installed ? "up to date" : undefined },
    ...(reach ? [{ id: "reach", label: "Reach", value: reach.tailnetOnly ? "Tailscale only" : "Your home network", hint: live!.urls.length ? live!.urls.map((url) => `${url.label} ${url.host}`).join(" · ") : "No web page" }] : []),
    ...(!installed && manifest.ports.length ? [{ id: "ports", label: "Ports", mono: true, value: manifest.ports.map((port) => `${port.label} ${port.host}/${port.protocol}`).join(" · ") }] : []),
    ...(folders.length ? [{ id: "data", label: "Data", mono: true, value: <span className="catalog-paths">{folders.map((folder) => <code key={folder.path} title={folder.label}>{folder.path}</code>)}</span> }] : []),
    ...(installed && stat ? [{ id: "uses", label: "Uses", mono: true, value: `CPU ${stat.cpuPercent.toFixed(1)}% · ${Math.round(stat.memBytes / 1024 / 1024)} MiB${stat.containers > 1 ? ` · ${stat.containers} containers` : ""}` }] : []),
    ...(installed && tunnel?.running && tunnel.exit ? [{ id: "exit", label: "VPN exit", value: `${tunnel.exit.location ?? "unknown place"} · ${tunnel.exit.ip}`, hint: tunnel.forwardedPort ? `forwarded port ${tunnel.forwardedPort}` : undefined }] : []),
    ...(installed || live?.dataPresent ? [{
      id: "drill", label: "Restore drill",
      status: verification ? (verification.verified ? "good" as const : "danger" as const) : undefined,
      value: verification ? `${verification.verified ? "Restored cleanly" : "Failed"} ${new Date(verification.checkedAt).toLocaleString()}` : "Not rehearsed",
      hint: rehearsal[manifest.id] ? `rehearsed automatically, ${rehearsal[manifest.id].cadence}` : undefined,
    }] : []),
    ...(installed && live?.killSwitchDrill ? [{
      id: "killswitch", label: "Kill switch",
      status: live.killSwitchDrill.leaked ? "danger" as const : "good" as const,
      value: `${live.killSwitchDrill.leaked ? "Leaked" : "Held"} ${new Date(live.killSwitchDrill.at).toLocaleString()}`,
      hint: killswitch[manifest.id] ? `checked weekly${drillFailed(killswitch[manifest.id].lastResult) ? ", the last check failed" : ""}` : undefined,
    }] : []),
    ...(installed && live?.state?.installedAt ? [{ id: "installed", label: "Installed", mono: true, value: new Date(live.state.installedAt).toLocaleDateString(), hint: live.state.updatedAt && live.state.updatedAt !== live.state.installedAt ? `changed ${new Date(live.state.updatedAt).toLocaleDateString()}` : undefined }] : []),
    ...(manifest.website ? [{ id: "website", label: "Website", value: <a href={manifest.website} target="_blank" rel="noreferrer">{manifest.website.replace(/^https?:\/\//, "").replace(/\/$/, "")}</a> }] : []),
  ];

  return (
    <div className="catalog-tab">
      {installed && (live?.folderProblems ?? []).length > 0 && (
        <Notice tone="danger" title={`${name} cannot write to its folder`} action={may("app.reconfigure") ? <Button risk={riskOf("app.reconfigure")} onClick={() => act({ operationId: "app.reconfigure", title: `Fix folder access for ${name}`, parameters: { id: manifest.id, values: {} }, preview: <span>Redeploys {name} with its current settings; the deploy hands its data folders to the app's own user so it can write there. Nothing else changes.</span> })}>Fix folder access</Button> : undefined}>
          <ul className="catalog-list">{live!.folderProblems!.map((problem) => <li key={problem.path}><code>{problem.path}</code> ({problem.volume}: {problem.reason}). Uploads and downloads there will fail.</li>)}</ul>
        </Notice>
      )}
      {/* The drill's own verdict: a leak means traffic escaped the tunnel while it was down, which
          is the whole thing the kill switch is for. */}
      {installed && live?.killSwitchDrill?.leaked && (
        <Notice tone="danger" title={`${name} leaked outside its VPN`} action={<Button variant="ghost" onClick={() => onTab("vpn")}>VPN</Button>}>
          During the drill on {new Date(live.killSwitchDrill.at).toLocaleString()}, traffic escaped while the tunnel was down.
        </Notice>
      )}

      <div className="catalog-sheet__actions">
        {installed && live && live.urls.map((port, index) => (
          <a key={port.id} className={`ui-button ui-button--${index === 0 ? "primary" : "secondary"}`} href={ctx.openUrl(port, manifest)} target="_blank" rel="noreferrer"><span className="ui-button__label">Open {port.label}</span></a>
        ))}
        {!installed && may("app.install") && <Button variant="primary" risk={installTier(manifest)} onClick={() => ctx.configure(entry, "install")}>Install</Button>}
        {installed && may("app.action") && (paused
          ? <>
            <Button risk={riskOf("app.action")} onClick={() => lifecycle("unpause", `Resume ${name}`, <span>Thaws {name} exactly where it left off.</span>)}>Resume</Button>
            <Button risk={riskOf("app.action")} onClick={() => lifecycle("stop", `Stop ${name}`, <span>Stops {name} and frees its memory.</span>)}>Stop</Button>
          </>
          : running
            ? <>
              <Button risk={riskOf("app.action")} onClick={() => lifecycle("restart", `Restart ${name}`)}>Restart</Button>
              <Button risk={riskOf("app.action")} onClick={() => lifecycle("stop", `Stop ${name}`)}>Stop</Button>
            </>
            : <Button risk={riskOf("app.action")} onClick={() => lifecycle("start", `Start ${name}`)}>Start</Button>)}
        {installed && may("app.update") && (
          <Button variant={live?.updateAvailable ? "primary" : "secondary"} risk={riskOf("app.update")} onClick={() => act({ operationId: "app.update", title: `Update ${name}`, parameters: { id: manifest.id }, preview: <span>{live?.updateAvailable ? <>Updates from <code>{live.installedImage}</code> to <code>{manifest.image.reference}</code>. </> : null}Pulls the image and recreates the container. The previous image is restored if the new one fails to become healthy.</span> })}>
            {live?.updateAvailable ? "Update available" : "Update"}
          </Button>
        )}
        {installed && may("app.reconfigure") && <Button onClick={() => ctx.configure(entry, "reconfigure")}>Settings</Button>}
        {installed && may("app.backup") && (
          <Button risk={riskOf("app.backup")} onClick={() => act({ operationId: "app.backup", title: `Back up ${name}`, parameters: { id: manifest.id }, preview: <span>Stops {name} briefly, archives its data and configuration, restarts it, and keeps the newest 5 copies.{ownFolders ? <> Your own folders ({ownFolders}) are <strong>not</strong> included.</> : null}</span> })}>Back up</Button>
        )}
      </div>

      {/* What the app's manifest offers to do inside it (M38: Zulip's "Create your organization"),
          each a registered operation approved at its own tier. It runs inside the container, so
          only while the app is running. */}
      {installed && (manifest.actions ?? []).some((action) => may(action.operation)) && (
        <Panel level={3} title={`In ${name}`} className="catalog-app-actions">
          <ul className="catalog-rows">
            {(manifest.actions ?? []).filter((action) => may(action.operation)).map((action) => (
              <li key={action.id} className="catalog-row">
                <span className="catalog-row__main">
                  <strong>{action.label}</strong>
                  {action.description && <span className="catalog-row__dim">{action.description}</span>}
                </span>
                <Button risk={riskOf(action.operation)} disabled={!running} onClick={() => act({ operationId: action.operation, title: `${action.label} (${name})`, parameters: { id: manifest.id }, preview: <span>{action.description ?? action.label}</span> })}>{action.label}</Button>
              </li>
            ))}
          </ul>
          {!running && <p className="catalog-note">{name} is not running; start it first.</p>}
        </Panel>
      )}

      <KeyValue layout="rows" className="catalog-facts" items={facts} />

      {manifest.notes && installed && <p className="catalog-note">{manifest.notes}</p>}

      {/* The update that succeeded and turned out wrong. Every version comes from this app's own
          recorded history, so this can only put back something it already ran. */}
      {installed && history.length > 0 && (
        <Panel level={3} title="Earlier versions" count={history.length} className="catalog-versions">
          <ul className="catalog-rows">
            {history.map((update) => (
              <li key={update.at} className="catalog-row">
                <span className="catalog-row__main">
                  <code>{update.from[manifest.id]}</code>
                  <span className="catalog-row__dim">{update.rolledBack ? "before going back" : "before updating"}, {new Date(update.at).toLocaleDateString()}</span>
                </span>
                {may("app.rollback") && (
                  <Button risk={riskOf("app.rollback")} aria-label={`Go back to ${update.from[manifest.id]}`} onClick={() => act({
                    operationId: "app.rollback",
                    title: `Put ${name} back on ${update.from[manifest.id]}`,
                    parameters: { id: manifest.id, at: update.at },
                    preview: <span>Takes a checkpoint, then puts {name} back on <code>{update.from[manifest.id]}</code>{Object.keys(update.from).length > 1 ? <> along with{Object.entries(update.from).filter(([service]) => service !== manifest.id).map(([service, reference]) => <span key={service}> its {service} on <code>{reference}</code></span>)}</> : null}. Your data and settings are untouched; only the versions change.</span>,
                  })}>Go back to this</Button>
                )}
              </li>
            ))}
          </ul>
        </Panel>
      )}

      {(installed || live?.dataPresent) && (
        <div className="catalog-sheet__more">
          {installed && manifest.id === "homepage" && may("homepage.sync") && (
            <Button risk={riskOf("homepage.sync")} onClick={() => act({ operationId: "homepage.sync", title: "Sync Homepage with installed apps", parameters: { host: window.location.hostname }, preview: <span>Writes a <strong>BoxPilot</strong> group into Homepage's <code>services.yaml</code> with every installed app, links via <code>{window.location.hostname}</code>, descriptions, icons, and live container status. Groups you wrote yourself are kept. Repeats by itself after installs and uninstalls.</span> })}>Sync dashboard</Button>
          )}
          {installed && may("app.uninstall") && (
            <Button risk={riskOf("app.uninstall")} onClick={() => act({ operationId: "app.uninstall", title: `Uninstall ${name}`, parameters: { id: manifest.id }, preview: <span>Stops and removes the container. Data under the app directory is kept so you can reinstall later.</span> })}>Uninstall</Button>
          )}
          {live?.dataPresent && may("app.purge") && (
            <Button risk={riskOf("app.purge")} onClick={() => act({ operationId: "app.purge", title: `Delete ${name} and its data`, parameters: { id: manifest.id }, preview: <span>Removes the container <strong>and deletes everything</strong> under the app's data directory. This cannot be undone.</span> })}>Delete data</Button>
          )}
        </div>
      )}
    </div>
  );
}

function VpnTab({ entry, ctx }: { entry: Entry; ctx: CatalogContext }) {
  const { manifest, live } = entry;
  const { act, role, killswitch, scheduling, scheduleError, schedules } = ctx;
  const tunnel = ctx.tunnels[manifest.id];
  const weekly = killswitch[manifest.id];
  const drill = live?.killSwitchDrill ?? null;
  const canChange = role !== "viewer";
  const facts: KeyValueItem[] = [
    { id: "tunnel", label: "Tunnel", status: !tunnel ? "unknown" : tunnel.running ? "good" : "danger", value: !tunnel ? "Not read" : tunnel.running ? "Up" : "Down", hint: `through its ${manifest.networkVia} container` },
    ...(tunnel?.exit ? [{ id: "exit", label: "Exit", value: `${tunnel.exit.location ?? "unknown place"} · ${tunnel.exit.ip}`, hint: "where its traffic leaves, from the tunnel's own log" }] : []),
    ...(tunnel?.forwardedPort ? [{ id: "forwarded", label: "Forwarded port", mono: true, value: String(tunnel.forwardedPort), hint: "set it in the app under Tools, Options, Connection" }] : []),
    { id: "drill", label: "Last drill", status: drill ? (drill.leaked ? "danger" : "good") : undefined, value: drill ? `${drill.leaked ? "Leaked" : "Held"} ${new Date(drill.at).toLocaleString()}` : "Never proved", hint: drill?.downForMs ? `tunnel down ${Math.round(drill.downForMs / 1000)}s` : undefined },
    { id: "weekly", label: "Weekly check", status: weekly ? (weekly.overdue || drillFailed(weekly.lastResult) ? "warning" : "good") : undefined, value: weekly ? "On" : "Off", hint: weekly?.lastRunAt ? `last ${new Date(weekly.lastRunAt).toLocaleDateString()}${drillFailed(weekly.lastResult) ? ", failed" : ""}` : undefined },
  ];
  return (
    <div className="catalog-tab">
      {drill?.leaked && <Notice tone="danger" title={`${manifest.name} leaked outside its VPN`}>During the drill on {new Date(drill.at).toLocaleString()}, traffic escaped while the tunnel was down.</Notice>}
      {scheduleError && <Notice tone="danger" live title="The weekly check was not changed">{scheduleError}</Notice>}
      <KeyValue layout="rows" className="catalog-facts" items={facts} />
      <div className="catalog-sheet__actions">
        {tunnel?.running && mayStart(role, "app.vpn.killswitch.drill") && (
          <Button risk={riskOf("app.vpn.killswitch.drill")} onClick={() => act({ operationId: "app.vpn.killswitch.drill", title: `Prove ${manifest.name}'s kill switch`, parameters: { id: manifest.id }, preview: <span>Forces the tunnel down for a few seconds, checks nothing can reach the internet while it is down, then brings it back. Downloads pause briefly and resume by themselves; the result is recorded.</span> })}>Prove the kill switch</Button>
        )}
        {canChange && (weekly
          ? <Button variant="ghost" disabled={scheduling} onClick={() => void schedules.stopKillswitch(weekly.id)}>Stop the weekly check</Button>
          : <Button disabled={scheduling} onClick={() => void schedules.killswitch(manifest.id)}>Verify weekly</Button>)}
      </div>
      {!tunnel?.running && <p className="catalog-note">The tunnel is not up, so there is nothing to prove until it is.</p>}
    </div>
  );
}
