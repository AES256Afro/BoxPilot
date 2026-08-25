import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { useOperation } from "./ApproveDialog";
import { inspectOperation } from "./operations";
import { appUrl } from "./appLinks";

/** Types mirror server/catalog/schema.mjs (normalized manifest) and server/app-helper.mjs (live state). */
interface ManifestPort { id: string; label: string; container: number; host: number; protocol: "tcp" | "udp"; exposure: "lan" | "loopback"; fixed: boolean; tailnet?: "serve" | "address" | "unchanged" }
interface ManifestVolume { id: string; label: string; container: string; path: string | null; hostPath: string | null; readOnly: boolean; backup: boolean; configurable: boolean; description: string | null }
interface SetupChoice { id: string; label: string; description: string | null; website: string | null; recommended: boolean; exec: string[] }
interface ManifestSetup { title: string; note: string | null; finalize: string[] | null; finalizeLabel: string | null; choices: SetupChoice[] }
interface ManifestEnv { name: string; label: string; description: string | null; type: "string" | "password" | "number" | "boolean" | "timezone" | "path"; default: string | number | boolean | null; required: boolean; secret: boolean; generate: boolean; options: string[] | null; fixed: boolean }
export interface Manifest {
  id: string; name: string; category: string; description: string; website: string | null; icon: string | null; risk: "low" | "medium" | "high"; notes: string | null;
  image: { reference: string; version: string | null; digestPinned: boolean };
  ports: ManifestPort[]; volumes: ManifestVolume[]; env: ManifestEnv[];
  health: { kind: string; stableSeconds: number; timeoutSeconds: number };
  setup?: ManifestSetup | null;
  signIn?: { path: string | null; port: string | null; username: string | null; usernameEnv: string | null; passwordEnv: string; note: string | null } | null;
  network?: string;
  networkModes?: string[];
  sha256: string;
}
interface LiveState {
  id: string; installed: boolean; dataPresent: boolean;
  state: { installedAt: string; updatedAt: string; manifestSha256: string | null; image: { reference: string; id: string | null } | null; values: { ports: Record<string, number>; env: Record<string, string>; volumes: Record<string, string>; setup?: string[]; exposure?: "lan" | "tailnet"; networkMode?: string }; pinnedRollback: boolean; uninstalledAt: string | null } | null;
  container: { exists: boolean; running: boolean; status: string; health: string; restarts: number; image: string | null };
  urls: Array<{ id: string; label: string; host: number; exposure: string; path?: string | null }>;
  updateAvailable?: boolean;
  installedImage?: string | null;
}
interface CatalogResponse {
  applications: Array<{ manifest: Manifest; live: LiveState | null }>;
  problems: Array<{ file: string; errors: string[] }>;
  liveError: string | null;
  host: { lanAddress: string | null; tailscaleDnsName: string | null };
}

type Values = { ports: Record<string, number>; env: Record<string, string>; volumes: Record<string, string>; setup?: string[]; networkMode?: string };

function initialValues(manifest: Manifest, live: LiveState | null): Values {
  const stored = live?.state?.values;
  return {
    ports: Object.fromEntries(manifest.ports.map((port) => [port.id, stored?.ports?.[port.id] ?? port.host])),
    env: Object.fromEntries(manifest.env.filter((entry) => !entry.fixed && !entry.generate).map((entry) => [entry.name, stored?.env?.[entry.name] ?? (entry.default === null ? "" : String(entry.default))])),
    volumes: Object.fromEntries(manifest.volumes.filter((volume) => volume.configurable).map((volume) => [volume.id, stored?.volumes?.[volume.id] ?? volume.hostPath ?? ""])),
    // Setup choices (blocklists, plugins): what was chosen before, else the manifest's recommendations.
    ...(manifest.setup ? { setup: stored?.setup ?? manifest.setup.choices.filter((choice) => choice.recommended).map((choice) => choice.id) } : {}),
    ...((manifest.networkModes?.length ?? 0) > 1 ? { networkMode: stored?.networkMode ?? manifest.networkModes?.[0] } : {}),
  };
}

/** Strip values that equal the manifest default so the server applies defaults and future manifest changes flow through. */
function compactValues(manifest: Manifest, values: Values): Values {
  const ports = Object.fromEntries(Object.entries(values.ports).filter(([id, host]) => manifest.ports.find((port) => port.id === id)?.host !== host));
  const env = Object.fromEntries(Object.entries(values.env).filter(([name, value]) => value !== "" && String(manifest.env.find((entry) => entry.name === name)?.default ?? "") !== value));
  const volumes = Object.fromEntries(Object.entries(values.volumes).filter(([id, path]) => path !== "" && manifest.volumes.find((volume) => volume.id === id)?.hostPath !== path));
  // Setup choices are always sent explicitly: an empty list means "none", not "the defaults".
  return { ports, env, volumes, ...((manifest.networkModes?.length ?? 0) > 1 && values.networkMode ? { networkMode: values.networkMode } : {}), ...(manifest.setup ? { setup: values.setup ?? [] } : {}) };
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
      const body = (await response.json().catch(() => ({}))) as { ok: boolean; errors: string[]; conflicts: Array<{ label: string; port: number; protocol: string; listeners: string[] }>; error?: string };
      if (!response.ok && !body.errors?.length) throw new Error(body.error ?? "Precheck failed");
      const found = [...(body.errors ?? []), ...(body.conflicts ?? []).map((conflict) => {
        const held = conflict.listeners.join(", ");
        // "Pick another port" is useless advice for a DNS server, and resolved is the usual culprit.
        const resolved = conflict.port === 53 && held.includes("127.0.0.53");
        return resolved
          ? `Port 53 is held by Ubuntu's own resolver (${held}). Set DNSStubListener=no in /etc/systemd/resolved.conf, restart systemd-resolved, then install again.`
          : `${conflict.label}: port ${conflict.port}/${conflict.protocol} is already in use on this server (${held}). Pick another port.`;
      })];
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
  const toggleSetup = (id: string, checked: boolean) => setValues((current) => ({ ...current, setup: checked ? [...new Set([...(current.setup ?? []), id])] : (current.setup ?? []).filter((entry) => entry !== id) }));
  const editablePorts = manifest.ports.filter((port) => !port.fixed);
  const editableEnv = manifest.env.filter((entry) => !entry.fixed && !entry.generate);
  const generated = manifest.env.filter((entry) => entry.generate);
  // A password the app signs you in with is worth choosing yourself; the rest (database
  // passwords, session secrets) nobody ever types, so those stay generated and out of the way.
  const choosable = generated.filter((entry) => entry.name === manifest.signIn?.passwordEnv);
  const generatedQuietly = generated.filter((entry) => !choosable.includes(entry));
  const editableVolumes = manifest.volumes.filter((volume) => volume.configurable);
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onCancel}>
      <section className="modal" role="dialog" aria-modal="true" aria-labelledby="config-title" onMouseDown={(event) => event.stopPropagation()}>
        <header className="modal-header"><div><span className="eyebrow">{mode === "install" ? "Install" : "Settings"}</span><h2 id="config-title">{manifest.name}</h2></div><button className="icon-button" type="button" onClick={onCancel} aria-label="Close dialog">X</button></header>
        <form className="modal-copy app-config-form" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
          {problems.length > 0 && <div className="auth-error" role="alert">{problems.map((problem) => <div key={problem}>{problem}</div>)}</div>}
          {(manifest.networkModes?.length ?? 0) > 1 && <fieldset><legend>Network</legend>
            <label>How Pi-hole and friends see your devices
              <select value={values.networkMode ?? manifest.networkModes?.[0]} onChange={(event) => setValues((current) => ({ ...current, networkMode: event.target.value }))} aria-label="Network mode">
                {manifest.networkModes?.map((networkMode) => <option key={networkMode} value={networkMode}>{networkMode === "host" ? "Host — sees each device on your network by address and name" : "Bridge — isolated; every device appears as one client"}</option>)}
              </select>
              <span className="muted">{(values.networkMode ?? manifest.networkModes?.[0]) === "host"
                ? "Shares this server's network, so the app sees real client addresses. Its ports become this server's ports (the admin UI moves to port 80), and it cannot use a bundled recursive resolver."
                : "Runs behind Docker's own network. Safer isolation, but every device reaches it through one address, so per-device rules and client lists do not work."}</span>
            </label>
          </fieldset>}
          {editablePorts.length > 0 && <fieldset><legend>Ports</legend>{editablePorts.map((port) => <label key={port.id}>{port.label} <span className="muted">(container {port.container}/{port.protocol}, {port.exposure === "loopback" ? "this server only" : "LAN"})</span><input type="number" min={1} max={65535} value={values.ports[port.id] ?? port.host} onChange={(event) => setPort(port.id, event.target.value)} aria-label={`${port.label} port`} /></label>)}</fieldset>}
          {editableVolumes.length > 0 && <fieldset><legend>Folders</legend>{editableVolumes.map((volume) => <label key={volume.id}>{volume.label}{volume.description && <span className="muted"> — {volume.description}</span>}<input type="text" value={values.volumes[volume.id] ?? ""} onChange={(event) => setVolume(volume.id, event.target.value)} aria-label={`${volume.label} path`} placeholder={volume.hostPath ?? "/srv/..."} /></label>)}</fieldset>}
          {editableEnv.length > 0 && <fieldset><legend>Settings</legend>{editableEnv.map((entry) => (
            <label key={entry.name}>{entry.label}{entry.required && " *"}{entry.description && <span className="muted"> — {entry.description}</span>}
              {entry.options ? <select value={values.env[entry.name] ?? ""} onChange={(event) => setEnv(entry.name, event.target.value)} aria-label={entry.label}>{entry.options.map((option) => <option key={option} value={option}>{option}</option>)}</select>
                : entry.type === "boolean" ? <select value={values.env[entry.name] || "false"} onChange={(event) => setEnv(entry.name, event.target.value)} aria-label={entry.label}><option value="true">Yes</option><option value="false">No</option></select>
                : <input type={entry.type === "password" ? "password" : entry.type === "number" ? "number" : "text"} value={values.env[entry.name] ?? ""} onChange={(event) => setEnv(entry.name, event.target.value)} aria-label={entry.label} required={entry.required} />}
            </label>
          ))}</fieldset>}
          {manifest.setup && manifest.setup.choices.length > 0 && (
            <fieldset className="setup-choices"><legend>{manifest.setup.title}</legend>
              {manifest.setup.note && <p className="muted">{manifest.setup.note}</p>}
              {manifest.setup.choices.map((choice) => (
                <div className="setup-choice" key={choice.id}>
                  <label><input type="checkbox" checked={(values.setup ?? []).includes(choice.id)} onChange={(event) => toggleSetup(choice.id, event.target.checked)} aria-label={choice.label} /> <strong>{choice.label}</strong>{choice.recommended && <span className="status-pill status-good">Recommended</span>}</label>
                  {(choice.description || choice.website) && <span className="muted">{choice.description}{choice.website && <> <a href={choice.website} target="_blank" rel="noreferrer">Learn more</a></>}</span>}
                </div>
              ))}
            </fieldset>
          )}
          {choosable.length > 0 && <fieldset><legend>Sign-in</legend>{choosable.map((entry) => (
            <label key={entry.name}>{entry.label}<span className="muted"> — leave empty to have one generated for you; you can see or change it from the app's card afterwards.</span>
              <input type="password" autoComplete="new-password" minLength={8} maxLength={128} value={values.env[entry.name] ?? ""} onChange={(event) => setEnv(entry.name, event.target.value)} aria-label={entry.label} placeholder={mode === "install" ? "Generate one for me" : "Unchanged"} />
            </label>
          ))}</fieldset>}
          {generatedQuietly.length > 0 && <p className="muted">Generated for you: {generatedQuietly.map((entry) => entry.label).join(", ")} (stored in the app's .env on the server).</p>}
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
  const [appBackups, setAppBackups] = useState<{ id: string; name: string; backups: Array<{ artifact: string; createdAt: string | null; sizeBytes: number | null; downtimeMs: number | null; skippedHostPaths: string[]; skippedVolumes?: string[]; image: string | null }> } | null>(null);
  const [browsing, setBrowsing] = useState<{ backup: string; files: Array<{ path: string; sizeBytes: number; type: string }>; truncated: boolean; filter: string } | null>(null);
  const browseBackup = async (id: string, backup: string) => {
    try {
      const response = await fetch("/api/v1/operations/app.backup.files/run", { method: "POST", headers: { "Content-Type": "application/json", "X-BoxPilot-CSRF": csrfToken }, body: JSON.stringify({ parameters: { id, backup } }) });
      const body = (await response.json().catch(() => ({}))) as { result?: { files: Array<{ path: string; sizeBytes: number; type: string }>; truncated: boolean }; error?: string };
      if (!response.ok || !body.result) throw new Error(body.error ?? "Could not read the backup");
      setBrowsing({ backup, files: body.result.files, truncated: body.result.truncated, filter: "" });
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Could not read the backup");
    }
  };
  const [secrets, setSecrets] = useState<{ id: string; name: string; items: Array<{ name: string; label: string; value: string }> | null; needsPassword: boolean; password: string; error: string | null; signIn?: boolean; newPassword?: string } | null>(null);
  const [filter, setFilter] = useState("");
  const [search, setSearch] = useState("");
  const [serves, setServes] = useState<Array<{ dnsName: string; port: number; target: string | null }> | null>(null);
  const [stats, setStats] = useState<Record<string, { cpuPercent: number; memBytes: number; containers: number }> | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch("/api/v1/catalog");
      const body = (await response.json().catch(() => ({}))) as CatalogResponse & { error?: string };
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
      const body = (await response.json().catch(() => ({}))) as { result?: { lines: string[] }; error?: string };
      if (!response.ok) throw new Error(body.error ?? "Could not read logs");
      setLogs({ id, lines: body.result?.lines ?? [] });
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Could not read logs");
    }
  };

  const showEffectiveConfig = async (id: string) => {
    try {
      const response = await fetch("/api/v1/operations/app.config.inspect/run", { method: "POST", headers: { "Content-Type": "application/json", "X-BoxPilot-CSRF": csrfToken }, body: JSON.stringify({ parameters: { id } }) });
      const body = (await response.json().catch(() => ({}))) as { result?: { id: string; name: string; compose: string | null; env: Array<{ name: string; value: string; secret: boolean }>; directory: string }; error?: string };
      if (!response.ok || !body.result) throw new Error(body.error ?? "Could not read the configuration");
      setEffectiveConfig(body.result);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Could not read the configuration");
    }
  };

  const showBackups = async (manifest: Manifest) => {
    try {
      const response = await fetch("/api/v1/operations/app.backups.inspect/run", { method: "POST", headers: { "Content-Type": "application/json", "X-BoxPilot-CSRF": csrfToken }, body: JSON.stringify({ parameters: { id: manifest.id } }) });
      const body = (await response.json().catch(() => ({}))) as { result?: { id: string; backups: Array<{ artifact: string; createdAt: string | null; sizeBytes: number | null; downtimeMs: number | null; skippedHostPaths: string[]; skippedVolumes?: string[]; image: string | null }> }; error?: string };
      if (!response.ok || !body.result) throw new Error(body.error ?? "Could not list backups");
      setAppBackups({ id: manifest.id, name: manifest.name, backups: body.result.backups });
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Could not list backups");
    }
  };

  /**
   * Everything needed to get into an app's own interface, in one place: where the page is, the
   * username if there is one, the password (revealed with the owner password, like any secret),
   * and a way to change it. Pi-hole was the prompt — a generated password behind an elevated
   * view, and a variable name to find in Settings if you wanted your own.
   */
  const showSignIn = (manifest: Manifest) => setSecrets({ id: manifest.id, name: manifest.name, items: null, needsPassword: false, password: "", error: null, signIn: true, newPassword: "" });

  const revealSecrets = async (manifest: Manifest, password?: string, signIn = false) => {
    try {
      if (password) {
        const elevate = await fetch("/api/v1/auth/elevate", { method: "POST", headers: { "Content-Type": "application/json", "X-BoxPilot-CSRF": csrfToken }, body: JSON.stringify({ password }) });
        if (!elevate.ok) { const body = (await elevate.json()) as { error?: string }; throw new Error(body.error ?? "Invalid password"); }
        window.dispatchEvent(new Event("boxpilot:auth-changed"));
      }
      const response = await fetch("/api/v1/operations/app.secrets/run", { method: "POST", headers: { "Content-Type": "application/json", "X-BoxPilot-CSRF": csrfToken }, body: JSON.stringify({ parameters: { id: manifest.id } }) });
      const body = (await response.json().catch(() => ({}))) as { result?: { secrets: Array<{ name: string; label: string; value: string }> }; error?: string; code?: string };
      if (response.status === 401 && body.code === "elevation_required") { setSecrets((current) => ({ id: manifest.id, name: manifest.name, items: null, needsPassword: true, password: "", error: null, signIn, newPassword: current?.newPassword ?? "" })); return; }
      if (!response.ok) throw new Error(body.error ?? "Could not read secrets");
      const items = (body.result?.secrets ?? []).filter((item) => !signIn || item.name === manifest.signIn?.passwordEnv);
      setSecrets((current) => ({ id: manifest.id, name: manifest.name, items, needsPassword: false, password: "", error: null, signIn, newPassword: current?.newPassword ?? "" }));
    } catch (requestError) {
      const refused = requestError instanceof Error && /owner|Viewers/i.test(requestError.message);
      setSecrets((current) => ({ id: manifest.id, name: manifest.name, items: null, needsPassword: !refused, password: "", error: requestError instanceof Error ? requestError.message : "Could not read secrets", signIn, newPassword: current?.newPassword ?? "" }));
    }
  };

  const categories = useMemo(() => [...new Set((data?.applications ?? []).map((entry) => entry.manifest.category))].sort(), [data]);
  const visible = useMemo(() => {
    const words = search.trim().toLowerCase().split(/\s+/).filter(Boolean);
    return (data?.applications ?? []).filter((entry) => {
      if (filter && entry.manifest.category !== filter) return false;
      if (!words.length) return true;
      const haystack = `${entry.manifest.name} ${entry.manifest.id} ${entry.manifest.category} ${entry.manifest.description}`.toLowerCase();
      return words.every((word) => haystack.includes(word));
    });
  }, [data, filter, search]);
  // What is already on this server goes first, running before stopped, so it is never behind a
  // scroll through a hundred-odd things that are not installed.
  const installedVisible = useMemo(() => visible.filter((entry) => entry.live?.installed)
    .sort((left, right) => Number(right.live?.container.running ?? false) - Number(left.live?.container.running ?? false) || left.manifest.name.localeCompare(right.manifest.name)), [visible]);
  const availableVisible = useMemo(() => visible.filter((entry) => !entry.live?.installed), [visible]);
  const runningCount = installedVisible.filter((entry) => entry.live?.container.running).length;
  const installedCount = (data?.applications ?? []).filter((entry) => entry.live?.installed).length;
  const openUrl = (port: { host: number; exposure: string }, manifest: Manifest) =>
    appUrl(port, { lanAddress: data?.host.lanAddress ?? null, serves: serves ?? [], https: manifest.id === "portainer" });

  const statusPill = (live: LiveState | null): ReactNode => {
    if (!live) return <span className="status-pill status-neutral">Unknown</span>;
    if (!live.installed) return live.dataPresent ? <span className="status-pill status-neutral">Not installed · data kept</span> : <span className="status-pill status-neutral">Not installed</span>;
    if (live.container.running) return <span className={`status-pill ${live.container.health === "unhealthy" ? "status-warning" : "status-good"}`}>{live.container.health === "unhealthy" ? "Running · unhealthy" : "Running"}</span>;
    return <span className="status-pill status-warning">Stopped</span>;
  };

  /** One application's card. Both sections render the same card, so it lives in one place. */
  const renderCard = ({ manifest, live }: { manifest: Manifest; live: LiveState | null }) => {
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
              {installed && live && (live.urls.length > 0 || (manifest.ports ?? []).some((port) => port.exposure !== "loopback")) ? (
                <div className="recovery-actions">
                  {live.urls.map((port) => <a key={port.id} className="secondary-button" href={openUrl(port, manifest)} target="_blank" rel="noreferrer">Open {port.label}</a>)}
                  {(() => {
                    if (serves === null) return null;
                    if ((live.state?.values?.networkMode ?? manifest.network) === "host") return null;
                    // Only an app's HTTP ports can go through Tailscale Serve. The rest move to
                    // the tailnet address, or stay on the LAN when the home network depends on
                    // them — DNS on 53, a reverse proxy's 80 and 443, UniFi's inform port. Saying
                    // which is which up front is the difference between an informed choice and an
                    // app that half works afterwards.
                    const publicPorts = (manifest.ports ?? []).filter((port) => port.exposure !== "loopback");
                    if (!publicPorts.length) return null;
                    const servePorts = publicPorts.filter((port) => port.protocol !== "udp" && (port.tailnet ?? "serve") === "serve");
                    const stayOnLan = publicPorts.filter((port) => (port.tailnet ?? (port.protocol === "udp" ? "unchanged" : "serve")) === "unchanged");
                    const moveToTailnet = publicPorts.filter((port) => port.tailnet === "address");
                    const primaryPort = servePorts[0] ? (live.state?.values?.ports?.[servePorts[0].id] ?? servePorts[0].host) : live.urls[0]?.host;
                    const served = serves.find((serve) => serve.port === primaryPort);
                    const names = (ports: ManifestPort[]) => ports.map((port) => port.label).join(", ");
                    // Where this app is reachable from. Tailnet-only is not just a firewall rule:
                    // the container stops listening on the network, so the only way in is through
                    // Tailscale, which authenticates before the app sees anyone. That matters for
                    // the apps in this catalog that have no login of their own.
                    // An empty link list must not read as "all loopback": a database with only a
                    // protocol port is on the home network until the owner says otherwise.
                    const tailnetOnly = live.state?.values?.exposure === "tailnet" || (live.urls.length > 0 && live.urls.every((url) => url.exposure === "loopback"));
                    return (
                      <>
                        {served && <a className="secondary-button" href={`https://${served.dnsName}:${served.port}`} target="_blank" rel="noreferrer">Open on tailnet 🔒</a>}
                        <span className={`status-pill ${tailnetOnly ? "status-good" : "status-neutral"}`} title={tailnetOnly ? "Only reachable through Tailscale" : "Listening on your home network; the firewall decides who can reach it"}>{tailnetOnly ? "tailnet only" : "home network"}</span>
                        {tailnetOnly
                          ? <button className="text-button" type="button" onClick={() => start({ operationId: "app.exposure.set", title: `Publish ${manifest.name} on your home network`, parameters: { id: manifest.id, mode: "lan" }, preview: <span>Recreates {manifest.name} listening on this server's network address{primaryPort ? <> on port {primaryPort}</> : null}{servePorts.length > 0 ? ", and stops publishing it on your tailnet" : ""}. Anything on your home network will be able to reach it — the firewall is then the only thing deciding who can.</span> })}>Publish on home network</button>
                          : <button className="text-button" type="button" onClick={() => start({ operationId: "app.exposure.set", title: `Make ${manifest.name} reachable only through Tailscale`, parameters: { id: manifest.id, mode: "tailnet" }, preview: <span>{servePorts.length > 0
                            ? <>Recreates {manifest.name} so its web interface no longer listens on your home network, then publishes it at <code>https://…ts.net:{primaryPort}</code> with a real certificate. Tailscale authenticates every visitor before {manifest.name} sees them; nothing is opened on your router.</>
                            : <>Recreates {manifest.name} so it no longer listens on your home network. It has no web interface to publish through Tailscale Serve, so nothing gets a certificate; being on your tailnet is what lets a machine reach it.</>}{moveToTailnet.length > 0 && <> {names(moveToTailnet)} {moveToTailnet.length === 1 ? "does not speak HTTP, so it moves to" : "do not speak HTTP, so they move to"} this server's tailnet address — reachable from your tailnet and nowhere else.</>}{stayOnLan.length > 0 && <> {names(stayOnLan)} {stayOnLan.length === 1 ? "stays" : "stay"} on your home network, because that is what {stayOnLan.length === 1 ? "it serves" : "they serve"}.</>}</span> })}>Reach only through Tailscale</button>}
                      </>
                    );
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
                {installed && <button className="text-button" type="button" onClick={() => start({ operationId: "app.backup", title: `Back up ${manifest.name}`, parameters: { id: manifest.id }, preview: <span>Stops {manifest.name} briefly, archives its data and configuration, restarts it, and keeps the newest 5 copies.{manifest.volumes.some((volume) => volume.hostPath) ? <> Your own folders ({manifest.volumes.filter((volume) => volume.hostPath).map((volume) => volume.hostPath).join(", ")}) are <strong>not</strong> included.</> : null}</span> })}>Back up</button>}
                {installed && manifest.id === "homepage" && <button className="text-button" type="button" onClick={() => start({ operationId: "homepage.sync", title: "Sync Homepage with installed apps", parameters: { host: window.location.hostname }, preview: <span>Writes a <strong>BoxPilot</strong> group into Homepage's <code>services.yaml</code> with every installed app — links via <code>{window.location.hostname}</code>, descriptions, icons, and live container status. Groups you wrote yourself are kept. Repeats by itself after installs and uninstalls.</span> })}>Sync dashboard</button>}
                {(installed || live?.dataPresent) && <button className="text-button" type="button" onClick={() => void showBackups(manifest)}>Backups</button>}
                {installed && manifest.signIn && <button className="secondary-button" type="button" onClick={() => showSignIn(manifest)}>Sign in</button>}
                {installed && manifest.env.some((entry) => entry.secret) && <button className="text-button" type="button" onClick={() => void revealSecrets(manifest)}>Secrets</button>}
                {installed && <button className="text-button" type="button" onClick={() => start({ operationId: "app.uninstall", title: `Uninstall ${manifest.name}`, parameters: { id: manifest.id }, preview: <span>Stops and removes the container. Data under the app directory is kept so you can reinstall later.</span> })}>Uninstall</button>}
                {live?.dataPresent && <button className="text-button danger-text" type="button" onClick={() => start({ operationId: "app.purge", title: `Delete ${manifest.name} and its data`, parameters: { id: manifest.id }, preview: <span>Removes the container <strong>and deletes everything</strong> under the app's data directory. This cannot be undone.</span> })}>Delete data</button>}
                {manifest.website && <a className="text-button" href={manifest.website} target="_blank" rel="noreferrer">Website</a>}
              </footer>
              {manifest.notes && installed && <p className="muted app-notes">{manifest.notes}</p>}
            </article>
          );
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
              {browsing && (
                <div className="backup-browser">
                  <div className="recovery-actions">
                    <strong>Files in {browsing.backup}</strong>
                    <input aria-label="Filter files" placeholder="Filter…" value={browsing.filter} onChange={(event) => setBrowsing({ ...browsing, filter: event.target.value })} />
                    <button className="text-button" type="button" onClick={() => setBrowsing(null)}>Close</button>
                  </div>
                  <ul className="backup-file-list">
                    {browsing.files.filter((entry) => entry.type !== "directory" && (!browsing.filter || entry.path.toLowerCase().includes(browsing.filter.toLowerCase()))).slice(0, 200).map((entry) => (
                      <li key={entry.path}><code>{entry.path}</code><span className="muted">{entry.sizeBytes >= 1024 ? `${(entry.sizeBytes / 1024).toFixed(0)} KiB` : `${entry.sizeBytes} B`}</span><button className="text-button" type="button" onClick={() => { const target = appBackups; const file = entry.path; const archive = browsing.backup; setBrowsing(null); setAppBackups(null); start({ operationId: "app.backup.restore-path", title: `Restore ${file} into ${target.name}`, parameters: { id: target.id, backup: archive, path: file }, preview: <span>Takes a checkpoint of {target.name}'s current data, stops it briefly, restores only <code>{file}</code> from this backup over the current one, and starts it again. Everything else is untouched.</span> }); }}>Restore this file</button></li>
                    ))}
                  </ul>
                  {browsing.truncated && <p className="muted">Listing capped; refine the filter.</p>}
                </div>
              )}
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
                              <button className="text-button" type="button" onClick={() => void browseBackup(appBackups.id, backup.artifact)}>Browse</button>
                              <button className="text-button" type="button" onClick={() => { const target = appBackups; setAppBackups(null); start({ operationId: "app.backup.delete", title: `Delete backup of ${target.name}`, parameters: { id: target.id, backup: backup.artifact }, preview: <span>Deletes the archive from {backup.createdAt ? new Date(backup.createdAt).toLocaleString() : backup.artifact}. This cannot be undone.</span> }); }}>Delete</button>
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              {appBackups.backups.some((backup) => (backup.skippedVolumes ?? []).length > 0) && <p className="muted">Not included in these archives: {[...new Set(appBackups.backups.flatMap((backup) => backup.skippedVolumes ?? []))].join(", ")}.</p>}
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
            <header className="modal-header"><div><span className="eyebrow">{secrets.signIn ? "Sign in" : "Secrets"}</span><h2 id="secrets-title">{secrets.name}</h2></div><button className="icon-button" type="button" onClick={() => setSecrets(null)} aria-label="Close dialog">X</button></header>
            <div className="modal-copy">
              {secrets.signIn && (() => {
                const entry = data?.applications.find((application) => application.manifest.id === secrets.id);
                const manifest = entry?.manifest; const live = entry?.live;
                if (!manifest?.signIn || !live) return null;
                const portId = manifest.signIn.port ?? live.urls[0]?.id;
                const port = live.urls.find((url) => url.id === portId) ?? live.urls[0];
                const username = manifest.signIn.username ?? (manifest.signIn.usernameEnv ? live.state?.values?.env?.[manifest.signIn.usernameEnv] ?? manifest.env.find((env) => env.name === manifest.signIn?.usernameEnv)?.default ?? null : null);
                const passwordLabel = manifest.env.find((env) => env.name === manifest.signIn?.passwordEnv)?.label ?? "Password";
                const newPassword = secrets.newPassword ?? "";
                return (
                  <div className="sign-in-panel">
                    {port && <p><a className="primary-button" href={openUrl(port, manifest)} target="_blank" rel="noreferrer">Open {manifest.name}'s sign-in page</a></p>}
                    <dl className="sign-in-details">
                      <dt>Username</dt>
                      {username !== null ? <dd><code>{String(username)}</code></dd> : <dd className="muted">none — {manifest.name} asks only for the password</dd>}
                      <dt>{passwordLabel}</dt>
                      <dd>{secrets.items && secrets.items.length > 0
                        ? <input readOnly value={secrets.items[0].value} aria-label={passwordLabel} onFocus={(event) => event.currentTarget.select()} />
                        : secrets.needsPassword ? <span className="muted">enter your owner password below</span> : <button className="text-button" type="button" onClick={() => void revealSecrets(manifest, undefined, true)}>Reveal</button>}</dd>
                    </dl>
                    {manifest.signIn.note && <p className="muted">{manifest.signIn.note}</p>}
                    <form className="recovery-actions" onSubmit={(event) => { event.preventDefault(); if (newPassword.length < 8) return; start({ operationId: "app.password.set", title: `Change ${manifest.name}'s sign-in password`, parameters: { id: manifest.id, password: newPassword }, preview: <span>Sets a new {passwordLabel.toLowerCase()} and recreates {manifest.name} so it takes effect — a few seconds of downtime, data untouched.</span> }); setSecrets(null); }}>
                      <input type="password" autoComplete="new-password" minLength={8} maxLength={128} placeholder="New password (8+ characters)" aria-label="New password" value={newPassword} onChange={(event) => setSecrets({ ...secrets, newPassword: event.target.value })} />
                      <button className="secondary-button" type="submit" disabled={newPassword.length < 8}>Change password</button>
                    </form>
                  </div>
                );
              })()}
              {secrets.needsPassword ? (
                <>
                  <p>Enter your owner password to reveal {secrets.signIn ? "the sign-in password" : "generated passwords and tokens"}. This unlocks high-risk actions for 10 minutes and is recorded in the audit log.</p>
                  <input aria-label="Owner password" type="password" autoComplete="current-password" value={secrets.password} onChange={(event) => setSecrets({ ...secrets, password: event.target.value })} />
                  {secrets.error && <div className="auth-error" role="alert">{secrets.error}</div>}
                  <footer className="recovery-actions"><button className="primary-button" type="button" disabled={secrets.password.length < 12} onClick={() => { const manifest = data?.applications.find((entry) => entry.manifest.id === secrets.id)?.manifest; if (manifest) void revealSecrets(manifest, secrets.password, secrets.signIn ?? false); }}>Reveal</button></footer>
                </>
              ) : secrets.signIn ? null : (
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

      <div className="recovery-actions app-catalog-search">
        <input
          type="search"
          aria-label="Search applications"
          placeholder="Search by name, category or what it does…"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
        {(search || filter) && <button className="text-button" type="button" onClick={() => { setSearch(""); setFilter(""); }}>Clear</button>}
        <span className="muted">{loading ? "Loading…" : `${installedCount} installed of ${data?.applications.length ?? 0}`}</span>
        <button className="text-button" type="button" onClick={() => void refresh()}>Refresh</button>
      </div>
      <div className="recovery-actions app-catalog-toolbar">
        <button className={`secondary-button${filter === "" ? " is-active" : ""}`} type="button" onClick={() => setFilter("")}>All</button>
        {categories.map((category) => <button key={category} className={`secondary-button${filter === category ? " is-active" : ""}`} type="button" onClick={() => setFilter(category)}>{category}</button>)}
      </div>
      {error && <div className="auth-error" role="alert">{error}</div>}
      {data?.liveError && <div className="notice warning-notice"><strong>Live state unavailable</strong><span>{data.liveError}</span></div>}
      {data?.problems.map((problem) => <div key={problem.file} className="notice warning-notice"><strong>Catalog file {problem.file} was skipped</strong><span>{problem.errors.join("; ")}</span></div>)}

      {installedVisible.length > 0 && (
        <section className="app-section">
          <header className="app-section-header">
            <h2>On this server</h2>
            <span className="muted">{runningCount} running of {installedVisible.length} installed</span>
          </header>
          <div className="app-grid">{installedVisible.map(renderCard)}</div>
        </section>
      )}

      <section className="app-section">
        <header className="app-section-header">
          <h2>{installedCount > 0 ? "Add something else" : "Choose what this server runs"}</h2>
          <span className="muted">{availableVisible.length} to choose from</span>
        </header>
        {availableVisible.length === 0
          ? <p className="muted">Nothing in the catalog matches that.</p>
          : <div className="app-grid">{availableVisible.map(renderCard)}</div>}
      </section>
    </div>
  );
}
