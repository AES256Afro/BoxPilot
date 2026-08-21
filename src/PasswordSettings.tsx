import { useState } from "react";

/** Self-service password change for the signed-in account (any role). Other sessions are signed out. */
export default function PasswordSettings({ csrfToken }: { csrfToken: string }) {
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [message, setMessage] = useState<{ tone: "good" | "bad"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true); setMessage(null);
    try {
      const response = await fetch("/api/v1/auth/password", { method: "POST", headers: { "Content-Type": "application/json", "X-BoxPilot-CSRF": csrfToken }, body: JSON.stringify({ currentPassword, newPassword }) });
      const body = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) throw new Error(body.error ?? "Could not change the password");
      setMessage({ tone: "good", text: "Password changed. Other devices signed in as you were signed out." });
      setCurrentPassword(""); setNewPassword("");
    } catch (requestError) {
      setMessage({ tone: "bad", text: requestError instanceof Error ? requestError.message : "Could not change the password" });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="panel">
      <header className="panel-header"><div><strong>Your password</strong><span>Twelve characters or more. Changing it signs out your other devices; this one stays signed in.</span></div></header>
      <form className="recovery-actions" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
        <input aria-label="Current password" type="password" placeholder="current password" autoComplete="current-password" value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} required />
        <input aria-label="New password" type="password" placeholder="new password (12+)" autoComplete="new-password" minLength={12} value={newPassword} onChange={(event) => setNewPassword(event.target.value)} required />
        <button className="secondary-button" type="submit" disabled={busy}>Change password</button>
      </form>
      {message && <div className={message.tone === "good" ? "surface-notice" : "auth-error"} role="status">{message.text}</div>}
    </section>
  );
}
