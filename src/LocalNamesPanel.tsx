import { useCallback, useEffect, useState } from "react";
import { inspectOperation } from "./operations";
import type { PendingOperation } from "./ApproveDialog";

/**
 * Local names for the apps on this server, served by the DNS server already running here.
 *
 * A name resolves to an address, and every app here shares one — so the port is still part of the
 * address unless a reverse proxy is doing the routing. Saying that plainly is better than a page
 * that implies `jellyfin.lan` will just work and leaves the owner wondering why it does not.
 */
interface Report {
  available: boolean;
  reason: string | null;
  platform: { id: string; label: string; running: boolean } | null;
  file?: string;
  records: Array<{ address: string; name: string }>;
  apps: Array<{ id: string; name: string; port: number }>;
}

const domains = ["lan", "home.arpa", "internal"];

export default function LocalNamesPanel({ csrfToken, start, lanAddress }: { csrfToken: string; start: (operation: PendingOperation) => void; lanAddress: string | null }) {
  const [report, setReport] = useState<Report | null>(null);
  const [domain, setDomain] = useState("lan");

  const refresh = useCallback(async () => {
    try {
      const { result } = await inspectOperation<Report>("dns.names.inspect");
      setReport(result);
    } catch {
      setReport(null);
    }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);
  void csrfToken;

  if (!report) return null;

  const preview = (report.apps ?? []).map((app) => ({ ...app, name: `${app.id}.${domain}` }));
  const inForce = new Set((report.records ?? []).map((record) => record.name));

  return (
    <section className="panel">
      <header className="panel-header">
        <div>
          <strong>Local names for your apps</strong>
          <span>Reach them as <code>jellyfin.{domain}</code> instead of an address to remember. Served by the DNS server on this box; records you added yourself are in a different file and are never touched.</span>
        </div>
        {report.available && lanAddress && (
          <button className="primary-button" type="button" onClick={() => start({
            operationId: "dns.names.apply",
            title: `Name ${preview.length} app${preview.length === 1 ? "" : "s"} under .${domain}`,
            parameters: { address: lanAddress, domain },
            preview: <span>Writes one record per installed app pointing at <code>{lanAddress}</code>, into a file only BoxPilot manages. Devices pick the names up as soon as they use this server for DNS.</span>,
          })}>{inForce.size ? "Update names" : "Give apps names"}</button>
        )}
      </header>

      {!report.available ? <p className="muted">{report.reason}</p> : !lanAddress ? (
        <p className="muted">This server&apos;s LAN address could not be read, and a name has to point somewhere.</p>
      ) : (
        <>
          <div className="recovery-actions">
            <label>Domain
              <select aria-label="Local domain" value={domain} onChange={(event) => setDomain(event.target.value)}>
                {domains.map((option) => <option key={option} value={option}>.{option}</option>)}
              </select>
            </label>
            {inForce.size > 0 && (
              <button className="text-button danger-text" type="button" onClick={() => start({
                operationId: "dns.names.clear", title: "Remove the local names", parameters: {},
                preview: <span>Deletes the {inForce.size} name{inForce.size === 1 ? "" : "s"} BoxPilot wrote. Anything you added by hand stays.</span>,
              })}>Remove them</button>
            )}
          </div>
          {preview.length === 0 ? <p className="muted">No installed app has a page to open yet.</p> : (
            <table className="perf-table">
              <thead><tr><th>Name</th><th>Opens</th><th>In DNS now</th></tr></thead>
              <tbody>
                {preview.map((app) => (
                  <tr key={app.id}>
                    <td><code>{app.name}</code></td>
                    <td className="muted">{app.name}:{app.port}</td>
                    <td>{inForce.has(app.name) ? <span className="status-pill status-good">yes</span> : <span className="status-pill status-neutral">not yet</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <p className="muted">
            A name points at this server, so the port is still needed: <code>jellyfin.{domain}:8096</code>. Put a reverse proxy in front if you want the name on its own.
            Only devices using this server for DNS see them; that is the router setting on the Network page above.
          </p>
        </>
      )}
    </section>
  );
}
