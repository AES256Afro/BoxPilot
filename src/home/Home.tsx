import { useMemo, useState } from "react";
import { useOperation } from "../ApproveDialog";
import { judgeProtection } from "../backupProtection";
import { countOf, sentenceList, type ViewName } from "../data";
import { AreaIcon, BellIcon, PlusIcon, SparkIcon } from "../shell/areaIcons";
import { TopBarSlot } from "../shell/TopBarSlot";
import { Button, MetricTile, Section, StatusChip, Tile, initials, type Status } from "../ui";
import { appHue } from "../ui/appColor";
import { AppSheet } from "./AppSheet";
import { useFacts, valuesOf, type AppFact } from "./facts";
import { greeting, loadStatus, mountName, mountStatus, relativeTime, shortCpu, size, uptime } from "./format";
import { NeedRow } from "./NeedRow";
import { useNeedActions } from "./useNeedActions";
import { appHealth, buildNeeds, needsLabel, verdictFor, verdictSources, type Need } from "./needs";

/*
 * Home (M33.2, ADR-004): the Launcher. It answers "is everything OK?" on one screen: a verdict
 * first, then what needs the owner, worst first, beside the installed apps as tiles with their
 * health. Every fact opens its detail; every fix shows its tier and goes through the approval
 * dialog. Comfortable density; Ops shows the same facts compactly.
 *
 * The look (M33.7) is the study's Launcher: a wallpaper, frosted glass panels down the left (what
 * needs you, the system, backups and disks), the greeting and the apps as colour squares on the
 * right with what can wait in a strip beneath them, the dock at the bottom. On a phone the columns
 * stack in the order they are read.
 */

export interface HomeProps {
  csrfToken: string;
  role: string;
  onNavigate: (view: ViewName, options?: { app?: string }) => void;
  now?: () => number;
}

/** How many of each list show before "Show all". */
const shownUrgent = 5;
const shownWaiting = 4;

/** An app's colour square with its glyph: its emoji, or its initials. */
function AppSquare({ app }: { app: Pick<AppFact, "id" | "name" | "icon"> }) {
  return <span className="lx-square" data-hue={appHue(app.id)}>{app.icon ? <span className="lx-square__emoji">{app.icon}</span> : initials(app.name)}</span>;
}

export default function Home({ csrfToken, role, onNavigate, now = Date.now }: HomeProps) {
  const { facts, refresh, accept } = useFacts();
  const clock = now();
  const values = useMemo(() => valuesOf(facts), [facts]);
  const needs = buildNeeds(values, { now: clock, role });
  // The app sheet's own buttons; every button in the needs goes through useNeedActions (M35).
  const { start, dialog } = useOperation(csrfToken, () => refresh());
  const { act, runs, remembered, dialog: needDialog } = useNeedActions({ csrfToken, refresh, accept });
  const [sheetFor, setSheetFor] = useState<string | null>(null);
  const [allUrgent, setAllUrgent] = useState(false);
  const [allWaiting, setAllWaiting] = useState(false);

  const checking = verdictSources.some(([key]) => facts[key].state === "idle" || facts[key].state === "loading");
  const unread = verdictSources.filter(([key]) => facts[key].state === "failed").map(([, words]) => words);
  const inventory = facts.inventory.value;
  const hostname = inventory?.hostname ?? "This server";
  const verdict = verdictFor(needs, { hostname, checking, unread });

  const open = (need: Need) => onNavigate(need.view, need.appId && need.view === "catalog" ? { app: need.appId } : undefined);
  const runOf = (need: Need) => (need.finding ? runs[need.finding.id] : undefined);
  // Fixed from here and gone from the list since: said once, under it (M35).
  const listed = new Set(needs.flatMap((need) => (need.finding ? [need.finding.id] : [])));
  const justFixed = Object.values(remembered).filter((finding) => !listed.has(finding.id) && runs[finding.id] && ["fixed", "scheduled"].includes(runs[finding.id].phase));

  const catalog = facts.catalog.value;
  const apps = catalog?.apps ?? [];
  const appsById = new Map(apps.map((app) => [app.id, app]));
  const protectionById = new Map((values.protection ?? []).map((entry) => [entry.id, entry]));
  const healths = apps.map((app) => ({ app, health: appHealth(app, protectionById.get(app.id), clock) }));
  const unwell = healths.filter(({ health }) => health.status === "danger" || health.status === "warning").length;
  const sheetApp = sheetFor ? apps.find((app) => app.id === sheetFor) ?? null : null;
  // A need about an app shows the app's square; any other, the icon of the page it opens.
  const iconFor = (need: Need) => {
    const app = need.appId ? appsById.get(need.appId) : undefined;
    return app ? <AppSquare app={app} /> : <span className="lx-well"><AreaIcon view={need.view} /></span>;
  };

  // What needs a look down the side; what can wait in the strip under the apps. The verdict counts
  // both ("2 things need a look. 2 more can wait."), so between them they are the whole list.
  const urgent = needs.filter((need) => need.severity !== "neutral");
  const waiting = needs.filter((need) => need.severity === "neutral");
  const worst: Status = urgent.some((need) => need.severity === "danger") ? "danger" : urgent.length ? "warning" : "good";
  const needsStatus = urgent.length ? { status: worst, label: needsLabel(needs, verdict) }
    : checking ? { status: "unknown" as const, label: "Checking" }
      : unread.length ? { status: "unknown" as const, label: "Not fully read" } : { status: "good" as const, label: "All clear" };

  // Backups at a glance, from the same verdicts the needs list uses.
  const verdicts = values.protection ? judgeProtection(values.protection, (values.schedules ?? []).map((schedule) => ({ ...schedule, parameters: schedule.parameters ?? undefined })), { now: clock }) : null;
  const recent = verdicts?.filter((verdict) => verdict.state === "ok").length ?? 0;
  const never = verdicts?.filter((verdict) => verdict.state === "never").length ?? 0;
  const stale = verdicts?.filter((verdict) => verdict.state === "stale").length ?? 0;
  const offBox = values.offBox?.verdict ?? null;
  const offBoxValue = !offBox ? "—" : offBox.state === "none" ? "Nowhere" : offBox.state === "never" ? "Never copied" : offBox.state === "behind" ? "Behind" : offBox.state === "stale" ? `${offBox.ageDays} days old` : relativeTime(offBox.lastSyncAt, clock) ?? "Copied";
  const database = values.database;
  const databaseAge = database?.lastBackupAt ? Math.floor((clock - Date.parse(database.lastBackupAt)) / 86_400_000) : null;
  const notRead = (state: string) => (state === "failed" ? "Could not be read" : "Reading…");
  // The newest restore drill any app has had, for the panel's corner.
  const lastDrill = apps.flatMap((app) => (app.drill?.checkedAt ? [app.drill] : [])).sort((a, b) => (b.checkedAt ?? "").localeCompare(a.checkedAt ?? ""))[0] ?? null;
  const drillWords = lastDrill ? `${lastDrill.verified ? "drill passed" : "drill failed"} ${relativeTime(lastDrill.checkedAt, clock) ?? ""}`.trim() : undefined;

  const shownNeeds = allUrgent ? urgent : urgent.slice(0, shownUrgent);
  const shownWait = allWaiting ? waiting : waiting.slice(0, shownWaiting);

  return (
    <div className="home lx" data-density="comfortable">
      {dialog}
      {needDialog}
      <TopBarSlot>
        <div className="lx-host ui-marked" data-status={verdict.status} title={verdict.sentence}>
          <span className="ui-mark lx-host__mark" aria-hidden="true" />
          <strong>{inventory?.hostname ?? "This server"}</strong>
          {inventory && <span className="lx-host__facts">{inventory.operatingSystem} · up {uptime(inventory.uptimeSeconds)}</span>}
        </div>
      </TopBarSlot>

      <header className="lx-hello">
        <h1>{greeting(clock)}</h1>
        <p className="lx-verdict"><StatusChip status={verdict.status}>{verdict.label}</StatusChip><span>{verdict.sentence}</span></p>
        <Button variant="ghost" className="lx-again" onClick={() => refresh()}>Check again</Button>
      </header>

      <div className="lx-side">
        <div className="lx-panel home-needs">
          <Section title={<><BellIcon className="lx-title-icon" />What needs you</>} status={needsStatus}>
            {urgent.length === 0
              ? <p className="lx-quiet">{checking ? "Reading this server…" : unread.length ? "Nothing wrong in what could be read." : "Nothing needs you right now."}</p>
              : <ul className="need-list">{shownNeeds.map((need) => <NeedRow key={need.id} need={need} onOpen={open} onAct={act} icon={iconFor(need)} tier="inline" run={runOf(need)} />)}</ul>}
            {justFixed.map((finding) => {
              const run = runs[finding.id];
              return <p key={finding.id} className="lx-fixed" role="status"><StatusChip status="good">{run.phase === "scheduled" ? "Scheduled" : "Fixed"}</StatusChip><span>{finding.title}. {run.phase === "fixed" ? run.changed : run.phase === "scheduled" ? run.message : ""}</span></p>;
            })}
            {urgent.length > shownUrgent && <Button variant="ghost" className="lx-more" aria-expanded={allUrgent} onClick={() => setAllUrgent((value) => !value)}>{allUrgent ? "Show fewer" : `Show all ${urgent.length}`}</Button>}
            {unread.length > 0 && <p className="lx-unread"><StatusChip status="unknown">Not read</StatusChip><span>BoxPilot could not read {sentenceList(unread)}, so this list may be missing something.</span></p>}
          </Section>
        </div>

        <div className="lx-panel home-system">
          <Section
            title={<><AreaIcon view="performance" className="lx-title-icon" />System</>}
            status={facts.inventory.state === "failed" ? { status: "unknown", label: "Not read" } : undefined}
            summary={inventory ? shortCpu(inventory.cpuModel) || countOf(inventory.cpuCount, "core") : undefined}
          >
            <div className="lx-metrics">
              <MetricTile label="Processor" value={inventory ? `${inventory.loadPercent}%` : "—"} caption={inventory ? `load ${inventory.load1.toFixed(2)} on ${countOf(inventory.cpuCount, "core")}` : notRead(facts.inventory.state)}
                status={inventory ? loadStatus(inventory.loadPercent, 80, 95) : "unknown"} bar={inventory ? { value: inventory.loadPercent } : undefined} onSelect={() => onNavigate("performance")} />
              <MetricTile label="Memory" value={inventory ? size(inventory.memoryUsed) : "—"} caption={inventory ? `of ${size(inventory.memoryTotal)} · ${inventory.memoryPercent}%` : notRead(facts.inventory.state)}
                status={inventory ? loadStatus(inventory.memoryPercent, 85, 95) : "unknown"} bar={inventory ? { value: inventory.memoryPercent } : undefined} onSelect={() => onNavigate("performance")} />
            </div>
          </Section>
        </div>

        <div className="lx-panel home-backups">
          <Section title={<><AreaIcon view="backups" className="lx-title-icon" />Backups &amp; disks</>} summary={drillWords}>
            <div className="lx-metrics">
              <MetricTile label="Apps backed up" value={verdicts ? `${recent} of ${verdicts.length}` : "—"}
                caption={!verdicts ? notRead(facts.protection.state) : never ? `${never} never backed up` : stale ? `${stale} not backed up lately` : verdicts.length ? "Each has a recent backup" : "No app holds data to back up"}
                status={!verdicts ? "unknown" : never || stale ? "warning" : "good"} bar={verdicts && verdicts.length ? { value: recent, max: verdicts.length } : undefined} onSelect={() => onNavigate("backups")} />
              <MetricTile label="Off this server" value={offBoxValue}
                caption={!offBox ? notRead(facts.offBox.state) : offBox.where.length ? sentenceList(offBox.where) : "No second copy is set up"}
                status={!offBox ? "unknown" : offBox.state === "ok" ? "good" : "warning"} onSelect={() => onNavigate("backups")} />
              <MetricTile label="BoxPilot's database" value={!database ? "—" : database.lastBackupAt ? relativeTime(database.lastBackupAt, clock) ?? "—" : "Never"}
                caption={!database ? notRead(facts.database.state) : "last backed up, with a restore drill"}
                status={!database ? "unknown" : databaseAge !== null && databaseAge <= 7 ? "good" : "warning"} onSelect={() => onNavigate("backups")} />
              {(inventory?.mounts ?? []).slice(0, 4).map((mount) => (
                <MetricTile key={mount.target} label={mountName(mount.target)} value={mount.percent === null ? "—" : `${mount.percent}%`} caption={mount.total === null ? "Size not known" : `${size(mount.used)} of ${size(mount.total)}`}
                  status={mountStatus(mount)} bar={mount.percent === null ? undefined : { value: mount.percent }} onSelect={() => onNavigate("storage")} />
              ))}
              {!inventory && <MetricTile label="Disks" value="—" caption={notRead(facts.inventory.state)} status="unknown" onSelect={() => onNavigate("storage")} />}
            </div>
          </Section>
        </div>
      </div>

      <div className="lx-main">
        <div className="lx-apps home-apps">
          <Section
            title={<><AreaIcon view="catalog" className="lx-title-icon" />Apps</>}
            status={facts.catalog.state === "failed" || (catalog && !catalog.liveKnown) ? { status: "unknown", label: "Not read" }
              : catalog ? (unwell ? { status: "warning", label: `${unwell} of ${countOf(apps.length, "app")} flagged` } : { status: apps.length ? "good" : "neutral", label: countOf(apps.length, "app") }) : undefined}
            actions={<Button variant="ghost" onClick={() => onNavigate("catalog")}>App catalog</Button>}
          >
            {facts.catalog.state === "failed" && (
              <p className="lx-quiet">Which apps are installed could not be read. <Button variant="ghost" onClick={() => refresh(["catalog"])}>Try again</Button></p>
            )}
            {catalog && !catalog.liveKnown && <p className="lx-quiet">Docker did not say which apps are installed, so none are shown. The App catalog has the details.</p>}
            {catalog && catalog.liveKnown && apps.length === 0 && (
              <p className="lx-quiet">No apps are installed yet.{values.setup?.firstRun ? <> <Button variant="primary" onClick={() => onNavigate("setup")}>Choose a setup profile</Button></> : null}</p>
            )}
            {(catalog || facts.catalog.state !== "failed") && (
              <div className="lx-tiles">
                {healths.map(({ app, health }) => (
                  <Tile
                    key={app.id}
                    name={app.name}
                    status={health.status}
                    statusLabel={health.label}
                    detail={health.detail}
                    hue={appHue(app.id)}
                    icon={app.icon ? <span className="lx-square__emoji">{app.icon}</span> : undefined}
                    className="home-tile lx-tile"
                    onSelect={() => setSheetFor(app.id)}
                  />
                ))}
                <button type="button" className="ui-tile home-tile lx-tile home-tile--add" onClick={() => onNavigate("catalog")}>
                  <span className="ui-tile__icon" aria-hidden="true"><PlusIcon /></span>
                  <span className="ui-tile__name">Add an app</span>
                  <span className="ui-tile__detail">{catalog ? `${catalog.total} in the catalog` : "From the catalog"}</span>
                </button>
              </div>
            )}
          </Section>
        </div>

        {waiting.length > 0 && (
          <div className="lx-panel lx-wait home-wait">
            <Section title={<><SparkIcon className="lx-title-icon" />Can wait</>} status={{ status: "neutral", label: String(waiting.length) }}>
              <ul className="need-list lx-wait__list">{shownWait.map((need) => <NeedRow key={need.id} need={need} onOpen={open} onAct={act} icon={iconFor(need)} tier="inline" run={runOf(need)} />)}</ul>
              {waiting.length > shownWaiting && <Button variant="ghost" className="lx-more" aria-expanded={allWaiting} onClick={() => setAllWaiting((value) => !value)}>{allWaiting ? "Show fewer" : `Show all ${waiting.length}`}</Button>}
            </Section>
          </div>
        )}
      </div>

      {sheetApp && <AppSheet app={sheetApp} protection={protectionById.get(sheetApp.id)} now={clock} role={role} onClose={() => setSheetFor(null)} onNavigate={onNavigate} onStart={start} />}
    </div>
  );
}
