import { useCallback, useEffect, useState } from "react";
import type { PendingOperation } from "./ApproveDialog";
import { inspectOperation } from "./operations";

interface Fail2banState {
  installed: boolean; running: boolean | null; configured: boolean;
  config: { managed: boolean; maxRetry: number | null; findTimeMinutes: number | null; banTimeMinutes: number | null; ignoreLan: boolean; ignore: string[]; sshd: boolean };
  currentlyBanned: number | null; totalBanned: number | null;
}

/** Brute-force protection for SSH: thresholds, what is never banned, current bans. */
export default function Fail2banPanel({ start, refreshKey }: { start: (operation: PendingOperation) => void; refreshKey: number }) {
  const [state, setState] = useState<Fail2banState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [maxRetry, setMaxRetry] = useState(5);
  const [findTime, setFindTime] = useState(10);
  const [banTime, setBanTime] = useState(60);
  const [ignoreLan, setIgnoreLan] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const { result } = await inspectOperation<Fail2banState>("fail2ban.inspect");
      setState(result);
      setError(null);
      if (result.config.managed) {
        setMaxRetry(result.config.maxRetry ?? 5); setFindTime(result.config.findTimeMinutes ?? 10); setBanTime(result.config.banTimeMinutes ?? 60); setIgnoreLan(result.config.ignoreLan);
      }
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Could not read fail2ban state");
    }
  }, []);
  useEffect(() => { void refresh(); }, [refresh, refreshKey]);

  const active = Boolean(state?.running && state?.configured);
  const apply = (enabled: boolean) => start({
    operationId: "fail2ban.apply",
    title: enabled ? `${active ? "Update" : "Turn on"} brute-force protection for SSH` : "Turn off brute-force protection",
    parameters: enabled ? { enabled: true, maxRetry, findTimeMinutes: findTime, banTimeMinutes: banTime, ignoreLan } : { enabled: false },
    preview: enabled
      ? <span>Bans an address for <strong>{banTime} min</strong> after <strong>{maxRetry}</strong> failed SSH logins within <strong>{findTime} min</strong>. Never bans this machine, your tailnet{ignoreLan ? ", or your LAN" : ""}, so a typo at home cannot lock you out. Writes <code>/etc/fail2ban/jail.d/boxpilot.local</code>, tests it, and starts fail2ban.</span>
      : <span>Stops and disables fail2ban and removes the managed jail file. Existing bans are lifted.</span>,
  });

  if (state && !state.installed) {
    return (
      <section className="panel" id="fail2ban">
        <header className="panel-header"><div><strong>Brute-force protection (fail2ban)</strong><span>Temporarily bans addresses that keep failing SSH logins. Matters most when SSH is reachable from outside your tailnet.</span></div>
          <button className="secondary-button" type="button" onClick={() => start({ operationId: "apt.install", title: "Install fail2ban", parameters: { packages: ["fail2ban"] }, preview: <span><code>apt-get install --no-install-recommends fail2ban</code>. Nothing is enforced until you turn it on here.</span> })}>Install fail2ban</button>
        </header>
      </section>
    );
  }

  if (!state) {
    return (
      <section className="panel" id="fail2ban">
        <header className="panel-header"><div><strong>Brute-force protection (fail2ban)</strong><span>{error ?? "Reading state..."}</span></div></header>
      </section>
    );
  }

  return (
    <section className="panel" id="fail2ban">
      <header className="panel-header">
        <div><strong>Brute-force protection (fail2ban)</strong><span>Temporarily bans addresses that keep failing SSH logins. Your tailnet and this machine are never banned.</span></div>
        <span className={`status-pill ${active ? "status-good" : "status-neutral"}`}>{state === null ? "…" : active ? `On · ${state.currentlyBanned ?? 0} banned now` : state.running ? "Running, not configured by BoxPilot" : "Off"}</span>
      </header>
      {error && <div className="auth-error" role="alert">{error}</div>}
      <div className="share-form">
        <label>Failed logins before a ban<input aria-label="Max retries" type="number" min={1} max={50} value={maxRetry} onChange={(event) => setMaxRetry(Number.parseInt(event.target.value, 10) || 1)} /></label>
        <label>…within (minutes)<input aria-label="Find time" type="number" min={1} max={1440} value={findTime} onChange={(event) => setFindTime(Number.parseInt(event.target.value, 10) || 1)} /></label>
        <label>Ban for (minutes)<input aria-label="Ban time" type="number" min={1} max={43200} value={banTime} onChange={(event) => setBanTime(Number.parseInt(event.target.value, 10) || 1)} /></label>
        <label className="cloud-vm-check share-readonly"><input type="checkbox" checked={ignoreLan} onChange={(event) => setIgnoreLan(event.target.checked)} />never ban my LAN</label>
        <div className="recovery-actions share-actions">
          <button className="primary-button" type="button" onClick={() => apply(true)}>{active ? "Apply changes" : "Turn on protection"}</button>
          {active && <button className="text-button" type="button" onClick={() => apply(false)}>Turn off protection</button>}
          {state?.totalBanned !== null && state?.totalBanned !== undefined && <span className="muted">{state.totalBanned} bans since start</span>}
        </div>
      </div>
    </section>
  );
}
