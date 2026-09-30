import { useEffect, useId, useState } from "react";
import type { HomeProps } from "../../home/Home";
import { greeting } from "../../home/format";
import { actionsOf, runs, type Need } from "../../home/needs";
import { runWords } from "../../home/useNeedActions";
import { TopBarSlot } from "../../shell/TopBarSlot";
import { Button } from "../../ui";
import { riskCopy } from "../../ui/Button";
import { dataDrive, shortName, spellOut, stateWords, useHomeData } from "../swiss/homeData";
import "./home.css";

/*
 * Home on an e-paper screen (M41, docs/design-directions/05-looks.html, M.eink): no colour at all.
 * Literata on grey paper, sentences before numbers, dithered bars, and status carried by shapes
 * and words: a filled square for what needs you, an open one for what can wait. Each fix names its
 * tier in words and goes through the approval dialog.
 */

/** 7:41, as the paper prints a time. */
const shortTime = (at: number) => {
  const date = new Date(at);
  return `${date.getHours()}:${String(date.getMinutes()).padStart(2, "0")}`;
};

/** How often the figures are read again while Home is open (the facts' quick sources). */
const refreshEveryMs = 60_000;

/** How many of what needs you are set before "Show all". */
const shown = 6;

/** "…need a look. Two more can wait." as the paper writes it: "…need a look; two more can wait." */
const lead = (sentence: string) => spellOut(sentence).replace(/ a look\. (One|Two|Three|Four|Five|Six|Seven|Eight|Nine|Ten|Eleven|Twelve|\d+)( more)/, (_match, count: string, more: string) => ` a look; ${count.toLowerCase()}${more}`);

const sentence = (text: string) => (/[.!?…]$/.test(text) ? text : `${text}.`);

export default function EinkHome(props: HomeProps) {
  const { onNavigate, now = Date.now } = props;
  const data = useHomeData(props);
  const { facts, clock, urgent, waiting, verdict, checking, unread, inventory, hostname, rows, glance, act, runOf, open, dialog } = data;
  const needsId = useId();
  const [all, setAll] = useState(false);
  const everything = [...urgent, ...waiting];
  const listed = all ? everything : everything.slice(0, shown);
  const glanceId = useId();

  // When the figures were last read: the moment the inventory's answer last arrived.
  const [readAt, setReadAt] = useState<number | null>(null);
  const stamp = facts.inventory.value;
  useEffect(() => { if (stamp) setReadAt(now()); }, [stamp]); // eslint-disable-line react-hooks/exhaustive-deps

  const drive = dataDrive(inventory?.mounts ?? []);
  const bars: Array<{ id: string; label: string; share: number | null; words: string; go: () => void }> = [
    { id: "cpu", label: "Processor", share: inventory ? inventory.loadPercent : null, words: inventory ? `${inventory.loadPercent}%` : "—", go: () => onNavigate("performance") },
    { id: "memory", label: "Memory", share: inventory ? inventory.memoryPercent : null, words: inventory ? `${inventory.memoryPercent}%` : "—", go: () => onNavigate("performance") },
    { id: "drive", label: drive?.name ?? "Disks", share: drive?.mount.percent ?? null, words: drive?.mount.percent === null || !drive ? "—" : `${drive.mount.percent}%`, go: () => onNavigate("storage") },
    { id: "backups", label: "Backed up", share: glance.apps.bar ? (glance.apps.bar.value / (glance.apps.bar.max || 1)) * 100 : null, words: glance.apps.value, go: () => onNavigate("backups") },
  ];

  const item = (need: Need, soft: boolean) => {
    const actions = actionsOf(need);
    const runnable = runs(need);
    const tier = runnable ? riskCopy[runnable.risk].label : need.risk ? riskCopy[need.risk].label : null;
    const run = runOf(need);
    const busy = run && ["queued", "running", "checking"].includes(run.phase);
    return (
      <li key={need.id} className="eink-need" data-soft={soft || undefined}>
        <span className="eink-need__mark" aria-hidden="true" />
        <button type="button" className="eink-need__title" onClick={() => open(need)}>
          {/* The space stays outside the hidden words: a name is built from trimmed pieces. */}
          <span className="ui-visually-hidden">{soft ? "Can wait:" : need.severity === "danger" ? "Problem:" : "Needs you:"}</span>{` ${sentence(spellOut(need.title))}`}
        </button>
        {(tier || need.detail) && (
          <p className="eink-need__detail">{tier && <><i>{tier}.</i>{" "}</>}{need.detail ? sentence(spellOut(need.detail)) : null}</p>
        )}
        {run && <p className="eink-need__detail" role="status">{runWords(run)}</p>}
        {actions.length > 0 && (
          <div className="eink-acts">
            {actions.map((action, index) => (
              <Button key={`${action.operationId}:${action.label}`} variant={index === 0 && !soft ? "primary" : "secondary"} className="eink-btn"
                risk={action.kind === "open" || action.kind === "dismiss" ? undefined : action.risk} disabled={Boolean(busy)} aria-label={`${action.label}: ${need.title}`} onClick={() => act(need, action)}>
                {action.label}
              </Button>
            ))}
          </div>
        )}
      </li>
    );
  };

  return (
    <div className="eink-home">
      {dialog}
      <TopBarSlot>
        <span className="eink-bar"><b>{hostname}</b> · Home</span>
        {readAt !== null && <i className="eink-bar__refresh">Refreshed {shortTime(readAt)} · next refresh {shortTime(readAt + refreshEveryMs)}</i>}
      </TopBarSlot>

      <header className="eink-lead">
        <h1>{greeting(clock)}.</h1>
        <p>{lead(verdict.sentence)}</p>
      </header>

      <div className="eink-cols">
        <section aria-labelledby={needsId}>
          <h2 className="eink-h" id={needsId}>Needs you</h2>
          {urgent.length === 0 && waiting.length === 0
            ? <p className="eink-quiet">{checking ? "Reading this server." : unread.length ? "Nothing wrong in what could be read." : "Nothing needs you."}</p>
            : <ul className="eink-needs">{listed.map((need) => item(need, need.severity === "neutral"))}</ul>}
          {urgent.length + waiting.length > shown && (
            <button type="button" className="eink-more" aria-expanded={all} onClick={() => setAll((value) => !value)}>
              {all ? "Show fewer" : `Show all ${urgent.length + waiting.length}`}
            </button>
          )}
        </section>

        <section aria-labelledby={glanceId}>
          <h2 className="eink-h" id={glanceId}>At a glance</h2>
          <div className="eink-rows">
            {bars.map((bar) => (
              <button key={bar.id} type="button" className="eink-row" aria-label={`${bar.label}: ${bar.words}`} onClick={bar.go}>
                <span>{bar.label}</span>
                <span className="eink-bar-meter" aria-hidden="true"><i style={{ width: `${Math.max(0, Math.min(100, bar.share ?? 0))}%` }} /></span>
                <em>{bar.words}</em>
              </button>
            ))}
          </div>
          <ul className="eink-apps" aria-label="Apps">
            {rows.map((row) => {
              const state = stateWords(row);
              return (
                <li key={row.app.id}>
                  <button type="button" className="eink-app" data-attention={state.attention || undefined} aria-label={`${row.app.name}, ${state.words}`} onClick={() => onNavigate("catalog", { app: row.app.id })}>
                    <span className="eink-app__name">{shortName(row.app.name)}</span>
                    <span className="eink-app__state">{state.attention && <span aria-hidden="true">■ </span>}{state.words}</span>
                  </button>
                </li>
              );
            })}
            {rows.length === 0 && <li className="eink-quiet">{facts.catalog.state === "failed" ? "The apps could not be read." : checking ? "Reading the apps." : "No apps yet."}</li>}
          </ul>
        </section>
      </div>
    </div>
  );
}
