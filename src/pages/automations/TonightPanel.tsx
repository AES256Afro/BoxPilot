import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { openView } from "../../activityEvents";
import { readJson } from "../../http";
import type { Job } from "../../operations";
import { Button, EmptyState, Notice, Panel, StatusChip, Tag } from "../../ui";
import { agentsApi } from "../agents/api";
import type { SchedulesSource } from "./SchedulesPanel";
import { cadenceLabel, type Flow } from "./flows";
import {
  browserClock, clockIn, clockWords, durationWords, jobsFromAgents, jobsFromFlows, jobsFromSchedules, lastRunWords, movedCadence, planTonight, verdictOf,
  type JobTimes, type Overlap, type PlannedJob, type QuietHours,
} from "./tonight";
import "./automations.css";

/*
 * Tonight: what this server will do by itself between 20:00 and 08:00, as a table that is also a
 * chart, with the jobs that will run into each other called out. The sums are in tonight.ts; this
 * reads what they need and draws the answer.
 *
 * Every row is something scheduled: the page's schedules and automations, and the agents with a
 * schedule. A job's length is what its last finished run took, read from the job history; nothing
 * is estimated beyond that. If any of it cannot be read the verdict is "Not read", never green.
 *
 * Times are the server's: the instant it gave for each next run, read on its own clock (the time
 * zone System reports). The browser's clock stands in only when that zone was not read, and the
 * foot of the panel says which it is.
 */

type Read<T> = { state: "reading" } | { state: "read"; value: T } | { state: "unread" };

export interface TonightPanelProps {
  csrfToken: string;
  /** Who is signed in: a viewer reads the night and moves nothing. */
  role?: string;
  /** The automations as the page read them; null until it has. */
  flows: Flow[] | null;
  /** The page's last read of the automations failed. */
  flowsUnread?: boolean;
  schedules: SchedulesSource;
  /** The server's time zone, which every time here is in. */
  serverTimezone?: string | null;
  /** Read the automations again: one was moved, or the owner asked. */
  onFlowsChanged: () => unknown;
  /** Open the page's Schedules tab. */
  onOpenSchedules: () => void;
  /** The time, for tests. */
  now?: () => number;
}

const two = (value: number) => String(value).padStart(2, "0");
const span = (from: number, to: number) => ({ "--from": from, "--to": to }) as CSSProperties;

export default function TonightPanel({ csrfToken, role = "owner", flows, flowsUnread = false, schedules, serverTimezone = null, onFlowsChanged, onOpenSchedules, now = Date.now }: TonightPanelProps) {
  const [round, setRound] = useState(0);
  const [at, setAt] = useState(now);
  const [history, setHistory] = useState<Read<Map<string, JobTimes>>>({ state: "reading" });
  const [quiet, setQuiet] = useState<Read<QuietHours>>({ state: "reading" });
  const [agents, setAgents] = useState<Read<PlannedJob[]>>({ state: "reading" });
  const [moving, setMoving] = useState(false);
  const [moved, setMoved] = useState<string | null>(null);
  const [moveError, setMoveError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    // The summary view of the newest two hundred jobs: their states and times, without their logs.
    fetch("/api/v1/jobs?limit=200&view=summary").then((response) => readJson<{ jobs?: Job[] }>(response))
      .then((body) => {
        if (!Array.isArray(body?.jobs)) throw new Error("no jobs in the answer");
        if (live) setHistory({ state: "read", value: new Map(body.jobs.map((job) => [job.id, job])) });
      })
      .catch(() => { if (live) setHistory({ state: "unread" }); });
    fetch("/api/v1/settings/quiet-hours").then((response) => readJson<QuietHours>(response))
      .then((body) => {
        if (typeof body?.enabled !== "boolean") throw new Error("no quiet hours in the answer");
        if (live) setQuiet({ state: "read", value: body });
      })
      .catch(() => { if (live) setQuiet({ state: "unread" }); });
    agentsApi.overview()
      .then(async (overview) => {
        // Past runs are read only for the agents that will run: with Agents off, that is none.
        const due = jobsFromAgents(overview.agents, overview.module, {}).filter((job) => job.enabled).map((job) => job.id.slice("agent:".length));
        const runs = Object.fromEntries(await Promise.all(due.map((id) => agentsApi.runs(id).then((body) => [id, Array.isArray(body?.runs) ? body.runs : null] as const, () => [id, null] as const))));
        if (live) setAgents({ state: "read", value: jobsFromAgents(overview.agents, overview.module, runs) });
      })
      .catch(() => { if (live) setAgents({ state: "unread" }); });
    return () => { live = false; };
  }, [round]);

  const readAgain = () => {
    setAt(now());
    setRound((value) => value + 1);
    void schedules.refresh();
    void onFlowsChanged();
  };

  const serverClock = useMemo(() => clockIn(serverTimezone), [serverTimezone]);
  const clock = serverClock ?? browserClock;
  const jobHistory = history.state === "read" ? history.value : null;
  const agentJobs = agents.state === "read" ? agents.value : null;
  const plan = useMemo(() => planTonight({
    jobs: [...jobsFromSchedules(schedules.schedules ?? [], jobHistory), ...jobsFromFlows(flows ?? [], jobHistory), ...(agentJobs ?? [])],
    quiet: quiet.state === "read" ? quiet.value : null,
    now: at,
    clock,
  }), [schedules.schedules, flows, jobHistory, agentJobs, quiet, at, clock]);

  const reading = (flows === null && !flowsUnread) || schedules.schedules === null || history.state === "reading" || quiet.state === "reading" || agents.state === "reading";
  // What could not be read, in words. Any of it makes the verdict "Not read": a night with a list
  // missing, or with lengths missing, cannot be called clear.
  const missing = [
    flowsUnread ? "the automations" : null,
    schedules.unread ? "the schedules" : null,
    history.state === "unread" ? "the job history, which says how long each last run took" : null,
    agents.state === "unread" ? "the agents' schedules" : null,
    plan.rows.some((row) => row.kind === "agent" && row.last.known === "unread") ? "an agent's past runs" : null,
    quiet.state === "unread" ? "the quiet hours" : null,
  ].filter((part): part is string => part !== null);
  const verdict = reading ? { status: "unknown" as const, label: "Reading…" } : verdictOf(plan, missing.length > 0);

  const viewer = role === "viewer";
  const mayManage = (flow: Flow) => !viewer && (role === "owner" || flow.createdBy !== null) && !flow.triggerDrive;
  const flowOf = (job: Overlap["later"]) => (job.kind === "automation" ? (flows ?? []).find((flow) => `automation:${flow.id}` === job.id) ?? null : null);

  const move = async (flow: Flow, cadence: ReturnType<typeof movedCadence>) => {
    if (moving) return;
    setMoving(true); setMoved(null); setMoveError(null);
    try {
      const response = await fetch(`/api/v1/flows/${encodeURIComponent(flow.id)}`, { method: "PUT", headers: { "Content-Type": "application/json", "X-BoxPilot-CSRF": csrfToken }, body: JSON.stringify({ cadence }) });
      if (!response.ok) throw new Error(((await response.json().catch(() => ({}))) as { error?: string }).error ?? "The request was refused");
      setMoved(`${flow.name} now runs ${cadenceLabel(cadence)}.`);
      await onFlowsChanged();
    } catch (requestError) {
      setMoveError(requestError instanceof Error ? requestError.message : "Could not move it");
    } finally {
      setMoving(false);
    }
  };

  // A schedule is moved in place (PUT /schedules/:id { time }): the same job and frequency at another
  // time, its last result kept. The server lists a schedule only to someone who may change it.
  const scheduleOf = (job: Overlap["later"]) => (job.kind === "schedule" ? (schedules.schedules ?? []).find((entry) => `schedule:${entry.id}` === job.id) ?? null : null);
  const moveSchedule = async (schedule: { id: string; title: string }, cadence: ReturnType<typeof movedCadence>) => {
    if (moving) return;
    setMoving(true); setMoved(null); setMoveError(null);
    try {
      const response = await fetch(`/api/v1/schedules/${encodeURIComponent(schedule.id)}`, { method: "PUT", headers: { "Content-Type": "application/json", "X-BoxPilot-CSRF": csrfToken }, body: JSON.stringify({ time: { minute: cadence.minute, hour: cadence.hour, weekday: cadence.weekday } }) });
      if (!response.ok) throw new Error(((await response.json().catch(() => ({}))) as { error?: string }).error ?? "The request was refused");
      setMoved(`${schedule.title} now runs ${cadenceLabel(cadence)}.`);
      await schedules.refresh();
    } catch (requestError) {
      setMoveError(requestError instanceof Error ? requestError.message : "Could not move it");
    } finally {
      setMoving(false);
    }
  };

  const first = reading ? null : plan.overlaps[0] ?? null;
  const overlapPanel = (overlap: Overlap) => {
    const flow = flowOf(overlap.later);
    // The one thing the page can do about it: an automation's time is changed with the request its
    // own card uses. A schedule's and an agent's are changed where they are kept.
    const cadence = flow && mayManage(flow) && overlap.move && (flow.frequency === "daily" || flow.frequency === "weekly")
      ? movedCadence({ frequency: flow.frequency, minute: flow.minute, hour: flow.hour, weekday: flow.weekday }, overlap.move.deltaMinutes)
      : null;
    const schedule = scheduleOf(overlap.later);
    const scheduleCadence = schedule && !viewer && overlap.move && (schedule.frequency === "daily" || schedule.frequency === "weekly")
      ? movedCadence({ frequency: schedule.frequency, minute: schedule.minute, hour: schedule.hour, weekday: schedule.weekday }, overlap.move.deltaMinutes)
      : null;
    const action = flow
      ? cadence && <Button variant="primary" busy={moving} onClick={() => void move(flow, cadence)}>Move {overlap.later.name} to {two(cadence.hour)}:{two(cadence.minute)}</Button>
      : overlap.later.kind === "schedule"
        ? (schedule && scheduleCadence
          ? <Button variant="primary" busy={moving} onClick={() => void moveSchedule(schedule, scheduleCadence)}>Move {overlap.later.name} to {two(scheduleCadence.hour)}:{two(scheduleCadence.minute)}</Button>
          : <Button onClick={onOpenSchedules}>Open Schedules</Button>)
        : <Button onClick={() => openView("agents")}>Open Agents</Button>;
    const consequence = `${overlap.later.name} then waits behind it or runs beside it, and both finish later than planned.`;
    return (
      <Notice tone="warning" className="automations-tonight__overlap" title={`${overlap.earlier.name} and ${overlap.later.name} will run into each other at ${overlap.atLabel}`} action={action || undefined}>
        <p>
          {overlap.earlierTookMs !== null
            ? `${overlap.earlier.name} took ${durationWords(overlap.earlierTookMs)} last time, so it will still be running when ${overlap.later.name} starts at ${overlap.atLabel}: ${consequence}`
            : `${overlap.earlier.name} starts at ${overlap.earlierAtLabel} and has no run to measure yet, and ${overlap.later.name} starts at ${overlap.atLabel}, within ten minutes of it: ${consequence}`}
          {overlap.times > 1 ? ` They meet ${overlap.times} times tonight.` : ""}
        </p>
        {plan.overlaps.length > 1 && (
          <ul className="automations-tonight__others" aria-label="Other overlaps tonight">
            {plan.overlaps.slice(1).map((other) => <li key={`${other.earlier.id} ${other.later.id}`}>{other.earlier.name} and {other.later.name} at <b>{other.atLabel}</b></li>)}
          </ul>
        )}
      </Notice>
    );
  };

  const quietFact = quiet.state === "unread" ? "not read" : quiet.state === "read" && quiet.value.enabled ? `${quiet.value.start} to ${quiet.value.end}` : quiet.state === "read" ? "off" : "…";
  const until = clockWords(clock(plan.end));
  const marks = new Set(plan.rows.flatMap((row) => row.cells.map((cell) => cell?.kind)));

  return (
    <Panel
      className="automations-tonight"
      title="Tonight"
      meta={reading ? undefined : <><b>{plan.rows.length}</b> {plan.rows.length === 1 ? "job" : "jobs"}{plan.first ? <> · first <b>{plan.first}</b> · last <b>{plan.last}</b></> : null} · quiet hours <b>{quietFact}</b></>}
      actions={<Button variant="ghost" onClick={readAgain}>Check again</Button>}
      footer={<>
        {serverClock ? <>Times are this server's clock, <b>{serverTimezone}</b>.</> : "Times are your browser's clock: this server's time zone was not read."}
        {" "}A job is as long as its last finished run took; one with no run to measure is given ten minutes.
        {role !== "owner" ? " The schedules listed are the ones you made; the owner sees every account's." : ""}
      </>}
    >
      <p className="automations-tonight__verdict"><StatusChip status={verdict.status}>{verdict.label}</StatusChip></p>
      {missing.length > 0 && (
        <Notice tone="danger" className="automations-notice" title="Tonight could not be read in full" action={<Button onClick={readAgain}>Try again</Button>}>
          Not read: {missing.join("; ")}. What is shown is the rest.
        </Notice>
      )}
      {moveError && <Notice tone="danger" live className="automations-notice" title="It was not moved" onDismiss={() => setMoveError(null)}>{moveError}</Notice>}
      {moved && !moveError && <Notice tone="success" live className="automations-notice" onDismiss={() => setMoved(null)}>{moved}</Notice>}

      {reading ? <p className="automations-quiet">Reading…</p>
        : plan.rows.length === 0 ? (
          <EmptyState title={missing.length ? "Nothing that could be read is due tonight" : "Nothing is due tonight"} action={<Button onClick={onOpenSchedules}>Open Schedules</Button>}>
            No schedule, automation or agent has a run between {plan.columns[0].label} and {until}.
          </EmptyState>
        ) : (
          <>
            {/* A real table, scrolled sideways in its own box on a narrow screen: the keyboard reaches the box to scroll it. */}
            <div className="automations-tonight__scroll" role="region" aria-label="Tonight, on a time axis" tabIndex={0}>
              <table className="automations-tonight__table">
                <caption className="ui-visually-hidden">What this server will do by itself from {plan.columns[0].label} to {until}, in half hours</caption>
                <thead>
                  <tr>
                    <th scope="col">Job</th>
                    <th scope="col">Starts</th>
                    <th scope="col">Last run</th>
                    {plan.hours.map((hour) => <th key={hour.at} scope="col" colSpan={2} className="automations-tonight__hour">{hour.label}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {plan.quiet && (
                    <tr className="automations-tonight__quiet">
                      <th scope="row"><span className="automations-tonight__name">Quiet hours</span><span className="automations-tonight__detail">pushes wait{plan.quiet.holdHigh ? ", urgent ones too" : "; urgent ones still come"}</span></th>
                      <td className="automations-tonight__starts">{plan.quiet.start}</td>
                      <td className="automations-tonight__took">{plan.quiet.held > 0 ? `${plan.quiet.held} ${plan.quiet.held === 1 ? "push" : "pushes"} held` : "none held"}</td>
                      {plan.quiet.cells.map((cell, index) => (
                        <td key={plan.columns[index].at} className="automations-tonight__cell" data-half={index % 2 ? "second" : "first"}>
                          {cell && <span className="automations-tonight__bar automations-tonight__mark" data-kind="quiet" style={span(cell.from, cell.to)} {...(cell.label ? { role: "img", "aria-label": cell.label } : { "aria-hidden": true })} />}
                        </td>
                      ))}
                    </tr>
                  )}
                  {plan.rows.map((row) => (
                    <tr key={row.id} data-clash={row.clashes || undefined}>
                      <th scope="row">
                        <span className="automations-tonight__name">{row.name}</span>
                        {(row.detail || row.note) && <span className="automations-tonight__detail">{[row.detail, row.note].filter(Boolean).join(" · ")}</span>}
                      </th>
                      <td className="automations-tonight__starts">{row.startsLabel}{row.clashes && <> <Tag tone="warning">overlap</Tag></>}</td>
                      <td className="automations-tonight__took" data-long={row.ranLong || undefined}>{lastRunWords(row.last)}</td>
                      {row.cells.map((cell, index) => (
                        <td key={plan.columns[index].at} className="automations-tonight__cell" data-half={index % 2 ? "second" : "first"}>
                          {cell && <span className="automations-tonight__bar automations-tonight__mark" data-kind={cell.kind} data-clash={cell.clash || undefined} role="img" aria-label={cell.label} style={span(cell.from, cell.to)} />}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {/* Each mark differs by its pattern, not its colour, and is named here. */}
            <ul className="automations-tonight__legend" aria-label="What the marks mean">
              {marks.has("planned") && <li><span className="automations-tonight__swatch automations-tonight__mark" data-kind="planned" aria-hidden="true" />Starts here, as long as its last run took</li>}
              {marks.has("spill") && <li><span className="automations-tonight__swatch automations-tonight__mark" data-kind="spill" aria-hidden="true" />Its last run went on past the half hour it starts in</li>}
              {marks.has("queued") && <li><span className="automations-tonight__swatch automations-tonight__mark" data-kind="queued" aria-hidden="true" />An agent's run: queued then, starts when the runner is free</li>}
              {plan.quiet && <li><span className="automations-tonight__swatch automations-tonight__mark" data-kind="quiet" aria-hidden="true" />Quiet hours</li>}
              {plan.overlaps.length > 0 && <li><span className="automations-tonight__swatch automations-tonight__mark" data-kind="planned" data-clash aria-hidden="true" />Starts while another job is still running</li>}
            </ul>
          </>
        )}

      {first && overlapPanel(first)}
    </Panel>
  );
}
