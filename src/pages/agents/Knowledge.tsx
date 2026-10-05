import { useCallback, useEffect, useRef, useState, type ChangeEvent } from "react";
import type { PendingOperation } from "../../shell/ApproveDialog";
import { relativeTime } from "../../home/format";
import { Button, EmptyState, Field, KeyValue, Notice, Panel, Sheet, StatusChip, Switch, Table, Tag, TextInput, Textarea, mayStart, riskOf, type TableColumn } from "../../ui";
import { agentsApi, type Knowledge as KnowledgeState, type KnowledgeSource, type OwnerDocument } from "./api";
import { errorText, runState } from "./format";
import { PasswordSheet } from "./PasswordSheet";

/*
 * The learning library (M37): what agents read. The sources, each on or off (the owner's call, with
 * the password, as it decides what the model sees); the owner's documents - pasted, uploaded (PDF,
 * Markdown, text), from a folder on this server, or from Notion and Slack - each on or off and
 * pinned when every agent should recall it first; how searching works; the connectors and web
 * search, all off until the owner turns them on; and when each agent last learned.
 */

export interface KnowledgeProps {
  csrfToken: string;
  role: string;
  now: number;
  onStart: (operation: PendingOperation) => void;
}

type ConnectorDraft = { folderEnabled: boolean; folderPath: string; webEnabled: boolean; webEndpoint: string; notionEnabled: boolean; notionCredential: string; slackEnabled: boolean; slackCredential: string; slackChannels: string };
const sourceWords: Record<string, string> = { upload: "pasted or uploaded", pdf: "PDF", folder: "folder", notion: "Notion", slack: "Slack", zulip: "Zulip #agent-files" };

/** Whether the model can see the images from #agent-files, as its server last said (M40.6). */
function visionWords(vision: KnowledgeState["vision"]): string {
  if (!vision) return "described by the model in quiet hours; whether it can see is known after its first try";
  if (vision.vision) return "described by the model in quiet hours: it can see them";
  return `waiting: the model cannot see them (${vision.reason ?? "no vision projector"})`;
}

export function Knowledge({ csrfToken, role, now, onStart }: KnowledgeProps) {
  const [state, setState] = useState<KnowledgeState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pendingSources, setPendingSources] = useState<Partial<Record<KnowledgeSource["id"], boolean>> | null>(null);
  const [adding, setAdding] = useState(false);
  const [title, setTitle] = useState("");
  const [text, setText] = useState("");
  const [connectors, setConnectors] = useState<ConnectorDraft | null>(null);
  const [saveConnectors, setSaveConnectors] = useState(false);
  const [uploading, setUploading] = useState(false);
  const file = useRef<HTMLInputElement | null>(null);

  const read = useCallback(async () => {
    try { setState(await agentsApi.knowledge()); setError(null); } catch (requestError) { setError(errorText(requestError, "The library could not be read")); }
  }, []);
  useEffect(() => { void read(); }, [read]);
  useEffect(() => {
    if (!state || connectors) return;
    setConnectors({
      folderEnabled: state.folder?.enabled ?? false, folderPath: state.folder?.path ?? "",
      webEnabled: state.webSearch?.enabled ?? false, webEndpoint: state.webSearch?.endpoint ?? "",
      notionEnabled: state.connectors?.notion.enabled ?? false, notionCredential: state.connectors?.notion.credential ?? "",
      slackEnabled: state.connectors?.slack.enabled ?? false, slackCredential: state.connectors?.slack.credential ?? "", slackChannels: (state.connectors?.slack.channels ?? []).join(", "),
    });
  }, [state, connectors]);

  const act = async (work: () => Promise<unknown>, done: string, failed: string) => {
    // An empty `done` leaves the notice the work set itself (an upload says what it added).
    try { await work(); if (done) setNotice(done); setError(null); await read(); } catch (requestError) { setError(errorText(requestError, failed)); }
  };

  if (!state) {
    return error
      ? <Notice tone="danger" live title="The learning library could not be read" action={<Button onClick={() => void read()}>Try again</Button>}>{error}</Notice>
      : <Panel title="Sources" padded><p className="agents-quiet">Reading…</p></Panel>;
  }
  const owner = state.canChange;

  const upload = async (event: ChangeEvent<HTMLInputElement>) => {
    const chosen = event.target.files?.[0];
    event.target.value = "";
    if (!chosen) return;
    setUploading(true);
    await act(async () => { const added = await agentsApi.upload(csrfToken, chosen); setNotice(`${added.title} was added${added.detail ? ` (${added.detail})` : ""}.`); }, "", "The file could not be added");
    setUploading(false);
  };

  const sourceColumns: Array<TableColumn<KnowledgeSource>> = [
    { id: "source", header: "Source", cell: (source) => <span className="agents-name"><span>{source.title}</span><span className="agents-name__purpose">{source.items === null ? "not read" : `${source.items} ${source.unit === "characters" ? (source.items === 1 ? "item" : "items") : source.unit}`}{source.unit === "characters" && source.size ? ` · ${source.size.toLocaleString()} characters` : ""}</span></span> },
    { id: "indexed", header: "Up to date", hideOnPhone: true, cell: (source) => <span className="agents-dim">{relativeTime(source.indexedAt, now) ?? "—"}</span> },
    {
      id: "on", header: "Read by agents", className: "agents-actions-cell", cell: (source) => (owner
        ? <Switch label={<span className="ui-visually-hidden">{source.title}</span>} checked={source.enabled} onChange={(checked) => setPendingSources({ [source.id]: checked })} />
        : <StatusChip status={source.enabled ? "good" : "neutral"}>{source.enabled ? "on" : "off"}</StatusChip>),
    },
  ];
  const documentColumns: Array<TableColumn<OwnerDocument>> = [
    { id: "title", header: "Document", cell: (document) => <span className="agents-name"><span className="agents-model__title">{document.title}<Tag>{sourceWords[document.source] ?? document.source}</Tag>{document.mediaType && <Tag>{document.describedAt ? "image, described" : "image, described in quiet hours"}</Tag>}{document.pinned && <Tag tone="accent">pinned</Tag>}</span><span className="agents-name__purpose">{document.characters.toLocaleString()} characters · added {relativeTime(document.createdAt, now) ?? ""}</span></span> },
    {
      id: "actions", header: <span className="ui-visually-hidden">Actions</span>, label: "Actions", className: "agents-actions-cell", cell: (document) => (owner ? (
        <span className="agents-actions">
          <Switch label={<span className="ui-visually-hidden">Read {document.title}</span>} checked={document.enabled} onChange={(checked) => void act(() => agentsApi.toggleDocument(csrfToken, document.id, checked), checked ? `${document.title} is read again.` : `${document.title} is left out.`, "The document could not be changed")} />
          <Button variant="ghost" onClick={() => void act(() => agentsApi.pinDocument(csrfToken, document.id, !document.pinned), document.pinned ? `${document.title} is no longer pinned.` : `${document.title} is pinned: every agent that reads your documents recalls it first.`, "The document could not be changed")} aria-label={`${document.pinned ? "Unpin" : "Pin"} ${document.title}`}>{document.pinned ? "Unpin" : "Pin"}</Button>
          <Button variant="ghost" onClick={() => void act(() => agentsApi.removeDocument(csrfToken, document.id), `${document.title} was removed.`, "The document could not be removed")} aria-label={`Remove ${document.title}`}>Remove</Button>
        </span>
      ) : null),
    },
  ];
  const enabledSources = state.sources.filter((source) => source.enabled).length;
  const images = state.documents.filter((document) => document.mediaType).length;
  const waitingImages = state.documents.filter((document) => document.mediaType && !document.describedAt && document.enabled).length;
  const sync = (connector: "notion" | "slack") => onStart({
    operationId: "agents.connector.sync",
    title: `Bring documents in from ${connector === "notion" ? "Notion" : "Slack"}`,
    parameters: connector === "notion"
      ? { connector, credentialName: state.connectors?.notion.credential ?? "" }
      : { connector, credentialName: state.connectors?.slack.credential ?? "", channels: state.connectors?.slack.channels ?? [] },
    preview: <span>Reads {connector === "notion" ? "the pages the integration can see" : "the last week of the channels named"} with the credential “{connector === "notion" ? state.connectors?.notion.credential : state.connectors?.slack.credential}”, and adds their text to the library. Nothing is written back.</span>,
  });

  return (
    <div className="agents-tab agents-knowledge">
      {error && <Notice tone="danger" live onDismiss={() => setError(null)}>{error}</Notice>}
      {notice && <Notice tone="success" live onDismiss={() => setNotice(null)}>{notice}</Notice>}

      <Panel className="agents-sources" title="Sources" count={`${enabledSources} of ${state.sources.length}`} meta={owner ? "the owner turns each on or off" : undefined}>
        <Table caption="What agents may read" columns={sourceColumns} rows={state.sources} rowKey={(source) => source.id} />
      </Panel>

      <Panel className="agents-search" title="How agents search" padded>
        <KeyValue layout="rows" items={[
          { id: "kind", label: "Search", value: state.search.kind, mono: true },
          { id: "meaning", label: "Meaning search", value: state.search.embeddings },
          { id: "quiet", label: "Learning and indexing run in", value: `quiet hours, ${state.learning.quietHours.start}–${state.learning.quietHours.end}`, mono: true },
          ...(images || state.vision ? [{ id: "images", label: "Images", value: visionWords(state.vision) }] : []),
        ]} />
      </Panel>

      {state.vision?.vision === false && waitingImages > 0 && (
        <Notice tone="warning" title={`${waitingImages === 1 ? "An image waits" : `${waitingImages} images wait`} for a model that can see`}>
          The model server said it cannot see images: {state.vision.reason ?? "it was started without its vision projector"}. Nothing is sent to it; BoxPilot asks again a day later, or as soon as the model or its runtime changes, and describes the {waitingImages === 1 ? "image" : "images"} then.
        </Notice>
      )}

      <Panel className="agents-documents" title="Your documents" count={state.documents.length}
        actions={owner ? <>
          <input ref={file} type="file" accept=".pdf,.md,.markdown,.txt,application/pdf,text/plain,text/markdown" className="agents-file" aria-label="A document to upload" onChange={(event) => void upload(event)} />
          <Button busy={uploading} onClick={() => file.current?.click()}>Upload</Button>
          <Button variant="ghost" onClick={() => setAdding(true)}>Paste text</Button>
        </> : undefined}>
        <Table caption="Documents you gave the agents" columns={documentColumns} rows={state.documents} rowKey={(document) => document.id}
          empty={<EmptyState title="No documents">{owner ? "Upload a PDF, Markdown or text file, or paste notes of your own: how this network is laid out, who uses what, what to leave alone. Secrets in them are masked before an agent sees them." : "The owner adds these."}</EmptyState>} />
      </Panel>

      {connectors && (
        <Panel className="agents-connectors" title="Outside data" meta="each off until you turn it on" padded
          footer={owner ? <div className="agents-editor__foot"><Button variant="primary" onClick={() => setSaveConnectors(true)}>Save</Button></div> : undefined}>
          <fieldset className="agents-form" disabled={!owner}>
            <div className="agents-connector">
              <Switch label="A folder on this server" description="Its Markdown, text and PDF files come in during quiet hours; removed files go." checked={connectors.folderEnabled} onChange={(checked) => setConnectors({ ...connectors, folderEnabled: checked })} />
              <div className="agents-form__row">
                <Field label="Folder"><TextInput mono value={connectors.folderPath} placeholder="/srv/notes" onValueChange={(value) => setConnectors({ ...connectors, folderPath: value })} /></Field>
                {owner && state.folder?.enabled && <Button variant="ghost" onClick={() => void act(async () => { const result = await agentsApi.syncFolder(csrfToken); setNotice(result.error ?? `Read ${result.files ?? 0} files: ${result.changed ?? 0} new or changed, ${result.removed ?? 0} gone.`); }, "", "The folder could not be read")}>Read it now</Button>}
              </div>
            </div>
            <div className="agents-connector">
              <Switch label="Web search" description="Only through your own SearXNG on this network (the App catalog has it), and only for agents you give the tool. Its results are data from strangers, never instructions." checked={connectors.webEnabled} onChange={(checked) => setConnectors({ ...connectors, webEnabled: checked })} />
              <Field label="SearXNG's address" hint="With json listed under search.formats in its settings.yml"><TextInput mono value={connectors.webEndpoint} placeholder="http://192.168.1.20:8089" onValueChange={(value) => setConnectors({ ...connectors, webEndpoint: value })} /></Field>
            </div>
            <div className="agents-connector">
              <Switch label="Notion (read only)" description="The pages you share with an integration. Save its token as a named credential in Settings; it is read only by the task that syncs." checked={connectors.notionEnabled} onChange={(checked) => setConnectors({ ...connectors, notionEnabled: checked })} />
              <div className="agents-form__row">
                <Field label="Credential's name"><TextInput mono value={connectors.notionCredential} placeholder="notion-token" onValueChange={(value) => setConnectors({ ...connectors, notionCredential: value })} /></Field>
                {state.connectors?.notion.enabled && mayStart(role, "agents.connector.sync") && <Button risk={riskOf("agents.connector.sync")} onClick={() => sync("notion")}>Sync Notion</Button>}
              </div>
            </div>
            <div className="agents-connector">
              <Switch label="Slack (read only)" description="The last week of the channels you name; who wrote each message is left out." checked={connectors.slackEnabled} onChange={(checked) => setConnectors({ ...connectors, slackEnabled: checked })} />
              <div className="agents-form__row">
                <Field label="Credential's name"><TextInput mono value={connectors.slackCredential} placeholder="slack-token" onValueChange={(value) => setConnectors({ ...connectors, slackCredential: value })} /></Field>
                <Field label="Channel ids"><TextInput mono value={connectors.slackChannels} placeholder="C0123456789" onValueChange={(value) => setConnectors({ ...connectors, slackChannels: value })} /></Field>
                {state.connectors?.slack.enabled && mayStart(role, "agents.connector.sync") && <Button risk={riskOf("agents.connector.sync")} onClick={() => sync("slack")}>Sync Slack</Button>}
              </div>
            </div>
          </fieldset>
        </Panel>
      )}

      <Panel className="agents-learning" title="Learning" count={state.learning.agents.length}
        actions={state.learning.agents.length ? <Button onClick={() => void act(() => agentsApi.relearn(csrfToken, null), `Learning is queued for the next quiet hours (${state.learning.quietHours.start}).`, "Learning could not be queued")}>Learn again in quiet hours</Button> : undefined}>
        <Table caption="When each agent last learned" rows={state.learning.agents} rowKey={(entry) => entry.agentId}
          columns={[
            { id: "agent", header: "Agent", cell: (entry) => entry.name },
            { id: "state", header: "Last pass", cell: (entry) => (entry.state ? <StatusChip status={runState(entry.state).status}>{runState(entry.state).label}</StatusChip> : <span className="agents-dim">never</span>) },
            { id: "when", header: "When", cell: (entry) => <span className="agents-dim">{relativeTime(entry.at, now) ?? "—"}</span> },
          ]} />
      </Panel>

      {pendingSources && (
        <PasswordSheet title="Change what agents read" confirmLabel="Change it" onClose={() => setPendingSources(null)}
          onConfirm={async (password) => { await agentsApi.saveSettings(csrfToken, { password, knowledge: pendingSources }); setNotice("Changed what agents read. The next run reads the new sources."); await read(); }}>
          <p>{Object.entries(pendingSources).map(([id, on]) => `${state.sources.find((source) => source.id === id)?.title ?? id}: ${on ? "on" : "off"}`).join(", ")}. This decides what the model is shown, so it takes your password.</p>
        </PasswordSheet>
      )}
      {saveConnectors && connectors && (
        <PasswordSheet title="Save outside data" confirmLabel="Save" onClose={() => setSaveConnectors(false)}
          onConfirm={async (password) => {
            await agentsApi.saveSettings(csrfToken, {
              password,
              folder: { enabled: connectors.folderEnabled, path: connectors.folderPath.trim() || null },
              webSearch: { enabled: connectors.webEnabled, endpoint: connectors.webEndpoint.trim() || null },
              connectors: {
                notion: { enabled: connectors.notionEnabled, credential: connectors.notionCredential.trim() || null },
                slack: { enabled: connectors.slackEnabled, credential: connectors.slackCredential.trim() || null, channels: connectors.slackChannels.split(/[\s,]+/).filter(Boolean) },
              },
            });
            setNotice("Saved. What comes in from outside is data for the agents, never instructions.");
            await read();
          }}>
          <p>What agents may bring in from outside this server. It takes your password.</p>
          {connectors.webEnabled && <p>With web search on, the agents' queries go to the search engines your SearXNG asks. Nothing about this server should be in them, and the agents are told so.</p>}
        </PasswordSheet>
      )}
      {adding && (
        <Sheet kicker="Learning library" title="Paste a document" onClose={() => setAdding(false)}
          footer={<><Button variant="ghost" onClick={() => setAdding(false)}>Cancel</Button><Button variant="primary" disabled={!title.trim() || !text.trim()} onClick={() => void act(async () => { await agentsApi.addDocument(csrfToken, title.trim(), text); setAdding(false); setTitle(""); setText(""); }, "The document was added. Agents that read your documents see it from their next run.", "The document could not be added")}>Add it</Button></>}>
          <div className="agents-password">
            <Field label="Title"><TextInput value={title} maxLength={120} onValueChange={setTitle} /></Field>
            <Field label="Text" hint="Up to 64,000 characters. Anything that looks like a secret is masked."><Textarea rows={12} value={text} maxLength={64_000} onValueChange={setText} /></Field>
          </div>
        </Sheet>
      )}
    </div>
  );
}
