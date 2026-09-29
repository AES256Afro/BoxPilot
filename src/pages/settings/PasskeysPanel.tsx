import { useCallback, useEffect, useRef, useState } from "react";
import { deletePasskey, fetchPasskeyStatus, generateRecoveryCodes, passkeysSupported, registerPasskey, renamePasskey, type PasskeyInfo } from "../../passkey";
import { Button, CodeBlock, EmptyState, Field, Notice, Panel, SecretInput, TextInput } from "../../ui";

const day = (iso: string) => new Date(iso).toLocaleDateString();

/**
 * Settings → Account & sign-in: passkeys and recovery codes. Register a passkey for this way in,
 * rename or remove passkeys, and mint recovery codes. A passkey is tied to the address it was made
 * at (this page's host), which the copy says plainly, because that is how WebAuthn works and
 * pretending otherwise would confuse.
 */
export default function PasskeysPanel({ csrfToken }: { csrfToken: string }) {
  const [status, setStatus] = useState<{ passkeys: PasskeyInfo[]; recoveryCodesRemaining: number } | null>(null);
  const [label, setLabel] = useState("");
  const [password, setPassword] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [freshCodes, setFreshCodes] = useState<string[] | null>(null);
  const [renaming, setRenaming] = useState<{ id: string; label: string } | null>(null);
  const renameOpener = useRef<HTMLButtonElement | null>(null);
  const returnRenameFocus = useRef(false);
  const cancelRename = () => { returnRenameFocus.current = true; setRenaming(null); };
  useEffect(() => {
    if (!renaming && !busy && returnRenameFocus.current) {
      returnRenameFocus.current = false;
      renameOpener.current?.focus();
    }
  }, [renaming, busy]);
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
  const saveRename = () => {
    if (!renaming?.label.trim()) return;
    void act("Passkey renamed.", async () => {
      await renamePasskey(csrfToken, renaming.id, renaming.label.trim());
      cancelRename();
    });
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

  const keys = status?.passkeys ?? [];
  const remaining = status?.recoveryCodesRemaining;

  if (!supported) {
    return (
      <Panel title="Passkeys" padded className="settings-panel">
        <Notice tone="info" title="This browser cannot use passkeys here">Passkeys need a secure connection: open BoxPilot over Tailscale, or set up HTTPS on your local network from the Network page, then come back.</Notice>
      </Panel>
    );
  }

  return (
    <Panel title="Passkeys" count={status ? keys.length : undefined} meta={<>for <b>{host}</b></>} className="settings-panel settings-panel--wide"
      footer={remaining === undefined ? undefined : <><b>{remaining}</b> unused recovery code{remaining === 1 ? "" : "s"} left</>}>
      {keys.length ? (
        <ul className="settings-rows" aria-label="Your passkeys">
          {keys.map((key) => (
            <li key={key.id} className="settings-row">
              <div className="settings-row__main">
                <strong className="settings-row__title">{key.label}</strong>
                <span className="settings-row__facts">for <code>{key.rpId}</code> · added {day(key.createdAt)}{key.lastUsedAt ? ` · last used ${day(key.lastUsedAt)}` : " · not used yet"}</span>
              </div>
              <div className="settings-row__actions">
                <Button variant="ghost" disabled={busy} onClick={(event) => { renameOpener.current = event.currentTarget; setRenaming({ id: key.id, label: key.label }); }}>Rename</Button>
                <Button variant="ghost" disabled={busy} onClick={() => void remove(key.id, key.label)}>Remove</Button>
              </div>
              {renaming?.id === key.id && (
                <form className="settings-inline" aria-label="Rename passkey" onSubmit={(event) => { event.preventDefault(); saveRename(); }} onKeyDown={(event) => { if (event.key === "Escape" && !busy) { event.preventDefault(); event.stopPropagation(); cancelRename(); } }}>
                  <Field label="New passkey name">
                    <TextInput autoFocus maxLength={48} value={renaming.label} onValueChange={(value) => setRenaming({ id: key.id, label: value })} />
                  </Field>
                  <div className="settings-actions">
                    <Button variant="primary" type="submit" disabled={busy || !renaming.label.trim() || renaming.label.trim() === key.label}>Save name</Button>
                    <Button variant="ghost" disabled={busy} onClick={cancelRename}>Cancel rename</Button>
                  </div>
                </form>
              )}
            </li>
          ))}
        </ul>
      ) : status ? <EmptyState title="No passkeys yet">Add one to sign in with your fingerprint, face, or a security key.</EmptyState> : <p className="settings-quiet">Reading…</p>}

      <div className="settings-body">
        <form className="settings-form settings-form--row" onSubmit={(event) => { event.preventDefault(); void addPasskey(); }}>
          <Field label="Name for a new passkey" hint={<>It will work when you reach BoxPilot at <code>{host}</code>. Register another for a different address, such as your Tailscale name.</>}>
            <TextInput placeholder="e.g. My phone, YubiKey" maxLength={48} value={label} onValueChange={setLabel} />
          </Field>
          <Button variant="primary" type="submit" disabled={busy}>Add a passkey</Button>
        </form>

        <section className="settings-sub" aria-labelledby="settings-recovery-title">
          <h3 id="settings-recovery-title" className="settings-sub__title">Recovery codes</h3>
          <p className="settings-quiet">One-time codes to sign in if you lose every passkey and your password. Generating new codes replaces any old ones.</p>
          {freshCodes && (
            <div className="settings-codes">
              <Notice tone="warning" title="Save these now">They are shown once, and each works a single time.</Notice>
              <CodeBlock label="Recovery codes" wrap={false}>{freshCodes.join("\n")}</CodeBlock>
              <div className="settings-actions">
                <Button onClick={downloadCodes}>Download</Button>
                <Button variant="ghost" onClick={() => setFreshCodes(null)}>Done, I saved them</Button>
              </div>
            </div>
          )}
          <div className="settings-form settings-form--row">
            <Field label="Password for passkey changes" hint="Your password: needed to remove a passkey or to generate recovery codes.">
              <SecretInput autoComplete="current-password" value={password} onValueChange={setPassword} />
            </Field>
            <Button disabled={busy} onClick={() => void mintRecoveryCodes()}>Generate recovery codes</Button>
          </div>
        </section>

        {message && <Notice tone="success" live>{message}</Notice>}
        {error && <Notice tone="danger" live>{error}</Notice>}
      </div>
    </Panel>
  );
}
