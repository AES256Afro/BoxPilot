import { useCallback, useEffect, useId, useMemo, useState } from "react";
import { JobLogView } from "../../JobLogView";
import { Button, EmptyState, Field, Notice, Panel, Select, Sheet, StatusChip, Table, Tag, TextInput, type Status, type TableColumn } from "../../ui";
import "./automations.css";

/*
 * Schedules (M6.1, rebuilt on the kit in M33.11): registered operations on an hourly, daily or
 * weekly cadence, approved as whoever made them, each run a job in Activity and the audit log.
 * Automations shows them in their own tab; System (M33.8) still shows this panel as it is, so it
 * stays a component that loads what it needs when it is not given it.
 */

export interface Schedule {
  id: string; operationId: string; parameters: Record<string, unknown>; frequency: "hourly" | "daily" | "weekly";
  minute: number; hour: number | null; weekday: number | null; enabled: boolean;
  nextDueAt: string; lastRunAt: string | null; lastJobId: string | null; lastResult: string | null;
  title: string; cadence: string;
  /** Set by the API when a schedule has slipped a whole cycle past its due time (M20.1). */
  overdue?: boolean;
  /** How the last run ended, read from its job rather than from having started one (M27.2). */
  lastOutcome?: "ran" | "failed" | "did-not-run" | "running" | "unknown" | null;
  lastReason?: string | null;
}

interface Template { key: string; label: string; operationId: string; parameters: Record<string, unknown> }
type Frequency = "hourly" | "daily" | "weekly";

const weekdays = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** The schedules, read once and again after each change, for the panel and for a page's verdict. */
export function useSchedules(enabled = true) {
  const [schedules, setSchedules] = useState<Schedule[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    try {
      const response = await fetch("/api/v1/schedules");
      const body = (await response.json().catch(() => ({}))) as { schedules?: Schedule[]; error?: string };
      if (!response.ok) throw new Error(body.error ?? "Could not load schedules");
      setSchedules(body.schedules ?? []);
      setError(null);
    } catch (requestError) {
      setSchedules((current) => current ?? []);
      setError(requestError instanceof Error ? requestError.message : "Could not load schedules");
    }
  }, []);
  useEffect(() => { if (enabled) void refresh(); }, [enabled, refresh]);
  return { schedules, error, setError, refresh };
}
export type SchedulesSource = ReturnType<typeof useSchedules>;

/**
 * The last run's real ending: ran, failed, or did not run. Starting a job used to be shown as "ran",
 * so a backup whose job failed an hour later still looked fine here.
 */
export function lastRunOf(schedule: Schedule): { status: Status; label: string; failed: boolean } {
  const when = schedule.lastRunAt ? ` ${new Date(schedule.lastRunAt).toLocaleString()}` : "";
  switch (schedule.lastOutcome) {
    case "ran": return { status: "good", label: `ran${when}`, failed: false };
    case "running": return { status: "neutral", label: "running", failed: false };
    case "unknown": return { status: "unknown", label: `started${when}`, failed: false };
    case "did-not-run": return schedule.lastResult === "blocked-by-approval-mode"
      ? { status: "warning", label: "did not run: Always-ask approvals", failed: true }
      : { status: "warning", label: `did not run${when}`, failed: true };
    case "failed": return { status: "danger", label: `failed${when}`, failed: true };
    default: return schedule.lastResult ? { status: "danger", label: "failed", failed: true } : { status: "neutral", label: "not yet run", failed: false };
  }
}

export interface SchedulesPanelProps {
  csrfToken: string;
  /** The server's time zone, which the cadences are in. */
  serverTimezone?: string | null;
  /** Who is signed in: a viewer sees the schedules and changes none. */
  role?: string;
  /** The schedules, when the page already reads them (Automations, for its verdict); read here otherwise. */
  source?: SchedulesSource;
}

export default function SchedulesPanel({ csrfToken, serverTimezone = null, role = "owner", source }: SchedulesPanelProps) {
  const own = useSchedules(!source);
  const { schedules, error, setError, refresh } = source ?? own;
  const canChange = role !== "viewer";
  const [installedApps, setInstalledApps] = useState<Array<{ id: string; name: string }>>([]);
  const [log, setLog] = useState<Schedule | null>(null);
  const [adding, setAdding] = useState(false);
  const [templateKey, setTemplateKey] = useState("");
  const [frequency, setFrequency] = useState<Frequency>("daily");
  const [time, setTime] = useState("03:00");
  const [weekday, setWeekday] = useState(0);
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const formId = useId();

  useEffect(() => {
    fetch("/api/v1/catalog?view=summary")
      .then((response) => (response.ok ? response.json() : Promise.reject(new Error("catalog unavailable"))))
      .then((data: { applications: Array<{ manifest: { id: string; name: string }; live: { installed: boolean } | null }> }) => {
        setInstalledApps(data.applications.filter((entry) => entry.live?.installed).map((entry) => ({ id: entry.manifest.id, name: entry.manifest.name })));
      })
      .catch(() => {});
  }, []);

  const templates = useMemo<Template[]>(() => [
    ...installedApps.map((app) => ({ key: `backup:${app.id}`, label: `Back up ${app.name}`, operationId: "app.backup", parameters: { id: app.id } })),
    { key: "apt.refresh", label: "Refresh package lists", operationId: "apt.refresh", parameters: {} },
    { key: "apt.upgrade", label: "Install all package updates", operationId: "apt.upgrade", parameters: {} },
    { key: "docker.prune", label: "Clean up Docker disk space", operationId: "docker.prune", parameters: {} },
    { key: "backup.remote.sync", label: "Mirror backups to the SSH destination", operationId: "backup.remote.sync", parameters: {} },
    { key: "backup.cloud.sync", label: "Mirror backups to the cloud destination", operationId: "backup.cloud.sync", parameters: {} },
  ], [installedApps]);

  const create = async () => {
    const template = templates.find((entry) => entry.key === templateKey);
    if (!template || busy) return;
    const [hour, minute] = time.split(":").map((part) => Number.parseInt(part, 10));
    setFormError(null);
    setBusy(true);
    try {
      const response = await fetch("/api/v1/schedules", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-BoxPilot-CSRF": csrfToken },
        body: JSON.stringify({
          operationId: template.operationId,
          parameters: template.parameters,
          frequency,
          minute: Number.isInteger(minute) ? minute : 0,
          hour: frequency === "hourly" ? null : hour,
          weekday: frequency === "weekly" ? weekday : null,
        }),
      });
      const body = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) throw new Error(body.error ?? "Could not create the schedule");
      setTemplateKey("");
      setAdding(false);
      await refresh();
    } catch (requestError) {
      setFormError(requestError instanceof Error ? requestError.message : "Could not create the schedule");
    } finally {
      setBusy(false);
    }
  };

  const toggle = async (schedule: Schedule) => {
    const response = await fetch(`/api/v1/schedules/${encodeURIComponent(schedule.id)}`, { method: "PUT", headers: { "Content-Type": "application/json", "X-BoxPilot-CSRF": csrfToken }, body: JSON.stringify({ enabled: !schedule.enabled }) });
    if (!response.ok) { setError(((await response.json().catch(() => ({}))) as { error?: string }).error ?? "Could not change the schedule"); return; }
    setError(null);
    await refresh();
  };

  const remove = async (schedule: Schedule) => {
    const response = await fetch(`/api/v1/schedules/${encodeURIComponent(schedule.id)}`, { method: "DELETE", headers: { "X-BoxPilot-CSRF": csrfToken } });
    if (!response.ok) { setError(((await response.json().catch(() => ({}))) as { error?: string }).error ?? "Could not remove the schedule"); return; }
    setError(null);
    await refresh();
  };

  const list = schedules ?? [];
  const paused = list.filter((schedule) => !schedule.enabled).length;
  const columns: Array<TableColumn<Schedule>> = [
    {
      id: "what", header: "What", sortValue: (schedule) => schedule.title, cell: (schedule) => (
        <span className="automations-what">
          <span className="automations-what__title">{schedule.title}</span>
          {typeof schedule.parameters.subject === "string" ? <code>{schedule.parameters.subject}</code> : typeof schedule.parameters.id === "string" ? <code>{schedule.parameters.id}</code> : null}
        </span>
      ),
    },
    { id: "when", header: serverTimezone ? `When (${serverTimezone})` : "When", label: "When", sortValue: (schedule) => schedule.cadence, cell: (schedule) => schedule.cadence },
    {
      id: "next", header: "Next run (your time)", label: "Next run", sortValue: (schedule) => (schedule.enabled ? schedule.nextDueAt : null), cell: (schedule) => (
        <span className="automations-next">
          {schedule.enabled ? new Date(schedule.nextDueAt).toLocaleString() : "paused"}
          {schedule.enabled && schedule.overdue && <Tag tone="warning" title="This schedule has not run for more than a full cycle: the server may have been off, or the task may be failing.">behind</Tag>}
        </span>
      ),
    },
    {
      id: "last", header: "Last run", cell: (schedule) => {
        const last = lastRunOf(schedule);
        return (
          <span className="automations-last">
            <StatusChip status={last.status} title={schedule.lastReason ?? schedule.lastResult ?? undefined}>{last.label}</StatusChip>
            {/* Always-ask approvals stop every schedule, so say where that is changed. */}
            {schedule.lastResult === "blocked-by-approval-mode"
              ? <span className="automations-reason">Schedules are skipped while approvals always ask for the password. Change that in Settings, under Approvals.</span>
              : (schedule.lastOutcome === "failed" || schedule.lastOutcome === "did-not-run") && schedule.lastReason
                ? <span className="automations-reason">{schedule.lastReason}</span>
                : null}
          </span>
        );
      },
    },
    {
      id: "actions", header: <span className="ui-visually-hidden">Actions</span>, label: "Actions", className: "automations-actions-cell", cell: (schedule) => (
        <span className="automations-actions">
          {schedule.lastJobId && <Button variant="ghost" aria-label={`View log: ${schedule.title}`} onClick={() => setLog(schedule)}>Log</Button>}
          {canChange && <Button aria-label={`${schedule.enabled ? "Pause" : "Resume"} ${schedule.title}`} onClick={() => void toggle(schedule)}>{schedule.enabled ? "Pause" : "Resume"}</Button>}
          {canChange && <Button aria-label={`Delete the schedule: ${schedule.title}`} onClick={() => void remove(schedule)}>Delete</Button>}
        </span>
      ),
    },
  ];

  return (
    <Panel
      className="automations-schedules"
      title="Schedules"
      count={schedules ? list.length : undefined}
      meta={schedules ? <><b>{list.length - paused}</b> active · <b>{paused}</b> paused</> : undefined}
      actions={canChange ? <Button onClick={() => { setFormError(null); setAdding(true); }}>Add a schedule</Button> : undefined}
    >
      {error && <Notice tone="danger" live className="automations-notice" title="Schedules could not be changed" onDismiss={() => setError(null)}>{error}</Notice>}
      <Table
        caption="Scheduled operations"
        columns={columns}
        rows={list}
        rowKey={(schedule) => schedule.id}
        rowStatus={(schedule) => { const last = lastRunOf(schedule); return last.failed ? last.status : schedule.enabled && schedule.overdue ? "warning" : undefined; }}
        empty={schedules === null ? "Loading schedules…" : <EmptyState title="Nothing scheduled yet" action={canChange ? <Button onClick={() => setAdding(true)}>Add a schedule</Button> : undefined}>Backups, update refreshes and cleanup can run on their own, each run a job in Activity.</EmptyState>}
      />

      {log?.lastJobId && (
        <Sheet kicker="Last run" title={log.title} size="lg" onClose={() => setLog(null)}>
          <JobLogView jobId={log.lastJobId} title={log.title} />
        </Sheet>
      )}

      {adding && (
        <Sheet
          kicker="New schedule"
          title="Run something on its own"
          onClose={() => setAdding(false)}
          footer={<>
            <Button onClick={() => setAdding(false)}>Cancel</Button>
            <Button variant="primary" type="submit" form={formId} disabled={!templateKey} busy={busy}>Add schedule</Button>
          </>}
        >
          <form id={formId} className="automations-form" onSubmit={(event) => { event.preventDefault(); void create(); }}>
            {formError && <Notice tone="danger" live title="The schedule was not added">{formError}</Notice>}
            <Field label="What to run" hint="Runs as you, approved like any schedule. A high-risk operation cannot run unattended.">
              <Select value={templateKey} onValueChange={setTemplateKey} placeholder="Choose an action…" options={templates.map((template) => ({ value: template.key, label: template.label }))} />
            </Field>
            <Field label="How often">
              <Select value={frequency} onValueChange={(value) => setFrequency(value as Frequency)} options={[{ value: "hourly", label: "Hourly" }, { value: "daily", label: "Daily" }, { value: "weekly", label: "Weekly" }]} />
            </Field>
            {frequency === "weekly" && (
              <Field label="Weekday">
                <Select value={String(weekday)} onValueChange={(value) => setWeekday(Number(value))} options={weekdays.map((day, index) => ({ value: String(index), label: day }))} />
              </Field>
            )}
            {frequency !== "hourly" ? (
              <Field label="Time of day" hint={serverTimezone ? `In the server's time zone, ${serverTimezone}.` : "In the server's time zone."}>
                <TextInput type="time" mono value={time} onValueChange={setTime} />
              </Field>
            ) : (
              <Field label="Minute of the hour">
                <TextInput mono inputMode="numeric" value={time.split(":")[1] ?? "0"} onValueChange={(value) => setTime(`00:${value}`)} placeholder="minute" />
              </Field>
            )}
          </form>
        </Sheet>
      )}
    </Panel>
  );
}
