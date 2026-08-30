import { useEffect, useState } from "react";

interface TailnetNode {
  name: string; dnsName: string | null; address: string | null; os: string | null;
  online: boolean; lastSeen: string | null; exitNode: boolean; subnetRoutes: string[];
  direct: boolean | null; relay: string | null; isSelf: boolean;
}
interface Tailnet { available: boolean; connected: boolean; self: TailnetNode | null; peers: TailnetNode[] }

const osLabel = (os: string | null) => {
  const map: Record<string, string> = { linux: "Linux", macOS: "macOS", windows: "Windows", android: "Android", iOS: "iOS", tvOS: "tvOS" };
  return os ? map[os] ?? os : "unknown";
};

const agoLabel = (iso: string | null) => {
  if (!iso) return null;
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms) || ms < 0) return null;
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes || 1} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.round(hours / 24)} days ago`;
};

/**
 * Every device on the owner's tailnet (M24.1), shown the way the LAN device list is: who is online,
 * their tailnet address, and the roles that matter (exit node, subnet router, direct or relayed).
 * New devices appear here as they join, with nothing to configure in BoxPilot.
 */
export default function TailnetPanel() {
  const [tailnet, setTailnet] = useState<Tailnet | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    fetch("/api/v1/network/tailnet")
      .then((response) => (response.ok ? response.json() : null))
      .then((body: Tailnet | null) => (body ? setTailnet(body) : setError(true)))
      .catch(() => setError(true));
  }, []);

  if (error || (tailnet && !tailnet.available)) return null; // no tailscale on this box: the Tailscale panel already says so
  const nodes = tailnet ? [...(tailnet.self ? [tailnet.self] : []), ...tailnet.peers] : [];
  const online = nodes.filter((node) => node.online).length;

  return (
    <section className="panel">
      <header className="panel-header">
        <div><strong>Devices on your tailnet</strong><span>Every machine signed into your Tailscale network. New devices show up here as you add them.</span></div>
        <span className={`status-pill ${online > 0 ? "status-good" : "status-neutral"}`}>{tailnet === null ? "…" : `${online} of ${nodes.length} online`}</span>
      </header>
      {tailnet === null ? <p className="muted">Reading…</p> : (
        <div className="table-scroll">
          <table>
            <thead><tr><th>Device</th><th>Address</th><th>System</th><th>Connection</th><th>Roles</th></tr></thead>
            <tbody>
              {nodes.map((node) => (
                <tr key={node.name + (node.address ?? "")}>
                  <td>
                    <span className={`watch-dot ${node.online ? "watch-dot-clear" : "watch-dot-off"}`} aria-hidden="true" />{" "}
                    <strong>{node.name}</strong>
                    {node.isSelf && <span className="status-pill status-neutral tailnet-self">this server</span>}
                  </td>
                  <td>{node.address ? <code>{node.address}</code> : <span className="muted">—</span>}</td>
                  <td>{osLabel(node.os)}</td>
                  <td>
                    {node.isSelf ? <span className="muted">—</span>
                      : node.online ? (node.direct ? "Direct" : node.relay ? `Via relay (${node.relay})` : "Via relay")
                        : <span className="muted">{agoLabel(node.lastSeen) ? `last seen ${agoLabel(node.lastSeen)}` : "offline"}</span>}
                  </td>
                  <td>
                    {node.exitNode && <span className="chip">exit node</span>}
                    {node.subnetRoutes.length > 0 && <span className="chip" title={node.subnetRoutes.join(", ")}>subnet router · {node.subnetRoutes.join(", ")}</span>}
                    {!node.exitNode && node.subnetRoutes.length === 0 && <span className="muted">—</span>}
                  </td>
                </tr>
              ))}
              {nodes.length === 0 && <tr><td colSpan={5} className="muted">Nothing on the tailnet yet.</td></tr>}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
