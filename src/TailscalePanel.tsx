import { useEffect, useState } from "react";
import type { PendingOperation } from "./ApproveDialog";

export interface TailscaleInfo {
  connected: boolean; dnsName: string | null;
  address?: string | null; exitNodeAdvertised?: boolean | null; advertisedRoutes?: string[]; approvedRoutes?: string[]; lanSubnets?: string[];
}

/** Exit node and subnet router toggles; both are offered to the tailnet and approved in the admin console. */
export default function TailscalePanel({ start, tailscale }: { start: (operation: PendingOperation) => void; tailscale: TailscaleInfo | null }) {
  const [exitNode, setExitNode] = useState(false);
  const [subnetRouter, setSubnetRouter] = useState(false);
  useEffect(() => {
    setExitNode(Boolean(tailscale?.exitNodeAdvertised));
    setSubnetRouter(Boolean(tailscale?.advertisedRoutes?.length));
  }, [tailscale?.exitNodeAdvertised, tailscale?.advertisedRoutes]);
  if (!tailscale) return null;
  const lan = tailscale.lanSubnets ?? [];
  const dirty = exitNode !== Boolean(tailscale.exitNodeAdvertised) || subnetRouter !== Boolean(tailscale.advertisedRoutes?.length);
  const approved = tailscale.approvedRoutes ?? [];
  const pending = (tailscale.advertisedRoutes ?? []).filter((route) => !approved.includes(route));

  return (
    <section className="panel" id="tailscale">
      <header className="panel-header">
        <div><strong>Tailscale</strong><span>{tailscale.connected
          ? <>Connected as <code>{tailscale.dnsName ?? tailscale.address ?? "this server"}</code>{tailscale.address ? <> ({tailscale.address})</> : null}. Apps get HTTPS on the tailnet with each card's Serve button; the options below give the whole tailnet more.</>
          : <>Not connected to a tailnet. Joining one is how this page, your apps and your shares reach you from your phone and laptop away from home, with nothing opened on your router. The <strong>Set up your server</strong> checklist on the Overview page starts it.</>}</span></div>
        <span className={`status-pill ${tailscale.connected ? "status-good" : "status-neutral"}`}>{tailscale.connected ? "Connected" : "Offline"}</span>
      </header>
      <div className="samba-scope">
        <label><input type="checkbox" checked={exitNode} disabled={!tailscale.connected} onChange={(event) => setExitNode(event.target.checked)} /> <strong>Use this server as an exit node</strong> <span className="muted">route all of a device's internet traffic through your home connection when you are away (hotel Wi-Fi, geo-locked services)</span></label>
        <label><input type="checkbox" checked={subnetRouter} disabled={!tailscale.connected || lan.length === 0} onChange={(event) => setSubnetRouter(event.target.checked)} /> <strong>Share my home network with my tailnet (subnet router)</strong> <span className="muted">{lan.length ? <>reach every device on <code>{lan.join(", ")}</code>. The NAS, printer, TV, from your devices anywhere, without installing Tailscale on them</> : "no LAN subnet detected"}</span></label>
      </div>
      <div className="recovery-actions samba-apply">
        <button className="primary-button" type="button" disabled={!dirty || !tailscale.connected} onClick={() => start({
          operationId: "tailscale.set",
          title: `${exitNode ? "Offer" : "Withdraw"} exit node, ${subnetRouter ? "share" : "stop sharing"} the LAN`,
          parameters: { exitNode, subnetRouter },
          preview: <span>{exitNode || subnetRouter ? <>Turns on IP forwarding (persisted in <code>/etc/sysctl.d</code>) and runs </> : "Runs "}<code>tailscale set --advertise-exit-node={String(exitNode)} --advertise-routes={subnetRouter ? lan.join(",") : ""}</code>. {exitNode || subnetRouter ? "Tailscale only offers these until you approve them: open the admin console, find this machine, and enable the exit node or routes." : "Nothing is offered to the tailnet any more."}</span>,
        })}>Apply</button>
        {(Boolean(tailscale.exitNodeAdvertised) || Boolean(tailscale.advertisedRoutes?.length)) && (
          <span className="muted">
            {tailscale.exitNodeAdvertised ? "Exit node offered. " : ""}
            {tailscale.advertisedRoutes?.length ? `Routes offered: ${tailscale.advertisedRoutes.join(", ")}${pending.length ? ` (waiting for approval: ${pending.join(", ")})` : " (approved)"}. ` : ""}
            <a href="https://login.tailscale.com/admin/machines" target="_blank" rel="noreferrer">Approve in the Tailscale admin console</a>
          </span>
        )}
      </div>
    </section>
  );
}
