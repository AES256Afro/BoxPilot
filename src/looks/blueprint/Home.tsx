import { useEffect, useId, useMemo, useState } from "react";
import { openActivity, openNotifications } from "../../activityEvents";
import type { HomeProps } from "../../home/Home";
import { useFacts, valuesOf, type AppFact, type MountFact } from "../../home/facts";
import { greeting, size, uptime } from "../../home/format";
import { actionsOf, appHealth, buildNeeds, runs, verdictFor, verdictSources, type Need } from "../../home/needs";
import { usePerformance } from "../../home/Ops";
import { runWords, useNeedActions } from "../../home/useNeedActions";
import { dockAreas } from "../../shell/ShellNav";
import { TopBarSlot } from "../../shell/TopBarSlot";
import { Button } from "../../ui";
import type { RiskTier } from "../../ui/types";
import "./home.css";

/*
 * Home as a blueprint (M41; docs/design-directions/05-looks.html, M.blueprint): the server as a
 * general arrangement drawing, built from the same facts as every other Home. The apps are the
 * parts in the Docker enclosure, the fullest data drive and the system disk are dimensioned to
 * scale, what needs the owner is the sheet's general notes, numbered, with a triangle on each part
 * a note refers to, and the loads and the title block sit at the foot of the notes. Every fix is a
 * real button through the approval dialog at its tier; every part and figure opens its page.
 */

const tierWord: Record<RiskTier, string> = { low: "LOW", medium: "MED", high: "HIGH" };

/** An app's name as the drawing labels a part: without what is in brackets or after a plus. */
export function partName(name: string): string {
  const short = name.replace(/\s*\(.*\)\s*$/, "").replace(/\s*\+.*$/, "").trim() || name;
  return short.length > 13 ? `${short.slice(0, 12)}…` : short;
}

/** Bytes as a drawing writes them: "70MB", "1.4GB". */
const tight = (bytes: number | null | undefined) => (bytes === null || bytes === undefined ? "—" : size(bytes).replace(" ", ""));

/**
 * The apps a note is about: the one it names, or those its fix is for (a Repair finding's
 * parameters), or else those its words name.
 */
export function appsOfNeed(need: Need, apps: AppFact[]): string[] {
  if (need.appId) return [need.appId];
  const ids = new Set<string>();
  const known = new Set(apps.map((app) => app.id));
  const take = (value: unknown) => { if (typeof value === "string" && known.has(value)) ids.add(value); };
  for (const fix of need.finding ? [need.finding.fix, ...(need.finding.fixes ?? [])] : []) {
    const parameters = (fix?.parameters ?? {}) as { id?: unknown; ids?: unknown };
    take(parameters.id);
    if (Array.isArray(parameters.ids)) parameters.ids.forEach(take);
    for (const schedule of (fix as { schedules?: Array<{ parameters?: { id?: unknown } }> } | null)?.schedules ?? []) take(schedule.parameters?.id);
  }
  if (ids.size) return [...ids];
  const words = [need.title, need.detail ?? "", ...(need.finding?.evidence ?? [])].join(" ").toLowerCase();
  return apps.filter((app) => words.includes(partName(app.name).replace("…", "").toLowerCase())).map((app) => app.id);
}

/** The data drive to dimension: the fullest mount that is not the system disk or a boot partition. */
export function dataDrive(mounts: MountFact[]): MountFact | null {
  return mounts.filter((mount) => mount.target !== "/" && !mount.target.startsWith("/boot") && mount.total !== null && mount.percent !== null)
    .sort((a, b) => (b.percent ?? 0) - (a.percent ?? 0))[0] ?? null;
}

interface Forecast { target: string; daysToFull: number }

/** When each drive fills at the rate it has been filling, as Storage reads it; none when not read. */
function useForecasts(): Forecast[] {
  const [forecasts, setForecasts] = useState<Forecast[]>([]);
  useEffect(() => {
    let live = true;
    fetch("/api/v1/storage/forecast")
      .then((response) => (response.ok ? response.json() : null))
      .then((body: { forecasts?: Forecast[] } | null) => { if (live && Array.isArray(body?.forecasts)) setForecasts(body.forecasts); })
      .catch(() => undefined);
    return () => { live = false; };
  }, []);
  return forecasts;
}

/** When the facts were last read: the time in the title block's CHECKED box. */
function useCheckedAt(read: unknown, now: () => number): number | null {
  const [at, setAt] = useState<number | null>(null);
  useEffect(() => { if (read) setAt(now()); }, [read]); // eslint-disable-line react-hooks/exhaustive-deps
  return at;
}

/** A drive's figures in one unit, the total's: "2.65 / 3.90 TB", "212 / 800 GB". */
export function driveFigures(used: number | null, total: number | null): { used: string; total: string; unit: string } {
  const tera = (total ?? 0) >= 1024 ** 4;
  const div = tera ? 1024 ** 4 : 1024 ** 3;
  const figure = (bytes: number | null) => (bytes === null ? "—" : tera ? (bytes / div).toFixed(2) : String(Math.round(bytes / div)));
  return { used: figure(used), total: figure(total), unit: tera ? "TB" : "GB" };
}

const clockTime = (at: number | null) => (at === null ? "—" : new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false }));
const deviceName = (source: string) => (source.startsWith("/dev/mapper/") ? "LVM" : source.replace(/^\/dev\//, "") || "—");

/** The note's triangle with its number, as the drawing marks a note and each part it is about. */
function Marker({ n, className }: { n: number; className: string }) {
  return (
    <svg className={className} viewBox="0 0 18 16" aria-hidden="true">
      <path d="M9 1 L17 15 H1 Z" />
      <text x="9" y="13" textAnchor="middle" fontSize={n >= 10 ? 5.6 : undefined}>{n}</text>
    </svg>
  );
}

export default function BlueprintHome({ csrfToken, role, onNavigate, now = Date.now }: HomeProps) {
  const { facts, refresh, accept } = useFacts();
  const clock = now();
  const values = useMemo(() => valuesOf(facts), [facts]);
  const needs = buildNeeds(values, { now: clock, role });
  const { act, runs: fixRuns, dialog } = useNeedActions({ csrfToken, refresh, accept, navigate: onNavigate });
  const performance = usePerformance(15_000, now);
  const forecasts = useForecasts();
  const checkedAt = useCheckedAt(facts.inventory.value, now);
  const titleId = useId();

  const inventory = values.inventory;
  const hostname = inventory?.hostname ?? "This server";
  const checking = verdictSources.some(([key]) => facts[key].state === "idle" || facts[key].state === "loading");
  const unread = verdictSources.filter(([key]) => facts[key].state === "failed").map(([, words]) => words);
  const verdict = verdictFor(needs, { hostname, checking, unread });

  // The notes: what needs a look first, then what can wait, numbered in that order.
  const notes = [...needs.filter((need) => need.severity !== "neutral"), ...needs.filter((need) => need.severity === "neutral")];
  const apps = values.catalog?.apps ?? [];
  const noteOf = new Map<string, number[]>();
  notes.forEach((need, index) => appsOfNeed(need, apps).forEach((id) => noteOf.set(id, [...(noteOf.get(id) ?? []), index + 1])));
  const protectionById = new Map((values.protection ?? []).map((entry) => [entry.id, entry]));
  const perf = performance.value;
  const measured = new Map((perf?.statsAvailable ? perf.apps : []).map((entry) => [entry.id, entry]));
  // Twelve parts fill the enclosure; past that, the twelfth says how many more the catalog has.
  const shownParts = apps.length > 12 ? apps.slice(0, 11) : apps;

  const open = (need: Need) => (need.jobId ? openActivity(need.jobId) : need.id === "unannounced" ? openNotifications() : onNavigate(need.view, need.appId && need.view === "catalog" ? { app: need.appId } : undefined));

  // ── The drives: the fullest data drive dimensioned, the system disk under it. ──
  const mounts = inventory?.mounts ?? [];
  const media = dataDrive(mounts);
  const system = mounts.find((mount) => mount.target === "/") ?? null;
  const fstype = (target: string) => (perf?.disks.find((disk) => disk.mount === target) as { fstype?: string } | undefined)?.fstype;
  const mediaSize = driveFigures(media?.used ?? null, media?.total ?? null);
  const systemSize = driveFigures(system?.used ?? null, system?.total ?? null);
  const fills = media ? forecasts.find((forecast) => forecast.target === media.target) : undefined;

  // ── The loads table. ──
  const cpu = perf?.cpu.usagePercent ?? inventory?.loadPercent ?? null;
  const hottest = perf?.temps.length ? Math.round(Math.max(...perf.temps.map((temp) => temp.celsius))) : null;
  const memUsed = perf?.memory.usedBytes ?? inventory?.memoryUsed ?? null;
  const memTotal = perf?.memory.totalBytes ?? inventory?.memoryTotal ?? null;
  const tailscale = inventory?.tailscale ?? null;
  const net = !tailscale ? "—" : tailscale.connected ? "TAILNET UP" : tailscale.installed ? "TAILNET DOWN" : "LAN ONLY";
  const gb = (bytes: number | null) => (bytes === null ? "—" : (bytes / 1024 ** 3).toFixed(bytes / 1024 ** 3 >= 100 ? 0 : 1));

  const sub = [inventory?.operatingSystem, inventory ? `UP ${uptime(inventory.uptimeSeconds).replace(/(\d+)([dhm])/g, "$1 $2")}` : null].filter(Boolean).join(" · ");

  return (
    <div className="blueprint-home">
      {dialog}
      <h1 className="ui-visually-hidden">{greeting(clock)}</h1>
      <TopBarSlot inPlace>
        <p className="blueprint-title" id={titleId}>{hostname} · General arrangement</p>
      </TopBarSlot>
      <p className="blueprint-sub" role="status">{sub ? `${sub} · ` : ""}{verdict.sentence}</p>

      <div className="blueprint-sheet">
        <div className="blueprint-left">
          <section className="blueprint-enclosure" aria-label="Apps">
            <h2 className="blueprint-enclosure__label">Enclosure: Docker · {apps.length} {apps.length === 1 ? "part" : "parts"}</h2>
            {facts.catalog.state === "failed" && <p className="blueprint-quiet">Which apps are installed could not be read.</p>}
            {values.catalog && apps.length === 0 && <p className="blueprint-quiet">No apps are installed yet. <button type="button" className="blueprint-link" onClick={() => onNavigate(values.setup?.firstRun ? "setup" : "catalog")}>{values.setup?.firstRun ? "Choose a setup profile" : "Add an app"}</button></p>}
            <ul className="blueprint-parts">
              {shownParts.map((app) => {
                const health = appHealth(app, protectionById.get(app.id), clock);
                const stats = measured.get(app.id);
                const live = app.running || app.paused;
                const state = !live ? (app.status === "restarting" ? "RESTARTING" : app.status === "absent" ? "NO CONTAINER" : "STOPPED") : app.paused ? "PAUSED" : null;
                const refs = noteOf.get(app.id) ?? [];
                return (
                  <li key={app.id}>
                    <button type="button" className="blueprint-part" data-status={health.status} onClick={() => onNavigate("catalog", { app: app.id })}
                      aria-label={`${app.name}, ${health.label}${refs.length ? `, see note ${refs.join(" and ")}` : ""}`}>
                      <svg className="blueprint-part__drawing" viewBox="0 0 92 52" aria-hidden="true">
                        <rect className="blueprint-part__box" x="0.5" y="0.5" width="91" height="51" />
                        <text className="blueprint-part__name" x="7" y="19">{partName(app.name).toUpperCase()}</text>
                        <text className="blueprint-part__fact" x="7" y="33">{app.port === null ? "NO PORT" : `:${app.port}`} · {tight(live && stats ? stats.memBytes : null)}</text>
                        <text className="blueprint-part__fact" x="7" y="44">{state ?? `CPU ${stats && live ? `${stats.cpuPercent.toFixed(1)}%` : "—"}`}</text>
                      </svg>
                      {refs.length > 0 && <Marker n={refs[0]} className="blueprint-part__marker" />}
                    </button>
                  </li>
                );
              })}
              {apps.length > shownParts.length && (
                <li>
                  <button type="button" className="blueprint-part blueprint-part--more" onClick={() => onNavigate("catalog")}>
                    <svg className="blueprint-part__drawing" viewBox="0 0 92 52" aria-hidden="true">
                      <rect className="blueprint-part__box" x="0.5" y="0.5" width="91" height="51" />
                      <text className="blueprint-part__name" x="46" y="30" textAnchor="middle">+{apps.length - shownParts.length} MORE</text>
                    </svg>
                    <span className="ui-visually-hidden">{apps.length - shownParts.length} more apps in the App catalog</span>
                  </button>
                </li>
              )}
            </ul>
          </section>

          {media && (
            <button type="button" className="blueprint-drive" onClick={() => onNavigate("storage")}>
              <span className="blueprint-drive__name">{[media.target, deviceName(media.source), fstype(media.target)].filter(Boolean).join(" · ")}</span>
              <span className="blueprint-dim" aria-hidden="true"><span>{mediaSize.total} {mediaSize.unit}</span></span>
              <span className="blueprint-bar" aria-hidden="true"><i style={{ width: `${Math.min(100, media.percent ?? 0)}%` }} /></span>
              <span className="blueprint-drive__note">{mediaSize.used} {mediaSize.unit} used ({media.percent} %){fills ? ` · fills in ~${fills.daysToFull} days` : ""}</span>
            </button>
          )}
          {system && (
            <button type="button" className="blueprint-drive blueprint-drive--system" onClick={() => onNavigate("storage")}>
              <span className="blueprint-drive__name">System · {deviceName(system.source)}{fstype("/") ? ` · ${fstype("/")}` : ""}</span>
              <span className="blueprint-drive__size">{systemSize.used} / {systemSize.total} {systemSize.unit} ({system.percent} %)</span>
              <span className="blueprint-bar blueprint-bar--small" aria-hidden="true"><i style={{ width: `${Math.min(100, system.percent ?? 0)}%` }} /></span>
            </button>
          )}
          {!inventory && <p className="blueprint-quiet">{facts.inventory.state === "failed" ? "The drives could not be read." : "Reading the drives…"}</p>}
        </div>

        <div className="blueprint-right">
          <div className="blueprint-right__fill">
            <section className="blueprint-notes" aria-labelledby={`${titleId}-notes`}>
              <h2 className="blueprint-notes__title" id={`${titleId}-notes`}>General notes{notes.length > 4 && <span className="blueprint-notes__count">{notes.length} notes</span>}</h2>
              {notes.length === 0 && <p className="blueprint-quiet">{checking ? "Reading this server…" : unread.length ? "Nothing wrong in what could be read." : "No notes. Nothing needs you."}</p>}
              <ol className="blueprint-notes__list">
                {notes.map((need, index) => {
                  const runnable = runs(need);
                  const tier = runnable?.risk ?? need.risk ?? null;
                  const run = need.finding ? fixRuns[need.finding.id] : undefined;
                  const busy = run && ["queued", "running", "checking"].includes(run.phase);
                  return (
                    <li key={need.id} className="blueprint-note" data-severity={need.severity}>
                      <Marker n={index + 1} className="blueprint-note__marker" />
                      <button type="button" className="blueprint-note__words" onClick={() => open(need)} title={need.detail ?? undefined}>
                        {need.title}.
                        {need.detail && <span className="ui-visually-hidden"> {need.detail}</span>}
                      </button>
                      {tier && <span className="blueprint-note__tier" aria-hidden="true">{tierWord[tier]}</span>}
                      {actionsOf(need).length > 0 && (
                        <span className="blueprint-note__acts">
                          {actionsOf(need).map((action) => (action.kind === "dismiss" || action.kind === "open"
                            ? <Button key={`${action.kind}:${action.label}`} className="blueprint-act" aria-label={`${action.label}: ${need.title}`} onClick={() => act(need, action)}>{action.label}</Button>
                            : <Button key={`${action.operationId}:${action.label}`} className="blueprint-act" risk={action.risk} disabled={Boolean(busy)} aria-label={`${action.label}: ${need.title}`}
                              onClick={() => act(need, action)}>{action.label.replace(/^Back up nightly$/, "Nightly")}</Button>))}
                        </span>
                      )}
                      {run && <span className="blueprint-note__run" role="status">{runWords(run)}</span>}
                    </li>
                  );
                })}
              </ol>
            </section>

            <table className="blueprint-loads">
              <caption className="ui-visually-hidden">Loads</caption>
              <tbody>
                <tr>
                  <td><button type="button" onClick={() => onNavigate("performance")}>CPU {cpu === null ? "—" : Math.round(cpu)} %</button></td>
                  <td><button type="button" onClick={() => onNavigate("performance")}>MEM {gb(memUsed)} / {memTotal === null ? "—" : Math.round(memTotal / 1024 ** 3)} GB</button></td>
                </tr>
                <tr>
                  <td><button type="button" onClick={() => onNavigate("performance")}>{hottest === null ? `LOAD ${inventory ? inventory.load1.toFixed(2) : "—"}` : `TEMP ${hottest} °C`}</button></td>
                  <td><button type="button" onClick={() => onNavigate("network")}>NET {net}</button></td>
                </tr>
              </tbody>
            </table>

            <div className="blueprint-block" aria-label="Title block" role="group">
              <div className="blueprint-block__head"><b>BoxPilot</b><span>DWG HOME · SHEET 01 OF {String(dockAreas.length + 2).padStart(2, "0")}</span></div>
              <span>REV {__BOXPILOT_VERSION__}</span><span>SCALE 1 : 1</span>
              <span>DRAWN BY BOXPILOT</span><span>CHECKED {clockTime(checkedAt)}</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
