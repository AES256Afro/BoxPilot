import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { openActivity, openNotifications } from "../../activityEvents";
import { countOf, sentenceList } from "../../data";
import { AppSheet } from "../../home/AppSheet";
import { backupGlance } from "../../home/backupGlance";
import { useFacts, valuesOf, type AppFact, type MountFact } from "../../home/facts";
import { elapsed, greeting, loadStatus, mountStatus, shortAge, size, uptime } from "../../home/format";
import type { HomeProps } from "../../home/Home";
import { useJobHistory, useMergedJobs } from "../../home/jobHistory";
import { NeedRow } from "../../home/NeedRow";
import { actionsOf, appHealth, buildNeeds, runs as runnable, verdictFor, verdictSources, type Need } from "../../home/needs";
import { jobTarget, performanceFrom, pushSample, sampleFrom, type Performance, type Sample } from "../../home/opsFacts";
import { useNeedActions } from "../../home/useNeedActions";
import { inspectOperation, type Job } from "../../operations";
import { overnightWindow } from "../../pages/today/today";
import { useOperation } from "../../shell/ApproveDialog";
import { AreaIcon, BellIcon, PlusIcon } from "../../shell/areaIcons";
import { TopBarSlot } from "../../shell/TopBarSlot";
import { AppIcon, Button, Sparkline, StatusChip, type Status } from "../../ui";
import "./panel.css";
import "./home.css";

/*
 * Home in Home + Ops (M41), as docs/design-directions/05-looks.html drew it (blendHome): the
 * greeting and the verdict, one glass strip of six figures, the apps beside what needs you, and
 * what ran overnight under them. The Launcher's frame, the console's contents: every figure in
 * mono, every fix with its tier in words and on its pill, cyan (the chosen accent) for what is
 * measured and amber for what to do. The same facts as every Home (src/home/facts.tsx), the same
 * list of what needs you (buildNeeds) and every fix through the approval dialog (useNeedActions).
 */

/**
 * Live figures for the strip's lines, read every fifteen seconds while the page is visible. The read
 * runs docker stats in the root helper, and Home is where everyone lands, so it is a third of Ops'
 * pace (Ops is opened on purpose); the lines start with the first read and grow from there.
 */
const homePollMs = 15_000;

function useLivePerformance(now: () => number, pollMs = homePollMs): { value: Performance | null; samples: Sample[] } {
  const [state, setState] = useState<{ value: Performance | null; samples: Sample[] }>({ value: null, samples: [] });
  const clock = useRef(now);
  clock.current = now;
  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = async () => {
      if (typeof document === "undefined" || document.visibilityState !== "hidden") {
        try {
          const { result } = await inspectOperation<unknown>("system.performance.inspect");
          const value = performanceFrom(result);
          if (live) setState((current) => ({ value, samples: pushSample(current.samples, sampleFrom(value, clock.current())) }));
        } catch { /* the inventory's figures stand in */ }
      }
      if (live) timer = setTimeout(() => void tick(), pollMs);
    };
    void tick();
    return () => { live = false; if (timer) clearTimeout(timer); };
  }, [pollMs]);
  return state;
}

/** A figure's reads as a line; one read so far is a dot where the line will start. */
function Trend({ values, floor }: { values: Array<number | null>; floor: number }) {
  const known = values.filter((value): value is number => value !== null && Number.isFinite(value));
  if (known.length >= 2) return <Sparkline values={values} floor={floor} />;
  if (known.length === 0) return null;
  return <svg className="blend-cell__dot" viewBox="0 0 64 24" preserveAspectRatio="xMaxYMid meet" aria-hidden="true" focusable="false"><circle cx="60" cy="12" r="2.4" /></svg>;
}

interface Forecast { target: string; daysToFull: number }

/** When each filesystem is expected to fill, from the nightly measure (Storage's forecast). */
function useForecasts(): Forecast[] {
  const [forecasts, setForecasts] = useState<Forecast[]>([]);
  useEffect(() => {
    let live = true;
    fetch("/api/v1/storage/forecast").then((response) => (response.ok ? response.json() : null))
      .then((body: { forecasts?: Forecast[] } | null) => { if (live && Array.isArray(body?.forecasts)) setForecasts(body.forecasts); })
      .catch(() => undefined);
    return () => { live = false; };
  }, []);
  return forecasts;
}

/** "11.0 GB" as the figure and its unit, so the unit is drawn smaller. */
function split(text: string): [string, string] {
  const match = /^(-?[\d.,]+)\s?(.*)$/.exec(text);
  return match ? [match[1], match[2]] : [text, ""];
}

/** A figure from ten up has no decimals in a caption: "212", "32", but "2.6". */
const short = (figure: string) => (Number(figure) >= 10 ? String(Math.round(Number(figure))) : figure);

/** A size in a caption, short: "32 GB". */
function shortSize(bytes: number): string {
  const [figure, unit] = split(size(bytes));
  return `${short(figure)} ${unit}`;
}

/** Sizes in a caption, short: "212 of 700 GB", "2.6 of 3.9 TB". */
function sizePair(used: number | null, total: number | null): string {
  if (used === null || total === null) return "Size not known";
  const [a, unitA] = split(size(used));
  const [b, unitB] = split(size(total));
  return unitA === unitB ? `${short(a)} of ${short(b)} ${unitB}` : `${short(a)} ${unitA} of ${short(b)} ${unitB}`;
}

/** A network share is not a drive in this server. */
const isShare = (mount: MountFact) => mount.source.startsWith("//") || /^[^/]+:\//.test(mount.source);

/** "/mnt/media" is the media drive. */
function driveName(target: string): string {
  const last = target.split("/").filter(Boolean).pop() ?? target;
  return `${last.charAt(0).toUpperCase()}${last.slice(1)} drive`;
}

interface CellProps {
  label: string;
  value: string;
  unit?: string;
  caption: string;
  status?: Status;
  bar?: number | null;
  line?: ReactNode;
  onSelect: () => void;
}

function Cell({ label, value, unit, caption, status, bar, line, onSelect }: CellProps) {
  return (
    <button type="button" className="blend-cell" data-status={status} onClick={onSelect} aria-label={`${label}: ${value}${unit ? ` ${unit}` : ""}, ${caption}`}>
      <span className="blend-cell__k">{label}</span>
      <span className="blend-cell__v">{value}{unit ? <small>{unit}</small> : null}</span>
      <span className="blend-cell__d">{caption}</span>
      {line ? <span className="blend-cell__spark" aria-hidden="true">{line}</span> : null}
      {bar !== undefined && bar !== null ? <span className="blend-cell__bar" aria-hidden="true"><i style={{ width: `${Math.max(0, Math.min(100, bar))}%` }} /></span> : null}
    </button>
  );
}

/** The overnight jobs in plain words: what was done, and what it is when it failed or still runs. */
const jobWords: Record<string, { done: string; doing: string }> = {
  "app.backup": { done: "Backed up {app}", doing: "back up {app}" },
  "app.backup.verify": { done: "Test-restored {app}", doing: "test-restore {app}" },
  "app.update": { done: "Updated {app}", doing: "update {app}" },
  "app.restore": { done: "Restored {app}", doing: "restore {app}" },
  "apt.upgrade": { done: "Installed updates", doing: "install updates" },
  "apt.refresh": { done: "Refreshed the package lists", doing: "refresh the package lists" },
  "storage.lvm.snapshot.create": { done: "Took a snapshot", doing: "take a snapshot" },
  "host.snapshot.create": { done: "Took a machine snapshot", doing: "take a machine snapshot" },
  "backup.cloud.sync": { done: "Copied the backups off this server", doing: "copy the backups off this server" },
};

/** What a job did, in the past tense, with the app's name where it had one. */
function jobSentence(job: Job, appName: (id: string) => string | null): string {
  const words = jobWords[job.type.replace(/^op:/, "")];
  if (!words) return job.title;
  const target = jobTarget(job);
  const app = target !== "—" ? appName(target) ?? target : "an app";
  const fill = (text: string) => text.replace("{app}", app);
  if (job.state === "failed") return `Could not ${fill(words.doing)}`;
  if (job.state === "completed") return fill(words.done);
  const doing = fill(words.doing);
  return `${doing.charAt(0).toUpperCase()}${doing.slice(1)}`;
}

const ran = new Set(["completed", "failed", "applying", "verifying"]);

/** The hour and minute a job started, on a 24-hour clock. */
const clockTime = (iso: string | undefined) => {
  const at = Date.parse(iso ?? "");
  return Number.isFinite(at) ? new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(at) : "—";
};

/** How many overnight jobs the panel lists; its count opens Today, which has them all. */
const shownJobs = 3;

/** What needs you and the apps, as many as the drawing has room for; "+N more" opens the rest. */
const shownNeeds = 4;
const appCells = 12;

/** Within one severity, what can be acted on from here comes first, so its button is in view. */
const actionFirst = (list: Need[]) => [...list.filter((need) => actionsOf(need).length > 0), ...list.filter((need) => actionsOf(need).length === 0)];

export default function BlendHome({ csrfToken, role, onNavigate, now = Date.now }: HomeProps) {
  const { facts, refresh, accept } = useFacts();
  const clock = now();
  const values = useMemo(() => valuesOf(facts), [facts]);
  const needs = buildNeeds(values, { now: clock, role });
  const { start, dialog } = useOperation(csrfToken, () => refresh());
  const { act, runs, remembered, dialog: needDialog } = useNeedActions({ csrfToken, refresh, accept, navigate: onNavigate });
  const performance = useLivePerformance(now);
  const forecasts = useForecasts();
  const { jobs: history } = useJobHistory();
  const jobs = useMergedJobs(history, values.jobs ?? []);
  const [sheetFor, setSheetFor] = useState<string | null>(null);
  // Everything shown, the page growing past the window, once a "+N more" is pressed.
  const [open, setOpen] = useState(false);

  const checking = verdictSources.some(([key]) => facts[key].state === "idle" || facts[key].state === "loading");
  const unread = verdictSources.filter(([key]) => facts[key].state === "failed").map(([, words]) => words);
  const inventory = values.inventory;
  const hostname = inventory?.hostname ?? "This server";
  const verdict = verdictFor(needs, { hostname, checking, unread });

  const openNeed = (need: Need) => (need.jobId ? openActivity(need.jobId) : need.id === "unannounced" ? openNotifications() : onNavigate(need.view, need.appId && need.view === "catalog" ? { app: need.appId } : undefined));
  const runOf = (need: Need) => (need.finding ? runs[need.finding.id] : undefined);
  const listed = new Set(needs.flatMap((need) => (need.finding ? [need.finding.id] : [])));
  const justFixed = Object.values(remembered).filter((finding) => !listed.has(finding.id) && runs[finding.id] && ["fixed", "scheduled"].includes(runs[finding.id].phase));
  const urgent = needs.filter((need) => need.severity !== "neutral");
  const waiting = needs.filter((need) => need.severity === "neutral");
  // Worst first, as buildNeeds sorts them; within each severity, the ones with a button first.
  const ordered = (["danger", "warning", "neutral"] as const).flatMap((severity) => actionFirst(needs.filter((need) => need.severity === severity)));
  const listedNeeds = open ? ordered : ordered.slice(0, shownNeeds);
  const moreNeeds = ordered.length - listedNeeds.length;
  const moreNeedsWords = ordered.slice(shownNeeds).every((need) => need.severity === "neutral") ? `+${moreNeeds} more can wait` : `+${moreNeeds} more`;
  // A note, with nothing to run from here, gets a tag of the tiers' shape in place of a tier.
  const noteTag = (need: Need) => (runnable(need) || need.risk ? undefined : <span className="blend-note" data-severity={need.severity}>Note</span>);

  // ── The strip: the live read when it answers, the inventory's otherwise (as Ops). ──
  const perf = performance.value;
  const samples = performance.samples;
  const cpu = perf?.cpu.usagePercent ?? inventory?.loadPercent ?? null;
  const mounts = inventory?.mounts ?? [];
  const system = mounts.find((mount) => mount.target === "/") ?? null;
  const drive = mounts.filter((mount) => mount.target !== "/" && !isShare(mount) && mount.percent !== null).sort((a, b) => (b.percent ?? 0) - (a.percent ?? 0))[0] ?? null;
  const fills = drive ? forecasts.find((forecast) => forecast.target === drive.target && forecast.daysToFull <= 90) : undefined;
  const glance = backupGlance(values, { protection: facts.protection.state, offBox: facts.offBox.state, database: facts.database.state }, clock);
  const offBox = values.offBox?.verdict ?? null;
  const hottest = perf?.temps.length ? perf.temps.reduce((best, temp) => (temp.celsius > best.celsius ? temp : best)) : null;
  const reading = (state: string) => (state === "failed" ? "Could not be read" : "Reading…");
  const [memoryFigure, memoryUnit] = split(size(inventory?.memoryUsed));

  // ── The apps: each square with its health, and its numbers or its problem under the name. ──
  const catalog = values.catalog;
  const apps = catalog?.apps ?? [];
  const protectionById = new Map((values.protection ?? []).map((entry) => [entry.id, entry]));
  const stats = new Map((perf?.statsAvailable ? perf.apps : []).map((entry) => [entry.id, entry]));
  const healths = apps.map((app) => ({ app, health: appHealth(app, protectionById.get(app.id), clock) }));
  const unwell = healths.filter(({ health }) => health.status === "danger" || health.status === "warning").length;
  // The squares the panel has room for, the add square among them; an app that needs a look is
  // never the one folded away.
  const folded = !open && healths.length > appCells - 1;
  const ailing = (status: Status) => status === "danger" || status === "warning";
  const keep = folded ? new Set([...healths.filter(({ health }) => ailing(health.status)), ...healths.filter(({ health }) => !ailing(health.status))].slice(0, appCells - 2).map(({ app }) => app.id)) : null;
  const shownApps = keep ? healths.filter(({ app }) => keep.has(app.id)) : healths;
  const moreApps = healths.length - shownApps.length;
  const sheetApp = sheetFor ? apps.find((app) => app.id === sheetFor) ?? null : null;
  const appLine = (app: AppFact, health: { status: Status; detail: string }) => {
    if (health.status === "warning" || health.status === "danger") {
      return health.detail.replace(/^Never backed up$/, "no backup").replace(/^Backup (\d+)d old$/, "backup $1 d").toLowerCase();
    }
    const measured = stats.get(app.id);
    if (measured && app.running && !app.paused) return `${measured.cpuPercent.toFixed(1)}% · ${size(measured.memBytes)}`;
    return health.detail.toLowerCase();
  };

  // ── Overnight: what ran since the evening, failures kept in view. ──
  const overnight = overnightWindow(clock);
  const night = jobs.filter((job) => ran.has(job.state) && Date.parse(job.createdAt ?? "") >= overnight.since);
  const failed = night.filter((job) => job.state === "failed");
  const shown = [...failed, ...night.filter((job) => job.state !== "failed")].slice(0, shownJobs)
    .sort((a, b) => (a.createdAt ?? "").localeCompare(b.createdAt ?? ""));
  const appName = (id: string) => apps.find((app) => app.id === id)?.name ?? null;

  const needsSummary = urgent.length && waiting.length ? `${urgent.length} + ${waiting.length} can wait`
    : urgent.length ? `${urgent.length} to look at` : waiting.length ? `${waiting.length} can wait` : checking ? "Checking" : "All clear";

  return (
    <div className={open ? "blend-home blend-home--open" : "blend-home"} data-density="comfortable">
      {dialog}
      {needDialog}
      <TopBarSlot inPlace>
        <div className="cc-crumb blend-crumb"><h1>{greeting(clock)}</h1></div>
      </TopBarSlot>

      <p className="blend-home__verdict">
        <StatusChip status={verdict.status}>{verdict.label}</StatusChip>
        <span>{verdict.sentence}</span>
      </p>

      <section className="blend-strip" aria-label="The figures">
        <Cell label="CPU" value={cpu === null ? "—" : String(Math.round(cpu))} unit={cpu === null ? undefined : "%"}
          caption={inventory ? `load ${(perf?.cpu.load1 ?? inventory.load1).toFixed(2)} · ${countOf(inventory.cpuCount, "core")}` : reading(facts.inventory.state)}
          status={loadStatus(cpu, 80, 95)} line={<Trend values={samples.map((sample) => sample.cpu)} floor={10} />} onSelect={() => onNavigate("performance")} />
        <Cell label="Memory" value={inventory ? memoryFigure : "—"} unit={inventory ? memoryUnit : undefined}
          caption={inventory ? `of ${shortSize(inventory.memoryTotal)} · ${inventory.memoryPercent}%` : reading(facts.inventory.state)}
          status={loadStatus(inventory?.memoryPercent, 85, 95)} bar={inventory?.memoryPercent} onSelect={() => onNavigate("performance")} />
        <Cell label="System disk" value={system && system.percent !== null ? String(system.percent) : "—"} unit={system && system.percent !== null ? "%" : undefined}
          caption={system ? sizePair(system.used, system.total) : reading(facts.inventory.state)} status={system ? mountStatus(system) : "unknown"} bar={system?.percent} onSelect={() => onNavigate("storage")} />
        {drive ? (
          <Cell label={driveName(drive.target)} value={String(drive.percent)} unit="%"
            caption={fills ? `fills in ~${fills.daysToFull} ${fills.daysToFull === 1 ? "day" : "days"}` : sizePair(drive.used, drive.total)}
            status={mountStatus(drive)} bar={drive.percent} onSelect={() => onNavigate("storage")} />
        ) : (
          <Cell label="Network" value={!inventory ? "—" : inventory.tailscale.connected ? "Tailnet" : "LAN"} unit={inventory?.tailscale.connected ? "up" : undefined}
            caption={inventory?.addresses[0] ? `${inventory.addresses[0].interface} ${inventory.addresses[0].address}` : reading(facts.inventory.state)} onSelect={() => onNavigate("network")} />
        )}
        <Cell label="Backups" value={glance.apps.bar ? `${glance.apps.bar.value}/${glance.apps.bar.max}` : "—"} unit={glance.apps.bar ? "apps" : undefined}
          caption={!offBox ? glance.offBox.caption : offBox.state === "ok" && offBox.lastSyncAt ? `off-box ${shortAge(offBox.lastSyncAt, clock)} ago` : `off-box: ${glance.offBox.value.toLowerCase()}`}
          status={glance.apps.status} bar={glance.apps.bar?.max ? (100 * glance.apps.bar.value) / glance.apps.bar.max : undefined} onSelect={() => onNavigate("backups")} />
        {hottest ? (
          <Cell label="Hottest" value={String(Math.round(hottest.celsius))} unit="°C" caption={hottest.label.split(":")[0]}
            status={loadStatus(hottest.celsius, 80, 90)} line={<Trend values={samples.map((sample) => sample.hottest)} floor={4} />} onSelect={() => onNavigate("performance")} />
        ) : (
          <Cell label="Uptime" value={inventory ? uptime(inventory.uptimeSeconds) : "—"} caption={inventory ? inventory.operatingSystem : reading(facts.inventory.state)} onSelect={() => onNavigate("performance")} />
        )}
      </section>

      <div className="blend-cols">
        <section className="blend-panel blend-apps" aria-labelledby="blend-apps-title">
          <header className="blend-panel__head">
            <h2 id="blend-apps-title" className="blend-panel__title"><AreaIcon view="catalog" />Apps</h2>
            {catalog && (unwell > 0
              ? <StatusChip status="warning" className="blend-panel__chip">{`${unwell} ${unwell === 1 ? "needs" : "need"} a look`}</StatusChip>
              : <span className="blend-panel__meta">{countOf(apps.length, "app")}</span>)}
          </header>
          {facts.catalog.state === "failed" && <p className="blend-quiet">Which apps are installed could not be read.</p>}
          {!catalog && facts.catalog.state !== "failed" && <p className="blend-quiet">Reading the apps…</p>}
          {catalog && !catalog.liveKnown && <p className="blend-quiet">Docker did not say which apps are installed, so none are shown.</p>}
          {catalog && catalog.liveKnown && apps.length === 0 && (
            <p className="blend-quiet">No apps are installed yet.{values.setup?.firstRun ? <> <Button variant="ghost" onClick={() => onNavigate("setup")}>Choose a setup profile</Button></> : null}</p>
          )}
          <div className="blend-apps__grid">
            {shownApps.map(({ app, health }) => (
              <button key={app.id} type="button" className="blend-app" data-status={health.status} onClick={() => setSheetFor(app.id)}>
                <span className="blend-app__square">
                  <AppIcon id={app.id} name={app.name} icon={app.icon} size="lg" className="blend-app__icon" />
                  <span className="blend-app__badge" aria-hidden="true" />
                </span>
                <b className="blend-app__name">{app.name}</b>
                <span className="ui-visually-hidden">, {health.label}. </span>
                <small className="blend-app__line">{appLine(app, health)}</small>
              </button>
            ))}
            {(moreApps > 0 || (open && healths.length > appCells - 1)) && (
              <button type="button" className="blend-app blend-app--more" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
                <span className="blend-app__square" aria-hidden="true">{open ? "−" : `+${moreApps}`}</span>
                <b className="blend-app__name">{open ? "Fewer" : `${moreApps} more`}</b>
                <span className="ui-visually-hidden">{open ? " apps. " : `${moreApps === 1 ? " app" : " apps"}. `}</span>
                <small className="blend-app__line">{open ? "fit the window" : "show all"}</small>
              </button>
            )}
            <button type="button" className="blend-app blend-app--add" onClick={() => onNavigate("catalog")}>
              <span className="blend-app__square" aria-hidden="true"><PlusIcon /></span>
              <b className="blend-app__name">Add an app</b>
              <span className="ui-visually-hidden">. </span>
              <small className="blend-app__line">{catalog ? `${catalog.total} to choose` : "from the catalog"}</small>
            </button>
          </div>
        </section>

        <section className="blend-panel blend-needs" aria-labelledby="blend-needs-title">
          <header className="blend-panel__head">
            <h2 id="blend-needs-title" className="blend-panel__title"><BellIcon />Needs you</h2>
            <span className="blend-panel__meta">{needsSummary}</span>
          </header>
          <div className="blend-needs__list">
            {needs.length === 0
              ? <p className="blend-quiet">{checking ? "Reading this server…" : unread.length ? "Nothing wrong in what could be read." : "Nothing needs you right now."}</p>
              : <ul className="need-list">{listedNeeds.map((need) => <NeedRow key={need.id} need={need} onOpen={openNeed} onAct={act} icon={noteTag(need)} tier="inline" run={runOf(need)} />)}</ul>}
            {(moreNeeds > 0 || (open && ordered.length > shownNeeds)) && (
              <button type="button" className="blend-needs__more" aria-expanded={open} onClick={() => setOpen((value) => !value)}>{open ? "Show fewer" : moreNeedsWords}</button>
            )}
            {justFixed.map((finding) => {
              const run = runs[finding.id];
              return <p key={finding.id} className="blend-quiet" role="status"><StatusChip status="good">{run.phase === "scheduled" ? "Scheduled" : "Fixed"}</StatusChip> {finding.title}.</p>;
            })}
            {unread.length > 0 && <p className="blend-quiet"><StatusChip status="unknown">Not read</StatusChip> BoxPilot could not read {sentenceList(unread)}, so this list may be missing something.</p>}
          </div>
        </section>
      </div>

      <section className="blend-panel blend-night" aria-labelledby="blend-night-title">
        <header className="blend-panel__head">
          <h2 id="blend-night-title" className="blend-panel__title"><AreaIcon view="ops" />Overnight</h2>
          {night.length > shown.length
            ? <button type="button" className="blend-panel__meta blend-night__all" onClick={() => onNavigate("today")}>{`${countOf(night.length, "job")} · ${failed.length} failed`}<span className="ui-visually-hidden">{`, ${night.length - shown.length} more on Today`}</span></button>
            : <span className="blend-panel__meta">{`${countOf(night.length, "job")} · ${failed.length} failed`}</span>}
        </header>
        {night.length === 0
          ? <p className="blend-quiet">{facts.jobs.state === "failed" ? "The jobs could not be read." : `Nothing ran ${overnight.label}.`}</p>
          : (
            <ul className="blend-night__jobs">
              {shown.map((job) => {
                const target = jobTarget(job);
                const operation = job.type.replace(/^op:/, "");
                const state = job.state === "failed" ? "failed" : job.state === "completed" ? (operation === "app.backup.verify" ? "passed" : "done") : "running";
                const from = Date.parse(job.createdAt ?? "");
                const to = Date.parse(job.updatedAt ?? "");
                return (
                  <li key={job.id} className="blend-job" data-state={state}>
                    <span className="blend-job__time">{clockTime(job.createdAt)}</span>
                    <button type="button" className="blend-job__what" onClick={() => openActivity(job.id)}>{jobSentence(job, appName)}</button>
                    <span className="blend-job__op">{operation}{target !== "—" ? ` · ${target}` : ""}</span>
                    <span className="blend-job__state"><span aria-hidden="true">● </span>{state}</span>
                    <span className="blend-job__took">{Number.isFinite(from) && Number.isFinite(to) && to >= from ? elapsed(to - from) : "—"}</span>
                  </li>
                );
              })}
            </ul>
          )}
      </section>

      {sheetApp && <AppSheet app={sheetApp} protection={protectionById.get(sheetApp.id)} now={clock} role={role} onClose={() => setSheetFor(null)} onNavigate={onNavigate} onStart={start} />}
    </div>
  );
}
