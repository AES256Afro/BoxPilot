import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useOperation } from "./ApproveDialog";
import Fail2banPanel from "./Fail2banPanel";

interface FirewallRule { action?: string; protocol?: string; port?: number | null; app?: string | null; direction?: string; interface?: string | null; comment?: string | null; family?: string; raw?: string }
interface FirewallReport { installed: boolean; enabled: boolean | null; defaults: { incoming: string | null; outgoing: string | null; routed: string | null } | null; rules: FirewallRule[] }
interface ProtectedRule { port: number; protocol: string; label: string; reason: string; allow: boolean }
interface Profile { id: string; name: string; recommended: boolean; summary: string; detail: string; defaults: { incoming: string; outgoing: string }; rules: Array<{ action: string; port: number; protocol: string; comment?: string | null }>; lockServices?: boolean }
interface Service { id: string; name: string; hint: string; ports: Array<{ port: number; protocol: string }> }
interface Advice { id: string; level: "action" | "warn" | "info"; title: string; detail: string; focus?: "profiles" | "install" | "fail2ban"; operationId?: string; parameters?: Record<string, unknown>; actionLabel?: string }
interface CurrentProfile { id: string; services: string[]; sshRateLimit: boolean; appliedAt: string | null }
interface Overview {
  report: FirewallReport | null; reportError: string | null;
  web: { port: number; lanExposed: boolean };
  protected: ProtectedRule[]; profiles: Profile[]; services: Service[]; current: CurrentProfile | null; advice: Advice[];
}
interface Plan { profile: { id: string; name: string }; services: string[]; steps: Array<{ args: string[]; label: string; tolerateFailure?: boolean }> }

const spec = (port: number, protocol?: string | null) => `${port}${protocol && protocol !== "any" ? `/${protocol}` : ""}`;
const levelLabel: Record<Advice["level"], string> = { action: "Do this", warn: "Heads-up", info: "Tip" };
const levelClass: Record<Advice["level"], string> = { action: "status-danger", warn: "status-warning", info: "status-neutral" };

export default function FirewallCenter({ csrfToken }: { csrfToken: string }) {
  const [overview, setOverview] = useState<Overview | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [port, setPort] = useState("");
  const [protocol, setProtocol] = useState("tcp");
  const [action, setAction] = useState("allow");
  const [comment, setComment] = useState("");
  const [profileId, setProfileId] = useState<string | null>(null);
  const [chosen, setChosen] = useState<string[]>([]);
  const [sshRateLimit, setSshRateLimit] = useState(false);
  const [replace, setReplace] = useState(false);
  const [planning, setPlanning] = useState(false);
  const profilesRef = useRef<HTMLElement | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch("/api/v1/firewall/overview");
      const body = (await response.json()) as Overview & { error?: string };
      if (!response.ok) throw new Error(body.error ?? "Could not read firewall state");
      setOverview(body);
      setRefreshKey((key) => key + 1);
      if (body.reportError) setError(body.reportError);
      setProfileId((current) => current ?? body.current?.id ?? body.profiles.find((profile) => profile.recommended)?.id ?? body.profiles[0]?.id ?? null);
      setChosen((current) => (current.length ? current : body.current?.services ?? []));
      setSshRateLimit((current) => current || Boolean(body.current?.sshRateLimit));
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Could not read firewall state");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const { start, dialog } = useOperation(csrfToken, () => { setPort(""); setComment(""); void refresh(); });

  const report = overview?.report ?? null;
  const protectedRules = useMemo(() => overview?.protected ?? [], [overview]);
  const isProtectedPort = useCallback((rulePort: number | null | undefined, ruleProtocol?: string | null) => rulePort !== null && rulePort !== undefined && protectedRules.some((entry) => entry.port === rulePort && (!ruleProtocol || ruleProtocol === "any" || entry.protocol === ruleProtocol)), [protectedRules]);

  const portValue = Number.parseInt(port, 10);
  const portValid = Number.isInteger(portValue) && portValue >= 1 && portValue <= 65535;
  const denyingProtected = action === "deny" && portValid && isProtectedPort(portValue, protocol);
  const protectedHit = denyingProtected ? protectedRules.find((entry) => entry.port === portValue && (protocol === "any" || entry.protocol === protocol)) : null;

  const selectedProfile = overview?.profiles.find((profile) => profile.id === profileId) ?? null;
  const currentProfile = overview?.current ? overview.profiles.find((profile) => profile.id === overview.current?.id) ?? null : null;

  const toggleService = (id: string, checked: boolean) => setChosen((current) => (checked ? [...new Set([...current, id])] : current.filter((entry) => entry !== id)));
  const focusProfiles = () => profilesRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });

  const installUfw = () => start({ operationId: "apt.install", title: "Install ufw", parameters: { packages: ["ufw"] }, preview: <span><code>apt-get install --no-install-recommends ufw</code>. Installing does not enable it.</span> });

  const reviewProfile = async () => {
    if (!selectedProfile) return;
    setPlanning(true);
    try {
      const query = new URLSearchParams({ profile: selectedProfile.id, services: chosen.join(","), replace: String(replace), sshRateLimit: String(sshRateLimit) });
      const response = await fetch(`/api/v1/firewall/plan?${query.toString()}`);
      const plan = (await response.json()) as Plan & { error?: string };
      if (!response.ok) throw new Error(plan.error ?? "Could not build the plan");
      start({
        operationId: "firewall.profile.apply",
        title: `Apply the ${selectedProfile.name} profile`,
        parameters: { profile: selectedProfile.id, services: selectedProfile.lockServices ? [] : chosen, replace, sshRateLimit },
        preview: (
          <div className="plan-preview">
            <p>Runs these ufw commands in order. The firewall ends up <strong>on</strong>; SSH, Tailscale, and BoxPilot stay reachable throughout. If any required step fails, nothing is turned on.</p>
            <ol>{plan.steps.map((step, index) => <li key={index}><code>ufw {step.args.join(" ")}</code><span className="muted"> — {step.label}</span></li>)}</ol>
          </div>
        ),
      });
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Could not build the plan");
    } finally {
      setPlanning(false);
    }
  };

  const adviceAction = (entry: Advice) => {
    if (entry.operationId && entry.parameters) {
      const parameters = entry.parameters as { action?: string; port?: number; protocol?: string };
      start({
        operationId: entry.operationId,
        title: entry.actionLabel ?? entry.title,
        parameters: entry.parameters,
        preview: <span><code>ufw {entry.operationId === "firewall.rule.delete" ? "delete " : ""}{parameters.action} {spec(parameters.port ?? 0, parameters.protocol)}</code></span>,
      });
      return;
    }
    if (entry.focus === "install") installUfw();
    else if (entry.focus === "fail2ban") document.getElementById("fail2ban")?.scrollIntoView({ behavior: "smooth", block: "start" });
    else focusProfiles();
  };

  if (report && !report.installed) {
    return (
      <div className="firewall-center">
        {dialog}
        <section className="panel">
          <header className="panel-header"><div><strong>ufw is not installed</strong><span>Install the uncomplicated firewall to manage incoming traffic from here. Installing does not turn it on.</span></div>
            <button className="primary-button" type="button" onClick={installUfw}>Install ufw</button>
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
          <strong>{loading && !report ? "…" : report?.enabled === null || !report ? "Unknown" : report.enabled ? "Enabled" : "Disabled"}</strong>
          <span>{report?.enabled ? "Incoming traffic is filtered" : "All incoming traffic is accepted"}</span>
          {report && report.enabled !== null && (
            <div className="recovery-actions">
              <button className="secondary-button" type="button" disabled={loading} onClick={() => start({
                operationId: "firewall.set",
                title: report.enabled ? "Turn the firewall off" : "Turn the firewall on",
                parameters: { enabled: !report.enabled },
                preview: report.enabled
                  ? <span><code>ufw disable</code>. All incoming traffic is accepted afterwards.</span>
                  : <span>Adds rules keeping SSH (22/tcp), Tailscale (41641/udp){overview?.web.lanExposed ? `, BoxPilot (${overview.web.port}/tcp)` : ""}, and the <code>tailscale0</code> interface reachable, then <code>ufw enable</code>. Other incoming traffic follows the default policy.</span>,
              })}>{report.enabled ? "Turn off" : "Turn on"}</button>
            </div>
          )}
        </article>
        <article className="panel"><span className="eyebrow">Default incoming</span><strong>{loading && !report ? "…" : report?.defaults?.incoming ?? "—"}</strong><span>what happens without a matching rule</span></article>
        <article className="panel">
          <span className="eyebrow">Profile</span>
          <strong>{loading && !overview ? "…" : currentProfile?.name ?? "None applied"}</strong>
          <span>{overview?.current?.appliedAt ? `applied ${new Date(overview.current.appliedAt).toLocaleString()}` : "apply one below to get sensible defaults"}</span>
        </article>
        <article className="panel"><span className="eyebrow">Rules</span><strong>{loading && !report ? "…" : report?.rules.length ?? "—"}</strong><span>configured in ufw</span></article>
      </div>

      <section className="panel">
        <header className="panel-header"><div><strong>Suggestions</strong><span>What BoxPilot would change, based on what is listening on this server right now.</span></div></header>
        {overview && overview.advice.length === 0 && <p className="muted">Nothing to suggest: the firewall is on, blocks by default, and nothing risky is open to the network.</p>}
        <div className="advice-list">
          {overview?.advice.map((entry) => (
            <div className="advice-item" key={entry.id}>
              <span className={`status-pill ${levelClass[entry.level]}`}>{levelLabel[entry.level]}</span>
              <div><strong>{entry.title}</strong><span className="muted">{entry.detail}</span></div>
              {(entry.operationId || entry.focus) && <button className={entry.level === "action" ? "primary-button" : "secondary-button"} type="button" onClick={() => adviceAction(entry)}>{entry.actionLabel ?? (entry.focus === "install" ? "Install ufw" : entry.focus === "fail2ban" ? "Set it up" : "Choose a profile")}</button>}
            </div>
          ))}
        </div>
      </section>

      <section className="panel" ref={profilesRef} id="firewall-profiles">
        <header className="panel-header"><div><strong>Profiles</strong><span>Pick a starting point, tick the services other devices should reach, and apply. Applying always ends with the firewall on.</span></div></header>
        <div className="profile-grid" role="radiogroup" aria-label="Firewall profile">
          {overview?.profiles.map((profile) => (
            <label className={`profile-card${profileId === profile.id ? " selected" : ""}`} key={profile.id}>
              <span><input type="radio" name="firewall-profile" value={profile.id} checked={profileId === profile.id} onChange={() => setProfileId(profile.id)} /><strong>{profile.name}</strong>{profile.recommended && <span className="status-pill status-good">Recommended</span>}{overview.current?.id === profile.id && <span className="status-pill status-neutral">In force</span>}</span>
              <span>{profile.summary}</span>
              <span className="muted">{profile.detail}</span>
            </label>
          ))}
        </div>

        <div className="profile-options">
          <strong>Services other devices may reach</strong>
          {selectedProfile?.lockServices && <p className="muted">{selectedProfile.name} opens nothing on the LAN. Switch profile to pick services.</p>}
          <div className="service-grid">
            {overview?.services.map((service) => (
              <label key={service.id}>
                <input type="checkbox" checked={!selectedProfile?.lockServices && chosen.includes(service.id)} disabled={Boolean(selectedProfile?.lockServices)} onChange={(event) => toggleService(service.id, event.target.checked)} aria-label={service.name} />
                <span><strong>{service.name}</strong> <span className="muted">{service.ports.map((entry) => spec(entry.port, entry.protocol)).join(", ")} — {service.hint}</span></span>
              </label>
            ))}
          </div>
          <div className="service-grid">
            <label><input type="checkbox" checked={sshRateLimit} onChange={(event) => setSshRateLimit(event.target.checked)} aria-label="Rate-limit SSH logins" /><span><strong>Rate-limit SSH logins</strong> <span className="muted">6 new connections per 30 s per address; blunts password guessing without locking you out</span></span></label>
            <label><input type="checkbox" checked={replace} onChange={(event) => setReplace(event.target.checked)} aria-label="Start from scratch" /><span><strong>Start from scratch</strong> <span className="muted">remove every existing rule first (<code>ufw reset</code>), then apply the profile</span></span></label>
          </div>
        </div>

        <div className="profile-options">
          <strong>Always kept open</strong>
          <ul className="protected-list">
            {protectedRules.map((entry) => <li key={`${entry.port}/${entry.protocol}`}><code>{spec(entry.port, entry.protocol)}</code> {entry.label} — {entry.reason}{entry.allow ? "" : " (no LAN rule needed; it just cannot be denied)"}</li>)}
          </ul>
          <p className="muted">These cannot be denied or deleted from BoxPilot, so a profile or a typo can never lock you out.</p>
        </div>

        <div className="recovery-actions">
          <button className="primary-button" type="button" disabled={!selectedProfile || planning || loading} onClick={() => void reviewProfile()}>{planning ? "Preparing..." : "Review and apply"}</button>
          <span className="muted">You will see every command before anything runs; applying needs your password.</span>
        </div>
      </section>

      <Fail2banPanel start={start} refreshKey={refreshKey} />

      <section className="panel">
        <header className="panel-header"><div><strong>Rules</strong><span>Configured rules from ufw. Protected allow rules cannot be deleted from here.</span></div></header>
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
                      <td><span className={`status-pill ${rule.action === "allow" ? "status-good" : rule.action === "limit" ? "status-warning" : "status-danger"}`}>{rule.action}</span></td>
                      <td>{rule.app ?? rule.port ?? "any"}</td>
                      <td>{rule.protocol ?? "any"}</td>
                      <td>{rule.interface ? `on ${rule.interface}` : rule.direction === "out" ? "outgoing" : "incoming"}{rule.family === "v6" ? " (IPv6)" : ""}</td>
                      <td>{rule.comment ?? "—"}</td>
                    </>
                  )}
                  <td>
                    {!rule.raw && rule.port !== null && rule.port !== undefined && rule.app === null && ["allow", "deny", "limit"].includes(rule.action ?? "") && !rule.interface && (rule.action === "deny" || !isProtectedPort(rule.port, rule.protocol)) && (
                      <button className="text-button" type="button" onClick={() => start({
                        operationId: "firewall.rule.delete",
                        title: `Delete ${rule.action} ${spec(rule.port ?? 0, rule.protocol)}`,
                        parameters: { action: rule.action, port: rule.port, protocol: rule.protocol ?? "any" },
                        preview: <span><code>ufw delete {rule.action} {spec(rule.port ?? 0, rule.protocol)}</code></span>,
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
        <header className="panel-header"><div><strong>Add a rule</strong><span>Allow, deny, or rate-limit a port for tcp, udp, or both.</span></div></header>
        <div className="recovery-actions">
          <select aria-label="Rule action" value={action} onChange={(event) => setAction(event.target.value)}><option value="allow">Allow</option><option value="deny">Deny</option><option value="limit">Rate-limit</option></select>
          <input aria-label="Port" inputMode="numeric" placeholder="8096" value={port} onChange={(event) => setPort(event.target.value.trim())} />
          <select aria-label="Protocol" value={protocol} onChange={(event) => setProtocol(event.target.value)}><option value="tcp">tcp</option><option value="udp">udp</option><option value="any">tcp + udp</option></select>
          <input aria-label="Comment" placeholder="comment (optional)" value={comment} onChange={(event) => setComment(event.target.value)} />
          <button className="primary-button" type="button" disabled={!portValid || denyingProtected} onClick={() => start({
            operationId: "firewall.rule.add",
            title: `${action === "allow" ? "Allow" : action === "deny" ? "Deny" : "Rate-limit"} port ${portValue}`,
            parameters: { action, port: portValue, protocol, ...(comment.trim() ? { comment: comment.trim() } : {}) },
            preview: <span><code>ufw {action} {spec(portValue, protocol)}</code>{action === "limit" ? <> — allows up to 6 new connections per 30 seconds per address, then drops the rest.</> : null}</span>,
          })}>Add rule</button>
        </div>
        {protectedHit && <p className="muted" role="note">Port {spec(protectedHit.port, protectedHit.protocol)} is {protectedHit.label} and stays open: {protectedHit.reason}</p>}
      </section>
    </div>
  );
}
