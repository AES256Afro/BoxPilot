import { useCallback, useEffect, useState } from "react";
import type { PendingOperation } from "../../shell/ApproveDialog";
import { relativeTime } from "../../home/format";
import { Button, Field, KeyValue, MetricTile, Notice, Panel, Progress, Select, StatusChip, Switch, Table, Tag, TextInput, mayStart, riskOf, type Status, type TableColumn } from "../../ui";
import { agentsApi, type LibraryModel, type ModuleState, type RuntimeDriver, type RuntimeState, type Usage as UsageState } from "./api";
import { bytes, errorText, gibibytes } from "./format";
import { PasswordSheet } from "./PasswordSheet";

/*
 * Usage and the runtime (M37). First whether agents are running cool, from the runner's own cgroup:
 * the processor and memory it uses now against the hard caps the kernel holds it to, and whether
 * the kernel had to throttle it. Then the caps themselves, today's budgets per agent and the queue.
 * Then what runs the model: Unsloth, the capped runner unit, and the model library - size, time to
 * download, memory against the cap and speed before anything is fetched - each step an operation
 * approved at its tier. The owner's settings close the tab.
 */

export interface UsageProps {
  module: ModuleState;
  csrfToken: string;
  role: string;
  now: number;
  onStart: (operation: PendingOperation) => void;
  onModuleChanged: () => void;
  /** Bumped by the page when a job the tab started has finished, so it reads again. */
  refreshKey: number;
}

const driverWords: Record<RuntimeDriver, string> = { unsloth: "Unsloth", "llama-server": "llama.cpp's llama-server", external: "A model server already on this machine", fake: "The demo's stand-in model" };

function coolness(usage: UsageState): { status: Status; label: string } {
  const cap = usage.caps.cpuQuotaPercent;
  const cpu = usage.runner.usage?.cpuPercent ?? null;
  if (!usage.runner.online || cpu === null) return { status: "unknown", label: "Not measured" };
  if (cpu >= cap * 0.9) return { status: "warning", label: "At its cap" };
  return { status: "good", label: "Running cool" };
}

export function Usage({ module, csrfToken, role, now, onStart, onModuleChanged, refreshKey }: UsageProps) {
  const [usage, setUsage] = useState<UsageState | null>(null);
  const [runtime, setRuntime] = useState<RuntimeState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<{ driver: RuntimeDriver; endpoint: string; idleStopMinutes: string; quietStart: string; quietEnd: string; notify: boolean; runsPerDay: string; modelSecondsPerDay: string; embeddings: boolean } | null>(null);
  const [confirm, setConfirm] = useState<null | "settings" | "off">(null);
  const [saved, setSaved] = useState<string | null>(null);
  const owner = role === "owner";

  const read = useCallback(async () => {
    try {
      const [nextUsage, nextRuntime] = await Promise.all([agentsApi.usage(), agentsApi.runtime()]);
      setUsage(nextUsage);
      setRuntime(nextRuntime);
      setError(null);
    } catch (requestError) {
      setError(errorText(requestError, "Usage could not be read"));
    }
  }, []);
  useEffect(() => { void read(); }, [read, refreshKey]);
  // The live numbers every ten seconds while the tab is open: the runner reports them itself.
  useEffect(() => {
    const timer = setInterval(() => { void agentsApi.usage().then(setUsage, () => undefined); }, 10_000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    if (!runtime || draft) return;
    setDraft({
      driver: runtime.settings.driver, endpoint: runtime.settings.endpoint ?? "", idleStopMinutes: String(runtime.settings.idleStopMinutes ?? 60), quietStart: module.quietHours.start, quietEnd: module.quietHours.end, notify: module.notify,
      runsPerDay: String(module.budget?.runsPerDay ?? 300), modelSecondsPerDay: String(module.budget?.modelSecondsPerDay ?? 10_800), embeddings: module.embeddings !== false,
    });
  }, [runtime, draft, module]);

  if (!usage || !runtime) {
    return error
      ? <Notice tone="danger" live title="Usage could not be read" action={<Button onClick={() => void read()}>Try again</Button>}>{error}</Notice>
      : <Panel title="Right now" padded><p className="agents-quiet">Reading…</p></Panel>;
  }

  const { caps } = usage;
  const live = usage.runner.usage;
  const verdict = coolness(usage);
  const cpu = live?.cpuPercent ?? null;
  const installed = runtime.installed;
  const unsloth = runtime.unsloth;
  const service = installed?.service ?? null;
  const operation = (operationId: string, title: string, parameters: Record<string, unknown>, preview: string) => onStart({ operationId, title, parameters, preview: <span>{preview}</span> });
  const may = (operationId: string) => mayStart(role, operationId);
  const modelParameters = (model: LibraryModel) => ({ repo: model.repo, file: model.file, projector: model.projector });

  const perAgent = usage.today.perAgent;
  const modelColumns: Array<TableColumn<LibraryModel>> = [
    {
      id: "model", header: "Model", cell: (model) => (
        <span className="agents-name">
          <span className="agents-model__title">{model.title}{model.recommended && <Tag tone="accent">recommended</Tag>}{model.current && <Tag tone="good">in use</Tag>}</span>
          <span className="agents-name__purpose">{model.note}</span>
        </span>
      ),
    },
    { id: "size", header: "Download", hideOnPhone: true, cell: (model) => <span className="agents-mono">{bytes(model.preview.bytes)} · {model.preview.fastMinutes}–{model.preview.slowMinutes} min</span> },
    { id: "memory", header: "Memory", cell: (model) => <span className="agents-mono" data-fits={model.fitsCap}>{bytes(model.memoryBytes)}{model.fitsCap ? "" : " · over the cap"}</span> },
    { id: "speed", header: "Speed", hideOnPhone: true, cell: (model) => <span className="agents-mono">{model.tokensPerSecond} tok/s</span> },
    {
      id: "actions", header: <span className="ui-visually-hidden">Actions</span>, label: "Actions", className: "agents-actions-cell", cell: (model) => (
        <span className="agents-actions">
          {!model.downloaded && may("agents.model.download") && (
            <Button risk={riskOf("agents.model.download")} onClick={() => operation("agents.model.download", `Download ${model.title}`, modelParameters(model), `${bytes(model.preview.bytes)} from huggingface.co, every byte checked; about ${model.preview.fastMinutes} minutes on a fast connection, ${model.preview.slowMinutes} on a slow one.`)} aria-label={`Download ${model.title}`}>Download</Button>
          )}
          {model.downloaded && !model.current && may("agents.model.switch") && (
            <Button risk={riskOf("agents.model.switch")} onClick={() => operation("agents.model.switch", `Use ${model.title} for agents`, modelParameters(model), "The next run uses it. The model in use now stays downloaded, to switch back to.")} aria-label={`Use ${model.title}`}>Use</Button>
          )}
          {model.downloaded && !model.current && may("agents.model.remove") && (
            <Button risk={riskOf("agents.model.remove")} onClick={() => operation("agents.model.remove", `Remove ${model.title}`, modelParameters(model), `Frees about ${bytes(model.preview.bytes)}.`)} aria-label={`Remove ${model.title}`}>Remove</Button>
          )}
          {model.downloaded && <StatusChip status="good">downloaded</StatusChip>}
        </span>
      ),
    },
  ];

  const saveSettings = async (password: string) => {
    if (!draft) return;
    const runtimeChange = { driver: draft.driver, idleStopMinutes: Number.parseInt(draft.idleStopMinutes, 10), ...(draft.driver === "external" ? { endpoint: draft.endpoint.trim() } : {}) };
    await agentsApi.saveSettings(csrfToken, { password, quietHours: { start: draft.quietStart, end: draft.quietEnd }, notify: draft.notify, runtime: runtimeChange, embeddings: draft.embeddings, budget: { runsPerDay: Number.parseInt(draft.runsPerDay, 10), modelSecondsPerDay: Number.parseInt(draft.modelSecondsPerDay, 10) } });
    setSaved("Saved. The next run uses these settings.");
    onModuleChanged();
    await read();
  };

  return (
    <div className="agents-tab agents-usage">
      {error && <Notice tone="danger" live onDismiss={() => setError(null)}>{error}</Notice>}

      <Panel className="agents-now" title="Right now" count={{ status: verdict.status, label: verdict.label }}
        meta={usage.runner.online ? <>runner <b>{usage.runner.version ?? "?"}</b> · seen {relativeTime(usage.runner.lastSeenAt, now) ?? "just now"}</> : "the runner is not answering"} padded>
        <div className="agents-metrics">
          <MetricTile label="Processor" value={cpu === null ? "—" : `${cpu}%`} caption={`of a ${caps.cpuQuotaPercent}% cap (one processor)`} status={verdict.status} bar={cpu === null ? undefined : { value: cpu, max: caps.cpuQuotaPercent }} />
          <MetricTile label="Memory" value={live ? bytes(live.memoryBytes) : "—"} caption={`of ${gibibytes(live?.memoryMaxBytes ?? caps.memoryMaxBytes)}${live?.memoryPeakBytes ? ` · peak ${bytes(live.memoryPeakBytes)}` : ""}`}
            status={live ? (live.memoryBytes > caps.memoryMaxBytes * 0.9 ? "warning" : "good") : "unknown"} bar={live ? { value: live.memoryBytes, max: live.memoryMaxBytes ?? caps.memoryMaxBytes } : undefined} />
          <MetricTile label="Model" value={live?.modelLoaded ? "Loaded" : "Not loaded"} caption={live?.modelLoaded ? live.model ?? "" : "starts when a run needs it, stops when idle"} status={live?.modelLoaded ? "good" : "neutral"} />
          <MetricTile label="Throttled" value={live ? `${Math.round(live.throttledMs / 1000)} s` : "—"} caption="time the kernel held it to its cap" status={live ? "neutral" : "unknown"} />
        </div>
        {live && !live.cgroup && <p className="agents-dim">Measured from the runner's own process: it is not running in its capped unit.</p>}
      </Panel>

      <div className="agents-split">
        <Panel className="agents-caps" title="Hard caps" meta={<code>{caps.unit}</code>} padded
          footer="Enforced by the kernel through systemd, for the runner and its model together. CI proves them on real systemd.">
          <KeyValue layout="rows" items={[
            { id: "cpu", label: "Processor", value: `${caps.cpuQuotaPercent}% (CPUQuota)`, mono: true },
            { id: "weight", label: "Priority", value: `CPUWeight=${caps.cpuWeight} · Nice ${caps.nice}`, mono: true },
            { id: "io", label: "Disk", value: `IOSchedulingClass=${caps.ioSchedulingClass}`, mono: true },
            { id: "memory", label: "Memory", value: `${gibibytes(caps.memoryMaxBytes)} · no swap`, mono: true },
            { id: "tasks", label: "Tasks", value: String(caps.tasksMax), mono: true },
            { id: "threads", label: "Model threads", value: String(caps.modelThreads), mono: true },
            { id: "network", label: "Network", value: "this machine only", mono: true },
          ]} />
        </Panel>

        <Panel className="agents-today" title="Today" meta={<><b>{usage.today.runs}</b> runs · <b>{usage.today.modelSeconds}</b> s of model time · <b>{usage.queue.queued}</b> waiting{usage.queue.dropped ? <> · <b>{usage.queue.dropped}</b> dropped</> : null}</>} padded>
          {usage.module.budget && (
            <div className="agents-budget agents-budget--all">
              <span className="agents-budget__name">All agents</span>
              <Progress label="All agents: runs" value={usage.module.budget.runsUsed} max={usage.module.budget.runsPerDay} detail={`${usage.module.budget.runsUsed}/${usage.module.budget.runsPerDay} runs`} status={usage.module.budget.runsUsed >= usage.module.budget.runsPerDay ? "warning" : "good"} />
              <Progress label="All agents: model time" value={Math.round(usage.module.budget.modelMsUsed / 1000)} max={usage.module.budget.modelSecondsPerDay} detail={`${Math.round(usage.module.budget.modelMsUsed / 1000)}/${usage.module.budget.modelSecondsPerDay} s`} status={usage.module.budget.modelMsLeft <= 0 ? "warning" : "good"} />
            </div>
          )}
          {perAgent.length === 0 ? <p className="agents-quiet">No agents yet.</p> : (
            <ul className="agents-budgets">
              {perAgent.map((entry) => (
                <li key={entry.agentId} className="agents-budget">
                  <span className="agents-budget__name">{entry.name}</span>
                  <Progress label={`${entry.name}: runs`} value={entry.runs} max={entry.runsPerDay} detail={`${entry.runs}/${entry.runsPerDay} runs`} status={entry.runs >= entry.runsPerDay ? "warning" : "good"} />
                  <Progress label={`${entry.name}: model time`} value={entry.modelSeconds} max={entry.modelSecondsPerDay} detail={`${entry.modelSeconds}/${entry.modelSecondsPerDay} s`} status={entry.modelSeconds >= entry.modelSecondsPerDay ? "warning" : "good"} />
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>

      <Panel className="agents-runtime" title="Runtime" count={installed?.runtime?.installed ? { status: "good", label: "installed" } : installed ? { status: "neutral", label: "not installed" } : { status: "unknown", label: "not read" }}
        meta={<>{driverWords[runtime.settings.driver]}{unsloth.version ? <> · <b>{unsloth.version}</b></> : null}</>} padded
        actions={
          <span className="agents-actions">
            {installed && !installed.runtime?.installed && may("agents.runtime.install") && <Button risk={riskOf("agents.runtime.install")} onClick={() => operation("agents.runtime.install", "Install Unsloth for agents", {}, "Unsloth's own installer, GGUF only, run as the runner's user into its own folder. About 2 GB.")}>Install Unsloth</Button>}
            {service && service.active !== "active" && may("agents.runtime.enable") && module.enabled && <Button risk={riskOf("agents.runtime.enable")} onClick={() => operation("agents.runtime.enable", "Start the agents runner", {}, `${caps.unit}: one processor at most, idle priority, ${gibibytes(caps.memoryMaxBytes)}, this machine only.`)}>Start the runner</Button>}
            {service && service.active === "active" && may("agents.runtime.disable") && <Button risk={riskOf("agents.runtime.disable")} onClick={() => operation("agents.runtime.disable", "Stop the agents runner", {}, "Stops the runner and any model it runs. Agents wait until it starts again.")}>Stop the runner</Button>}
          </span>
        }>
        {unsloth.version && !unsloth.version.includes(unsloth.testedVersion) && (
          <Notice tone="warning" title={`Unsloth ${unsloth.version} is not the release BoxPilot was measured with`}>
            BoxPilot's numbers and flags come from {unsloth.testedVersion}. It still runs with its tools off and on this machine only; check a run or two before relying on it.
          </Notice>
        )}
        <KeyValue layout="columns" items={[
          { id: "unsloth", label: "Unsloth", value: installed?.runtime?.installed ? unsloth.version ?? "installed" : installed ? "not installed" : "not read", mono: true, status: installed?.runtime?.installed ? "good" : installed ? "neutral" : "unknown" },
          { id: "tested", label: "Measured with", value: unsloth.testedVersion, mono: true },
          { id: "unit", label: "Runner unit", value: service ? `${service.active}${service.enabled && service.enabled !== "unknown" ? ` · ${service.enabled}` : ""}` : "not read", mono: true, status: service ? (service.active === "active" ? "good" : service.active === "failed" ? "danger" : "neutral") : "unknown" },
          { id: "runner", label: "Runner", value: usage.runner.online ? "answering" : "not answering", mono: true, status: usage.runner.online ? "good" : module.enabled ? "warning" : "neutral" },
          { id: "model", label: "Model", value: runtime.settings.repo.replace(/^unsloth\//, ""), mono: true },
          { id: "disk", label: "Free for models", value: bytes(installed?.diskFreeBytes ?? null), mono: true },
        ]} />
      </Panel>

      {runtime.newer && (
        <Notice tone="info" title={`Unsloth published Qwen ${runtime.newer.version} at ${runtime.newer.parameters}B`}>
          A card on the Agents tab offers its download and the switch; nothing changes until you approve both. Checked {relativeTime(runtime.checkedAt, now) ?? "today"}.
        </Notice>
      )}

      <Panel className="agents-models" title="Models" count={runtime.library.length} meta="Unsloth's 4-bit Qwen 3.5 builds that read text and images">
        <Table caption="Models agents can use" columns={modelColumns} rows={runtime.library} rowKey={(model) => model.id} rowStatus={(model) => (model.current ? "good" : undefined)} />
      </Panel>

      {owner && draft && (
        <Panel className="agents-settings" title="Settings" padded
          footer={<div className="agents-editor__foot">
            {module.enabled && <Button onClick={() => setConfirm("off")}>Turn Agents off</Button>}
            <Button variant="primary" onClick={() => setConfirm("settings")}>Save settings</Button>
          </div>}>
          {saved && <Notice tone="success" live onDismiss={() => setSaved(null)}>{saved}</Notice>}
          <div className="agents-form__grid">
            <Field label="What runs the model">
              <Select value={draft.driver} onValueChange={(value) => setDraft({ ...draft, driver: value as RuntimeDriver })}
                options={(["unsloth", "llama-server", "external"] as const).map((driver) => ({ value: driver, label: driverWords[driver] }))} />
            </Field>
            {draft.driver === "external" && <Field label="Its address" hint="On this machine only"><TextInput mono value={draft.endpoint} placeholder="http://127.0.0.1:8080" onValueChange={(value) => setDraft({ ...draft, endpoint: value })} /></Field>}
            <Field label="Stop an idle model server after" hint="minutes, 5 to 720"><TextInput mono type="number" min={5} max={720} value={draft.idleStopMinutes} onValueChange={(value) => setDraft({ ...draft, idleStopMinutes: value })} /></Field>
            <Field label="Quiet hours from"><TextInput mono type="time" value={draft.quietStart} onValueChange={(value) => setDraft({ ...draft, quietStart: value })} /></Field>
            <Field label="Until"><TextInput mono type="time" value={draft.quietEnd} onValueChange={(value) => setDraft({ ...draft, quietEnd: value })} /></Field>
          </div>
          <div className="agents-form__grid">
            <Field label="Runs a day, all agents together" hint="10 to 2,000"><TextInput mono type="number" min={10} max={2000} value={draft.runsPerDay} onValueChange={(value) => setDraft({ ...draft, runsPerDay: value })} /></Field>
            <Field label="Model seconds a day, all together" hint="60 to 86,400"><TextInput mono type="number" min={60} max={86400} value={draft.modelSecondsPerDay} onValueChange={(value) => setDraft({ ...draft, modelSecondsPerDay: value })} /></Field>
          </div>
          <Switch label="Agents may tell me what is important" description="Through BoxPilot's notifications, a few times a day at most." checked={draft.notify} onChange={(checked) => setDraft({ ...draft, notify: checked })} />
          <Switch label="Search memory by meaning" description="Embeddings from the model server, made in quiet hours; off, memory is searched by words only." checked={draft.embeddings} onChange={(checked) => setDraft({ ...draft, embeddings: checked })} />
          {draft.driver === "llama-server" && <Notice tone="info">llama.cpp's own server from the Unsloth install: no Python layer and no Studio, idle at nothing, but without Unsloth's tool-call repair. It was measured for embeddings, not yet for chat.</Notice>}
        </Panel>
      )}

      {confirm === "settings" && (
        <PasswordSheet title="Save the agents' settings" confirmLabel="Save" onClose={() => setConfirm(null)} onConfirm={saveSettings}>
          <p>How agents run and where the server's facts go; it takes your password.</p>
        </PasswordSheet>
      )}
      {confirm === "off" && (
        <PasswordSheet title="Turn Agents off" confirmLabel="Turn off" onClose={() => setConfirm(null)}
          onConfirm={async (password) => { await agentsApi.saveSettings(csrfToken, { password, enabled: false }); onModuleChanged(); await read(); }}>
          <p>Nothing runs until they are on again, and the runner stops its model. Agents, their versions and their notes are kept.</p>
        </PasswordSheet>
      )}
    </div>
  );
}
