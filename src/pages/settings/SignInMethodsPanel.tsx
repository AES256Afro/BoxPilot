import { useCallback, useEffect, useRef, useState } from "react";
import { pollGithubSignIn, type GithubFlow } from "../../auth";
import { Button, Field, Notice, Panel, SecretInput, StatusChip, TextInput } from "../../ui";

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

/**
 * Settings → Account & sign-in → Sign-in methods: link the current Tailscale identity, and configure
 * and link GitHub device-flow sign-in. Every change asks for the password of the account making it.
 * The owner and operators have it; a viewer's Settings leaves it out (ADR-003).
 */
export default function SignInMethodsPanel({ csrfToken }: { csrfToken: string }) {
  const [links, setLinks] = useState<Links | null>(null);
  const [password, setPassword] = useState("");
  const [clientId, setClientId] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [flow, setFlow] = useState<GithubFlow | null>(null);
  const pollTimer = useRef<number | null>(null);
  // Bumped by Cancel and on unmount: a poll that was already in flight sees it and stops, instead
  // of scheduling the next one (the device code lives for about fifteen minutes).
  const flowGeneration = useRef(0);
  const headers = { "Content-Type": "application/json", "X-BoxPilot-CSRF": csrfToken };

  const refresh = useCallback(async () => {
    try {
      const body = await json<Partial<Links>>(await fetch("/api/v1/auth/identity/links"));
      // An older or partial answer draws as nothing linked rather than taking the page down.
      const read: Links = {
        tailscaleLogins: Array.isArray(body.tailscaleLogins) ? body.tailscaleLogins : [],
        githubLogins: Array.isArray(body.githubLogins) ? body.githubLogins : [],
        githubRelinkNeeded: Array.isArray(body.githubRelinkNeeded) ? body.githubRelinkNeeded : [],
        githubConfigured: body.githubConfigured === true,
        githubClientId: typeof body.githubClientId === "string" ? body.githubClientId : "",
        currentTailscale: body.currentTailscale ?? null,
      };
      setLinks(read); setClientId(read.githubClientId);
    } catch (requestError) { setError(requestError instanceof Error ? requestError.message : "Could not load sign-in settings"); }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => () => { flowGeneration.current += 1; if (pollTimer.current) window.clearTimeout(pollTimer.current); }, []);

  const act = async (label: string, work: () => Promise<void>) => {
    setBusy(true); setError(null); setMessage(null);
    try { await work(); setMessage(label); setPassword(""); await refresh(); } catch (requestError) { setError(requestError instanceof Error ? requestError.message : "Request failed"); } finally { setBusy(false); }
  };

  const linkTailscale = () => act("Tailscale identity linked. Next time, sign in with one click over Tailscale.", async () => { await json(await fetch("/api/v1/auth/identity/tailscale", { method: "POST", headers, body: JSON.stringify({ password }) })); });
  const unlinkTailscale = (login: string) => act(`Unlinked ${login}.`, async () => { await json(await fetch("/api/v1/auth/identity/tailscale", { method: "DELETE", headers, body: JSON.stringify({ password, login }) })); });
  const saveClientId = () => act(clientId ? "GitHub client ID saved." : "GitHub sign-in disabled.", async () => { await json(await fetch("/api/v1/settings/github-client-id", { method: "PUT", headers, body: JSON.stringify({ password, clientId }) })); });
  const unlinkGithub = (login: string) => act(`Unlinked ${login}.`, async () => { await json(await fetch("/api/v1/auth/identity/github", { method: "DELETE", headers, body: JSON.stringify({ password, login }) })); });

  const linkGithub = async () => {
    const generation = ++flowGeneration.current;
    const current = () => generation === flowGeneration.current;
    setBusy(true); setError(null); setMessage(null);
    try {
      const started = await json<GithubFlow>(await fetch("/api/v1/auth/identity/github/start", { method: "POST", headers, body: JSON.stringify({ password }) }));
      if (!current()) return;
      setFlow(started); setPassword("");
      const poll = async () => {
        try {
          const result = await pollGithubSignIn(started.flowId);
          if (!current()) return;
          if (result.status === "complete") { setFlow(null); setMessage(`Linked GitHub account ${result.login}.`); await refresh(); setBusy(false); return; }
          if (result.status === "pending") { pollTimer.current = window.setTimeout(() => void poll(), started.intervalSeconds * 1000); return; }
          setFlow(null); setBusy(false); setError(result.error ?? `GitHub flow ${result.status}`);
        } catch (pollError) { if (!current()) return; setFlow(null); setBusy(false); setError(pollError instanceof Error ? pollError.message : "GitHub link failed"); }
      };
      pollTimer.current = window.setTimeout(() => void poll(), started.intervalSeconds * 1000);
    } catch (requestError) {
      if (!current()) return;
      setBusy(false); setError(requestError instanceof Error ? requestError.message : "GitHub link failed");
    }
  };

  const cancelGithub = () => {
    flowGeneration.current += 1;
    if (pollTimer.current) window.clearTimeout(pollTimer.current);
    pollTimer.current = null;
    setFlow(null); setBusy(false); setError(null); setMessage("GitHub linking cancelled.");
  };

  const passwordOk = password.length >= 12;
  // Why every button below waits, said with each of them as well as once above the lot.
  const needPassword = passwordOk ? undefined : "Type your password above first";
  const here = links?.currentTailscale ?? null;
  const tailscaleLinked = links?.tailscaleLogins.length ?? 0;
  const githubLinked = links?.githubLogins.length ?? 0;
  const relink = links?.githubRelinkNeeded ?? [];

  return (
    <Panel title="Sign-in methods" meta={links ? <>Tailscale <b>{tailscaleLinked}</b> · GitHub <b>{githubLinked}</b></> : undefined} padded className="settings-panel">
      <Field label="Your password" hint="Needed for every change below.">
        <SecretInput autoComplete="current-password" value={password} onValueChange={setPassword} />
      </Field>

      <section className="settings-sub" aria-labelledby="settings-tailscale-title">
        <div className="settings-sub__head">
          <h3 id="settings-tailscale-title" className="settings-sub__title">Tailscale</h3>
          {links && <StatusChip status={tailscaleLinked ? "good" : "neutral"}>{tailscaleLinked ? `${tailscaleLinked} linked` : "Not linked"}</StatusChip>}
        </div>
        <p className="settings-quiet">{here ? <>This connection is <code>{here.login}</code> ({here.displayName}) from <code>{here.node}</code>.</> : "You are not connected over Tailscale right now; open BoxPilot through its Tailscale address to link that identity."}</p>
        {(here && !here.linked) || tailscaleLinked ? (
          <div className="settings-actions">
            {here && !here.linked && <Button variant="primary" disabled={busy || !passwordOk} title={needPassword} onClick={() => void linkTailscale()}>Link {here.login}</Button>}
            {links?.tailscaleLogins.map((login) => <Button key={login} disabled={busy || !passwordOk} title={needPassword} onClick={() => void unlinkTailscale(login)}>Unlink {login}</Button>)}
          </div>
        ) : null}
      </section>

      <section className="settings-sub" aria-labelledby="settings-github-title">
        <div className="settings-sub__head">
          <h3 id="settings-github-title" className="settings-sub__title">GitHub</h3>
          {links && <StatusChip status={links.githubConfigured ? "good" : "neutral"}>{links.githubConfigured ? "Set up" : "Not set up"}</StatusChip>}
        </div>
        <p className="settings-quiet">Uses the OAuth device flow: create an OAuth App at github.com → Settings → Developer settings with <em>Device Flow</em> enabled, then paste its Client ID here. No secret or callback URL is needed.</p>
        <div className="settings-form settings-form--row">
          <Field label="GitHub OAuth App client ID">
            <TextInput mono placeholder="Ov23li... or Iv1..." value={clientId} onValueChange={setClientId} autoComplete="off" spellCheck={false} />
          </Field>
          <Button disabled={busy || !passwordOk || clientId === (links?.githubClientId ?? "")} title={needPassword ?? (clientId === (links?.githubClientId ?? "") ? "This client ID is the one saved" : undefined)} onClick={() => void saveClientId()}>Save client ID</Button>
        </div>
        {links?.githubConfigured && !flow && <div className="settings-actions"><Button variant="primary" disabled={busy || !passwordOk} title={needPassword} onClick={() => void linkGithub()}>Link a GitHub account</Button></div>}
        {flow && (
          <div className="settings-device" aria-live="polite">
            <span>Open <a href={flow.verificationUri} target="_blank" rel="noreferrer">{flow.verificationUri}</a> and enter</span>
            <code className="settings-device__code">{flow.userCode}</code>
            <span className="settings-quiet">Waiting for GitHub…</span>
            <Button variant="ghost" onClick={cancelGithub}>Cancel</Button>
          </div>
        )}
        {githubLinked ? <div className="settings-actions">{links!.githubLogins.map((login) => <Button key={login} disabled={busy || !passwordOk} title={needPassword} onClick={() => void unlinkGithub(login)}>Unlink {login}</Button>)}</div> : null}
        {relink.length ? (
          <Notice tone="warning" title={`Link ${relink.length === 1 ? "it" : "them"} again`}>
            {relink.join(", ")} {relink.length === 1 ? "was" : "were"} linked before BoxPilot recorded GitHub's account number. A GitHub name can be released and taken by somebody else, so a name on its own no longer signs anyone in. Link {relink.length === 1 ? "it" : "them"} again to use GitHub sign-in.
          </Notice>
        ) : null}
      </section>

      {message && <Notice tone="success" live>{message}</Notice>}
      {error && <Notice tone="danger" live>{error}</Notice>}
    </Panel>
  );
}
