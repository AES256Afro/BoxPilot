import { useEffect, useState } from "react";
import { Button, Field, Notice, Panel, SecretInput, Tag } from "../../ui";

type Mode = "tiered" | "always-password";
interface ApprovalModeResponse { approvalMode: Mode; modes: string[]; elevationTtlMs?: number }

const modeWords: Record<Mode, string> = { tiered: "Tiered", "always-password": "Always ask" };

/**
 * Settings → Approvals (owner only, ADR-003): risk-tiered approvals (the default) or the password
 * every time. Changing it asks for the owner's password. The tiers themselves never weaken: this
 * only chooses whether low and medium ask for the password too.
 */
export default function ApprovalsPanel({ csrfToken, onChange }: { csrfToken: string; /** The mode changed: the page reads its facts again. */ onChange?: () => void }) {
  const [mode, setMode] = useState<Mode | null>(null);
  const [choice, setChoice] = useState<Mode>("tiered");
  const [ttlMs, setTtlMs] = useState<number | null>(null);
  const [password, setPassword] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    fetch("/api/v1/settings/approval-mode").then((response) => response.json()).then((body: ApprovalModeResponse) => {
      const read = body?.approvalMode === "tiered" || body?.approvalMode === "always-password" ? body.approvalMode : null;
      if (!read) throw new Error("unreadable");
      setMode(read); setChoice(read); setTtlMs(body.elevationTtlMs ?? null);
    }).catch(() => setError("Could not read the approval mode"));
  }, []);

  const save = async () => {
    setSaving(true); setError(null); setMessage(null);
    try {
      const response = await fetch("/api/v1/settings/approval-mode", { method: "PUT", headers: { "Content-Type": "application/json", "X-BoxPilot-CSRF": csrfToken }, body: JSON.stringify({ approvalMode: choice, password }) });
      const body = (await response.json()) as ApprovalModeResponse & { error?: string };
      if (!response.ok) throw new Error(body.error ?? "Could not change the approval mode");
      setMode(body.approvalMode); setPassword(""); setMessage(body.approvalMode === "tiered" ? "Tiered approvals are on." : "Every approval will ask for your password.");
      onChange?.();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Could not change the approval mode");
    } finally {
      setSaving(false);
    }
  };

  const minutes = ttlMs ? Math.max(1, Math.round(ttlMs / 60_000)) : 10;
  const options: Array<{ value: Mode; title: string; detail: string; asks: [string, string, string] }> = [
    { value: "tiered", title: "Tiered (recommended)", detail: `A password unlocks high-risk approvals for ${minutes} minutes.`, asks: ["one click", "preview, then confirm", "password"] },
    { value: "always-password", title: "Always ask for the password", detail: "Every change, including restarts and refreshes, re-enters the owner password. No elevated window.", asks: ["password", "password", "password"] },
  ];

  return (
    <Panel title="Approvals" count={mode ? { status: "neutral", label: modeWords[mode] } : undefined} meta="how much BoxPilot asks before it changes this server" padded className="settings-panel settings-panel--wide">
      <fieldset className="settings-choices" disabled={mode === null}>
        <legend className="ui-visually-hidden">Approval mode</legend>
        {options.map((option) => (
          <label key={option.value} className="settings-choice" data-checked={choice === option.value || undefined}>
            <input type="radio" name="approval-mode" value={option.value} checked={choice === option.value} onChange={() => setChoice(option.value)} />
            <span className="settings-choice__text">
              <strong>{option.title}</strong>
              <span>{option.detail}</span>
              <span className="settings-choice__tiers">
                <span><Tag tier="low" /> {option.asks[0]}</span>
                <span><Tag tier="medium" /> {option.asks[1]}</span>
                <span><Tag tier="high" /> {option.asks[2]}</span>
              </span>
            </span>
          </label>
        ))}
      </fieldset>
      {mode !== null && choice !== mode && (
        <form className="settings-form settings-form--row" onSubmit={(event) => { event.preventDefault(); if (password.length >= 12) void save(); }}>
          <Field label="Owner password" hint={`Switches to ${modeWords[choice].toLowerCase()} approvals.`}>
            <SecretInput autoComplete="current-password" value={password} onValueChange={setPassword} />
          </Field>
          <div className="settings-actions">
            <Button variant="primary" type="submit" disabled={saving || password.length < 12}>{saving ? "Saving..." : "Save"}</Button>
            <Button variant="ghost" onClick={() => { setChoice(mode ?? "tiered"); setPassword(""); }}>Cancel</Button>
          </div>
        </form>
      )}
      {message && <Notice tone="success" live>{message}</Notice>}
      {error && <Notice tone="danger" live>{error}</Notice>}
    </Panel>
  );
}
