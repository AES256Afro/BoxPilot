import { useCallback, useEffect, useState } from "react";

type Topology = {
  generatedAt: string;
  collectors: Record<string, boolean>;
  eligibleLanAddresses: Array<{ interface: string; address: string; cidr: string | null }>;
  defaultRoutes: Array<{ gateway: string; interface: string; protocol: string }>;
  defaultResolvers: string[];
  tailscale: { connected: boolean; dnsName: string | null; resolverPresent: boolean; defaultDnsObserved: boolean; overrideState: string };
  dnsListeners: Array<{ protocol: string; address: string; port: number; scope: string; interface: string | null }>;
  routerCatalog: Array<{ id: string; name: string; roles: string[]; integration: string; note: string; officialSource: string }>;
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

async function readJson<T>(response: Response): Promise<T> {
  const body = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(body.error ?? `Request failed with status ${response.status}`);
  return body;
}

export default function NetworkCenter({ csrfToken }: { csrfToken: string }) {
  const [topology, setTopology] = useState<Topology | null>(null);
  const [selectedTopology, setSelectedTopology] = useState("flint2-edge-tplink-ap");
  const [dnsRole, setDnsRole] = useState("current-external");
  const [gatewayAddress, setGatewayAddress] = useState("");
  const [serverAddress, setServerAddress] = useState("");
  const [dnsServiceAddress, setDnsServiceAddress] = useState("");
  const [fallbackDnsAddress, setFallbackDnsAddress] = useState("");
  const [routerBackupRecorded, setRouterBackupRecorded] = useState(false);
  const [emergencyResolverTested, setEmergencyResolverTested] = useState(false);
  const [secondDeviceReady, setSecondDeviceReady] = useState(false);
  const [tailscaleDnsOverride, setTailscaleDnsOverride] = useState(false);
  const [plan, setPlan] = useState<NetworkPlan | null>(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const next = await readJson<Topology>(await fetch("/api/v1/network/topology"));
      setTopology(next);
      setGatewayAddress((value) => value || next.defaultRoutes[0]?.gateway || "");
      setServerAddress((value) => value || next.eligibleLanAddresses[0]?.address || "");
      setDnsServiceAddress((value) => value || next.defaultResolvers[0] || "");
      setFallbackDnsAddress((value) => value || next.defaultResolvers[1] || "");
      setTailscaleDnsOverride(next.tailscale.defaultDnsObserved);
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

      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="network-summary-grid">
        <article className="panel network-summary"><span className="eyebrow">Bigbox LAN</span><strong>{topology.eligibleLanAddresses[0]?.address ?? "Unavailable"}</strong><span>{topology.eligibleLanAddresses[0]?.cidr ?? "No eligible LAN address"}</span></article>
        <article className="panel network-summary"><span className="eyebrow">Default resolvers</span><strong>{topology.defaultResolvers.join(" + ") || "Unavailable"}</strong><span>Observed from systemd-resolved, not router configuration</span></article>
        <article className="panel network-summary"><span className="eyebrow">Tailscale DNS path</span><strong>{topology.tailscale.defaultDnsObserved ? "Default resolver observed" : "Split resolver only"}</strong><span>{topology.tailscale.dnsName ?? "No tailnet DNS name"}</span></article>
      </div>

      <div className="dashboard-grid">
        <section className="panel">
          <header className="panel-header"><strong>Port 53 listeners</strong><span>Addresses only, no process or credential data</span></header>
          {topology.dnsListeners.length ? <div className="workload-list">{topology.dnsListeners.map((listener, index) => <div className="workload" key={`${listener.protocol}-${listener.address}-${index}`}><div><strong>{listener.address}:{listener.port}</strong><span>{listener.interface ?? "no host interface match"}</span></div><span className="workload-kind">{listener.protocol.toUpperCase()}</span><span className={`status-pill status-${listener.scope === "wildcard" || listener.scope === "host-address" ? "warning" : "neutral"}`}>{listener.scope}</span></div>)}</div> : <p className="empty-state">No TCP or UDP port 53 listeners were reported.</p>}
        </section>
        <section className="panel">
          <header className="panel-header"><strong>Supported device declarations</strong><span>Read-only in this release</span></header>
          <div className="workload-list">{topology.routerCatalog.map((router) => <div className="router-entry" key={router.id}><div><strong>{router.name}</strong><span>{router.roles.join(" | ")}</span><p>{router.note}</p></div><a href={router.officialSource} target="_blank" rel="noreferrer">Official source</a></div>)}</div>
        </section>
      </div>

      <section className="panel network-planner">
        <header className="panel-header"><strong>Router and DNS change-window assessment</strong><span>Creates an attributable immutable plan, never a router change</span></header>
        <div className="network-form-grid">
          <label>Intended topology<select value={selectedTopology} onChange={(event) => { setSelectedTopology(event.target.value); setPlan(null); }}><option value="flint2-edge-tplink-ap">Flint 2 edge + TP-Link AP</option><option value="omada-edge-access-points">ER707-M2 edge + wireless APs</option><option value="single-router">Single current router</option><option value="custom">Custom, manually verified</option></select></label>
          <label>DNS role<select value={dnsRole} onChange={(event) => { setDnsRole(event.target.value); setPlan(null); }}><option value="current-external">Keep current external resolvers</option><option value="flint2-adguard-home">Flint 2 AdGuard Home</option><option value="pihole-on-bigbox">Pi-hole on Bigbox</option><option value="pihole-in-vm">Pi-hole in a dedicated VM</option><option value="other">Other resolver</option></select></label>
          <label>Live gateway IPv4<input value={gatewayAddress} onChange={(event) => { setGatewayAddress(event.target.value); setPlan(null); }} inputMode="decimal" /></label>
          <label>Bigbox LAN IPv4<input value={serverAddress} onChange={(event) => { setServerAddress(event.target.value); setPlan(null); }} inputMode="decimal" /></label>
          <label>Proposed primary DNS IPv4<input value={dnsServiceAddress} onChange={(event) => { setDnsServiceAddress(event.target.value); setPlan(null); }} inputMode="decimal" /></label>
          <label>Emergency DNS IPv4<input value={fallbackDnsAddress} onChange={(event) => { setFallbackDnsAddress(event.target.value); setPlan(null); }} inputMode="decimal" /></label>
        </div>
        <div className="network-checklist">
          <label><input type="checkbox" checked={routerBackupRecorded} onChange={(event) => { setRouterBackupRecorded(event.target.checked); setPlan(null); }} /> Router configuration backup or checkpoint recorded</label>
          <label><input type="checkbox" checked={emergencyResolverTested} onChange={(event) => { setEmergencyResolverTested(event.target.checked); setPlan(null); }} /> Emergency resolver tested independently</label>
          <label><input type="checkbox" checked={secondDeviceReady} onChange={(event) => { setSecondDeviceReady(event.target.checked); setPlan(null); }} /> Second LAN device ready for DNS testing</label>
          <label><input type="checkbox" checked={tailscaleDnsOverride} onChange={(event) => { setTailscaleDnsOverride(event.target.checked); setPlan(null); }} /> Tailscale DNS override is enabled</label>
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
        <div className="network-lock"><span className="status-pill status-warning">Router writes locked</span><span className="status-pill status-warning">DNS cutover locked</span><span>No stage or approval action exists in 0.18.0.</span></div>
      </section>}
    </div>
  );
}
