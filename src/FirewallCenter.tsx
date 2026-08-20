import { useCallback, useEffect, useState } from "react";
import { useOperation } from "./ApproveDialog";
import { inspectOperation } from "./operations";

interface FirewallRule { action?: string; protocol?: string; port?: number | null; app?: string | null; direction?: string; interface?: string | null; comment?: string | null; family?: string; raw?: string }
interface FirewallReport { installed: boolean; enabled: boolean | null; defaults: { incoming: string | null; outgoing: string | null; routed: string | null } | null; rules: FirewallRule[] }

export default function FirewallCenter({ csrfToken }: { csrfToken: string }) {
  const [report, setReport] = useState<FirewallReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [port, setPort] = useState("");
  const [protocol, setProtocol] = useState("tcp");
  const [action, setAction] = useState("allow");
  const [comment, setComment] = useState("");

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const { result } = await inspectOperation<FirewallReport>("firewall.inspect");
      setReport(result);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Could not read firewall state");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const { start, dialog } = useOperation(csrfToken, () => { setPort(""); setComment(""); void refresh(); });

  const portValue = Number.parseInt(port, 10);
  const portValid = Number.isInteger(portValue) && portValue >= 1 && portValue <= 65535;

  if (report && !report.installed) {
    return (
      <div className="firewall-center">
        {dialog}
        <section className="panel">
          <header className="panel-header"><div><strong>ufw is not installed</strong><span>Install the uncomplicated firewall to manage incoming traffic from here.</span></div>
            <button className="primary-button" type="button" onClick={() => start({ operationId: "apt.install", title: "Install ufw", parameters: { packages: ["ufw"] }, preview: <span><code>apt-get install --no-install-recommends ufw</code>. Installing does not enable it.</span> })}>Install ufw</button>
          </header>
        </section>
      </div>
    );
  }

  return (
    <div className="firewall-center">
      {dialog}
      {error && <div className="auth-error" role="alert">{error}</div>}

      <div className="metric-grid">
        <article className="panel">
          <span className="eyebrow">Firewall</span>
          <strong>{loading ? "…" : report?.enabled === null ? "Unknown" : report?.enabled ? "Enabled" : "Disabled"}</strong>
          <span>{report?.enabled ? "Incoming traffic is filtered" : "All incoming traffic is accepted"}</span>
          {report && report.enabled !== null && (
            <div className="recovery-actions">
              <button className="secondary-button" type="button" disabled={loading} onClick={() => start({
                operationId: "firewall.set",
                title: report.enabled ? "Turn the firewall off" : "Turn the firewall on",
                parameters: { enabled: !report.enabled },
                preview: report.enabled
                  ? <span><code>ufw disable</code>. All incoming traffic is accepted afterwards.</span>
                  : <span>Adds rules keeping SSH (22/tcp) and the <code>tailscale0</code> interface reachable, then <code>ufw enable</code>. Other incoming traffic follows the default policy.</span>,
              })}>{report.enabled ? "Turn off" : "Turn on"}</button>
            </div>
          )}
        </article>
        <article className="panel"><span className="eyebrow">Default incoming</span><strong>{loading ? "…" : report?.defaults?.incoming ?? "—"}</strong><span>what happens without a matching rule</span></article>
        <article className="panel"><span className="eyebrow">Rules</span><strong>{loading ? "…" : report?.rules.length ?? "—"}</strong><span>configured in ufw</span></article>
      </div>

      <section className="panel">
        <header className="panel-header"><div><strong>Rules</strong><span>Configured rules from ufw. The SSH rule cannot be deleted from here.</span></div></header>
        <div className="table-scroll">
          <table>
            <thead><tr><th>Action</th><th>Port / app</th><th>Protocol</th><th>Where</th><th>Comment</th><th aria-label="Delete" /></tr></thead>
            <tbody>
              {loading && !report ? <tr><td colSpan={6}>Reading firewall configuration...</td></tr> : null}
              {report && report.rules.length === 0 ? <tr><td colSpan={6}>No rules yet. {report.enabled ? "Only the default policy applies." : "The firewall is off."}</td></tr> : null}
              {report?.rules.map((rule, index) => (
                <tr key={index}>
                  {rule.raw ? (
                    <td colSpan={5}><code>{rule.raw}</code></td>
                  ) : (
                    <>
                      <td><span className={`status-pill ${rule.action === "allow" ? "status-good" : "status-danger"}`}>{rule.action}</span></td>
                      <td>{rule.app ?? rule.port ?? "any"}</td>
                      <td>{rule.protocol ?? "any"}</td>
                      <td>{rule.interface ? `on ${rule.interface}` : rule.direction === "out" ? "outgoing" : "incoming"}{rule.family === "v6" ? " (IPv6)" : ""}</td>
                      <td>{rule.comment ?? "—"}</td>
                    </>
                  )}
                  <td>
                    {!rule.raw && rule.port !== null && rule.port !== 22 && rule.app === null && (rule.action === "allow" || rule.action === "deny") && !rule.interface && (
                      <button className="text-button" type="button" onClick={() => start({
                        operationId: "firewall.rule.delete",
                        title: `Delete ${rule.action} ${rule.port}${rule.protocol && rule.protocol !== "any" ? `/${rule.protocol}` : ""}`,
                        parameters: { action: rule.action, port: rule.port, protocol: rule.protocol ?? "any" },
                        preview: <span><code>ufw delete {rule.action} {rule.port}{rule.protocol && rule.protocol !== "any" ? `/${rule.protocol}` : ""}</code></span>,
                      })}>Delete</button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="panel">
        <header className="panel-header"><div><strong>Add a rule</strong><span>Allow or deny a port for tcp, udp, or both.</span></div></header>
        <div className="recovery-actions">
          <select aria-label="Rule action" value={action} onChange={(event) => setAction(event.target.value)}><option value="allow">Allow</option><option value="deny">Deny</option></select>
          <input aria-label="Port" inputMode="numeric" placeholder="8096" value={port} onChange={(event) => setPort(event.target.value.trim())} />
          <select aria-label="Protocol" value={protocol} onChange={(event) => setProtocol(event.target.value)}><option value="tcp">tcp</option><option value="udp">udp</option><option value="any">tcp + udp</option></select>
          <input aria-label="Comment" placeholder="comment (optional)" value={comment} onChange={(event) => setComment(event.target.value)} />
          <button className="primary-button" type="button" disabled={!portValid} onClick={() => start({
            operationId: "firewall.rule.add",
            title: `${action === "allow" ? "Allow" : "Deny"} port ${portValue}`,
            parameters: { action, port: portValue, protocol, ...(comment.trim() ? { comment: comment.trim() } : {}) },
            preview: <span><code>ufw {action} {portValue}{protocol !== "any" ? `/${protocol}` : ""}</code></span>,
          })}>Add rule</button>
        </div>
      </section>
    </div>
  );
}
