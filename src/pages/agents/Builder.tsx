import { useCallback, useEffect, useMemo, useState } from "react";
import { relativeTime } from "../../home/format";
import { Button, Checkbox, CodeBlock, Field, Notice, Panel, Segmented, Select, Sheet, StatusChip, Switch, Table, Tag, TextInput, Textarea, type TableColumn } from "../../ui";
import { agentsApi, type AgentDetail, type AgentSpec, type AgentVersion, type Catalog, type Schedule, type SpecChange, type ToolInfo, type ToolPermission, type VersionDetail } from "./api";
import { errorText, scheduleWords, triggerWords } from "./format";

/*
 * The Agent Builder (M37). Without an agent chosen: the templates, each made into an agent with one
 * click. With one: everything an agent is, on one form - who it is and what it is told, who may ask
 * it, what it reads, each tool's permission (on, only when a person asked, off), when it runs, its
 * budget under ceilings no spec can lift, what it writes and what it remembers. Saving makes a new
 * version; every version can be compared field by field, the instructions line by line, and rolled
 * back to (which is a new version too). What the model is told, BoxPilot's rules included, is one
 * click away.
 */

export interface BuilderProps {
  agentId: string | null;
  catalog: Catalog | null;
  canCreate: boolean;
  csrfToken: string;
  now: number;
  onCreated: (agentId: string) => void;
  onChanged: () => void;
  onDeleted: () => void;
  onTest: (agentId: string) => void;
}

const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const knowledgeWords: Record<keyof AgentSpec["knowledge"], string> = { docs: "BoxPilot's documents", registry: "Registered operations", catalog: "The app catalog", notes: "Its own notes", documents: "Your documents" };
const outputWords = { notes: "Notes about the server", digest: "A daily digest on Home and Ops", proposals: "Cards with a plan to approve" } as const;
const budgetWords: Record<keyof AgentSpec["budget"], { label: string; unit: string }> = {
  runsPerDay: { label: "Runs a day", unit: "runs" },
  modelSecondsPerDay: { label: "Model time a day", unit: "seconds" },
  stepsPerRun: { label: "Steps a run", unit: "steps" },
  tokensPerRun: { label: "Tokens a run", unit: "tokens" },
  runSeconds: { label: "Longest run", unit: "seconds" },
};
const weekdays = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const permissionOptions = [{ value: "auto" as const, label: "On" }, { value: "ask" as const, label: "Asked" }, { value: "off" as const, label: "Off" }];

// ---- the templates ----

function TemplatePicker({ catalog, canCreate, csrfToken, onCreated }: Pick<BuilderProps, "catalog" | "canCreate" | "csrfToken" | "onCreated">) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const create = async (template: string) => {
    setBusy(template);
    try {
      const agent = await agentsApi.create(csrfToken, { template });
      setError(null);
      onCreated(agent.id);
    } catch (requestError) {
      setError(errorText(requestError, "The agent could not be made"));
    } finally {
      setBusy(null);
    }
  };
  if (!catalog) return <Panel title="Templates" padded><p className="agents-quiet">Reading the templates…</p></Panel>;
  return (
    <Panel className="agents-templates" title="Start from a template" count={catalog.templates.length} meta="each becomes an agent you can change" padded>
      {error && <Notice tone="danger" live>{error}</Notice>}
      <div className="agents-templates__grid">
        {catalog.templates.map((template) => {
          const tools = Object.values(template.spec.tools).filter((permission) => permission !== "off").length;
          return (
            <article key={template.id} className="agents-template" aria-label={template.title}>
              <h3 className="agents-template__title">{template.title}</h3>
              <p className="agents-template__summary">{template.summary}</p>
              <p className="agents-template__facts">
                {tools} {tools === 1 ? "tool" : "tools"} · {triggerWords({ triggers: template.spec.triggers })} · asked by {template.spec.audience.join(", ")}
              </p>
              {canCreate && <Button variant={template.id === "server-keeper" ? "primary" : "secondary"} busy={busy === template.id} onClick={() => void create(template.id)}>{template.id === "blank" ? "Start blank" : `Make a ${template.title}`}</Button>}
            </article>
          );
        })}
      </div>
    </Panel>
  );
}

// ---- the form ----

interface FormProps {
  draft: AgentSpec;
  setDraft: (update: (draft: AgentSpec) => AgentSpec) => void;
  catalog: Catalog;
  disabled: boolean;
}

function numberOf(text: string, fallback: number): number {
  const value = Number.parseInt(text, 10);
  return Number.isFinite(value) ? value : fallback;
}

function ToolTable({ draft, setDraft, catalog, disabled }: FormProps) {
  const columns: Array<TableColumn<ToolInfo>> = [
    {
      id: "tool", header: "Tool", cell: (tool) => (
        <span className="agents-tool">
          <span className="agents-tool__name"><span className="agents-tool__title">{tool.title}</span><code>{tool.id}</code></span>
          <span className="agents-tool__description">{tool.description}</span>
        </span>
      ),
    },
    {
      id: "facts", header: "Reads as", hideOnPhone: true, cell: (tool) => (
        <span className="agents-tool__tags">
          {tool.role === "operator" ? <Tag tone="warning" title="An operator read: only for runs of the owner or an operator">operator</Tag> : <Tag>anyone</Tag>}
          <Tag tone={tool.cost === "heavy" ? "warning" : "neutral"}>{tool.cost}</Tag>
          {tool.writes && <Tag tone="info" title={`Writes ${tool.writes}; never anything on the server`}>writes {tool.writes}</Tag>}
        </span>
      ),
    },
    {
      id: "permission", header: "Permission", className: "agents-tool__permission", cell: (tool) => (
        <Segmented<ToolPermission>
          label={`${tool.title}: permission`}
          value={draft.tools[tool.id] ?? "off"}
          onChange={(value) => { if (!disabled) setDraft((current) => ({ ...current, tools: { ...current.tools, [tool.id]: value } })); }}
          options={permissionOptions.map((option) => ({ ...option, disabled }))}
        />
      ),
    },
  ];
  return <Table caption="Tools and their permissions" columns={columns} rows={catalog.tools} rowKey={(tool) => tool.id} />;
}

function ScheduleFields({ draft, setDraft, disabled }: Omit<FormProps, "catalog">) {
  const schedule = draft.triggers.schedule;
  const set = (next: Schedule | null) => setDraft((current) => ({ ...current, triggers: { ...current.triggers, schedule: next } }));
  const every = schedule?.every ?? "none";
  return (
    <div className="agents-form__row">
      <Field label="Schedule">
        <Select value={every} disabled={disabled} onValueChange={(value) => set(value === "none" ? null : { every: value as Schedule["every"], minute: schedule?.minute ?? 30, hour: value === "daily" || value === "weekly" ? schedule?.hour ?? 5 : null, weekday: value === "weekly" ? schedule?.weekday ?? 1 : null, quietHours: schedule?.quietHours ?? true })}
          options={[{ value: "none", label: "No schedule" }, { value: "hourly", label: "Every hour" }, { value: "every-6-hours", label: "Every 6 hours" }, { value: "daily", label: "Every day" }, { value: "weekly", label: "Every week" }]} />
      </Field>
      {schedule && (schedule.every === "weekly") && (
        <Field label="Day">
          <Select value={String(schedule.weekday ?? 1)} disabled={disabled} onValueChange={(value) => set({ ...schedule, weekday: Number(value) })} options={weekdays.map((day, index) => ({ value: String(index), label: day }))} />
        </Field>
      )}
      {schedule && (schedule.every === "daily" || schedule.every === "weekly") && (
        <Field label="Hour">
          <Select mono value={String(schedule.hour ?? 5)} disabled={disabled} onValueChange={(value) => set({ ...schedule, hour: Number(value) })} options={Array.from({ length: 24 }, (_, hour) => ({ value: String(hour), label: String(hour).padStart(2, "0") }))} />
        </Field>
      )}
      {schedule && (
        <Field label="Minute">
          <TextInput mono type="number" min={0} max={59} value={String(schedule.minute)} disabled={disabled} onValueChange={(value) => set({ ...schedule, minute: Math.min(59, Math.max(0, numberOf(value, schedule.minute))) })} />
        </Field>
      )}
      {schedule && (
        <Checkbox className="agents-form__check" label="Wait for quiet hours" description="Heavy work waits until the night; a person's question never does." checked={schedule.quietHours} disabled={disabled}
          onChange={(checked) => set({ ...schedule, quietHours: checked })} />
      )}
    </div>
  );
}

function SpecForm({ draft, setDraft, catalog, disabled }: FormProps) {
  const events = catalog.events;
  const limits = catalog.limits.budget;
  return (
    <fieldset className="agents-form" disabled={disabled}>
      <section className="agents-form__section" aria-labelledby="agents-form-who">
        <h3 id="agents-form-who" className="agents-form__heading">Who it is</h3>
        <div className="agents-form__row">
          <Field label="Name"><TextInput value={draft.name} maxLength={60} onValueChange={(value) => setDraft((current) => ({ ...current, name: value }))} /></Field>
        </div>
        <Field label="Purpose" hint="One sentence: what it is for. People who may ask it see this.">
          <TextInput value={draft.purpose} maxLength={300} onValueChange={(value) => setDraft((current) => ({ ...current, purpose: value }))} />
        </Field>
        <Field label="Instructions" hint="What it is told, below BoxPilot's own rules, which it cannot change: read before answering, cite tool output, propose and never act.">
          <Textarea rows={8} value={draft.instructions} maxLength={8000} onValueChange={(value) => setDraft((current) => ({ ...current, instructions: value }))} />
        </Field>
      </section>

      <section className="agents-form__section" aria-labelledby="agents-form-ask">
        <h3 id="agents-form-ask" className="agents-form__heading">Who may ask it</h3>
        <div className="agents-form__checks">
          {(["owner", "operator", "viewer"] as const).map((role) => (
            <Checkbox key={role} label={role === "owner" ? "The owner" : role === "operator" ? "Operators" : "Viewers"} description={role === "viewer" ? "Their runs read only what a viewer may: never logs or Pi-hole." : undefined}
              checked={draft.audience.includes(role)} onChange={(checked) => setDraft((current) => ({ ...current, audience: checked ? [...new Set([...current.audience, role])] : current.audience.filter((entry) => entry !== role) }))} />
          ))}
        </div>
      </section>

      <section className="agents-form__section" aria-labelledby="agents-form-reads">
        <h3 id="agents-form-reads" className="agents-form__heading">What it reads</h3>
        <div className="agents-form__checks">
          {(Object.keys(knowledgeWords) as Array<keyof AgentSpec["knowledge"]>).map((source) => (
            <Checkbox key={source} label={knowledgeWords[source]} checked={draft.knowledge[source]} onChange={(checked) => setDraft((current) => ({ ...current, knowledge: { ...current.knowledge, [source]: checked } }))} />
          ))}
        </div>
      </section>

      <section className="agents-form__section agents-form__section--flush" aria-labelledby="agents-form-tools">
        <h3 id="agents-form-tools" className="agents-form__heading">Tools</h3>
        <p className="agents-form__note">Every tool reads; none changes the server. "Asked" means only when a person asked, never on a schedule or an event. Tool output reaches the model as data, redacted, never as instructions.</p>
        <ToolTable draft={draft} setDraft={setDraft} catalog={catalog} disabled={disabled} />
      </section>

      <section className="agents-form__section" aria-labelledby="agents-form-when">
        <h3 id="agents-form-when" className="agents-form__heading">When it runs</h3>
        <Switch label="When someone asks" checked={draft.triggers.ask} disabled={disabled} onChange={(checked) => setDraft((current) => ({ ...current, triggers: { ...current.triggers, ask: checked } }))} />
        <ScheduleFields draft={draft} setDraft={setDraft} disabled={disabled} />
        <div className="agents-form__checks">
          {events.map((event) => (
            <Checkbox key={event.id} label={event.title} description="At most once every half hour." checked={draft.triggers.events.includes(event.id)}
              onChange={(checked) => setDraft((current) => ({ ...current, triggers: { ...current.triggers, events: checked ? [...new Set([...current.triggers.events, event.id])] : current.triggers.events.filter((entry) => entry !== event.id) } }))} />
          ))}
        </div>
      </section>

      <section className="agents-form__section" aria-labelledby="agents-form-budget">
        <h3 id="agents-form-budget" className="agents-form__heading">Budget</h3>
        <div className="agents-form__grid">
          {(Object.keys(budgetWords) as Array<keyof AgentSpec["budget"]>).map((key) => (
            <Field key={key} label={budgetWords[key].label} hint={`${limits[key].min}–${limits[key].max} ${budgetWords[key].unit}`}>
              <TextInput mono type="number" min={limits[key].min} max={limits[key].max} value={String(draft.budget[key])}
                onValueChange={(value) => setDraft((current) => ({ ...current, budget: { ...current.budget, [key]: numberOf(value, current.budget[key]) } }))} />
            </Field>
          ))}
        </div>
      </section>

      <section className="agents-form__section" aria-labelledby="agents-form-writes">
        <h3 id="agents-form-writes" className="agents-form__heading">What it writes</h3>
        <div className="agents-form__checks">
          {(Object.keys(outputWords) as Array<keyof typeof outputWords>).map((key) => (
            <Checkbox key={key} label={outputWords[key]} checked={draft.outputs[key]} onChange={(checked) => setDraft((current) => ({ ...current, outputs: { ...current.outputs, [key]: checked } }))} />
          ))}
        </div>
        <div className="agents-form__row">
          <Field label="Tell the owner">
            <Select value={draft.outputs.notify} disabled={disabled} onValueChange={(value) => setDraft((current) => ({ ...current, outputs: { ...current.outputs, notify: value as "important" | "never" } }))}
              options={[{ value: "important", label: "Only what is important" }, { value: "never", label: "Never" }]} />
          </Field>
        </div>
      </section>

      <section className="agents-form__section" aria-labelledby="agents-form-memory">
        <h3 id="agents-form-memory" className="agents-form__heading">Memory</h3>
        <Switch label="Keeps notes between runs" checked={draft.memory.enabled} disabled={disabled} onChange={(checked) => setDraft((current) => ({ ...current, memory: { ...current.memory, enabled: checked } }))} />
        {draft.memory.enabled && (
          <div className="agents-form__row">
            <Field label="A note stays fresh for" hint="days"><TextInput mono type="number" min={1} max={90} value={String(draft.memory.freshDays)} onValueChange={(value) => setDraft((current) => ({ ...current, memory: { ...current.memory, freshDays: numberOf(value, current.memory.freshDays) } }))} /></Field>
            <Field label="At most" hint="notes"><TextInput mono type="number" min={1} max={200} value={String(draft.memory.maxNotes)} onValueChange={(value) => setDraft((current) => ({ ...current, memory: { ...current.memory, maxNotes: numberOf(value, current.memory.maxNotes) } }))} /></Field>
          </div>
        )}
      </section>
    </fieldset>
  );
}

// ---- versions ----

function valueWords(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "string") return value.length > 80 ? `${value.slice(0, 79)}…` : value;
  if (Array.isArray(value)) return value.length ? value.join(", ") : "none";
  if (typeof value === "object") return scheduleWords(value as Schedule) ?? JSON.stringify(value);
  return String(value);
}

function Changes({ changes }: { changes: SpecChange[] }) {
  if (!changes.length) return <p className="agents-quiet">No differences.</p>;
  return (
    <ul className="agents-diff">
      {changes.map((change) => (
        <li key={change.field} className="agents-diff__field">
          <code className="agents-diff__name">{change.field}</code>
          {change.lines
            ? <pre className="agents-diff__lines">{change.lines.filter((line) => line.op !== "keep").map((line, index) => <span key={index} className="agents-diff__line" data-op={line.op}>{line.op === "add" ? "+ " : "- "}{line.text}{"\n"}</span>)}</pre>
            : <span className="agents-diff__values"><span data-op="remove">{valueWords(change.before)}</span><span aria-hidden="true"> → </span><span className="ui-visually-hidden"> became </span><span data-op="add">{valueWords(change.after)}</span></span>}
        </li>
      ))}
    </ul>
  );
}

function Versions({ agent, csrfToken, now, onRolledBack }: { agent: AgentDetail; csrfToken: string; now: number; onRolledBack: (agent: AgentDetail) => void }) {
  const [shown, setShown] = useState<VersionDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const compare = async (version: number) => {
    try { setShown(await agentsApi.version(agent.id, version)); setError(null); } catch (requestError) { setError(errorText(requestError, "That version could not be read")); }
  };
  const rollback = async (version: number) => {
    setBusy(true);
    try { onRolledBack(await agentsApi.rollback(csrfToken, agent.id, version)); setShown(null); setError(null); } catch (requestError) { setError(errorText(requestError, "The roll back did not work")); } finally { setBusy(false); }
  };
  const versions = [...agent.versions].sort((a, b) => b.version - a.version);
  const columns: Array<TableColumn<AgentVersion>> = [
    { id: "version", header: "Version", cell: (version) => <span className="agents-mono">v{version.version}{version.version === agent.version ? " · current" : ""}</span> },
    { id: "note", header: "What changed", cell: (version) => <span className="agents-dim">{version.note ?? (version.version === 1 ? "Made" : "Edited")}</span> },
    { id: "when", header: "When", hideOnPhone: true, cell: (version) => <span className="agents-dim">{relativeTime(version.createdAt, now) ?? ""}</span> },
    { id: "compare", header: <span className="ui-visually-hidden">Compare</span>, label: "Compare", className: "agents-actions-cell", cell: (version) => <Button variant="ghost" onClick={() => void compare(version.version)} aria-label={`Compare version ${version.version}`}>Compare</Button> },
  ];
  return (
    <Panel className="agents-versions" title="Versions" count={agent.versions.length} meta={<>v<b>{agent.version}</b> in use</>}>
      {error && <Notice tone="danger" live>{error}</Notice>}
      <Table caption={`Versions of ${agent.name}`} columns={columns} rows={versions} rowKey={(version) => String(version.version)} />
      {shown && (
        <Sheet kicker={agent.name} title={`Version ${shown.version.version}`} size="lg" onClose={() => setShown(null)}
          footer={agent.canEdit && shown.version.version !== agent.version ? <Button busy={busy} onClick={() => void rollback(shown.version.version)}>Roll back to version {shown.version.version}</Button> : undefined}>
          <p className="agents-dim">{shown.version.note ?? "No note."} {relativeTime(shown.version.createdAt, now) ?? ""}</p>
          <h3 className="agents-form__heading">Against the version before it</h3>
          <Changes changes={shown.changes} />
          {shown.version.version !== agent.version && <><h3 className="agents-form__heading">Against the one in use (v{agent.version})</h3><Changes changes={shown.againstCurrent} /></>}
        </Sheet>
      )}
    </Panel>
  );
}

// ---- the builder ----

export function Builder({ agentId, catalog, canCreate, csrfToken, now, onCreated, onChanged, onDeleted, onTest }: BuilderProps) {
  const [agent, setAgent] = useState<AgentDetail | null>(null);
  const [draft, setDraftState] = useState<AgentSpec | null>(null);
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<{ tone: "success" | "info"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [showPrompt, setShowPrompt] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const load = useCallback(async (id: string) => {
    try {
      const detail = await agentsApi.agent(id);
      setAgent(detail);
      setDraftState(clone(detail.spec));
      setError(null);
    } catch (requestError) {
      setError(errorText(requestError, "The agent could not be read"));
    }
  }, []);
  useEffect(() => { setAgent(null); setDraftState(null); setSaved(null); if (agentId) void load(agentId); }, [agentId, load]);

  const setDraft = useCallback((update: (draft: AgentSpec) => AgentSpec) => { setDraftState((current) => (current ? update(current) : current)); setSaved(null); }, []);
  const dirty = useMemo(() => Boolean(agent && draft && JSON.stringify(agent.spec) !== JSON.stringify(draft)), [agent, draft]);

  if (!agentId) return <TemplatePicker catalog={catalog} canCreate={canCreate} csrfToken={csrfToken} onCreated={onCreated} />;
  if (error && !agent) return <Notice tone="danger" live title="The agent could not be read" action={<Button onClick={() => void load(agentId)}>Try again</Button>}>{error}</Notice>;
  if (!agent || !draft || !catalog) return <Panel title="Agent" padded><p className="agents-quiet">Reading…</p></Panel>;

  const save = async () => {
    setBusy(true);
    try {
      const result = await agentsApi.update(csrfToken, agent.id, draft, note || undefined);
      setAgent(result);
      setDraftState(clone(result.spec));
      setNote("");
      setError(null);
      setSaved(result.unchanged ? { tone: "info", text: "Nothing changed, so no new version." } : { tone: "success", text: `Saved as version ${result.version}.` });
      onChanged();
    } catch (requestError) {
      setError(errorText(requestError, "The agent could not be saved"));
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    try { await agentsApi.remove(csrfToken, agent.id); onDeleted(); } catch (requestError) { setError(errorText(requestError, "The agent could not be deleted")); setConfirmDelete(false); }
  };

  return (
    <div className="agents-builder">
      <Panel
        className="agents-editor"
        title={agent.name}
        count={`v${agent.version}`}
        meta={agent.template ? `from the ${catalog.templates.find((template) => template.id === agent.template)?.title ?? agent.template} template` : "made from scratch"}
        actions={<Button variant="ghost" onClick={() => onTest(agent.id)}>Test it</Button>}
        padded
        footer={agent.canEdit ? (
          <div className="agents-editor__foot">
            <Field label="What changed" optional className="agents-editor__note"><TextInput value={note} maxLength={200} placeholder="For the version list" onValueChange={setNote} /></Field>
            <Button variant="ghost" disabled={!dirty} onClick={() => { setDraftState(clone(agent.spec)); setSaved(null); }}>Undo changes</Button>
            <Button variant="primary" busy={busy} disabled={!dirty} onClick={() => void save()}>Save as version {agent.version + 1}</Button>
          </div>
        ) : undefined}
      >
        {!agent.canEdit && <Notice tone="info">Only the owner and the person who made it change it. You can read it and test it.</Notice>}
        {error && <Notice tone="danger" live title="Not saved">{error}</Notice>}
        {saved && <Notice tone={saved.tone} live>{saved.text}</Notice>}
        <SpecForm draft={draft} setDraft={setDraft} catalog={catalog} disabled={!agent.canEdit} />
      </Panel>

      <div className="agents-builder__side">
        <Versions agent={agent} csrfToken={csrfToken} now={now} onRolledBack={(next) => { setAgent(next); setDraftState(clone(next.spec)); setSaved({ tone: "success", text: `Rolled back: version ${next.version} is the old one again.` }); onChanged(); }} />
        <Panel className="agents-prompt" title="What the model is told" meta="BoxPilot's rules, then the instructions" actions={<Button variant="ghost" aria-expanded={showPrompt} onClick={() => setShowPrompt((value) => !value)}>{showPrompt ? "Hide" : "Show"}</Button>}>
          {showPrompt && <CodeBlock label="The system prompt" maxHeight="420px">{agent.prompt}</CodeBlock>}
        </Panel>
        {agent.canEdit && (
          <Panel className="agents-danger" title="Delete" padded>
            <p className="agents-dim">Deletes the agent, its versions and its notes. Its runs stay in the history.</p>
            <Button onClick={() => setConfirmDelete(true)}>Delete {agent.name}</Button>
          </Panel>
        )}
      </div>

      {confirmDelete && (
        <Sheet side="center" size="sm" kicker="Agents" title={`Delete ${agent.name}?`} onClose={() => setConfirmDelete(false)}
          footer={<><Button variant="ghost" onClick={() => setConfirmDelete(false)}>Keep it</Button><Button variant="primary" onClick={() => void remove()}>Delete</Button></>}>
          <p>Anything it has waiting is cancelled and a run in progress is stopped. This cannot be undone.</p>
          <StatusChip status="warning">{agent.versions.length} {agent.versions.length === 1 ? "version" : "versions"}</StatusChip>
        </Sheet>
      )}
    </div>
  );
}
