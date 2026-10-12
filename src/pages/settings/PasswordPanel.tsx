import { useState } from "react";
import { Button, Field, Notice, Panel, SecretInput } from "../../ui";

/** Self-service password change for the signed-in account (any role). Other sessions are signed out. */
export default function PasswordPanel({ csrfToken }: { csrfToken: string }) {
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  // Typed twice (M50): a typo signed every other device out and left this one with a password nobody knew.
  const [again, setAgain] = useState("");
  const [message, setMessage] = useState<{ tone: "good" | "bad"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true); setMessage(null);
    try {
      if (newPassword !== again) throw new Error("The new password was not typed the same twice.");
      const response = await fetch("/api/v1/auth/password", { method: "POST", headers: { "Content-Type": "application/json", "X-BoxPilot-CSRF": csrfToken }, body: JSON.stringify({ currentPassword, newPassword }) });
      const body = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) throw new Error(body.error ?? "Could not change the password");
      setMessage({ tone: "good", text: "Password changed. Other devices signed in as you were signed out." });
      setCurrentPassword(""); setNewPassword(""); setAgain("");
    } catch (requestError) {
      setMessage({ tone: "bad", text: requestError instanceof Error ? requestError.message : "Could not change the password" });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Panel title="Your password" meta="12 characters or more" padded className="settings-panel">
      <form className="settings-form" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
        <Field label="Current password">
          <SecretInput autoComplete="current-password" value={currentPassword} onValueChange={setCurrentPassword} required />
        </Field>
        <Field label="New password" hint="Changing it signs out your other devices; this one stays signed in.">
          <SecretInput autoComplete="new-password" minLength={12} value={newPassword} onValueChange={setNewPassword} required />
        </Field>
        <Field label="New password again" hint={again && again !== newPassword ? "Not the same yet" : undefined}>
          <SecretInput autoComplete="new-password" minLength={12} value={again} onValueChange={setAgain} required />
        </Field>
        <div className="settings-actions"><Button type="submit" busy={busy}>Change password</Button></div>
      </form>
      {message && <Notice tone={message.tone === "good" ? "success" : "danger"} live>{message.text}</Notice>}
    </Panel>
  );
}
