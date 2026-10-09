import { useState } from "react";
import type { HomeProps } from "../../home/Home";
import { greeting } from "../../home/format";
import { actionsOf, type Need, type NeedAction } from "../../home/needs";
import { runWords } from "../../home/useNeedActions";
import { TopBarSlot } from "../../shell/TopBarSlot";
import { Button } from "../../ui";
import { riskCopy } from "../../ui/Button";
import { clockTime, dataDrive, shortName, stateWords, useHomeData } from "./homeData";
import "./home.css";

/*
 * Home as a Swiss poster (M41, docs/design-directions/05-looks.html, M.swiss): white paper, black
 * ink and one red. The number of things that need a look is the biggest thing on the screen, four
 * figures under it on rules, the headline and the needs as ruled rows on the right, each with its
 * tier in red capitals (grey for low) and a black rectangle that starts the fix through the
 * approval dialog, and the apps in three columns at the foot. No boxes: only type and rules.
 */

/** How many needs are listed before "Show all". */
const shown = 5;

const tierWord = (need: Need, action: NeedAction | null): { word: string; low: boolean } => {
  const risk = action?.kind === "open" || action?.kind === "dismiss" ? undefined : action?.risk ?? need.risk;
  if (risk) return { word: riskCopy[risk].label, low: risk === "low" };
  if (need.severity === "danger") return { word: "Problem", low: false };
  if (need.severity === "warning") return { word: "Look", low: false };
  return { word: "Can wait", low: true };
};

const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
/** Tue 30.09.2026 07:41, as the poster prints the date. */
function posterDate(at: number): string {
  const date = new Date(at);
  return `${weekday[date.getDay()]} ${String(date.getDate()).padStart(2, "0")}.${String(date.getMonth() + 1).padStart(2, "0")}.${date.getFullYear()} ${clockTime(at)}`;
}

export default function SwissHome(props: HomeProps) {
  const { onNavigate } = props;
  const data = useHomeData(props);
  const { clock, needs, urgent, verdict, checking, unread, inventory, hostname, rows, glance, act, runOf, open, dialog } = data;
  const [all, setAll] = useState(false);

  const count = urgent.length;
  const danger = urgent.some((need) => need.severity === "danger");
  const headline = count === 0
    ? (checking ? "Reading this server." : unread.length ? "Nothing wrong found." : "Nothing needs a look.")
    : `${count === 1 ? "thing" : "things"} ${danger ? (count === 1 ? "needs you" : "need you") : (count === 1 ? "needs a look" : "need a look")}.`;
  // The headline says how many need a look; the line under it says the rest of the verdict.
  const rest = verdict.sentence.replace(/\s*(One thing needs|\d+ things need) a look\./, "").trim();
  const listed = all ? needs : needs.slice(0, shown);

  const drive = dataDrive(inventory?.mounts ?? []);
  const backedUp = glance.apps.bar ? `${glance.apps.bar.value}/${glance.apps.bar.max}` : "—";
  const figures: Array<{ id: string; value: string; label: string; attention: boolean; go: () => void }> = [
    { id: "cpu", value: inventory ? `${inventory.loadPercent}%` : "—", label: "Processor", attention: (inventory?.loadPercent ?? 0) >= 80, go: () => onNavigate("performance") },
    { id: "memory", value: inventory ? `${inventory.memoryPercent}%` : "—", label: "Memory", attention: (inventory?.memoryPercent ?? 0) >= 85, go: () => onNavigate("performance") },
    { id: "drive", value: drive?.mount.percent === null || !drive ? "—" : `${drive.mount.percent}%`, label: drive?.name ?? "Disks", attention: drive?.mount.state === "warning" || drive?.mount.state === "critical", go: () => onNavigate("storage") },
    { id: "backups", value: backedUp, label: "Apps backed up", attention: false, go: () => onNavigate("backups") },
  ];

  return (
    <div className="swiss-home">
      {dialog}
      <TopBarSlot>
        <span className="swiss-bar">
          <span className="swiss-bar__page">Home</span>
          <span className="swiss-bar__host">{hostname}</span>
          {inventory?.operatingSystem && <span className="swiss-bar__os">{inventory.operatingSystem}</span>}
        </span>
        <time className="swiss-bar__date" dateTime={new Date(clock).toISOString()}>{posterDate(clock)}</time>
      </TopBarSlot>
      <h1 className="ui-visually-hidden">{greeting(clock)}</h1>

      <div className="swiss-left">
        <p className="swiss-num" data-none={count === 0 || undefined} data-digits={Math.min(3, String(count).length)} aria-hidden="true">{count}</p>
        <div className="swiss-metrics">
          {figures.map((figure) => (
            <button key={figure.id} type="button" className="swiss-figure" data-attention={figure.attention || undefined} onClick={figure.go}>
              <b>{figure.value}</b>{" "}
              <span>{figure.label}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="swiss-right">
        <p className="swiss-h" aria-hidden="true">{headline}</p>
        <p className="swiss-sub">
          {rest && rest !== verdict.sentence
            ? <><span className="ui-visually-hidden">{verdict.sentence}</span><span aria-hidden="true">{rest}</span></>
            : verdict.sentence}
        </p>
        {needs.length > 0 && (
          <ul className="swiss-list" aria-label="What needs a look">
            {listed.map((need) => {
              const actions = actionsOf(need);
              const tier = tierWord(need, actions[0] ?? null);
              const run = runOf(need);
              const busy = run && ["queued", "running", "checking"].includes(run.phase);
              return (
                <li key={need.id} className="swiss-item" data-severity={need.severity}>
                  <span className="swiss-item__tier" data-low={tier.low || undefined}>{tier.word}</span>
                  <span className="swiss-item__words">
                    <button type="button" className="swiss-item__title" onClick={() => open(need)}>{need.title}</button>
                    {run && <span className="swiss-item__run" role="status">{runWords(run)}</span>}
                  </span>
                  <span className="swiss-item__acts">
                    {actions.length === 0 && <button type="button" className="swiss-go" aria-label={`Open: ${need.title}`} onClick={() => open(need)}>Open <span aria-hidden="true">→</span></button>}
                    {actions.slice(0, 2).map((action, index) => (
                      <Button key={`${action.operationId}:${action.label}`} variant={index === 0 ? "primary" : "secondary"} className={index === 0 ? "swiss-go" : "swiss-go swiss-go--more"}
                        risk={action.kind === "open" || action.kind === "dismiss" ? undefined : action.risk} disabled={Boolean(busy)} aria-label={`${action.label}: ${need.title}`} onClick={() => act(need, action)}>
                        {action.label}{index === 0 && <span aria-hidden="true"> →</span>}
                      </Button>
                    ))}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
        {needs.length > shown && (
          <button type="button" className="swiss-more" aria-expanded={all} onClick={() => setAll((value) => !value)}>{all ? "Show fewer" : `and ${needs.length - shown} more`}</button>
        )}
        <ul className="swiss-apps" aria-label="Apps">
          {rows.map((row) => {
            const state = stateWords(row);
            return (
              <li key={row.app.id}>
                <button type="button" className="swiss-app" data-attention={state.attention || undefined} aria-label={`${row.app.name}, ${state.words}`} onClick={() => onNavigate("catalog", { app: row.app.id })}>
                  {shortName(row.app.name)}<span>{state.words}</span>
                </button>
              </li>
            );
          })}
          {rows.length === 0 && <li className="swiss-app swiss-app--none">{data.facts.catalog.state === "failed" ? "The apps could not be read." : checking ? "Reading the apps." : "No apps yet."}</li>}
        </ul>
      </div>
    </div>
  );
}
