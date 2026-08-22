import { useCallback, useEffect, useMemo, useState } from "react";
import { useOperation } from "./ApproveDialog";
import { inspectOperation } from "./operations";

interface Unit { unit: string; description: string; load: string; active: string; sub: string; enabled: string; critical: boolean; guarded?: string | null }
interface ServiceList { units: Unit[]; counts: { total: number; active: number; failed: number } }

const interesting = /^(docker|containerd|libvirtd|virtqemud|tailscaled|ssh|cron|nginx|caddy|apache2|smbd|nmbd|nfs-server|cockpit|unattended-upgrades|fail2ban|ufw|boxpilot|restic|smartmontools|smartd|nut-|upsd|postgresql|mariadb|mysql|redis|pihole|adguard|jellyfin|plex|homeassistant|zfs|snapd|fwupd|apt-daily|dpkg-db-backup|logrotate|man-db|e2scrub|fstrim|motd-news|systemd-tmpfiles-clean|update-notifier)/;

export default function ServicesCenter({ csrfToken }: { csrfToken: string }) {
  const [data, setData] = useState<ServiceList | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [scope, setScope] = useState<"common" | "active" | "failed" | "all">("common");
  const [journal, setJournal] = useState<{ unit: string; lines: string[] } | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const { result } = await inspectOperation<ServiceList>("service.list");
      setData(result); setError(null);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Could not list services");
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);

  const { start, dialog } = useOperation(csrfToken, () => { void refresh(); });

  const showJournal = async (unit: string) => {
    try {
      const response = await fetch("/api/v1/operations/service.journal/run", { method: "POST", headers: { "Content-Type": "application/json", "X-BoxPilot-CSRF": csrfToken }, body: JSON.stringify({ parameters: { unit, lines: 200 } }) });
      const body = (await response.json()) as { result?: { lines: string[] }; error?: string };
      if (!response.ok) throw new Error(body.error ?? "Could not read the journal");
      setJournal({ unit, lines: body.result?.lines ?? [] });
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Could not read the journal");
    }
  };

  const visible = useMemo(() => {
    const units = data?.units ?? [];
    const needle = filter.trim().toLowerCase();
    return units.filter((unit) => {
      if (needle) return unit.unit.toLowerCase().includes(needle) || unit.description.toLowerCase().includes(needle);
      if (scope === "failed") return unit.active === "failed";
      if (scope === "active") return unit.active === "active";
      if (scope === "common") return interesting.test(unit.unit) || unit.active === "failed";
      return true;
    });
  }, [data, filter, scope]);

  const act = (unit: Unit, action: "start" | "stop" | "restart" | "reload" | "enable" | "disable") => start({
    operationId: "service.action", title: `${action[0].toUpperCase()}${action.slice(1)} ${unit.unit}`, parameters: { unit: unit.unit, action },
    preview: <span><code>systemctl {action} {unit.unit}</code>{unit.description ? ` — ${unit.description}` : ""}</span>,
  });

  const statePill = (unit: Unit) => {
    if (unit.active === "active") return <span className="status-pill status-good">{unit.sub}</span>;
    if (unit.active === "failed") return <span className="status-pill status-danger">failed</span>;
    if (unit.active === "activating" || unit.active === "deactivating") return <span className="status-pill status-warning">{unit.active}</span>;
    return <span className="status-pill status-neutral">{unit.sub || unit.active}</span>;
  };

  return (
    <div className="services-center">
      {dialog}
      {journal && (
        <div className="modal-backdrop" role="presentation" onMouseDown={() => setJournal(null)}>
          <section className="modal" role="dialog" aria-modal="true" aria-labelledby="journal-title" onMouseDown={(event) => event.stopPropagation()}>
            <header className="modal-header"><div><span className="eyebrow">Journal</span><h2 id="journal-title">{journal.unit}</h2></div><button className="icon-button" type="button" onClick={() => setJournal(null)} aria-label="Close dialog">X</button></header>
            <pre className="app-logs">{journal.lines.join("\n") || "(no entries)"}</pre>
          </section>
        </div>
      )}
      <div className="metric-grid">
        <article className="panel"><span className="eyebrow">Services and timers</span><strong>{data?.counts.total ?? "…"}</strong><span>known units</span></article>
        <article className="panel"><span className="eyebrow">Active</span><strong>{data?.counts.active ?? "…"}</strong><span>running now</span></article>
        <article className="panel"><span className="eyebrow">Failed</span><strong className={data?.counts.failed ? "danger-text" : ""}>{data?.counts.failed ?? "…"}</strong><span>{data?.counts.failed ? "need attention" : "none"}</span></article>
      </div>
      {error && <div className="auth-error" role="alert">{error}</div>}
      <section className="panel">
        <header className="panel-header">
          <div><strong>Units</strong><span>Start, stop, restart, enable, or disable. Protected units (BoxPilot, SSH, systemd, Tailscale) cannot be stopped from here.</span></div>
          <div className="recovery-actions">
            {(["common", "active", "failed", "all"] as const).map((key) => <button key={key} className={`secondary-button${scope === key && !filter ? " is-active" : ""}`} type="button" onClick={() => { setScope(key); setFilter(""); }}>{key === "common" ? "Common" : key[0].toUpperCase() + key.slice(1)}</button>)}
            <input aria-label="Filter units" placeholder="Filter by name…" value={filter} onChange={(event) => setFilter(event.target.value)} />
            <button className="text-button" type="button" onClick={() => void refresh()} disabled={loading}>Refresh</button>
          </div>
        </header>
        <div className="table-scroll">
          <table>
            <thead><tr><th>Unit</th><th>State</th><th>On boot</th><th>Actions</th></tr></thead>
            <tbody>
              {loading && !data ? <tr><td colSpan={4}>Reading systemd…</td></tr> : null}
              {data && visible.length === 0 ? <tr><td colSpan={4}>No units match.</td></tr> : null}
              {visible.map((unit) => (
                <tr key={unit.unit}>
                  <td><code>{unit.unit}</code>{unit.description && <div className="muted">{unit.description}</div>}</td>
                  <td>{statePill(unit)}</td>
                  <td>{unit.enabled}</td>
                  <td>
                    <div className="recovery-actions">
                      {unit.active === "active" ? <>
                        <button className="text-button" type="button" onClick={() => act(unit, "restart")}>Restart</button>
                        {!unit.critical && !unit.guarded && <button className="text-button" type="button" onClick={() => act(unit, "stop")}>Stop</button>}
                        {unit.guarded && <span className="muted" title={unit.guarded}>Managed on the Firewall page</span>}
                      </> : <button className="text-button" type="button" onClick={() => act(unit, "start")}>Start</button>}
                      {unit.enabled === "enabled" && !unit.critical && !unit.guarded && <button className="text-button" type="button" onClick={() => act(unit, "disable")}>Disable</button>}
                      {(unit.enabled === "disabled") && <button className="text-button" type="button" onClick={() => act(unit, "enable")}>Enable</button>}
                      <button className="text-button" type="button" onClick={() => void showJournal(unit.unit)}>Journal</button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
