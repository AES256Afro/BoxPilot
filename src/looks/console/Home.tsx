import { useMemo, useState } from "react";
import { openActivity, openNotifications } from "../../activityEvents";
import { countOf, sentenceList } from "../../data";
import { backupGlance } from "../../home/backupGlance";
import { AppSheet } from "../../home/AppSheet";
import { useFacts, valuesOf } from "../../home/facts";
import { elapsed, greeting, loadStatus, mountName, mountStatus, relativeTime, size, uptime } from "../../home/format";
import type { HomeProps } from "../../home/Home";
import { useJobHistory, useMergedJobs } from "../../home/jobHistory";
import { NeedRow } from "../../home/NeedRow";
import { appHealth, buildNeeds, runs, verdictFor, verdictSources, type Need } from "../../home/needs";
import { figure, usePerformance } from "../../home/Ops";
import { jobState, jobTarget } from "../../home/opsFacts";
import { useCheckAgain } from "../../home/useCheckAgain";
import { useNeedActions } from "../../home/useNeedActions";
import { overnightWindow } from "../../pages/today/today";
import { PlusIcon } from "../../shell/areaIcons";
import { useOperation } from "../../shell/ApproveDialog";
import { TopBarSlot } from "../../shell/TopBarSlot";
import { AppIcon, Button, MetricStrip, MetricTile, Panel, Sparkline, StatusChip } from "../../ui";
import "./home.css";

/*
 * Home in the Command Center (M41, "Ops everywhere"): the console's compact bar names the server
 * and its facts, then one verdict line, the six figures Ops leads with, and two columns: the apps as
 * a compact grid with their state in words and what ran last night on the left, the action inbox
 * led by each fix's tier and the backups on the right. The same facts as every Home
 * (src/home/facts.tsx), the same list of what needs you (buildNeeds), and every fix through the
 * approval dialog at its tier (useNeedActions). Drawn to docs/design-directions/05-looks.html,
 * M.opsHome.
 */

/** Rows of last night's jobs; the rest are a click away in Activity. */
const shownJobs = 3;

/** A job's time of day, as the drawing's first column has it: "03:02". */
function clockTime(iso: string | undefined, fallback = "—"): string {
  const at = Date.parse(iso ?? "");
  if (!Number.isFinite(at)) return fallback;
  return new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
}

export default function ConsoleHome({ csrfToken, role, onNavigate, now = Date.now }: HomeProps) {
  const { facts, refresh, accept } = useFacts();
  const clock = now();
  const values = useMemo(() => valuesOf(facts), [facts]);
  const needs = buildNeeds(values, { now: clock, role });
  const performance = usePerformance(5000, now);
  const { jobs: history } = useJobHistory();
  const jobs = useMergedJobs(history, values.jobs ?? []);
  // The app sheet's own buttons; every button in the inbox goes through useNeedActions (M35).
  const { start, dialog } = useOperation(csrfToken, () => refresh());
  const { act, runs: fixRuns, dialog: needDialog } = useNeedActions({ csrfToken, refresh, accept, navigate: onNavigate });
  const again = useCheckAgain(refresh);
  const [sheetFor, setSheetFor] = useState<string | null>(null);

  const inventory = values.inventory;
  const hostname = inventory?.hostname ?? "This server";
  const checking = verdictSources.some(([key]) => facts[key].state === "idle" || facts[key].state === "loading");
  const unread = verdictSources.filter(([key]) => facts[key].state === "failed").map(([, words]) => words);
  const verdict = verdictFor(needs, { hostname, checking, unread });

  const open = (need: Need) => (need.jobId ? openActivity(need.jobId) : need.id === "unannounced" ? openNotifications() : onNavigate(need.view, need.appId && need.view === "catalog" ? { app: need.appId } : undefined));
  const runOf = (need: Need) => (need.finding ? fixRuns[need.finding.id] : undefined);

  // ── The six figures: the live read when it answers, the inventory's otherwise (as Ops). ──
  const perf = performance.value;
  const samples = performance.samples;
  const cpu = perf?.cpu.usagePercent ?? null;
  const memoryUsed = perf?.memory.usedBytes ?? inventory?.memoryUsed ?? null;
  const memoryTotal = perf?.memory.totalBytes ?? inventory?.memoryTotal ?? null;
  const memoryPercent = perf?.memory.usedPercent ?? inventory?.memoryPercent ?? null;
  const hottest = perf?.temps.length ? Math.max(...perf.temps.map((temp) => temp.celsius)) : null;
  const mounts = inventory?.mounts ?? [];
  const tailscale = inventory?.tailscale ?? null;
  const lan = inventory?.addresses.find((address) => address.interface !== "tailscale0" && /^\d+\.\d+\.\d+\.\d+$/.test(address.address)) ?? null;
  const reading = facts.inventory.state === "failed" ? "Could not be read" : "Reading…";

  // ── The apps, each with its state in a few words. ──
  const catalog = values.catalog;
  const apps = catalog?.apps ?? [];
  const protectionById = new Map((values.protection ?? []).map((entry) => [entry.id, entry]));
  const cpuById = new Map((perf?.apps ?? []).map((app) => [app.id, app.cpuPercent]));
  const cells = apps.map((app) => {
    const health = appHealth(app, protectionById.get(app.id), clock);
    const share = cpuById.get(app.id);
    const words = health.status === "good" ? (share === undefined ? "up" : `up · ${share.toFixed(1)}%`) : health.detail.charAt(0).toLowerCase() + health.detail.slice(1);
    return { app, health, words };
  });
  const up = apps.filter((app) => app.running && !app.paused).length;
  const unwell = cells.filter(({ health }) => health.status === "warning" || health.status === "danger").length;
  const sheetApp = sheetFor ? apps.find((app) => app.id === sheetFor) ?? null : null;

  // ── What ran last night: the window Today reads, oldest first, as a log is read. ──
  const night = overnightWindow(clock);
  const ran = jobs.filter((job) => ["completed", "failed", "applying", "verifying"].includes(job.state) && Date.parse(job.updatedAt ?? job.createdAt ?? "") >= night.since)
    .sort((a, b) => (a.createdAt ?? "").localeCompare(b.createdAt ?? ""));
  const failed = ran.filter((job) => job.state === "failed").length;
  const shownRan = ran.slice(-shownJobs);
  const took = (job: (typeof ran)[number]) => {
    const from = Date.parse(job.createdAt ?? "");
    if (!Number.isFinite(from)) return "—";
    if (job.state === "applying" || job.state === "verifying") return elapsed(clock - from);
    const to = Date.parse(job.updatedAt ?? "");
    return Number.isFinite(to) ? elapsed(to - from) : "—";
  };

  // ── Backups at a glance, from the same verdicts Home's panel uses. ──
  const glance = backupGlance(values, { protection: facts.protection.state, offBox: facts.offBox.state, database: facts.database.state }, clock);
  const lastDrill = apps.flatMap((app) => (app.drill?.checkedAt ? [app.drill] : [])).sort((a, b) => (b.checkedAt ?? "").localeCompare(a.checkedAt ?? ""))[0] ?? null;
  const drillWords = lastDrill ? `${lastDrill.verified ? "drill passed" : "drill failed"} ${relativeTime(lastDrill.checkedAt, clock) ?? ""}`.trim() : undefined;
  const appsBar = glance.apps.bar ? Math.round((glance.apps.bar.value / (glance.apps.bar.max || 1)) * 100) : null;

  // The inbox: every need, those with a fix first, each led by its tier; then the notes, which have
  // none. Worst first within each, as buildNeeds sorts them.
  const inbox = [...needs.filter((need) => runs(need)), ...needs.filter((need) => !runs(need))];
  const runnable = needs.filter((need) => runs(need)).length;

  return (
    <div className="console-home cc" data-density="compact">
      {dialog}
      {needDialog}
      <TopBarSlot inPlace>
        <div className="cc-crumb ui-crumb console-crumb">
          <span className="cc-crumb__host">{inventory?.hostname ?? "boxpilot"}</span>
          <span className="cc-crumb__sep" aria-hidden="true">/</span>
          <span className="console-crumb__page">home</span>
          {inventory && <span className="cc-kv">{inventory.operatingSystem} · up <b>{uptime(inventory.uptimeSeconds)}</b> · kernel <b>{inventory.kernel}</b></span>}
        </div>
      </TopBarSlot>

      <header className="console-verdict">
        <StatusChip status={verdict.status} className="console-verdict__chip">{verdict.label}</StatusChip>
        <div className="console-verdict__words">
          <h1 className="console-verdict__hello">{greeting(clock)}.</h1>
          <p className="console-verdict__sentence">{verdict.sentence}</p>
        </div>
        {again.said}
        <Button variant="ghost" className="console-verdict__again" busy={again.checking} onClick={again.run}>{again.checking ? "Reading…" : "Read again"}</Button>
      </header>

      <MetricStrip label="Processor, memory, disks, network and temperature" className="console-strip" minTile="9.5rem">
        <MetricTile label="CPU" value={cpu === null ? (inventory ? figure(`${inventory.loadPercent}%`) : "—") : figure(`${Math.round(cpu)}%`)}
          caption={perf ? `load ${perf.cpu.load1.toFixed(2)} · ${countOf(perf.cpu.cores, "core")}` : inventory ? `load ${inventory.load1.toFixed(2)} · ${countOf(inventory.cpuCount, "core")}` : performance.failed ? "Could not be read" : reading}
          status={cpu === null && !inventory ? "unknown" : loadStatus(cpu ?? inventory?.loadPercent, 80, 95)}
          graphic={<Sparkline values={samples.map((sample) => sample.cpu)} floor={10} />} onSelect={() => onNavigate("performance")} />
        <MetricTile label="Memory" value={memoryUsed === null ? "—" : figure(size(memoryUsed))}
          caption={memoryTotal === null ? reading : `of ${size(memoryTotal)} · ${memoryPercent}%`}
          status={memoryPercent === null ? "unknown" : loadStatus(memoryPercent, 85, 95)} bar={memoryPercent === null ? undefined : { value: memoryPercent }} onSelect={() => onNavigate("performance")} />
        {mounts.slice(0, 2).map((mount) => (
          <MetricTile key={mount.target} label={mountName(mount.target)} value={mount.percent === null ? "—" : figure(`${mount.percent}%`)}
            caption={mount.total === null ? "Size not known" : `${size(mount.used)} of ${size(mount.total)}`} status={mountStatus(mount)}
            bar={mount.percent === null ? undefined : { value: mount.percent }} onSelect={() => onNavigate("storage")} />
        ))}
        {!inventory && <MetricTile label="Disks" value="—" caption={reading} status="unknown" onSelect={() => onNavigate("storage")} />}
        <MetricTile label="Network" value={!tailscale ? "—" : tailscale.connected ? <>Tailnet<small>up</small></> : tailscale.installed ? <>Tailnet<small>down</small></> : "LAN only"}
          caption={lan ? `${lan.interface} · LAN${tailscale?.connected ? " + tailnet" : ""}` : inventory ? "No LAN address" : reading}
          status={!tailscale ? "unknown" : tailscale.connected || !tailscale.installed ? "good" : "warning"} onSelect={() => onNavigate("network")} />
        <MetricTile label={hottest === null ? "Uptime" : "Hottest"} value={hottest === null ? (inventory ? uptime(inventory.uptimeSeconds) : "—") : figure(`${Math.round(hottest)}°C`)}
          caption={hottest === null ? (inventory ? inventory.operatingSystem : reading) : perf!.temps.find((temp) => temp.celsius === hottest)?.label.split(":")[0] ?? ""}
          status={hottest === null ? (inventory ? "neutral" : "unknown") : loadStatus(hottest, 80, 90)}
          graphic={hottest === null ? undefined : <Sparkline values={samples.map((sample) => sample.hottest)} floor={4} />} onSelect={() => onNavigate("performance")} />
      </MetricStrip>

      <div className="console-grid">
        <div className="console-col">
          <Panel className="console-apps" title="Apps"
            count={facts.catalog.state === "failed" || (catalog && !catalog.liveKnown) ? { status: "unknown", label: "not read" } : undefined}
            meta={catalog?.liveKnown ? <>{apps.length} installed · {up} up{unwell ? ` · ${unwell} need a look` : ""}</> : undefined}>
            {facts.catalog.state === "failed" && <p className="ops-quiet">Which apps are installed could not be read.</p>}
            {catalog && !catalog.liveKnown && <p className="ops-quiet">Docker did not say which apps are installed. The App catalog has the details.</p>}
            <ul className="console-apps__grid">
              {cells.map(({ app, health, words }) => (
                <li key={app.id}>
                  <button type="button" className="console-app ui-marked" data-status={health.status} onClick={() => setSheetFor(app.id)} aria-label={`${app.name}, ${health.label}`}>
                    <AppIcon id={app.id} name={app.name} icon={app.icon} className="console-app__icon" />
                    <span className="console-app__name">{app.name}</span>
                    <span className="console-app__state"><span className="ui-mark" aria-hidden="true" />{words}</span>
                  </button>
                </li>
              ))}
              <li>
                <button type="button" className="console-app console-app--add" onClick={() => onNavigate("catalog")}>
                  <span className="console-app__icon console-app__plus" aria-hidden="true"><PlusIcon /></span>
                  <span className="console-app__name">Add an app</span>
                  <span className="console-app__state">{catalog ? `${catalog.total} in the catalog` : "From the catalog"}</span>
                </button>
              </li>
            </ul>
          </Panel>

          <Panel className="console-night" title={night.label === "since 06:00" ? "Today" : "Last night"}
            count={facts.jobs.state === "failed" ? { status: "unknown", label: "not read" } : undefined}
            meta={<>{failed} failed{ran.length > shownJobs ? ` · ${ran.length} ran` : ""}</>}
            footer={ran.length > shownJobs ? <button type="button" className="ops-link console-night__more" onClick={() => openActivity()}>And {ran.length - shownJobs} more in Activity</button> : undefined}>
            {shownRan.length === 0
              ? <p className="ops-quiet">{facts.jobs.state === "failed" ? "Job history could not be read." : `Nothing ran ${night.label}.`}</p>
              : (
                <table className="console-jobs">
                  <caption className="ui-visually-hidden">What ran {night.label}</caption>
                  <thead className="ui-visually-hidden"><tr><th scope="col">Time</th><th scope="col">Operation</th><th scope="col">Target</th><th scope="col">State</th><th scope="col">Took</th></tr></thead>
                  <tbody>
                    {shownRan.map((job) => {
                      const state = jobState(job);
                      const word = job.state === "completed" && state.label === "Completed" ? "done" : state.label.toLowerCase();
                      const operation = job.type.replace(/^op:/, "");
                      return (
                        <tr key={job.id}>
                          <td className="console-jobs__dim">{clockTime(job.createdAt)}</td>
                          <td><button type="button" className="ops-link ops-link--mono" onClick={() => openActivity(job.id)} aria-label={`${operation}: open its log`} title={job.title}>{operation}</button></td>
                          <td>{jobTarget(job)}</td>
                          <td className="console-jobs__state ui-marked" data-status={state.status}><span className="ui-mark" aria-hidden="true" />{word}</td>
                          <td className="console-jobs__dim console-jobs__took">{took(job)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
          </Panel>
        </div>

        <div className="console-col">
          <Panel className="console-inbox" title="Action inbox" count={runnable ? undefined : { status: checking ? "unknown" : "good", label: checking ? "reading" : "0" }}
            meta={<><b>L</b> one click · <b>M</b> preview · <b>H</b> password</>}>
            {needs.length === 0
              ? <p className="ops-quiet">{checking ? "Reading this server…" : unread.length ? `Nothing wrong in what could be read. Not read: ${sentenceList(unread)}.` : "Nothing needs you right now."}</p>
              : <ul className="need-list">{inbox.map((need) => <NeedRow key={need.id} need={need} onOpen={open} onAct={act} tier="lead" run={runOf(need)} />)}</ul>}
          </Panel>

          <Panel className="console-backups" title="Backups" meta={drillWords}>
            <button type="button" className="console-kv ui-marked" data-status={glance.apps.status} onClick={() => onNavigate("backups")}>
              <span className="console-kv__label">Apps backed up</span>
              <b className="console-kv__value">{glance.apps.value}</b>
              {appsBar !== null && <span className="console-kv__bar" aria-hidden="true"><i style={{ width: `${appsBar}%` }} /></span>}
              <span className="ui-visually-hidden">. {glance.apps.caption}</span>
            </button>
            <button type="button" className="console-kv ui-marked" data-status={glance.offBox.status} onClick={() => onNavigate("backups")}>
              <span className="console-kv__label">Off this server</span>
              <b className="console-kv__value">{glance.offBox.value}</b>
              <span className="ui-visually-hidden">. {glance.offBox.caption}</span>
            </button>
          </Panel>
        </div>
      </div>

      {sheetApp && <AppSheet app={sheetApp} protection={protectionById.get(sheetApp.id)} now={clock} role={role} onClose={() => setSheetFor(null)} onNavigate={onNavigate} onStart={start} />}
    </div>
  );
}

