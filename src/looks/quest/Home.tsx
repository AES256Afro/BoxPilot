import { useId, useMemo, useState } from "react";
import { openActivity, openNotifications } from "../../activityEvents";
import { useOperation } from "../../shell/ApproveDialog";
import { AppSheet } from "../../home/AppSheet";
import { useFacts, valuesOf, type AppFact } from "../../home/facts";
import { greeting, size } from "../../home/format";
import type { HomeProps } from "../../home/Home";
import { actionsOf, appHealth, backupOperation, buildNeeds, runs, verdictFor, verdictSources, type Need, type NeedAction } from "../../home/needs";
import { runWords, useNeedActions } from "../../home/useNeedActions";
import type { AppProtection } from "../../backupProtection";
import { appHue, riskCopy, type RiskTier, type Status } from "../../ui";
import { fullestDrive, hottestSensor, useLivePerformance } from "../cockpit/livePerformance";
import "./home.css";

/*
 * Home in the Quest look (M41, docs/design-directions/05-looks.html, M.quest): an RPG's party
 * screen. Every installed app is a party member, with a status effect for what is wrong with it
 * (never backed up, an old backup, asleep) and an HP bar that says how it is; everything that needs
 * you is a quest, its words, what it earns and its risk, with Accept running the fix through the
 * approval dialog at its tier; what can wait is a side quest. The server's own figures are its
 * stats, and it greets you in a dialog box at the bottom.
 */

const tierWords: Record<RiskTier, string> = { low: "low", medium: "medium", high: "high" };
const numberWords = ["No", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten", "Eleven", "Twelve"];

/** A need as a quest: a name for it, and what finishing it earns. */
function questOf(need: Need, appName: (id: string) => string): { name: string; reward: string } {
  const operation = runs(need)?.operationId ?? "";
  const app = need.appId ? appName(need.appId) : null;
  if (need.kind === "backup" || backupOperation.test(operation) || need.view === "backups" || need.finding?.id.startsWith("backup")) return { name: "Guard the vault", reward: "sleep well" };
  if (need.id === "reboot") return { name: "Rest at the inn", reward: "a fresh start" };
  if (need.kind === "updates") return { name: "Patch day", reward: "+1 security" };
  if (need.id.startsWith("app-vpn")) return { name: `Plug ${app ?? "the"} leak`, reward: "stay hidden" };
  if (need.id.startsWith("app-down") || need.id === "apps-missing") return { name: app ? `Revive ${app}` : "Revive the fallen", reward: "the whole party back" };
  if (app) return { name: `Heal ${app}`, reward: "+HP" };
  if (need.kind === "approval") return { name: "A decision awaits", reward: "the job goes ahead" };
  if (need.kind === "job") return { name: "Back to the dungeon", reward: "the job done" };
  if (need.view === "storage") return { name: "Make room in the bag", reward: "room to grow" };
  if (need.view === "network" || need.view === "firewall") return { name: "Guard the gate", reward: "a safer road" };
  if (need.kind === "setup") return { name: "Begin the journey", reward: "a server ready" };
  if (need.kind === "alert") return { name: "Heed the warning", reward: "peace of mind" };
  return { name: "Mend what is broken", reward: "peace of mind" };
}

/** What can wait, as a side quest's few words. */
function sideOf(need: Need, appName: (id: string) => string): string {
  const app = need.appId ? appName(need.appId) : null;
  if (app && need.id.startsWith("app-paused")) return `wake ${app}`;
  if (app && need.id.startsWith("app-update")) return `new gear for ${app}`;
  if (app && need.id.startsWith("app-stopped")) return `rouse ${app}`;
  if (need.id === "updates") return "fresh supplies";
  if (need.id === "unattended") return "hire a night watch";
  return need.title.charAt(0).toLowerCase() + need.title.slice(1);
}

/** A quest's words: the need's, with its detail when that is a few words more. */
function sentence(need: Need): string {
  const stop = (text: string) => (/[.!?…]$/.test(text) ? text : `${text}.`);
  return need.detail && need.detail.length <= 32 ? `${stop(need.title)} ${stop(need.detail)}` : stop(need.title);
}

/** A member's status effect, from what is wrong with it; null when it is fine. */
function effectOf(app: AppFact, protection: AppProtection | undefined, now: number): { tag: string; tone: "bad" | "calm" } | null {
  if (app.vpnLeaked) return { tag: "LEAKED", tone: "bad" };
  if (!app.running && !app.paused) {
    if (app.status === "absent") return { tag: "LOST", tone: "bad" };
    if (app.stoppedOnPurpose && app.status !== "restarting") return { tag: "RESTING", tone: "calm" };
    return { tag: "KO", tone: "bad" };
  }
  if (app.paused) return { tag: "ASLEEP", tone: "calm" };
  if (app.troubledSidecar || app.health === "unhealthy") return { tag: "POISONED", tone: "bad" };
  if (app.folderProblems > 0) return { tag: "CAN'T SAVE", tone: "bad" };
  if (protection?.protectable) {
    const newest = protection.newestAt ? Date.parse(protection.newestAt) : Number.NaN;
    if (protection.backups === 0 || !Number.isFinite(newest)) return { tag: "UNPROTECTED", tone: "bad" };
    if (Math.floor((now - newest) / 86_400_000) > 14) return { tag: "STALE SAVE", tone: "bad" };
  }
  return null;
}

const hpOf: Record<Status, { hp: number; tone: string }> = {
  good: { hp: 100, tone: "full" },
  warning: { hp: 55, tone: "hurt" },
  danger: { hp: 15, tone: "low" },
  neutral: { hp: 100, tone: "asleep" },
  unknown: { hp: 100, tone: "asleep" },
};

/** "11/32 GB": both in the unit of the larger when they share it. */
function amountOf(used: number | null, total: number | null): string {
  const [a, b] = [size(used), size(total)];
  const unit = / (\w+)$/.exec(b)?.[1];
  return unit && a.endsWith(` ${unit}`) ? `${a.replace(` ${unit}`, "")}/${b}` : `${a}/${b}`;
}

export default function QuestHome({ csrfToken, role, onNavigate, now = Date.now }: HomeProps) {
  const { facts, refresh, accept } = useFacts();
  const clock = now();
  const values = useMemo(() => valuesOf(facts), [facts]);
  const needs = buildNeeds(values, { now: clock, role });
  const { start, dialog } = useOperation(csrfToken, () => refresh());
  const { act, runs: fixRuns, dialog: needDialog } = useNeedActions({ csrfToken, refresh, accept, navigate: onNavigate });
  const performance = useLivePerformance(30_000);
  const [sheetFor, setSheetFor] = useState<string | null>(null);

  const inventory = values.inventory;
  const hostname = inventory?.hostname ?? "This server";
  const checking = verdictSources.some(([key]) => facts[key].state === "idle" || facts[key].state === "loading");
  const unread = verdictSources.filter(([key]) => facts[key].state === "failed").map(([, words]) => words);
  const verdict = verdictFor(needs, { hostname, checking, unread });
  const open = (need: Need) => (need.jobId ? openActivity(need.jobId) : need.id === "unannounced" ? openNotifications() : onNavigate(need.view, need.appId && need.view === "catalog" ? { app: need.appId } : undefined));

  const catalog = values.catalog;
  const apps = catalog?.apps ?? [];
  const appName = (id: string) => apps.find((app) => app.id === id)?.name ?? id;
  const protectionById = new Map((values.protection ?? []).map((entry) => [entry.id, entry]));
  const stats = new Map((performance.value?.statsAvailable ? performance.value.apps : []).map((entry) => [entry.id, entry]));
  const awake = apps.filter((app) => app.running && !app.paused).length;
  const level = inventory ? Math.floor(inventory.uptimeSeconds / 86_400) : null;
  const sheetApp = sheetFor ? apps.find((app) => app.id === sheetFor) ?? null : null;

  const main = needs.filter((need) => need.severity !== "neutral");
  const side = needs.filter((need) => need.severity === "neutral");
  const count = numberWords[main.length] ?? String(main.length);

  const drive = fullestDrive(inventory);
  const heat = hottestSensor(performance.value);
  const memory = performance.value?.memory ?? (inventory ? { usedBytes: inventory.memoryUsed, totalBytes: inventory.memoryTotal, usedPercent: inventory.memoryPercent } : null);

  return (
    <div className="quest-home">
      {dialog}
      {needDialog}

      <section className="quest-win quest-party" aria-labelledby="quest-party-title">
        <h2 className="quest-head" id="quest-party-title">
          PARTY{" "}<span>{catalog ? `${apps.length} ${apps.length === 1 ? "member" : "members"} · ${awake} awake` : facts.catalog.state === "failed" ? "not read" : "gathering…"}</span>
        </h2>
        {facts.catalog.state === "failed" && <p className="quest-quiet">The party could not be read. <button type="button" className="quest-link" onClick={() => void refresh(["catalog"])}>Try again</button></p>}
        {catalog && !catalog.liveKnown && <p className="quest-quiet">Docker did not say which apps are installed.</p>}
        {catalog && catalog.liveKnown && apps.length === 0 && <p className="quest-quiet">No party yet. <button type="button" className="quest-link" onClick={() => onNavigate("catalog")}>Recruit an app</button></p>}
        <ul className="quest-members">
          {apps.map((app) => {
            const protection = protectionById.get(app.id);
            const health = appHealth(app, protection, clock);
            const effect = effectOf(app, protection, clock);
            const measured = stats.get(app.id);
            const { hp, tone } = hpOf[health.status];
            return (
              <li key={app.id}>
                <button type="button" className="quest-mem" aria-label={`${app.name}, ${health.label}`} onClick={() => setSheetFor(app.id)}>
                  <span className="quest-av" data-hue={appHue(app.id)} aria-hidden="true">{app.name.charAt(0)}</span>
                  <b className="quest-mem__name"><span>{app.name}</span>{level !== null && <small>LV {level}</small>}</b>
                  {effect
                    ? <span className="quest-fx" data-tone={effect.tone}>{effect.tag}</span>
                    : <span className="quest-mem__stat">{measured && (app.running || app.paused) ? `${measured.cpuPercent.toFixed(1)}% · ${size(measured.memBytes)}` : health.detail}</span>}
                  <span className="quest-hp" data-tone={tone} aria-hidden="true"><span><i style={{ width: `${hp}%` }} /></span>HP {hp}/100</span>
                </button>
              </li>
            );
          })}
        </ul>
      </section>

      <div className="quest-right">
        <section className="quest-win quest-quests" aria-labelledby="quest-quests-title">
          <h2 className="quest-head" id="quest-quests-title">QUESTS{" "}<span>{main.length} main · {side.length} side</span></h2>
          {main.length === 0 && <p className="quest-quiet">{checking ? "Reading the quest board…" : unread.length ? "No quests in what could be read." : "No quests today. The party rests."}</p>}
          <ul className="quest-list">
            {main.map((need) => {
              const quest = questOf(need, appName);
              const runnable = runs(need);
              const actions = actionsOf(need);
              const run = need.finding ? fixRuns[need.finding.id] : undefined;
              const busy = Boolean(run && ["queued", "running", "checking"].includes(run.phase));
              return (
                <li key={need.id} className="quest-quest" data-severity={need.severity}>
                  <button type="button" className="quest-quest__name" onClick={() => open(need)}>
                    <span aria-hidden="true">▶ </span>{quest.name}<span className="ui-visually-hidden">: {need.title}</span>
                  </button>
                  <p className="quest-quest__words" title={need.detail ?? undefined}>{sentence(need)}</p>
                  <p className="quest-quest__reward">Reward: {quest.reward} · {runnable ? `Risk: ${tierWords[runnable.risk]}` : need.risk ? `Staged at ${tierWords[need.risk]} risk` : "Look into it"}</p>
                  {run && <p className="quest-quest__run" role="status" data-phase={run.phase}>{runWords(run)}</p>}
                  <div className="quest-acts">
                    {actions.map((action) => <QuestButton key={`${action.kind ?? "operation"}:${action.operationId}:${action.label}`} need={need} action={action} main={action === runnable} tierShown={runnable?.risk} disabled={busy && action.kind !== "dismiss" && action.kind !== "open"} onAct={act} />)}
                    {actions.length === 0 && <button type="button" className="quest-btn quest-btn--plain" onClick={() => open(need)}>Look</button>}
                  </div>
                </li>
              );
            })}
            {side.length > 0 && (
              <li className="quest-quest quest-side">
                <span className="quest-side__label">Side:</span>{" "}
                {side.map((need, index) => (
                  <span key={need.id}>
                    {index > 0 && <span aria-hidden="true"> · </span>}
                    <button type="button" className="quest-link quest-side__one" aria-label={`${sideOf(need, appName)}: ${need.title}`} onClick={() => open(need)}>{sideOf(need, appName)}</button>
                  </span>
                ))}
              </li>
            )}
          </ul>
        </section>

        <section className="quest-win quest-stats" aria-labelledby="quest-stats-title">
          <h2 className="quest-head" id="quest-stats-title">{hostname.toUpperCase()}{" "}<span>{[level !== null ? `LV ${level}` : null, inventory?.operatingSystem.split(" ")[0]].filter(Boolean).join(" · ")}</span></h2>
          <p className="quest-verdict" data-status={verdict.status}>{verdict.sentence}</p>
          <div className="quest-bars">
            <button type="button" className="quest-bar" data-stat="mana" aria-label={`Mana, the memory: ${memory ? `${amountOf(memory.usedBytes, memory.totalBytes)}, ${memory.usedPercent}%` : "not read"}`} onClick={() => onNavigate("performance")}>
              <span className="quest-bar__name">MANA</span><span className="quest-bar__track"><i style={{ width: `${memory?.usedPercent ?? 0}%` }} /></span><span className="quest-bar__value">{memory ? amountOf(memory.usedBytes, memory.totalBytes) : "?"}</span>
            </button>
            <button type="button" className="quest-bar" data-stat="bag" aria-label={`Bag, ${drive ? (drive.target === "/" ? "the system disk" : drive.target) : "the data drive"}: ${drive ? `${amountOf(drive.used, drive.total)}, ${drive.percent}%` : "not read"}`} onClick={() => onNavigate("storage")}>
              <span className="quest-bar__name">BAG</span><span className="quest-bar__track"><i style={{ width: `${drive?.percent ?? 0}%` }} /></span><span className="quest-bar__value">{drive ? amountOf(drive.used, drive.total) : "?"}</span>
            </button>
            <button type="button" className="quest-bar" data-stat="heat" aria-label={`Heat, the hottest sensor: ${heat ? `${heat.celsius} °C` : "not read"}`} onClick={() => onNavigate("performance")}>
              <span className="quest-bar__name">HEAT</span><span className="quest-bar__track"><i style={{ width: `${Math.min(100, heat?.celsius ?? 0)}%` }} /></span><span className="quest-bar__value">{heat ? `${heat.celsius} °C` : "?"}</span>
            </button>
          </div>
        </section>
      </div>

      <div className="quest-win quest-say">
        <b>{hostname.toUpperCase()}:</b>
        <div className="quest-say__text"><h1 className="quest-say__hello">{greeting(clock)}</h1>! {main.length ? `${count} ${main.length === 1 ? "quest is" : "quests are"} waiting for you.` : checking ? "Let me look around…" : "Nothing needs you. The party rests."}</div>
        <span className="quest-blink" aria-hidden="true">▼</span>
      </div>

      {sheetApp && <AppSheet app={sheetApp} protection={protectionById.get(sheetApp.id)} now={clock} role={role} onClose={() => setSheetFor(null)} onNavigate={onNavigate} onStart={start} />}
    </div>
  );
}

/** Accept runs the quest's fix at its tier; any other fix says its own words, and its tier when it differs. */
function QuestButton({ need, action, main, tierShown, disabled, onAct }: { need: Need; action: NeedAction; main: boolean; tierShown?: RiskTier; disabled: boolean; onAct: (need: Need, action?: NeedAction | null) => void }) {
  const tierId = useId();
  const runsSomething = action.kind !== "dismiss" && action.kind !== "open";
  const words = main ? "Accept" : action.label;
  const tier = runsSomething && !main && action.risk !== tierShown ? ` · ${tierWords[action.risk]}` : "";
  return (
    <>
      <button type="button" className={main ? "quest-btn" : "quest-btn quest-btn--plain"} data-risk={runsSomething ? action.risk : undefined} disabled={disabled}
        aria-label={`${main ? `Accept, ${action.label}` : action.label}: ${need.title}`} aria-describedby={runsSomething ? tierId : undefined} onClick={() => onAct(need, action)}>
        {words}{tier}
      </button>
      {runsSomething && <span id={tierId} hidden>{riskCopy[action.risk].description}</span>}
    </>
  );
}
