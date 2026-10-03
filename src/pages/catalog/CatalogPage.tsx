import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useOperation, type PendingOperation } from "../../shell/ApproveDialog";
import { appUrl } from "../../appLinks";
import { countOf } from "../../data";
import { inspectOperation, type Job } from "../../operations";
import { strandedServes } from "../../strandedServes";
import { AppIcon, Button, CodeBlock, EmptyState, Notice, PageHeader, Panel, SearchField, Select, Sheet, StatusChip, Table, Tabs, Tag, Tile, Toolbar, appHue, mayStart, riskOf, useUrlParam, type Status, type TableColumn } from "../../ui";
import { AppSheet, type SheetTab } from "./AppSheet";
import { ConfigSheet } from "./ConfigSheet";
import { appStatus, installTier, isRunning, runRead, tileDetail } from "./appState";
import type { AppStats, CatalogContext, CatalogResponse, Entry, KillswitchSchedule, Serve, Tunnel, Values } from "./types";
import "./catalog.css";

/*
 * The App catalog (M33.11), rebuilt in the console on the kit. Facts first: whether the installed
 * apps are well, and how many are installed, running and waiting for an update. Then the apps: the
 * ones on this server as Home's colour squares, the catalog to browse as cards, and the Compose
 * stacks BoxPilot did not start, a tab each, with one search and a category across them. Each app
 * opens its sheet (?view=catalog&app=<id> opens it straight away), which holds everything the
 * Classic card did; installing or changing settings is a form in a sheet of its own.
 */

type CatalogTab = "installed" | "browse" | "stacks";
interface ForeignStack { name: string; status: string; configFiles: string[] }
const catalogTabs: readonly CatalogTab[] = ["installed", "browse", "stacks"];

export interface CatalogPageProps {
  csrfToken: string;
  /** Opens the catalog at one app's sheet (from a Home tile, a need, or the command bar). */
  focusApp?: string;
  /** Who is signed in: a viewer sees the apps and their facts, and runs nothing. */
  role?: string;
}

const sheetTabs: readonly SheetTab[] = ["overview", "tunnel", "reach", "backups", "vpn", "logs", "config", "models", "signin", "secrets"];

/**
 * Puts `app` (and the sheet's tab, `sheet`) in the address while its sheet is open, so a reload or
 * a link comes back to it: ?view=catalog&app=vaultwarden&sheet=backups.
 */
function rememberApp(id: string | null, tab?: SheetTab) {
  const url = new URL(window.location.href);
  if (id) url.searchParams.set("app", id); else url.searchParams.delete("app");
  if (id && tab && tab !== "overview") url.searchParams.set("sheet", tab); else url.searchParams.delete("sheet");
  window.history.replaceState(window.history.state, "", url);
}

/** The sheet's tab a link asked for, if it is one. */
function linkedSheetTab(): SheetTab | undefined {
  const asked = new URLSearchParams(window.location.search).get("sheet");
  return asked && (sheetTabs as readonly string[]).includes(asked) ? asked as SheetTab : undefined;
}

export default function CatalogPage({ csrfToken, focusApp, role = "owner" }: CatalogPageProps) {
  const [data, setData] = useState<CatalogResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [serves, setServes] = useState<Serve[] | null>(null);
  const [stats, setStats] = useState<Record<string, AppStats> | null>(null);
  const [tunnels, setTunnels] = useState<Record<string, Tunnel>>({});
  const [killswitch, setKillswitch] = useState<Record<string, KillswitchSchedule>>({});
  const [rehearsal, setRehearsal] = useState<Record<string, { id: string; cadence: string }>>({});
  const [foreign, setForeign] = useState<ForeignStack[] | null>(null);
  const [foreignLogs, setForeignLogs] = useState<{ name: string; lines: string[] | null; error: string | null } | null>(null);
  const [scheduling, setScheduling] = useState(false);
  const [scheduleError, setScheduleError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("");
  const [tab, setTab] = useUrlParam<CatalogTab>("tab", catalogTabs, "installed");
  const [sheet, setSheet] = useState<{ id: string; tab?: SheetTab } | null>(null);
  const [config, setConfig] = useState<{ entry: Entry; mode: "install" | "reconfigure"; back: { id: string; tab?: SheetTab } | null } | null>(null);
  const focused = useRef(false);
  const canRead = role === "owner" || role === "operator";

  // Which VPN apps have the kill-switch drill and which apps have a restore rehearsal on a schedule.
  const loadSchedules = useCallback(async () => {
    try {
      const body = (await fetch("/api/v1/schedules").then((response) => (response.ok ? response.json() : { schedules: [] }))) as { schedules?: Array<{ id: string; operationId: string; cadence: string; parameters?: { subject?: string }; overdue?: boolean; lastRunAt?: string | null; lastResult?: string | null }> };
      const drills: Record<string, KillswitchSchedule> = {};
      const rehearsals: Record<string, { id: string; cadence: string }> = {};
      for (const schedule of body.schedules ?? []) {
        const subject = schedule.parameters?.subject;
        if (schedule.operationId === "app.vpn.killswitch.drill" && subject) drills[subject] = { id: schedule.id, overdue: Boolean(schedule.overdue), lastRunAt: schedule.lastRunAt ?? null, lastResult: schedule.lastResult ?? null };
        if (schedule.operationId === "app.backup.verify" && subject) rehearsals[subject] = { id: schedule.id, cadence: schedule.cadence };
      }
      setKillswitch(drills);
      setRehearsal(rehearsals);
    } catch { /* the manual buttons still work without this */ }
  }, []);

  // For the few apps that run through a VPN tunnel, where their traffic actually leaves. The answer
  // comes from the tunnel's own log, so it costs one read per tunneled app, not per tile.
  const loadTunnels = useCallback(async (entries: Entry[]) => {
    for (const entry of entries.filter((candidate) => candidate.manifest.networkVia && candidate.live?.installed)) {
      try {
        const { response, body } = await runRead<{ tunneled: boolean; running?: boolean; exit?: Tunnel["exit"]; forwardedPort?: number | null }>(csrfToken, "app.vpn.inspect", { id: entry.manifest.id });
        if (response.ok && body.result?.tunneled) {
          const result = body.result;
          setTunnels((current) => ({ ...current, [entry.manifest.id]: { running: result.running ?? false, exit: result.exit ?? null, forwardedPort: result.forwardedPort ?? null } }));
        }
      } catch { /* the app's state already covers a broken tunnel; the exit is a bonus */ }
    }
  }, [csrfToken]);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch("/api/v1/catalog");
      const body = (await response.json().catch(() => ({}))) as CatalogResponse & { error?: string };
      if (!response.ok) throw new Error(body.error ?? "Could not load the catalog");
      const normalised = { ...body, applications: body.applications ?? [], problems: body.problems ?? [], host: body.host ?? { lanAddress: null, tailscaleDnsName: null } };
      setData(normalised);
      setError(null);
      void loadTunnels(normalised.applications);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Could not load the catalog");
    } finally {
      setLoading(false);
    }
    void loadSchedules();
    // Tailnet publishing and live resource use are extras: a failure hides them.
    inspectOperation<{ available: boolean; serves: Serve[] }>("app.serve.inspect").then(({ result }) => setServes(result.available ? result.serves : null)).catch(() => setServes(null));
    inspectOperation<{ available: boolean; stats: Record<string, AppStats> }>("app.stats.inspect").then(({ result }) => setStats(result.available ? result.stats : null)).catch(() => setStats(null));
  }, [loadTunnels, loadSchedules]);
  useEffect(() => { void refresh(); }, [refresh]);

  useEffect(() => {
    inspectOperation<{ available: boolean; projects: ForeignStack[] }>("compose.projects.inspect")
      .then(({ result }) => setForeign(result.available ? result.projects ?? [] : null))
      .catch(() => setForeign(null));
  }, []);

  // Where an action started from, and how its job ended, so the owner lands back where the result
  // shows once the approval dialog closes. Every action in an app's sheet used to close the sheet for
  // good (back to the grid, off the Backups tab they were on), and an install left the owner on the
  // Catalog tab, which lists only what is not installed: the app they had just installed vanished.
  const returnTo = useRef<{ id: string; tab?: SheetTab } | null>(null);
  const ended = useRef<Job | null>(null);
  const { start, dialog } = useOperation(csrfToken, (job) => { ended.current = job; void refresh(); });
  const openSheet = useCallback((id: string, sheetTab?: SheetTab) => { setSheet({ id, tab: sheetTab }); rememberApp(id); }, []);
  const closeSheet = useCallback(() => { setSheet(null); rememberApp(null); }, []);
  const act = useCallback((operation: PendingOperation) => {
    returnTo.current = sheet ?? (config ? config.back ?? { id: config.entry.manifest.id } : null);
    ended.current = null;
    closeSheet(); setConfig(null); start(operation);
  }, [closeSheet, config, sheet, start]);
  const approving = Boolean(dialog);
  const wasApproving = useRef(false);
  useEffect(() => {
    if (approving) { wasApproving.current = true; return; }
    if (!wasApproving.current) return;
    wasApproving.current = false;
    const back = returnTo.current;
    const job = ended.current;
    returnTo.current = null; ended.current = null;
    if (!back) return;
    // Installed: it is on the Installed tab now; its sheet opens at Overview, with its address.
    if (job?.type === "op:app.install" && job.state === "completed") { setTab("installed"); openSheet(back.id); return; }
    openSheet(back.id, back.tab);
  }, [approving, openSheet, setTab]);

  // Opened at one app: its sheet, once the catalog has answered.
  useEffect(() => {
    if (!data || !focusApp || focused.current) return;
    focused.current = true;
    const entry = data.applications.find((candidate) => candidate.manifest.id === focusApp);
    if (!entry) return;
    setTab(entry.live?.installed ? "installed" : "browse");
    setSheet({ id: focusApp, tab: linkedSheetTab() });
  }, [data, focusApp, setTab]);

  // A rehearsal on a cadence is what turns "the backups restore" from a one-off into a record.
  // Every schedule change reports the server's refusal and blocks a second click while it is out.
  const changeSchedule = async (send: () => Promise<Response>, failure: string) => {
    if (scheduling) return;
    setScheduling(true);
    setScheduleError(null);
    try {
      const response = await send();
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `${failure} (${response.status})`);
      }
    } catch (requestError) {
      setScheduleError(requestError instanceof Error ? requestError.message : failure);
    } finally {
      await loadSchedules();
      setScheduling(false);
    }
  };
  const createSchedule = (body: Record<string, unknown>) => () => fetch("/api/v1/schedules", { method: "POST", headers: { "Content-Type": "application/json", "X-BoxPilot-CSRF": csrfToken }, body: JSON.stringify(body) });
  const deleteSchedule = (scheduleId: string) => () => fetch(`/api/v1/schedules/${encodeURIComponent(scheduleId)}`, { method: "DELETE", headers: { "X-BoxPilot-CSRF": csrfToken } });

  const showForeignLogs = async (name: string) => {
    setForeignLogs({ name, lines: null, error: null });
    try {
      const { response, body } = await runRead<{ lines?: string[] }>(csrfToken, "compose.project.logs", { name, lines: 200 });
      if (!response.ok || !body.result) throw new Error(body.error ?? "Could not read the logs");
      setForeignLogs({ name, lines: body.result.lines ?? [], error: null });
    } catch (requestError) {
      setForeignLogs({ name, lines: null, error: requestError instanceof Error ? requestError.message : "Could not read the logs" });
    }
  };

  // ── What the owner sees: filtered by the search and the category, installed first. ──
  const applications = useMemo(() => data?.applications ?? [], [data]);
  const categories = useMemo(() => [...new Set(applications.map((entry) => entry.manifest.category))].sort(), [applications]);
  const visible = useMemo(() => {
    const words = search.trim().toLowerCase().split(/\s+/).filter(Boolean);
    return applications.filter((entry) => {
      if (category && entry.manifest.category !== category) return false;
      if (!words.length) return true;
      const haystack = `${entry.manifest.name} ${entry.manifest.id} ${entry.manifest.category} ${entry.manifest.description}`.toLowerCase();
      return words.every((word) => haystack.includes(word));
    });
  }, [applications, category, search]);
  // What is already on this server goes first, running before stopped, so it is never behind a
  // scroll through a hundred-odd things that are not installed.
  const installedVisible = useMemo(() => visible.filter((entry) => entry.live?.installed)
    .sort((left, right) => Number(isRunning(right.live)) - Number(isRunning(left.live)) || left.manifest.name.localeCompare(right.manifest.name)), [visible]);
  const availableVisible = useMemo(() => visible.filter((entry) => !entry.live?.installed), [visible]);
  const installedAll = applications.filter((entry) => entry.live?.installed);
  const runningCount = installedVisible.filter((entry) => isRunning(entry.live)).length;
  const updates = installedAll.filter((entry) => entry.live?.updateAvailable).length;
  const unwell = installedAll.map((entry) => appStatus(entry.live)).filter((state) => state.status === "danger" || state.status === "warning");
  const worst: Status = unwell.some((state) => state.status === "danger") ? "danger" : "warning";
  const filtering = Boolean(search.trim() || category);

  const verdict: { status: Status; label: string } = !data
    ? { status: "unknown", label: error ? "Not read" : "Reading…" }
    : data.liveError ? { status: "unknown", label: "Live state not read" }
      : installedAll.length === 0 ? { status: "neutral", label: "None installed" }
        : unwell.length ? { status: worst, label: `${unwell.length} ${unwell.length === 1 ? "needs" : "need"} a look` }
          : { status: "good", label: "All running" };

  // Tailnet addresses pointing at ports no installed app publishes. Publishing records the port an
  // app had at the time and nothing moves that record; "stop publishing" withdraws the port the app
  // has now, so once a port changes the old address is stranded and unreachable from here.
  const stranded = strandedServes(serves ?? [], installedAll.map((entry) => entry.live).filter((live): live is NonNullable<typeof live> => Boolean(live)));

  const openUrl = useCallback((port: { host: number; exposure: string; path?: string | null }, manifest: { id: string }) =>
    appUrl(port, { lanAddress: data?.host.lanAddress ?? null, serves: serves ?? [], https: manifest.id === "portainer" }), [data, serves]);

  const ctx: CatalogContext | null = data ? {
    csrfToken, role, data, serves, stats, tunnels, killswitch, rehearsal, scheduling, scheduleError,
    schedules: {
      // spread: one server can have twenty of these, and twenty archives decompressing in the same
      // minute is not a rehearsal, it is an outage. The server puts each somewhere quiet near here.
      rehearse: (appId) => changeSchedule(createSchedule({ operationId: "app.backup.verify", parameters: { id: appId }, frequency: "weekly", minute: 30, hour: 3, weekday: 1, spread: true }), "Could not schedule the rehearsal"),
      stopRehearsal: (scheduleId) => changeSchedule(deleteSchedule(scheduleId), "Could not stop the rehearsal"),
      killswitch: (appId) => changeSchedule(createSchedule({ operationId: "app.vpn.killswitch.drill", parameters: { id: appId }, frequency: "weekly", minute: 0, hour: 4, weekday: 0, spread: true }), "Could not schedule the kill-switch check"),
      stopKillswitch: (scheduleId) => changeSchedule(deleteSchedule(scheduleId), "Could not stop the kill-switch check"),
    },
    act,
    openUrl,
    configure: (entry, mode) => { const back = sheet; setSheet(null); setScheduleError(null); setConfig({ entry, mode, back }); },
  } : null;
  const sheetEntry = sheet ? applications.find((entry) => entry.manifest.id === sheet.id) ?? null : null;
  const shownTab: CatalogTab = tab === "stacks" && !foreign?.length ? "installed" : tab;

  const toolbar = (
    <Toolbar
      label="Find an app"
      className="catalog-toolbar"
      search={{ value: search, onValueChange: setSearch, label: "Search applications", placeholder: "Search by name, category or what it does…" }}
      filters={<Select aria-label="Category" value={category} onValueChange={setCategory} options={[{ value: "", label: `All categories (${applications.length})` }, ...categories.map((name) => ({ value: name, label: `${name} (${applications.filter((entry) => entry.manifest.category === name).length})` }))]} />}
      actions={filtering ? <Button variant="ghost" onClick={() => { setSearch(""); setCategory(""); }}>Clear</Button> : undefined}
    />
  );

  const strandedColumns: Array<TableColumn<Serve>> = [
    { id: "address", header: "Address", cell: (serve) => <code>https://{serve.dnsName}:{serve.port}</code> },
    { id: "target", header: "Forwards to", cell: (serve) => <code>{serve.target ?? `port ${serve.port}`}</code> },
    ...(mayStart(role, "app.serve.withdraw") ? [{
      id: "actions", header: <span className="ui-visually-hidden">Actions</span>, label: "Actions", className: "catalog-actions-cell",
      cell: (serve: Serve) => <span className="catalog-actions"><Button risk={riskOf("app.serve.withdraw")} aria-label={`Stop publishing port ${serve.port}`} onClick={() => act({ operationId: "app.serve.withdraw", title: `Stop publishing port ${serve.port} on the tailnet`, parameters: { port: serve.port }, preview: <span>Runs <code>tailscale serve --https={serve.port} off</code>. Nothing else about your tailnet or any app changes.</span> })}>Stop publishing</Button></span>,
    }] : []),
  ];

  const stackColumns: Array<TableColumn<ForeignStack>> = [
    { id: "name", header: "Stack", sortValue: (stack) => stack.name, cell: (stack) => <code className="catalog-strong">{stack.name}</code> },
    { id: "status", header: "State", cell: (stack) => <StatusChip status={stackRunning(stack) ? "good" : /running|up/i.test(stack.status) ? "warning" : "neutral"}>{stack.status}</StatusChip> },
    { id: "file", header: "Compose file", hideOnPhone: true, cell: (stack) => <code className="catalog-dim">{stack.configFiles[0] ?? ""}</code> },
    {
      id: "actions", header: <span className="ui-visually-hidden">Actions</span>, label: "Actions", className: "catalog-actions-cell", cell: (stack) => {
        const stackAct = (action: "start" | "stop" | "restart") => act({ operationId: "compose.project.action", title: `${action[0].toUpperCase()}${action.slice(1)} ${stack.name}`, parameters: { name: stack.name, action }, preview: <span>Runs <code>docker compose {action}</code> on {stack.name} using its own compose files. BoxPilot does not change or adopt the stack.</span> });
        const may = mayStart(role, "compose.project.action");
        const risk = riskOf("compose.project.action");
        return (
          <span className="catalog-actions">
            {may && (stackRunning(stack)
              ? <><Button risk={risk} aria-label={`Restart ${stack.name}`} onClick={() => stackAct("restart")}>Restart</Button><Button risk={risk} aria-label={`Stop ${stack.name}`} onClick={() => stackAct("stop")}>Stop</Button></>
              : <Button risk={risk} aria-label={`Start ${stack.name}`} onClick={() => stackAct("start")}>Start</Button>)}
            {canRead && <Button variant="ghost" aria-label={`Logs of ${stack.name}`} onClick={() => void showForeignLogs(stack.name)}>Logs</Button>}
          </span>
        );
      },
    },
  ];

  return (
    <div className="catalog-page">
      {dialog}
      <PageHeader
        title="App catalog"
        status={verdict}
        meta={data ? <><b>{installedAll.length}</b> installed · <b>{installedAll.filter((entry) => isRunning(entry.live)).length}</b> running · <b>{updates}</b> {updates === 1 ? "update" : "updates"} · <b>{applications.length}</b> in the catalog · <b>{categories.length}</b> categories</> : undefined}
        actions={<Button variant="ghost" onClick={() => void refresh()} busy={loading && Boolean(data)}>Read again</Button>}
        about={<>
          <p>Install, update, configure and remove applications. Each one is a Compose project BoxPilot deploys from the catalog, and each opens a sheet with its state, who can reach it, its backups and restore drills, its logs and its configuration.</p>
          <p>Other stacks lists Compose projects started outside BoxPilot. Their compose files stay theirs; they are listed so this page tells the whole truth about this server.</p>
        </>}
      />

      {error && <Notice tone="danger" live title="The catalog could not be read" action={<Button onClick={() => void refresh()}>Try again</Button>}>{error}</Notice>}
      {data?.liveError && <Notice tone="warning" title="Live state unavailable">{data.liveError}</Notice>}
      {(data?.problems.length ?? 0) > 0 && (
        <Notice tone="warning" title={`${countOf(data!.problems.length, "catalog file")} skipped`}>
          <ul className="catalog-list">{data!.problems.map((problem) => <li key={problem.file}><code>{problem.file}</code>: {problem.errors.join("; ")}</li>)}</ul>
        </Notice>
      )}

      <Tabs<CatalogTab>
        label="Apps"
        value={shownTab}
        onChange={setTab}
        className="catalog-tabs"
        tabs={[
          { id: "installed", label: "On this server", count: data ? installedVisible.length : undefined, status: unwell.length ? worst : undefined, statusLabel: unwell.length ? `${unwell.length} ${unwell.length === 1 ? "needs" : "need"} a look` : undefined },
          { id: "browse", label: "Catalog", count: data ? availableVisible.length : undefined },
          ...(foreign?.length ? [{ id: "stacks" as const, label: "Other stacks", count: foreign.length }] : []),
        ]}
      >
        {(current) => current === "stacks" ? (
          <Panel className="catalog-stacks" title="Also on this server" count={foreign?.length ?? 0} meta={<><b>{(foreign ?? []).filter(stackRunning).length}</b> running · started outside BoxPilot</>}>
            <Table caption="Compose stacks started outside BoxPilot" columns={stackColumns} rows={foreign ?? []} rowKey={(stack) => stack.name} />
          </Panel>
        ) : current === "installed" ? (
          <>
            {installedAll.length > 0 && toolbar}
            <Panel className="catalog-installed" title="On this server" count={data ? installedVisible.length : undefined} meta={data ? `${runningCount} running of ${installedVisible.length} installed` : undefined}>
              {!data ? <p className="catalog-quiet">{error ? "The apps could not be read." : "Reading…"}</p>
                : installedVisible.length === 0 ? (
                  filtering
                    ? <EmptyState title="No installed app matches" action={<Button onClick={() => setTab("browse")}>Search the catalog</Button>}>The search looks through the name, the category and what each app does.</EmptyState>
                    : <EmptyState title="No apps installed yet" action={<Button variant="primary" onClick={() => setTab("browse")}>Browse the catalog</Button>}>{countOf(applications.length, "app")} to choose from.</EmptyState>
                ) : (
                  <div className="catalog-tiles">
                    {installedVisible.map((entry) => {
                      const state = appStatus(entry.live);
                      return (
                        <Tile
                          key={entry.manifest.id}
                          name={entry.manifest.name}
                          status={state.status}
                          statusLabel={state.label}
                          detail={tileDetail(entry.manifest, entry.live, stats?.[entry.manifest.id])}
                          hue={appHue(entry.manifest.id)}
                          icon={entry.manifest.icon ? <span className="catalog-tile__emoji">{entry.manifest.icon}</span> : undefined}
                          className="catalog-tile"
                          onSelect={() => openSheet(entry.manifest.id)}
                        />
                      );
                    })}
                  </div>
                )}
            </Panel>
            {stranded.length > 0 && (
              <Panel className="catalog-stranded" title="Tailnet addresses that lead nowhere" count={{ status: "warning", label: String(stranded.length) }}
                footer="Published on your tailnet, but forwarding to ports nothing here answers on: what an app's port changing leaves behind. Withdrawing one changes nothing you can reach now.">
                <Table caption="Tailnet addresses that lead nowhere" columns={strandedColumns} rows={stranded} rowKey={(serve) => `${serve.dnsName}:${serve.port}`} rowStatus={() => "warning"} />
              </Panel>
            )}
          </>
        ) : (
          <>
            {toolbar}
            <Panel className="catalog-browse" title={installedAll.length > 0 ? "Add something else" : "Choose what this server runs"} count={data ? availableVisible.length : undefined} meta={data ? `${category || "all categories"} · ${availableVisible.length} to choose from` : undefined}>
              {!data ? <p className="catalog-quiet">{error ? "The catalog could not be read." : "Reading…"}</p>
                : availableVisible.length === 0 ? <EmptyState title="Nothing in the catalog matches that" action={filtering ? <Button onClick={() => { setSearch(""); setCategory(""); }}>Clear the search</Button> : undefined}>The search looks through the name, the category and what each app does.</EmptyState>
                  : (
                    <ul className="catalog-cards">
                      {availableVisible.map((entry) => {
                        const { manifest, live } = entry;
                        return (
                          <li key={manifest.id} className="catalog-card">
                            <button type="button" className="catalog-card__open" onClick={() => openSheet(manifest.id)} aria-label={`${manifest.name}: ${manifest.category}, ${live?.dataPresent ? "not installed, data kept" : "not installed"}`}>
                              <AppIcon id={manifest.id} name={manifest.name} icon={manifest.icon} />
                              <span className="catalog-card__title">
                                <span className="catalog-card__name">{manifest.name}</span>
                                <span className="catalog-card__meta">{manifest.category} · {manifest.image.version ?? manifest.image.reference}</span>
                              </span>
                            </button>
                            <p className="catalog-card__description">{manifest.description}</p>
                            <div className="catalog-card__foot">
                              {live?.dataPresent ? <Tag tone="warning" title="Its data is still on this server from before">data kept</Tag> : !live ? <Tag>state unknown</Tag> : <span />}
                              {mayStart(role, "app.install") && <Button aria-label={`Install ${manifest.name}`} risk={installTier(manifest)} onClick={() => ctx?.configure(entry, "install")}>Install</Button>}
                            </div>
                          </li>
                        );
                      })}
                    </ul>
                  )}
            </Panel>
          </>
        )}
      </Tabs>

      {sheetEntry && ctx && <AppSheet key={sheetEntry.manifest.id} entry={sheetEntry} ctx={ctx} tab={sheet?.tab} onTab={(next) => { rememberApp(sheetEntry.manifest.id, next); setSheet((current) => (current ? { ...current, tab: next } : current)); }} onClose={closeSheet} />}

      {config && (
        <ConfigSheet
          manifest={config.entry.manifest}
          live={config.entry.live}
          mode={config.mode}
          csrfToken={csrfToken}
          appNameFor={(id) => applications.find((entry) => entry.manifest.id === id)?.manifest.name ?? null}
          onCancel={() => { const back = config.back; setConfig(null); if (back) setSheet(back); }}
          onSubmit={(values: Values) => {
            const { entry: { manifest }, mode } = config;
            act({ operationId: mode === "install" ? "app.install" : "app.reconfigure", title: mode === "install" ? `Install ${manifest.name}` : `Change ${manifest.name} settings`, parameters: { id: manifest.id, values }, preview: <span>{mode === "install" ? `Pulls ${manifest.image.reference}, starts it with the settings you chose, and waits until it is healthy. Rolled back automatically if it fails.` : "Recreates the container with the new settings; the previous configuration is restored if it fails."}</span> });
          }}
        />
      )}

      {foreignLogs && (
        <Sheet kicker="Logs" title={foreignLogs.name} size="lg" onClose={() => setForeignLogs(null)} footer={<Button onClick={() => void showForeignLogs(foreignLogs.name)} busy={foreignLogs.lines === null && !foreignLogs.error}>Read again</Button>}>
          {foreignLogs.error
            ? <Notice tone="danger" live title="The logs could not be read">{foreignLogs.error}</Notice>
            : <CodeBlock label={`Logs for ${foreignLogs.name}`} meta={foreignLogs.lines ? `last ${foreignLogs.lines.length} lines` : undefined} follow empty={foreignLogs.lines === null ? "Reading…" : "(no output)"} maxHeight="calc(100vh - 220px)">{(foreignLogs.lines ?? []).join("\n")}</CodeBlock>}
        </Sheet>
      )}
    </div>
  );
}

/** Compose reports a compound status ("running(1), exited(1)"): a stack is running only when it is up with nothing stopped. */
function stackRunning(stack: ForeignStack): boolean {
  return /running|up/i.test(stack.status) && !/exited|stopped/i.test(stack.status);
}
