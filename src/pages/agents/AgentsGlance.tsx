import { useEffect, useState } from "react";
import { relativeTime } from "../../home/format";
import { Button, Panel, Section } from "../../ui";
import { agentsApi, type Glance } from "./api";
import { moduleVerdict } from "./format";
import { Prose } from "./Prose";
import "./agents.css";

/*
 * Agents at a glance, on Home and on Ops (M37): the latest digest the Server Keeper wrote, and how
 * many cards wait for someone. For the owner and operators only, and only once Agents are on or a
 * digest exists: a server without agents shows nothing here. One read when the page opens.
 * A runner that is not answering leads, over the cards and this morning's digest: nothing runs
 * until it starts, and the runs waiting for it are counted.
 */

export interface AgentsGlanceProps {
  role: string;
  variant: "home" | "ops";
  onOpen: () => void;
  now?: () => number;
}

export function AgentsGlance({ role, variant, onOpen, now = Date.now }: AgentsGlanceProps) {
  const [glance, setGlance] = useState<Glance | null>(null);
  const allowed = role === "owner" || role === "operator";
  useEffect(() => {
    if (!allowed) return undefined;
    let live = true;
    agentsApi.glance().then((value) => { if (live) setGlance(value); }, () => undefined);
    return () => { live = false; };
  }, [allowed]);
  if (!allowed || !glance || (!glance.enabled && !glance.digest)) return null;

  const verdict = moduleVerdict({ enabled: glance.enabled, paused: glance.paused, pausedUntil: null, killedAt: null, quietHours: { start: "", end: "" }, inQuietHours: false, notify: true }, glance.runnerOnline, 0);
  const cards = glance.cardsWaiting;
  const stopped = glance.enabled && !glance.paused && !glance.runnerOnline;
  const queued = glance.queued ?? 0;
  const body = (
    <div className="agents-glance__body">
      {stopped && (
        <p className="agents-glance__runner">
          Nothing runs until the runner starts{queued ? <>: <b>{queued}</b> {queued === 1 ? "run waits" : "runs wait"} for it</> : null}.
        </p>
      )}
      {glance.digest
        ? <>
            <p className="agents-glance__meta">{glance.digest.agentName} · {relativeTime(glance.digest.at, now()) ?? "recently"}</p>
            {/* Its markdown drawn, never shown as stars or run as HTML (M44). */}
            <Prose text={glance.digest.excerpt} className="agents-glance__digest" />
          </>
        : <p className="agents-glance__meta">No digest yet: the Server Keeper writes one each morning in quiet hours.</p>}
      <p className="agents-glance__cards">{cards ? <><b>{cards}</b> {cards === 1 ? "card waits" : "cards wait"} for you</> : "No cards waiting"}</p>
    </div>
  );
  const open = <Button variant="ghost" onClick={onOpen}>Open Agents</Button>;
  if (variant === "ops") {
    return (
      <Panel className="agents-glance agents-glance--ops" title="Agents" count={{ status: verdict.status, label: cards && !stopped ? `${cards} ${cards === 1 ? "card" : "cards"}` : verdict.label }} meta={glance.digest ? "latest digest" : undefined} actions={open} padded>
        {body}
      </Panel>
    );
  }
  return (
    <div className="lx-panel agents-glance agents-glance--home">
      <Section title="Agents" status={{ status: verdict.status, label: verdict.label }} actions={open}>
        {body}
      </Section>
    </div>
  );
}
