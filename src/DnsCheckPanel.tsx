import { useState } from "react";

/**
 * Whether the DNS blocker on this server is actually being used, rather than merely installed.
 *
 * Installing it is the easy half. What goes wrong is everything after: port 53 has to be open to
 * the network, the container has to answer on the LAN address rather than only on loopback, the
 * blocklists have to have loaded, and the lookups it forwards have to come back. Any one of those
 * left undone leaves a blocker that looks healthy on its own page and blocks nothing for anybody,
 * or worse, one that would take the whole house offline the moment the router points at it.
 */
interface Clients {
  available: boolean;
  reason: string | null;
  platform: { id: string; label: string; running: boolean } | null;
  clients: Array<{ address: string; queries: number }>;
  self: number;
}

interface Report {
  address: string;
  answering: boolean;
  resolving: boolean;
  blocking: boolean;
  intercepted: boolean | null;
  interceptorBlocking: boolean | null;
  control: { domain: string; addresses: string[]; error: string | null };
  probe: { domain: string; addresses: string[]; error: string | null };
  reason: string | null;
}

const verdict = (ok: boolean, good: string, bad: string) =>
  <span className={`status-pill ${ok ? "status-good" : "status-warning"}`}>{ok ? good : bad}</span>;

export default function DnsCheckPanel({ csrfToken, lanAddress }: { csrfToken: string; lanAddress: string | null }) {
  const [report, setReport] = useState<Report | null>(null);
  const [users, setUsers] = useState<Clients | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const check = async () => {
    if (!lanAddress) return;
    setBusy(true); setError(null); setReport(null); setUsers(null);
    try {
      const response = await fetch("/api/v1/operations/dns.blocker.verify/run", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-BoxPilot-CSRF": csrfToken },
        body: JSON.stringify({ parameters: { address: lanAddress } }),
      });
      const body = (await response.json()) as { result?: Report; error?: string };
      if (!response.ok || !body.result) throw new Error(body.error ?? "The check could not run");
      setReport(body.result);
      // Who has asked it is a separate question from whether it works, and the more useful one: a
      // blocker can be healthy and answering and used by nobody, because the router hands out a
      // different address. It is fetched second so a failure here cannot lose the check itself.
      try {
        const asked = await fetch("/api/v1/operations/dns.blocker.clients/run", {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-BoxPilot-CSRF": csrfToken },
          body: JSON.stringify({ parameters: { selfAddress: lanAddress } }),
        });
        const found = (await asked.json()) as { result?: Clients };
        if (asked.ok && found.result) setUsers(found.result);
      } catch { /* the check above still stands on its own */ }
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "The check could not run");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="panel">
      <header className="panel-header">
        <div>
          <strong>Is your DNS blocker working?</strong>
          <span>Sends two ordinary lookups to <code>{lanAddress ?? "this server"}</code>, the way a laptop on your network would. Worth running before you point your router at it, because a blocker that cannot resolve takes every device offline with it. Nothing is changed.</span>
        </div>
        <button className="secondary-button" type="button" disabled={busy || !lanAddress} onClick={() => void check()}>{busy ? "Checking…" : "Check"}</button>
      </header>

      {!lanAddress && <p className="muted">This server has no LAN address to be reached on.</p>}
      {error && <div className="auth-error" role="alert">{error}</div>}

      {report && (
        <>
          <div className="samba-scope">
            <div>{verdict(report.answering, "answering", "nothing answered")} <span className="muted">something is listening on port 53 at that address</span></div>
            <div>{verdict(report.resolving, "resolving", "cannot resolve")} <span className="muted">it looked up <code>{report.control.domain}</code>{report.control.error ? <> and got <code>{report.control.error}</code></> : null}</span></div>
            <div>{verdict(report.blocking, "blocking", "not blocking")} <span className="muted">it refused <code>{report.probe.domain}</code>, which every mainstream blocklist carries</span></div>
            {report.intercepted && (
              <div>
                {report.interceptorBlocking
                  ? <><span className="status-pill status-neutral">DNS is handled elsewhere</span> <span className="muted">something upstream answers every query and blocks ads itself, so this blocker is idle</span></>
                  : <><span className="status-pill status-warning">DNS is being intercepted</span> <span className="muted">something upstream answers queries sent to addresses that cannot run a resolver</span></>}
              </div>
            )}
          </div>
          {users && (
            <div className="samba-scope">
              {!users.available
                ? <div><span className="status-pill status-neutral">not known</span> <span className="muted">{users.reason}</span></div>
                : users.clients.length === 0
                ? <div>
                    <span className="status-pill status-warning">nothing is using it</span>
                    <span className="muted"> no device on your network has asked it anything{users.self > 0 ? `, only this server's own checks (${users.self})` : ""}. Point your router's DHCP at <code>{report.address}</code>, then renew a device's lease.</span>
                  </div>
                : <div>
                    <span className="status-pill status-good">{users.clients.length} {users.clients.length === 1 ? "device" : "devices"} using it</span>
                    <span className="muted"> {users.clients.slice(0, 6).map((client) => `${client.address} (${client.queries})`).join(", ")}{users.clients.length > 6 ? `, and ${users.clients.length - 6} more` : ""}</span>
                  </div>}
            </div>
          )}
          {!report.reason
            ? <p className="muted">Answering, resolving and blocking. Devices pointed at <code>{report.address}</code> will use it.</p>
            : report.intercepted && report.interceptorBlocking
            ? <p className="muted">{report.reason}</p>
            : <p className="auth-error" role="alert">{report.reason}</p>}
        </>
      )}
    </section>
  );
}
