import { useMemo, useState } from "react";
import { useOperation } from "../ApproveDialog";
import { judgeProtection } from "../backupProtection";
import { countOf, sentenceList, type ViewName } from "../data";
import { PlusIcon } from "../shell/areaIcons";
import { Button, Card, MetricTile, Section, StatusChip, Tile, type Status } from "../ui";
import { AppSheet } from "./AppSheet";
import { useFacts, valuesOf } from "./facts";
import { greeting, loadStatus, mountName, mountStatus, relativeTime, size, uptime } from "./format";
import { NeedRow } from "./NeedRow";
import { appHealth, buildNeeds, verdictFor, verdictSources, type Need } from "./needs";

/*
 * Home (M33.2, ADR-004): the Launcher. It answers "is everything OK?" on one screen: a verdict
 * first, then what needs the owner, worst first, beside the installed apps as tiles with their
 * health. Every fact opens its detail; every fix shows its tier and goes through the approval
 * dialog. Comfortable density; Ops shows the same facts compactly.
 */

export interface HomeProps {
  csrfToken: string;
  role: string;
  onNavigate: (view: ViewName, options?: { app?: string }) => void;
  now?: () => number;
}

const shownNeeds = 6;

export default function Home({ csrfToken, role, onNavigate, now = Date.now }: HomeProps) {
  const { facts, refresh } = useFacts();
  const clock = now();
  const values = useMemo(() => valuesOf(facts), [facts]);
  const needs = buildNeeds(values, { now: clock, role });
  const { start, dialog } = useOperation(csrfToken, () => refresh());
  const [sheetFor, setSheetFor] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);

  const checking = verdictSources.some(([key]) => facts[key].state === "idle" || facts[key].state === "loading");
  const unread = verdictSources.filter(([key]) => facts[key].state === "failed").map(([, words]) => words);
  const inventory = facts.inventory.value;
  const hostname = inventory?.hostname ?? "This server";
  const verdict = verdictFor(needs, { hostname, checking, unread });

  const open = (need: Need) => onNavigate(need.view, need.appId && need.view === "catalog" ? { app: need.appId } : undefined);
  const act = (need: Need) => {
    if (!need.action) return;
    start({ operationId: need.action.operationId, title: need.action.title, parameters: need.action.parameters, preview: <span>{need.action.preview}</span> });
  };

  const catalog = facts.catalog.value;
  const apps = catalog?.apps ?? [];
  const protectionById = new Map((values.protection ?? []).map((entry) => [entry.id, entry]));
  const healths = apps.map((app) => ({ app, health: appHealth(app, protectionById.get(app.id), clock) }));
  const unwell = healths.filter(({ health }) => health.status === "danger" || health.status === "warning").length;
  const sheetApp = sheetFor ? apps.find((app) => app.id === sheetFor) ?? null : null;

  const worst: Status = needs.some((need) => need.severity === "danger") ? "danger" : needs.some((need) => need.severity === "warning") ? "warning" : needs.length ? "neutral" : "good";
  const needsStatus = needs.length ? { status: worst, label: String(needs.length) } : checking ? { status: "unknown" as const, label: "Checking" } : unread.length ? { status: "unknown" as const, label: "Not fully read" } : { status: "good" as const, label: "All clear" };

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

  return (
    <div className="home" data-density="comfortable">
      {dialog}
      <header className="home-hello">
        <div>
          <h1>{greeting(clock)}</h1>
          <p className="home-verdict"><StatusChip status={verdict.status}>{verdict.label}</StatusChip><span>{verdict.sentence}</span></p>
        </div>
        <Button variant="ghost" onClick={() => refresh()}>Check again</Button>
      </header>

      <div className="home-layout">
        <Card className="home-card home-needs">
          <Section title="What needs you" status={needsStatus}>
            {needs.length === 0
              ? <p className="home-quiet">{checking ? "Reading this server…" : unread.length ? "Nothing wrong in what could be read." : "Nothing needs you right now."}</p>
              : (
                <ul className="need-list">
                  {(showAll ? needs : needs.slice(0, shownNeeds)).map((need) => <NeedRow key={need.id} need={need} onOpen={open} onAct={act} />)}
                </ul>
              )}
            {needs.length > shownNeeds && <Button variant="ghost" className="home-more" aria-expanded={showAll} onClick={() => setShowAll((value) => !value)}>{showAll ? "Show fewer" : `Show all ${needs.length}`}</Button>}
            {unread.length > 0 && <p className="home-unread"><StatusChip status="unknown">Not read</StatusChip><span>BoxPilot could not read {sentenceList(unread)}, so this list may be missing something.</span></p>}
          </Section>
        </Card>

        <Card className="home-card home-apps">
          <Section
            title="Apps"
            status={facts.catalog.state === "failed" || (catalog && !catalog.liveKnown) ? { status: "unknown", label: "Not read" }
              : catalog ? (unwell ? { status: "warning", label: `${unwell} need a look` } : { status: apps.length ? "good" : "neutral", label: countOf(apps.length, "app") }) : undefined}
            actions={<Button variant="ghost" onClick={() => onNavigate("catalog")}>App catalog</Button>}
          >
            {facts.catalog.state === "failed" && (
              <p className="home-quiet">Which apps are installed could not be read. <Button variant="ghost" onClick={() => refresh(["catalog"])}>Try again</Button></p>
            )}
            {catalog && !catalog.liveKnown && <p className="home-quiet">Docker did not say which apps are installed, so none are shown. The App catalog has the details.</p>}
            {catalog && catalog.liveKnown && apps.length === 0 && (
              <p className="home-quiet">No apps are installed yet.{values.setup?.firstRun ? <> <Button variant="primary" onClick={() => onNavigate("setup")}>Choose a setup profile</Button></> : null}</p>
            )}
            {(catalog || facts.catalog.state !== "failed") && (
              <div className="home-tiles">
                {healths.map(({ app, health }) => (
                  <Tile
                    key={app.id}
                    name={app.name}
                    status={health.status}
                    statusLabel={health.label}
                    detail={health.detail}
                    icon={app.icon ? <span className="home-tile__emoji">{app.icon}</span> : undefined}
                    className={app.icon ? "home-tile home-tile--emoji" : "home-tile"}
                    onSelect={() => setSheetFor(app.id)}
                  />
                ))}
                <button type="button" className="ui-tile home-tile home-tile--add" onClick={() => onNavigate("catalog")}>
                  <span className="ui-tile__icon" aria-hidden="true"><PlusIcon /></span>
                  <span className="ui-tile__name">Add an app</span>
                  <span className="ui-tile__detail">{catalog ? `${catalog.total} in the catalog` : "From the catalog"}</span>
                </button>
              </div>
            )}
          </Section>
        </Card>

        <Card className="home-card home-system">
          <Section
            title="System"
            status={facts.inventory.state === "failed" ? { status: "unknown", label: "Not read" } : undefined}
            summary={inventory ? `${inventory.operatingSystem} · up ${uptime(inventory.uptimeSeconds)}` : undefined}
          >
            <div className="home-metrics">
              <MetricTile label="Processor" value={inventory ? `${inventory.loadPercent}%` : "—"} caption={inventory ? `load ${inventory.load1.toFixed(2)} on ${countOf(inventory.cpuCount, "core")}` : notRead(facts.inventory.state)}
                status={inventory ? loadStatus(inventory.loadPercent, 80, 95) : "unknown"} bar={inventory ? { value: inventory.loadPercent } : undefined} onSelect={() => onNavigate("performance")} />
              <MetricTile label="Memory" value={inventory ? size(inventory.memoryUsed) : "—"} caption={inventory ? `of ${size(inventory.memoryTotal)} · ${inventory.memoryPercent}%` : notRead(facts.inventory.state)}
                status={inventory ? loadStatus(inventory.memoryPercent, 85, 95) : "unknown"} bar={inventory ? { value: inventory.memoryPercent } : undefined} onSelect={() => onNavigate("performance")} />
              {(inventory?.mounts ?? []).slice(0, 4).map((mount) => (
                <MetricTile key={mount.target} label={mountName(mount.target)} value={mount.percent === null ? "—" : `${mount.percent}%`} caption={mount.total === null ? "Size not known" : `${size(mount.used)} of ${size(mount.total)}`}
                  status={mountStatus(mount)} bar={mount.percent === null ? undefined : { value: mount.percent }} onSelect={() => onNavigate("storage")} />
              ))}
            </div>
          </Section>
        </Card>

        <Card className="home-card home-backups">
          <Section title="Backups">
            <div className="home-metrics">
              <MetricTile label="Apps backed up" value={verdicts ? `${recent} of ${verdicts.length}` : "—"}
                caption={!verdicts ? notRead(facts.protection.state) : never ? `${never} never backed up` : stale ? `${stale} not backed up lately` : verdicts.length ? "Each has a recent backup" : "No app holds data to back up"}
                status={!verdicts ? "unknown" : never || stale ? "warning" : "good"} bar={verdicts && verdicts.length ? { value: recent, max: verdicts.length } : undefined} onSelect={() => onNavigate("backups")} />
              <MetricTile label="Off this server" value={offBoxValue}
                caption={!offBox ? notRead(facts.offBox.state) : offBox.where.length ? sentenceList(offBox.where) : "No second copy is set up"}
                status={!offBox ? "unknown" : offBox.state === "ok" ? "good" : "warning"} onSelect={() => onNavigate("backups")} />
              <MetricTile label="BoxPilot's database" value={!database ? "—" : database.lastBackupAt ? relativeTime(database.lastBackupAt, clock) ?? "—" : "Never"}
                caption={!database ? notRead(facts.database.state) : "last backed up, with a restore drill"}
                status={!database ? "unknown" : databaseAge !== null && databaseAge <= 7 ? "good" : "warning"} onSelect={() => onNavigate("backups")} />
            </div>
          </Section>
        </Card>
      </div>

      {sheetApp && <AppSheet app={sheetApp} protection={protectionById.get(sheetApp.id)} now={clock} role={role} onClose={() => setSheetFor(null)} onNavigate={onNavigate} onStart={start} />}
    </div>
  );
}
