import { useMemo, useState } from "react";
import { openActivity, openNotifications } from "../../activityEvents";
import { sentenceList } from "../../data";
import { AppSheet } from "../../home/AppSheet";
import { useFacts, valuesOf, type InventoryFacts, type MountFact } from "../../home/facts";
import { greeting, size } from "../../home/format";
import type { HomeProps } from "../../home/Home";
import { actionsOf, appHealth, buildNeeds, runs, verdictFor, verdictSources, type Need, type NeedAction } from "../../home/needs";
import { useCheckAgain } from "../../home/useCheckAgain";
import { runWords, useNeedActions } from "../../home/useNeedActions";
import type { FixRun } from "../../repair/useRepairFixes";
import { useOperation } from "../../shell/ApproveDialog";
import { TopBarSlot } from "../../shell/TopBarSlot";
import { AppIcon, Button, riskCopy } from "../../ui";
import "./home.css";

/*
 * Home in the Aqua look (M41): Mac OS X, 2001, as docs/design-directions/05-looks.html draws it
 * (M.aqua). The page is the window's content: two group boxes side by side, what needs you with
 * its gel buttons and the tier in words, and the server with barber-pole bars for memory, the data
 * drive and the processor; then the apps as glossy icons with what is wrong in orange under the
 * ones that need a look, and the dock of apps under the window. The window itself, the menu bar and
 * the source list are the look's skin (skin.css), the same on every page. The toolbar under the
 * window's title holds Check Again, App Catalog and Activity.
 */

const severityWords = { danger: "Problem", warning: "Needs a look", neutral: "Suggestion" } as const;
/** How many of the things that need you show before "Show all". */
const shownUrgent = 2;
/** How many apps sit in the dock. */
const docked = 7;

/** "up 19 days", "up 5 hours". */
function upFor(seconds: number): string {
  const days = Math.floor(seconds / 86_400);
  if (days >= 1) return `up ${days} ${days === 1 ? "day" : "days"}`;
  const hours = Math.floor(seconds / 3600);
  return hours >= 1 ? `up ${hours} ${hours === 1 ? "hour" : "hours"}` : "up a few minutes";
}

/** "11.0 of 32.0 GB": the unit said once when both sides share it. */
function ofSize(used: number | null, total: number | null): string {
  const a = size(used);
  const b = size(total);
  const unit = / (GB|TB|MB)$/.exec(a)?.[1];
  return unit && b.endsWith(` ${unit}`) ? `${a.slice(0, -unit.length - 1)} of ${b}` : `${a} of ${b}`;
}

/** The drive the data lives on: the largest mount that is not the system disk, else the system disk. */
function dataDrive(inventory: InventoryFacts | null | undefined): MountFact | null {
  const mounts = (inventory?.mounts ?? []).filter((mount) => mount.total !== null);
  const others = mounts.filter((mount) => mount.target !== "/").sort((a, b) => (b.total ?? 0) - (a.total ?? 0));
  return others[0] ?? mounts.find((mount) => mount.target === "/") ?? null;
}

/** "/mnt/media" is the Media drive; "/" the System disk. */
function driveName(target: string): string {
  if (target === "/") return "System disk";
  const last = target.split("/").filter(Boolean).pop() ?? target;
  return `${last.charAt(0).toUpperCase()}${last.slice(1)} drive`;
}

const sentence = (text: string) => (/[.!?…]$/.test(text) ? text : `${text}.`);

function NeedItem({ need, run, onOpen, onAct }: { need: Need; run?: FixRun; onOpen: (need: Need) => void; onAct: (need: Need, action?: NeedAction | null) => void }) {
  const runnable = runs(need);
  const tier = runnable?.risk ?? need.risk;
  const actions = actionsOf(need);
  const busy = Boolean(run && ["queued", "running", "checking"].includes(run.phase));
  const lead = actions.find((action) => action.kind !== "dismiss" && action.kind !== "open");
  return (
    <li className="aqua-need" data-severity={need.severity}>
      <button type="button" className="aqua-need__title" onClick={() => onOpen(need)}>
        <span className="ui-visually-hidden">{`${severityWords[need.severity]}:`}</span>{` ${sentence(need.title)}`}
      </button>
      {(tier || need.detail) && (
        <p className="aqua-need__detail">
          {/* The button carries the tier for assistive technology; this is the same word on screen. */}
          {tier && <span aria-hidden={runnable ? true : undefined}>{riskCopy[tier].label}{need.detail ? " · " : ""}</span>}
          {need.detail && sentence(need.detail)}
        </p>
      )}
      {run && <p className="aqua-need__run" role="status">{runWords(run)}</p>}
      {actions.length > 0 && (
        <div className="aqua-need__acts">
          {actions.map((action) => (action.kind === "dismiss"
            ? <Button key="dismiss" aria-label={`Dismiss: ${need.title}`} onClick={() => onAct(need, action)}>Dismiss</Button>
            : action.kind === "open"
              ? <Button key={`open:${action.label}`} aria-label={`${action.label}: ${need.title}`} onClick={() => onAct(need, action)}>{action.label}</Button>
              : <Button key={`${action.operationId}:${action.label}`} variant={action === lead ? "primary" : "secondary"} risk={action.risk} disabled={busy}
                aria-label={`${action.label}: ${need.title}`} onClick={() => onAct(need, action)}>{action.label}</Button>))}
        </div>
      )}
    </li>
  );
}

export default function AquaHome({ csrfToken, role, onNavigate, now = Date.now }: HomeProps) {
  const { facts, refresh, accept } = useFacts();
  const clock = now();
  const values = useMemo(() => valuesOf(facts), [facts]);
  const needs = buildNeeds(values, { now: clock, role });
  const { start, dialog } = useOperation(csrfToken, () => refresh());
  const { act, runs: fixRuns, remembered, dialog: needDialog } = useNeedActions({ csrfToken, refresh, accept, navigate: onNavigate });
  const again = useCheckAgain(refresh);
  const [sheetFor, setSheetFor] = useState<string | null>(null);
  const [unfolded, setUnfolded] = useState(false);

  const checking = verdictSources.some(([key]) => facts[key].state === "idle" || facts[key].state === "loading");
  const unread = verdictSources.filter(([key]) => facts[key].state === "failed").map(([, words]) => words);
  const inventory = facts.inventory.value;
  const hostname = inventory?.hostname ?? "This server";
  const verdict = verdictFor(needs, { hostname, checking, unread });

  const open = (need: Need) => (need.jobId ? openActivity(need.jobId) : need.id === "unannounced" ? openNotifications() : onNavigate(need.view, need.appId && need.view === "catalog" ? { app: need.appId } : undefined));
  const runOf = (need: Need) => (need.finding ? fixRuns[need.finding.id] : undefined);
  const listed = new Set(needs.flatMap((need) => (need.finding ? [need.finding.id] : [])));
  const justFixed = Object.values(remembered).filter((finding) => !listed.has(finding.id) && fixRuns[finding.id] && ["fixed", "scheduled"].includes(fixRuns[finding.id].phase));

  const urgent = needs.filter((need) => need.severity !== "neutral");
  const waiting = needs.filter((need) => need.severity === "neutral");
  // The drawing's two, then the rest folded under a disclosure triangle, what can wait with them.
  const shownNeeds = urgent.slice(0, shownUrgent);
  const restUrgent = Math.max(0, urgent.length - shownUrgent);
  const folded = restUrgent + waiting.length;
  const foldedWords = [
    restUrgent > 0 ? `${restUrgent} more ${restUrgent === 1 ? "needs" : "need"} you` : "",
    waiting.length > 0 ? `${waiting.length}${restUrgent > 0 ? "" : " more"} can wait` : "",
  ].filter(Boolean).join(", ");

  const catalog = facts.catalog.value;
  const apps = catalog?.apps ?? [];
  const protectionById = new Map((values.protection ?? []).map((entry) => [entry.id, entry]));
  const healths = apps.map((app) => ({ app, health: appHealth(app, protectionById.get(app.id), clock) }));
  const inDock = apps.filter((app) => app.running && !app.paused).slice(0, docked);
  const sheetApp = sheetFor ? apps.find((app) => app.id === sheetFor) ?? null : null;

  const drive = dataDrive(inventory);
  const bars = inventory ? [
    { key: "memory", label: "Memory", value: ofSize(inventory.memoryUsed, inventory.memoryTotal), percent: inventory.memoryPercent, view: "performance" as const },
    ...(drive ? [{ key: "drive", label: driveName(drive.target), value: ofSize(drive.used, drive.total), percent: drive.percent ?? 0, view: "storage" as const }] : []),
    { key: "cpu", label: "Processor", value: `${inventory.loadPercent}%`, percent: inventory.loadPercent, view: "performance" as const },
  ] : [];

  return (
    <div className="aqua-home">
      {dialog}
      {needDialog}
      <TopBarSlot>
        <div className="cc-crumb aqua-crumb">
          <span className="cc-crumb__host">{hostname}</span>
          <span className="aqua-wintitle" aria-hidden="true">{hostname}</span>
        </div>
      </TopBarSlot>
      <h1 className="ui-visually-hidden">{greeting(clock)}</h1>

      <div className="aqua-tools" role="toolbar" aria-label="Home">
        <Button busy={again.checking} onClick={again.run}>{again.checking ? "Checking…" : "Check Again"}</Button>
        <Button onClick={() => onNavigate("catalog")}>App Catalog</Button>
        <Button onClick={() => openActivity()}>Activity</Button>
        {again.said}
      </div>

      <div className="aqua-boxes">
        <section className="aqua-box aqua-needs" aria-labelledby="aqua-needs-title">
          <h2 className="aqua-box__title" id="aqua-needs-title">What needs you</h2>
          {urgent.length === 0 && (
            <p className="aqua-box__text">{checking ? "Reading this server…" : unread.length ? "Nothing wrong in what could be read." : "Nothing needs you right now."}</p>
          )}
          {urgent.length > 0 && (
            <ul className="aqua-needs__list">
              {shownNeeds.map((need) => <NeedItem key={need.id} need={need} run={runOf(need)} onOpen={open} onAct={act} />)}
            </ul>
          )}
          {justFixed.map((finding) => {
            const run = fixRuns[finding.id];
            return <p key={finding.id} className="aqua-need__run" role="status">{run.phase === "scheduled" ? "Scheduled" : "Fixed"}: {finding.title}. {run.phase === "fixed" ? run.changed : run.phase === "scheduled" ? run.message : ""}</p>;
          })}
          {folded > 0 && (
            <button type="button" className="aqua-disclose" aria-expanded={unfolded} aria-controls="aqua-more" onClick={() => setUnfolded((value) => !value)}>
              {unfolded ? "Show fewer" : foldedWords}
            </button>
          )}
          {unfolded && folded > 0 && (
            <div className="aqua-needs__more" id="aqua-more">
              {restUrgent > 0 && <ul className="aqua-needs__list">{urgent.slice(shownUrgent).map((need) => <NeedItem key={need.id} need={need} run={runOf(need)} onOpen={open} onAct={act} />)}</ul>}
              {waiting.length > 0 && (
                <>
                  <h3 className="aqua-needs__sub">Can wait</h3>
                  <ul className="aqua-needs__list">{waiting.map((need) => <NeedItem key={need.id} need={need} run={runOf(need)} onOpen={open} onAct={act} />)}</ul>
                </>
              )}
            </div>
          )}
          {unread.length > 0 && <p className="aqua-box__text aqua-box__text--note">BoxPilot could not read {sentenceList(unread)}, so this list may be missing something.</p>}
        </section>

        <section className="aqua-box aqua-host" aria-labelledby="aqua-host-title">
          <h2 className="aqua-box__title" id="aqua-host-title">{hostname}</h2>
          <p className="aqua-box__text">{inventory ? `${inventory.operatingSystem}, ${upFor(inventory.uptimeSeconds)}. ` : ""}{verdict.sentence}</p>
          {bars.length > 0 && (
            <div className="aqua-kv">
              {bars.map((bar) => (
                <button key={bar.key} type="button" className="aqua-kv__row" onClick={() => onNavigate(bar.view)}>
                  <span className="aqua-kv__label">{bar.label}</span>
                  <span className="aqua-kv__value">{bar.value}</span>
                  <span className="aqua-prog" aria-hidden="true"><i style={{ width: `${Math.max(0, Math.min(100, bar.percent))}%` }} /></span>
                </button>
              ))}
            </div>
          )}
          {!inventory && <p className="aqua-box__text aqua-box__text--note">{facts.inventory.state === "failed" ? "The server's figures could not be read." : "Reading the server's figures…"}</p>}
        </section>
      </div>

      <section className="aqua-icons" aria-labelledby="aqua-apps-title">
        <h2 className="ui-visually-hidden" id="aqua-apps-title">Apps</h2>
        {facts.catalog.state === "failed" && <p className="aqua-icons__quiet">Which apps are installed could not be read. <Button onClick={() => refresh(["catalog"])}>Try again</Button></p>}
        {catalog && !catalog.liveKnown && <p className="aqua-icons__quiet">Docker did not say which apps are installed, so none are shown. The App catalog has the details.</p>}
        {catalog && catalog.liveKnown && apps.length === 0 && (
          <p className="aqua-icons__quiet">No apps are installed yet. <Button variant="primary" onClick={() => onNavigate(values.setup?.firstRun ? "setup" : "catalog")}>{values.setup?.firstRun ? "Choose a setup profile" : "Open the App catalog"}</Button></p>
        )}
        {healths.length > 0 && (
          <ul className="aqua-icons__grid">
            {healths.map(({ app, health }) => {
              const needsLook = health.status === "warning" || health.status === "danger";
              return (
                <li key={app.id}>
                  <button type="button" className="aqua-icon" data-status={health.status} aria-label={`${app.name}, ${health.label}`} onClick={() => setSheetFor(app.id)}>
                    <AppIcon id={app.id} name={app.name} icon={app.icon} size="lg" className="aqua-icon__square" />
                    <span className="aqua-icon__name">{app.name}</span>
                    {needsLook && <span className="aqua-icon__note">{health.label}</span>}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {inDock.length > 0 && (
        <nav className="aqua-dock" aria-label="Dock">
          <ul>
            {inDock.map((app) => (
              <li key={app.id}>
                <button type="button" className="aqua-dock__item" onClick={() => setSheetFor(app.id)}>
                  <AppIcon id={app.id} name={app.name} icon={app.icon} size="lg" className="aqua-dock__square" />
                  <span className="aqua-dock__label">{app.name}</span>
                </button>
              </li>
            ))}
          </ul>
        </nav>
      )}

      {sheetApp && <AppSheet app={sheetApp} protection={protectionById.get(sheetApp.id)} now={clock} role={role} onClose={() => setSheetFor(null)} onNavigate={onNavigate} onStart={start} />}
    </div>
  );
}
