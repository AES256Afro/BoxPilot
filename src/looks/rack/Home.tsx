import { useMemo, type ReactNode } from "react";
import { openActivity, openNotifications } from "../../activityEvents";
import type { HomeProps } from "../../home/Home";
import { useFacts, valuesOf, type MountFact } from "../../home/facts";
import { greeting, uptime } from "../../home/format";
import { upsSummary } from "../../home/hostFacts";
import { actionsOf, appHealth, buildNeeds, runs, verdictFor, verdictSources, type Need, type NeedAction } from "../../home/needs";
import { usePerformance } from "../../home/Ops";
import { runWords, useNeedActions } from "../../home/useNeedActions";
import { Button } from "../../ui";
import type { RiskTier } from "../../ui/types";
import "./home.css";

/*
 * Home as a rack of equipment (M41; docs/design-directions/05-looks.html, M.rack): the same facts as
 * every other Home, mounted in brushed-metal units. The head unit names the server, lights its power
 * and uptime LEDs and an amber lamp when anything needs the owner, and shows the loads in red segment
 * windows; the apps are modules with an LED, a lever and a strip of label tape; what needs the owner
 * and what can wait are green LCDs with a push button for each fix (through the approval dialog at
 * its tier); the UPS unit shows the battery.
 */

const tierWord: Record<RiskTier, string> = { low: "LOW", medium: "MED", high: "HIGH" };
/** Keys a unit has room for beside its LCD, as the drawing has three. */
const maxKeys = 5;

/** A reading as a segment display draws it: three digits for a whole number, one decimal for a small one. */
export function segments(value: number | null, decimals = false): string {
  if (value === null || !Number.isFinite(value)) return "---";
  if (decimals) return value >= 100 ? String(Math.round(value)) : value.toFixed(1).padStart(4, "0");
  return String(Math.max(0, Math.min(999, Math.round(value)))).padStart(3, "0");
}

/** A push button's words, short as a label under a key: "Back up now" is BACK UP, a later "Back up nightly" NIGHTLY. */
export function keyWords(actions: NeedAction[]): string[] {
  const first = actions[0]?.label ?? "";
  return actions.map((action, index) => {
    let words = action.label;
    if (index > 0) {
      const a = first.split(" "), b = words.split(" ");
      let same = 0;
      while (same < a.length - 1 && same < b.length - 1 && a[same].toLowerCase() === b[same].toLowerCase()) same += 1;
      if (same > 0) words = b.slice(same).join(" ");
    }
    return words.replace(/\s+now$/i, "");
  });
}

const dataDrive = (mounts: MountFact[]) => mounts.filter((mount) => mount.target !== "/" && !mount.target.startsWith("/boot") && mount.total !== null && mount.percent !== null)
  .sort((a, b) => (b.percent ?? 0) - (a.percent ?? 0))[0] ?? null;

function Led({ state }: { state: "green" | "amber" | "red" | "off" }) {
  return <span className="rack-led" data-led={state} aria-hidden="true" />;
}

/** A red segment display in its black window, with its engraved label; it opens the figure's page. */
function Segment({ value, label, spoken, onOpen }: { value: string; label: string; spoken: string; onOpen: () => void }) {
  return (
    <button type="button" className="rack-seg" aria-label={spoken} onClick={onOpen}>
      <b aria-hidden="true">{value}</b>
      <span className="rack-eng" aria-hidden="true">{label}</span>
    </button>
  );
}

export default function RackHome({ csrfToken, role, onNavigate, now = Date.now }: HomeProps) {
  const { facts, refresh, accept } = useFacts();
  const clock = now();
  const values = useMemo(() => valuesOf(facts), [facts]);
  const needs = buildNeeds(values, { now: clock, role });
  const { act, runs: fixRuns, dialog } = useNeedActions({ csrfToken, refresh, accept, navigate: onNavigate });
  const performance = usePerformance(15_000, now);

  const inventory = values.inventory;
  const hostname = inventory?.hostname ?? "This server";
  const checking = verdictSources.some(([key]) => facts[key].state === "idle" || facts[key].state === "loading");
  const unread = verdictSources.filter(([key]) => facts[key].state === "failed").map(([, words]) => words);
  const verdict = verdictFor(needs, { hostname, checking, unread });
  const urgent = needs.filter((need) => need.severity !== "neutral");
  const waiting = needs.filter((need) => need.severity === "neutral");
  const open = (need: Need) => (need.jobId ? openActivity(need.jobId) : need.id === "unannounced" ? openNotifications() : onNavigate(need.view, need.appId && need.view === "catalog" ? { app: need.appId } : undefined));

  // ── The head unit's readings. ──
  const perf = performance.value;
  const cpu = perf?.cpu.usagePercent ?? inventory?.loadPercent ?? null;
  const memGb = perf ? perf.memory.usedBytes / 1024 ** 3 : inventory ? inventory.memoryUsed / 1024 ** 3 : null;
  const media = dataDrive(inventory?.mounts ?? []);
  const system = inventory?.mounts.find((mount) => mount.target === "/") ?? null;
  const drive = media ?? system;
  const driveLabel = media ? `${(media.target.split("/").filter(Boolean).at(-1) ?? "data").toUpperCase().slice(0, 6)} %` : "DISK %";
  const hottest = perf?.temps.length ? Math.max(...perf.temps.map((temp) => temp.celsius)) : null;

  // ── The apps, as modules. ──
  const apps = values.catalog?.apps ?? [];
  const protectionById = new Map((values.protection ?? []).map((entry) => [entry.id, entry]));
  const measured = new Map((perf?.statsAvailable ? perf.apps : []).map((entry) => [entry.id, entry]));

  // ── The UPS. ──
  const ups = inventory?.ups ?? null;
  const power = upsSummary(ups);
  const charge = ups?.charge ?? null;
  const upsLed: "green" | "amber" | "red" | "off" = !ups?.configured ? "off" : power.status === "good" ? "green" : power.status === "danger" ? "red" : "amber";

  /** One unit of fixes: its engraved name down the side, the LCD with a line a need, a key a fix. */
  const needsUnit = (title: string, list: Need[], first: number) => {
    const keys: ReactNode[] = [];
    list.forEach((need, index) => {
      const run = need.finding ? fixRuns[need.finding.id] : undefined;
      const busy = run && ["queued", "running", "checking"].includes(run.phase);
      const actions = actionsOf(need);
      const words = keyWords(actions);
      actions.forEach((action, at) => {
        const tone = action.kind === "dismiss" || action.kind === "open" || at > 0 ? "grey" : action.risk === "low" ? "green" : action.risk === "high" ? "red" : "amber";
        const label = `${action.label}: ${need.title}`;
        keys.push(action.kind === "dismiss" || action.kind === "open"
          ? <Button key={`${need.id}:${action.kind}:${action.label}`} className="rack-key" data-tone={tone} aria-label={label} onClick={() => act(need, action)}><i aria-hidden="true">{first + index}</i><span className="rack-eng">{words[at]}</span></Button>
          : <Button key={`${need.id}:${action.operationId}:${action.label}`} className="rack-key" data-tone={tone} risk={action.risk} disabled={Boolean(busy)} aria-label={label} onClick={() => act(need, action)}><i aria-hidden="true">{first + index}</i><span className="rack-eng">{words[at]}</span></Button>);
      });
    });
    // The keys the unit has room for; past that, one grey key to Ops, where every fix is.
    const shownKeys = keys.length > maxKeys ? [...keys.slice(0, maxKeys - 1),
      <Button key="more" className="rack-key" data-tone="grey" aria-label={`${keys.length - maxKeys + 1} more fixes on Ops`} onClick={() => onNavigate("ops")}><i aria-hidden="true">+{keys.length - maxKeys + 1}</i><span className="rack-eng">More</span></Button>] : keys;
    return (
      <section className="rack-u rack-row" aria-label={title}>
        <h2 className="rack-eng rack-side">{title}</h2>
        <div className="rack-lcd">
          {list.length === 0 && <p className="rack-lcd__line">{checking ? "READING THIS SERVER…" : "NOTHING. ALL CLEAR."}</p>}
          <ol>
            {list.map((need, index) => {
              const runnable = runs(need);
              const tier = runnable?.risk ?? need.risk ?? null;
              const run = need.finding ? fixRuns[need.finding.id] : undefined;
              return (
                <li key={need.id}>
                  <button type="button" className="rack-lcd__line" onClick={() => open(need)} title={need.detail ?? undefined}>
                    <span className="rack-lcd__n">{first + index}</span>
                    <span className="rack-lcd__words">{need.title}</span>
                    <span className="rack-lcd__tier">{tier ? tierWord[tier] : "LOOK"}</span>
                    {need.detail && <span className="ui-visually-hidden">. {need.detail}</span>}
                  </button>
                  {run && <span className="rack-lcd__run" role="status">{runWords(run)}</span>}
                </li>
              );
            })}
          </ol>
        </div>
        <div className="rack-keys">{shownKeys}</div>
      </section>
    );
  };

  return (
    <div className="rack-home">
      {dialog}
      <h1 className="ui-visually-hidden">{greeting(clock)}</h1>

      <section className="rack-u rack-head" aria-label="This server">
        <div className="rack-name">
          <b>{hostname}</b>
          <span className="rack-eng">BoxPilot {__BOXPILOT_VERSION__}{inventory ? ` · ${inventory.operatingSystem.replace(/\s+LTS$/, "")}` : ""}</span>
        </div>
        <div className="rack-leds">
          <span className="rack-eng"><Led state={inventory ? "green" : "off"} />Power</span>
          <span className="rack-eng"><Led state={inventory ? "green" : "off"} />{inventory ? `Up ${uptime(inventory.uptimeSeconds).replace(/(\d+)h$/, (_, h: string) => `${h.padStart(2, "0")}h`)}` : "Up --"}</span>
        </div>
        <span className="rack-lamp" data-lit={urgent.length > 0 || undefined} role="status">
          {urgent.length > 0 ? <>{urgent.length} to<br />look at</> : checking ? "Checking" : "All clear"}
        </span>
        <p className="rack-message">{verdict.sentence}</p>
        <div className="rack-segs">
          <Segment value={segments(cpu)} label="CPU %" spoken={`Processor ${cpu === null ? "not read" : `${Math.round(cpu)}%`}`} onOpen={() => onNavigate("performance")} />
          <Segment value={segments(memGb, true)} label="MEM GB" spoken={`Memory ${memGb === null ? "not read" : `${memGb.toFixed(1)} GB`}`} onOpen={() => onNavigate("performance")} />
          <Segment value={segments(drive?.percent ?? null)} label={driveLabel} spoken={`${drive ? (media ? media.target : "System disk") : "Disk"} ${drive?.percent === null || !drive ? "not read" : `${drive.percent}% full`}`} onOpen={() => onNavigate("storage")} />
          <Segment value={segments(hottest)} label="TEMP °C" spoken={`Hottest sensor ${hottest === null ? "not read" : `${Math.round(hottest)} °C`}`} onOpen={() => onNavigate("performance")} />
        </div>
      </section>

      <section className="rack-u" aria-label="Apps">
        {facts.catalog.state === "failed" && <p className="rack-quiet">Which apps are installed could not be read.</p>}
        {values.catalog && apps.length === 0 && (
          <p className="rack-quiet">No apps are installed yet. <Button className="rack-key" data-tone="grey" onClick={() => onNavigate(values.setup?.firstRun ? "setup" : "catalog")}><i aria-hidden="true">+</i><span className="rack-eng">{values.setup?.firstRun ? "Choose a setup profile" : "Add an app"}</span></Button></p>
        )}
        <ul className="rack-mods">
          {apps.map((app) => {
            const health = appHealth(app, protectionById.get(app.id), clock);
            const stats = measured.get(app.id);
            const live = app.running || app.paused;
            const on = app.running && !app.paused;
            const led = health.status === "good" ? "green" : health.status === "danger" ? "red" : health.status === "warning" ? "amber" : "off";
            const note = health.status === "good"
              ? `${app.port === null ? "" : `:${app.port} `}${stats && live ? `${stats.cpuPercent.toFixed(1)}%` : ""}`.trim() || "UP"
              : health.detail === "Never backed up" ? "No backup" : health.detail.replace(/^Backup (\d+)d old$/, "Backup $1d");
            return (
              <li key={app.id}>
                <button type="button" className="rack-mod" onClick={() => onNavigate("catalog", { app: app.id })} aria-label={`${app.name}, ${health.label}`}>
                  <span className="rack-mod__top"><Led state={led} /><span className="rack-sw" data-on={on || undefined} aria-hidden="true" /></span>
                  <span className="rack-tape">{app.name.replace(/\s*\(.*\)\s*$/, "").replace(/\s*\+.*$/, "")}</span>
                  <span className="rack-note" data-tone={health.status === "good" || health.status === "neutral" ? undefined : "amber"}>{note}</span>
                </button>
              </li>
            );
          })}
        </ul>
      </section>

      {needsUnit("Needs you", urgent, 1)}
      {needsUnit("Can wait", waiting, urgent.length + 1)}

      <section className="rack-u rack-ups" aria-label="UPS">
        <span className="rack-eng">UPS</span>
        <button type="button" className="rack-eng rack-ups__state" onClick={() => onNavigate("ops")}><Led state={upsLed} />{inventory ? power.label : "Not read"}</button>
        <span className="rack-cells" aria-hidden="true">
          {Array.from({ length: 10 }, (_, index) => <i key={index} data-lit={charge !== null && index < Math.round(charge / 10) || undefined} />)}
        </span>
        <span className="rack-eng">{charge === null ? power.headline : `Battery ${charge}%${ups?.runtimeSeconds ? ` · ${Math.round(ups.runtimeSeconds / 60)} min` : ""}`}</span>
        <span className="rack-vent" aria-hidden="true" />
      </section>
    </div>
  );
}
