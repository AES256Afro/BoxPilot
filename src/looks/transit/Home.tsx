import { useId, type KeyboardEvent, type ReactNode } from "react";
import { viewLabel } from "../../data";
import type { HomeProps } from "../../home/Home";
import { greeting } from "../../home/format";
import { actionsOf, runs, type Need } from "../../home/needs";
import { runWords } from "../../home/useNeedActions";
import { TopBarSlot } from "../../shell/TopBarSlot";
import { Button } from "../../ui";
import { riskCopy } from "../../ui/Button";
import { clockTime, shortName, useHomeData, type AppRow } from "../swiss/homeData";
import { LINE_COLOURS, transitMap, type LineId, type PlacedStop } from "./map";
import "./home.css";

/*
 * Home as a subway map (M41, docs/design-directions/05-looks.html, M.transit). The lines are how
 * the apps are reached (your network, the tailnet) and kept (backups, and a dashed branch for what
 * has no recent backup); every station is an app and opens it. At the right, a line status board:
 * one row per line and per thing that needs you, with the fix as a button that names its tier and
 * goes through the approval dialog.
 */

const INK = "#1d1d1f";

type Tone = "good" | "warn" | "closed" | "bad";
interface BoardRow {
  id: string;
  name: string;
  colour: string;
  dashed?: boolean;
  status: string;
  tone: Tone;
  lines: ReactNode[];
  needs: Need[];
}

const sentence = (text: string) => (/[.!?…]$/.test(text) ? text : `${text}.`);
const onLan = (row: AppRow) => row.app.port !== null && row.app.exposure !== "loopback" && row.app.exposure !== null;

export default function TransitHome(props: HomeProps) {
  const { onNavigate } = props;
  const data = useHomeData(props);
  const { values, clock, needs, verdict, inventory, hostname, rows, act, runOf, open, dialog } = data;
  const titleId = useId();

  // ── The map, from the facts ──
  const stop = (row: AppRow) => ({ id: row.app.id, name: shortName(row.app.name) });
  const tailnet = rows.filter((row) => row.app.served).map(stop);
  const network = rows.filter(onLan).map(stop);
  const backedUp = rows.filter((row) => row.backup?.state === "ok").map(stop);
  const unprotected = rows.filter((row) => row.backup && row.backup.state !== "ok").map(stop);
  const offBox = values.offBox?.verdict ?? null;
  const map = transitMap({ tailnet, network, backups: backedUp, unprotected, offBoxName: offBox && offBox.state === "none" ? "No off-box copy" : "Off-box copy" });
  const tailscale = inventory?.tailscale ?? null;
  const tailnetDown = tailscale !== null && !tailscale.connected;
  const byId = new Map(rows.map((row) => [row.app.id, row]));
  const stopWords = (placed: PlacedStop) => {
    const row = byId.get(placed.id);
    const where = placed.line === "tailnet" ? "on your tailnet" : placed.line === "network" ? "on your network" : placed.line === "backups" ? "backed up recently" : "no recent backup";
    return `${row?.app.name ?? placed.name}, ${where}${row ? `, ${row.health.label.toLowerCase()}` : ""}`;
  };
  const go = (placed: PlacedStop) => onNavigate("catalog", { app: placed.id });
  const keyGo = (placed: PlacedStop) => (event: KeyboardEvent) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); go(placed); } };

  // ── The board: the lines, then everything else that needs you, each on its own row ──
  const backupNeeds = needs.filter((need) => need.kind === "backup" || need.view === "backups" || /\bbacked up\b|\bbackups?\b/i.test(need.title));
  const updateNeeds = needs.filter((need) => !backupNeeds.includes(need) && (need.kind === "updates" || need.view === "updates"));
  const networkNeeds = needs.filter((need) => !backupNeeds.includes(need) && !updateNeeds.includes(need) && (need.view === "network" || need.view === "firewall"));
  const otherNeeds = needs.filter((need) => !backupNeeds.includes(need) && !updateNeeds.includes(need) && !networkNeeds.includes(need));
  const lanDown = rows.filter((row) => onLan(row) && row.health.status === "danger");

  const board: BoardRow[] = [
    {
      id: "network", name: "Your network", colour: LINE_COLOURS.network,
      status: lanDown.length ? "Part suspended" : networkNeeds.some((need) => need.severity !== "neutral") ? "Minor delays" : "Good service",
      tone: lanDown.length || networkNeeds.some((need) => need.severity === "danger") ? "bad" : networkNeeds.some((need) => need.severity !== "neutral") ? "warn" : "good",
      lines: lanDown.length ? [`${lanDown.map((row) => row.app.name).join(", ")} ${lanDown.length === 1 ? "is" : "are"} not running.`] : [],
      needs: networkNeeds,
    },
    {
      id: "tailnet", name: "Tailnet", colour: LINE_COLOURS.tailnet,
      status: !tailscale ? "No information" : !tailscale.installed ? "Not built" : tailnetDown ? "Suspended" : "Good service",
      tone: !tailscale || !tailscale.installed ? "closed" : tailnetDown ? "bad" : "good",
      lines: !tailscale ? [] : !tailscale.installed ? ["Tailscale is not set up on this server."] : tailnetDown ? ["Tailscale is not connected."] : [],
      needs: [],
    },
    {
      id: "backups", name: "Backups", colour: LINE_COLOURS.backups, dashed: unprotected.length > 0,
      status: backupNeeds.some((need) => need.severity === "danger") ? "Suspended" : backupNeeds.length || unprotected.length ? "Part suspended" : "Good service",
      tone: backupNeeds.some((need) => need.severity === "danger") ? "bad" : backupNeeds.length || unprotected.length ? "warn" : "good",
      lines: !backupNeeds.length && unprotected.length ? [`No recent backup for ${unprotected.map((entry) => entry.name).join(", ")}.`] : [],
      needs: backupNeeds,
    },
    {
      id: "updates", name: "Updates", colour: "#ffffff",
      status: updateNeeds.length ? "Planned works" : "Good service", tone: updateNeeds.length ? "warn" : "good",
      lines: [], needs: updateNeeds,
    },
    ...otherNeeds.map((need): BoardRow => {
      const app = need.appId ? byId.get(need.appId)?.app : undefined;
      const paused = Boolean(app?.paused) || /paused$/i.test(need.title);
      return {
        id: need.id, name: app ? shortName(app.name) : viewLabel(need.view), colour: paused || need.severity === "neutral" ? "#8c8c8c" : need.severity === "danger" ? "#e5484d" : "#ffcf33",
        status: paused ? "Station closed" : need.severity === "danger" ? "Suspended" : need.severity === "warning" ? "Minor delays" : "Planned works",
        tone: paused ? "closed" : need.severity === "danger" ? "bad" : "warn",
        lines: [], needs: [need],
      };
    }),
  ];

  const needLines = (need: Need) => {
    const runnable = runs(need);
    const tier = runnable ? riskCopy[runnable.risk].label : need.risk ? riskCopy[need.risk].label : null;
    const run = runOf(need);
    const busy = run && ["queued", "running", "checking"].includes(run.phase);
    const actions = actionsOf(need);
    return (
      <div key={need.id} className="transit-need">
        <p>
          <button type="button" className="transit-need__title" onClick={() => open(need)}>{sentence(need.title)}</button>
          {need.detail && <> {sentence(need.detail)}</>}
          {tier && <> {tier} risk.</>}
        </p>
        {run && <p role="status">{runWords(run)}</p>}
        {actions.length > 0 && (
          <div className="transit-acts">
            {actions.map((action, index) => (
              <Button key={`${action.operationId}:${action.label}`} variant={index === 0 ? "primary" : "secondary"} className="transit-btn"
                risk={action.kind === "open" || action.kind === "dismiss" ? undefined : action.risk} disabled={Boolean(busy)} aria-label={`${action.label}: ${need.title}`} onClick={() => act(need, action)}>
                {action.label}
              </Button>
            ))}
          </div>
        )}
      </div>
    );
  };

  const hub = map.interchange;
  const hubName = hostname.toUpperCase();
  const hubSize = Math.min(11, 160 / Math.max(1, hubName.length * 0.95));

  return (
    <div className="transit-home">
      {dialog}
      <TopBarSlot>
        <span className="transit-bar"><b>{hostname}</b><span aria-hidden="true">/</span>Home</span>
      </TopBarSlot>
      <h1 className="ui-visually-hidden">{greeting(clock)}</h1>

      <section className="transit-map" aria-labelledby={titleId}>
        <div className="transit-map__head">
          <p className="transit-map__title" id={titleId}>{hostname}</p>
          <p className="transit-map__lead">{verdict.sentence} Each line is a way in or a way out; stations are your apps.</p>
        </div>
        <svg className="transit-map__svg" viewBox="0 0 520 380" role="group" aria-label="Your apps on the lines">
          {map.paths.map((path) => (
            <path key={path.line} d={path.d} fill="none" stroke={path.line === "tailnet" && tailnetDown ? LINE_COLOURS.unprotected : LINE_COLOURS[path.line]} strokeWidth={8}
              strokeLinejoin="round" strokeDasharray={path.dashed || (path.line === "tailnet" && tailnetDown) ? "12 8" : undefined} />
          ))}
          <path d="M30 181 V199 M500 181 V199" stroke={INK} strokeWidth={4} />
          {map.termini.map((end) => (
            <g key={`${end.line}:${end.x}`} className="transit-end">
              <line x1={end.x} y1={end.y - 9} x2={end.x} y2={end.y + 9} stroke={INK} strokeWidth={4} />
              <text x={end.label.x} y={end.label.y} textAnchor={end.label.anchor}>{end.name}</text>
            </g>
          ))}
          <line x1={30} y1={293} x2={30} y2={311} stroke={LINE_COLOURS.unprotected} strokeWidth={4} />
          <rect x={hub.x} y={hub.y} width={hub.width} height={hub.height} rx={14} fill="#ffffff" stroke={INK} strokeWidth={3} />
          <text className="transit-hub" x={hub.x + 18} y={hub.y + hub.height / 2} transform={`rotate(-90 ${hub.x + 18} ${hub.y + hub.height / 2})`} textAnchor="middle" fontSize={hubSize}>{hubName}</text>
          {map.stops.map((placed) => (
            <g key={`${placed.line}:${placed.id}`} className="transit-stop" data-line={placed.line} role="button" tabIndex={0} aria-label={stopWords(placed)} onClick={() => go(placed)} onKeyDown={keyGo(placed)}>
              <circle className="transit-stop__ring" cx={placed.x} cy={placed.y} r={10} />
              <circle cx={placed.x} cy={placed.y} r={5.5} fill="#ffffff" stroke={placed.line === "unprotected" ? LINE_COLOURS.unprotected : INK} strokeWidth={2.4} />
              <text x={placed.label.x} y={placed.label.y} textAnchor={placed.label.anchor}>{placed.name}</text>
            </g>
          ))}
          <g className="transit-legend" aria-hidden="true">
            <line x1={30} y1={364} x2={54} y2={364} stroke={LINE_COLOURS.network} strokeWidth={6} /><text x={60} y={368}>Your network</text>
            <line x1={150} y1={364} x2={174} y2={364} stroke={LINE_COLOURS.tailnet} strokeWidth={6} /><text x={180} y={368}>Tailnet</text>
            <line x1={250} y1={364} x2={274} y2={364} stroke={LINE_COLOURS.backups} strokeWidth={6} /><text x={280} y={368}>Backups</text>
            <line x1={360} y1={364} x2={384} y2={364} stroke={LINE_COLOURS.unprotected} strokeWidth={6} strokeDasharray="6 4" /><text x={390} y={368}>Not backed up</text>
          </g>
        </svg>
      </section>

      <section className="transit-board" aria-labelledby={`${titleId}-board`}>
        <h2 className="transit-board__head" id={`${titleId}-board`}>Line status <span>{clockTime(clock)}</span></h2>
        {board.map((row) => (
          <div key={row.id} className="transit-line" style={{ ["--line" as string]: row.colour }}>
            <i className={row.dashed ? "transit-line__bar transit-line__bar--dashed" : "transit-line__bar"} aria-hidden="true" />
            <h3 className="transit-line__name">{row.name}</h3>
            <span className="transit-status" data-tone={row.tone}>{row.status}</span>
            {row.lines.map((line, index) => <p key={index}>{line}</p>)}
            {row.needs.map(needLines)}
          </div>
        ))}
      </section>
    </div>
  );
}
