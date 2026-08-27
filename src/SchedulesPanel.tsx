import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { JobLogView } from "./JobLogView";

interface Schedule {
  id: string; operationId: string; parameters: Record<string, unknown>; frequency: "hourly" | "daily" | "weekly";
  minute: number; hour: number | null; weekday: number | null; enabled: boolean;
  nextDueAt: string; lastRunAt: string | null; lastJobId: string | null; lastResult: string | null;
  title: string; cadence: string;
}

interface Template { key: string; label: string; operationId: string; parameters: Record<string, unknown> }

const weekdays = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function lastResultPill(schedule: Schedule) {
  if (!schedule.lastResult) return <span className="status-pill status-neutral">not yet run</span>;
  if (schedule.lastResult === "started") return <span className="status-pill status-good">ran {schedule.lastRunAt ? new Date(schedule.lastRunAt).toLocaleString() : ""}</span>;
  if (schedule.lastResult === "blocked-by-approval-mode") return <span className="status-pill status-warning">skipped: Always-ask approvals</span>;
  return <span className="status-pill status-danger" title={schedule.lastResult}>failed</span>;
}

/** Scheduled operations (M6.1): nightly app backups, update refreshes, Docker cleanup. */
export default function SchedulesPanel({ csrfToken, serverTimezone = null }: { csrfToken: string; serverTimezone?: string | null }) {
  const [schedules, setSchedules] = useState<Schedule[] | null>(null);
  const [installedApps, setInstalledApps] = useState<Array<{ id: string; name: string }>>([]);
  const [error, setError] = useState<string | null>(null);
  const [openLog, setOpenLog] = useState<string | null>(null);
  const [templateKey, setTemplateKey] = useState("");
  const [frequency, setFrequency] = useState<"hourly" | "daily" | "weekly">("daily");
  const [time, setTime] = useState("03:00");
  const [weekday, setWeekday] = useState(0);

  const refresh = useCallback(async () => {
    try {
      const response = await fetch("/api/v1/schedules");
      const body = (await response.json().catch(() => ({}))) as { schedules?: Schedule[]; error?: string };
      if (!response.ok) throw new Error(body.error ?? "Could not load schedules");
      setSchedules(body.schedules ?? []);
    } catch (requestError) {
      setSchedules([]);
      setError(requestError instanceof Error ? requestError.message : "Could not load schedules");
    }
  }, []);

  useEffect(() => {
    void refresh();
    fetch("/api/v1/catalog")
      .then((response) => (response.ok ? response.json() : Promise.reject(new Error("catalog unavailable"))))
      .then((data: { applications: Array<{ manifest: { id: string; name: string }; live: { installed: boolean } | null }> }) => {
        setInstalledApps(data.applications.filter((entry) => entry.live?.installed).map((entry) => ({ id: entry.manifest.id, name: entry.manifest.name })));
      })
      .catch(() => {});
  }, [refresh]);

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
    if (!template) return;
    const [hour, minute] = time.split(":").map((part) => Number.parseInt(part, 10));
    setError(null);
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
      await refresh();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Could not create the schedule");
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

  return (
    <section className="panel schedules-panel">
      <header className="panel-header"><div><strong>Schedules</strong><span>Backups, update refreshes, and cleanup run on their own. Each run appears in Activity and the audit log.</span></div></header>
      {error && <div className="auth-error" role="alert">{error}</div>}
      <div className="table-scroll">
        <table>
          <thead><tr><th>What</th><th>When{serverTimezone ? <span className="muted"> ({serverTimezone})</span> : null}</th><th>Next run <span className="muted">(your time)</span></th><th>Last run</th><th aria-label="Actions" /></tr></thead>
          <tbody>
            {schedules === null ? <tr><td colSpan={5}>Loading schedules...</td></tr> : null}
            {schedules?.length === 0 ? <tr><td colSpan={5}>Nothing scheduled yet.</td></tr> : null}
            {schedules?.map((schedule) => (
              <Fragment key={schedule.id}>
                <tr className={schedule.enabled ? "" : "schedule-disabled"}>
                  <td>{schedule.title}{typeof schedule.parameters.subject === "string" ? <> · <code>{schedule.parameters.subject}</code></> : null}</td>
                  <td>{schedule.cadence}</td>
                  <td>{schedule.enabled ? new Date(schedule.nextDueAt).toLocaleString() : "paused"}</td>
                  <td>{lastResultPill(schedule)}</td>
                  <td>
                    <div className="recovery-actions">
                      {schedule.lastJobId && (
                        <button className="text-button" type="button" onClick={() => setOpenLog((current) => (current === schedule.id ? null : schedule.id))}>
                          {openLog === schedule.id ? "Hide log" : "View log"}
                        </button>
                      )}
                      <button className="text-button" type="button" onClick={() => void toggle(schedule)}>{schedule.enabled ? "Pause" : "Resume"}</button>
                      <button className="text-button" type="button" onClick={() => void remove(schedule)}>Delete</button>
                    </div>
                  </td>
                </tr>
                {openLog === schedule.id && schedule.lastJobId && (
                  <tr className="schedule-log-row">
                    <td colSpan={5}><JobLogView jobId={schedule.lastJobId} title={schedule.title} /></td>
                  </tr>
                )}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
      <div className="recovery-actions schedule-form">
        <select aria-label="Scheduled action" value={templateKey} onChange={(event) => setTemplateKey(event.target.value)}>
          <option value="">Choose an action...</option>
          {templates.map((template) => <option key={template.key} value={template.key}>{template.label}</option>)}
        </select>
        <select aria-label="Frequency" value={frequency} onChange={(event) => setFrequency(event.target.value as typeof frequency)}>
          <option value="hourly">Hourly</option>
          <option value="daily">Daily</option>
          <option value="weekly">Weekly</option>
        </select>
        {frequency === "weekly" && (
          <select aria-label="Weekday" value={weekday} onChange={(event) => setWeekday(Number(event.target.value))}>
            {weekdays.map((day, index) => <option key={day} value={index}>{day}</option>)}
          </select>
        )}
        {frequency !== "hourly" ? (
          <input aria-label="Time of day" type="time" value={time} onChange={(event) => setTime(event.target.value)} />
        ) : (
          <input aria-label="Minute of the hour" inputMode="numeric" value={time.split(":")[1] ?? "0"} onChange={(event) => setTime(`00:${event.target.value}`)} placeholder="minute" />
        )}
        <button className="primary-button" type="button" disabled={!templateKey} onClick={() => void create()}>Add schedule</button>
      </div>
    </section>
  );
}
