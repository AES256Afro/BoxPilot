import { useCallback, useEffect, useState } from "react";
import { deletePasskey, fetchPasskeyStatus, generateRecoveryCodes, passkeysSupported, registerPasskey, renamePasskey, type PasskeyInfo } from "./passkey";

/**
 * Settings → Passkeys: register a passkey for this way in, rename or remove passkeys, and mint
 * recovery codes. A passkey is tied to the address it was made at (this page's host), which the copy
 * says plainly, because that is how WebAuthn works and pretending otherwise would confuse.
 */
export default function PasskeySettings({ csrfToken }: { csrfToken: string }) {
  const [status, setStatus] = useState<{ passkeys: PasskeyInfo[]; recoveryCodesRemaining: number } | null>(null);
  const [label, setLabel] = useState("");
  const [password, setPassword] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [freshCodes, setFreshCodes] = useState<string[] | null>(null);
  const supported = passkeysSupported();
  const host = typeof window !== "undefined" ? window.location.host : "";

  const refresh = useCallback(async () => {
    try { setStatus(await fetchPasskeyStatus()); } catch { /* a signed-in account always has this */ }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);

  const act = async (done: string, work: () => Promise<void>) => {
    setBusy(true); setError(null); setMessage(null);
    try { await work(); setMessage(done); await refresh(); } catch (requestError) { setError(requestError instanceof Error ? requestError.message : "Request failed"); } finally { setBusy(false); }
  };

  const addPasskey = () => act("Passkey registered. Sign in with it next time.", async () => {
    await registerPasskey(csrfToken, label.trim() || "Passkey");
    setLabel("");
  });
  const rename = (id: string, current: string) => {
    const next = window.prompt("Rename this passkey", current);
    if (next === null || next.trim() === current) return;
    void act("Passkey renamed.", async () => { await renamePasskey(csrfToken, id, next.trim()); });
  };
  const remove = (id: string, name: string) => act(`Removed ${name}.`, async () => {
    if (!password) throw new Error("Enter your password below to remove a passkey");
    await deletePasskey(csrfToken, id, password);
    setPassword("");
  });
  const mintRecoveryCodes = () => act("New recovery codes generated. Save them now; the old ones no longer work.", async () => {
    if (!password) throw new Error("Enter your password below to generate recovery codes");
    const { codes } = await generateRecoveryCodes(csrfToken, password);
    setFreshCodes(codes); setPassword("");
  });

  const downloadCodes = () => {
    if (!freshCodes) return;
    const blob = new Blob([`BoxPilot recovery codes for ${host}\nSaved ${new Date().toISOString()}\nEach code signs you in once.\n\n${freshCodes.join("\n")}\n`], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url; anchor.download = "boxpilot-recovery-codes.txt"; anchor.click();
    URL.revokeObjectURL(url);
  };

  return (
    <section className="panel settings-panel">
      <header className="panel-header"><div><strong>Passkeys</strong><span>Sign in with your fingerprint, face, or a security key instead of the password</span></div></header>
      <div className="approval-settings">
        {!supported ? (
          <p className="muted">This browser cannot use passkeys here. Passkeys need a secure connection: open BoxPilot over Tailscale, or set up HTTPS on your local network from the Network page, then come back.</p>
        ) : (
          <>
            <div className="approval-option" style={{ cursor: "default" }}><span aria-hidden="true">🔑</span><div>
              <strong>Register a passkey</strong>
              <span>This passkey will work when you reach BoxPilot at <code>{host}</code>. Register another when you use a different address (for example your Tailscale name).</span>
              <div className="recovery-actions" style={{ marginTop: 8 }}>
                <input aria-label="Passkey name" placeholder="e.g. My phone, Yubikey" maxLength={48} value={label} onChange={(event) => setLabel(event.target.value)} />
                <button className="primary-button" type="button" disabled={busy} onClick={() => void addPasskey()}>Add a passkey</button>
              </div>
            </div></div>

            {status?.passkeys.length ? (
              <div className="workload-list">
                {status.passkeys.map((key) => (
                  <div className="workload" key={key.id}>
                    <div><strong>{key.label}</strong><span>for <code>{key.rpId}</code> · added {new Date(key.createdAt).toLocaleDateString()}{key.lastUsedAt ? ` · last used ${new Date(key.lastUsedAt).toLocaleDateString()}` : " · not used yet"}</span></div>
                    <button className="text-button" type="button" disabled={busy} onClick={() => rename(key.id, key.label)}>Rename</button>
                    <button className="text-button" type="button" disabled={busy} onClick={() => void remove(key.id, key.label)}>Remove</button>
                  </div>
                ))}
              </div>
            ) : <p className="muted">No passkeys yet.</p>}

            <div className="approval-option" style={{ cursor: "default" }}><span aria-hidden="true">🎟️</span><div>
              <strong>Recovery codes</strong>
              <span>{status ? `${status.recoveryCodesRemaining} unused code${status.recoveryCodesRemaining === 1 ? "" : "s"} left.` : ""} One-time codes to sign in if you lose every passkey and your password. Generating new codes replaces any old ones.</span>
              <div className="recovery-actions" style={{ marginTop: 8 }}>
                <button className="secondary-button" type="button" disabled={busy} onClick={() => void mintRecoveryCodes()}>Generate recovery codes</button>
              </div>
              {freshCodes && (
                <div className="recovery-codes-box">
                  <p className="muted">Save these now. They are shown once and each works a single time.</p>
                  <ul className="recovery-code-list">{freshCodes.map((code) => <li key={code}><code>{code}</code></li>)}</ul>
                  <div className="recovery-actions">
                    <button className="secondary-button" type="button" onClick={() => void navigator.clipboard?.writeText(freshCodes.join("\n"))}>Copy</button>
                    <button className="secondary-button" type="button" onClick={downloadCodes}>Download</button>
                    <button className="text-button" type="button" onClick={() => setFreshCodes(null)}>Done, I saved them</button>
                  </div>
                </div>
              )}
            </div></div>

            <label>Owner password <span className="muted">(needed to remove a passkey or generate recovery codes)</span><input aria-label="Password for passkey changes" type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} /></label>
          </>
        )}
        {message && <p className="good-text">{message}</p>}
        {error && <div className="auth-error" role="alert">{error}</div>}
      </div>
    </section>
  );
}
