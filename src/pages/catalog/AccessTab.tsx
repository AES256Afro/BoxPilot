import { useCallback, useEffect, useState } from "react";
import { Button, Field, KeyValue, Notice, Panel, SecretInput, mayStart, riskOf } from "../../ui";
import { runRead } from "./appState";
import type { CatalogContext, Entry } from "./types";

/*
 * Getting into an app (M33.11). Sign-in puts everything needed in one place: where the page is,
 * the username if there is one, the password (revealed with the owner's password, like any secret)
 * and a way to change it. Pi-hole was the prompt: a generated password behind an elevated view, and
 * a variable name to find in Settings if you wanted your own. Secrets shows every generated
 * password and token the app keeps in its .env, to the owner, after the same check.
 */

interface Secret { name: string; label: string; value: string }

export function AccessTab({ entry, ctx, mode }: { entry: Entry; ctx: CatalogContext; mode: "signin" | "secrets" }) {
  const { manifest, live } = entry;
  const { csrfToken, role, act } = ctx;
  const owner = role === "owner";
  const signIn = mode === "signin";
  const [items, setItems] = useState<Secret[] | null>(null);
  const [needsPassword, setNeedsPassword] = useState(false);
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [newPassword, setNewPassword] = useState("");

  const reveal = useCallback(async (ownerPassword?: string) => {
    setBusy(true);
    try {
      if (ownerPassword) {
        const elevate = await fetch("/api/v1/auth/elevate", { method: "POST", headers: { "Content-Type": "application/json", "X-BoxPilot-CSRF": csrfToken }, body: JSON.stringify({ password: ownerPassword }) });
        if (!elevate.ok) { const body = (await elevate.json().catch(() => ({}))) as { error?: string }; throw new Error(body.error ?? "Invalid password"); }
        window.dispatchEvent(new Event("boxpilot:auth-changed"));
      }
      const { response, body } = await runRead<{ secrets?: Secret[] }>(csrfToken, "app.secrets", { id: manifest.id });
      if (response.status === 401 && body.code === "elevation_required") { setItems(null); setNeedsPassword(true); setPassword(""); setError(null); return; }
      if (!response.ok) throw new Error(body.error ?? "Could not read secrets");
      setItems((body.result?.secrets ?? []).filter((item) => !signIn || item.name === manifest.signIn?.passwordEnv));
      setNeedsPassword(false); setPassword(""); setError(null);
    } catch (requestError) {
      const refused = requestError instanceof Error && /owner|Viewers/i.test(requestError.message);
      setItems(null);
      setNeedsPassword(!refused);
      setPassword("");
      setError(requestError instanceof Error ? requestError.message : "Could not read secrets");
    } finally {
      setBusy(false);
    }
  }, [csrfToken, manifest.id, manifest.signIn?.passwordEnv, signIn]);
  // Secrets are what the tab is for, so it asks at once; Sign-in reveals the password on request.
  useEffect(() => { if (!signIn && owner) void reveal(); }, [signIn, owner, reveal]);

  const prompt = needsPassword && (
    <form className="catalog-access__unlock" onSubmit={(event) => { event.preventDefault(); if (password.length >= 12) void reveal(password); }}>
      <Field label="Owner password" hint={`Reveals ${signIn ? "the sign-in password" : "generated passwords and tokens"}. It unlocks high-risk actions for 10 minutes and is recorded in the audit log.`}>
        <SecretInput autoComplete="current-password" value={password} onValueChange={setPassword} />
      </Field>
      <Button variant="primary" type="submit" busy={busy} disabled={password.length < 12}>Reveal</Button>
    </form>
  );
  const problem = error && <Notice tone="danger" live title="Not revealed">{error}</Notice>;

  if (!signIn) {
    return (
      <div className="catalog-tab">
        {problem}
        {prompt}
        {items && items.length === 0 && <p className="catalog-quiet">This app has no generated secrets.</p>}
        {items && items.length > 0 && (
          <Panel level={3} padded title="Secrets" count={items.length} className="catalog-secrets">
            {items.map((item) => (
              <Field key={item.name} label={item.label} hint={<code>{item.name}</code>}>
                <SecretInput readOnly value={item.value} onFocus={(event) => event.currentTarget.select()} />
              </Field>
            ))}
          </Panel>
        )}
        <p className="catalog-quiet">Stored in the app's <code>.env</code> on the server. Copy what you need, then close.</p>
      </div>
    );
  }

  if (!manifest.signIn || !live) return null;
  const portId = manifest.signIn.port ?? live.urls[0]?.id;
  const port = live.urls.find((url) => url.id === portId) ?? live.urls[0];
  const usernameEnv = manifest.signIn.usernameEnv;
  const username = manifest.signIn.username ?? (usernameEnv ? live.state?.values?.env?.[usernameEnv] ?? manifest.env.find((env) => env.name === usernameEnv)?.default ?? null : null);
  const passwordLabel = manifest.env.find((env) => env.name === manifest.signIn?.passwordEnv)?.label ?? "Password";
  const revealed = items && items.length > 0 ? items[0] : null;

  return (
    <div className="catalog-tab">
      {port && (
        <div className="catalog-sheet__actions">
          <a className="ui-button ui-button--primary" href={ctx.openUrl(port, manifest)} target="_blank" rel="noreferrer"><span className="ui-button__label">Open {manifest.name}'s sign-in page</span></a>
        </div>
      )}
      <KeyValue layout="rows" className="catalog-facts" items={[
        { id: "username", label: "Username", mono: username !== null, value: username !== null ? String(username) : `none; ${manifest.name} asks only for the password` },
        ...(!revealed ? [{ id: "password", label: passwordLabel, value: owner ? (needsPassword ? "enter your owner password below" : <Button onClick={() => void reveal()} busy={busy}>Reveal</Button>) : "only the owner can reveal it" }] : []),
      ]} />
      {revealed && (
        <Field label={passwordLabel}>
          <SecretInput readOnly value={revealed.value} onFocus={(event) => event.currentTarget.select()} />
        </Field>
      )}
      {problem}
      {prompt}
      {manifest.signIn.note && <p className="catalog-note">{manifest.signIn.note}</p>}
      {mayStart(role, "app.password.set") && (
        <form className="catalog-access__change" onSubmit={(event) => {
          event.preventDefault();
          if (newPassword.length < 8) return;
          act({ operationId: "app.password.set", title: `Change ${manifest.name}'s sign-in password`, parameters: { id: manifest.id, password: newPassword }, preview: <span>Sets a new {passwordLabel.toLowerCase()} and recreates {manifest.name} so it takes effect: a few seconds of downtime, data untouched.</span> });
        }}>
          <Field label="New password" hint="8 characters or more.">
            <SecretInput autoComplete="new-password" minLength={8} maxLength={128} value={newPassword} onValueChange={setNewPassword} />
          </Field>
          <Button type="submit" risk={riskOf("app.password.set")} disabled={newPassword.length < 8}>Change password</Button>
        </form>
      )}
    </div>
  );
}
