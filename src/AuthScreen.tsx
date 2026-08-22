import { useEffect, useRef, useState, type FormEvent } from "react";
import { AuthError, bootstrapOwner, fetchIdentityOptions, loginOwner, loginWithTailscale, pollGithubSignIn, startGithubSignIn, type AuthStatus, type GithubFlow, type IdentityOptions } from "./auth";

export default function AuthScreen({ bootstrapRequired, onAuthenticated }: { bootstrapRequired: boolean; onAuthenticated: (status: AuthStatus) => void }) {
  const [username, setUsername] = useState("operator");
  const [password, setPassword] = useState("");
  const [bootstrapToken, setBootstrapToken] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [identity, setIdentity] = useState<IdentityOptions | null>(null);
  const [github, setGithub] = useState<GithubFlow | null>(null);
  const [githubStatus, setGithubStatus] = useState<string | null>(null);
  const pollTimer = useRef<number | null>(null);

  useEffect(() => {
    if (bootstrapRequired) return;
    fetchIdentityOptions().then(setIdentity).catch(() => setIdentity(null));
  }, [bootstrapRequired]);
  useEffect(() => () => { if (pollTimer.current) window.clearTimeout(pollTimer.current); }, []);

  // First Tailscale sign-in from a browser confirms the password once; the server then remembers the browser.
  const [devicePrompt, setDevicePrompt] = useState<{ username: string } | null>(null);
  const [devicePassword, setDevicePassword] = useState("");
  const tailscaleSignIn = async (password?: string) => {
    setSubmitting(true); setError(null);
    try {
      onAuthenticated(await loginWithTailscale(password));
      setDevicePrompt(null); setDevicePassword("");
    } catch (requestError) {
      if (requestError instanceof AuthError && requestError.code === "device_password_required") { setDevicePrompt({ username: requestError.username ?? "" }); if (password) setError("That password was not accepted"); }
      else setError(requestError instanceof Error ? requestError.message : "Tailscale sign-in failed");
    } finally { setSubmitting(false); }
  };

  const githubSignIn = async () => {
    setError(null); setGithubStatus("Starting…");
    try {
      const flow = await startGithubSignIn();
      setGithub(flow); setGithubStatus("Waiting for you to authorize on GitHub…");
      const poll = async () => {
        try {
          const result = await pollGithubSignIn(flow.flowId);
          if (result.status === "complete" && result.session) { onAuthenticated(result.session); return; }
          if (result.status === "pending") { pollTimer.current = window.setTimeout(() => void poll(), flow.intervalSeconds * 1000); return; }
          setGithub(null); setGithubStatus(null); setError(result.error ?? (result.status === "expired" ? "The GitHub code expired; try again." : result.status === "denied" ? "GitHub authorization was denied." : "GitHub sign-in failed."));
        } catch (pollError) {
          setGithub(null); setGithubStatus(null); setError(pollError instanceof Error ? pollError.message : "GitHub sign-in failed");
        }
      };
      pollTimer.current = window.setTimeout(() => void poll(), flow.intervalSeconds * 1000);
    } catch (requestError) {
      setGithubStatus(null); setError(requestError instanceof Error ? requestError.message : "GitHub sign-in failed");
    }
  };

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

        {!bootstrapRequired && identity && (identity.tailscale.linked || identity.github.configured) && (
          <div className="identity-signin">
            {identity.tailscale.linked && <button className="primary-button" type="button" disabled={submitting} onClick={() => void tailscaleSignIn()}>Continue as {identity.tailscale.displayName ?? identity.tailscale.login} (Tailscale)</button>}
            {devicePrompt && (
              <form className="stack" onSubmit={(event) => { event.preventDefault(); void tailscaleSignIn(devicePassword); }}>
                <p className="muted">First time in this browser: confirm the password for <strong>{devicePrompt.username}</strong>. Next time, Tailscale alone signs you in here.</p>
                <input aria-label="Password" type="password" autoComplete="current-password" value={devicePassword} onChange={(event) => setDevicePassword(event.target.value)} />
                <button className="primary-button" type="submit" disabled={submitting || devicePassword.length < 12}>Confirm and sign in</button>
              </form>
            )}
            {identity.github.configured && !github && <button className="secondary-button" type="button" disabled={submitting || Boolean(githubStatus)} onClick={() => void githubSignIn()}>Sign in with GitHub</button>}
            {github && (
              <div className="github-device">
                <span>Open <a href={github.verificationUri} target="_blank" rel="noreferrer">{github.verificationUri}</a> and enter</span>
                <code className="github-code">{github.userCode}</code>
                <span className="muted">{githubStatus}</span>
              </div>
            )}
            <div className="identity-divider"><span>or use your password</span></div>
          </div>
        )}
        {!bootstrapRequired && identity?.tailscale.available && !identity.tailscale.linked && <p className="muted">Connected over Tailscale as {identity.tailscale.login}. Sign in with your password, then link it in <strong>Settings → Sign-in methods</strong> to skip the password next time.</p>}
        {!bootstrapRequired && identity && !identity.github.configured && <p className="muted">GitHub sign-in is not set up yet. Sign in with your password, then add your GitHub OAuth App client ID in <strong>Settings → Sign-in methods</strong>.</p>}
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
