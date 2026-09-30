import { useEffect, useMemo, useRef, useState } from "react";
import type { ViewName } from "../../data";
import { useFacts, valuesOf } from "../../home/facts";
import { loadStatus, mountStatus } from "../../home/format";
import { smartSummary, upsSummary } from "../../home/hostFacts";
import { buildNeeds, verdictFor, verdictSources, type Need } from "../../home/needs";
import type { Status } from "../../ui";
import type { LookBarProps } from "../LookBar";
import { hottestSensor, useLivePerformance } from "./livePerformance";
import { sectionOf, worstOf, type SectionId } from "./sections";
import "./annunciators.css";

/*
 * The Glass Cockpit's annunciator row (M41), in the shell's bar on every page: a master caution lamp
 * lit amber when anything needs you (red, and MASTER WARNING, for a problem; dark when nothing does),
 * a lamp for the backups, the updates, the network, the heat, the disks and the UPS, lit amber from
 * what needs a look or dark green when it is normal, and the clock in its black box. Each lamp opens
 * its page; the master lamp goes to the memo on Home, where what it is lit for is said.
 *
 * It only glances at the facts (as the dock's counts do): Home keeps them fresh while it is open,
 * and on any other page the lamps say what the shell read once for the verdict; a source never read
 * leaves its lamp dark. Its own read of the sensors, which asks the helper for Docker's stats, is a
 * slow one, once a minute.
 */

type LampState = "danger" | "warning" | "good" | "off";
const lampOf = (status: Status): LampState => (status === "danger" ? "danger" : status === "warning" ? "warning" : status === "good" ? "good" : "off");
const lampWords: Record<LampState, string> = { danger: "problem", warning: "needs a look", good: "normal", off: "not known" };

export default function Annunciators({ role, onNavigate, now = Date.now }: LookBarProps) {
  const { facts } = useFacts({ active: false });
  const clock = now();
  const values = useMemo(() => valuesOf(facts), [facts]);
  const needs = buildNeeds(values, { now: clock, role });
  const performance = useLivePerformance(60_000);

  const inventory = values.inventory;
  const checking = verdictSources.some(([key]) => facts[key].state === "idle" || facts[key].state === "loading");
  const unread = verdictSources.filter(([key]) => facts[key].state === "failed").map(([, words]) => words);
  const verdict = verdictFor(needs, { hostname: inventory?.hostname ?? "This server", checking, unread });

  const urgent = needs.filter((need) => need.severity !== "neutral");
  const sections = new Map<SectionId, Need[]>();
  for (const need of urgent) sections.set(sectionOf(need), [...(sections.get(sectionOf(need)) ?? []), need]);
  const sectionStatus = (id: SectionId, read: boolean): Status => {
    const list = sections.get(id) ?? [];
    return list.length ? worstOf(list) : read ? "good" : "unknown";
  };
  const worst = (statuses: Status[]): Status => (statuses.includes("danger") ? "danger" : statuses.includes("warning") ? "warning" : "good");

  const mounts = inventory?.mounts ?? [];
  const diskStatus: Status = !inventory ? "unknown" : worst([...mounts.map(mountStatus), smartSummary(inventory.smart).status, sectionStatus("storage", true)]);
  const tailscale = inventory?.tailscale ?? null;
  const lan = inventory?.addresses.some((address) => address.interface !== "tailscale0" && /^\d+\.\d+\.\d+\.\d+$/.test(address.address)) ?? false;
  const reach: Status = !inventory ? "unknown" : (tailscale?.installed && !tailscale.connected) || !lan ? "warning" : "good";
  const heat = hottestSensor(performance.value);

  const lamps: Array<{ code: string; name: string; state: LampState; view: ViewName }> = [
    { code: "BKUP", name: "Backups", state: lampOf(sectionStatus("backup", Boolean(values.protection))), view: "backups" },
    { code: "UPD", name: "Updates", state: lampOf(sectionStatus("updates", Boolean(values.updates))), view: "updates" },
    { code: "NET", name: "Network", state: lampOf(sections.get("net")?.length ? worstOf(sections.get("net")!) : reach), view: "network" },
    { code: "TEMP", name: "Temperature", state: lampOf(heat ? loadStatus(heat.celsius, 80, 90) : "unknown"), view: "performance" },
    { code: "DISK", name: "Disks", state: lampOf(diskStatus), view: "storage" },
    { code: "UPS", name: "UPS", state: lampOf(inventory ? upsSummary(inventory.ups).status : "unknown"), view: "system" },
  ];
  const master: LampState = verdict.status === "danger" ? "danger" : urgent.length ? "warning" : "off";

  // The master lamp says why it is lit where that is said: the memo on Home.
  const toMemo = () => {
    const first = document.querySelector<HTMLElement>(".cockpit-memo :is(.cockpit-line--caution, .cockpit-line--act)");
    if (first) first.focus();
    else onNavigate("home");
  };

  return (
    <>
      <div className="cockpit-ann" role="group" aria-label="Annunciators">
        <button type="button" className="cockpit-lamp cockpit-lamp--master" data-state={master} title={verdict.sentence}
          aria-label={master === "off" ? `Master caution: ${checking ? "checking" : "nothing needs you"}` : `Master ${master === "danger" ? "warning" : "caution"}: ${verdict.label}. Go to the memo`}
          onClick={toMemo}>
          <span>MASTER</span><span>{master === "danger" ? "WARNING" : "CAUTION"}</span>
        </button>
        {lamps.map((lamp) => (
          <button key={lamp.code} type="button" className="cockpit-lamp" data-state={lamp.state} aria-label={`${lamp.name}: ${lampWords[lamp.state]}`} title={`${lamp.name}: ${lampWords[lamp.state]}`} onClick={() => onNavigate(lamp.view)}>
            {lamp.code}
          </button>
        ))}
      </div>
      <Clock now={now} />
    </>
  );
}

const pad = (value: number) => String(value).padStart(2, "0");

/** The clock in its black box, a second at a time. */
function Clock({ now }: { now: () => number }) {
  const [at, setAt] = useState(() => now());
  const read = useRef(now);
  read.current = now;
  useEffect(() => {
    const timer = window.setInterval(() => setAt(read.current()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const time = new Date(at);
  return <time className="cockpit-clock" dateTime={time.toISOString()}>{`${pad(time.getHours())}:${pad(time.getMinutes())}:${pad(time.getSeconds())}`}</time>;
}
