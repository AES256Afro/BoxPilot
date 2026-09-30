import { useMemo, useState } from "react";
import { openActivity, openNotifications } from "../../activityEvents";
import { countOf, sentenceList } from "../../data";
import { AppSheet } from "../../home/AppSheet";
import { useFacts, valuesOf, type InventoryFacts, type MountFact } from "../../home/facts";
import { greeting } from "../../home/format";
import type { HomeProps } from "../../home/Home";
import { actionsOf, appHealth, buildNeeds, runs, verdictFor, verdictSources, type Need, type NeedAction } from "../../home/needs";
import { runWords, useNeedActions } from "../../home/useNeedActions";
import type { FixRun } from "../../repair/useRepairFixes";
import { useOperation } from "../../shell/ApproveDialog";
import { TopBarSlot } from "../../shell/TopBarSlot";
import { Button, riskCopy } from "../../ui";
import { appHue, type AppHue } from "../../ui/appColor";
import "./home.css";

/*
 * Home in the Toybox look (M41), as docs/design-directions/05-looks.html draws it (M.toybox): a
 * robot that says how the server is doing in a speech bubble, then chunky cards down the left
 * (what needs you, what can wait, three candy-stripe bars) and the apps as pastel bubbles on the
 * right, a yellow "!" sticker on the ones that need a look. Buttons are pills that press down; the
 * main one is yellow. Every fix goes through the approval dialog at its tier, said in words beside
 * the buttons. For people who only need to know it is fine and what to tap.
 */

const severityWords = { danger: "Problem", warning: "Needs a look", neutral: "Suggestion" } as const;
/** How many rows each card shows before "Show more". */
const shownRows = 2;

/** The app's pastel, from the hue it has everywhere else. */
const pastel: Record<AppHue, string> = {
  violet: "#d8c8ff", indigo: "#cbd8ff", blue: "#c6d6ff", sky: "#bfe3ff", cyan: "#bff0f3", teal: "#b8f0d2", green: "#c9f5c0", olive: "#e1f0b8",
  amber: "#ffe7a6", orange: "#ffd6bf", red: "#ffc2c2", pink: "#ffc9dc", plum: "#f0c9ff", slate: "#ffc9dc", graphite: "#e3e3ea",
};

/** The round dot a row leads with: a glyph on a colour, both decoration beside the words. */
function dotOf(need: Need): { glyph: string; color: string } {
  if (need.id.startsWith("app-paused:") || need.id.startsWith("app-stopped:")) return { glyph: "z", color: "#e3e3ea" };
  if (need.id.startsWith("app-update:")) return { glyph: "↑", color: "#cfbcff" };
  if (need.id === "updates") return { glyph: /^\d+/.exec(need.title)?.[0] ?? "↑", color: "#a9d0ff" };
  if (need.kind === "approval") return { glyph: "?", color: "#cfbcff" };
  if (need.kind === "setup") return { glyph: "+", color: "#9ee8bb" };
  if (need.severity === "danger" || need.kind === "job") return { glyph: "!", color: "#ffb3d1" };
  if (need.severity === "neutral") return { glyph: "i", color: "#e3e3ea" };
  return { glyph: "!", color: "#ffd84d" };
}

/** A few of the list's sentences, said the way the robot says them; the facts stay the same. */
function friendly(need: Need): string {
  const app = need.id.startsWith("app-") ? need.title.replace(/ is (paused|stopped)$/, "").replace(/^An update for /, "") : "";
  if (need.id.startsWith("app-paused:")) return `${app} is napping, on purpose`;
  if (need.id.startsWith("app-update:")) return `${app} has a new version`;
  return need.title;
}

/** "Media drive" for /mnt/media; the largest mount that is not the system disk, else the system disk. */
function dataDrive(inventory: InventoryFacts | null | undefined): { mount: MountFact; name: string } | null {
  const mounts = (inventory?.mounts ?? []).filter((mount) => mount.total !== null);
  const mount = mounts.filter((entry) => entry.target !== "/").sort((a, b) => (b.total ?? 0) - (a.total ?? 0))[0] ?? mounts.find((entry) => entry.target === "/");
  if (!mount) return null;
  const last = mount.target.split("/").filter(Boolean).pop();
  return { mount, name: last ? `${last.charAt(0).toUpperCase()}${last.slice(1)} drive` : "System disk" };
}

/** How an app is doing, in a word a family member would use. */
function mood(status: string, label: string): string {
  if (status === "good") return "happy";
  if (label === "Paused") return "napping";
  if (label === "Stopped") return "switched off";
  if (/backed up|backup/i.test(label)) return "needs a backup";
  return label.toLowerCase();
}

function Row({ need, run, lead, onOpen, onAct }: { need: Need; run?: FixRun; lead: boolean; onOpen: (need: Need) => void; onAct: (need: Need, action?: NeedAction | null) => void }) {
  const dot = dotOf(need);
  const runnable = runs(need);
  const tier = runnable?.risk ?? need.risk;
  const actions = actionsOf(need);
  const busy = Boolean(run && ["queued", "running", "checking"].includes(run.phase));
  const first = actions.find((action) => action.kind !== "dismiss" && action.kind !== "open");
  return (
    <li className="toybox-need" data-severity={need.severity}>
      <span className="toybox-dot" style={{ background: dot.color }} aria-hidden="true">{dot.glyph}</span>
      <button type="button" className="toybox-need__title" onClick={() => onOpen(need)}>
        <span className="ui-visually-hidden">{`${severityWords[need.severity]}:`}</span>{` ${friendly(need)}`}
      </button>
      {(actions.length > 0 || tier || run) && (
        <div className="toybox-need__acts">
          {actions.map((action) => (action.kind === "dismiss"
            ? <Button key="dismiss" aria-label={`Dismiss: ${need.title}`} onClick={() => onAct(need, action)}>Dismiss</Button>
            : action.kind === "open"
              ? <Button key={`open:${action.label}`} aria-label={`${action.label}: ${need.title}`} onClick={() => onAct(need, action)}>{action.label}</Button>
              : <Button key={`${action.operationId}:${action.label}`} variant={lead && action === first ? "primary" : "secondary"} risk={action.risk} disabled={busy}
                aria-label={`${action.label}: ${need.title}`} onClick={() => onAct(need, action)}>{action.label}</Button>))}
          {/* The buttons carry the tier for assistive technology; this is the same word on screen. */}
          {tier && <span className="toybox-tier" data-tier={tier} aria-hidden={runnable ? true : undefined}>{riskCopy[tier].label} risk</span>}
          {run && <span className="toybox-need__run" role="status">{runWords(run)}</span>}
        </div>
      )}
    </li>
  );
}

function Card({ title, needs, lead, runOf, onOpen, onAct }: { title: string; needs: Need[]; lead: boolean; runOf: (need: Need) => FixRun | undefined; onOpen: (need: Need) => void; onAct: (need: Need, action?: NeedAction | null) => void }) {
  const [all, setAll] = useState(false);
  const id = `toybox-${title.toLowerCase().replace(/\W+/g, "-")}`;
  const shown = all ? needs : needs.slice(0, shownRows);
  return (
    <section className="toybox-card toybox-needs" aria-labelledby={id}>
      <h2 className="toybox-card__title" id={id}>{title}</h2>
      <ul className="toybox-needs__list">{shown.map((need) => <Row key={need.id} need={need} run={runOf(need)} lead={lead} onOpen={onOpen} onAct={onAct} />)}</ul>
      {needs.length > shownRows && (
        <button type="button" className="toybox-more" aria-expanded={all} onClick={() => setAll((value) => !value)}>
          {all ? "Show fewer" : `Show ${needs.length - shownRows} more`}
        </button>
      )}
    </section>
  );
}

export default function ToyboxHome({ csrfToken, role, onNavigate, now = Date.now }: HomeProps) {
  const { facts, refresh, accept } = useFacts();
  const clock = now();
  const values = useMemo(() => valuesOf(facts), [facts]);
  const needs = buildNeeds(values, { now: clock, role });
  const { start, dialog } = useOperation(csrfToken, () => refresh());
  const { act, runs: fixRuns, remembered, dialog: needDialog } = useNeedActions({ csrfToken, refresh, accept, navigate: onNavigate });
  const [sheetFor, setSheetFor] = useState<string | null>(null);

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
  const problems = urgent.filter((need) => need.severity === "danger").length;
  const hello = `${greeting(clock).replace(/^Good /, "").replace(/^./, (letter) => letter.toUpperCase())}!`;
  const says = problems > 0 ? `${hello} I need help: ${countOf(problems, "problem")}.`
    : urgent.length > 0 ? `${hello} ${urgent.length === 1 ? "One thing needs" : `${urgent.length} things need`} you.`
      : checking ? `${hello} Let me have a look…` : `${hello} I'm running fine.`;

  const catalog = facts.catalog.value;
  const apps = catalog?.apps ?? [];
  const protectionById = new Map((values.protection ?? []).map((entry) => [entry.id, entry]));
  const healths = apps.map((app) => ({ app, health: appHealth(app, protectionById.get(app.id), clock) }));
  const sheetApp = sheetFor ? apps.find((app) => app.id === sheetFor) ?? null : null;

  const drive = dataDrive(inventory);
  const bars = inventory ? [
    { key: "memory", label: "Memory", percent: inventory.memoryPercent, color: "#cfbcff", view: "performance" as const },
    ...(drive ? [{ key: "drive", label: drive.name, percent: drive.mount.percent ?? 0, color: "#ffb3d1", view: "storage" as const }] : []),
    { key: "cpu", label: "Busy-ness", percent: inventory.loadPercent, color: "#9ee8bb", view: "performance" as const },
  ] : [];

  return (
    <div className="toybox-home">
      {dialog}
      {needDialog}
      <TopBarSlot>
        <div className="cc-crumb toybox-crumb">
          <span className="cc-crumb__host">{hostname}</span>
          <span className="toybox-crumb__page">Home</span>
        </div>
      </TopBarSlot>
      <h1 className="ui-visually-hidden">{greeting(clock)}</h1>

      <div className="toybox-left">
        <div className="toybox-hero">
          <div className="toybox-bot" aria-hidden="true"><i /></div>
          <div className="toybox-card toybox-say">
            <p className="toybox-say__line">{says}</p>
            <p className="toybox-say__verdict">{verdict.sentence}</p>
          </div>
        </div>

        {urgent.length > 0
          ? <Card title="Needs you" needs={urgent} lead runOf={runOf} onOpen={open} onAct={act} />
          : (
            <section className="toybox-card toybox-needs" aria-labelledby="toybox-needs-you">
              <h2 className="toybox-card__title" id="toybox-needs-you">Needs you</h2>
              <p className="toybox-quiet"><span className="toybox-dot" style={{ background: "#9ee8bb" }} aria-hidden="true">✓</span>{checking ? "Reading this server…" : unread.length ? "Nothing wrong in what could be read." : "Nothing needs you right now."}</p>
            </section>
          )}
        {justFixed.map((finding) => {
          const run = fixRuns[finding.id];
          return <p key={finding.id} className="toybox-fixed" role="status">{run.phase === "scheduled" ? "Scheduled" : "Fixed"}: {finding.title}. {run.phase === "fixed" ? run.changed : run.phase === "scheduled" ? run.message : ""}</p>;
        })}
        {unread.length > 0 && <p className="toybox-fixed">BoxPilot could not read {sentenceList(unread)}, so this list may be missing something.</p>}
        {waiting.length > 0 && <Card title="Can wait" needs={waiting} lead={false} runOf={runOf} onOpen={open} onAct={act} />}

        {bars.length > 0 && (
          <section className="toybox-card toybox-bars" aria-label="How full and how busy">
            {bars.map((bar) => (
              <button key={bar.key} type="button" className="toybox-bar" onClick={() => onNavigate(bar.view)}>
                <span className="toybox-bar__label">{bar.label}</span>
                <span className="toybox-bar__track" aria-hidden="true"><i style={{ width: `${Math.max(0, Math.min(100, bar.percent))}%`, background: `repeating-linear-gradient(-45deg, ${bar.color} 0 7.8px, rgba(255, 255, 255, 0.45) 7.8px 12.5px), ${bar.color}` }} /></span>
                <span className="toybox-bar__value">{bar.percent}%</span>
              </button>
            ))}
          </section>
        )}
        {!inventory && <p className="toybox-fixed">{facts.inventory.state === "failed" ? "How full and how busy could not be read." : "Reading how full and how busy…"}</p>}
      </div>

      <section className="toybox-card toybox-apps" aria-labelledby="toybox-apps-title">
        <h2 className="toybox-card__title" id="toybox-apps-title">Your apps</h2>
        {facts.catalog.state === "failed" && <p className="toybox-quiet">Which apps are installed could not be read. <Button onClick={() => refresh(["catalog"])}>Try again</Button></p>}
        {catalog && !catalog.liveKnown && <p className="toybox-quiet">Docker did not say which apps are installed, so none are shown. The App catalog has the details.</p>}
        <ul className="toybox-apps__grid">
          {healths.map(({ app, health }) => {
            const needsLook = health.status === "warning" || health.status === "danger";
            return (
              <li key={app.id}>
                <button type="button" className="toybox-app" data-status={health.status} aria-label={`${app.name}, ${health.label}`} onClick={() => setSheetFor(app.id)}>
                  <span className="toybox-app__bubble" style={{ background: pastel[appHue(app.id)] }} aria-hidden="true">
                    <span>{app.icon || app.name.slice(0, 1).toUpperCase()}</span>
                  </span>
                  <span className="toybox-app__name">{app.name}</span>
                  <span className="toybox-app__mood">{mood(health.status, health.label)}</span>
                  {needsLook && <span className="toybox-app__sticker" aria-hidden="true">!</span>}
                </button>
              </li>
            );
          })}
          {(catalog || facts.catalog.state !== "failed") && (
            <li>
              <button type="button" className="toybox-app toybox-app--add" onClick={() => onNavigate(values.setup?.firstRun ? "setup" : "catalog")}>
                <span className="toybox-app__bubble" aria-hidden="true"><span>+</span></span>
                <span className="toybox-app__name">Add an app</span>
                <span className="toybox-app__mood">{catalog ? `${catalog.total} to pick from` : "From the catalog"}</span>
              </button>
            </li>
          )}
        </ul>
      </section>

      {sheetApp && <AppSheet app={sheetApp} protection={protectionById.get(sheetApp.id)} now={clock} role={role} onClose={() => setSheetFor(null)} onNavigate={onNavigate} onStart={start} />}
    </div>
  );
}
