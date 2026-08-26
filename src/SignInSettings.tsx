import { useCallback, useEffect, useRef, useState } from "react";
import { pollGithubSignIn, type GithubFlow } from "./auth";

interface Links {
  tailscaleLogins: string[];
  githubLogins: string[];
  githubRelinkNeeded?: string[];
  githubConfigured: boolean;
  githubClientId: string;
  currentTailscale: { login: string; displayName: string; node: string; linked: boolean } | null;
}

async function json<T>(response: Response): Promise<T> {
  const body = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) throw new Error(body.error ?? `Request failed (${response.status})`);
  return body;
}

/** Settings → Sign-in methods: link the current Tailscale identity, configure GitHub device-flow sign-in. */
export default function SignInSettings({ csrfToken }: { csrfToken: string }) {
  const [links, setLinks] = useState<Links | null>(null);
  const [password, setPassword] = useState("");
  const [clientId, setClientId] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [flow, setFlow] = useState<GithubFlow | null>(null);
  const pollTimer = useRef<number | null>(null);
  const headers = { "Content-Type": "application/json", "X-BoxPilot-CSRF": csrfToken };

  const refresh = useCallback(async () => {
    try { const body = await json<Links>(await fetch("/api/v1/auth/identity/links")); setLinks(body); setClientId(body.githubClientId); } catch (requestError) { setError(requestError instanceof Error ? requestError.message : "Could not load sign-in settings"); }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => () => { if (pollTimer.current) window.clearTimeout(pollTimer.current); }, []);

  const act = async (label: string, work: () => Promise<void>) => {
    setBusy(true); setError(null); setMessage(null);
    try { await work(); setMessage(label); setPassword(""); await refresh(); } catch (requestError) { setError(requestError instanceof Error ? requestError.message : "Request failed"); } finally { setBusy(false); }
  };

  const linkTailscale = () => act("Tailscale identity linked. Next time, sign in with one click over Tailscale.", async () => { await json(await fetch("/api/v1/auth/identity/tailscale", { method: "POST", headers, body: JSON.stringify({ password }) })); });
  const unlinkTailscale = (login: string) => act(`Unlinked ${login}.`, async () => { await json(await fetch("/api/v1/auth/identity/tailscale", { method: "DELETE", headers, body: JSON.stringify({ password, login }) })); });
  const saveClientId = () => act(clientId ? "GitHub client ID saved." : "GitHub sign-in disabled.", async () => { await json(await fetch("/api/v1/settings/github-client-id", { method: "PUT", headers, body: JSON.stringify({ password, clientId }) })); });
  const unlinkGithub = (login: string) => act(`Unlinked ${login}.`, async () => { await json(await fetch("/api/v1/auth/identity/github", { method: "DELETE", headers, body: JSON.stringify({ password, login }) })); });

  const linkGithub = async () => {
    setBusy(true); setError(null); setMessage(null);
    try {
      const started = await json<GithubFlow>(await fetch("/api/v1/auth/identity/github/start", { method: "POST", headers, body: JSON.stringify({ password }) }));
      setFlow(started); setPassword("");
      const poll = async () => {
        try {
          const result = await pollGithubSignIn(started.flowId);
          if (result.status === "complete") { setFlow(null); setMessage(`Linked GitHub account ${result.login}.`); await refresh(); setBusy(false); return; }
          if (result.status === "pending") { pollTimer.current = window.setTimeout(() => void poll(), started.intervalSeconds * 1000); return; }
          setFlow(null); setBusy(false); setError(result.error ?? `GitHub flow ${result.status}`);
        } catch (pollError) { setFlow(null); setBusy(false); setError(pollError instanceof Error ? pollError.message : "GitHub link failed"); }
      };
      pollTimer.current = window.setTimeout(() => void poll(), started.intervalSeconds * 1000);
    } catch (requestError) {
      setBusy(false); setError(requestError instanceof Error ? requestError.message : "GitHub link failed");
    }
  };

  const passwordOk = password.length >= 12;

  return (
    <section className="panel settings-panel">
      <header className="panel-header"><div><strong>Sign-in methods</strong><span>Skip the password when you arrive over Tailscale, or sign in with GitHub</span></div></header>
      <div className="approval-settings">
        <label>Owner password <span className="muted">(required for every change below)</span><input aria-label="Owner password for sign-in settings" type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} /></label>

        <div className="approval-option" style={{ cursor: "default" }}><span aria-hidden="true">🔗</span><div>
          <strong>Tailscale</strong>
          <span>{links?.currentTailscale ? `This connection is ${links.currentTailscale.login} (${links.currentTailscale.displayName}) from ${links.currentTailscale.node}.` : "You are not connected over Tailscale right now; open BoxPilot through its Tailscale address to link that identity."}</span>
          <div className="recovery-actions" style={{ marginTop: 8 }}>
            {links?.currentTailscale && !links.currentTailscale.linked && <button className="primary-button" type="button" disabled={busy || !passwordOk} onClick={() => void linkTailscale()}>Link {links.currentTailscale.login}</button>}
            {links?.tailscaleLogins.map((login) => <button key={login} className="secondary-button" type="button" disabled={busy || !passwordOk} onClick={() => void unlinkTailscale(login)}>Unlink {login}</button>)}
          </div>
        </div></div>

        <div className="approval-option" style={{ cursor: "default" }}><span aria-hidden="true">🐙</span><div>
          <strong>GitHub</strong>
          <span>Uses the OAuth device flow: create an OAuth App at github.com → Settings → Developer settings with <em>Device Flow</em> enabled, then paste its Client ID here. No secret or callback URL is needed.</span>
          <div className="recovery-actions" style={{ marginTop: 8 }}>
            <input aria-label="GitHub OAuth App client ID" placeholder="Ov23li... or Iv1..." value={clientId} onChange={(event) => setClientId(event.target.value)} />
            <button className="secondary-button" type="button" disabled={busy || !passwordOk || clientId === (links?.githubClientId ?? "")} onClick={() => void saveClientId()}>Save client ID</button>
            {links?.githubConfigured && !flow && <button className="primary-button" type="button" disabled={busy || !passwordOk} onClick={() => void linkGithub()}>Link a GitHub account</button>}
          </div>
          {flow && <div className="github-device"><span>Open <a href={flow.verificationUri} target="_blank" rel="noreferrer">{flow.verificationUri}</a> and enter</span><code className="github-code">{flow.userCode}</code><span className="muted">Waiting for GitHub…</span></div>}
          {links?.githubLogins.length ? <div className="recovery-actions" style={{ marginTop: 8 }}>{links.githubLogins.map((login) => <button key={login} className="secondary-button" type="button" disabled={busy || !passwordOk} onClick={() => void unlinkGithub(login)}>Unlink {login}</button>)}</div> : null}
          {links?.githubRelinkNeeded?.length ? (
            <p className="muted" style={{ marginTop: 8 }}>
              {links.githubRelinkNeeded.join(", ")} {links.githubRelinkNeeded.length === 1 ? "was" : "were"} linked before BoxPilot recorded GitHub's account number. A GitHub name can be released and taken by somebody else, so a name on its own no longer signs anyone in. Link {links.githubRelinkNeeded.length === 1 ? "it" : "them"} again to use GitHub sign-in.
            </p>
          ) : null}
        </div></div>

        {message && <p className="good-text">{message}</p>}
        {error && <div className="auth-error" role="alert">{error}</div>}
      </div>
    </section>
  );
}
