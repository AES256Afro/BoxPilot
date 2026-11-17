import { useCallback, useEffect, useState, type ChangeEvent } from "react";
import { useOperation } from "../../shell/ApproveDialog";
import { inspectOperation } from "../../operations";
import { Button, EmptyState, Field, KeyValue, Notice, Panel, SecretInput, Table, TextInput, Textarea, riskOf, type KeyValueItem, type TableColumn } from "../../ui";
import { shortImage } from "./appState";
import type { Entry } from "./types";

/*
 * Apps → Private apps (M71, ADR-019; owner only): the owner's own apps, whose source and images
 * are private. A manifest is saved to this server's private catalog, never to BoxPilot's public
 * one, and from then on the app is installed, updated, backed up and restored from the Catalog tab
 * like any other. The registry sign-in is what lets this server pull its images; only private apps'
 * downloads use it, and no token is ever shown back.
 */

export interface RegistrySignIn { registry: string; username: string | null }

/** What the preview shows of a manifest before it is saved. The server reads and checks the whole of it. */
export interface ManifestPreview { id: string | null; name: string | null; image: string | null; version: string | null }

const privatePrefix = "private-";
const manifestLimit = 64 * 1024;
const registryPattern = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*(?::[0-9]{1,5})?$/;

/** A YAML scalar as written on one line: quotes and a trailing comment taken off. */
function scalar(raw: string): string | null {
  const text = raw.trim();
  const quoted = /^"((?:[^"\\]|\\.)*)"|^'((?:[^']|'')*)'/.exec(text);
  if (quoted) return quoted[1] !== undefined ? quoted[1].replace(/\\(.)/g, "$1") : quoted[2].replace(/''/g, "'");
  const plain = text.replace(/\s+#.*$/, "").trim();
  return plain ? plain : null;
}

/**
 * The id, name and image of a pasted manifest, from its top-level keys (and `image`'s own), for the
 * preview and the typed confirmation. Not a YAML parser: anything it cannot see comes back null, and
 * the server's checks have the last word.
 */
export function previewManifest(text: string): ManifestPreview {
  const preview: ManifestPreview = { id: null, name: null, image: null, version: null };
  let inImage = false;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const top = /^([A-Za-z][\w-]*):(.*)$/.exec(line);
    if (top) {
      const [, key, rest] = top;
      inImage = key === "image" && !rest.trim();
      if (key === "id") preview.id = scalar(rest);
      else if (key === "name") preview.name = scalar(rest);
      else if (key === "image" && rest.trim().startsWith("{")) {
        preview.image = scalar(/reference:\s*([^,}]+)/.exec(rest)?.[1] ?? "");
        preview.version = scalar(/version:\s*([^,}]+)/.exec(rest)?.[1] ?? "");
      }
      continue;
    }
    if (!inImage) continue;
    const nested = /^\s+(reference|version):(.*)$/.exec(line);
    if (nested?.[1] === "reference") preview.image = scalar(nested[2]);
    else if (nested?.[1] === "version") preview.version = scalar(nested[2]);
  }
  return preview;
}

/** What stops this manifest being saved, as far as the preview can tell; the server checks the same. */
export function previewProblem(preview: ManifestPreview): string | undefined {
  if (!preview.id) return "No id found: a manifest starts with schemaVersion, id, name, category, description and image";
  if (!preview.id.startsWith(privatePrefix)) return `Its id must start with ${privatePrefix}`;
  if (!preview.image) return "No image.reference found";
  if (!preview.image.includes("@sha256:")) return "Its image must be pinned by digest: name:tag@sha256:…";
  return undefined;
}

function stateOf(entry: Entry): string {
  if (!entry.live) return "State unknown";
  if (entry.live.installed) return "Installed";
  return entry.live.dataPresent ? "Not installed, data kept" : "Not installed";
}

export function PrivateAppsTab({ csrfToken, entries, onChanged }: { csrfToken: string; entries: Entry[]; onChanged: () => void }) {
  const [registries, setRegistries] = useState<RegistrySignIn[] | null>(null);
  const [readError, setReadError] = useState<string | null>(null);
  const [registry, setRegistry] = useState("ghcr.io");
  const [username, setUsername] = useState("");
  const [token, setToken] = useState("");
  const [text, setText] = useState("");
  const [fileProblem, setFileProblem] = useState<string | null>(null);

  const read = useCallback(() => inspectOperation<{ registries?: RegistrySignIn[] }>("registry.inspect")
    .then(({ result }) => {
      if (!Array.isArray(result?.registries)) throw new Error("The registry sign-ins came back in a shape this page cannot read");
      setRegistries(result.registries);
      setReadError(null);
    })
    .catch((error: unknown) => { setRegistries(null); setReadError(error instanceof Error ? error.message : "The registry sign-ins could not be read"); }), []);
  useEffect(() => { void read(); }, [read]);

  // A form clears once what it started has worked; a refusal leaves it as it was typed.
  const { start, dialog } = useOperation(csrfToken, (job) => {
    if (job.state === "completed" && job.type === "op:registry.signin") { setUsername(""); setToken(""); }
    if (job.state === "completed" && job.type === "op:catalog.private.save") setText("");
    void read();
    onChanged();
  });

  const chooseFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    if (file.size > manifestLimit) { setFileProblem(`${file.name} is larger than 64 KiB`); return; }
    try {
      setText(await file.text());
      setFileProblem(null);
    } catch {
      setFileProblem(`${file.name} could not be read`);
    }
  };

  const preview = previewManifest(text);
  const problem = text.trim() ? previewProblem(preview) : undefined;
  const existing = preview.id ? entries.find((entry) => entry.manifest.id === preview.id) ?? null : null;
  const tooLarge = new Blob([text]).size > manifestLimit;
  const canSave = Boolean(text.trim()) && !problem && !tooLarge;

  const save = () => {
    if (!canSave || !preview.id) return;
    const name = preview.name ?? preview.id;
    start({
      operationId: "catalog.private.save",
      title: `${existing ? "Replace" : "Add"} the private app ${name}`,
      parameters: { id: preview.id, manifest: text },
      preview: (
        <span>
          Saves {name} (<code>{preview.id}</code>) to this server&apos;s private catalog, on <code>{shortImage(preview.image)}</code>.
          {existing ? (existing.live?.installed ? " It replaces the manifest saved before; Update then offers the new image." : " It replaces the manifest saved before.") : " It is then installed from the Catalog tab like any other app."}
          {" "}A manifest can ask for anything a catalog app can, root on this server included: save only one you trust.
        </span>
      ),
    });
  };

  const remove = (entry: Entry) => start({
    operationId: "catalog.private.remove",
    title: `Remove the private app ${entry.manifest.name}`,
    parameters: { id: entry.manifest.id },
    preview: <span>Deletes {entry.manifest.name}&apos;s manifest (<code>{entry.manifest.id}</code>) from this server. It leaves the Catalog tab; save the manifest again to bring it back.</span>,
  });

  const signIn = () => start({
    operationId: "registry.signin",
    title: `Sign in to ${registry}`,
    parameters: { registry, username, token },
    preview: <span>Checks the token with <code>{registry}</code> as {username} and saves it on this server, readable by root only. Only private apps&apos; downloads use it. If {registry} refuses it, the sign-in saved before stays.</span>,
  });

  const signOut = (signedIn: RegistrySignIn) => start({
    operationId: "registry.signout",
    title: `Sign out of ${signedIn.registry}`,
    parameters: { registry: signedIn.registry },
    preview: <span>Forgets the token for <code>{signedIn.registry}</code>. Private apps keep running; downloading their images again needs a new sign-in.</span>,
  });

  const registryColumns: Array<TableColumn<RegistrySignIn>> = [
    { id: "registry", header: "Registry", sortValue: (row) => row.registry, cell: (row) => <code className="catalog-strong">{row.registry}</code> },
    { id: "username", header: "Signed in as", cell: (row) => row.username ?? "—" },
    { id: "actions", header: <span className="ui-visually-hidden">Actions</span>, label: "Actions", className: "catalog-actions-cell", cell: (row) => <span className="catalog-actions"><Button risk={riskOf("registry.signout")} aria-label={`Sign out of ${row.registry}`} onClick={() => signOut(row)}>Sign out</Button></span> },
  ];

  const appColumns: Array<TableColumn<Entry>> = [
    { id: "name", header: "App", sortValue: (entry) => entry.manifest.name, cell: (entry) => <span className="catalog-private__app"><strong>{entry.manifest.name}</strong> <code className="catalog-dim">{entry.manifest.id}</code></span> },
    { id: "version", header: "Image", hideOnPhone: true, cell: (entry) => <code className="catalog-dim">{entry.manifest.image.version ?? shortImage(entry.manifest.image.reference)}</code> },
    { id: "state", header: "State", cell: stateOf },
    {
      id: "actions", header: <span className="ui-visually-hidden">Actions</span>, label: "Actions", className: "catalog-actions-cell", cell: (entry) => (
        <span className="catalog-actions">
          {entry.live && !entry.live.installed && !entry.live.dataPresent && <Button risk={riskOf("catalog.private.remove")} aria-label={`Remove ${entry.manifest.name}`} onClick={() => remove(entry)}>Remove</Button>}
        </span>
      ),
    },
  ];

  const previewFacts: KeyValueItem[] = [
    { id: "id", label: "Id", mono: true, value: preview.id ?? "—", hint: existing ? "replaces the one saved before" : undefined },
    { id: "name", label: "Name", value: preview.name ?? "—" },
    { id: "image", label: "Image", mono: true, value: preview.image ? shortImage(preview.image) : "—", hint: preview.version ?? undefined },
  ];
  const registryProblem = registry && !registryPattern.test(registry) ? "A host name such as ghcr.io, with a port if it has one" : undefined;
  const canSignIn = Boolean(registry && username && token.length >= 8) && !registryProblem && !/\s/.test(token);

  return (
    <div className="catalog-private">
      {dialog}
      <Panel title="Registry sign-in" count={registries ? registries.length : undefined} meta="used only to download private apps' images" className="catalog-private__panel">
        {readError && <Notice tone="danger" live className="catalog-inset" action={<Button onClick={() => void read()}>Try again</Button>}>{readError}</Notice>}
        <Table
          caption="Registries this server is signed in to"
          columns={registryColumns}
          rows={registries ?? []}
          rowKey={(row) => row.registry}
          empty={registries === null ? (readError ? "Not read." : "Reading…") : <EmptyState title="Not signed in to any registry">Sign in below to pull private images.</EmptyState>}
        />
        <form className="catalog-private__form catalog-private__form--inset" aria-label="Sign in to a registry" onSubmit={(event) => { event.preventDefault(); if (canSignIn) signIn(); }}>
          <div className="catalog-private__fields">
            <Field label="Registry" error={registryProblem}>
              <TextInput mono value={registry} onValueChange={(value) => setRegistry(value.trim().toLowerCase())} autoComplete="off" spellCheck={false} />
            </Field>
            <Field label="User name">
              <TextInput mono value={username} onValueChange={(value) => setUsername(value.trim())} autoComplete="off" spellCheck={false} />
            </Field>
            <Field label="Token" hint="A token that can read packages. Saved for root only; never shown again.">
              <SecretInput maxLength={4096} value={token} onValueChange={(value) => setToken(value.trim())} />
            </Field>
          </div>
          <div className="catalog-sheet__actions">
            <Button type="submit" variant="primary" risk={riskOf("registry.signin")} disabled={!canSignIn}>Sign in</Button>
          </div>
        </form>
      </Panel>

      <Panel title="Private apps" count={entries.length} meta="from this server's private catalog" className="catalog-private__panel">
        <Table
          caption="Private apps"
          columns={appColumns}
          rows={entries}
          rowKey={(entry) => entry.manifest.id}
          stackOnPhone
          empty={<EmptyState title="No private apps yet">Add one below from its manifest.</EmptyState>}
        />
      </Panel>

      <Panel title="Add or replace" padded className="catalog-private__panel">
        <form className="catalog-private__form" aria-label="Add or replace a private app" onSubmit={(event) => { event.preventDefault(); save(); }}>
          <Field label="Manifest" hint={<>A catalog manifest in YAML: its id starts with <code>{privatePrefix}</code> and its image is pinned by digest.</>} error={tooLarge ? "Larger than 64 KiB" : fileProblem ?? problem}>
            <Textarea mono rows={12} value={text} onValueChange={(value) => { setText(value); setFileProblem(null); }} spellCheck={false} />
          </Field>
          <label className="catalog-private__file">
            <span>Or choose a file</span>
            <input type="file" accept=".yaml,.yml,application/yaml,text/yaml" onChange={(event) => void chooseFile(event)} />
          </label>
          {text.trim() && !problem && <KeyValue layout="rows" className="catalog-facts" items={previewFacts} />}
          <div className="catalog-sheet__actions">
            <Button type="submit" variant="primary" risk={riskOf("catalog.private.save")} disabled={!canSave}>{existing ? "Replace" : "Add"}</Button>
          </div>
        </form>
      </Panel>
    </div>
  );
}
