import { useCallback, useEffect, useRef, useState } from "react";
import { readJson } from "./http";
import { useOperation } from "./ApproveDialog";
import TailscalePanel from "./TailscalePanel";
import LocalNamesPanel from "./LocalNamesPanel";
import RouterPanel from "./RouterPanel";
import DnsCheckPanel from "./DnsCheckPanel";

type Topology = {
  generatedAt: string;
  collectors: Record<string, boolean>;
  eligibleLanAddresses: Array<{ interface: string; address: string; cidr: string | null }>;
  defaultRoutes: Array<{ gateway: string; interface: string; protocol: string }>;
  defaultResolvers: string[];
  tailscale: { connected: boolean; dnsName: string | null; resolverPresent: boolean; defaultDnsObserved: boolean; overrideState: string; address?: string | null; exitNodeAdvertised?: boolean | null; advertisedRoutes?: string[]; approvedRoutes?: string[]; lanSubnets?: string[] };
  dnsListeners: Array<{ protocol: string; address: string; port: number; scope: string; interface: string | null }>;
  devices?: Array<{ address: string; mac: string; interface: string | null; state: string }>;
  deviceRoles?: Array<{ id: string; name: string; summary: string }>;
  mutationSupported: boolean;
};

type NetworkPlan = {
  id: string;
  revision: string;
  output: {
    executable: boolean;
    readyForChangeWindow: boolean;
    topology: { summary: string; devices: string[] };
    dns: { role: string; primary: string; emergency: string };
    blockers: Array<{ id: string; summary: string }>;
    warnings: string[];
    changes: string[];
    recovery: string[];
    routerMutationSupported: boolean;
    dnsCutoverSupported: boolean;
  };
  expiresAt: string;
};

type DnsCheck = {
  id: string;
  protocol: "udp" | "tcp";
  name: string;
  type: "A";
  expectedRcode: number;
  rcode?: number;
  answers?: number;
  latencyMs?: number;
  passed?: boolean;
};

export default function NetworkCenter({ csrfToken, onAssessmentReady, onOpenRepair }: { csrfToken: string; onAssessmentReady?: (planId: string) => void; onOpenRepair?: () => void }) {
  const [topology, setTopology] = useState<Topology | null>(null);
  const [selectedTopology, setSelectedTopology] = useState("edge-router-with-access-points");
  const [dnsRole, setDnsRole] = useState("current-external");
  const [gatewayAddress, setGatewayAddress] = useState("");
  const [serverAddress, setServerAddress] = useState("");
  const [dnsServiceAddress, setDnsServiceAddress] = useState("");
  const [fallbackDnsAddress, setFallbackDnsAddress] = useState("");
  const [routerBackupRecorded, setRouterBackupRecorded] = useState(false);
  const [emergencyResolverTested, setEmergencyResolverTested] = useState(false);
  const [secondDeviceReady, setSecondDeviceReady] = useState(false);
  const [tailscaleDnsOverride, setTailscaleDnsOverride] = useState(false);
  /** True once the owner has set this themselves, so a refresh stops overwriting their answer. */
  const declarationTouched = useRef(false);
  const [plan, setPlan] = useState<NetworkPlan | null>(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { start, dialog } = useOperation(csrfToken, () => { void loadNetworkCap(); });
  const [networkCap, setNetworkCap] = useState<{ bind: string; port: number; lan: boolean; canSet: boolean } | null>(null);
  const loadNetworkCap = useCallback(() => fetch("/api/v1/capabilities")
    .then((response) => (response.ok ? response.json() : null))
    .then((body: { network?: { bind: string; port: number; lan: boolean; canSet: boolean } } | null) => setNetworkCap(body?.network ?? null))
    .catch(() => {}), []);
  useEffect(() => { void loadNetworkCap(); }, [loadNetworkCap]);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const next = await readJson<Topology>(await fetch("/api/v1/network/topology"));
      setTopology(next);
      setGatewayAddress((value) => value || next.defaultRoutes[0]?.gateway || "");
      setServerAddress((value) => value || next.eligibleLanAddresses[0]?.address || "");
      setDnsServiceAddress((value) => value || next.defaultResolvers[0] || "");
      setFallbackDnsAddress((value) => value || next.defaultResolvers[1] || "");
      // Only adopt the observed value before the owner has said anything: refreshing used to
      // untick a declaration they had made deliberately.
      setTailscaleDnsOverride((current) => (declarationTouched.current ? current : next.tailscale.defaultDnsObserved));
      setPlan(null);
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Network topology is unavailable");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const generatePlan = async () => {
    setSubmitting(true);
    setError(null);
    try {
      const body = await readJson<{ plan: NetworkPlan }>(await fetch("/api/v1/network/plans", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-BoxPilot-CSRF": csrfToken },
        body: JSON.stringify({
          topology: selectedTopology,
          dnsRole,
          gatewayAddress,
          serverAddress,
          dnsServiceAddress,
          fallbackDnsAddress,
          routerBackupRecorded,
          emergencyResolverTested,
          secondDeviceReady,
          tailscaleDnsOverride,
        }),
      }));
      setPlan(body.plan);
      if (dnsRole === "pihole-on-host" && body.plan.output.readyForChangeWindow) onAssessmentReady?.(body.plan.id);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to generate network assessment");
    } finally {
      setSubmitting(false);
    }
  };



  if (!topology && loading) return <section className="vm-loading">Inspecting routes, resolvers, and DNS listeners...</section>;
  if (!topology) return <p className="form-error" role="alert">{error}</p>;

  const collectorCount = Object.values(topology.collectors).filter(Boolean).length;
  const collectorTotal = Object.keys(topology.collectors).length;
  return (
    <div className="network-center">
      <section className="readiness">
        <div><strong>{topology.defaultRoutes[0]?.gateway ?? "No default gateway"}</strong><span>{topology.defaultRoutes[0] ? `Live default route on ${topology.defaultRoutes[0].interface}` : "Route collector did not find a usable IPv4 gateway"}</span></div>
        <div className="readiness-actions"><span className={`status-pill status-${collectorCount === collectorTotal ? "good" : "warning"}`}>{collectorCount}/{collectorTotal} collectors</span><button className="secondary-button" type="button" onClick={() => void refresh()} disabled={loading}>{loading ? "Refreshing..." : "Refresh"}</button></div>
      </section>

      {dialog}
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="network-summary-grid">
        <article className="panel network-summary"><span className="eyebrow">Server LAN</span><strong>{topology.eligibleLanAddresses[0]?.address ?? "Unavailable"}</strong><span>{topology.eligibleLanAddresses[0]?.cidr ?? "No eligible LAN address"}</span></article>
        <article className="panel network-summary"><span className="eyebrow">Default resolvers</span><strong>{topology.defaultResolvers.join(" + ") || "Unavailable"}</strong><span>Observed from systemd-resolved, not router configuration</span></article>
        <article className="panel network-summary"><span className="eyebrow">Tailscale DNS path</span><strong>{topology.tailscale.defaultDnsObserved ? "Default resolver observed" : "Split resolver only"}</strong><span>{topology.tailscale.dnsName ?? "No tailnet DNS name"}</span></article>
      </div>

      <div className="dashboard-grid">
        <TailscalePanel start={start} tailscale={topology.tailscale} />
        <LocalNamesPanel csrfToken={csrfToken} start={start} lanAddress={topology.eligibleLanAddresses[0]?.address ?? null} />
        <DnsCheckPanel csrfToken={csrfToken} lanAddress={topology.eligibleLanAddresses[0]?.address ?? null} />
        <RouterPanel start={start} gateway={topology.defaultRoutes[0]?.gateway ?? null} />
        {networkCap?.canSet && (
          <section className="panel">
            <header className="panel-header"><div><strong>Reach BoxPilot on your network</strong><span>By default BoxPilot answers over Tailscale and on this server only. Turn this on to also reach it from a device on your LAN that is not on your tailnet.</span></div></header>
            <p className="muted">
              {networkCap.lan
                ? <>On now. A device on your network can open <code>{`http://${topology.eligibleLanAddresses[0]?.address ?? "this-server"}:${networkCap.port}`}</code>. Tailscale still works too.</>
                : <>Off. BoxPilot is reachable over Tailscale and from this server only.</>}
            </p>
            {!networkCap.lan && <p className="muted">The sign-in password would cross your LAN unencrypted until HTTPS on the LAN lands, so turn this on only on a network you trust.</p>}
            <div className="recovery-actions">
              <button className={networkCap.lan ? "secondary-button" : "primary-button"} type="button" onClick={() => start({ operationId: "system.web.lan.set", title: networkCap.lan ? "Stop serving BoxPilot on the LAN" : "Reach BoxPilot on your local network", parameters: { enabled: !networkCap.lan }, preview: <span>{networkCap.lan ? <>Returns BoxPilot to Tailscale-and-loopback only and closes the web port on the firewall.</> : <>Also serves BoxPilot on this server's network address and opens the web port on the firewall. The Tailscale path keeps working; the password crosses the LAN unencrypted. BoxPilot restarts a few seconds after you approve.</>}</span> })}>
                {networkCap.lan ? "Turn off LAN access" : "Turn on LAN access"}
              </button>
            </div>
          </section>
        )}
        <section className="panel">
          <header className="panel-header"><div><strong>Devices on your LAN</strong><span>Neighbours this server has talked to recently (ARP table). Wake sends Wake-on-LAN magic packets; the device must allow it in firmware.</span></div></header>
          {topology.devices && topology.devices.length ? <div className="workload-list">{topology.devices.map((device) => <div className="workload" key={`${device.address}-${device.mac}`}><div><strong>{device.address}</strong><span><code>{device.mac}</code>{device.interface ? ` via ${device.interface}` : ""}</span></div><span className={`status-pill status-${device.state === "REACHABLE" ? "good" : "neutral"}`}>{device.state.toLowerCase()}</span><button className="text-button" type="button" onClick={() => start({ operationId: "network.wake", title: `Wake ${device.address}`, parameters: { mac: device.mac }, preview: <span>Broadcasts Wake-on-LAN magic packets for <code>{device.mac}</code> on this server's network. Nothing is read back. The device either wakes or it does not.</span> })}>Wake</button></div>)}</div> : <p className="empty-state">{topology.collectors.neighbors === false ? "The neighbour table is unavailable." : "No resolved neighbours right now. Devices appear after this server exchanges traffic with them."}</p>}
        </section>
        <section className="panel">
          <header className="panel-header"><strong>Port 53 listeners</strong><span>Addresses only, no process or credential data</span></header>
          {topology.dnsListeners.length ? <div className="workload-list">{topology.dnsListeners.map((listener, index) => <div className="workload" key={`${listener.protocol}-${listener.address}-${index}`}><div><strong>{listener.address}:{listener.port}</strong><span>{listener.interface ?? "no host interface match"}</span></div><span className="workload-kind">{listener.protocol.toUpperCase()}</span><span className={`status-pill status-${listener.scope === "wildcard" || listener.scope === "host-address" ? "warning" : "neutral"}`}>{listener.scope}</span></div>)}</div> : <p className="empty-state">No TCP or UDP port 53 listeners were reported.</p>}
        </section>
        <section className="panel">
          <header className="panel-header"><div><strong>Device roles</strong><span>Assessments plan around the role a device plays, not its make or model</span></div></header>
          <div className="workload-list">{(topology.deviceRoles ?? []).map((role) => <div className="router-entry" key={role.id}><div><strong>{role.name}</strong><p>{role.summary}</p></div></div>)}</div>
        </section>
      </div>

      <section className="panel network-planner">
        <header className="panel-header"><strong>Check DNS before changing it</strong><span>Writes a plan you can review; your router is never touched</span></header>
        <div className="network-form-grid">
          <label>Intended topology<select value={selectedTopology} onChange={(event) => { setSelectedTopology(event.target.value); setPlan(null); }}><option value="edge-router-with-access-points">One edge router, everything else as access points</option><option value="alternate-edge-router">A different device at the edge</option><option value="single-router">Single current router</option><option value="custom">Custom, manually verified</option></select></label>
          <label>DNS role<select value={dnsRole} onChange={(event) => { setDnsRole(event.target.value); setPlan(null); }}><option value="current-external">Keep current external resolvers</option><option value="router-hosted-resolver">Resolver hosted on the edge router</option><option value="pihole-on-host">Pi-hole on this server</option><option value="pihole-in-vm">Pi-hole in a dedicated VM</option><option value="other">Other resolver</option></select></label>
          <label>Live gateway IPv4<input value={gatewayAddress} onChange={(event) => { setGatewayAddress(event.target.value); setPlan(null); }} inputMode="decimal" /></label>
          <label>Server LAN IPv4<input value={serverAddress} onChange={(event) => { setServerAddress(event.target.value); setPlan(null); }} inputMode="decimal" /></label>
          <label>Proposed primary DNS IPv4<input value={dnsServiceAddress} onChange={(event) => { setDnsServiceAddress(event.target.value); setPlan(null); }} inputMode="decimal" /></label>
          <label>Emergency DNS IPv4<input value={fallbackDnsAddress} onChange={(event) => { setFallbackDnsAddress(event.target.value); setPlan(null); }} inputMode="decimal" /></label>
        </div>
        <div className="network-checklist">
          <label><input type="checkbox" checked={routerBackupRecorded} onChange={(event) => { setRouterBackupRecorded(event.target.checked); setPlan(null); }} /> Router configuration backup or checkpoint recorded</label>
          <label><input type="checkbox" checked={emergencyResolverTested} onChange={(event) => { setEmergencyResolverTested(event.target.checked); setPlan(null); }} /> Emergency resolver tested independently</label>
          <label><input type="checkbox" checked={secondDeviceReady} onChange={(event) => { setSecondDeviceReady(event.target.checked); setPlan(null); }} /> Second LAN device ready for DNS testing</label>
          <label><input type="checkbox" checked={tailscaleDnsOverride} onChange={(event) => { declarationTouched.current = true; setTailscaleDnsOverride(event.target.checked); setPlan(null); }} /> Tailscale DNS override is enabled</label>
        </div>
        <div className="network-plan-actions"><button className="primary-button" type="button" onClick={() => void generatePlan()} disabled={submitting}>{submitting ? "Rechecking live topology..." : "Generate no-change assessment"}</button><span>No credentials, router sessions, network probes, or settings are accepted.</span></div>
      </section>

      {plan && <section className="panel network-plan-result">
        <div className={`notice ${plan.output.readyForChangeWindow ? "" : "warning-notice"}`}><strong>{plan.output.readyForChangeWindow ? "Prerequisites recorded" : "Change window blocked"}</strong><span>Revision {plan.revision} | assessment expires {new Date(plan.expiresAt).toLocaleTimeString()}</span></div>
        <h3>{plan.output.topology.summary}</h3>
        <div className="network-plan-columns">
          <div><strong>Device roles</strong><ul>{plan.output.topology.devices.map((item) => <li key={item}>{item}</li>)}</ul><strong>Assessment only</strong><ul>{plan.output.changes.map((item) => <li key={item}>{item}</li>)}</ul></div>
          <div><strong>Recovery order</strong><ol>{plan.output.recovery.map((item) => <li key={item}>{item}</li>)}</ol>{plan.output.blockers.length > 0 && <><strong>Blockers</strong><ul className="warning-text">{plan.output.blockers.map((item) => <li key={item.id}>{item.summary}</li>)}</ul></>}{plan.output.warnings.length > 0 && <><strong>Warnings</strong><ul>{plan.output.warnings.map((item) => <li key={item}>{item}</li>)}</ul></>}</div>
        </div>
        <div className="network-lock"><span className="status-pill status-warning">Router writes locked</span><span className="status-pill status-warning">DNS cutover locked</span><span>{plan.output.readyForChangeWindow && plan.output.dns.role === "pihole-on-host" ? `Assessment ${plan.id} is ready for the Applications staging gate.` : "This assessment never changes the network."}</span></div>
      </section>}

    </div>
  );
}
