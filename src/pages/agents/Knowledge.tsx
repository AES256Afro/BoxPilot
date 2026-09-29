import { useCallback, useEffect, useState } from "react";
import { relativeTime } from "../../home/format";
import { Button, EmptyState, Field, KeyValue, Notice, Panel, Select, Sheet, StatusChip, Switch, Table, TextInput, Textarea, type TableColumn } from "../../ui";
import { agentsApi, type AgentSummary, type Knowledge as KnowledgeState, type KnowledgeSource, type Note, type OwnerDocument } from "./api";
import { errorText, runState } from "./format";
import { PasswordSheet } from "./PasswordSheet";

/*
 * The learning library (M37): what agents read and what they have learned. The sources, each on or
 * off (the owner's call, with the password, as it decides what the model sees); the owner's own
 * documents; how searching works; when each agent last learned, with a way to learn again in quiet
 * hours; and each agent's notes, with where they came from, whether they are still fresh, and a way
 * to delete one that is wrong.
 */

export interface KnowledgeProps {
  agents: AgentSummary[];
  agentId: string | null;
  csrfToken: string;
  now: number;
  onSelectAgent: (agentId: string) => void;
}

export function Knowledge({ agents, agentId, csrfToken, now, onSelectAgent }: KnowledgeProps) {
  const [state, setState] = useState<KnowledgeState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pendingSources, setPendingSources] = useState<Partial<Record<KnowledgeSource["id"], boolean>> | null>(null);
  const [adding, setAdding] = useState(false);
  const [title, setTitle] = useState("");
  const [text, setText] = useState("");
  const [notes, setNotes] = useState<Note[] | null>(null);
  const noted = agents.filter((agent) => agent.canEdit);
  const noteAgent = noted.find((agent) => agent.id === agentId) ?? noted[0] ?? null;

  const read = useCallback(async () => {
    try { setState(await agentsApi.knowledge()); setError(null); } catch (requestError) { setError(errorText(requestError, "The library could not be read")); }
  }, []);
  useEffect(() => { void read(); }, [read]);
  const noteAgentId = noteAgent?.id ?? null;
  const readNotes = useCallback(async (id: string) => {
    try { setNotes((await agentsApi.notes(id)).notes); } catch { setNotes(null); }
  }, []);
  useEffect(() => { if (noteAgentId) void readNotes(noteAgentId); }, [noteAgentId, readNotes]);

  const act = async (work: () => Promise<unknown>, done: string, failed: string) => {
    try { await work(); setNotice(done); setError(null); await read(); } catch (requestError) { setError(errorText(requestError, failed)); }
  };

  if (!state) {
    return error
      ? <Notice tone="danger" live title="The learning library could not be read" action={<Button onClick={() => void read()}>Try again</Button>}>{error}</Notice>
      : <Panel title="Sources" padded><p className="agents-quiet">Reading…</p></Panel>;
  }

  const sourceColumns: Array<TableColumn<KnowledgeSource>> = [
    { id: "source", header: "Source", cell: (source) => <span className="agents-name"><span>{source.title}</span><span className="agents-name__purpose">{source.items === null ? "not read" : `${source.items} ${source.unit === "characters" ? "items" : source.unit}`}{source.unit === "characters" && source.size ? ` · ${source.size.toLocaleString()} characters` : ""}</span></span> },
    { id: "indexed", header: "Up to date", hideOnPhone: true, cell: (source) => <span className="agents-dim">{relativeTime(source.indexedAt, now) ?? "—"}</span> },
    {
      id: "on", header: "Read by agents", className: "agents-actions-cell", cell: (source) => (state.canChange
        ? <Switch label={<span className="ui-visually-hidden">{source.title}</span>} checked={source.enabled} onChange={(checked) => setPendingSources({ [source.id]: checked })} />
        : <StatusChip status={source.enabled ? "good" : "neutral"}>{source.enabled ? "on" : "off"}</StatusChip>),
    },
  ];
  const documentColumns: Array<TableColumn<OwnerDocument>> = [
    { id: "title", header: "Document", cell: (document) => <span className="agents-name"><span>{document.title}</span><span className="agents-name__purpose">{document.characters.toLocaleString()} characters · added {relativeTime(document.createdAt, now) ?? ""}</span></span> },
    {
      id: "actions", header: <span className="ui-visually-hidden">Actions</span>, label: "Actions", className: "agents-actions-cell", cell: (document) => (state.canChange ? (
        <span className="agents-actions">
          <Switch label={<span className="ui-visually-hidden">Read {document.title}</span>} checked={document.enabled} onChange={(checked) => void act(() => agentsApi.toggleDocument(csrfToken, document.id, checked), checked ? `${document.title} is read again.` : `${document.title} is left out.`, "The document could not be changed")} />
          <Button variant="ghost" onClick={() => void act(() => agentsApi.removeDocument(csrfToken, document.id), `${document.title} was removed.`, "The document could not be removed")} aria-label={`Remove ${document.title}`}>Remove</Button>
        </span>
      ) : null),
    },
  ];
  const noteColumns: Array<TableColumn<Note>> = [
    {
      id: "note", header: "Note", cell: (note) => (
        <span className="agents-note">
          <span className="agents-note__title">{note.title}</span>
          <span className="agents-note__body">{note.body}</span>
          <span className="agents-name__purpose">{note.source?.tools?.length ? `from ${note.source.tools.join(", ")}` : note.source?.by === "agent" ? "written by the agent" : ""}{note.source?.injection ? " · after suspicious tool output" : ""}</span>
        </span>
      ),
    },
    { id: "fresh", header: "Fresh", cell: (note) => <StatusChip status={note.stale ? "warning" : "good"}>{note.stale ? "stale" : "fresh"}</StatusChip> },
    { id: "updated", header: "Written", hideOnPhone: true, cell: (note) => <span className="agents-dim">{relativeTime(note.updatedAt, now) ?? ""}</span> },
    {
      id: "delete", header: <span className="ui-visually-hidden">Delete</span>, label: "Delete", className: "agents-actions-cell", cell: (note) => (
        <Button variant="ghost" aria-label={`Delete the note ${note.title}`} onClick={() => void (async () => {
          if (!noteAgent) return;
          try { await agentsApi.deleteNote(csrfToken, noteAgent.id, note.id); await readNotes(noteAgent.id); setNotice(`Deleted the note “${note.title}”.`); } catch (requestError) { setError(errorText(requestError, "The note could not be deleted")); }
        })()}>Delete</Button>
      ),
    },
  ];
  const enabledSources = state.sources.filter((source) => source.enabled).length;
  const learnable = state.learning.agents;

  return (
    <div className="agents-tab agents-knowledge">
      {error && <Notice tone="danger" live onDismiss={() => setError(null)}>{error}</Notice>}
      {notice && <Notice tone="success" live onDismiss={() => setNotice(null)}>{notice}</Notice>}

      <Panel className="agents-sources" title="Sources" count={`${enabledSources} of ${state.sources.length}`} meta={state.canChange ? "the owner turns each on or off" : undefined}>
        <Table caption="What agents may read" columns={sourceColumns} rows={state.sources} rowKey={(source) => source.id} />
      </Panel>

      <Panel className="agents-search" title="How agents search" padded>
        <KeyValue layout="rows" items={[
          { id: "kind", label: "Search", value: state.search.kind, mono: true },
          { id: "meaning", label: "Meaning search", value: state.search.embeddings },
          { id: "quiet", label: "Learning runs in", value: `quiet hours, ${state.learning.quietHours.start}–${state.learning.quietHours.end}`, mono: true },
        ]} />
      </Panel>

      <Panel className="agents-documents" title="Your documents" count={state.documents.length}
        actions={state.canChange ? <Button onClick={() => setAdding(true)}>Add a document</Button> : undefined}>
        <Table caption="Documents you gave the agents" columns={documentColumns} rows={state.documents} rowKey={(document) => document.id}
          empty={<EmptyState title="No documents">{state.canChange ? "Add notes of your own: how this network is laid out, who uses what, what to leave alone. Secrets in them are masked before an agent sees them." : "The owner adds these."}</EmptyState>} />
      </Panel>

      <Panel className="agents-learning" title="Learning" count={learnable.length}
        actions={noted.length ? <Button onClick={() => void act(() => agentsApi.relearn(csrfToken, null), `Learning is queued for the next quiet hours (${state.learning.quietHours.start}).`, "Learning could not be queued")}>Learn again in quiet hours</Button> : undefined}>
        <Table caption="When each agent last learned" rows={learnable} rowKey={(entry) => entry.agentId}
          columns={[
            { id: "agent", header: "Agent", cell: (entry) => entry.name },
            { id: "state", header: "Last pass", cell: (entry) => (entry.state ? <StatusChip status={runState(entry.state).status}>{runState(entry.state).label}</StatusChip> : <span className="agents-dim">never</span>) },
            { id: "when", header: "When", cell: (entry) => <span className="agents-dim">{relativeTime(entry.at, now) ?? "—"}</span> },
          ]} />
      </Panel>

      {noteAgent && (
        <Panel className="agents-notes" title="What it learned" count={notes?.length}
          actions={<Select aria-label="Whose notes" value={noteAgent.id} onValueChange={onSelectAgent} options={noted.map((agent) => ({ value: agent.id, label: agent.name }))} />}>
          <Table caption={`Notes of ${noteAgent.name}`} columns={noteColumns} rows={notes ?? []} rowKey={(note) => note.id}
            rowStatus={(note) => (note.source?.injection ? "warning" : undefined)}
            empty={notes === null ? "The notes could not be read." : <EmptyState title="No notes yet">It writes them as it learns: in quiet hours, or when you ask it to.</EmptyState>} />
        </Panel>
      )}

      {pendingSources && (
        <PasswordSheet title="Change what agents read" confirmLabel="Change it" onClose={() => setPendingSources(null)}
          onConfirm={async (password) => { await agentsApi.saveSettings(csrfToken, { password, knowledge: pendingSources }); setNotice("Changed what agents read. The next run reads the new sources."); await read(); }}>
          <p>{Object.entries(pendingSources).map(([id, on]) => `${state.sources.find((source) => source.id === id)?.title ?? id}: ${on ? "on" : "off"}`).join(", ")}. This decides what the model is shown, so it takes your password.</p>
        </PasswordSheet>
      )}

      {adding && (
        <Sheet kicker="Learning library" title="Add a document" onClose={() => setAdding(false)}
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
