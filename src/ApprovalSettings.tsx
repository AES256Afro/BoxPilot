import { useEffect, useState } from "react";

interface ApprovalModeResponse { approvalMode: "tiered" | "always-password"; modes: string[]; elevationTtlMs: number }

/** Settings panel: choose between risk-tiered approvals (default) and asking for the password every time. */
export default function ApprovalSettings({ csrfToken }: { csrfToken: string }) {
  const [mode, setMode] = useState<"tiered" | "always-password" | null>(null);
  const [choice, setChoice] = useState<"tiered" | "always-password">("tiered");
  const [password, setPassword] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    fetch("/api/v1/settings/approval-mode").then((response) => response.json()).then((body: ApprovalModeResponse) => { setMode(body.approvalMode); setChoice(body.approvalMode); }).catch(() => setError("Could not read the approval mode"));
  }, []);

  const save = async () => {
    setSaving(true); setError(null); setMessage(null);
    try {
      const response = await fetch("/api/v1/settings/approval-mode", { method: "PUT", headers: { "Content-Type": "application/json", "X-BoxPilot-CSRF": csrfToken }, body: JSON.stringify({ approvalMode: choice, password }) });
      const body = (await response.json()) as ApprovalModeResponse & { error?: string };
      if (!response.ok) throw new Error(body.error ?? "Could not change the approval mode");
      setMode(body.approvalMode); setPassword(""); setMessage(body.approvalMode === "tiered" ? "Tiered approvals are on." : "Every approval will ask for your password.");
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Could not change the approval mode");
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="panel settings-panel">
      <header className="panel-header"><div><strong>Approvals</strong><span>How much BoxPilot asks before it changes the host</span></div>{mode && <span className="status-pill status-neutral">{mode === "tiered" ? "Tiered" : "Always ask"}</span>}</header>
      <div className="approval-settings">
        <label className="approval-option"><input type="radio" name="approval-mode" value="tiered" checked={choice === "tiered"} onChange={() => setChoice("tiered")} /><div><strong>Tiered (recommended)</strong><span>Low risk runs with one click, medium risk asks you to confirm, high risk asks for your password — and a password unlocks high-risk approvals for 10 minutes.</span></div></label>
        <label className="approval-option"><input type="radio" name="approval-mode" value="always-password" checked={choice === "always-password"} onChange={() => setChoice("always-password")} /><div><strong>Always ask for the password</strong><span>Every change, including restarts and refreshes, re-enters the owner password. No elevated window.</span></div></label>
        {choice !== mode && (
          <div className="recovery-actions">
            <input aria-label="Owner password" type="password" autoComplete="current-password" placeholder="Owner password to confirm" value={password} onChange={(event) => setPassword(event.target.value)} />
            <button className="primary-button" type="button" disabled={saving || password.length < 12} onClick={() => void save()}>{saving ? "Saving..." : "Save"}</button>
            <button className="secondary-button" type="button" onClick={() => { setChoice(mode ?? "tiered"); setPassword(""); }}>Cancel</button>
          </div>
        )}
        {message && <p className="good-text">{message}</p>}
        {error && <div className="auth-error" role="alert">{error}</div>}
      </div>
    </section>
  );
}
