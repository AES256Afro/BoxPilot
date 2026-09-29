import { useCallback, useEffect, useState } from "react";
import { relativeTime } from "../../home/format";
import { Button, EmptyState, Field, Notice, Panel, Progress, Select, StatusChip, Table, TextInput, type TableColumn } from "../../ui";
import { agentsApi, type AgentSummary, type EvalResult, type EvalRun, type Evaluation as EvaluationState, type Question } from "./api";
import { errorText } from "./format";

/*
 * Evaluation (M37): golden questions an agent should answer right, each with what right means -
 * a fact BoxPilot reads from this server at the time (its name, its system, how many apps, how full
 * the system disk is, where Pi-hole runs and whether it blocks) or words the answer must contain.
 * Running it asks every question as the person who pressed the button and scores the answers, so a
 * change to the instructions or a new model can be checked before it is trusted. Once an hour at
 * most.
 */

export interface EvaluationProps {
  agents: AgentSummary[];
  agentId: string | null;
  csrfToken: string;
  now: number;
  enabled: boolean;
  onSelectAgent: (agentId: string) => void;
  onOpenRun: (agentId: string, runId: string) => void;
}

const facts: Array<{ value: string; label: string }> = [
  { value: "hostname", label: "Its name" },
  { value: "operatingSystem", label: "Its operating system" },
  { value: "installedApps", label: "How many apps are installed" },
  { value: "rootDiskPercent", label: "How full the system disk is" },
  { value: "piholePlacement", label: "Where Pi-hole runs" },
  { value: "piholeBlocking", label: "Whether Pi-hole blocks" },
];
const factLabel = (fact: string | undefined) => facts.find((entry) => entry.value === fact)?.label ?? fact ?? "";

type Draft = { id: string; question: string; kind: "fact" | "includes"; fact: string; includes: string };
const toDraft = (question: Question): Draft => ({ id: question.id, question: question.question, kind: question.expect.fact ? "fact" : "includes", fact: question.expect.fact ?? "hostname", includes: (question.expect.includes ?? []).join(", ") });
const fromDraft = (draft: Draft): Question => ({ id: draft.id, question: draft.question.trim(), expect: draft.kind === "fact" ? { fact: draft.fact } : { includes: draft.includes.split(",").map((part) => part.trim()).filter(Boolean) } });

export function Evaluation({ agents, agentId, csrfToken, now, enabled, onSelectAgent, onOpenRun }: EvaluationProps) {
  const usable = agents.filter((agent) => agent.canEdit);
  const agent = usable.find((entry) => entry.id === agentId) ?? usable[0] ?? null;
  const [state, setState] = useState<EvaluationState | null>(null);
  const [drafts, setDrafts] = useState<Draft[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<"save" | "run" | null>(null);
  const currentId = agent?.id ?? null;

  const read = useCallback(async (id: string) => {
    try {
      const next = await agentsApi.evaluation(id);
      setState(next);
      setDrafts((current) => current ?? next.questions.map(toDraft));
      setError(null);
    } catch (requestError) {
      setError(errorText(requestError, "The evaluation could not be read"));
    }
  }, []);
  useEffect(() => { setState(null); setDrafts(null); if (currentId) void read(currentId); }, [currentId, read]);
  // While an evaluation runs, read it again every few seconds until every answer is scored.
  const latest = state?.runs[0] ?? null;
  useEffect(() => {
    if (!currentId || latest?.state !== "running") return undefined;
    const timer = setTimeout(() => void read(currentId), 3_000);
    return () => clearTimeout(timer);
  }, [currentId, latest, read]);

  if (!agent) return <Panel title="Evaluation" padded><EmptyState title="No agent to evaluate">Evaluations are for agents you may change.</EmptyState></Panel>;
  if (!state || !drafts) {
    return error
      ? <Notice tone="danger" live title="The evaluation could not be read" action={<Button onClick={() => void read(agent.id)}>Try again</Button>}>{error}</Notice>
      : <Panel title="Golden questions" padded><p className="agents-quiet">Reading…</p></Panel>;
  }

  const update = (index: number, change: Partial<Draft>) => setDrafts(drafts.map((draft, at) => (at === index ? { ...draft, ...change } : draft)));
  const save = async () => {
    setBusy("save");
    try {
      const next = await agentsApi.saveEvaluation(csrfToken, agent.id, drafts.map(fromDraft));
      setState(next);
      setDrafts(next.questions.map(toDraft));
      setNotice("The questions are saved.");
      setError(null);
    } catch (requestError) { setError(errorText(requestError, "The questions could not be saved")); } finally { setBusy(null); }
  };
  const run = async () => {
    setBusy("run");
    try {
      await agentsApi.runEvaluation(csrfToken, agent.id);
      setNotice("The evaluation is running: each question is asked in turn, as you.");
      setError(null);
      await read(agent.id);
    } catch (requestError) { setError(errorText(requestError, "The evaluation could not start")); } finally { setBusy(null); }
  };

  const resultColumns: Array<TableColumn<EvalResult>> = [
    { id: "question", header: "Question", cell: (result) => <span className="agents-name"><span>{result.question}</span><span className="agents-name__purpose">{result.expected.fact ? `${factLabel(result.expected.fact)}: ${result.expected.value ?? "not known on this server"}` : `contains ${(result.expected.includes ?? []).join(", ")}`}</span></span> },
    { id: "found", header: "Found", hideOnPhone: true, cell: (result) => <span className="agents-dim">{result.found ?? "—"}</span> },
    { id: "passed", header: "Right?", label: "Verdict", cell: (result) => (result.passed === null ? <StatusChip status="neutral">waiting</StatusChip> : <StatusChip status={result.passed ? "good" : "danger"}>{result.passed ? "right" : "wrong"}</StatusChip>) },
    { id: "open", header: <span className="ui-visually-hidden">Open</span>, label: "Actions", className: "agents-actions-cell", cell: (result) => (result.runId ? <Button variant="ghost" onClick={() => onOpenRun(agent.id, result.runId!)} aria-label="Open this answer">Open</Button> : null) },
  ];
  const score = (entry: EvalRun) => (entry.score === null ? "—" : `${Math.round(entry.score * 100)}%`);
  const passed = latest ? latest.results.filter((result) => result.passed).length : 0;

  return (
    <div className="agents-tab agents-evaluation">
      {error && <Notice tone="danger" live onDismiss={() => setError(null)}>{error}</Notice>}
      {notice && <Notice tone="success" live onDismiss={() => setNotice(null)}>{notice}</Notice>}

      {(state.successCriteria?.length ?? 0) > 0 && (
        <Panel className="agents-criteria" title="It did its job when" count={state.successCriteria!.length} padded meta="from the Build tab: write a question for each">
          <ul className="agents-criteria__list">{state.successCriteria!.map((line, index) => <li key={index}>{line}</li>)}</ul>
        </Panel>
      )}

      <Panel className="agents-questions" title="Golden questions" count={drafts.length}
        actions={<Select aria-label="Which agent" value={agent.id} onValueChange={onSelectAgent} options={usable.map((entry) => ({ value: entry.id, label: entry.name }))} />}
        footer={state.canEdit ? (
          <div className="agents-editor__foot">
            <Button variant="ghost" disabled={drafts.length >= 10} onClick={() => setDrafts([...drafts, { id: `q${drafts.length + 1}`, question: "", kind: "fact", fact: "hostname", includes: "" }])}>Add a question</Button>
            <Button busy={busy === "save"} onClick={() => void save()}>Save the questions</Button>
            <Button variant="primary" busy={busy === "run"} disabled={!enabled || !state.questions.length || latest?.state === "running"} onClick={() => void run()}>Run the evaluation</Button>
          </div>
        ) : undefined} padded>
        {drafts.length === 0 ? <EmptyState title="No questions yet">Add up to ten, each with what a right answer holds.</EmptyState> : (
          <ol className="agents-questions__list">
            {drafts.map((draft, index) => (
              <li key={`${draft.id}-${index}`} className="agents-question">
                <Field label={`Question ${index + 1}`}><TextInput value={draft.question} maxLength={300} disabled={!state.canEdit} onValueChange={(value) => update(index, { question: value })} /></Field>
                <Field label="Right means">
                  <Select value={draft.kind === "fact" ? draft.fact : "includes"} disabled={!state.canEdit} onValueChange={(value) => update(index, value === "includes" ? { kind: "includes" } : { kind: "fact", fact: value })}
                    options={[...facts.map((fact) => ({ value: fact.value, label: `The answer says ${fact.label.toLowerCase()}` })), { value: "includes", label: "The answer contains these words" }]} />
                </Field>
                {draft.kind === "includes" && <Field label="Words" hint="Separated by commas"><TextInput value={draft.includes} disabled={!state.canEdit} onValueChange={(value) => update(index, { includes: value })} /></Field>}
                {state.canEdit && <Button variant="ghost" className="agents-question__remove" onClick={() => setDrafts(drafts.filter((_, at) => at !== index))} aria-label={`Remove question ${index + 1}`}>Remove</Button>}
              </li>
            ))}
          </ol>
        )}
      </Panel>

      <Panel className="agents-result" title="Latest result" count={latest ? { status: latest.state === "running" ? "neutral" : (latest.score ?? 0) >= 0.8 ? "good" : "warning", label: latest.state === "running" ? "running" : score(latest) } : undefined}
        meta={latest ? <>v{latest.version} · <b>{passed}</b> of {latest.results.length} right · {relativeTime(latest.finishedAt ?? latest.createdAt, now) ?? ""}</> : undefined}>
        <Table caption="The latest evaluation's answers" columns={resultColumns} rows={latest?.results ?? []} rowKey={(result) => result.questionId}
          rowStatus={(result) => (result.passed === false ? "danger" : undefined)}
          empty={<EmptyState title="Not run yet">Run the evaluation to score this version.</EmptyState>} />
      </Panel>

      {(state.accuracy?.length ?? 0) > 0 && (
        <Panel className="agents-accuracy" title="Accuracy over time" count={state.accuracy!.length} meta="by version and model: the golden questions and people's verdicts">
          <Table caption="Accuracy by version and model" rows={state.accuracy!} rowKey={(entry) => `${entry.version}|${entry.model ?? ""}`}
            rowStatus={(entry) => (entry.score !== null && entry.score < 0.6 ? "warning" : undefined)}
            columns={[
              { id: "version", header: "Version", cell: (entry) => <span className="agents-mono">v{entry.version}</span> },
              { id: "model", header: "Model", hideOnPhone: true, cell: (entry) => <span className="agents-mono">{(entry.model ?? "—").replace(/^unsloth\//, "")}</span> },
              { id: "score", header: "Golden questions", cell: (entry) => (entry.score === null ? <span className="agents-dim">not run</span> : <span className="agents-accuracy__score"><Progress label={`Version ${entry.version}: score`} hideLabel value={Math.round(entry.score * 100)} max={100} status={entry.score >= 0.8 ? "good" : "warning"} /><span className="agents-mono">{Math.round(entry.score * 100)}% · {entry.evaluations} {entry.evaluations === 1 ? "run" : "runs"}</span></span>) },
              { id: "people", header: "People said", cell: (entry) => <span className="agents-mono">{entry.up} right · {entry.down} wrong</span> },
            ]} />
        </Panel>
      )}

      {state.runs.length > 1 && (
        <Panel className="agents-evals" title="Earlier evaluations" count={state.runs.length - 1}>
          <Table caption="Earlier evaluations" rows={state.runs.slice(1)} rowKey={(entry) => entry.id}
            columns={[
              { id: "version", header: "Version", cell: (entry) => <span className="agents-mono">v{entry.version}</span> },
              { id: "score", header: "Score", cell: (entry) => <span className="agents-mono">{score(entry)}</span> },
              { id: "when", header: "When", cell: (entry) => <span className="agents-dim">{relativeTime(entry.createdAt, now) ?? ""}</span> },
            ]} />
        </Panel>
      )}
    </div>
  );
}
