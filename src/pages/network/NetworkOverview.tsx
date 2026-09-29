import { useState } from "react";
import type { PendingOperation } from "../../ApproveDialog";
import { Button, EmptyState, KeyValue, Panel, Sheet, StatusChip, Table, mayStart, riskOf, type TableColumn } from "../../ui";
import { CopyValue, LinkButton } from "./parts";
import type { NetworkCapability, Reachability, ReachWay, TlsCapability, Topology } from "./types";

/*
 * The Network page's first tab (M33.10): how to reach BoxPilot (every address it answers on, the
 * LAN switch and HTTPS on the LAN), then the devices this server can see on the LAN, each with
 * Wake-on-LAN. What the certificate is and how to trust it opens in a sheet rather than sitting
 * above the facts.
 */

type Device = NonNullable<Topology["devices"]>[number];

export interface NetworkOverviewProps {
  topology: Topology | null;
  networkCap: NetworkCapability | null;
  tlsCap: TlsCapability | null;
  reach: Reachability | null;
  role: string;
  start: (operation: PendingOperation) => void;
}

/** How to trust BoxPilot's own certificate authority on each kind of device. */
const trustSteps = [
  { id: "windows", label: "Windows", value: <>Double-click the file, Install Certificate, Local Machine, &ldquo;Place all certificates in the following store&rdquo;, Browse, <em>Trusted Root Certification Authorities</em>. Restart the browser.</> },
  { id: "macos", label: "macOS", value: <>Double-click to open Keychain Access, add it to the <em>System</em> keychain, then open it there and set &ldquo;When using this certificate&rdquo; to <em>Always Trust</em>.</> },
  { id: "ios", label: "iPhone, iPad", value: <>Open the file to install the profile, then turn it on in Settings, General, About, Certificate Trust Settings.</> },
  { id: "android", label: "Android", value: <>Settings, Security, &ldquo;Install a certificate&rdquo;, CA certificate.</> },
  { id: "firefox", label: "Firefox", value: <>Keeps its own store: Settings, Privacy &amp; Security, Certificates, View Certificates, Authorities, Import.</> },
];

export function NetworkOverview({ topology, networkCap, tlsCap, reach, role, start }: NetworkOverviewProps) {
  const [trusting, setTrusting] = useState(false);
  const lanAddress = topology?.eligibleLanAddresses[0]?.address ?? null;
  const ways = reach?.ways ?? [];
  const untrusted = ways.some((way) => way.encrypted && !way.trusted);
  const devices = topology?.devices ?? [];
  const canWake = mayStart(role, "network.wake");
  const canLan = mayStart(role, "system.web.lan.set");
  const canTls = mayStart(role, "system.web.tls.provision");

  const wayColumns: Array<TableColumn<ReachWay>> = [
    { id: "url", header: "Address", cell: (way) => <a className="network-url" href={way.url} target="_blank" rel="noreferrer"><code>{way.url}</code></a> },
    { id: "from", header: "From", cell: (way) => <span className="network-two"><span>{way.label}</span><span className="network-dim">{way.scope}</span></span> },
    {
      id: "connection", header: "Connection", cell: (way) => (
        <span className="network-tags">
          <StatusChip status={way.encrypted ? "good" : "neutral"}>{way.encrypted ? "encrypted" : "not encrypted"}</StatusChip>
          {way.encrypted && !way.trusted && <StatusChip status="warning">install certificate</StatusChip>}
        </span>
      ),
    },
    { id: "copy", header: <span className="ui-visually-hidden">Copy</span>, label: "Copy", className: "network-actions-cell", cell: (way) => <span className="network-actions"><CopyValue value={way.url} label={`Copy ${way.url}`} /></span> },
  ];

  const deviceColumns: Array<TableColumn<Device>> = [
    { id: "address", header: "Address", sortValue: (device) => device.address, cell: (device) => <code className="network-strong">{device.address}</code> },
    { id: "mac", header: "MAC", sortValue: (device) => device.mac, cell: (device) => <code>{device.mac}</code> },
    { id: "interface", header: "Interface", hideOnPhone: true, cell: (device) => (device.interface ? <code>{device.interface}</code> : "—") },
    { id: "state", header: "State", sortValue: (device) => (device.state === "REACHABLE" ? 0 : 1), cell: (device) => <StatusChip status={device.state === "REACHABLE" ? "good" : "neutral"}>{device.state.toLowerCase()}</StatusChip> },
    {
      id: "wake", header: <span className="ui-visually-hidden">Actions</span>, label: "Actions", className: "network-actions-cell", cell: (device) => (
        <span className="network-actions">
          {canWake && <Button risk={riskOf("network.wake")} aria-label={`Wake ${device.address}`} onClick={() => start({ operationId: "network.wake", title: `Wake ${device.address}`, parameters: { mac: device.mac }, preview: <span>Broadcasts Wake-on-LAN magic packets for <code>{device.mac}</code> on this server&apos;s network. Nothing is read back. The device either wakes or it does not.</span> })}>Wake</Button>}
        </span>
      ),
    },
  ];

  // HTTPS on the LAN: the names the certificate is issued for, as the Classic page chose them.
  const hostLabel = (topology?.tailscale.dnsName?.split(".")[0] ?? "boxpilot").toLowerCase();
  const names = Array.from(new Set([hostLabel, `${hostLabel}.lan`, "boxpilot.lan"]));
  const ipAddresses = lanAddress ? [lanAddress] : [];
  const reachName = tlsCap?.provisioned ? (tlsCap.names?.find((name) => name.endsWith(".lan")) ?? tlsCap.ipAddresses?.[0] ?? lanAddress) : (lanAddress ?? "boxpilot.lan");
  const covers = [...(tlsCap?.names ?? []), ...(tlsCap?.ipAddresses ?? [])];
  const provision = (reissue: boolean) => start({
    operationId: "system.web.tls.provision",
    title: reissue ? "Reissue the HTTPS certificate" : "Set up HTTPS on your local network",
    parameters: { names, ipAddresses },
    preview: reissue
      ? <span>Issues a fresh certificate for <code>{names.join(", ")}</code>{ipAddresses.length ? <> and <code>{ipAddresses.join(", ")}</code></> : null} from the same authority, so devices that trust it stay trusting. BoxPilot restarts a few seconds after you approve.</span>
      : <span>Creates a BoxPilot certificate authority on this server and issues a certificate for <code>{names.join(", ")}</code>{ipAddresses.length ? <> and <code>{ipAddresses.join(", ")}</code></> : null}, then serves HTTPS on port 8443 and opens it on the firewall. You then install the certificate on your devices once. BoxPilot restarts a few seconds after you approve.</span>,
  });

  return (
    <>
      <Panel
        className="network-reach"
        title="Reach BoxPilot"
        count={reach ? ways.length : undefined}
        meta={reach ? (reach.servePublished ? "published on the tailnet" : "not published on the tailnet") : undefined}
        actions={untrusted ? <Button variant="ghost" onClick={() => setTrusting(true)}>Trust the certificate…</Button> : undefined}
        footer={reach && !reach.servePublished ? <>Publish it on your tailnet with <code>tailscale serve --bg http://127.0.0.1:{networkCap?.port ?? 8787}</code> to reach it from anywhere over HTTPS.</> : undefined}
      >
        <Table caption="Addresses BoxPilot answers on" columns={wayColumns} rows={ways} rowKey={(way) => way.id} empty={reach ? "BoxPilot reported no address to reach it on." : "Reading…"} />
      </Panel>

      <div className="network-pair">
        {networkCap?.canSet && (
          <Panel
            padded
            className="network-lan"
            title="LAN access"
            count={{ status: !networkCap.lan ? "neutral" : tlsCap?.provisioned ? "good" : "warning", label: networkCap.lan ? (tlsCap?.provisioned ? "on" : "on, plain HTTP") : "off" }}
            actions={canLan ? (
              <Button variant={networkCap.lan ? "secondary" : "primary"} risk={riskOf("system.web.lan.set")} onClick={() => start({
                operationId: "system.web.lan.set",
                title: networkCap.lan ? "Stop serving BoxPilot on the LAN" : "Reach BoxPilot on your local network",
                parameters: { enabled: !networkCap.lan },
                preview: <span>{networkCap.lan ? <>Returns BoxPilot to Tailscale-and-loopback only and closes the web port on the firewall.</> : <>Also serves BoxPilot on this server&apos;s network address and opens the web port on the firewall. The Tailscale path keeps working; the password crosses the LAN unencrypted. BoxPilot restarts a few seconds after you approve.</>}</span>,
              })}>{networkCap.lan ? "Turn off LAN access" : "Turn on LAN access"}</Button>
            ) : undefined}
          >
            <KeyValue items={[
              { id: "answers", label: "Answers on", value: networkCap.lan ? <code>{`http://${lanAddress ?? "this-server"}:${networkCap.port}`}</code> : "Tailscale and this server", hint: networkCap.lan ? "Tailscale still works too." : undefined },
              { id: "bind", label: "Bound to", value: <code>{`${networkCap.bind}:${networkCap.port}`}</code> },
            ]} />
            <p className="network-note">
              {networkCap.lan
                ? (tlsCap?.provisioned ? "The LAN can also use HTTPS, so the password need not cross it in the clear." : "This is plain HTTP: set up HTTPS on the LAN so the password is encrypted on your network.")
                : "Over plain HTTP the sign-in password would cross your LAN unencrypted: set up HTTPS on the LAN first, and turn this on only on a network you trust."}
            </p>
          </Panel>
        )}

        {tlsCap?.canProvision && (
          <Panel
            padded
            className="network-tls"
            title="HTTPS on the LAN"
            count={{ status: tlsCap.provisioned ? "good" : "neutral", label: tlsCap.provisioned ? "on" : "off" }}
            actions={<>
              {tlsCap.provisioned && <LinkButton href="/ca.crt" download>Download the certificate</LinkButton>}
              {canTls && <Button variant={tlsCap.provisioned ? "secondary" : "primary"} risk={riskOf("system.web.tls.provision")} onClick={() => provision(tlsCap.provisioned)}>{tlsCap.provisioned ? "Reissue" : "Set up HTTPS on the LAN"}</Button>}
            </>}
          >
            {tlsCap.provisioned ? (
              <KeyValue items={[
                { id: "open", label: "Open", value: <code>{`https://${reachName}:${tlsCap.port}`}</code>, hint: "after installing the certificate on the device" },
                { id: "covers", label: "Covers", value: <span className="network-list">{covers.map((entry) => <code key={entry}>{entry}</code>)}</span> },
                ...(tlsCap.notAfter ? [{ id: "until", label: "Valid until", value: tlsCap.notAfter, mono: true, hint: "Reissued automatically before then, from the same authority, so devices stay trusting." }] : []),
                ...(tlsCap.caFingerprint ? [{ id: "ca", label: "Authority SHA-256", value: <code className="network-fingerprint">{tlsCap.caFingerprint}</code>, hint: "Check that this matches when a device asks." }] : []),
              ]} />
            ) : (
              <p className="network-note">BoxPilot on the LAN is plain HTTP. This serves <code>{`https://${reachName}:8443`}</code> with a certificate your devices can trust, which passkeys need too.</p>
            )}
            {tlsCap.provisioned && <Button variant="ghost" className="network-inline-link" onClick={() => setTrusting(true)}>How to trust it on each device…</Button>}
          </Panel>
        )}
      </div>

      <Panel
        className="network-devices"
        title="Devices on your LAN"
        count={topology ? devices.length : undefined}
        meta="from the neighbour table"
        footer={devices.length && canWake ? "Wake sends Wake-on-LAN magic packets; the device must allow it in its firmware." : undefined}
      >
        <Table
          caption="Devices this server has talked to recently"
          columns={deviceColumns}
          rows={devices}
          rowKey={(device) => `${device.address}-${device.mac}`}
          defaultSort={{ column: "state", direction: "ascending" }}
          empty={!topology ? "Reading…" : topology.collectors.neighbors === false
            ? <EmptyState title="The neighbour table is unavailable" />
            : <EmptyState title="No neighbours right now">Devices appear after this server exchanges traffic with them.</EmptyState>}
        />
      </Panel>

      {trusting && (
        <Sheet kicker="Certificate" title="Trust BoxPilot's certificate" onClose={() => setTrusting(false)} footer={<LinkButton href="/api/v1/tls/ca.crt" download="boxpilot-ca.crt" variant="primary">Download the certificate</LinkButton>}>
          <p className="network-note">BoxPilot signs its own certificate, so a browser warns until the authority is installed on the machine you browse from, once per device. This is for this web interface only: a file share is SMB and needs no certificate.</p>
          {tlsCap?.caFingerprint && <KeyValue items={[{ id: "ca", label: "Authority SHA-256", value: <code className="network-fingerprint">{tlsCap.caFingerprint}</code> }]} />}
          <KeyValue items={trustSteps} />
        </Sheet>
      )}
    </>
  );
}
