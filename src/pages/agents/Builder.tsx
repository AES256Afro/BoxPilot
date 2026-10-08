import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type ReactNode } from "react";
import { relativeTime } from "../../home/format";
import { Button, Checkbox, CodeBlock, CopyButton, Facts, Field, Notice, Panel, Segmented, Select, Sheet, StatusChip, Switch, Table, Tag, TextInput, Textarea, type TableColumn } from "../../ui";
import { agentsApi, type AgentDetail, type AgentSpec, type AgentSummary, type AgentVersion, type Catalog, type ChatKind, type ChatOutput, type ChatOutputs, type ModelRoute, type OutputField, type Schedule, type SpecChange, type ToolInfo, type ToolPermission, type VersionDetail } from "./api";
import { errorText, scheduleWords, triggerWords } from "./format";

/*
 * The Agent Builder (M37), in the order an agent is built:
 * 1. Scope: one specific job and how the owner will know it did it; the Builder warns when the scope
 *    reads like "do everything".
 * 2. The system prompt, structured: rules, operational steps, the output format (text, or JSON with
 *    named fields the answer is checked against), what to escalate - templates prefill it, and it
 *    is versioned with line diffs.
 * 3. Data and tools: who may ask it, what it reads, each tool from the registry with its category,
 *    cost and permission, and the apps and operations it may touch.
 * 4. When it runs, 5. its guardrails (budget, outputs, escalation, thinking), 6. its memory, and
 *    7. its team: whether it shares its findings with the other agents and uses theirs (M44), and
 *    a supervisor that hands subtasks to specialists.
 * Then test it in the console. Saving makes a new version; every version compares field by field
 * and can be rolled back to. An agent exports as JSON and imports back.
 */

export interface BuilderProps {
  agentId: string | null;
  agents: AgentSummary[];
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

/** Its team chat (M38): each kind on by default, to the connection's channel under its own name. */
const chatKinds: readonly ChatKind[] = ["findings", "logs", "knowledge"];
const chatWords: Record<ChatKind, { label: string; description: string; channel: string }> = {
  findings: { label: "Findings", description: "Answers, digests and cards", channel: "agent-findings" },
  logs: { label: "Logs", description: "Each run's trace", channel: "agent-logs" },
  knowledge: { label: "Knowledge", description: "The notes it keeps", channel: "agent-knowledge" },
};
const defaultChat: ChatOutputs = { findings: { enabled: true, channel: null, topic: null }, logs: { enabled: true, channel: null, topic: null }, knowledge: { enabled: true, channel: null, topic: null } };
/** An agent saved before M38 has none stored: every output on, as the server reads it. */
const chatOf = (spec: AgentSpec): ChatOutputs => ({ ...defaultChat, ...(spec.outputs.chat ?? {}) });
const escalationWords: Record<keyof AgentSpec["escalation"], { label: string; description: string }> = {
  lowConfidence: { label: "When it is unsure what was meant", description: "A card when it is less than half sure it understood." },
  limits: { label: "When it reaches a limit", description: "A card when it runs out of steps, time or model time." },
  actions: { label: "When something needs doing", description: "A plan to approve, never an action." },
  risk: { label: "When something looks risky", description: "A card and a notification when what it read looked like an instruction." },
};
const budgetWords: Record<keyof AgentSpec["budget"], { label: string; unit: string }> = {
  runsPerDay: { label: "Runs a day", unit: "runs" },
  modelSecondsPerDay: { label: "Model time a day", unit: "seconds" },
  stepsPerRun: { label: "Steps a run", unit: "steps" },
  tokensPerRun: { label: "Tokens a run", unit: "tokens" },
  runSeconds: { label: "Longest run", unit: "seconds" },
};
/** What each model choice does, said under it (M45.3, M45.4). */
const routeHints: Record<ModelRoute, string> = {
  local: "Every run stays on this server.",
  auto: "It plans on this server and moves to Claude when its plan is unsure, proposes a change, or is too long for the local model. An answer that comes out cut short or not matching its tools is asked again on Claude. Needs Claude connected on the Agents page; until then, the local model answers.",
  claude: "Claude runs only once it is connected on the Agents page, and never past its monthly cap; until then, and after, the local model answers.",
};
const weekdays = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const permissionOptions = [{ value: "auto" as const, label: "On" }, { value: "ask" as const, label: "Asked" }, { value: "off" as const, label: "Off" }];
const article = (word: string) => (/^[aeiou]/i.test(word) || /^IT\b/.test(word) ? "an" : "a");

// ---- the templates, and importing a definition ----

function TemplatePicker({ catalog, canCreate, csrfToken, onCreated }: Pick<BuilderProps, "catalog" | "canCreate" | "csrfToken" | "onCreated">) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const file = useRef<HTMLInputElement | null>(null);
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
  const importFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const chosen = event.target.files?.[0];
    event.target.value = "";
    if (!chosen) return;
    setBusy("import");
    try {
      const agent = await agentsApi.importAgent(csrfToken, await chosen.text());
      setError(null);
      onCreated(agent.id);
    } catch (requestError) {
      setError(errorText(requestError, "That file could not be imported"));
    } finally {
      setBusy(null);
    }
  };
  if (!catalog) return <Panel title="Templates" padded><p className="agents-quiet">Reading the templates…</p></Panel>;
  return (
    <Panel className="agents-templates" title="Start from a template" count={catalog.templates.length} meta="each becomes an agent you can change" padded
      actions={canCreate ? <>
        <input ref={file} type="file" accept="application/json,.json" className="agents-file" aria-label="An agent definition to import" onChange={(event) => void importFile(event)} />
        <Button variant="ghost" busy={busy === "import"} onClick={() => file.current?.click()}>Import from a file</Button>
      </> : undefined}>
      {error && <Notice tone="danger" live>{error}</Notice>}
      <div className="agents-templates__grid">
        {catalog.templates.map((template) => {
          const tools = Object.values(template.spec.tools).filter((permission) => permission !== "off").length;
          return (
            <article key={template.id} className="agents-template" aria-label={template.title}>
              <h3 className="agents-template__title">{template.title}{template.spec.orchestration?.supervisor ? <Tag tone="accent">supervisor</Tag> : null}</h3>
              <p className="agents-template__summary">{template.summary}</p>
              <p className="agents-template__job"><span className="agents-dim">Its job:</span> {template.spec.job}</p>
              <Facts>
                <b>{tools}</b> {tools === 1 ? "tool" : "tools"} · {triggerWords({ triggers: template.spec.triggers })} · asked by {template.spec.audience.join(", ")}
              </Facts>
              {canCreate && <Button variant={template.id === "server-keeper" ? "primary" : "secondary"} busy={busy === template.id} onClick={() => void create(template.id)}>{template.id === "blank" ? "Start blank" : `Make ${article(template.title)} ${template.title}`}</Button>}
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
  others: AgentSummary[];
  /** The template it was made from: an agent saved before M44 shares findings as its template would. */
  template?: string | null;
}

/** Its two findings switches (M44), as the server reads them for an agent saved before they existed. */
function sharingOf(spec: AgentSpec, template: string | null = null): { shareFindings: boolean; useFindings: boolean } {
  return {
    shareFindings: typeof spec.sharing?.shareFindings === "boolean" ? spec.sharing.shareFindings : !["it-support", "house-guide"].includes(template ?? ""),
    useFindings: typeof spec.sharing?.useFindings === "boolean" ? spec.sharing.useFindings : true,
  };
}

function numberOf(text: string, fallback: number): number {
  const value = Number.parseInt(text, 10);
  return Number.isFinite(value) ? value : fallback;
}
const linesOf = (text: string) => text.split("\n");
const idList = (text: string) => text.split(/[\s,]+/).map((part) => part.trim()).filter(Boolean);

function FormSection({ id, title, step, children, flush = false }: { id: string; title: string; step: number; children: ReactNode; flush?: boolean }) {
  return (
    <section className={`agents-form__section${flush ? " agents-form__section--flush" : ""}`} aria-labelledby={`agents-form-${id}`}>
      <h3 id={`agents-form-${id}`} className="agents-form__heading"><span className="agents-form__step">{step}</span>{title}</h3>
      {children}
    </section>
  );
}

function ToolTable({ draft, setDraft, catalog, disabled }: FormProps) {
  const order = Object.keys(catalog.categories ?? {});
  const tools = [...catalog.tools].sort((a, b) => order.indexOf(a.category) - order.indexOf(b.category));
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
      id: "facts", header: "Kind", hideOnPhone: true, cell: (tool) => (
        <span className="agents-tool__tags">
          <Tag tone={tool.category === "web" ? "warning" : tool.category === "action" || tool.category === "orchestration" ? "accent" : "neutral"}>{tool.categoryTitle ?? tool.category}</Tag>
          {tool.role === "operator" ? <Tag tone="warning" title="An operator read: only for runs of the owner or an operator">operator</Tag> : null}
          <Tag tone={tool.cost === "heavy" ? "warning" : "neutral"}>{tool.cost}</Tag>
          {tool.writes && <Tag tone="info" title={`Writes ${tool.writes}; never anything on the server`}>writes {tool.writes}</Tag>}
          {tool.defaultOff && <Tag tone="warning" title="Also needs the owner to turn it on for the whole server">opt-in</Tag>}
        </span>
      ),
    },
    {
      id: "permission", header: "Permission", className: "agents-tool__permission", cell: (tool) => (
        <Segmented<ToolPermission>
          label={`${tool.title}: permission`}
          value={draft.tools[tool.id] ?? "off"}
          onChange={(value) => { if (!disabled) setDraft((current) => ({ ...current, tools: { ...current.tools, [tool.id]: value } })); }}
          options={permissionOptions.map((option) => ({ ...option, disabled: disabled || (tool.id === "agents.handoff" && !draft.orchestration.supervisor) }))}
        />
      ),
    },
  ];
  return <Table caption="Tools and their permissions" columns={columns} rows={tools} rowKey={(tool) => tool.id} />;
}

function ScheduleFields({ draft, setDraft, disabled }: Omit<FormProps, "catalog" | "others">) {
  const schedule = draft.triggers.schedule;
  const set = (next: Schedule | null) => setDraft((current) => ({ ...current, triggers: { ...current.triggers, schedule: next } }));
  const every = schedule?.every ?? "none";
  return (
    <div className="agents-form__row">
      <Field label="Schedule">
        <Select value={every} disabled={disabled} onValueChange={(value) => set(value === "none" ? null : { every: value as Schedule["every"], minute: schedule?.minute ?? 30, hour: value === "daily" || value === "weekly" ? schedule?.hour ?? 5 : null, weekday: value === "weekly" ? schedule?.weekday ?? 1 : null, quietHours: schedule?.quietHours ?? true })}
          options={[{ value: "none", label: "No schedule" }, { value: "hourly", label: "Every hour" }, { value: "every-6-hours", label: "Every 6 hours" }, { value: "daily", label: "Every day" }, { value: "weekly", label: "Every week" }]} />
      </Field>
      {schedule && schedule.every === "weekly" && (
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

function OutputFields({ draft, setDraft, disabled }: Omit<FormProps, "catalog" | "others">) {
  const output = draft.prompt.output;
  const setOutput = (next: Partial<AgentSpec["prompt"]["output"]>) => setDraft((current) => ({ ...current, prompt: { ...current.prompt, output: { ...current.prompt.output, ...next } } }));
  const setField = (index: number, change: Partial<OutputField>) => setOutput({ fields: output.fields.map((field, at) => (at === index ? { ...field, ...change } : field)) });
  return (
    <div className="agents-form__output">
      <Segmented<"text" | "json"> label="Its answer" value={output.format} onChange={(format) => { if (!disabled) setOutput({ format, fields: format === "json" && !output.fields.length ? [{ name: "answer", description: "" }] : output.fields }); }}
        options={[{ value: "text", label: "Sentences", disabled }, { value: "json", label: "JSON fields", disabled }]} />
      {output.format === "text"
        ? <Field label="How it writes its answer" optional><TextInput value={output.style} maxLength={300} placeholder="Short sentences, facts first, each with its citation." onValueChange={(value) => setOutput({ style: value })} /></Field>
        : (
          <div className="agents-form__fields">
            {output.fields.map((field, index) => (
              <div key={index} className="agents-form__field-row">
                <Field label={`Field ${index + 1}`}><TextInput mono value={field.name} maxLength={32} placeholder="fullestDisk" onValueChange={(value) => setField(index, { name: value })} /></Field>
                <Field label="What it holds"><TextInput value={field.description} maxLength={200} onValueChange={(value) => setField(index, { description: value })} /></Field>
                <Button variant="ghost" disabled={disabled || output.fields.length <= 1} onClick={() => setOutput({ fields: output.fields.filter((_, at) => at !== index) })} aria-label={`Remove field ${index + 1}`}>Remove</Button>
              </div>
            ))}
            <Button variant="ghost" disabled={disabled || output.fields.length >= 8} onClick={() => setOutput({ fields: [...output.fields, { name: "", description: "" }] })}>Add a field</Button>
          </div>
        )}
    </div>
  );
}

function SpecForm({ draft, setDraft, catalog, disabled, others, template = null }: FormProps) {
  const limits = catalog.limits.budget;
  const sharing = sharingOf(draft, template);
  const setSharing = (change: Partial<ReturnType<typeof sharingOf>>) => setDraft((current) => ({ ...current, sharing: { ...sharingOf(current, template), ...change } }));
  const setPrompt = (key: "rules" | "steps" | "escalate", value: string) => setDraft((current) => ({ ...current, prompt: { ...current.prompt, [key]: linesOf(value) } }));
  const allow = draft.allow;
  const delegates = draft.orchestration.delegates;
  const route: ModelRoute = draft.model.route ?? "local";
  const reachesClaude = route !== "local";
  return (
    <fieldset className="agents-form" disabled={disabled}>
      <FormSection id="scope" title="Its job" step={1}>
        <div className="agents-form__row">
          <Field label="Name"><TextInput value={draft.name} maxLength={60} onValueChange={(value) => setDraft((current) => ({ ...current, name: value }))} /></Field>
        </div>
        <Field label="Its one job" hint="One specific job, in a sentence. A small model does one job well and many badly.">
          <TextInput value={draft.job} maxLength={200} onValueChange={(value) => setDraft((current) => ({ ...current, job: value }))} />
        </Field>
        <Field label="It did its job when" hint="One per line. These are what its evaluation checks.">
          <Textarea rows={3} value={draft.successCriteria.join("\n")} onValueChange={(value) => setDraft((current) => ({ ...current, successCriteria: linesOf(value) }))} />
        </Field>
        <Field label="Purpose" optional hint="What people who may ask it see.">
          <TextInput value={draft.purpose} maxLength={300} onValueChange={(value) => setDraft((current) => ({ ...current, purpose: value }))} />
        </Field>
      </FormSection>

      <FormSection id="prompt" title="What it is told" step={2}>
        <p className="agents-form__note">Below BoxPilot's own rules, which it cannot change: read before answering, cite tool output, do sums with the exact tools, propose and never act.</p>
        <Field label="Rules" optional hint="One per line."><Textarea rows={3} value={draft.prompt.rules.join("\n")} onValueChange={(value) => setPrompt("rules", value)} /></Field>
        <Field label="How it works" optional hint="Its steps, one per line, in order."><Textarea rows={4} value={draft.prompt.steps.join("\n")} onValueChange={(value) => setPrompt("steps", value)} /></Field>
        <OutputFields draft={draft} setDraft={setDraft} disabled={disabled} />
        <Field label="What it hands to you" optional hint="One per line: what it tells you about or proposes a plan for."><Textarea rows={2} value={draft.prompt.escalate.join("\n")} onValueChange={(value) => setPrompt("escalate", value)} /></Field>
        <Field label="Anything else" optional><Textarea rows={3} value={draft.instructions} maxLength={8000} onValueChange={(value) => setDraft((current) => ({ ...current, instructions: value }))} /></Field>
      </FormSection>

      <FormSection id="data" title="Data and tools" step={3} flush>
        <div className="agents-form__checks">
          {(["owner", "operator", "viewer"] as const).map((role) => (
            <Checkbox key={role} label={role === "owner" ? "The owner may ask it" : role === "operator" ? "Operators may ask it" : "Viewers may ask it"} description={role === "viewer" ? "Their runs read only what a viewer may: never logs or Pi-hole." : undefined}
              checked={draft.audience.includes(role)} disabled={role === "owner"} onChange={(checked) => setDraft((current) => ({ ...current, audience: checked ? [...new Set([...current.audience, role])] : current.audience.filter((entry) => entry !== role) }))} />
          ))}
        </div>
        <div className="agents-form__checks">
          {(Object.keys(knowledgeWords) as Array<keyof AgentSpec["knowledge"]>).map((source) => (
            <Checkbox key={source} label={`Reads ${knowledgeWords[source].toLowerCase()}`} checked={draft.knowledge[source]} onChange={(checked) => setDraft((current) => ({ ...current, knowledge: { ...current.knowledge, [source]: checked } }))} />
          ))}
        </div>
        <p className="agents-form__note">Every tool reads; none changes the server. "Asked" means only when a person asked, never on a schedule, an event or a webhook. Tool output reaches the model as data, redacted, never as instructions.</p>
        <ToolTable draft={draft} setDraft={setDraft} catalog={catalog} disabled={disabled} others={others} />
        <div className="agents-form__row">
          <Field label="Apps it may look at" hint={allow.apps === "*" ? "Any app" : "App ids, separated by commas"}>
            {allow.apps === "*"
              ? <Button variant="ghost" onClick={() => setDraft((current) => ({ ...current, allow: { ...current.allow, apps: [] } }))}>Only some apps</Button>
              : <TextInput mono value={allow.apps.join(", ")} placeholder="pi-hole, jellyfin" onValueChange={(value) => setDraft((current) => ({ ...current, allow: { ...current.allow, apps: idList(value) } }))} />}
          </Field>
          <Field label="Operations it may propose" hint={allow.operations === "*" ? "Any it may propose" : "Operation ids, separated by commas"}>
            {allow.operations === "*"
              ? <Button variant="ghost" onClick={() => setDraft((current) => ({ ...current, allow: { ...current.allow, operations: [] } }))}>Only some operations</Button>
              : <TextInput mono value={allow.operations.join(", ")} placeholder="app.backup, app.update" onValueChange={(value) => setDraft((current) => ({ ...current, allow: { ...current.allow, operations: idList(value) } }))} />}
          </Field>
          {(allow.apps !== "*" || allow.operations !== "*") && <Button variant="ghost" onClick={() => setDraft((current) => ({ ...current, allow: { apps: "*", operations: "*" } }))}>Allow any again</Button>}
        </div>
      </FormSection>

      <FormSection id="when" title="When it runs" step={4}>
        <Switch label="When someone asks" checked={draft.triggers.ask} disabled={disabled} onChange={(checked) => setDraft((current) => ({ ...current, triggers: { ...current.triggers, ask: checked } }))} />
        <ScheduleFields draft={draft} setDraft={setDraft} disabled={disabled} />
        <div className="agents-form__checks">
          {catalog.events.map((event) => (
            <Checkbox key={event.id} label={event.title} description="At most once every half hour." checked={draft.triggers.events.includes(event.id)}
              onChange={(checked) => setDraft((current) => ({ ...current, triggers: { ...current.triggers, events: checked ? [...new Set([...current.triggers.events, event.id])] : current.triggers.events.filter((entry) => entry !== event.id) } }))} />
          ))}
          <Checkbox label="A webhook" description="Another system (n8n, for one) can start it with a secret URL; it chooses only when." checked={draft.triggers.webhook}
            onChange={(checked) => setDraft((current) => ({ ...current, triggers: { ...current.triggers, webhook: checked } }))} />
        </div>
      </FormSection>

      <FormSection id="guardrails" title="Guardrails" step={5}>
        <div className="agents-form__grid">
          {(Object.keys(budgetWords) as Array<keyof AgentSpec["budget"]>).map((key) => (
            <Field key={key} label={budgetWords[key].label} hint={`${limits[key].min}–${limits[key].max} ${budgetWords[key].unit}${Number.isFinite(limits[key].default) ? `, ${limits[key].default} by default` : ""}`}>
              <TextInput mono type="number" min={limits[key].min} max={limits[key].max} value={String(draft.budget[key])}
                onValueChange={(value) => setDraft((current) => ({ ...current, budget: { ...current.budget, [key]: numberOf(value, current.budget[key]) } }))} />
            </Field>
          ))}
        </div>
        <p className="agents-form__note">A run on its schedule goes at about half the speed of a question you wait on. If its runs end with a card saying it ran out of time or reached a limit, raise the longest run, its steps or its tokens here.</p>
        <div className="agents-form__checks">
          {(Object.keys(outputWords) as Array<keyof typeof outputWords>).map((key) => (
            <Checkbox key={key} label={`Writes ${outputWords[key].toLowerCase()}`} checked={draft.outputs[key]} onChange={(checked) => setDraft((current) => ({ ...current, outputs: { ...current.outputs, [key]: checked } }))} />
          ))}
        </div>
        <div className="agents-form__row">
          <Field label="Tell the owner">
            <Select value={draft.outputs.notify} disabled={disabled} onValueChange={(value) => setDraft((current) => ({ ...current, outputs: { ...current.outputs, notify: value as "important" | "never" } }))}
              options={[{ value: "important", label: "Only what is important" }, { value: "never", label: "Never" }]} />
          </Field>
        </div>
        <p className="agents-form__note">Its team chat, once Zulip is connected on the Agents tab. BoxPilot posts from each run's outcome, redacted; the model never posts, and nothing is approved there.</p>
        <div className="agents-chat">
          {chatKinds.map((kind) => {
            const output = chatOf(draft)[kind];
            const change = (patch: Partial<ChatOutput>) => setDraft((current) => ({ ...current, outputs: { ...current.outputs, chat: { ...chatOf(current), [kind]: { ...chatOf(current)[kind], ...patch } } } }));
            return (
              <div key={kind} className="agents-chat__row">
                <span className="agents-name"><span>{chatWords[kind].label}</span><span className="agents-name__purpose">{chatWords[kind].description}</span></span>
                <Switch label={<span className="ui-visually-hidden">Post {chatWords[kind].label.toLowerCase()}</span>} checked={output.enabled} disabled={disabled} onChange={(checked) => change({ enabled: checked })} />
                <Field label={`${chatWords[kind].label} channel`} hint={`#${chatWords[kind].channel} unless you name one`}>
                  <TextInput mono value={output.channel ?? ""} placeholder={chatWords[kind].channel} disabled={disabled || !output.enabled} spellCheck={false} autoCapitalize="off" onValueChange={(value) => change({ channel: value.trim() ? value.replace(/^#/, "") : null })} />
                </Field>
                <Field label={`${chatWords[kind].label} topic`} hint="its name unless you name one">
                  <TextInput value={output.topic ?? ""} placeholder={draft.name || "its name"} disabled={disabled || !output.enabled} maxLength={60} onValueChange={(value) => change({ topic: value.trim() ? value : null })} />
                </Field>
              </div>
            );
          })}
        </div>
        <p className="agents-form__note">It hands the matter to you as a card, and never acts:</p>
        <div className="agents-form__checks">
          {(Object.keys(escalationWords) as Array<keyof AgentSpec["escalation"]>).map((key) => (
            <Checkbox key={key} label={escalationWords[key].label} description={escalationWords[key].description} checked={draft.escalation[key]}
              onChange={(checked) => setDraft((current) => ({ ...current, escalation: { ...current.escalation, [key]: checked } }))} />
          ))}
        </div>
        <div className="agents-form__row">
          <Field label="Model" hint={routeHints[route]}>
            <Select value={route} disabled={disabled} onValueChange={(value) => setDraft((current) => ({ ...current, model: { ...current.model, route: value === "claude" || value === "auto" ? value : "local" } }))}
              options={[{ value: "local", label: "The local model, on this server" }, { value: "auto", label: "The local model, moving to Claude when a run needs it" }, { value: "claude", label: "Claude, through the model gateway" }]} />
          </Field>
          {reachesClaude && (
            <Field label="What may leave this server" hint="Secrets never leave it, either way.">
              <Select value={draft.model.dataPolicy ?? "redacted"} disabled={disabled} onValueChange={(value) => setDraft((current) => ({ ...current, model: { ...current.model, dataPolicy: value === "as-is" ? "as-is" : "redacted" } }))}
                options={[{ value: "redacted", label: "Names replaced: hosts, addresses, accounts and local domains go as stand-ins" }, { value: "as-is", label: "As it is" }]} />
            </Field>
          )}
        </div>
        {reachesClaude && (
          <div className="agents-form__checks">
            <Checkbox label="Claude may answer viewers" description="A viewer's question goes to Anthropic too. Off: a viewer's question is answered by the local model." checked={draft.model.claudeForViewers ?? false} disabled={disabled}
              onChange={(checked) => setDraft((current) => ({ ...current, model: { ...current.model, claudeForViewers: checked } }))} />
            <Checkbox label="Claude may read your documents" description={route === "auto" ? "The library on the Knowledge tab, what came in from Notion or Slack, and files dropped in Zulip. Off: they stay on this server, and since any run may move to Claude, the agent answers without them." : "The library on the Knowledge tab, what came in from Notion or Slack, and files dropped in Zulip. Off: they stay on this server, and the agent answers without them."} checked={draft.model.claudeReadsDocuments ?? false} disabled={disabled}
              onChange={(checked) => setDraft((current) => ({ ...current, model: { ...current.model, claudeReadsDocuments: checked } }))} />
          </div>
        )}
        <Switch label="Thinking" description={route === "claude" ? "For the local model, when it answers instead. Claude always thinks, as hard as the run needs." : "Off by default: on this processor a small model can spend minutes thinking and never answer. Turn it on only for hard tasks; it counts against the budget."} checked={draft.model.thinking} disabled={disabled}
          onChange={(checked) => setDraft((current) => ({ ...current, model: { ...current.model, thinking: checked } }))} />
      </FormSection>

      <FormSection id="memory" title="Memory" step={6}>
        <Switch label="Keeps notes between runs" checked={draft.memory.enabled} disabled={disabled} onChange={(checked) => setDraft((current) => ({ ...current, memory: { ...current.memory, enabled: checked } }))} />
        {draft.memory.enabled && (
          <div className="agents-form__row">
            <Field label="A note stays fresh for" hint="days"><TextInput mono type="number" min={1} max={90} value={String(draft.memory.freshDays)} onValueChange={(value) => setDraft((current) => ({ ...current, memory: { ...current.memory, freshDays: numberOf(value, current.memory.freshDays) } }))} /></Field>
            <Field label="At most" hint="notes"><TextInput mono type="number" min={1} max={200} value={String(draft.memory.maxNotes)} onValueChange={(value) => setDraft((current) => ({ ...current, memory: { ...current.memory, maxNotes: numberOf(value, current.memory.maxNotes) } }))} /></Field>
            <Checkbox className="agents-form__check" label="Other agents may read its notes" description="Each as far as its own runs may read." checked={draft.memory.share} onChange={(checked) => setDraft((current) => ({ ...current, memory: { ...current.memory, share: checked } }))} />
          </div>
        )}
        <div className="agents-form__row">
          <Checkbox className="agents-form__check" label="Remembers the conversation with each person" checked={draft.memory.threads} onChange={(checked) => setDraft((current) => ({ ...current, memory: { ...current.memory, threads: checked } }))} />
          {draft.memory.threads && <Field label="Turns kept word for word" hint="older ones are summarised"><TextInput mono type="number" min={1} max={20} value={String(draft.memory.turns)} onValueChange={(value) => setDraft((current) => ({ ...current, memory: { ...current.memory, turns: numberOf(value, current.memory.turns) } }))} /></Field>}
        </div>
      </FormSection>

      <FormSection id="team" title="Team" step={7}>
        <Switch label="Shares its findings with the other agents" description="What it finds on its schedule, and in answers it checked against its tools, is kept for a while, so the other agents need not look again." checked={sharing.shareFindings} disabled={disabled}
          onChange={(checked) => setSharing({ shareFindings: checked })} />
        <Switch label="Uses the other agents' findings" description="Before it starts, it reads what the others found recently and answers from that when it can. It still looks for itself before it suggests a fix, or when you ask it to check now." checked={sharing.useFindings} disabled={disabled}
          onChange={(checked) => setSharing({ useFindings: checked })} />
        <Switch label="A supervisor" description="Hands subtasks to specialists and answers from what they find, on the one queue, as the person who asked." checked={draft.orchestration.supervisor} disabled={disabled}
          onChange={(checked) => setDraft((current) => ({ ...current, orchestration: { ...current.orchestration, supervisor: checked }, tools: { ...current.tools, "agents.handoff": checked ? "auto" : "off" } }))} />
        {draft.orchestration.supervisor && (
          <>
            <div className="agents-form__checks">
              <Checkbox label="Any other agent" checked={delegates === "*"} onChange={(checked) => setDraft((current) => ({ ...current, orchestration: { ...current.orchestration, delegates: checked ? "*" : [] } }))} />
              {delegates !== "*" && others.map((other) => (
                <Checkbox key={other.id} label={other.name} checked={delegates.includes(other.id)}
                  onChange={(checked) => setDraft((current) => ({ ...current, orchestration: { ...current.orchestration, delegates: checked ? [...new Set([...(current.orchestration.delegates === "*" ? [] : current.orchestration.delegates), other.id])] : (current.orchestration.delegates === "*" ? [] : current.orchestration.delegates.filter((entry) => entry !== other.id)) } }))} />
              ))}
            </div>
            <div className="agents-form__row">
              <Field label="How deep hand-offs may go" hint="1 to 3; never in a loop">
                <Select mono value={String(draft.orchestration.maxDepth)} disabled={disabled} onValueChange={(value) => setDraft((current) => ({ ...current, orchestration: { ...current.orchestration, maxDepth: Number(value) } }))} options={[1, 2, 3].map((depth) => ({ value: String(depth), label: String(depth) }))} />
              </Field>
            </div>
          </>
        )}
      </FormSection>
    </fieldset>
  );
}

// ---- versions ----

function valueWords(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "string") return value.length > 80 ? `${value.slice(0, 79)}…` : value;
  if (Array.isArray(value)) return value.length ? value.map((entry) => (typeof entry === "object" ? JSON.stringify(entry) : String(entry))).join(", ") : "none";
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
    { id: "note", header: "What changed", cell: (version) => <span className="agents-name"><span>{version.note ?? (version.version === 1 ? "Made" : "Edited")}</span><span className="agents-name__purpose">{relativeTime(version.createdAt, now) ?? ""}</span></span> },
    { id: "compare", header: <span className="ui-visually-hidden">Compare</span>, label: "Actions", className: "agents-actions-cell", cell: (version) => <Button variant="ghost" onClick={() => void compare(version.version)} aria-label={`Compare version ${version.version}`}>Compare</Button> },
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

/** The webhook that starts the agent: its URL is shown once, when it is made. */
function Webhook({ agent, csrfToken, onChanged }: { agent: AgentDetail; csrfToken: string; onChanged: () => void }) {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const act = async (work: () => Promise<void>) => { setBusy(true); try { await work(); setError(null); onChanged(); } catch (requestError) { setError(errorText(requestError, "That did not work")); } finally { setBusy(false); } };
  if (!agent.webhook.enabled) return null;
  return (
    <Panel className="agents-webhook" title="Webhook" count={agent.webhook.minted ? { status: "good", label: "set" } : { status: "neutral", label: "none" }} padded>
      <p className="agents-dim">A POST to this URL starts {agent.name} once, as a schedule would. The caller chooses only when: nothing it sends reaches the run.</p>
      {url && <>
        <Notice tone="warning" title="Copy it now">It is shown once; BoxPilot keeps only a digest of it.</Notice>
        <div className="agents-webhook__url"><code>{url}</code><CopyButton value={url} name="the webhook's URL" /></div>
      </>}
      {error && <Notice tone="danger" live>{error}</Notice>}
      {agent.canEdit && (
        <div className="agents-editor__foot">
          {agent.webhook.minted && <Button variant="ghost" busy={busy} onClick={() => void act(async () => { await agentsApi.clearWebhook(csrfToken, agent.id); setUrl(null); })}>Take it away</Button>}
          <Button busy={busy} onClick={() => void act(async () => { const made = await agentsApi.mintWebhook(csrfToken, agent.id); setUrl(`${window.location.origin}${made.path}`); })}>{agent.webhook.minted ? "Make a new URL" : "Make its URL"}</Button>
        </div>
      )}
    </Panel>
  );
}

// ---- the builder ----

export function Builder({ agentId, agents, catalog, canCreate, csrfToken, now, onCreated, onChanged, onDeleted, onTest }: BuilderProps) {
  const [agent, setAgent] = useState<AgentDetail | null>(null);
  const [draft, setDraftState] = useState<AgentSpec | null>(null);
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<{ tone: "success" | "info"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [showPrompt, setShowPrompt] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  // "Test it" pressed with unsaved changes: the choice is shown instead of leaving.
  const [leaving, setLeaving] = useState(false);

  // The agent on show: an answer for the one chosen before is dropped rather than drawn under this one.
  const shown = useRef(agentId);
  // `keepDraft`: read the agent again without throwing away what is being edited. Making or removing
  // its webhook URL reads it again, and used to reset every unsaved change in the form.
  const load = useCallback(async (id: string, { keepDraft = false }: { keepDraft?: boolean } = {}) => {
    try {
      const detail = await agentsApi.agent(id);
      if (shown.current !== id) return;
      setAgent(detail);
      setDraftState((current) => (keepDraft && current ? current : clone(detail.spec)));
      setError(null);
    } catch (requestError) {
      if (shown.current === id) setError(errorText(requestError, "The agent could not be read"));
    }
  }, []);
  useEffect(() => { shown.current = agentId; setAgent(null); setDraftState(null); setSaved(null); if (agentId) void load(agentId); }, [agentId, load]);

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
      return true;
    } catch (requestError) {
      setError(errorText(requestError, "The agent could not be saved"));
      return false;
    } finally {
      setBusy(false);
    }
  };
  // Testing runs the saved version, and leaving the tab drops what is not saved: with changes, ask first.
  const testIt = () => { if (dirty) setLeaving(true); else onTest(agent.id); };
  const remove = async () => {
    try { await agentsApi.remove(csrfToken, agent.id); onDeleted(); } catch (requestError) { setError(errorText(requestError, "The agent could not be deleted")); setConfirmDelete(false); }
  };
  const exportIt = async () => {
    try {
      const definition = await agentsApi.exportAgent(agent.id);
      const link = document.createElement("a");
      link.href = URL.createObjectURL(new Blob([JSON.stringify(definition, null, 2)], { type: "application/json" }));
      link.download = `${agent.name.replace(/[^A-Za-z0-9 _-]/g, "").trim().replace(/\s+/g, "-").toLowerCase() || "agent"}.boxpilot-agent.json`;
      link.click();
      URL.revokeObjectURL(link.href);
    } catch (requestError) {
      setError(errorText(requestError, "The agent could not be exported"));
    }
  };
  const others = agents.filter((entry) => entry.id !== agent.id);

  return (
    <div className="agents-builder">
      <Panel
        className="agents-editor"
        title={agent.name}
        count={`v${agent.version}`}
        meta={agent.template ? `from the ${catalog.templates.find((template) => template.id === agent.template)?.title ?? agent.template} template` : "made from scratch"}
        actions={<><Button variant="ghost" onClick={() => void exportIt()}>Export</Button><Button variant="ghost" onClick={testIt}>Test it</Button></>}
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
        {agent.warnings?.length > 0 && <Notice tone="warning" title="About its scope">{agent.warnings.join(" ")}</Notice>}
        {leaving && dirty && (
          <Notice tone="warning" live title="Your changes are not saved"
            action={<><Button variant="ghost" onClick={() => setLeaving(false)}>Keep editing</Button><Button variant="primary" busy={busy} onClick={() => void save().then((ok) => { setLeaving(false); if (ok) onTest(agent.id); })}>Save, then test</Button></>}>
            Testing runs the saved version, v{agent.version}, and leaving this tab drops the changes.
          </Notice>
        )}
        {error && <Notice tone="danger" live title="Not saved">{error}</Notice>}
        {saved && <Notice tone={saved.tone} live>{saved.text}</Notice>}
        <SpecForm draft={draft} setDraft={setDraft} catalog={catalog} disabled={!agent.canEdit} others={others} template={agent.template} />
      </Panel>

      <div className="agents-builder__side">
        <Versions agent={agent} csrfToken={csrfToken} now={now} onRolledBack={(next) => { setAgent(next); setDraftState(clone(next.spec)); setSaved({ tone: "success", text: `Rolled back: version ${next.version} is the old one again.` }); onChanged(); }} />
        <Webhook agent={agent} csrfToken={csrfToken} onChanged={() => void load(agent.id, { keepDraft: true })} />
        <Panel className="agents-prompt" title="What the model is told" meta="BoxPilot's rules, then yours" actions={<Button variant="ghost" aria-expanded={showPrompt} onClick={() => setShowPrompt((value) => !value)}>{showPrompt ? "Hide" : "Show"}</Button>}>
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
