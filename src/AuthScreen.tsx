import { useState, type FormEvent } from "react";
import { bootstrapOwner, loginOwner, type AuthStatus } from "./auth";

export default function AuthScreen({ bootstrapRequired, onAuthenticated }: { bootstrapRequired: boolean; onAuthenticated: (status: AuthStatus) => void }) {
  const [username, setUsername] = useState("operator");
  const [password, setPassword] = useState("");
  const [bootstrapToken, setBootstrapToken] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const result = bootstrapRequired
        ? await bootstrapOwner(username, password, bootstrapToken)
        : await loginOwner(username, password);
      onAuthenticated(result);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Authentication failed");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <main className="auth-shell">
      <section className="auth-card">
        <div className="auth-brand"><span>B</span><div><strong>BoxPilot</strong><small>Private server control plane</small></div></div>
        <span className="eyebrow">{bootstrapRequired ? "Server-local owner setup" : "Private administration"}</span>
        <h1>{bootstrapRequired ? "Claim this BoxPilot server" : "Sign in to BoxPilot"}</h1>
        <p>{bootstrapRequired
          ? "Generate a short-lived token from an SSH session on the server, then create the first owner here."
          : "Use the local BoxPilot owner account. Tailscale access does not replace application authentication."}</p>

        {bootstrapRequired && (
          <div className="bootstrap-command">
            <strong>Run on the server</strong>
            <code>sudo -u boxpilot env BOXPILOT_STATE_DIRECTORY=/var/lib/boxpilot /usr/local/bin/node /opt/boxpilot/scripts/boxpilot-owner.mjs create-bootstrap-token</code>
            <span>The token expires in 15 minutes. Keep it out of chat and logs.</span>
          </div>
        )}

        <form onSubmit={(event) => void submit(event)}>
          <label>Username<input required autoComplete="username" value={username} onChange={(event) => setUsername(event.target.value)} pattern="[A-Za-z0-9][A-Za-z0-9_.-]{2,31}" /></label>
          <label>Password<input required type="password" autoComplete={bootstrapRequired ? "new-password" : "current-password"} minLength={12} maxLength={128} value={password} onChange={(event) => setPassword(event.target.value)} /></label>
          {bootstrapRequired && <label>Bootstrap token<input required type="password" autoComplete="off" value={bootstrapToken} onChange={(event) => setBootstrapToken(event.target.value)} /></label>}
          {error && <div className="auth-error" role="alert">{error}</div>}
          <button className="primary-button" type="submit" disabled={submitting}>{submitting ? "Verifying..." : bootstrapRequired ? "Create owner" : "Sign in"}</button>
        </form>
      </section>
    </main>
  );
}
