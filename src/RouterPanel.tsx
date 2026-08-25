import { useCallback, useEffect, useState } from "react";
import { inspectOperation } from "./operations";
import type { PendingOperation } from "./ApproveDialog";

/**
 * The router as a source of truth about the network: what it has handed addresses to, and what it
 * calls those devices. Reading only — writing to a router can take a house off the internet, and
 * that path is not offered until it has been exercised against a real device.
 */
interface Report {
  configured: boolean;
  reachable: boolean;
  host: string | null;
  username: string | null;
  model?: string | null;
  firmware?: string | null;
  reason: string | null;
}
interface Lease { name: string | null; address: string; mac: string | null; online: boolean; reserved: boolean }

export default function RouterPanel({ start, gateway }: { start: (operation: PendingOperation) => void; gateway: string | null }) {
  const [report, setReport] = useState<Report | null>(null);
  const [leases, setLeases] = useState<Lease[] | null>(null);
  const [host, setHost] = useState("");
  // The router's own login page asks for a password and nothing else, so this one does too. The
  // account is root; the field is there for a router that genuinely asks for a different one.
  const [username, setUsername] = useState("");
  const [namedAccount, setNamedAccount] = useState(false);
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const { result } = await inspectOperation<Report>("router.inspect");
      setReport(result);
      if (result.reachable) {
        const listed = await inspectOperation<{ leases: Lease[] }>("router.leases").catch(() => null);
        setLeases(listed?.result.leases ?? null);
      }
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Could not read the router connection");
    }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => { if (gateway && !host) setHost(gateway); }, [gateway, host]);

  if (!report) return null;
  // An empty box still means root. Opening the field must not become a new way to be stuck.
  const namedAccountOk = !username.trim() || /^[A-Za-z0-9._-]{1,64}$/.test(username.trim());
  const ready = /^[A-Za-z0-9]([A-Za-z0-9.-]{0,252}[A-Za-z0-9])?$/.test(host.trim()) && password.length > 0 && namedAccountOk;

  return (
    <section className="panel">
      <header className="panel-header">
        <div>
          <strong>Your router</strong>
          <span>Reads the devices your router has given addresses to, and the names it knows them by. GL.iNet firmware 4 for now; nothing on the router is changed.</span>
        </div>
      </header>

      {error && <div className="auth-error" role="alert">{error}</div>}

      {report.configured && report.reachable ? (
        <>
          <p className="muted">
            Connected to <code>{report.host}</code> as <code>{report.username}</code>
            {report.model ? <> — {report.model}{report.firmware ? ` on ${report.firmware}` : ""}</> : null}.
          </p>
          {leases === null ? <p className="muted">Reading the device list…</p> : leases.length === 0 ? <p className="muted">The router reported no devices.</p> : (
            <table className="perf-table">
              <thead><tr><th>Device</th><th>Address</th><th>MAC</th><th>Address is</th></tr></thead>
              <tbody>
                {leases.map((lease) => (
                  <tr key={`${lease.address}-${lease.mac ?? ""}`}>
                    <td>{lease.name ?? <span className="muted">unnamed</span>}{lease.online ? null : <span className="status-pill status-neutral perf-ai">offline</span>}</td>
                    <td><code>{lease.address}</code></td>
                    <td className="muted">{lease.mac ?? "—"}</td>
                    <td>{lease.reserved ? <span className="status-pill status-good">reserved</span> : <span className="status-pill status-neutral">from the pool</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      ) : (
        <>
          {report.configured && !report.reachable && (
            <p className="auth-error" role="alert">Connected to <code>{report.host}</code> before, but it is not answering now: {report.reason}</p>
          )}
          <form className="share-form" onSubmit={(event) => {
            event.preventDefault();
            if (!ready) return;
            start({
              operationId: "router.connect",
              title: `Connect to the router at ${host.trim()}`,
              parameters: { kind: "glinet", host: host.trim(), ...(namedAccount && username.trim() ? { username: username.trim() } : {}), password },
              preview: <span>Signs in once to check the password, then stores it on this server readable only by root, and records the certificate the router presented so a different one is refused later. Nothing on the router is changed.</span>,
            });
            setPassword("");
          }}>
            <label>Router address<input aria-label="Router address" placeholder="192.168.1.1" value={host} onChange={(event) => setHost(event.target.value)} /></label>
            <label>Router password<input aria-label="Router password" type="password" autoComplete="new-password" value={password} onChange={(event) => setPassword(event.target.value)} /></label>
            {namedAccount ? (
              <label>Username<input aria-label="Router username" autoFocus placeholder="root — leave blank unless the router asked for one" value={username} onChange={(event) => setUsername(event.target.value)} /></label>
            ) : (
              <button type="button" className="link-button" onClick={() => setNamedAccount(true)}>This router asks for a username too</button>
            )}
            <div className="recovery-actions share-actions">
              <button className="primary-button" type="submit" disabled={!ready}>Connect</button>
              {!ready && <span className="muted">{!host.trim() ? "Enter the router's address." : !password ? "Enter the router's admin password." : "That username has a character the router will not accept."}</span>}
            </div>
          </form>
          <p className="muted">The same password you use on the router's own admin page. It is stored on this server readable only by root, and sent to nothing but the router.</p>
        </>
      )}
    </section>
  );
}
