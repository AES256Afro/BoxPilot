import { useCallback, useEffect, useRef, useState } from "react";
import { relativeTime } from "../../home/format";
import { Button, EmptyState, Field, KeyValue, Notice, Panel, Select, Sheet, StatusChip, Table, Tag, TextInput, Textarea, type TableColumn } from "../../ui";
import { agentsApi, type AgentSummary, type Memory as MemoryState, type MemoryNote } from "./api";
import { errorText } from "./format";

/*
 * What an agent remembers (M37), by tier: the facts it learned (pinned first), what other agents
 * share with it, what its past runs found, and the conversation with the person looking. The owner
 * (or whoever made the agent) edits a fact - its words, how long it stays fresh, pinned, shared - and
 * makes it forget a fact, a run or the conversation. Forgetting deletes it and its embedding.
 */

export interface MemoryProps {
  agents: AgentSummary[];
  agentId: string | null;
  csrfToken: string;
  role: string;
  now: number;
  onSelectAgent: (agentId: string) => void;
}

export function Memory({ agents, agentId, csrfToken, role, now, onSelectAgent }: MemoryProps) {
  const usable = agents.filter((agent) => agent.canEdit);
  const agent = usable.find((entry) => entry.id === agentId) ?? usable[0] ?? null;
  const [state, setState] = useState<MemoryState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [editing, setEditing] = useState<MemoryNote | null>(null);
  const [draft, setDraft] = useState({ title: "", body: "", freshDays: "" });
  const currentId = agent?.id ?? null;

  // The agent on show: what arrives for the one chosen before is not drawn under this one's name.
  const shown = useRef(currentId);
  const read = useCallback(async (id: string) => {
    try {
      const next = await agentsApi.memory(id);
      if (shown.current === id) { setState(next); setError(null); }
    } catch (requestError) { if (shown.current === id) setError(errorText(requestError, "What it remembers could not be read")); }
  }, []);
  useEffect(() => { shown.current = currentId; setState(null); if (currentId) void read(currentId); }, [currentId, read]);

  if (!agent) return <Panel title="Memory" padded><EmptyState title="No agent to look at">Memory is for the agents you may change.</EmptyState></Panel>;
  if (!state) {
    return error
      ? <Notice tone="danger" live title="What it remembers could not be read" action={<Button onClick={() => void read(agent.id)}>Try again</Button>}>{error}</Notice>
      : <Panel title="Facts it learned" padded><p className="agents-quiet">Reading…</p></Panel>;
  }

  const act = async (work: () => Promise<unknown>, done: string) => {
    try { await work(); setNotice(done); setError(null); await read(agent.id); } catch (requestError) { setError(errorText(requestError, "That did not work")); }
  };
  const openEdit = (note: MemoryNote) => { setEditing(note); setDraft({ title: note.title, body: note.body, freshDays: "" }); };

  const factColumns: Array<TableColumn<MemoryNote>> = [
    {
      id: "fact", header: "Fact", cell: (note) => (
        <span className="agents-note">
          <span className="agents-note__title">{note.title}{note.pinned && <Tag tone="accent">pinned</Tag>}{note.shared && <Tag tone="info">shared</Tag>}</span>
          <span className="agents-note__body">{note.body}</span>
          <span className="agents-name__purpose">{note.source?.tools?.length ? `from ${note.source.tools.join(", ")}` : note.source?.by === "agent" ? "written by the agent" : ""}{note.source?.injection ? " · after suspicious tool output" : ""}{note.indexed ? " · indexed" : ""}</span>
        </span>
      ),
    },
    { id: "fresh", header: "Fresh", cell: (note) => <StatusChip status={note.stale ? "warning" : "good"}>{note.freshUntil ? (note.stale ? "stale" : "fresh") : "always"}</StatusChip> },
    { id: "updated", header: "Written", hideOnPhone: true, cell: (note) => <span className="agents-dim">{relativeTime(note.updatedAt, now) ?? ""}</span> },
    {
      id: "actions", header: <span className="ui-visually-hidden">Actions</span>, label: "Actions", className: "agents-actions-cell", cell: (note) => (
        <span className="agents-actions">
          <Button variant="ghost" onClick={() => openEdit(note)} aria-label={`Edit the fact ${note.title}`}>Edit</Button>
          <Button variant="ghost" onClick={() => void act(() => agentsApi.editMemory(csrfToken, agent.id, note.id, { pinned: !note.pinned }), note.pinned ? `“${note.title}” is no longer pinned.` : `“${note.title}” is pinned: recalled first, never dropped.`)} aria-label={`${note.pinned ? "Unpin" : "Pin"} ${note.title}`}>{note.pinned ? "Unpin" : "Pin"}</Button>
          <Button variant="ghost" onClick={() => void act(() => agentsApi.forget(csrfToken, agent.id, "notes", note.id), `Forgot “${note.title}”.`)} aria-label={`Forget the fact ${note.title}`}>Forget</Button>
        </span>
      ),
    },
  ];
  const episodeColumns: Array<TableColumn<MemoryState["episodes"][number]>> = [
    { id: "text", header: "What the run found", cell: (episode) => <span className="agents-note"><span className="agents-note__body">{episode.text}</span></span> },
    { id: "when", header: "When", hideOnPhone: true, cell: (episode) => <span className="agents-dim">{relativeTime(episode.createdAt, now) ?? ""}</span> },
    { id: "forget", header: <span className="ui-visually-hidden">Forget</span>, label: "Actions", className: "agents-actions-cell", cell: (episode) => <Button variant="ghost" onClick={() => void act(() => agentsApi.forget(csrfToken, agent.id, "episodes", episode.id), "Forgot that run.")} aria-label="Forget this run">Forget</Button> },
  ];

  return (
    <div className="agents-tab agents-memory">
      {error && <Notice tone="danger" live onDismiss={() => setError(null)}>{error}</Notice>}
      {notice && <Notice tone="success" live onDismiss={() => setNotice(null)}>{notice}</Notice>}

      <Panel className="agents-memory-search" title="How it recalls" padded
        actions={<Select aria-label="Whose memory" value={agent.id} onValueChange={onSelectAgent} options={usable.map((entry) => ({ value: entry.id, label: entry.name }))} />}>
        {!state.settings.enabled && <Notice tone="info">{agent.name} keeps no notes; it still remembers its runs and the conversation with each person when those are on.</Notice>}
        <KeyValue layout="columns" items={[
          { id: "how", label: "Search", value: state.search.byMeaning ? "by meaning and by words" : "by words", status: state.search.byMeaning ? "good" : "neutral" },
          { id: "model", label: "Embeddings from", value: state.search.model, mono: true },
          { id: "indexed", label: "Indexed", value: String(state.search.vectors), mono: true },
          { id: "pending", label: "Waiting for quiet hours", value: String(state.search.pending), mono: true, status: state.search.pending ? "neutral" : "good" },
          { id: "shared", label: "Its facts shared", value: state.settings.share ? "yes" : "no", mono: true },
          { id: "threads", label: "Conversations", value: state.settings.threads ? `${state.settings.turns} turns, then a summary` : "not kept", mono: true },
        ]} />
        {role === "owner" && state.search.byMeaning && state.search.pending > 0 && <Button onClick={() => void act(() => agentsApi.reindex(csrfToken), "Indexing is queued; it runs when the runner is free.")}>Index now</Button>}
      </Panel>

      <Panel className="agents-facts" title="Facts it learned" count={state.facts.length} meta={`at most ${state.settings.maxNotes}; pinned ones are never dropped`}>
        <Table caption={`Facts ${agent.name} learned`} columns={factColumns} rows={state.facts} rowKey={(note) => note.id}
          rowStatus={(note) => (note.source?.injection ? "warning" : undefined)}
          empty={<EmptyState title="No facts yet">It writes them as it learns: in quiet hours, or when you ask it to.</EmptyState>} />
      </Panel>

      {state.shared.length > 0 && (
        <Panel className="agents-shared" title="Shared by other agents" count={state.shared.length} meta="as far as its runs may read">
          <Table caption="Facts other agents share" rows={state.shared} rowKey={(note) => note.id}
            columns={[
              { id: "fact", header: "Fact", cell: (note) => <span className="agents-note"><span className="agents-note__title">{note.title}</span><span className="agents-note__body">{note.body}</span></span> },
              { id: "from", header: "From", cell: (note) => note.from },
              { id: "fresh", header: "Fresh", cell: (note) => <StatusChip status={note.stale ? "warning" : "good"}>{note.stale ? "stale" : "fresh"}</StatusChip> },
            ]} />
        </Panel>
      )}

      <Panel className="agents-episodes" title="What past runs found" count={state.episodes.length}>
        <Table caption={`Past runs ${agent.name} remembers`} columns={episodeColumns} rows={state.episodes} rowKey={(episode) => episode.id}
          empty={<EmptyState title="Nothing yet">Each answered run leaves a line here for later runs to recall.</EmptyState>} />
      </Panel>

      <Panel className="agents-thread" title="Your conversation with it" padded
        actions={state.thread ? <Button variant="ghost" onClick={() => void act(() => agentsApi.forgetThread(csrfToken, agent.id), "It forgot your conversation.")}>Forget it</Button> : undefined}>
        {!state.thread ? <p className="agents-quiet">None yet. Ask it something in the console.</p> : (
          <>
            {state.thread.summary && <p className="agents-dim"><b>Earlier, in short:</b> {state.thread.summary}</p>}
            <ol className="agents-turns">
              {state.thread.turns.map((turn, index) => <li key={index} className="agents-turn" data-role={turn.role}><span className="agents-turn__who">{turn.role === "user" ? "You" : agent.name}</span><span className="agents-turn__text">{turn.text}</span></li>)}
            </ol>
          </>
        )}
      </Panel>

      {editing && (
        <Sheet kicker={agent.name} title="Edit a fact" onClose={() => setEditing(null)}
          footer={<><Button variant="ghost" onClick={() => setEditing(null)}>Cancel</Button><Button variant="primary" onClick={() => void act(async () => {
            await agentsApi.editMemory(csrfToken, agent.id, editing.id, { title: draft.title, body: draft.body, ...(draft.freshDays === "always" ? { freshDays: null } : draft.freshDays ? { freshDays: Number(draft.freshDays) } : {}) });
            setEditing(null);
          }, "The fact is changed; its embedding is made again in quiet hours.")}>Save</Button></>}>
          <div className="agents-password">
            <Field label="Title"><TextInput value={draft.title} maxLength={120} onValueChange={(value) => setDraft({ ...draft, title: value })} /></Field>
            <Field label="What it remembers"><Textarea rows={6} value={draft.body} maxLength={2000} onValueChange={(value) => setDraft({ ...draft, body: value })} /></Field>
            <Field label="Stays fresh" hint="Leave as it is, or set again">
              <Select value={draft.freshDays} onValueChange={(value) => setDraft({ ...draft, freshDays: value })}
                options={[{ value: "", label: "As it is" }, { value: "7", label: "A week from now" }, { value: "30", label: "A month from now" }, { value: "365", label: "A year from now" }, { value: "always", label: "Always" }]} />
            </Field>
          </div>
        </Sheet>
      )}
    </div>
  );
}
