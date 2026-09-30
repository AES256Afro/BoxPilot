import { useEffect, useState } from "react";
import { openActivity, openNotifications } from "../../activityEvents";
import { countOf, type ViewName } from "../../data";
import { useFacts } from "../../home/facts";
import { relativeTime } from "../../home/format";
import { useJobHistory, useMergedJobs } from "../../home/jobHistory";
import { NeedRow } from "../../home/NeedRow";
import type { Need } from "../../home/needs";
import { useNeedActions } from "../../home/useNeedActions";
import { connected, useConnection } from "../../pwa/connection";
import { readLastKnown, saveLastKnown } from "../../pwa/lastKnown";
import { onRefresh } from "../../shell/refresh";
import { Button, Facts, MetricStrip, MetricTile, Notice, PageHeader, Panel, StatusChip } from "../../ui";
import { AgentsGlance } from "../agents/AgentsGlance";
import { offlineCopy, todayModel, type RanGroup, type TodayModel } from "./today";
import "./today.css";

/*
 * Today (M25.3): the phone's start page, and in the dock everywhere. One column on a phone, read top
 * to bottom: what waits for the owner's approval (each opens the ordinary approval dialog, at its
 * own tier, with its own password or typed confirmation), what else needs a look, the agents'
 * morning digest, what ran overnight, and whether the backups are off this server and current.
 *
 * It reads nothing Home and Ops do not: the same facts, the same needs, the same backup glance. What
 * it showed last is kept on this device for a day (src/pwa/lastKnown.ts), for the account that saw
 * it, so a phone that cannot reach BoxPilot still shows it - marked as not live, with no buttons.
 */

export interface TodayPageProps {
  csrfToken: string;
  role: string;
  /** The signed-in account, whose last known state this is. */
  accountId: string | null;
  onNavigate: (view: ViewName, options?: { app?: string; tab?: string }) => void;
  now?: () => number;
}

const shownAttention = 5;

export default function TodayPage({ csrfToken, role, accountId, onNavigate, now = Date.now }: TodayPageProps) {
  const { facts, refresh, accept } = useFacts();
  const connection = useConnection();
  const reachable = connected(connection);
  const { jobs: history, reload } = useJobHistory(100);
  useEffect(() => onRefresh(reload), [reload]);
  const jobs = useMergedJobs(history, facts.jobs.value ?? []);
  const clock = now();
  const live = todayModel(facts, jobs, { now: clock, role });
  const { act, runs, dialog } = useNeedActions({ csrfToken, refresh, accept });
  const [allAttention, setAllAttention] = useState(false);

  // Kept for offline reads once everything has been read, and only while BoxPilot is answering.
  const liveKey = JSON.stringify(offlineCopy(live));
  useEffect(() => {
    if (reachable && !live.checking) saveLastKnown(accountId, "today", JSON.parse(liveKey) as TodayModel);
  }, [accountId, liveKey, reachable, live.checking]);

  const kept = !reachable ? readLastKnown<TodayModel>(accountId, "today", clock) : null;
  const model = kept?.value ?? live;
  const stale = Boolean(kept);
  const keptAt = kept ? new Date(kept.savedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : null;

  const open = (need: Need) => (need.jobId ? openActivity(need.jobId) : need.id === "unannounced" ? openNotifications() : onNavigate(need.view, need.appId && need.view === "catalog" ? { app: need.appId } : undefined));
  const runOf = (need: Need) => (need.finding ? runs[need.finding.id] : undefined);
  const attention = allAttention ? model.attention : model.attention.slice(0, shownAttention);
  const approvals = model.approvals.length;
  const read = () => { refresh(); reload(); };

  return (
    <div className="today-page cc" data-density="compact">
      {dialog}
      <PageHeader
        title="Today"
        status={{ status: stale ? "unknown" : model.verdict.status, label: stale ? "Not live" : model.verdict.label }}
        summary={model.verdict.sentence}
        meta={stale ? <>as BoxPilot said it at <b>{keptAt}</b></> : undefined}
        actions={<Button variant="ghost" onClick={read}>Refresh</Button>}
        about="The morning glance: what waits for your approval, what ran overnight, and whether the backups are off this server and current. Kept on this device for a day so it can be read without a connection."
      />

      {stale && (
        <Notice tone="warning" title="Not live">
          This is what BoxPilot said at {keptAt}. Approvals and fixes need BoxPilot to answer; they come back when it does.
        </Notice>
      )}

      <div className="today-grid">
        <Panel className="today-approvals" title="Waiting for approval" count={approvals ? { status: "warning", label: String(approvals) } : undefined}>
          {approvals === 0
            ? <p className="today-quiet">Nothing is waiting for your approval.</p>
            : <ul className="need-list">{model.approvals.map((need) => <NeedRow key={need.id} need={need} onOpen={open} onAct={stale ? () => undefined : act} tier="lead" />)}</ul>}
        </Panel>

        <Panel className="today-attention" title="Needs a look" count={model.attention.length ? { status: model.attention.some((need) => need.severity === "danger") ? "danger" : "warning", label: String(model.attention.length) } : undefined}
          meta={model.canWait ? `${model.canWait} more can wait` : undefined}>
          {model.attention.length === 0
            ? <p className="today-quiet">{model.checking ? "Reading this server…" : "Nothing needs a look."}</p>
            : <ul className="need-list">{attention.map((need) => <NeedRow key={need.id} need={need} onOpen={open} onAct={stale ? () => undefined : act} run={runOf(need)} />)}</ul>}
          {(model.attention.length > shownAttention || model.canWait > 0) && (
            <div className="today-more">
              {model.attention.length > shownAttention && <Button variant="ghost" aria-expanded={allAttention} onClick={() => setAllAttention((value) => !value)}>{allAttention ? "Show fewer" : `Show all ${model.attention.length}`}</Button>}
              {model.canWait > 0 && <Button variant="ghost" onClick={() => onNavigate("home")}>What can wait, on Home</Button>}
            </div>
          )}
        </Panel>

        {!stale && <AgentsGlance variant="ops" role={role} onOpen={() => onNavigate("agents")} now={now} />}

        <Panel className="today-ran" title="What ran" meta={model.window.label}>
          {model.ran.length === 0
            ? <p className="today-quiet">Nothing ran {model.window.label}.</p>
            : model.ran.map((group) => <RanList key={group.kind} group={group} clock={clock} />)}
        </Panel>

        <Panel className="today-backups" title="Off this server" padded>
          <MetricStrip label="Backups at a glance" minTile="9.5rem">
            <MetricTile label="Off this server" {...model.backups.offBox} onSelect={() => onNavigate("backups")} />
            <MetricTile label="Apps backed up" {...model.backups.apps} onSelect={() => onNavigate("backups")} />
            <MetricTile label="BoxPilot's database" {...model.backups.database} onSelect={() => onNavigate("backups")} />
          </MetricStrip>
        </Panel>
      </div>
    </div>
  );
}

function RanList({ group, clock }: { group: RanGroup; clock: number }) {
  return (
    <section className="today-group" aria-label={group.label}>
      <h3 className="today-group__title">
        {group.label}
        <Facts as="span">
          <b>{group.completed}</b> done{group.failed ? <> · <b>{group.failed}</b> failed</> : null}{group.running ? <> · <b>{group.running}</b> running</> : null}
        </Facts>
      </h3>
      <ul className="today-runs">
        {group.jobs.map((job) => (
          <li key={job.id} className="today-run" data-status={job.status}>
            {/* The whole row opens the job in Activity: one target, as tall as a finger needs. */}
            <button type="button" className="today-run__open" onClick={() => openActivity(job.id)}>
              <span className="today-run__words">
                <span className="today-run__title">{job.title}</span>
                {job.target && <span className="today-run__target">{job.target}</span>}
              </span>
              <span className="today-run__meta">
                <StatusChip status={job.status}>{job.label}</StatusChip>
                <time dateTime={job.at}>{relativeTime(job.at, clock) ?? ""}</time>
              </span>
            </button>
          </li>
        ))}
      </ul>
      {group.jobs.length < group.completed + group.failed + group.running && (
        <p className="today-group__rest">{countOf(group.completed + group.failed + group.running - group.jobs.length, "more job")} in Activity.</p>
      )}
    </section>
  );
}
