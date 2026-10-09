import { useEffect, useRef, useState } from "react";
import { Button, CodeBlock, Field, KeyValue, Notice, Panel, SecretInput, Textarea, mayStart, riskOf } from "../../ui";
import { runRead } from "./appState";
import type { CatalogContext, Entry } from "./types";

/*
 * An app's effective configuration (M33.11): where it lives, its .env with private values masked,
 * and its raw compose.yaml, read only after the owner's password because it may hold credentials,
 * and editable as a last resort: docker compose validates it, BoxPilot rolls back if the app does
 * not come up, and the next Settings change or Update regenerates it from the manifest.
 */

interface Effective { directory: string; env: Array<{ name: string; value: string; secret: boolean }> }

export function ConfigTab({ entry, ctx }: { entry: Entry; ctx: CatalogContext }) {
  const { manifest } = entry;
  const { csrfToken, act, role, takeComposeDraft } = ctx;
  const [effective, setEffective] = useState<Effective | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [compose, setCompose] = useState<string | null>(null);
  const [draft, setDraft] = useState<string | null>(null);
  // An edit whose Apply was cancelled or failed comes back here rather than being lost with the sheet.
  useEffect(() => {
    const kept = takeComposeDraft(manifest.id);
    if (kept !== null) setDraft(kept);
  }, [takeComposeDraft, manifest.id]);
  const [access, setAccess] = useState({ needsPassword: false, password: "", busy: false, error: null as string | null });
  const composeRead = useRef<AbortController | null>(null);
  const owner = role === "owner";
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let live = true;
    setError(null);
    runRead<{ directory?: string; env?: Effective["env"] }>(csrfToken, "app.config.inspect", { id: manifest.id })
      .then(({ response, body }) => {
        if (!live) return;
        if (!response.ok || !body.result) throw new Error(body.error ?? "Could not read the configuration");
        // Normalised here so the tab can read these without checking each one: a partial answer
        // used to throw on env.length while rendering and lose the whole dialog.
        setEffective({ directory: body.result.directory ?? "", env: body.result.env ?? [] });
      })
      .catch((requestError: unknown) => { if (live) setError(requestError instanceof Error ? requestError.message : "Could not read the configuration"); });
    return () => { live = false; };
  }, [csrfToken, manifest.id, attempt]);
  // Leaving the tab (or closing the sheet) abandons a raw read still under way. Only on leaving:
  // a cleanup keyed on the app ran after the commit that showed the button and aborted a read
  // clicked in between, which left "Reading…" up for good.
  useEffect(() => () => { composeRead.current?.abort(); composeRead.current = null; }, []);

  const readRawCompose = async () => {
    if (access.busy) return;
    const password = access.password;
    composeRead.current?.abort();
    const controller = new AbortController(); composeRead.current = controller;
    const deadline = setTimeout(() => controller.abort(), 15_000);
    setAccess((current) => ({ ...current, busy: true, password: "", error: null }));
    try {
      if (password) {
        const elevated = await fetch("/api/v1/auth/elevate", { method: "POST", signal: controller.signal, headers: { "Content-Type": "application/json", "X-BoxPilot-CSRF": csrfToken }, body: JSON.stringify({ password }) });
        const body = await elevated.json().catch(() => ({})) as { error?: string };
        if (!elevated.ok) throw new Error(body.error ?? "Owner verification failed");
        window.dispatchEvent(new Event("boxpilot:auth-changed"));
      }
      const { response, body } = await runRead<{ compose?: unknown }>(csrfToken, "app.compose.inspect", { id: manifest.id }, { signal: controller.signal });
      if (controller.signal.aborted) return;
      if (response.status === 401 && body.code === "elevation_required") { setAccess({ needsPassword: true, password: "", busy: false, error: null }); return; }
      if (!response.ok) { if (response.status === 403) setAccess((current) => ({ ...current, needsPassword: false })); throw new Error(body.error ?? "The Compose file could not be read"); }
      if (typeof body.result?.compose !== "string") throw new Error("The Compose file response was incomplete");
      setCompose(body.result.compose);
      setAccess({ needsPassword: false, password: "", busy: false, error: null });
    } catch (readError) {
      if (composeRead.current !== controller) return;
      setAccess((current) => ({ ...current, busy: false, error: controller.signal.aborted ? "The Compose file could not be read in time. Try again." : readError instanceof Error ? readError.message : "The Compose file could not be read" }));
    } finally {
      clearTimeout(deadline);
      if (composeRead.current === controller) composeRead.current = null;
    }
  };

  return (
    <div className="catalog-tab">
      {error && <Notice tone="danger" live title="The configuration could not be read" action={<Button onClick={() => setAttempt((count) => count + 1)}>Try again</Button>}>{error}</Notice>}
      <KeyValue layout="rows" className="catalog-facts" items={[
        { id: "directory", label: "Directory", mono: true, value: effective ? (effective.directory || "—") : "Reading…" },
        { id: "masked", label: "Private values", value: "Masked here; the raw Compose file shows them to the owner" },
      ]} />
      {effective && effective.env.length > 0 && draft === null && (
        <CodeBlock label=".env" meta={`${effective.env.length} values`} maxHeight="16rem">{effective.env.map((item) => `${item.name}=${item.value}`).join("\n")}</CodeBlock>
      )}

      <Panel level={3} padded title="compose.yaml" className="catalog-compose">
        {draft === null ? (
          compose === null ? (
            owner ? (
              <div className="catalog-compose__read">
                {access.needsPassword && (
                  <Field label="Owner password" hint="Unlocks high-risk actions for 10 minutes, and is recorded in the audit log.">
                    <SecretInput aria-label="Owner password for Compose" autoComplete="current-password" value={access.password} onValueChange={(password) => setAccess((current) => ({ ...current, password }))} />
                  </Field>
                )}
                {access.error && <Notice tone="danger" live title="The Compose file was not read">{access.error}</Notice>}
                <Button disabled={access.busy || (access.needsPassword && access.password.length < 12)} busy={access.busy} onClick={() => void readRawCompose()}>
                  {access.busy ? "Reading Compose file…" : access.needsPassword ? "Unlock and read Compose file" : "Read Compose file"}
                </Button>
              </div>
            ) : <p className="catalog-quiet">The raw Compose file may hold credentials, so only the owner reads it.</p>
          ) : (
            <>
              <CodeBlock label="compose.yaml" maxHeight="24rem" wrap={false}>{compose}</CodeBlock>
              {mayStart(role, "app.compose.edit") && <div className="catalog-inline"><Button onClick={() => setDraft(compose)}>Edit raw</Button></div>}
            </>
          )
        ) : (
          <>
            <Notice tone="warning" title="Full control, full responsibility">docker compose validates the file and BoxPilot rolls back if the app does not come up, but the next Settings change or Update regenerates it from the manifest.</Notice>
            <Field label="Compose file">
              <Textarea mono spellCheck={false} rows={16} value={draft} onValueChange={setDraft} />
            </Field>
            <div className="catalog-inline">
              <Button onClick={() => setDraft(null)}>Cancel</Button>
              <Button variant="primary" risk={riskOf("app.compose.edit")} disabled={!draft.trim() || draft === compose} onClick={() => act({ operationId: "app.compose.edit", title: `Apply edited compose file to ${manifest.name}`, parameters: { id: manifest.id, compose: draft }, preview: <span>Replaces <code>compose.yaml</code> verbatim and recreates the containers. Rolled back if {manifest.name} does not come up.</span> }, { composeDraft: draft })}>Apply</Button>
            </div>
          </>
        )}
      </Panel>
    </div>
  );
}
