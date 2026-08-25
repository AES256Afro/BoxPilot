import { useState } from "react";

/**
 * Prepare a *new* Ubuntu server (M4.3): generates the NoCloud user-data/meta-data for an
 * unattended install that installs BoxPilot on first boot. Nothing on this server changes.
 */

interface Rendered { userData: string; metaData: string; ref: string; filename: string }

export default function AutoinstallGenerator({ csrfToken }: { csrfToken: string }) {
  const [hostname, setHostname] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [sshKeys, setSshKeys] = useState("");
  const [githubUser, setGithubUser] = useState("");
  const [mode, setMode] = useState<"dhcp" | "static">("dhcp");
  const [address, setAddress] = useState("");
  const [gateway, setGateway] = useState("");
  const [nameservers, setNameservers] = useState("");
  const [layout, setLayout] = useState<"lvm" | "direct">("lvm");
  const [timezone, setTimezone] = useState("Etc/UTC");
  const [ref, setRef] = useState(`v${__BOXPILOT_VERSION__}`);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rendered, setRendered] = useState<Rendered | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  const importKeys = async () => {
    if (!githubUser.trim()) return;
    setError(null);
    try {
      const response = await fetch(`/api/v1/ssh-keys/github/${encodeURIComponent(githubUser.trim())}`);
      const body = (await response.json()) as { keys?: string[]; error?: string };
      if (!response.ok) throw new Error(body.error ?? "Could not fetch keys");
      setSshKeys((current) => [...current.split("\n").map((line) => line.trim()).filter(Boolean), ...(body.keys ?? [])].filter((key, index, all) => all.indexOf(key) === index).join("\n"));
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Could not fetch keys");
    }
  };

  const generate = async () => {
    setBusy(true);
    setError(null);
    setRendered(null);
    try {
      const body = {
        hostname: hostname.trim(), username: username.trim(), password,
        sshKeys: sshKeys.split("\n").map((line) => line.trim()).filter(Boolean),
        network: mode === "dhcp" ? { mode } : { mode, address: address.trim(), gateway: gateway.trim(), nameservers: nameservers.split(/[,\s]+/).map((entry) => entry.trim()).filter(Boolean) },
        disk: { layout }, timezone: timezone.trim() || undefined, boxpilotRef: ref.trim() || undefined,
      };
      const response = await fetch("/api/v1/setup/autoinstall", { method: "POST", headers: { "Content-Type": "application/json", "X-BoxPilot-CSRF": csrfToken }, body: JSON.stringify(body) });
      const result = (await response.json().catch(() => ({}))) as Rendered & { error?: string };
      if (!response.ok) throw new Error(result.error ?? "Could not generate the autoinstall files");
      setRendered(result);
      setPassword("");
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Could not generate the autoinstall files");
    } finally {
      setBusy(false);
    }
  };

  const download = (name: string, text: string) => {
    const url = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
    const anchor = document.createElement("a"); anchor.href = url; anchor.download = name; anchor.click(); URL.revokeObjectURL(url);
  };
  const copy = async (name: string, text: string) => { try { await navigator.clipboard.writeText(text); setCopied(name); window.setTimeout(() => setCopied(null), 1500); } catch { setError("Clipboard unavailable — use Download."); } };

  return (
    <section className="panel">
      <header className="panel-header"><div><strong>Prepare a new server</strong><span>Generates Ubuntu Server autoinstall files for another machine. The install is unattended, erases that machine's disk, and installs BoxPilot on first boot. Nothing here changes this server.</span></div></header>
      <form className="autoinstall-form" onSubmit={(event) => { event.preventDefault(); void generate(); }}>
        <label>Hostname<input value={hostname} onChange={(event) => setHostname(event.target.value)} placeholder="garage-box" pattern="[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?" required /></label>
        <label>User name<input value={username} onChange={(event) => setUsername(event.target.value)} placeholder="owner" pattern="[a-z_][a-z0-9_-]{0,31}" required /></label>
        <label>Password (12+ characters, hashed here, never stored)<input type="password" value={password} onChange={(event) => setPassword(event.target.value)} minLength={12} autoComplete="new-password" required /></label>
        <label className="autoinstall-wide">SSH public keys, one per line (password login is turned off when a key is given)<textarea rows={3} value={sshKeys} onChange={(event) => setSshKeys(event.target.value)} placeholder="ssh-ed25519 AAAA… you@laptop" spellCheck={false} /></label>
        <div className="recovery-actions autoinstall-wide"><input aria-label="GitHub user for keys" placeholder="GitHub user" value={githubUser} onChange={(event) => setGithubUser(event.target.value)} /><button className="secondary-button" type="button" onClick={() => void importKeys()} disabled={!githubUser.trim()}>Import keys from GitHub</button></div>
        <label>Network<select value={mode} onChange={(event) => setMode(event.target.value as "dhcp" | "static")}><option value="dhcp">DHCP</option><option value="static">Static IPv4</option></select></label>
        {mode === "static" && <>
          <label>Address with prefix<input value={address} onChange={(event) => setAddress(event.target.value)} placeholder="192.168.1.20/24" required /></label>
          <label>Gateway<input value={gateway} onChange={(event) => setGateway(event.target.value)} placeholder="192.168.1.1" required /></label>
          <label>DNS servers<input value={nameservers} onChange={(event) => setNameservers(event.target.value)} placeholder="192.168.1.1, 1.1.1.1" required /></label>
        </>}
        <label>Disk<select value={layout} onChange={(event) => setLayout(event.target.value as "lvm" | "direct")}><option value="lvm">Whole disk, LVM</option><option value="direct">Whole disk, plain partitions</option></select></label>
        <label>Time zone<input value={timezone} onChange={(event) => setTimezone(event.target.value)} placeholder="Etc/UTC" /></label>
        {/* The build's own version, not a number typed here once: the placeholder said v0.62.5 more
            than a hundred releases later, and it is the one field where copying the example
            verbatim installs something ancient on a brand-new server. Empty means current, which
            is what the server already does. */}
        <label>BoxPilot release<input value={ref} onChange={(event) => setRef(event.target.value)} placeholder={`v${__BOXPILOT_VERSION__} (current)`} /></label>
        <div className="recovery-actions autoinstall-wide"><button className="primary-button" type="submit" disabled={busy}>{busy ? "Generating…" : "Generate autoinstall files"}</button></div>
      </form>
      {error && <div className="auth-error" role="alert">{error}</div>}
      {rendered && (
        <div className="autoinstall-output">
          <div className="recovery-actions">
            <span className="muted">Put <code>user-data</code> and <code>meta-data</code> on a small volume labelled <code>CIDATA</code> (or serve them over HTTP) and boot the Ubuntu Server installer with <code>autoinstall ds=nocloud</code>. First boot installs BoxPilot {rendered.ref}; open <code>http://{hostname || "the-new-server"}:8787</code> afterwards.</span>
            <button className="secondary-button" type="button" onClick={() => void copy("user-data", rendered.userData)}>{copied === "user-data" ? "Copied" : "Copy user-data"}</button>
            <button className="secondary-button" type="button" onClick={() => download("user-data", rendered.userData)}>Download user-data</button>
            <button className="text-button" type="button" onClick={() => download("meta-data", rendered.metaData)}>Download meta-data</button>
          </div>
          <pre className="app-logs" aria-label="Generated user-data">{rendered.userData}</pre>
        </div>
      )}
    </section>
  );
}
