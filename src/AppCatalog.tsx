import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { useOperation } from "./ApproveDialog";
import { inspectOperation } from "./operations";

/** Types mirror server/catalog/schema.mjs (normalized manifest) and server/app-helper.mjs (live state). */
interface ManifestPort { id: string; label: string; container: number; host: number; protocol: "tcp" | "udp"; exposure: "lan" | "loopback"; fixed: boolean }
interface ManifestVolume { id: string; label: string; container: string; path: string | null; hostPath: string | null; readOnly: boolean; backup: boolean; configurable: boolean; description: string | null }
interface ManifestEnv { name: string; label: string; description: string | null; type: "string" | "password" | "number" | "boolean" | "timezone" | "path"; default: string | number | boolean | null; required: boolean; secret: boolean; generate: boolean; options: string[] | null; fixed: boolean }
export interface Manifest {
  id: string; name: string; category: string; description: string; website: string | null; icon: string | null; risk: "low" | "medium" | "high"; notes: string | null;
  image: { reference: string; version: string | null; digestPinned: boolean };
  ports: ManifestPort[]; volumes: ManifestVolume[]; env: ManifestEnv[];
  health: { kind: string; stableSeconds: number; timeoutSeconds: number };
  sha256: string;
}
interface LiveState {
  id: string; installed: boolean; dataPresent: boolean;
  state: { installedAt: string; updatedAt: string; manifestSha256: string | null; image: { reference: string; id: string | null } | null; values: { ports: Record<string, number>; env: Record<string, string>; volumes: Record<string, string> }; pinnedRollback: boolean; uninstalledAt: string | null } | null;
  container: { exists: boolean; running: boolean; status: string; health: string; restarts: number; image: string | null };
  urls: Array<{ id: string; label: string; host: number; exposure: string }>;
  updateAvailable?: boolean;
  installedImage?: string | null;
}
interface CatalogResponse {
  applications: Array<{ manifest: Manifest; live: LiveState | null }>;
  problems: Array<{ file: string; errors: string[] }>;
  liveError: string | null;
  host: { lanAddress: string | null; tailscaleDnsName: string | null };
}

type Values = { ports: Record<string, number>; env: Record<string, string>; volumes: Record<string, string> };

function initialValues(manifest: Manifest, live: LiveState | null): Values {
  const stored = live?.state?.values;
  return {
    ports: Object.fromEntries(manifest.ports.map((port) => [port.id, stored?.ports?.[port.id] ?? port.host])),
    env: Object.fromEntries(manifest.env.filter((entry) => !entry.fixed && !entry.generate).map((entry) => [entry.name, stored?.env?.[entry.name] ?? (entry.default === null ? "" : String(entry.default))])),
    volumes: Object.fromEntries(manifest.volumes.filter((volume) => volume.configurable).map((volume) => [volume.id, stored?.volumes?.[volume.id] ?? volume.hostPath ?? ""])),
  };
}

/** Strip values that equal the manifest default so the server applies defaults and future manifest changes flow through. */
function compactValues(manifest: Manifest, values: Values): Values {
  const ports = Object.fromEntries(Object.entries(values.ports).filter(([id, host]) => manifest.ports.find((port) => port.id === id)?.host !== host));
  const env = Object.fromEntries(Object.entries(values.env).filter(([name, value]) => value !== "" && String(manifest.env.find((entry) => entry.name === name)?.default ?? "") !== value));
  const volumes = Object.fromEntries(Object.entries(values.volumes).filter(([id, path]) => path !== "" && manifest.volumes.find((volume) => volume.id === id)?.hostPath !== path));
  return { ports, env, volumes };
}

function ConfigForm({ manifest, live, mode, csrfToken, onSubmit, onCancel }: { manifest: Manifest; live: LiveState | null; mode: "install" | "reconfigure"; csrfToken: string; onSubmit: (values: Values) => void; onCancel: () => void }) {
  const [values, setValues] = useState<Values>(() => initialValues(manifest, live));
  const [checking, setChecking] = useState(false);
  const [problems, setProblems] = useState<string[]>([]);
  const submit = async () => {
    const compact = compactValues(manifest, values);
    setChecking(true); setProblems([]);
    try {
      const response = await fetch(`/api/v1/catalog/${encodeURIComponent(manifest.id)}/precheck`, { method: "POST", headers: { "Content-Type": "application/json", "X-BoxPilot-CSRF": csrfToken }, body: JSON.stringify({ values: compact }) });
      const body = (await response.json()) as { ok: boolean; errors: string[]; conflicts: Array<{ label: string; port: number; protocol: string; listeners: string[] }>; error?: string };
      if (!response.ok && body.errors?.length === 0) throw new Error(body.error ?? "Precheck failed");
      const found = [...(body.errors ?? []), ...(body.conflicts ?? []).map((conflict) => `${conflict.label}: port ${conflict.port}/${conflict.protocol} is already in use on this server (${conflict.listeners.join(", ")}). Pick another port.`)];
      if (found.length) { setProblems(found); return; }
      onSubmit(compact);
    } catch (requestError) {
      // Precheck is advisory: if it cannot run, continue and let the install report the real error.
      onSubmit(compact);
      void requestError;
    } finally {
      setChecking(false);
    }
  };
  const setPort = (id: string, value: string) => setValues((current) => ({ ...current, ports: { ...current.ports, [id]: Number.parseInt(value, 10) || 0 } }));
  const setEnv = (name: string, value: string) => setValues((current) => ({ ...current, env: { ...current.env, [name]: value } }));
  const setVolume = (id: string, value: string) => setValues((current) => ({ ...current, volumes: { ...current.volumes, [id]: value } }));
  const editablePorts = manifest.ports.filter((port) => !port.fixed);
  const editableEnv = manifest.env.filter((entry) => !entry.fixed && !entry.generate);
  const generated = manifest.env.filter((entry) => entry.generate);
  const editableVolumes = manifest.volumes.filter((volume) => volume.configurable);
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onCancel}>
      <section className="modal" role="dialog" aria-modal="true" aria-labelledby="config-title" onMouseDown={(event) => event.stopPropagation()}>
        <header className="modal-header"><div><span className="eyebrow">{mode === "install" ? "Install" : "Settings"}</span><h2 id="config-title">{manifest.name}</h2></div><button className="icon-button" type="button" onClick={onCancel} aria-label="Close dialog">X</button></header>
        <form className="modal-copy app-config-form" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
          {problems.length > 0 && <div className="auth-error" role="alert">{problems.map((problem) => <div key={problem}>{problem}</div>)}</div>}
          {editablePorts.length > 0 && <fieldset><legend>Ports</legend>{editablePorts.map((port) => <label key={port.id}>{port.label} <span className="muted">(container {port.container}/{port.protocol}, {port.exposure === "loopback" ? "this server only" : "LAN"})</span><input type="number" min={1} max={65535} value={values.ports[port.id] ?? port.host} onChange={(event) => setPort(port.id, event.target.value)} aria-label={`${port.label} port`} /></label>)}</fieldset>}
          {editableVolumes.length > 0 && <fieldset><legend>Folders</legend>{editableVolumes.map((volume) => <label key={volume.id}>{volume.label}{volume.description && <span className="muted"> — {volume.description}</span>}<input type="text" value={values.volumes[volume.id] ?? ""} onChange={(event) => setVolume(volume.id, event.target.value)} aria-label={`${volume.label} path`} placeholder={volume.hostPath ?? "/srv/..."} /></label>)}</fieldset>}
          {editableEnv.length > 0 && <fieldset><legend>Settings</legend>{editableEnv.map((entry) => (
            <label key={entry.name}>{entry.label}{entry.required && " *"}{entry.description && <span className="muted"> — {entry.description}</span>}
              {entry.options ? <select value={values.env[entry.name] ?? ""} onChange={(event) => setEnv(entry.name, event.target.value)} aria-label={entry.label}>{entry.options.map((option) => <option key={option} value={option}>{option}</option>)}</select>
                : entry.type === "boolean" ? <select value={values.env[entry.name] || "false"} onChange={(event) => setEnv(entry.name, event.target.value)} aria-label={entry.label}><option value="true">Yes</option><option value="false">No</option></select>
                : <input type={entry.type === "password" ? "password" : entry.type === "number" ? "number" : "text"} value={values.env[entry.name] ?? ""} onChange={(event) => setEnv(entry.name, event.target.value)} aria-label={entry.label} required={entry.required} />}
            </label>
          ))}</fieldset>}
          {generated.length > 0 && <p className="muted">Generated for you: {generated.map((entry) => entry.label).join(", ")} (stored in the app's .env on the server).</p>}
          {manifest.volumes.filter((volume) => volume.path).length > 0 && <p className="muted">Data lives under <code>/var/lib/boxpilot-managed/catalog/{manifest.id}/</code> and is kept on uninstall unless you delete it explicitly.</p>}
          <footer className="recovery-actions"><button className="secondary-button" type="button" onClick={onCancel}>Cancel</button><button className="primary-button" type="submit" disabled={checking}>{checking ? "Checking..." : mode === "install" ? "Continue to install" : "Apply settings"}</button></footer>
        </form>
      </section>
    </div>
  );
}

export default function AppCatalog({ csrfToken }: { csrfToken: string }) {
  const [data, setData] = useState<CatalogResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [config, setConfig] = useState<{ manifest: Manifest; live: LiveState | null; mode: "install" | "reconfigure" } | null>(null);
  const [logs, setLogs] = useState<{ id: string; lines: string[] } | null>(null);
  const [effectiveConfig, setEffectiveConfig] = useState<{ id: string; name: string; compose: string | null; env: Array<{ name: string; value: string; secret: boolean }>; directory: string } | null>(null);
  const [composeDraft, setComposeDraft] = useState<string | null>(null);
  const [appBackups, setAppBackups] = useState<{ id: string; name: string; backups: Array<{ artifact: string; createdAt: string | null; sizeBytes: number | null; downtimeMs: number | null; skippedHostPaths: string[]; image: string | null }> } | null>(null);
  const [secrets, setSecrets] = useState<{ id: string; name: string; items: Array<{ name: string; label: string; value: string }> | null; needsPassword: boolean; password: string; error: string | null } | null>(null);
  const [filter, setFilter] = useState("");
  const [serves, setServes] = useState<Array<{ dnsName: string; port: number; target: string | null }> | null>(null);
  const [stats, setStats] = useState<Record<string, { cpuPercent: number; memBytes: number; containers: number }> | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch("/api/v1/catalog");
      const body = (await response.json()) as CatalogResponse & { error?: string };
      if (!response.ok) throw new Error(body.error ?? "Could not load the catalog");
      setData(body);
      setError(null);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Could not load the catalog");
    } finally {
      setLoading(false);
    }
    // Tailnet publishing and live resource use are optional garnish: failures hide them.
    inspectOperation<{ available: boolean; serves: Array<{ dnsName: string; port: number; target: string | null }> }>("app.serve.inspect")
      .then(({ result }) => setServes(result.available ? result.serves : null))
      .catch(() => setServes(null));
    inspectOperation<{ available: boolean; stats: Record<string, { cpuPercent: number; memBytes: number; containers: number }> }>("app.stats.inspect")
      .then(({ result }) => setStats(result.available ? result.stats : null))
      .catch(() => setStats(null));
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);

  const { start, dialog } = useOperation(csrfToken, () => { void refresh(); });

  const showLogs = async (id: string) => {
    try {
      const response = await fetch("/api/v1/operations/app.logs/run", { method: "POST", headers: { "Content-Type": "application/json", "X-BoxPilot-CSRF": csrfToken }, body: JSON.stringify({ parameters: { id, lines: 200 } }) });
      const body = (await response.json()) as { result?: { lines: string[] }; error?: string };
      if (!response.ok) throw new Error(body.error ?? "Could not read logs");
      setLogs({ id, lines: body.result?.lines ?? [] });
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Could not read logs");
    }
  };

  const showEffectiveConfig = async (id: string) => {
    try {
      const response = await fetch("/api/v1/operations/app.config.inspect/run", { method: "POST", headers: { "Content-Type": "application/json", "X-BoxPilot-CSRF": csrfToken }, body: JSON.stringify({ parameters: { id } }) });
      const body = (await response.json()) as { result?: { id: string; name: string; compose: string | null; env: Array<{ name: string; value: string; secret: boolean }>; directory: string }; error?: string };
      if (!response.ok || !body.result) throw new Error(body.error ?? "Could not read the configuration");
      setEffectiveConfig(body.result);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Could not read the configuration");
    }
  };

  const showBackups = async (manifest: Manifest) => {
    try {
      const response = await fetch("/api/v1/operations/app.backups.inspect/run", { method: "POST", headers: { "Content-Type": "application/json", "X-BoxPilot-CSRF": csrfToken }, body: JSON.stringify({ parameters: { id: manifest.id } }) });
      const body = (await response.json()) as { result?: { id: string; backups: Array<{ artifact: string; createdAt: string | null; sizeBytes: number | null; downtimeMs: number | null; skippedHostPaths: string[]; image: string | null }> }; error?: string };
      if (!response.ok || !body.result) throw new Error(body.error ?? "Could not list backups");
      setAppBackups({ id: manifest.id, name: manifest.name, backups: body.result.backups });
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Could not list backups");
    }
  };

  const revealSecrets = async (manifest: Manifest, password?: string) => {
    try {
      if (password) {
        const elevate = await fetch("/api/v1/auth/elevate", { method: "POST", headers: { "Content-Type": "application/json", "X-BoxPilot-CSRF": csrfToken }, body: JSON.stringify({ password }) });
        if (!elevate.ok) { const body = (await elevate.json()) as { error?: string }; throw new Error(body.error ?? "Invalid password"); }
        window.dispatchEvent(new Event("boxpilot:auth-changed"));
      }
      const response = await fetch("/api/v1/operations/app.secrets/run", { method: "POST", headers: { "Content-Type": "application/json", "X-BoxPilot-CSRF": csrfToken }, body: JSON.stringify({ parameters: { id: manifest.id } }) });
      const body = (await response.json()) as { result?: { secrets: Array<{ name: string; label: string; value: string }> }; error?: string; code?: string };
      if (response.status === 401 && body.code === "elevation_required") { setSecrets({ id: manifest.id, name: manifest.name, items: null, needsPassword: true, password: "", error: null }); return; }
      if (!response.ok) throw new Error(body.error ?? "Could not read secrets");
      setSecrets({ id: manifest.id, name: manifest.name, items: body.result?.secrets ?? [], needsPassword: false, password: "", error: null });
    } catch (requestError) {
      setSecrets((current) => ({ id: manifest.id, name: manifest.name, items: null, needsPassword: true, password: "", error: requestError instanceof Error ? requestError.message : "Could not read secrets", ...(current ? {} : {}) }));
    }
  };

  const categories = useMemo(() => [...new Set((data?.applications ?? []).map((entry) => entry.manifest.category))].sort(), [data]);
  const visible = useMemo(() => (data?.applications ?? []).filter((entry) => !filter || entry.manifest.category === filter), [data, filter]);
  const hostForLinks = data?.host.lanAddress ?? window.location.hostname;

  const openUrl = (port: { host: number; exposure: string }, manifest: Manifest) => `${manifest.id === "portainer" ? "https" : "http"}://${port.exposure === "loopback" ? "127.0.0.1" : hostForLinks}:${port.host}`;

  const statusPill = (live: LiveState | null): ReactNode => {
    if (!live) return <span className="status-pill status-neutral">Unknown</span>;
    if (!live.installed) return live.dataPresent ? <span className="status-pill status-neutral">Not installed · data kept</span> : <span className="status-pill status-neutral">Not installed</span>;
    if (live.container.running) return <span className={`status-pill ${live.container.health === "unhealthy" ? "status-warning" : "status-good"}`}>{live.container.health === "unhealthy" ? "Running · unhealthy" : "Running"}</span>;
    return <span className="status-pill status-warning">Stopped</span>;
  };

  return (
    <div className="app-catalog">
      {dialog}
      {config && <ConfigForm manifest={config.manifest} live={config.live} mode={config.mode} csrfToken={csrfToken} onCancel={() => setConfig(null)} onSubmit={(values) => {
        const { manifest, mode } = config;
        setConfig(null);
        start({ operationId: mode === "install" ? "app.install" : "app.reconfigure", title: mode === "install" ? `Install ${manifest.name}` : `Change ${manifest.name} settings`, parameters: { id: manifest.id, values }, preview: <span>{mode === "install" ? `Pulls ${manifest.image.reference}, starts it with the settings you chose, and waits until it is healthy. Rolled back automatically if it fails.` : "Recreates the container with the new settings; the previous configuration is restored if it fails."}</span> });
      }} />}
      {logs && (
        <div className="modal-backdrop" role="presentation" onMouseDown={() => setLogs(null)}>
          <section className="modal" role="dialog" aria-modal="true" aria-labelledby="logs-title" onMouseDown={(event) => event.stopPropagation()}>
            <header className="modal-header"><div><span className="eyebrow">Logs</span><h2 id="logs-title">{logs.id}</h2></div><button className="icon-button" type="button" onClick={() => setLogs(null)} aria-label="Close dialog">X</button></header>
            <pre className="app-logs">{logs.lines.join("\n") || "(no output)"}</pre>
          </section>
        </div>
      )}

      {appBackups && (
        <div className="modal-backdrop" role="presentation" onMouseDown={() => setAppBackups(null)}>
          <section className="modal" role="dialog" aria-modal="true" aria-labelledby="backups-title" onMouseDown={(event) => event.stopPropagation()}>
            <header className="modal-header"><div><span className="eyebrow">Backups</span><h2 id="backups-title">{appBackups.name}</h2></div><button className="icon-button" type="button" onClick={() => setAppBackups(null)} aria-label="Close dialog">X</button></header>
            <div className="modal-copy">
              {appBackups.backups.length === 0 && <p>No backups yet. Back up creates a consistent archive of the app's data and configuration.</p>}
              {appBackups.backups.length > 0 && (
                <div className="table-scroll">
                  <table>
                    <thead><tr><th>Created</th><th>Size</th><th aria-label="Actions" /></tr></thead>
                    <tbody>
                      {appBackups.backups.map((backup) => (
                        <tr key={backup.artifact}>
                          <td>{backup.createdAt ? new Date(backup.createdAt).toLocaleString() : backup.artifact}</td>
                          <td>{backup.sizeBytes !== null ? `${(backup.sizeBytes / 1024 / 1024).toFixed(1)} MiB` : "—"}</td>
                          <td>
                            <div className="recovery-actions">
                              <button className="text-button" type="button" onClick={() => { const target = appBackups; setAppBackups(null); start({ operationId: "app.backup.restore", title: `Restore ${target.name} from ${backup.createdAt ? new Date(backup.createdAt).toLocaleString() : backup.artifact}`, parameters: { id: target.id, backup: backup.artifact }, preview: <span>Saves the current state as a safety copy first, then replaces {target.name}'s data and configuration with this backup and starts it.</span> }); }}>Restore</button>
                              <button className="text-button" type="button" onClick={() => { const target = appBackups; setAppBackups(null); start({ operationId: "app.backup.delete", title: `Delete backup of ${target.name}`, parameters: { id: target.id, backup: backup.artifact }, preview: <span>Deletes the archive from {backup.createdAt ? new Date(backup.createdAt).toLocaleString() : backup.artifact}. This cannot be undone.</span> }); }}>Delete</button>
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              {appBackups.backups.some((backup) => backup.skippedHostPaths.length > 0) && <p className="muted">Volumes at operator-managed host paths are not included: {[...new Set(appBackups.backups.flatMap((backup) => backup.skippedHostPaths))].join(", ")}</p>}
            </div>
          </section>
        </div>
      )}

      {effectiveConfig && (
        <div className="modal-backdrop" role="presentation" onMouseDown={() => { setEffectiveConfig(null); setComposeDraft(null); }}>
          <section className="modal" role="dialog" aria-modal="true" aria-labelledby="config-title" onMouseDown={(event) => event.stopPropagation()}>
            <header className="modal-header"><div><span className="eyebrow">Effective configuration</span><h2 id="config-title">{effectiveConfig.name}</h2></div><button className="icon-button" type="button" onClick={() => { setEffectiveConfig(null); setComposeDraft(null); }} aria-label="Close dialog">X</button></header>
            <div className="modal-copy">
              <p>What BoxPilot wrote under <code>{effectiveConfig.directory}</code>. Secret values are masked; use Secrets to reveal them.</p>
              {effectiveConfig.env.length > 0 && composeDraft === null && (
                <>
                  <strong>.env</strong>
                  <pre className="app-logs">{effectiveConfig.env.map((entry) => `${entry.name}=${entry.value}`).join("\n")}</pre>
                </>
              )}
              <strong>compose.yaml</strong>
              {composeDraft === null ? (
                <>
                  <pre className="app-logs">{effectiveConfig.compose ?? "(missing)"}</pre>
                  {effectiveConfig.compose && <footer className="recovery-actions"><button className="secondary-button" type="button" onClick={() => setComposeDraft(effectiveConfig.compose)}>Edit raw</button></footer>}
                </>
              ) : (
                <>
                  <p className="muted">Full control, full responsibility: docker compose validates the file and BoxPilot rolls back if the app does not come up — but the next Settings change or Update regenerates it from the manifest.</p>
                  <textarea aria-label="Compose file" className="compose-editor" spellCheck="false" rows={16} value={composeDraft} onChange={(event) => setComposeDraft(event.target.value)} />
                  <footer className="recovery-actions">
                    <button className="secondary-button" type="button" onClick={() => setComposeDraft(null)}>Cancel</button>
                    <button className="primary-button" type="button" disabled={!composeDraft.trim() || composeDraft === effectiveConfig.compose} onClick={() => { const draft = composeDraft; const target = effectiveConfig; setEffectiveConfig(null); setComposeDraft(null); start({ operationId: "app.compose.edit", title: `Apply edited compose file to ${target.name}`, parameters: { id: target.id, compose: draft }, preview: <span>Replaces <code>compose.yaml</code> verbatim and recreates the containers. Rolled back if {target.name} does not come up.</span> }); }}>Apply</button>
                  </footer>
                </>
              )}
            </div>
          </section>
        </div>
      )}

      {secrets && (
        <div className="modal-backdrop" role="presentation" onMouseDown={() => setSecrets(null)}>
          <section className="modal" role="dialog" aria-modal="true" aria-labelledby="secrets-title" onMouseDown={(event) => event.stopPropagation()}>
            <header className="modal-header"><div><span className="eyebrow">Secrets</span><h2 id="secrets-title">{secrets.name}</h2></div><button className="icon-button" type="button" onClick={() => setSecrets(null)} aria-label="Close dialog">X</button></header>
            <div className="modal-copy">
              {secrets.needsPassword ? (
                <>
                  <p>Enter your owner password to reveal generated passwords and tokens. This unlocks high-risk actions for 10 minutes and is recorded in the audit log.</p>
                  <input aria-label="Owner password" type="password" autoComplete="current-password" value={secrets.password} onChange={(event) => setSecrets({ ...secrets, password: event.target.value })} />
                  {secrets.error && <div className="auth-error" role="alert">{secrets.error}</div>}
                  <footer className="recovery-actions"><button className="primary-button" type="button" disabled={secrets.password.length < 12} onClick={() => { const manifest = data?.applications.find((entry) => entry.manifest.id === secrets.id)?.manifest; if (manifest) void revealSecrets(manifest, secrets.password); }}>Reveal</button></footer>
                </>
              ) : (
                <>
                  {secrets.items && secrets.items.length === 0 && <p>This app has no generated secrets.</p>}
                  {secrets.items?.map((item) => <label key={item.name}>{item.label}<input readOnly value={item.value} aria-label={item.label} onFocus={(event) => event.currentTarget.select()} /></label>)}
                  <p className="muted">Stored in the app's <code>.env</code> on the server. Copy what you need, then close.</p>
                </>
              )}
            </div>
          </section>
        </div>
      )}

      <div className="recovery-actions app-catalog-toolbar">
        <button className={`secondary-button${filter === "" ? " is-active" : ""}`} type="button" onClick={() => setFilter("")}>All</button>
        {categories.map((category) => <button key={category} className={`secondary-button${filter === category ? " is-active" : ""}`} type="button" onClick={() => setFilter(category)}>{category}</button>)}
        <span className="muted">{loading ? "Loading…" : `${data?.applications.length ?? 0} apps in catalog`}</span>
        <button className="text-button" type="button" onClick={() => void refresh()}>Refresh</button>
      </div>
      {error && <div className="auth-error" role="alert">{error}</div>}
      {data?.liveError && <div className="notice warning-notice"><strong>Live state unavailable</strong><span>{data.liveError}</span></div>}
      {data?.problems.map((problem) => <div key={problem.file} className="notice warning-notice"><strong>Catalog file {problem.file} was skipped</strong><span>{problem.errors.join("; ")}</span></div>)}

      <div className="app-grid">
        {visible.map(({ manifest, live }) => {
          const installed = Boolean(live?.installed);
          const running = Boolean(live?.container.running);
          return (
            <article key={manifest.id} className="panel app-card">
              <header className="app-card-header">
                <div><span className="app-icon" aria-hidden="true">{manifest.icon ?? "📦"}</span></div>
                <div><strong>{manifest.name}</strong><span className="muted">{manifest.category} · {manifest.image.version ?? manifest.image.reference}</span></div>
                {statusPill(live)}
              </header>
              <p>{manifest.description}</p>
              {installed && stats?.[manifest.id] && (
                <p className="muted app-stats">CPU {stats[manifest.id].cpuPercent.toFixed(1)}% · {(stats[manifest.id].memBytes / 1024 / 1024).toFixed(0)} MiB{stats[manifest.id].containers > 1 ? ` · ${stats[manifest.id].containers} containers` : ""}</p>
              )}
              {installed && live?.urls.length ? (
                <div className="recovery-actions">
                  {live.urls.map((port) => <a key={port.id} className="secondary-button" href={openUrl(port, manifest)} target="_blank" rel="noreferrer">Open {port.label}</a>)}
                  {(() => {
                    if (serves === null) return null;
                    const primaryPort = live.urls[0]?.host;
                    const served = serves.find((serve) => serve.port === primaryPort);
                    return served
                      ? <><a className="secondary-button" href={`https://${served.dnsName}:${served.port}`} target="_blank" rel="noreferrer">Open on tailnet 🔒</a><button className="text-button" type="button" onClick={() => start({ operationId: "app.serve.set", title: `Stop serving ${manifest.name} on the tailnet`, parameters: { id: manifest.id, enabled: false }, preview: <span><code>tailscale serve --https={served.port} off</code>. LAN access is unchanged.</span> })}>Stop tailnet HTTPS</button></>
                      : <button className="text-button" type="button" onClick={() => start({ operationId: "app.serve.set", title: `Serve ${manifest.name} on the tailnet`, parameters: { id: manifest.id, enabled: true }, preview: <span>Publishes port {primaryPort} at <code>https://…ts.net:{primaryPort}</code> with a real certificate — reachable from your tailnet only; Funnel stays off.</span> })}>Serve on tailnet (HTTPS)</button>;
                  })()}
                </div>
              ) : null}
              <footer className="recovery-actions">
                {!installed && <button className="primary-button" type="button" onClick={() => setConfig({ manifest, live, mode: "install" })}>Install</button>}
                {installed && (running
                  ? <><button className="secondary-button" type="button" onClick={() => start({ operationId: "app.action", title: `Restart ${manifest.name}`, parameters: { id: manifest.id, action: "restart" } })}>Restart</button><button className="secondary-button" type="button" onClick={() => start({ operationId: "app.action", title: `Stop ${manifest.name}`, parameters: { id: manifest.id, action: "stop" } })}>Stop</button></>
                  : <button className="primary-button" type="button" onClick={() => start({ operationId: "app.action", title: `Start ${manifest.name}`, parameters: { id: manifest.id, action: "start" } })}>Start</button>)}
                {installed && <button className="secondary-button" type="button" onClick={() => setConfig({ manifest, live, mode: "reconfigure" })}>Settings</button>}
                {installed && <button className={live?.updateAvailable ? "primary-button" : "secondary-button"} type="button" onClick={() => start({ operationId: "app.update", title: `Update ${manifest.name}`, parameters: { id: manifest.id }, preview: <span>{live?.updateAvailable ? <>Updates from <code>{live.installedImage}</code> to <code>{manifest.image.reference}</code>. </> : null}Pulls the image and recreates the container. The previous image is restored if the new one fails to become healthy.</span> })}>{live?.updateAvailable ? "Update available" : "Update"}</button>}
                {installed && <button className="text-button" type="button" onClick={() => void showLogs(manifest.id)}>Logs</button>}
                {installed && <button className="text-button" type="button" onClick={() => void showEffectiveConfig(manifest.id)}>Config</button>}
                {installed && <button className="text-button" type="button" onClick={() => start({ operationId: "app.backup", title: `Back up ${manifest.name}`, parameters: { id: manifest.id }, preview: <span>Stops {manifest.name} briefly, archives its data and configuration, restarts it, and keeps the newest 5 copies.</span> })}>Back up</button>}
                {(installed || live?.dataPresent) && <button className="text-button" type="button" onClick={() => void showBackups(manifest)}>Backups</button>}
                {installed && manifest.env.some((entry) => entry.secret) && <button className="text-button" type="button" onClick={() => void revealSecrets(manifest)}>Secrets</button>}
                {installed && <button className="text-button" type="button" onClick={() => start({ operationId: "app.uninstall", title: `Uninstall ${manifest.name}`, parameters: { id: manifest.id }, preview: <span>Stops and removes the container. Data under the app directory is kept so you can reinstall later.</span> })}>Uninstall</button>}
                {live?.dataPresent && <button className="text-button danger-text" type="button" onClick={() => start({ operationId: "app.purge", title: `Delete ${manifest.name} and its data`, parameters: { id: manifest.id }, preview: <span>Removes the container <strong>and deletes everything</strong> under the app's data directory. This cannot be undone.</span> })}>Delete data</button>}
                {manifest.website && <a className="text-button" href={manifest.website} target="_blank" rel="noreferrer">Website</a>}
              </footer>
              {manifest.notes && installed && <p className="muted app-notes">{manifest.notes}</p>}
            </article>
          );
        })}
      </div>
    </div>
  );
}
