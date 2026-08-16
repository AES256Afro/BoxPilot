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

type DnsAcceptance = {
  id: string;
  resolverAddress: string;
  origin: "boxpilot-controller";
  checks: DnsCheck[];
  passed: boolean;
  secondDeviceTested: boolean;
  createdAt: string;
};

type DnsAcceptanceStatus = {
  source: { installed: boolean; healthy: boolean; state: string; lanAddress: string | null; detail: string };
  linkedDeploymentJobId: string | null;
  linkedBackupId: string | null;
  acceptances: DnsAcceptance[];
  limitations: string[];
};

type DnsAcceptancePlan = {
  id: string;
  revision: string;
  output: {
    executable: boolean;
    resolverAddress: string | null;
    linkedDeploymentJobId: string | null;
    linkedAssessmentId: string | null;
    linkedBackupId: string | null;
    blockers: Array<{ id: string; summary: string }>;
    tests: DnsCheck[];
    evidenceBoundary: { provesBigboxPath: boolean; provesSecondDevicePath: boolean; routerMutationSupported: boolean; dnsCutoverSupported: boolean };
    changes: string[];
    recovery: string;
  };
  expiresAt: string;
};

async function readJson<T>(response: Response): Promise<T> {
  const body = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(body.error ?? `Request failed with status ${response.status}`);
  return body;
}

export default function NetworkCenter({ csrfToken, onAssessmentReady, onOpenRepair }: { csrfToken: string; onAssessmentReady?: (planId: string) => void; onOpenRepair?: () => void }) {
  const [topology, setTopology] = useState<Topology | null>(null);
  const [acceptance, setAcceptance] = useState<DnsAcceptanceStatus | null>(null);
  const [acceptancePlan, setAcceptancePlan] = useState<DnsAcceptancePlan | null>(null);
  const [acceptanceMessage, setAcceptanceMessage] = useState<string | null>(null);
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
      const [next, acceptanceStatus] = await Promise.all([
        readJson<Topology>(await fetch("/api/v1/network/topology")),
        readJson<DnsAcceptanceStatus>(await fetch("/api/v1/network/dns-acceptance")),
      ]);
      setTopology(next);
      setAcceptance(acceptanceStatus);
      setGatewayAddress((value) => value || next.defaultRoutes[0]?.gateway || "");
      setServerAddress((value) => value || next.eligibleLanAddresses[0]?.address || "");
      setDnsServiceAddress((value) => value || next.defaultResolvers[0] || "");
      setFallbackDnsAddress((value) => value || next.defaultResolvers[1] || "");
      setTailscaleDnsOverride(next.tailscale.defaultDnsObserved);
      setPlan(null);
      setAcceptancePlan(null);
      setAcceptanceMessage(null);
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
      if (dnsRole === "pihole-on-bigbox" && body.plan.output.readyForChangeWindow) onAssessmentReady?.(body.plan.id);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to generate network assessment");
    } finally {
      setSubmitting(false);
    }
  };

  const generateAcceptancePlan = async () => {
    setSubmitting(true);
    setError(null);
    setAcceptanceMessage(null);
    try {
      const body = await readJson<{ plan: DnsAcceptancePlan }>(await fetch("/api/v1/network/dns-acceptance/plans", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-BoxPilot-CSRF": csrfToken },
        body: "{}",
      }));
      setAcceptancePlan(body.plan);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to plan direct DNS acceptance");
    } finally {
      setSubmitting(false);
    }
  };

  const stageAcceptancePlan = async () => {
    if (!acceptancePlan) return;
    setSubmitting(true);
    setError(null);
    try {
      await readJson(await fetch(`/api/v1/network/dns-acceptance-plans/${acceptancePlan.id}/stage`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-BoxPilot-CSRF": csrfToken },
        body: JSON.stringify({ revision: acceptancePlan.revision }),
      }));
      setAcceptancePlan(null);
      setAcceptanceMessage("Direct DNS acceptance is staged. Review and approve the exact fixed checks in Repair Center.");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to stage direct DNS acceptance");
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
        <div className="network-lock"><span className="status-pill status-warning">Router writes locked</span><span className="status-pill status-warning">DNS cutover locked</span><span>{plan.output.readyForChangeWindow && plan.output.dns.role === "pihole-on-bigbox" ? `Assessment ${plan.id} is ready for the Applications staging gate.` : "This assessment never changes the network."}</span></div>
      </section>}

      {acceptance && <section className="panel dns-acceptance-panel" aria-label="Direct DNS acceptance">
        <div className="section-heading"><div><span className="eyebrow">Pi-hole acceptance gate</span><h3>Prove DNS directly from Bigbox</h3></div><span className={`status-pill ${acceptance.acceptances[0]?.passed ? "status-good" : "status-warning"}`}>{acceptance.acceptances[0]?.passed ? "Bigbox path passed" : acceptance.source.installed ? "Proof required" : "Pi-hole not installed"}</span></div>
        <div className="dns-acceptance-summary">
          <div><strong>{acceptance.source.lanAddress ? `${acceptance.source.lanAddress}:53` : "No managed resolver"}</strong><span>{acceptance.source.detail}</span></div>
          <div><strong>{acceptance.linkedBackupId ? "Restore evidence linked" : "Restore evidence missing"}</strong><span>{acceptance.linkedBackupId ?? "Run the separate Pi-hole backup and isolated restore drill first"}</span></div>
          <div><strong>Second device not proven</strong><span>An enrolled independent LAN device is still required before router advertisement.</span></div>
        </div>
        <div className="network-lock"><span className="status-pill status-warning">Router writes locked</span><span className="status-pill status-warning">Client DNS locked</span><span>Planning accepts no address, hostname, command, or router credential.</span></div>
        {!acceptancePlan && !acceptanceMessage && <button className="primary-button" type="button" onClick={() => void generateAcceptancePlan()} disabled={submitting}>{submitting ? "Inspecting exact evidence..." : "Plan fixed direct DNS checks"}</button>}
        {acceptanceMessage && <div className="notice"><strong>Approval job ready</strong><span>{acceptanceMessage}</span>{onOpenRepair && <button className="text-button" type="button" onClick={onOpenRepair}>Open Repair Center</button>}</div>}

        {acceptancePlan && <div className="dns-acceptance-plan">
          <div className={`notice ${acceptancePlan.output.executable ? "" : "warning-notice"}`}><strong>{acceptancePlan.output.executable ? "Exact checks are ready to stage" : "Direct DNS acceptance is blocked"}</strong><span>Revision {acceptancePlan.revision} | expires {new Date(acceptancePlan.expiresAt).toLocaleTimeString()}</span></div>
          <div className="network-plan-columns">
            <div><strong>Fixed requests</strong><ol>{acceptancePlan.output.tests.map((test) => <li key={test.id}>{test.protocol.toUpperCase()} {test.name} {test.type} on port 53, expect response code {test.expectedRcode}</li>)}</ol></div>
            <div><strong>Evidence boundary</strong><ul><li>Proves the Bigbox-to-resolver path only</li><li>Does not prove a second LAN device</li><li>Does not change router, DHCP, clients, firewall, or Tailscale</li></ul><p>{acceptancePlan.output.recovery}</p></div>
          </div>
          {acceptancePlan.output.blockers.map((blocker) => <div className="notice warning-notice" key={blocker.id}><strong>{blocker.id}</strong><span>{blocker.summary}</span></div>)}
          <footer className="modal-actions"><button className="text-button" type="button" onClick={() => setAcceptancePlan(null)}>Discard plan</button><button className="primary-button" type="button" disabled={!acceptancePlan.output.executable || submitting} onClick={() => void stageAcceptancePlan()}>Stage fixed checks for approval</button></footer>
        </div>}

        <div className="table-scroll"><table><thead><tr><th>Origin</th><th>Resolver</th><th>Created</th><th>Checks</th><th>Second device</th></tr></thead><tbody>{acceptance.acceptances.length ? acceptance.acceptances.map((record) => <tr key={record.id}><td>{record.origin === "boxpilot-controller" ? "Bigbox controller" : record.origin}</td><td>{record.resolverAddress}:53</td><td>{new Date(record.createdAt).toLocaleString()}</td><td className={record.passed ? "good-text" : "warning-text"}>{record.checks.filter((check) => check.passed).length}/{record.checks.length} passed</td><td className="warning-text">{record.secondDeviceTested ? "Proven" : "Pending"}</td></tr>) : <tr><td colSpan={5}>No direct DNS acceptance has been recorded.</td></tr>}</tbody></table></div>
        <ul className="dns-acceptance-limitations">{acceptance.limitations.map((limitation) => <li key={limitation}>{limitation}</li>)}</ul>
      </section>}
    </div>
  );
}
