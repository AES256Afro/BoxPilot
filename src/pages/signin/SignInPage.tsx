import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from "react";
import { AuthError, bootstrapOwner, fetchIdentityOptions, loginOwner, loginWithTailscale, pollGithubSignIn, startGithubSignIn, type AuthStatus, type GithubFlow, type IdentityOptions, type SignedOutReason } from "../../auth";
import { passkeysSupported, signInWithPasskey, signInWithRecoveryCode } from "../../passkey";
import { Button, CodeBlock, Field, Progress, SecretInput, TextInput } from "../../ui";
import { ThemeSwitch } from "../../ui/ThemeSwitch";
import "./signin.css";

/*
 * The sign-in page (M33.13): the first thing anyone sees, so it has Home's welcome rather than the
 * console's density - the Launcher's wallpaper and one glass card. The ways in are offered in the
 * order they are worth using: a passkey, then GitHub, then Tailscale, then the password. When a
 * session this browser had has ended (M36) the card says why and which page signing in goes back
 * to; the address keeps that page, so signing in lands on it.
 */

/** Why a session this browser had is gone, and the page signing in goes back to (M36). */
export interface SignedOutNotice { reason: SignedOutReason; page: string | null }

export function signedOutWords({ reason, page }: SignedOutNotice): string {
  const back = page ? ` Sign in to go back to ${page}.` : " Sign in to carry on.";
  if (reason === "address-changed") return `You were signed out because this sign-in came from a different network address, as it does when a phone or laptop changes networks.${back}`;
  return reason === "expired"
    ? `Your session ended: a sign-in lasts twelve hours, and restarts and updates do not end it.${back}`
    : `You were signed out from somewhere else: a password change, a role change or "sign out everywhere else" ends this browser's session.${back}`;
}

/** The wallpaper, the theme in the corner, and the glass card with the BoxPilot mark. */
function SignInFrame({ labelledBy, children }: { labelledBy: string; children: ReactNode }) {
  return (
    <main className="signin-page">
      <div className="signin-corner"><ThemeSwitch compact /></div>
      <section className="signin-card" aria-labelledby={labelledBy}>
        <div className="signin-brand">
          <span className="signin-brand__mark" aria-hidden="true">B</span>
          <span className="signin-brand__words"><strong>BoxPilot</strong><small>Ubuntu server setup and management</small></span>
        </div>
        {children}
      </section>
      <p className="signin-version">BoxPilot {__BOXPILOT_VERSION__}</p>
    </main>
  );
}

/** While the first answer about the session is on its way. */
export function SignInLoading() {
  const titleId = useId();
  return (
    <SignInFrame labelledBy={titleId}>
      <h1 id={titleId} className="signin-title">Loading BoxPilot...</h1>
      <Progress label="Asking BoxPilot whether you are signed in" hideLabel />
    </SignInFrame>
  );
}

/** BoxPilot did not answer the question whether anyone is signed in. */
export function SignInUnavailable({ problem }: { problem: string }) {
  const titleId = useId();
  return (
    <SignInFrame labelledBy={titleId}>
      <span className="signin-kicker">Connection failed</span>
      <h1 id={titleId} className="signin-title">BoxPilot is unavailable</h1>
      <p className="signin-error" role="alert">{problem}</p>
      <Button variant="primary" onClick={() => window.location.reload()}>Try again</Button>
    </SignInFrame>
  );
}

export default function SignInPage({ bootstrapRequired, onAuthenticated, notice = null }: { bootstrapRequired: boolean; onAuthenticated: (status: AuthStatus) => void; notice?: SignedOutNotice | null }) {
  const titleId = useId();
  const [username, setUsername] = useState("operator");
  const [password, setPassword] = useState("");
  const [bootstrapToken, setBootstrapToken] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [identity, setIdentity] = useState<IdentityOptions | null>(null);
  const [github, setGithub] = useState<GithubFlow | null>(null);
  const [githubStatus, setGithubStatus] = useState<string | null>(null);
  const pollTimer = useRef<number | null>(null);
  // Bumped by Cancel and on unmount so a poll already in flight does not schedule another.
  const flowGeneration = useRef(0);

  useEffect(() => {
    if (bootstrapRequired) return;
    fetchIdentityOptions().then(setIdentity).catch(() => setIdentity(null));
  }, [bootstrapRequired]);
  useEffect(() => () => { flowGeneration.current += 1; if (pollTimer.current) window.clearTimeout(pollTimer.current); }, []);

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

  const canPasskey = passkeysSupported();
  const passkeySignIn = async () => {
    setSubmitting(true); setError(null);
    try { onAuthenticated(await signInWithPasskey()); }
    catch (requestError) { setError(requestError instanceof Error ? requestError.message : "Passkey sign-in failed"); }
    finally { setSubmitting(false); }
  };

  const [recoveryOpen, setRecoveryOpen] = useState(false);
  const [recoveryCode, setRecoveryCode] = useState("");
  const recoverySignIn = async () => {
    setSubmitting(true); setError(null);
    try { onAuthenticated(await signInWithRecoveryCode(recoveryCode)); }
    catch (requestError) { setError(requestError instanceof Error ? requestError.message : "That recovery code was not accepted"); }
    finally { setSubmitting(false); }
  };

  const githubSignIn = async () => {
    const generation = ++flowGeneration.current;
    const current = () => generation === flowGeneration.current;
    setError(null); setGithubStatus("Starting…");
    try {
      const flow = await startGithubSignIn();
      if (!current()) return;
      setGithub(flow); setGithubStatus("Waiting for you to authorize on GitHub…");
      const poll = async () => {
        try {
          const result = await pollGithubSignIn(flow.flowId);
          if (!current()) return;
          if (result.status === "complete" && result.session) { onAuthenticated(result.session); return; }
          if (result.status === "pending") { pollTimer.current = window.setTimeout(() => void poll(), flow.intervalSeconds * 1000); return; }
          setGithub(null); setGithubStatus(null); setError(result.error ?? (result.status === "expired" ? "The GitHub code expired; try again." : result.status === "denied" ? "GitHub authorization was denied." : "GitHub sign-in failed."));
        } catch (pollError) {
          if (!current()) return;
          setGithub(null); setGithubStatus(null); setError(pollError instanceof Error ? pollError.message : "GitHub sign-in failed");
        }
      };
      pollTimer.current = window.setTimeout(() => void poll(), flow.intervalSeconds * 1000);
    } catch (requestError) {
      if (!current()) return;
      setGithubStatus(null); setError(requestError instanceof Error ? requestError.message : "GitHub sign-in failed");
    }
  };

  const cancelGithub = () => {
    flowGeneration.current += 1;
    if (pollTimer.current) window.clearTimeout(pollTimer.current);
    pollTimer.current = null;
    setGithub(null); setGithubStatus(null);
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

  // The ways in, best first. The first one offered is the card's main button.
  const passkey = !bootstrapRequired && Boolean(identity?.passkey?.registered && canPasskey);
  const githubReady = !bootstrapRequired && Boolean(identity?.github.configured);
  const tailscale = !bootstrapRequired && Boolean(identity?.tailscale.linked);
  const lead = passkey ? "passkey" : githubReady ? "github" : tailscale ? "tailscale" : "password";
  const variantFor = (way: typeof lead) => (lead === way ? "primary" : "secondary");
  const heading = bootstrapRequired ? "Claim this BoxPilot server" : notice?.reason === "expired" ? "Your session ended" : "Sign in to BoxPilot";

  return (
    <SignInFrame labelledBy={titleId}>
      <span className="signin-kicker">{bootstrapRequired ? "Server-local owner setup" : "Private administration"}</span>
      <h1 id={titleId} className="signin-title">{heading}</h1>
      {notice && <p className="signin-notice" role="status">{signedOutWords(notice)}</p>}
      <p className="signin-lead">{bootstrapRequired
        ? "Make a short-lived token from an SSH session on the server, then create the first owner here."
        : "Sign in with this server's own BoxPilot account."}</p>

      {bootstrapRequired && (
        <div className="signin-bootstrap">
          <CodeBlock label="Run on the server">sudo -u boxpilot env BOXPILOT_STATE_DIRECTORY=/var/lib/boxpilot /usr/local/bin/node /opt/boxpilot/scripts/boxpilot-owner.mjs create-bootstrap-token</CodeBlock>
          <p className="signin-hint">The token expires in 15 minutes. Keep it out of chat and logs.</p>
        </div>
      )}

      {(passkey || githubReady || tailscale) && (
        <div className="signin-ways" role="group" aria-label="Ways to sign in">
          {passkey && <Button variant={variantFor("passkey")} disabled={submitting} onClick={() => void passkeySignIn()}>Sign in with a passkey</Button>}
          {githubReady && !github && <Button variant={variantFor("github")} disabled={submitting || Boolean(githubStatus)} onClick={() => void githubSignIn()}>Sign in with GitHub</Button>}
          {github && (
            <div className="signin-device" aria-live="polite">
              <span>Open <a href={github.verificationUri} target="_blank" rel="noreferrer">{github.verificationUri}</a> and enter</span>
              <code className="signin-device__code">{github.userCode}</code>
              <span className="signin-hint">{githubStatus}</span>
              <Button variant="ghost" onClick={cancelGithub}>Cancel</Button>
            </div>
          )}
          {tailscale && identity && <Button variant={variantFor("tailscale")} disabled={submitting} onClick={() => void tailscaleSignIn()}>Continue as {identity.tailscale.displayName ?? identity.tailscale.login} (Tailscale)</Button>}
          {devicePrompt && (
            <form className="signin-form" onSubmit={(event) => { event.preventDefault(); void tailscaleSignIn(devicePassword); }}>
              <p className="signin-hint">First time in this browser: confirm the password for <strong>{devicePrompt.username}</strong>. Next time, Tailscale alone signs you in here.</p>
              <Field label={`Password for ${devicePrompt.username || "this account"}`}>
                <SecretInput autoComplete="current-password" value={devicePassword} onValueChange={setDevicePassword} />
              </Field>
              <Button variant="primary" type="submit" disabled={submitting || devicePassword.length < 12}>Confirm and sign in</Button>
            </form>
          )}
          <p className="signin-divider"><span>or use your password</span></p>
        </div>
      )}

      <form className="signin-form" onSubmit={(event) => void submit(event)}>
        <Field label="Username">
          <TextInput required autoComplete="username" autoCapitalize="off" spellCheck={false} value={username} onValueChange={setUsername} pattern="[A-Za-z0-9][A-Za-z0-9_.-]{1,31}" />
        </Field>
        <Field label="Password">
          <SecretInput required autoComplete={bootstrapRequired ? "new-password" : "current-password"} minLength={12} maxLength={128} value={password} onValueChange={setPassword} />
        </Field>
        {bootstrapRequired && (
          <Field label="Bootstrap token">
            <SecretInput required autoComplete="off" value={bootstrapToken} onValueChange={setBootstrapToken} />
          </Field>
        )}
        {error && <p className="signin-error" role="alert">{error}</p>}
        <Button variant={bootstrapRequired || lead === "password" ? "primary" : "secondary"} type="submit" busy={submitting}>{submitting ? "Verifying..." : bootstrapRequired ? "Create owner" : "Sign in"}</Button>
      </form>

      {!bootstrapRequired && (
        recoveryOpen ? (
          <form className="signin-form signin-recovery" onSubmit={(event) => { event.preventDefault(); void recoverySignIn(); }}>
            <p className="signin-hint">Lost every passkey and your password? Enter one of the recovery codes you saved.</p>
            <Field label="Recovery code">
              <TextInput mono autoComplete="one-time-code" spellCheck={false} autoCapitalize="characters" placeholder="XXXXX-XXXXX-XXXXX-XXXXX" value={recoveryCode} onValueChange={setRecoveryCode} />
            </Field>
            <div className="signin-row">
              <Button variant="primary" type="submit" disabled={submitting || recoveryCode.trim().length < 16}>Use recovery code</Button>
              <Button variant="ghost" onClick={() => { setRecoveryOpen(false); setError(null); }}>Back</Button>
            </div>
          </form>
        ) : (
          <Button variant="ghost" className="signin-recovery-link" onClick={() => { setRecoveryOpen(true); setError(null); }}>Use a recovery code instead</Button>
        )
      )}

      {!bootstrapRequired && identity && (identity.tailscale.available && !identity.tailscale.linked || !identity.github.configured) && (
        <div className="signin-notes">
          {identity.tailscale.available && !identity.tailscale.linked && <p className="signin-hint">Connected over Tailscale as {identity.tailscale.login}. Sign in with your password, then link it in <strong>Settings → Account &amp; sign-in</strong> to skip the password next time.</p>}
          {!identity.github.configured && <p className="signin-hint">GitHub sign-in is not set up yet. Sign in with your password, then add your GitHub OAuth App client ID in <strong>Settings → Account &amp; sign-in</strong>.</p>}
        </div>
      )}
    </SignInFrame>
  );
}
