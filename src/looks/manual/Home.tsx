import { useState } from "react";
import type { HomeProps } from "../../home/Home";
import { greeting } from "../../home/format";
import { actionsOf, type Need } from "../../home/needs";
import { runWords } from "../../home/useNeedActions";
import { TopBarSlot } from "../../shell/TopBarSlot";
import { Button } from "../../ui";
import { clockTime, dataDrive, stateWords, useHomeData } from "../swiss/homeData";
import "./home.css";

/*
 * Home as the first page of an operator's manual (M57): the condition of the server stamped at the
 * top, then three numbered sections. What needs you is printed the way a manual prints what can
 * hurt the equipment: a WARNING under red hatching for a problem, a CAUTION under yellow for
 * something to look at, a NOTE in a plain box for what can wait, each with its corrective action
 * going through the approval dialog at its tier. The readings and the apps are ruled tables.
 */

/** How many needs are printed before "and N more". */
const shown = 5;

/** The block a need is printed in: by how much it matters. Its fix carries its own tier on the button. */
const blockOf = (need: Need): "warning" | "caution" | "note" => (need.severity === "danger" ? "warning" : need.severity === "warning" ? "caution" : "note");
const blockWord = { warning: "Warning", caution: "Caution", note: "Note" } as const;

const month = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** 29 SEP 2026 07:41, as a manual dates a change. */
const changeDate = (at: number) => {
  const date = new Date(at);
  return `${date.getDate()} ${month[date.getMonth()]} ${date.getFullYear()} ${clockTime(at)}`;
};

export default function ManualHome(props: HomeProps) {
  const { onNavigate } = props;
  const data = useHomeData(props);
  const { clock, needs, urgent, verdict, checking, unread, inventory, hostname, rows, glance, act, runOf, open, dialog } = data;
  const [all, setAll] = useState(false);

  const faults = urgent.length;
  const stamp = faults > 0 ? `${faults} ${faults === 1 ? "fault" : "faults"}` : checking ? "Reading" : unread.length ? "Not all read" : "No faults";
  const listed = all ? needs : needs.slice(0, shown);

  const drive = dataDrive(inventory?.mounts ?? []);
  const backed = glance.apps.bar ? { value: glance.apps.bar.value, max: glance.apps.bar.max ?? 0 } : null;
  const readings: Array<{ id: string; name: string; reading: string; percent: number | null; caution: boolean; go: () => void }> = [
    { id: "cpu", name: "Processor", reading: inventory ? `${inventory.loadPercent}%` : "not read", percent: inventory?.loadPercent ?? null, caution: (inventory?.loadPercent ?? 0) >= 80, go: () => onNavigate("performance") },
    { id: "memory", name: "Memory", reading: inventory ? `${inventory.memoryPercent}%` : "not read", percent: inventory?.memoryPercent ?? null, caution: (inventory?.memoryPercent ?? 0) >= 85, go: () => onNavigate("performance") },
    { id: "drive", name: drive?.name ?? "Disks", reading: !drive || drive.mount.percent === null ? "not read" : `${drive.mount.percent}%`, percent: drive?.mount.percent ?? null, caution: drive?.mount.state === "warning" || drive?.mount.state === "critical", go: () => onNavigate("storage") },
    { id: "backups", name: "Apps backed up", reading: backed ? `${backed.value} of ${backed.max}` : "not read", percent: backed && backed.max > 0 ? Math.round((backed.value / backed.max) * 100) : null, caution: Boolean(backed && backed.value < backed.max), go: () => onNavigate("backups") },
  ];

  return (
    <div className="manual-home">
      {dialog}
      <TopBarSlot>
        <span className="manual-bar">
          <span>Home</span>
          <span>{hostname}</span>
        </span>
        <time className="manual-bar__date" dateTime={new Date(clock).toISOString()}>{changeDate(clock)}</time>
      </TopBarSlot>

      <header className="manual-head">
        <div className="manual-head__words">
          <p className="manual-head__chapter">Chapter 1 <span aria-hidden="true">·</span> {inventory?.operatingSystem ?? "This server"}</p>
          <h1 className="ui-visually-hidden">{greeting(clock)}</h1>
          <p className="manual-head__title" aria-hidden="true">Condition of {hostname}</p>
          <p className="manual-head__verdict">{verdict.sentence}</p>
        </div>
        <p className="manual-stamp" data-faults={faults > 0 || undefined} aria-hidden="true">
          <span>Result</span>
          <b>{stamp}</b>
        </p>
      </header>

      <section className="manual-section" aria-labelledby="manual-faults">
        <h2 id="manual-faults" className="manual-h">1-1. Faults and corrective action</h2>
        {needs.length === 0 && <p className="manual-none">{checking ? "Reading this server." : "Nothing to correct."}</p>}
        {needs.length > 0 && (
          <ul className="manual-blocks" aria-label="What needs a look">
            {listed.map((need) => {
              const actions = actionsOf(need);
              const block = blockOf(need);
              const run = runOf(need);
              const busy = run && ["queued", "running", "checking"].includes(run.phase);
              return (
                <li key={need.id} className="manual-block" data-block={block}>
                  <span className="manual-block__word">{blockWord[block]}</span>
                  <span className="manual-block__words">
                    <button type="button" className="manual-block__title" onClick={() => open(need)}>{need.title}</button>
                    {run && <span className="manual-block__run" role="status">{runWords(run)}</span>}
                  </span>
                  <span className="manual-block__acts">
                    {actions.length === 0 && <button type="button" className="manual-open" aria-label={`Open: ${need.title}`} onClick={() => open(need)}>Open</button>}
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
          <button type="button" className="manual-more" aria-expanded={all} onClick={() => setAll((value) => !value)}>{all ? "Show fewer" : `and ${needs.length - shown} more`}</button>
        )}
      </section>

      <div className="manual-pair">
        <section className="manual-section" aria-labelledby="manual-readings">
          <h2 id="manual-readings" className="manual-h">1-2. Readings</h2>
          <table className="manual-table">
            <thead><tr><th scope="col">Item</th><th scope="col">Reading</th><th scope="col">Scale</th></tr></thead>
            <tbody>
              {readings.map((row) => (
                <tr key={row.id} data-caution={row.caution || undefined}>
                  <th scope="row"><button type="button" className="manual-link" aria-label={`${row.reading} ${row.name}`} onClick={row.go}>{row.name}</button></th>
                  <td className="manual-table__reading">{row.reading}</td>
                  <td><span className="manual-scale" aria-hidden="true"><i style={{ width: `${Math.max(0, Math.min(100, row.percent ?? 0))}%` }} /></span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>

        <section className="manual-section" aria-labelledby="manual-apps">
          <h2 id="manual-apps" className="manual-h">1-3. Applications</h2>
          <ul className="manual-apps" aria-label="Apps">
            {rows.map((row) => {
              const state = stateWords(row);
              return (
                <li key={row.app.id}>
                  <button type="button" className="manual-app" data-caution={state.attention || undefined} aria-label={`${row.app.name}, ${state.words}`} onClick={() => onNavigate("catalog", { app: row.app.id })}>
                    <span>{row.app.name}</span><span className="manual-app__state">{state.words}</span>
                  </button>
                </li>
              );
            })}
            {rows.length === 0 && <li className="manual-none">{data.facts.catalog.state === "failed" ? "The apps could not be read." : checking ? "Reading the apps." : "No apps yet."}</li>}
          </ul>
        </section>
      </div>
    </div>
  );
}
