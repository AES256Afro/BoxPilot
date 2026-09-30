import { useEffect, useMemo, useState } from "react";
import { openActivity, openNotifications } from "../../activityEvents";
import type { HomeProps } from "../../home/Home";
import { useFacts, valuesOf, type AppFact, type MountFact } from "../../home/facts";
import { greeting, size, uptime } from "../../home/format";
import { actionsOf, appHealth, buildNeeds, runs, verdictFor, verdictSources, type Need, type NeedAction } from "../../home/needs";
import { usePerformance } from "../../home/Ops";
import { runWords, useNeedActions } from "../../home/useNeedActions";
import { TopBarSlot } from "../../shell/TopBarSlot";
import { Button } from "../../ui";
import type { RiskTier } from "../../ui/types";
import { barKeys, openCommandBar, typingPlaces } from "./Bar";
import "./home.css";

/*
 * Home as a green phosphor terminal (M41; docs/design-directions/05-looks.html, M.phosphor): the
 * same facts as every other Home, typed out. The host and its status in inverse video, the loads as
 * ASCII bars, what needs the owner and what can wait under dashed rules with each fix written
 * "(b)ack up now" (and pressing that letter on Home does the same as the button, through the
 * approval dialog at its tier), the apps in two columns, and a prompt that opens the command bar.
 */

const tierTag: Record<RiskTier, string> = { low: "[LOW]", medium: "[MED]", high: "[HIGH]" };
/** How many of each list the screen shows before "and N more". */
const shownNeeds = 6;
const shownWaits = 3;

/** "[####......]" for a percentage, `width` characters inside the brackets. */
export function asciiBar(percent: number | null, width: number): string {
  const filled = percent === null ? 0 : Math.max(0, Math.min(width, Math.round((percent / 100) * width)));
  return `[${"#".repeat(filled)}${".".repeat(width - filled)}]`;
}

/**
 * Each action's words and its key: a later action that repeats the first one's opening words drops
 * them ("Back up now", "nightly"), and the key is the first letter of a word not taken yet, else the
 * first free letter at all.
 */
export function keyedActions(actions: NeedAction[], taken: Set<string>): Array<{ action: NeedAction; words: string; key: string | null; at: number }> {
  const first = actions[0]?.label ?? "";
  return actions.map((action, index) => {
    let words = action.label;
    if (index > 0) {
      const a = first.split(" "), b = words.split(" ");
      let same = 0;
      while (same < a.length - 1 && same < b.length - 1 && a[same].toLowerCase() === b[same].toLowerCase()) same += 1;
      if (same > 0) words = b.slice(same).join(" ");
    }
    const lower = words.toLowerCase();
    // Dismiss sets a failure aside at once, with no dialog to catch a stray keypress: it is pressed
    // with the pointer or Enter, never by a letter. Every other key only opens the approval dialog.
    if (action.kind === "dismiss") return { action, words, key: null, at: -1 };
    const starts = [...lower.matchAll(/\b[a-z]/g)].map((match) => match.index ?? 0);
    const any = [...lower].map((char, at) => (/[a-z]/.test(char) ? at : -1)).filter((at) => at >= 0);
    const at = [...starts, ...any].find((position) => !taken.has(lower[position])) ?? -1;
    const key = at >= 0 ? lower[at] : null;
    if (key) taken.add(key);
    return { action, words, key, at };
  });
}

/** The words an app's row says about it, as the drawing lists them: "no backup", "backup 63d", "up". */
function stateWords(detail: string, status: string): string {
  if (status === "good") return "up";
  if (detail === "Never backed up") return "no backup";
  const old = /^Backup (\d+)d old$/.exec(detail);
  if (old) return `backup ${old[1]}d`;
  return detail.toLowerCase();
}

const narrowQuery = "(max-width: 760px)";
function useNarrow(): boolean {
  const [narrow, setNarrow] = useState(() => typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia(narrowQuery).matches);
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return undefined;
    const query = window.matchMedia(narrowQuery);
    const change = () => setNarrow(query.matches);
    query.addEventListener?.("change", change);
    return () => query.removeEventListener?.("change", change);
  }, []);
  return narrow;
}

interface Forecast { target: string; daysToFull: number }
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

const dataDrive = (mounts: MountFact[]) => mounts.filter((mount) => mount.target !== "/" && !mount.target.startsWith("/boot") && mount.total !== null && mount.percent !== null)
  .sort((a, b) => (b.percent ?? 0) - (a.percent ?? 0))[0] ?? null;

/**
 * What the prompt offers to type next, as the drawing's "back up vaultwarden": the first fix on the
 * list, as its button's words and the app it is for ("Back up now" for Vaultwarden and 3 more is
 * "back up vaultwarden", "Install" for the updates is "install updates").
 */
export function suggestion(need: Need, action: NeedAction, apps: Array<Pick<AppFact, "id" | "name">>): string {
  const verb = action.label.toLowerCase().replace(/\s+now$/, "");
  const ids: string[] = need.appId ? [need.appId] : [];
  for (const fix of need.finding ? [need.finding.fix, ...(need.finding.fixes ?? [])] : []) {
    const parameters = (fix?.parameters ?? {}) as { id?: unknown; ids?: unknown };
    if (typeof parameters.id === "string") ids.push(parameters.id);
    if (Array.isArray(parameters.ids)) for (const id of parameters.ids) if (typeof id === "string") ids.push(id);
  }
  const app = ids.length ? apps.find((entry) => entry.id === ids[0]) : undefined;
  const object = app ? app.name.replace(/\s*\(.*\)\s*$/, "").replace(/\s*\+.*$/, "").toLowerCase()
    : ids[0] ?? (need.kind === "updates" && /update/i.test(need.title) ? "updates" : "");
  return `${verb} ${object}`.trim();
}

/** "(b)ack up now", the key letter in brackets and underlined. */
function Keyed({ words, at }: { words: string; at: number }) {
  if (at < 0) return <>{words.toLowerCase()}</>;
  const lower = words.toLowerCase();
  return <>{lower.slice(0, at)}(<u>{lower[at]}</u>){lower.slice(at + 1)}</>;
}

export default function PhosphorHome({ csrfToken, role, onNavigate, now = Date.now }: HomeProps) {
  const { facts, refresh, accept } = useFacts();
  const clock = now();
  const values = useMemo(() => valuesOf(facts), [facts]);
  const needs = buildNeeds(values, { now: clock, role });
  const { act, runs: fixRuns, dialog } = useNeedActions({ csrfToken, refresh, accept, navigate: onNavigate });
  const performance = usePerformance(15_000, now);
  const forecasts = useForecasts();
  const narrow = useNarrow();

  const inventory = values.inventory;
  const hostname = inventory?.hostname ?? "this server";
  const checking = verdictSources.some(([key]) => facts[key].state === "idle" || facts[key].state === "loading");
  const unread = verdictSources.filter(([key]) => facts[key].state === "failed").map(([, words]) => words);
  const verdict = verdictFor(needs, { hostname: inventory?.hostname ?? "This server", checking, unread });
  const urgent = needs.filter((need) => need.severity !== "neutral");
  const waiting = needs.filter((need) => need.severity === "neutral");
  // As many lines as the drawing has room for; the rest one keypress away, as a pager would.
  const [all, setAll] = useState(false);
  const shownUrgent = all ? urgent : urgent.slice(0, shownNeeds);
  const shownWaiting = all ? waiting : waiting.slice(0, shownWaits);
  const hidden = urgent.length - shownUrgent.length + waiting.length - shownWaiting.length;
  const open = (need: Need) => (need.jobId ? openActivity(need.jobId) : need.id === "unannounced" ? openNotifications() : onNavigate(need.view, need.appId && need.view === "catalog" ? { app: need.appId } : undefined));

  // Every fix on screen with its key, in the order the needs are listed; no two share a letter, and
  // none takes a key the bar answers to on every page ("(/)search", "(a)ctivity").
  const shown = [...shownUrgent, ...shownWaiting];
  const taken = new Set<string>(barKeys);
  const keyed = new Map(shown.map((need) => [need.id, keyedActions(actionsOf(need), taken)]));
  const byKey = new Map<string, { need: Need; action: NeedAction }>();
  for (const need of shown) for (const entry of keyed.get(need.id) ?? []) if (entry.key) byKey.set(entry.key, { need, action: entry.action });

  // The prompt offers the first fix on the list, typed out; running it opens the same approval dialog.
  const firstFix = shown.map((need) => ({ need, action: runs(need) })).find((entry): entry is { need: Need; action: NeedAction } => entry.action !== null);
  const next = firstFix ? {
    ...firstFix,
    words: suggestion(firstFix.need, firstFix.action, values.catalog?.apps ?? []),
    busy: Boolean(firstFix.need.finding && ["queued", "running", "checking"].includes(fixRuns[firstFix.need.finding.id]?.phase ?? "")),
  } : null;

  // Pressing a fix's letter on Home presses its button: the approval dialog opens at its tier.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.ctrlKey || event.metaKey || event.altKey || event.defaultPrevented || event.repeat) return;
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest(typingPlaces)) return;
      if (document.querySelector('[aria-modal="true"]')) return;
      const entry = byKey.get(event.key.toLowerCase());
      if (!entry) return;
      const run = entry.need.finding ? fixRuns[entry.need.finding.id] : undefined;
      if (run && ["queued", "running", "checking"].includes(run.phase)) return;
      event.preventDefault();
      act(entry.need, entry.action);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  });

  // ── The loads, as bars. ──
  const perf = performance.value;
  const width = narrow ? 16 : 40;
  const cpu = perf?.cpu.usagePercent ?? inventory?.loadPercent ?? null;
  const memPercent = perf?.memory.usedPercent ?? inventory?.memoryPercent ?? null;
  const mounts = inventory?.mounts ?? [];
  const system = mounts.find((mount) => mount.target === "/") ?? null;
  const media = dataDrive(mounts);
  const fills = media ? forecasts.find((forecast) => forecast.target === media.target) : undefined;
  // "11.0 of 32.0 GB", "212 of 800 GB", "2.6 of 3.9 TB": one unit, the total's, when both share it.
  const of = (used: number | null | undefined, total: number | null | undefined) => {
    const plain = (text: string) => text.replace(/^(\d{3,})\.\d /, "$1 ");
    const [a, b] = [plain(size(used)), plain(size(total))];
    const unit = b.split(" ")[1];
    return a.endsWith(` ${unit}`) ? `${a.split(" ")[0]} of ${b}` : `${a} of ${b}`;
  };
  const rows: Array<{ label: string; percent: number | null; note: string; view: "performance" | "storage" }> = [
    { label: "CPU", percent: cpu, note: inventory ? `load ${inventory.load1.toFixed(2)} on ${inventory.cpuCount} cores` : "reading…", view: "performance" },
    { label: "MEM", percent: memPercent, note: inventory ? of(perf?.memory.usedBytes ?? inventory.memoryUsed, perf?.memory.totalBytes ?? inventory.memoryTotal) : "reading…", view: "performance" },
    ...(system ? [{ label: "DISK", percent: system.percent, note: of(system.used, system.total), view: "storage" as const }] : []),
    ...(media ? [{ label: (media.target.split("/").filter(Boolean).at(-1) ?? "DATA").toUpperCase().slice(0, 5), percent: media.percent, note: `${of(media.used, media.total)}${fills ? `, full in ~${fills.daysToFull} days` : ""}`, view: "storage" as const }] : []),
  ];

  // ── The apps, two columns of rows. ──
  const apps = values.catalog?.apps ?? [];
  const protectionById = new Map((values.protection ?? []).map((entry) => [entry.id, entry]));
  const measured = new Map((perf?.statsAvailable ? perf.apps : []).map((entry) => [entry.id, entry]));
  const appRows = apps.map((app) => {
    const health = appHealth(app, protectionById.get(app.id), clock);
    const stats = measured.get(app.id);
    const live = app.running || app.paused;
    const mark = health.status === "good" ? "*" : health.status === "neutral" ? "-" : "!";
    const name = app.name.toLowerCase().replace(/\s*\(.*\)\s*$/, "").replace(/\s*\+.*$/, "").replace(/\s+/g, "-").slice(0, 12);
    const said = stateWords(health.detail, health.status);
    const words = said.length > 12 ? `${said.slice(0, 11)}…` : said;
    const cpuText = live && stats && !app.paused ? `${stats.cpuPercent.toFixed(1)}%` : "";
    const mem = live && stats ? size(stats.memBytes).replace(" ", "") : "";
    const line = narrow
      ? `${mark} ${name.padEnd(12)} ${words}`
      : `${mark} ${name.padEnd(12)} ${words.padEnd(12)}${cpuText.padStart(6)} ${mem.padStart(6)}`;
    return { app, health, line, mark };
  });
  const half = Math.ceil(appRows.length / 2);
  const columns = [appRows.slice(0, half), appRows.slice(half)];
  const status = urgent.length ? `${urgent.length} NEED${urgent.length === 1 ? "S" : ""} A LOOK` : checking ? "CHECKING" : unread.length ? "NOT FULLY READ" : "ALL CLEAR";

  const needRow = (need: Need, inverse: boolean) => {
    const runnable = runs(need);
    const tier = runnable?.risk ?? need.risk ?? null;
    const run = need.finding ? fixRuns[need.finding.id] : undefined;
    const busy = run && ["queued", "running", "checking"].includes(run.phase);
    return (
      <li key={need.id} className="phosphor-need">
        <span className={inverse ? "phosphor-inv phosphor-need__tag" : "phosphor-need__tag"}>{tier ? tierTag[tier] : "[LOOK]"}</span>
        <button type="button" className="phosphor-need__words" onClick={() => open(need)} title={need.detail ?? undefined}>
          {need.title}
          {need.detail && <span className="ui-visually-hidden">. {need.detail}</span>}
        </button>
        <span className="phosphor-need__acts">
          {(keyed.get(need.id) ?? []).map(({ action, words, key, at }) => (action.kind === "dismiss" || action.kind === "open"
            ? <Button key={`${action.kind}:${action.label}`} className="phosphor-key" aria-label={`${action.label}: ${need.title}`} aria-keyshortcuts={key ?? undefined} onClick={() => act(need, action)}><Keyed words={words} at={at} /></Button>
            : <Button key={`${action.operationId}:${action.label}`} className="phosphor-key" risk={action.risk} disabled={Boolean(busy)} aria-label={`${action.label}: ${need.title}`} aria-keyshortcuts={key ?? undefined}
              onClick={() => act(need, action)}><Keyed words={words} at={at} /></Button>))}
        </span>
        {run && <span className="phosphor-need__run" role="status">{runWords(run)}</span>}
      </li>
    );
  };

  return (
    <div className="phosphor-home">
      {dialog}
      <h1 className="ui-visually-hidden">{greeting(clock)}</h1>
      <TopBarSlot inPlace>
        <p className="phosphor-host">
          <span className="phosphor-inv">{` ${hostname.toUpperCase()} `}</span>
          {inventory && <span className="phosphor-host__facts">{inventory.operatingSystem} :: up {uptime(inventory.uptimeSeconds).replace(/(\d+)h$/, (_, h: string) => `${h.padStart(2, "0")}h`)}</span>}
        </p>
      </TopBarSlot>

      <p className="phosphor-line phosphor-status">
        <span>STATUS</span>
        <span className={urgent.length ? "phosphor-inv" : ""}>{` ${status} `}</span>
        <span className="phosphor-status__verdict">{verdict.sentence}</span>
      </p>

      <div className="phosphor-bars">
        {rows.map((row) => (
          <button key={row.label} type="button" className="phosphor-line phosphor-bar" onClick={() => onNavigate(row.view)}>
            <span>{row.label.padEnd(5)} {asciiBar(row.percent, width)} {(row.percent === null ? "--" : `${Math.round(row.percent)}%`).padStart(4)}</span>
            <span className="phosphor-dim">{row.note}</span>
          </button>
        ))}
      </div>

      <h2 className="phosphor-rule">NEEDS YOU</h2>
      {urgent.length === 0
        ? <p className="phosphor-line phosphor-dim">{checking ? "reading this server…" : unread.length ? `nothing wrong in what could be read; not read: ${unread.join(", ")}` : "nothing needs you."}</p>
        : <ul className="phosphor-needs">{shownUrgent.map((need) => needRow(need, true))}</ul>}

      {waiting.length > 0 && <>
        <h2 className="phosphor-rule">CAN WAIT</h2>
        <ul className="phosphor-needs">{shownWaiting.map((need) => needRow(need, false))}</ul>
      </>}
      {(hidden > 0 || all) && (
        <button type="button" className="phosphor-line phosphor-more" aria-expanded={all} onClick={() => setAll((value) => !value)}>
          {all ? "-- show fewer --" : `-- ${hidden} more; show all --`}
        </button>
      )}

      <h2 className="phosphor-rule">APPS {apps.length}</h2>
      {facts.catalog.state === "failed" && <p className="phosphor-line phosphor-dim">which apps are installed could not be read.</p>}
      {values.catalog && apps.length === 0 && (
        <p className="phosphor-line phosphor-dim">no apps are installed yet. <button type="button" className="phosphor-link" onClick={() => onNavigate(values.setup?.firstRun ? "setup" : "catalog")}>{values.setup?.firstRun ? "choose a setup profile" : "add an app"}</button></p>
      )}
      <div className="phosphor-apps">
        {columns.map((column, index) => (
          <ul key={index}>
            {column.map(({ app, health, line, mark }) => (
              <li key={app.id}>
                <button type="button" className={mark === "!" ? "phosphor-app phosphor-inv" : mark === "*" ? "phosphor-app phosphor-dim" : "phosphor-app"}
                  aria-label={`${app.name}, ${health.label}`} onClick={() => onNavigate("catalog", { app: app.id })}>{line}</button>
              </li>
            ))}
          </ul>
        ))}
      </div>

      <p className="phosphor-line phosphor-prompt">
        <button type="button" className="phosphor-prompt__ps" aria-label="Search, or say what you want (Ctrl K)" aria-haspopup="dialog" onClick={openCommandBar}>{hostname.toLowerCase()}:~$</button>
        {next
          ? <button type="button" className="phosphor-prompt__next" aria-label={`Run: ${next.words}. ${next.need.title}`} disabled={next.busy} onClick={() => act(next.need, next.action)}>{next.words}<span className="phosphor-cursor" aria-hidden="true" /></button>
          : <span className="phosphor-cursor" aria-hidden="true" />}
      </p>
    </div>
  );
}
