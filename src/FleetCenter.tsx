import { useCallback, useEffect, useMemo, useState } from "react";

type Agent = {
  id: string;
  name: string;
  fingerprint: string;
  capabilities: string[];
  status: "active" | "revoked";
  lastSequence: number;
  enrolledAt: string;
  lastSeenAt: string | null;
};

type FleetTask = {
  id: string;
  agentId: string;
  type: string;
  state: "pending" | "completed" | "expired";
  createdAt: string;
  availableAt: string;
  expiresAt: string;
};

type FleetEvidence = {
  id: string;
  taskId: string;
  agentId: string;
  sequence: number;
  passed: boolean;
  receivedAt: string;
  result: { type: string; resolverAddress: string; controllerAcceptanceId?: string; routerAcceptanceId?: string; secondDeviceTested: boolean; modelIdentityVerified?: boolean; checks: Array<{ passed: boolean }> };
};

type FleetStatus = {
  agents: Agent[];
  tasks: FleetTask[];
  evidence: FleetEvidence[];
  enrollment: { tokenTtlMinutes: number; keyType: string; tokenStoredAsDigest: boolean };
  executionBoundary: {
    controllerShellAccess: boolean;
    arbitraryCommands: boolean;
    arbitraryTargets: boolean;
    supportedTasks: string[];
    nodeLocalExecution: boolean;
    routerMutationSupported: boolean;
    dnsCutoverSupported: boolean;
  };
  schedulingPolicy: {
    mode: string;
    allowedDelayMinutes: number[];
    executionWindowMinutes: number;
    recurrenceSupported: boolean;
    unattendedExecutionSupported: boolean;
    cancellationSupported: boolean;
    taskTypes: string[];
    targetSources: string[];
    passwordReauthenticationRequired: boolean;
  };
};

async function readJson<T>(response: Response): Promise<T> {
  const body = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(body.error ?? `Request failed with status ${response.status}`);
  return body;
}

export default function FleetCenter({ csrfToken }: { csrfToken: string }) {
  const [status, setStatus] = useState<FleetStatus | null>(null);
  const [deviceName, setDeviceName] = useState("second-lan-device");
  const [password, setPassword] = useState("");
  const [revocationPassword, setRevocationPassword] = useState("");
  const [selectedAgentId, setSelectedAgentId] = useState("");
  const [probePassword, setProbePassword] = useState("");
  const [probeKind, setProbeKind] = useState<"pi-hole" | "flint2-adguard">("pi-hole");
  const [delayMinutes, setDelayMinutes] = useState(0);
  const [enrollment, setEnrollment] = useState<{ token: string; expiresAt: string } | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const next = await readJson<FleetStatus>(await fetch("/api/v1/fleet"));
      setStatus(next);
      const active = next.agents.find((agent) => agent.status === "active");
      setSelectedAgentId((value) => next.agents.some((agent) => agent.id === value && agent.status === "active") ? value : active?.id ?? "");
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Fleet status is unavailable");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const createEnrollment = async () => {
    setSubmitting(true);
    setError(null);
    setMessage(null);
    try {
      const body = await readJson<{ enrollment: { token: string; expiresAt: string } }>(await fetch("/api/v1/fleet/enrollments", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-BoxPilot-CSRF": csrfToken },
        body: JSON.stringify({ password }),
      }));
      setEnrollment(body.enrollment);
      setPassword("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to create enrollment token");
    } finally {
      setSubmitting(false);
    }
  };

  const createProbe = async () => {
    if (!selectedAgentId) return;
    setSubmitting(true);
    setError(null);
    setMessage(null);
    try {
      const endpoint = probeKind === "pi-hole" ? "/api/v1/fleet/dns-probe-tasks" : "/api/v1/fleet/flint2-dns-probe-tasks";
      const body = await readJson<{ task: FleetTask }>(await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-BoxPilot-CSRF": csrfToken },
        body: JSON.stringify({ agentId: selectedAgentId, delayMinutes, password: probePassword }),
      }));
      setProbePassword("");
      setMessage(`One-shot ${probeKind === "pi-hole" ? "Pi-hole" : "Flint 2 gateway"} DNS probe ${body.task.id} is available ${new Date(body.task.availableAt).toLocaleString()} and expires ${new Date(body.task.expiresAt).toLocaleString()}. Run the agent once during that window.`);
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to create DNS probe task");
    } finally {
      setSubmitting(false);
    }
  };

  const revokeAgent = async (agentId: string) => {
    setSubmitting(true);
    setError(null);
    setMessage(null);
    try {
      const body = await readJson<{ agent: Agent }>(await fetch(`/api/v1/fleet/agents/${agentId}/revoke`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-BoxPilot-CSRF": csrfToken },
        body: JSON.stringify({ password: revocationPassword }),
      }));
      setRevocationPassword("");
      setMessage(`${body.agent.name} was revoked. Pending tasks expired and future signed requests will be rejected.`);
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to revoke agent");
    } finally {
      setSubmitting(false);
    }
  };

  const activeAgents = useMemo(() => status?.agents.filter((agent) => agent.status === "active") ?? [], [status]);
  if (!status && loading) return <section className="vm-loading">Loading signed agents and evidence...</section>;
  if (!status) return <p className="form-error" role="alert">{error}</p>;
  const command = enrollment
    ? `npm run agent -- enroll --controller ${window.location.origin} --token ${enrollment.token} --name ${deviceName}`
    : null;
  const enrollmentExpiry = enrollment ? new Date(enrollment.expiresAt).toLocaleTimeString() : "";

  return (
    <div className="fleet-center">
      <section className="readiness">
        <div><strong>{activeAgents.length} active signed agent{activeAgents.length === 1 ? "" : "s"}</strong><span>Ed25519 identity, five-minute request window, and strictly increasing replay sequence</span></div>
        <div className="readiness-actions"><span className="status-pill status-good">No remote shell</span><button className="secondary-button" type="button" onClick={() => void refresh()} disabled={loading}>{loading ? "Refreshing..." : "Refresh"}</button></div>
      </section>
      {error && <p className="form-error" role="alert">{error}</p>}
      {message && <div className="notice"><strong>Agent task ready</strong><span>{message}</span></div>}

      <div className="dashboard-grid">
        <section className="panel fleet-boundary">
          <header className="panel-header"><strong>Execution boundary</strong><span>Controller compromise cannot request a shell</span></header>
          <div className="network-lock"><span className="status-pill status-good">Commands unavailable</span><span className="status-pill status-good">Targets fixed</span><span className="status-pill status-warning">Router writes locked</span></div>
          <ul><li>The only task contracts are four fixed Pi-hole checks or four fixed Flint 2 observed-gateway checks.</li><li>The resolver comes from a fresh matching Bigbox controller acceptance record, never this form.</li><li>The device executes locally and keeps functioning without the controller.</li><li>No router, DHCP, client DNS, firewall, or Tailscale setting can be changed.</li></ul>
        </section>

        <section className="panel fleet-enrollment">
          <header className="panel-header"><strong>Enroll a second LAN device</strong><span>Token shown once and stored only as a digest</span></header>
          <div className="network-form-grid">
            <label>Device name<input value={deviceName} onChange={(event) => { setDeviceName(event.target.value); setEnrollment(null); }} pattern="[A-Za-z0-9][A-Za-z0-9_.-]{2,47}" /></label>
            <label>Owner password<input type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" /></label>
          </div>
          <button className="primary-button" type="button" disabled={submitting || password.length < 12 || !/^[A-Za-z0-9][A-Za-z0-9_.-]{2,47}$/.test(deviceName)} onClick={() => void createEnrollment()}>{submitting ? "Reauthenticating..." : "Create 10-minute token"}</button>
          {command && <div className="fleet-command"><strong>Run from a trusted checkout on the second device</strong><code>{command}</code><code>npm run agent -- run-once</code><span>Expires {enrollmentExpiry}. The private key never leaves that device.</span></div>}
        </section>
      </div>

      <section className="panel fleet-probe">
        <header className="panel-header"><strong>Independent DNS proof</strong><span>Owner-approved one-shot window after a fresh matching Bigbox proof</span></header>
        <div className="fleet-schedule-policy"><div><span className="eyebrow">Scheduling policy</span><strong>One-shot only</strong><small>Immediate, 5-minute, or 10-minute delay | 10-minute execution window</small></div><div className="network-lock"><span className="status-pill status-good">Password required</span><span className="status-pill status-good">Fixed task</span><span className="status-pill status-warning">No recurrence</span><span className="status-pill status-warning">No unattended jobs</span></div></div>
        <div className="network-form-grid">
          <label>Proof source<select aria-label="Proof source" value={probeKind} onChange={(event) => setProbeKind(event.target.value as "pi-hole" | "flint2-adguard")}><option value="pi-hole">Managed Pi-hole</option><option value="flint2-adguard">Flint 2 observed gateway</option></select></label>
          <label>Signed device<select value={selectedAgentId} onChange={(event) => setSelectedAgentId(event.target.value)}><option value="">Choose an active agent</option>{activeAgents.map((agent) => <option key={agent.id} value={agent.id}>{agent.name}</option>)}</select></label>
          <label>Start delay<select aria-label="Start delay" value={delayMinutes} onChange={(event) => setDelayMinutes(Number(event.target.value))}>{status.schedulingPolicy.allowedDelayMinutes.map((delay) => <option value={delay} key={delay}>{delay === 0 ? "Immediately" : `In ${delay} minutes`}</option>)}</select></label>
          <label>Owner password for task<input type="password" value={probePassword} onChange={(event) => setProbePassword(event.target.value)} autoComplete="current-password" /></label>
        </div>
        <div className="network-plan-actions"><button className="primary-button" type="button" disabled={!selectedAgentId || probePassword.length < 12 || submitting} onClick={() => void createProbe()}>{submitting ? "Reauthenticating..." : `Schedule fixed ${probeKind === "pi-hole" ? "Pi-hole" : "Flint 2"} proof`}</button><span>No address, hostname, port, command, recurrence, or arbitrary execution time is accepted from this form.</span></div>
      </section>

      <section className="panel table-panel">
        <header className="panel-header"><strong>One-shot task windows</strong><span>Pending tasks are dispatchable only inside their exact window</span></header>
        <div className="table-scroll"><table><thead><tr><th>Created</th><th>Agent</th><th>Available</th><th>Expires</th><th>Type</th><th>State</th></tr></thead><tbody>{status.tasks.length ? status.tasks.map((task) => <tr key={task.id}><td>{new Date(task.createdAt).toLocaleString()}</td><td>{status.agents.find((agent) => agent.id === task.agentId)?.name ?? task.agentId}</td><td>{new Date(task.availableAt).toLocaleString()}</td><td>{new Date(task.expiresAt).toLocaleString()}</td><td><code>{task.type}</code></td><td className={task.state === "completed" ? "good-text" : task.state === "expired" ? "warning-text" : ""}>{task.state === "pending" && new Date(task.availableAt) > new Date() ? "scheduled" : task.state}</td></tr>) : <tr><td colSpan={6}>No one-shot fleet task has been scheduled.</td></tr>}</tbody></table></div>
      </section>

      <section className="panel table-panel">
        <header className="panel-header"><strong>Agents</strong><span>Public-key fingerprint and liveness only</span></header>
        <div className="fleet-revoke"><label>Owner password to revoke an active identity<input type="password" value={revocationPassword} onChange={(event) => setRevocationPassword(event.target.value)} autoComplete="current-password" /></label><span>Revocation expires pending tasks and cannot be undone. Re-enrollment creates a new key identity.</span></div>
        <div className="table-scroll"><table><thead><tr><th>Device</th><th>Status</th><th>Fingerprint</th><th>Last seen</th><th>Sequence</th><th>Action</th></tr></thead><tbody>{status.agents.length ? status.agents.map((agent) => <tr key={agent.id}><td>{agent.name}</td><td className={agent.status === "active" ? "good-text" : "warning-text"}>{agent.status}</td><td><code>{agent.fingerprint.slice(0, 16)}...</code></td><td>{agent.lastSeenAt ? new Date(agent.lastSeenAt).toLocaleString() : "Never"}</td><td>{agent.lastSequence}</td><td>{agent.status === "active" ? <button className="text-button warning-text" type="button" disabled={revocationPassword.length < 12 || submitting} onClick={() => void revokeAgent(agent.id)}>Revoke</button> : "Revoked"}</td></tr>) : <tr><td colSpan={6}>No agent has been enrolled.</td></tr>}</tbody></table></div>
      </section>

      <section className="panel table-panel">
        <header className="panel-header"><strong>Signed DNS evidence</strong><span>Second-device proof does not unlock router cutover</span></header>
        <div className="table-scroll"><table><thead><tr><th>Received</th><th>Agent</th><th>Source</th><th>Resolver</th><th>Checks</th><th>Result</th></tr></thead><tbody>{status.evidence.length ? status.evidence.map((evidence) => <tr key={evidence.id}><td>{new Date(evidence.receivedAt).toLocaleString()}</td><td>{status.agents.find((agent) => agent.id === evidence.agentId)?.name ?? evidence.agentId}</td><td>{evidence.result.type === "dns.flint2-adguard.acceptance.v1" ? "Flint 2 gateway" : "Pi-hole"}</td><td>{evidence.result.resolverAddress}:53</td><td>{evidence.result.checks.filter((check) => check.passed).length}/4</td><td className={evidence.passed ? "good-text" : "warning-text"}>{evidence.passed ? "Passed" : "Failed"}</td></tr>) : <tr><td colSpan={6}>No independent DNS evidence has been recorded.</td></tr>}</tbody></table></div>
      </section>
    </div>
  );
}
