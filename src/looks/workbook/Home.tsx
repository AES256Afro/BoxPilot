import { useState } from "react";
import type { HomeProps } from "../../home/Home";
import { greeting } from "../../home/format";
import { actionsOf, type Need, type NeedAction } from "../../home/needs";
import { runWords } from "../../home/useNeedActions";
import { TopBarSlot } from "../../shell/TopBarSlot";
import { Button } from "../../ui";
import { riskCopy } from "../../ui/Button";
import { clockTime, dataDrive, stateWords, useHomeData } from "../swiss/homeData";
import "./home.css";

/*
 * Home as the first sheet of a workbook (M57). The verdict is the cell that is selected, with the
 * formula bar above the grid saying what it was worked out from; under it three ranges: what needs
 * a look, one row each with its tier and its fix (through the approval dialog), the four figures
 * as cells with a bar drawn in each, and the apps, one row each. Rows are numbered down the left
 * as a sheet numbers them, and a state fills its cell the way conditional formatting would.
 */

/** How many needs are listed before "and N more". */
const shown = 5;

const tierOf = (need: Need, action: NeedAction | null): string => {
  const risk = action?.kind === "open" || action?.kind === "dismiss" || action?.kind === "acknowledge" ? undefined : action?.risk ?? need.risk;
  if (risk) return riskCopy[risk].label;
  return need.severity === "danger" ? "Problem" : need.severity === "warning" ? "Look" : "Can wait";
};

export default function WorkbookHome(props: HomeProps) {
  const { onNavigate } = props;
  const data = useHomeData(props);
  const { clock, needs, urgent, waiting, verdict, checking, inventory, hostname, rows, glance, act, runOf, open, dialog } = data;
  const [all, setAll] = useState(false);

  const worst = urgent.some((need) => need.severity === "danger") ? "danger" : urgent.length ? "warning" : checking ? "neutral" : "good";
  const listed = all ? needs : needs.slice(0, shown);

  const drive = dataDrive(inventory?.mounts ?? []);
  const backed = glance.apps.bar ? { value: glance.apps.bar.value, max: glance.apps.bar.max ?? 0 } : null;
  const figures: Array<{ id: string; label: string; value: string; percent: number | null; fill: "warning" | undefined; go: () => void }> = [
    { id: "cpu", label: "Processor", value: inventory ? `${inventory.loadPercent}%` : "—", percent: inventory?.loadPercent ?? null, fill: (inventory?.loadPercent ?? 0) >= 80 ? "warning" : undefined, go: () => onNavigate("performance") },
    { id: "memory", label: "Memory", value: inventory ? `${inventory.memoryPercent}%` : "—", percent: inventory?.memoryPercent ?? null, fill: (inventory?.memoryPercent ?? 0) >= 85 ? "warning" : undefined, go: () => onNavigate("performance") },
    { id: "drive", label: drive?.name ?? "Disks", value: !drive || drive.mount.percent === null ? "—" : `${drive.mount.percent}%`, percent: drive?.mount.percent ?? null, fill: drive?.mount.state === "warning" || drive?.mount.state === "critical" ? "warning" : undefined, go: () => onNavigate("storage") },
    { id: "backups", label: "Apps backed up", value: backed ? `${backed.value}/${backed.max}` : "—", percent: backed && backed.max > 0 ? Math.round((backed.value / backed.max) * 100) : null, fill: backed && backed.value < backed.max ? "warning" : undefined, go: () => onNavigate("backups") },
  ];

  return (
    <div className="workbook-home">
      {dialog}
      <TopBarSlot>
        <span className="workbook-bar">
          <span>Home</span>
          <span>{hostname}</span>
        </span>
        <time className="workbook-bar__date" dateTime={new Date(clock).toISOString()}>{clockTime(clock)}</time>
      </TopBarSlot>

      <p className="workbook-fx" aria-hidden="true">
        <span className="workbook-fx__cell">B2</span>
        <span className="workbook-fx__sign">fx</span>
        <span className="workbook-fx__formula">=VERDICT(needs_a_look: {urgent.length}, can_wait: {waiting.length}, apps: {rows.length})</span>
      </p>

      <header className="workbook-head">
        <h1 className="workbook-head__title">{greeting(clock)}</h1>
        <p className="workbook-verdict" data-fill={worst}>{verdict.sentence}</p>
      </header>

      <section className="workbook-range" aria-labelledby="workbook-needs">
        <h2 id="workbook-needs" className="workbook-range__title">Needs a look <span>{needs.length}</span></h2>
        {needs.length === 0 && <p className="workbook-empty">{checking ? "Reading this server." : "Nothing needs a look."}</p>}
        {needs.length > 0 && (
          <ul className="workbook-rows" aria-label="What needs a look">
            {listed.map((need) => {
              const actions = actionsOf(need);
              const run = runOf(need);
              const busy = run && ["queued", "running", "checking"].includes(run.phase);
              return (
                <li key={need.id} className="workbook-row" data-fill={need.severity === "neutral" ? undefined : need.severity}>
                  <span className="workbook-row__tier">{tierOf(need, actions[0] ?? null)}</span>
                  <span className="workbook-row__words">
                    <button type="button" className="workbook-row__title" onClick={() => open(need)}>{need.title}</button>
                    {run && <span className="workbook-row__run" role="status">{runWords(run)}</span>}
                  </span>
                  <span className="workbook-row__acts">
                    {actions.length === 0 && <button type="button" className="workbook-cellbutton" aria-label={`Open: ${need.title}`} onClick={() => open(need)}>Open</button>}
                    {actions.slice(0, 2).map((action, index) => (
                      <Button key={`${action.operationId}:${action.label}`} variant={index === 0 ? "primary" : "secondary"}
                        risk={action.kind === "open" || action.kind === "dismiss" || action.kind === "acknowledge" ? undefined : action.risk} disabled={Boolean(busy)} aria-label={`${action.label}: ${need.title}`} onClick={() => act(need, action)}>
                        {action.label}
                      </Button>
                    ))}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
        {needs.length > shown && (
          <button type="button" className="workbook-cellbutton workbook-more" aria-expanded={all} onClick={() => setAll((value) => !value)}>{all ? "Show fewer" : `and ${needs.length - shown} more`}</button>
        )}
      </section>

      <section className="workbook-range" aria-labelledby="workbook-figures">
        <h2 id="workbook-figures" className="workbook-range__title">Figures</h2>
        <div className="workbook-figures">
          {figures.map((figure) => (
            <button key={figure.id} type="button" className="workbook-figure" data-fill={figure.fill} aria-label={`${figure.value} ${figure.label}`} onClick={figure.go}>
              <span className="workbook-figure__label">{figure.label}</span>
              <b>{figure.value}</b>
              <span className="workbook-figure__bar" aria-hidden="true"><i style={{ width: `${Math.max(0, Math.min(100, figure.percent ?? 0))}%` }} /></span>
            </button>
          ))}
        </div>
      </section>

      <section className="workbook-range" aria-labelledby="workbook-apps">
        <h2 id="workbook-apps" className="workbook-range__title">Apps <span>{rows.length}</span></h2>
        <ul className="workbook-rows workbook-rows--apps" aria-label="Apps">
          {rows.map((row) => {
            const state = stateWords(row);
            return (
              <li key={row.app.id} className="workbook-row workbook-row--app">
                <button type="button" className="workbook-app" aria-label={`${row.app.name}, ${state.words}`} onClick={() => onNavigate("catalog", { app: row.app.id })}>
                  <span className="workbook-app__name">{row.app.name}</span>
                  <span className="workbook-app__state" data-fill={state.attention ? "warning" : state.words === "running" ? "good" : undefined}>{state.words}</span>
                </button>
              </li>
            );
          })}
          {rows.length === 0 && <li className="workbook-empty">{data.facts.catalog.state === "failed" ? "The apps could not be read." : checking ? "Reading the apps." : "No apps yet."}</li>}
        </ul>
      </section>
    </div>
  );
}
