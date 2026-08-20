import { useCallback, useEffect, useState } from "react";
import { useOperation } from "./ApproveDialog";
import { inspectOperation } from "./operations";

interface DockerDisk { available: boolean; rows: Array<{ type: string; total: number | string | null; active: number | string | null; size: string | null; reclaimable: string | null }> }

interface SystemSettings {
  hostname: { static: string | null; live: string | null };
  timezone: string | null;
  timezones: string[];
  swappiness: number | null;
  swap: Array<{ device: string; type: string; sizeKiB: number; usedKiB: number; priority: number }>;
  memory: { memTotalKiB: number | null; memAvailableKiB: number | null; swapTotalKiB: number | null; swapFreeKiB: number | null };
  fstrim: { active: string | null; enabled: string | null; nextRun: string | null };
}

function gib(kib: number | null): string {
  if (kib === null) return "—";
  return `${(kib / 1024 / 1024).toFixed(1)} GiB`;
}

export default function SystemCenter({ csrfToken }: { csrfToken: string }) {
  const [settings, setSettings] = useState<SystemSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [hostname, setHostname] = useState("");
  const [timezone, setTimezone] = useState("");
  const [swappiness, setSwappiness] = useState("");

  const [dockerDisk, setDockerDisk] = useState<DockerDisk | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [{ result }, docker] = await Promise.all([
        inspectOperation<SystemSettings>("system.settings.inspect"),
        inspectOperation<DockerDisk>("docker.disk.inspect").catch(() => null),
      ]);
      setSettings(result);
      setDockerDisk(docker?.result && Array.isArray(docker.result.rows) ? docker.result : null);
      setHostname(result.hostname.static ?? "");
      setTimezone(result.timezone ?? "");
      setSwappiness(result.swappiness === null ? "" : String(result.swappiness));
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Could not read system settings");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const { start, dialog } = useOperation(csrfToken, () => { void refresh(); });

  const fstrimEnabled = settings?.fstrim.enabled === "enabled";
  const swappinessValue = Number.parseInt(swappiness, 10);
  const swappinessValid = Number.isInteger(swappinessValue) && swappinessValue >= 0 && swappinessValue <= 100;

  return (
    <div className="system-center">
      {dialog}
      {error && <div className="auth-error" role="alert">{error}</div>}

      <div className="metric-grid">
        <article className="panel"><span className="eyebrow">Hostname</span><strong>{loading ? "…" : settings?.hostname.live ?? "—"}</strong><span>{settings && settings.hostname.static !== settings.hostname.live ? `static: ${settings.hostname.static}` : "static and live match"}</span></article>
        <article className="panel"><span className="eyebrow">Time zone</span><strong>{loading ? "…" : settings?.timezone ?? "unknown"}</strong><span>{new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} in your browser</span></article>
        <article className="panel"><span className="eyebrow">Memory</span><strong>{loading ? "…" : gib(settings?.memory.memAvailableKiB ?? null)}</strong><span>available of {gib(settings?.memory.memTotalKiB ?? null)}</span></article>
        <article className="panel"><span className="eyebrow">Swap</span><strong>{loading ? "…" : gib(settings?.memory.swapTotalKiB ?? null)}</strong><span>{settings?.memory.swapTotalKiB ? `${gib((settings.memory.swapTotalKiB ?? 0) - (settings.memory.swapFreeKiB ?? 0))} in use` : "no swap configured"}</span></article>
      </div>

      <section className="panel">
        <header className="panel-header"><div><strong>Rename this server</strong><span>Sets the hostname and keeps /etc/hosts in step. Other machines that cached the old name keep using it until they look it up again.</span></div></header>
        <div className="recovery-actions">
          <input aria-label="New hostname" value={hostname} onChange={(event) => setHostname(event.target.value.toLowerCase())} placeholder="my-server" />
          <button className="primary-button" type="button" disabled={loading || !hostname || hostname === settings?.hostname.static} onClick={() => start({ operationId: "system.hostname.set", title: `Rename to ${hostname}`, parameters: { hostname }, preview: <span><code>hostnamectl set-hostname {hostname}</code>, then the <code>127.0.1.1</code> line in <code>/etc/hosts</code> is updated.</span> })}>Rename</button>
        </div>
      </section>

      <section className="panel">
        <header className="panel-header"><div><strong>Time zone</strong><span>Log timestamps, cron schedules, and timers follow the system time zone.</span></div></header>
        <div className="recovery-actions">
          {settings && settings.timezones.length > 0 ? (
            <select aria-label="Time zone" value={timezone} onChange={(event) => setTimezone(event.target.value)}>
              {settings.timezone && !settings.timezones.includes(settings.timezone) && <option value={settings.timezone}>{settings.timezone}</option>}
              {settings.timezones.map((zone) => <option key={zone} value={zone}>{zone}</option>)}
            </select>
          ) : (
            <input aria-label="Time zone" value={timezone} onChange={(event) => setTimezone(event.target.value)} placeholder="Europe/Berlin" />
          )}
          <button className="primary-button" type="button" disabled={loading || !timezone || timezone === settings?.timezone} onClick={() => start({ operationId: "system.timezone.set", title: `Change time zone to ${timezone}`, parameters: { timezone }, preview: <span><code>timedatectl set-timezone {timezone}</code></span> })}>Change</button>
        </div>
      </section>

      <section className="panel">
        <header className="panel-header"><div><strong>Swap and memory pressure</strong><span>Swappiness {settings?.swappiness ?? "—"} today. Lower values keep more in RAM; 10 suits most servers, 60 is the Ubuntu default.</span></div></header>
        <div className="recovery-actions">
          <input aria-label="Swappiness" inputMode="numeric" value={swappiness} onChange={(event) => setSwappiness(event.target.value)} placeholder="10" />
          <button className="primary-button" type="button" disabled={loading || !swappinessValid || swappinessValue === settings?.swappiness} onClick={() => start({ operationId: "system.swappiness.set", title: `Set swappiness to ${swappinessValue}`, parameters: { value: swappinessValue }, preview: <span>Applies now with <code>sysctl</code> and persists in <code>/etc/sysctl.d/99-boxpilot.conf</code>.</span> })}>Apply</button>
        </div>
        {settings && settings.swap.length > 0 && (
          <div className="table-scroll">
            <table>
              <thead><tr><th>Swap device</th><th>Type</th><th>Size</th><th>In use</th></tr></thead>
              <tbody>{settings.swap.map((device) => <tr key={device.device}><td><code>{device.device}</code></td><td>{device.type}</td><td>{gib(device.sizeKiB)}</td><td>{gib(device.usedKiB)}</td></tr>)}</tbody>
            </table>
          </div>
        )}
      </section>

      {dockerDisk?.available && (
        <section className="panel">
          <header className="panel-header">
            <div><strong>Docker disk use</strong><span>Cleanup removes stopped containers, unused networks, dangling images, and the build cache. Volumes and running apps are kept.</span></div>
            <button className="secondary-button" type="button" disabled={loading} onClick={() => start({ operationId: "docker.prune", title: "Clean up Docker disk space", parameters: {}, preview: <span><code>docker system prune --force</code> — volumes and images in use are kept.</span> })}>Clean up</button>
          </header>
          <div className="table-scroll">
            <table>
              <thead><tr><th>Type</th><th>Total</th><th>Active</th><th>Size</th><th>Reclaimable</th></tr></thead>
              <tbody>{dockerDisk.rows.map((row) => <tr key={row.type}><td>{row.type}</td><td>{row.total ?? "—"}</td><td>{row.active ?? "—"}</td><td>{row.size ?? "—"}</td><td>{row.reclaimable ?? "—"}</td></tr>)}</tbody>
            </table>
          </div>
        </section>
      )}

      <section className="panel">
        <header className="panel-header">
          <div><strong>SSD trim timer</strong><span>{fstrimEnabled ? `fstrim.timer is enabled${settings?.fstrim.nextRun ? `; next run ${settings.fstrim.nextRun}` : ""}.` : "fstrim.timer is disabled. Weekly trim keeps SSDs fast and healthy."}</span></div>
          <button className="secondary-button" type="button" disabled={loading} onClick={() => start({ operationId: "service.action", title: fstrimEnabled ? "Disable weekly trim" : "Enable weekly trim", parameters: { unit: "fstrim.timer", action: fstrimEnabled ? "disable" : "enable" }, preview: <span><code>systemctl {fstrimEnabled ? "disable" : "enable"} fstrim.timer</code></span> })}>{fstrimEnabled ? "Disable" : "Enable"}</button>
        </header>
      </section>
    </div>
  );
}
