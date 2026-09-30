import { useId, useMemo, type ReactNode } from "react";
import { openActivity, openNotifications } from "../../activityEvents";
import { backupGlance } from "../../home/backupGlance";
import { useFacts, valuesOf } from "../../home/facts";
import { greeting } from "../../home/format";
import type { HomeProps } from "../../home/Home";
import { actionsOf, buildNeeds, verdictFor, verdictSources, type Need, type NeedAction } from "../../home/needs";
import { runWords, useNeedActions } from "../../home/useNeedActions";
import { riskCopy, type RiskTier, type Status } from "../../ui";
import { driveWord, fullestDrive, hottestSensor, useLivePerformance } from "./livePerformance";
import { nextBackupRun } from "./nextRun";
import { sectionOf, sectionTitles, worstOf, type SectionId } from "./sections";
import "./home.css";

/*
 * Home in the Glass Cockpit look (M41, docs/design-directions/05-looks.html, M.cockpit): an
 * aircraft's display. Four round gauges drawn from the live figures, and beside them the memo in
 * the ECAM's words and colours: white titles, amber for what needs you, cyan for what can be done
 * about it (each a button through the approval dialog, its tier said at the end of the line),
 * magenta for the next backup, green for what can wait and what is fine. The annunciator row above
 * it is in the shell's bar, on every page (Annunciators.tsx).
 */

const pad = (value: number) => String(value).padStart(2, "0");
const tierWord: Record<RiskTier, string> = { low: "LOW", medium: "MED", high: "HIGH" };
const severityWords = { danger: "Problem", warning: "Needs a look", neutral: "Can wait" } as const;

/** "- INSTALL ......... MED": the action, dots to the memo's column, then its tier. */
function leader(left: string, right: string, column: number): string {
  if (!right) return left;
  return `${left} ${".".repeat(Math.max(3, column - left.length - 2))} ${right}`;
}

const actionWords = (action: NeedAction) => `- ${action.label.toUpperCase()}`;
const actionRight = (action: NeedAction) => (action.kind === "dismiss" ? "" : action.kind === "open" ? "OPEN" : tierWord[action.risk]);

export default function CockpitHome({ csrfToken, role, onNavigate, now = Date.now }: HomeProps) {
  const { facts, refresh, accept } = useFacts();
  const clock = now();
  const values = useMemo(() => valuesOf(facts), [facts]);
  const needs = buildNeeds(values, { now: clock, role });
  const { act, runs: fixRuns, dialog } = useNeedActions({ csrfToken, refresh, accept, navigate: onNavigate });
  const performance = useLivePerformance(5000);

  const inventory = values.inventory;
  const hostname = inventory?.hostname ?? "This server";
  const checking = verdictSources.some(([key]) => facts[key].state === "idle" || facts[key].state === "loading");
  const unread = verdictSources.filter(([key]) => facts[key].state === "failed").map(([, words]) => words);
  const verdict = verdictFor(needs, { hostname, checking, unread });
  const open = (need: Need) => (need.jobId ? openActivity(need.jobId) : need.id === "unannounced" ? openNotifications() : onNavigate(need.view, need.appId && need.view === "catalog" ? { app: need.appId } : undefined));

  // ── The four gauges: the live read when it answers, the inventory's figures until then. ──
  const perf = performance.value;
  const cpu = perf?.cpu.usagePercent ?? inventory?.loadPercent ?? null;
  const memory = perf?.memory.usedPercent ?? inventory?.memoryPercent ?? null;
  const drive = fullestDrive(inventory);
  const heat = hottestSensor(perf);

  // ── The memo: what needs you by section, then what can wait. ──
  const urgent = needs.filter((need) => need.severity !== "neutral");
  const waiting = needs.filter((need) => need.severity === "neutral");
  const sections = new Map<SectionId, Need[]>([["backup", []], ["updates", []]]);
  for (const need of urgent) {
    const id = sectionOf(need);
    sections.set(id, [...(sections.get(id) ?? []), need]);
  }
  // Worst first: a section with a problem leads; backups and updates are always said, as drawn.
  const order = [...sections.keys()].sort((a, b) => Number(worstOf(sections.get(b)!) === "danger") - Number(worstOf(sections.get(a)!) === "danger"));
  const every = needs.flatMap((need) => actionsOf(need).map(actionWords));
  const column = Math.max(20, ...every.map((words) => words.length + 5));

  const glance = backupGlance(values, { protection: facts.protection.state, offBox: facts.offBox.state, database: facts.database.state }, clock);
  const nextRun = nextBackupRun(values.schedules, clock);
  const updates = values.updates;
  const tailscale = inventory?.tailscale ?? null;
  const lan = inventory?.addresses.find((address) => address.interface !== "tailscale0" && /^\d+\.\d+\.\d+\.\d+$/.test(address.address)) ?? null;
  const reach = inventory ? [tailscale?.installed ? (tailscale.connected ? "Tailnet up" : "Tailnet down") : null, lan ? "LAN up" : "No LAN address"].filter(Boolean).join(" · ") : null;
  const reachStatus: Status = !inventory ? "unknown" : (tailscale?.installed && !tailscale.connected) || !lan ? "warning" : "good";

  return (
    <div className="cockpit-home">
      {dialog}
      <h1 className="ui-visually-hidden">{greeting(clock)}</h1>

      <div className="cockpit-gauges" role="group" aria-label="Instruments">
        <Gauge label="CPU %" name="Processor" value={cpu} unit="%" warn={80} danger={95} onSelect={() => onNavigate("performance")} />
        <Gauge label="MEM %" name="Memory" value={memory} unit="%" warn={85} danger={95} onSelect={() => onNavigate("performance")} />
        <Gauge label={`${drive ? driveWord(drive.target) : "DISK"} %`} name={drive ? (drive.target === "/" ? "System disk" : drive.target) : "Disk"} value={drive?.percent ?? null} unit="%" warn={85} danger={95} onSelect={() => onNavigate("storage")} />
        <Gauge label="TEMP °C" name={heat ? `Hottest sensor, ${heat.label}` : "Hottest sensor"} value={heat?.celsius ?? null} unit="°C" warn={80} danger={90} onSelect={() => onNavigate("performance")} />
      </div>

      <section className="cockpit-memo" aria-label="Memo">
        <h2 className="cockpit-t">{hostname}</h2>
        {inventory && <p className="cockpit-line cockpit-line--dim">{inventory.operatingSystem.replace(/\s+LTS$/, "")} · up {upFor(inventory.uptimeSeconds)}</p>}
        <p className="cockpit-line cockpit-verdict" data-status={verdict.status}>{verdict.sentence}</p>

        {order.map((id) => {
          const list = sections.get(id) ?? [];
          return (
            <div key={id} className="cockpit-section">
              <h2 className="cockpit-t">{sectionTitles[id]}</h2>
              <ul className="cockpit-lines">
                {list.map((need) => <MemoNeed key={need.id} need={need} column={column} onOpen={open} onAct={act} run={need.finding ? fixRuns[need.finding.id] : undefined} />)}
                {id === "backup" && list.length === 0 && (
                  <li><button type="button" className="cockpit-line cockpit-line--open" data-status={glance.apps.status} onClick={() => onNavigate("backups")}>{glance.apps.status === "unknown" ? `Apps backed up: ${glance.apps.caption}` : glance.apps.caption}</button></li>
                )}
                {id === "backup" && nextRun && <li className="cockpit-line cockpit-line--target">Next run {nextRun.words}</li>}
                {id === "updates" && list.length === 0 && (
                  <li><button type="button" className="cockpit-line cockpit-line--open" data-status={updates ? "good" : "unknown"} onClick={() => onNavigate("updates")}>
                    {!updates ? (facts.updates.state === "failed" ? "Updates not read" : "Reading updates") : updates.count === 0 ? "No updates waiting" : "No security fixes waiting"}
                  </button></li>
                )}
              </ul>
            </div>
          );
        })}

        <div className="cockpit-section">
          <h2 className="cockpit-t">Memo</h2>
          <ul className="cockpit-lines">
            {waiting.map((need) => <MemoNeed key={need.id} need={need} column={column} onOpen={open} onAct={act} run={need.finding ? fixRuns[need.finding.id] : undefined} />)}
            {reach && <li><button type="button" className="cockpit-line cockpit-line--open" data-status={reachStatus} onClick={() => onNavigate("network")}>{reach}</button></li>}
            {!inventory && <li className="cockpit-line cockpit-line--dim">{facts.inventory.state === "failed" ? "The system could not be read" : "Reading the system"}</li>}
          </ul>
        </div>
      </section>
    </div>
  );
}

/** "19D 04H", as the memo says how long the server has been up. */
function upFor(seconds: number): string {
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3600);
  return days > 0 ? `${days}d ${pad(hours)}h` : `${hours}h ${pad(Math.floor((seconds % 3600) / 60))}m`;
}

/** One need in the memo: its line opens its page; each fix is a cyan line ending in its tier. */
function MemoNeed({ need, column, onOpen, onAct, run }: { need: Need; column: number; onOpen: (need: Need) => void; onAct: (need: Need, action?: NeedAction | null) => void; run?: ReturnType<typeof useNeedActions>["runs"][string] }) {
  const detailId = useId();
  const busy = run && ["queued", "running", "checking"].includes(run.phase);
  // As terse as the ECAM: a few words more ride on the line ("4 UPDATES AVAILABLE · 1 SECURITY FIX
  // AMONG THEM"); a longer detail is the line's description and its tooltip.
  const short = need.detail && need.detail.length <= 32 ? need.detail : null;
  const long = need.detail && !short ? need.detail : null;
  return (
    <>
      <li>
        <button type="button" className="cockpit-line cockpit-line--caution" data-severity={need.severity} title={long ?? undefined} onClick={() => onOpen(need)} aria-describedby={long ? detailId : undefined}>
          <span className="ui-visually-hidden">{`${severityWords[need.severity]}:`}</span>{` ${need.title}`}{short && <span className="cockpit-line__more">{` · ${short}`}</span>}
        </button>
        {long && <span className="ui-visually-hidden" id={detailId}>{long}</span>}
      </li>
      {need.risk && !need.action && <li className="cockpit-line cockpit-line--dim">{`Staged at ${tierWord[need.risk]}`}</li>}
      {actionsOf(need).map((action) => <MemoAction key={`${action.kind ?? "operation"}:${action.operationId}:${action.label}`} need={need} action={action} column={column} disabled={Boolean(busy) && action.kind !== "dismiss" && action.kind !== "open"} onAct={onAct} />)}
      {run && <li className="cockpit-line cockpit-line--run" role="status" data-phase={run.phase}>{runWords(run)}</li>}
    </>
  );
}

function MemoAction({ need, action, column, disabled, onAct }: { need: Need; action: NeedAction; column: number; disabled: boolean; onAct: (need: Need, action?: NeedAction | null) => void }) {
  const tierId = useId();
  const runsSomething = action.kind !== "dismiss" && action.kind !== "open";
  return (
    <li>
      <button type="button" className="cockpit-line cockpit-line--act" data-risk={runsSomething ? action.risk : undefined} disabled={disabled}
        aria-label={`${action.label}: ${need.title}`} aria-describedby={runsSomething ? tierId : undefined} onClick={() => onAct(need, action)}>
        {leader(actionWords(action), actionRight(action), column)}
      </button>
      {runsSomething && <span id={tierId} hidden>{riskCopy[action.risk].description}</span>}
    </li>
  );
}

/*
 * A round gauge, as drawn in the study: a 240° dial, the value's arc green, amber past `warn` and
 * red past `danger`, the amber and red limits outside the dial, a white needle, and the figure in
 * a black readout box with the label under it. A figure not read shows dashes and no needle.
 */
const centre = [60, 56] as const;
const point = (angle: number, radius: number): [number, number] => [centre[0] + radius * Math.cos((angle * Math.PI) / 180), centre[1] - radius * Math.sin((angle * Math.PI) / 180)];
function arc(from: number, to: number, radius: number): string {
  const a1 = 210 - 2.4 * from;
  const a2 = 210 - 2.4 * to;
  const [x1, y1] = point(a1, radius);
  const [x2, y2] = point(a2, radius);
  return `M${x1.toFixed(1)} ${y1.toFixed(1)} A${radius} ${radius} 0 ${a1 - a2 > 180 ? 1 : 0} 1 ${x2.toFixed(1)} ${y2.toFixed(1)}`;
}

const bandColour = { good: "#39e27d", warning: "#ffbf1f", danger: "#ff4d4d", unknown: "#7d8894" } as const;

function Gauge({ label, name, value, unit, warn, danger, onSelect }: { label: string; name: string; value: number | null; unit: string; warn: number; danger: number; onSelect: () => void }): ReactNode {
  const known = value !== null && Number.isFinite(value);
  const shown = known ? Math.round(value) : null;
  const on = known ? Math.min(100, Math.max(0, value)) : 0;
  const band = !known ? "unknown" : value >= danger ? "danger" : value >= warn ? "warning" : "good";
  const colour = bandColour[band];
  const [nx, ny] = point(210 - 2.4 * on, 33);
  return (
    <button type="button" className="cockpit-gauge" data-status={band} aria-label={`${name}: ${shown === null ? "not read" : `${shown}${unit}`}`} onClick={onSelect}>
      <svg viewBox="0 0 120 100" preserveAspectRatio="xMidYMin meet" aria-hidden="true" focusable="false">
        <path d={arc(0, 100, 40)} fill="none" stroke="#1b242c" strokeWidth="6" />
        {known && on > 0 && <path d={arc(0, on, 40)} fill="none" stroke={colour} strokeWidth="6" />}
        <path d={arc(warn, danger, 46)} fill="none" stroke="#ffbf1f" strokeWidth="2.2" />
        <path d={arc(danger, 100, 46)} fill="none" stroke="#ff4d4d" strokeWidth="2.2" />
        {known && <line x1={centre[0]} y1={centre[1]} x2={nx.toFixed(1)} y2={ny.toFixed(1)} stroke="#f1f4f6" strokeWidth="2.4" strokeLinecap="round" />}
        <circle cx={centre[0]} cy={centre[1]} r="3.2" fill="#f1f4f6" />
        <rect x="37" y="66" width="46" height="17" fill="#000000" stroke="#f1f4f6" strokeWidth="1" />
        <text x="60" y="79" textAnchor="middle" fontFamily="'B612 Mono', monospace" fontSize="12" fill={colour}>{shown === null ? "--" : shown}</text>
        <text x="60" y="95" textAnchor="middle" fontFamily="B612, sans-serif" fontSize="8" fill="#7d8894" letterSpacing="1">{label}</text>
      </svg>
    </button>
  );
}
