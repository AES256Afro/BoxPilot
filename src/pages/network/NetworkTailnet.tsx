import { useEffect, useState } from "react";
import type { PendingOperation } from "../../shell/ApproveDialog";
import { relativeTime } from "../../home/format";
import { Button, Checkbox, CodeBlock, EmptyState, KeyValue, Notice, Panel, Table, Tag, mayStart, riskOf, type TableColumn } from "../../ui";
import type { Tailnet, TailnetNode, TailscaleFacts } from "./types";

/*
 * The Network page's Tailnet tab (M33.10): this server on Tailscale (connected as what, and what it
 * offers the tailnet: an exit node, the home LAN as a subnet), then every device on the tailnet,
 * who is online, and how each is reached. Offering the exit node and the subnet is one operation,
 * tailscale.set; Tailscale then waits for approval in its admin console.
 */

const osWords: Record<string, string> = { linux: "Linux", macOS: "macOS", windows: "Windows", android: "Android", iOS: "iOS", tvOS: "tvOS" };
const osLabel = (os: string | null) => (os ? osWords[os] ?? os : "unknown");

export interface NetworkTailnetProps {
  tailscale: TailscaleFacts | null;
  tailnet: Tailnet | null;
  tailnetError: boolean;
  role: string;
  start: (operation: PendingOperation) => void;
  now: number;
}

export function NetworkTailnet({ tailscale, tailnet, tailnetError, role, start, now }: NetworkTailnetProps) {
  const lan = tailscale?.lanSubnets ?? [];
  const advertised = tailscale?.advertisedRoutes ?? [];
  const approved = tailscale?.approvedRoutes ?? [];
  const pending = advertised.filter((route) => !approved.includes(route));
  const offeredExit = Boolean(tailscale?.exitNodeAdvertised);
  const offeredSubnet = advertised.length > 0;
  // What the owner has ticked, over what is offered now; a new read of what is offered starts over.
  const [exitDraft, setExitNode] = useState<boolean | null>(null);
  const [subnetDraft, setSubnetRouter] = useState<boolean | null>(null);
  useEffect(() => { setExitNode(null); setSubnetRouter(null); }, [offeredExit, offeredSubnet]);
  const exitNode = exitDraft ?? offeredExit;
  const subnetRouter = subnetDraft ?? offeredSubnet;
  const dirty = exitNode !== offeredExit || subnetRouter !== offeredSubnet;
  const canSet = mayStart(role, "tailscale.set");
  const nodes = tailnet ? [...(tailnet.self ? [tailnet.self] : []), ...tailnet.peers] : [];
  const online = nodes.filter((node) => node.online).length;

  const apply = () => start({
    operationId: "tailscale.set",
    title: `${exitNode ? "Offer" : "Withdraw"} exit node, ${subnetRouter ? "share" : "stop sharing"} the LAN`,
    parameters: { exitNode, subnetRouter },
    preview: <span>{exitNode || subnetRouter ? <>Turns on IP forwarding (persisted in <code>/etc/sysctl.d</code>) and runs </> : "Runs "}<code>tailscale set --advertise-exit-node={String(exitNode)} --advertise-routes={subnetRouter ? lan.join(",") : ""}</code>. {exitNode || subnetRouter ? "Tailscale only offers these until you approve them: open the admin console, find this machine, and enable the exit node or routes." : "Nothing is offered to the tailnet any more."}</span>,
  });

  const connection = (node: TailnetNode) => {
    if (node.isSelf) return <span className="network-dim">—</span>;
    if (node.online) return node.direct ? "Direct" : node.relay ? `Via relay (${node.relay})` : "Via relay";
    const seen = relativeTime(node.lastSeen, now);
    return <span className="network-dim">{seen ? `last seen ${seen}` : "offline"}</span>;
  };

  const columns: Array<TableColumn<TailnetNode>> = [
    {
      id: "device", header: "Device", sortValue: (node) => `${node.isSelf ? 0 : 1}${node.name}`, cell: (node) => (
        <span className="network-node">
          <span className="network-strong">{node.name}</span>
          {node.isSelf && <Tag tone="accent">this server</Tag>}
        </span>
      ),
    },
    { id: "address", header: "Address", sortValue: (node) => node.address, cell: (node) => (node.address ? <code>{node.address}</code> : <span className="network-dim">—</span>) },
    { id: "system", header: "System", hideOnPhone: true, sortValue: (node) => osLabel(node.os), cell: (node) => osLabel(node.os) },
    { id: "connection", header: "Connection", sortValue: (node) => (node.isSelf ? 0 : node.online ? 1 : 2), cell: connection },
    {
      id: "roles", header: "Roles", cell: (node) => (
        <span className="network-tags">
          {node.exitNode && <Tag>exit node</Tag>}
          {node.subnetRoutes.length > 0 && <Tag title={node.subnetRoutes.join(", ")}>subnet {node.subnetRoutes.join(", ")}</Tag>}
          {!node.exitNode && node.subnetRoutes.length === 0 && <span className="network-dim">—</span>}
        </span>
      ),
    },
  ];

  return (
    <>
      <Panel
        padded
        className="network-tailscale"
        title="Tailscale"
        count={tailscale ? { status: tailscale.connected ? "good" : "neutral", label: tailscale.connected ? "connected" : "not connected" } : undefined}
        meta={tailscale?.connected ? (tailscale.dnsName ?? tailscale.address ?? undefined) : undefined}
      >
        {!tailscale ? <p className="network-dim">Reading…</p> : !tailscale.connected ? (
          // This page said "the setup checklist on Ops starts it", and that checklist's Open came back
          // here: a loop with no way to join. BoxPilot has no join of its own yet, so say how.
          <Notice tone="info" title="Not on a tailnet">
            <p>Joining one is how this page, your apps and your shares reach your phone and laptop away from home, with nothing opened on your router.</p>
            <p>To join, run this on the server (over SSH, or at its keyboard) and open the link it prints to sign in to Tailscale. The first line installs Tailscale; skip it if it is already installed. This page shows the tailnet once it has joined.</p>
            <CodeBlock label="Join a tailnet">{"curl -fsSL https://tailscale.com/install.sh | sh\nsudo tailscale up"}</CodeBlock>
          </Notice>
        ) : (
          <KeyValue layout="columns" items={[
            { id: "name", label: "Name", value: tailscale.dnsName ?? "—", mono: true },
            { id: "address", label: "Address", value: tailscale.address ?? "—", mono: true },
            { id: "exit", label: "Exit node", value: tailscale.exitNodeAdvertised ? "Offered" : "Not offered" },
            { id: "routes", label: "Routes offered", value: advertised.length ? advertised.join(", ") : "None", mono: true, status: pending.length ? "warning" : advertised.length ? "good" : undefined, hint: advertised.length ? (pending.length ? `waiting for approval: ${pending.join(", ")}` : "approved") : undefined },
          ]} />
        )}
        {tailscale && canSet && (
          <form className="network-tailscale__form" onSubmit={(event) => { event.preventDefault(); if (dirty && tailscale.connected) apply(); }}>
            <Checkbox
              label="Use this server as an exit node"
              description="Route all of a device's internet traffic through your home connection when you are away: hotel Wi-Fi, services locked to your country."
              checked={exitNode}
              disabled={!tailscale.connected}
              onChange={setExitNode}
            />
            <Checkbox
              label="Share my home network with my tailnet (subnet router)"
              description={lan.length ? <>Reach every device on <code>{lan.join(", ")}</code> (the NAS, the printer, the TV) from your devices anywhere, without installing Tailscale on them.</> : "No LAN subnet was found to share."}
              checked={subnetRouter}
              disabled={!tailscale.connected || lan.length === 0}
              onChange={setSubnetRouter}
            />
            <div className="network-tailscale__actions">
              <Button type="submit" variant="primary" risk={riskOf("tailscale.set")} disabled={!dirty || !tailscale.connected}>Apply</Button>
              {(tailscale.exitNodeAdvertised || advertised.length > 0) && <a className="network-link" href="https://login.tailscale.com/admin/machines" target="_blank" rel="noreferrer">Approve in the Tailscale admin console</a>}
            </div>
          </form>
        )}
      </Panel>

      <Panel
        className="network-tailnet"
        title="Devices on your tailnet"
        count={tailnet?.available ? { status: online > 0 ? "good" : "neutral", label: `${online} of ${nodes.length} online` } : undefined}
        meta={tailnet?.available ? "new devices appear as they join" : undefined}
      >
        {tailnetError ? <EmptyState title="The tailnet could not be read" />
          : !tailnet ? <p className="network-dim network-pad">Reading…</p>
            : !tailnet.available ? <EmptyState title="Tailscale is not on this server">Its devices show here once this server joins a tailnet.</EmptyState>
              : (
                <Table
                  caption="Every device on your tailnet"
                  columns={columns}
                  rows={nodes}
                  rowKey={(node) => node.name + (node.address ?? "")}
                  rowStatus={(node) => (node.online ? "good" : "neutral")}
                  defaultSort={{ column: "connection", direction: "ascending" }}
                  empty="Nothing on the tailnet yet."
                />
              )}
      </Panel>
    </>
  );
}
