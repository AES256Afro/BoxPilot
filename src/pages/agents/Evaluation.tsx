import { useCallback, useEffect, useRef, useState } from "react";
import { relativeTime } from "../../home/format";
import { Button, EmptyState, Field, Notice, Panel, Progress, Select, StatusChip, Table, TextInput, type TableColumn } from "../../ui";
import { agentsApi, type AccuracyPoint, type AgentSummary, type Comparison, type ComparisonSide, type EvalResult, type EvalRun, type Evaluation as EvaluationState, type Question } from "./api";
import { errorText, usd } from "./format";

/*
 * Evaluation (M37, M40): questions an agent should answer right, each with what right means - a
 * fact BoxPilot reads from this server at the time (which drives, how full the root filesystem is,
 * where Pi-hole runs, which apps are stopped, the OS and its version, its name, how many apps, whether
 * Pi-hole blocks, and since M43 which apps are unhealthy or have an update and which services
 * failed) or words the answer must contain. The built-in ones come from the agent's own
 * tools; the owner adds their own, and a "wrong" on an answer can become one. BoxPilot asks them
 * every night in quiet hours, within the budgets, as the person who made the agent; "Run the
 * evaluation" asks them now, as you. Accuracy is followed over time, and a drop is flagged.
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
  { value: "drives", label: "Which drives are connected" },
  { value: "rootDiskPercent", label: "How full the root filesystem is" },
  { value: "piholePlacement", label: "Where Pi-hole runs" },
  { value: "stoppedApps", label: "Which apps are stopped" },
  { value: "operatingSystem", label: "Its operating system and version" },
  { value: "hostname", label: "Its name" },
  { value: "installedApps", label: "How many apps are installed" },
  { value: "piholeBlocking", label: "Whether Pi-hole blocks" },
  { value: "unhealthyApps", label: "Which apps are unhealthy" },
  { value: "appUpdates", label: "Which apps have an update" },
  { value: "failedServices", label: "Which system services have failed" },
];
const factLabel = (fact: string | undefined) => facts.find((entry) => entry.value === fact)?.label ?? fact ?? "";
/** A fact's value as a person reads it: the drives by device, the apps by name. */
function valueWords(value: unknown): string {
  if (value === null || value === undefined) return "not known on this server";
  if (Array.isArray(value)) {
    if (!value.length) return "none";
    return value.map((entry) => (entry && typeof entry === "object" && "device" in entry ? `${String((entry as { device: string }).device)}${(entry as { system?: boolean }).system ? " (system)" : ""}` : String(entry))).join(", ");
  }
  return String(value);
}
const percent = (score: number) => `${Math.round(score * 100)}%`;

type Draft = { id: string; question: string; kind: "fact" | "includes"; fact: string; includes: string };
const toDraft = (question: Question): Draft => ({ id: question.id, question: question.question, kind: question.expect.fact ? "fact" : "includes", fact: question.expect.fact ?? "hostname", includes: (question.expect.includes ?? []).join(", ") });
/**
 * An id no other question has, the way the server names one ("Wrong" in the Test tab). Numbering
 * from how many there were reused the id of one still there after a removal, and the two
 * questions' grades were swapped.
 */
const freshId = (drafts: Draft[]) => {
  const base = `q${Date.now().toString(36)}`;
  let id = base;
  for (let next = 2; drafts.some((draft) => draft.id === id); next += 1) id = `${base}-${next}`;
  return id;
};
const fromDraft = (draft: Draft): Question => ({ id: draft.id, question: draft.question.trim(), expect: draft.kind === "fact" ? { fact: draft.fact } : { includes: draft.includes.split(",").map((part) => part.trim()).filter(Boolean) } });

/**
 * Accuracy over time (M40): each evaluation a bar, oldest at the left, its height its score. A
 * picture of the table under it, which says the same in words for anyone who cannot see it.
 */
function AccuracyChart({ history }: { history: AccuracyPoint[] }) {
  const width = Math.max(history.length, 2) * 12;
  const height = 60;
  return (
    <svg className="agents-accuracy-chart" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" aria-hidden="true" focusable="false">
      <line className="agents-accuracy-chart__rule" x1="0" x2={width} y1={height * 0.2} y2={height * 0.2} />
      {history.map((point, index) => {
        const barHeight = Math.max(2, point.score * height);
        return <rect key={point.id} className="agents-accuracy-chart__bar" data-status={point.score >= 0.8 ? "good" : point.score >= 0.6 ? "warning" : "danger"} x={index * 12 + 2} y={height - barHeight} width={8} height={barHeight} rx={1} />;
      })}
    </svg>
  );
}

export function Evaluation({ agents, agentId, csrfToken, now, enabled, onSelectAgent, onOpenRun }: EvaluationProps) {
  const usable = agents.filter((agent) => agent.canEdit);
  const agent = usable.find((entry) => entry.id === agentId) ?? usable[0] ?? null;
  const [state, setState] = useState<EvaluationState | null>(null);
  const [drafts, setDrafts] = useState<Draft[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<"save" | "run" | "compare" | null>(null);
  const currentId = agent?.id ?? null;
  // The agent on show. A read for the one chosen before, still in flight when another was chosen
  // (the poll below keeps one in flight while an evaluation runs), used to land after the switch:
  // its questions became this agent's drafts, and Save wrote them over this agent's own.
  const shown = useRef(currentId);

  const read = useCallback(async (id: string) => {
    try {
      const next = await agentsApi.evaluation(id);
      if (shown.current !== id) return;
      setState(next);
      setDrafts((current) => current ?? next.questions.map(toDraft));
      setError(null);
    } catch (requestError) {
      if (shown.current === id) setError(errorText(requestError, "The evaluation could not be read"));
    }
  }, []);
  useEffect(() => { shown.current = currentId; setState(null); setDrafts(null); if (currentId) void read(currentId); }, [currentId, read]);
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
      : <Panel title="Questions" padded><p className="agents-quiet">Reading…</p></Panel>;
  }

  const builtIn = state.builtIn ?? [];
  const history = state.history ?? [];
  const drop = state.drop ?? null;
  const people = state.people ?? [];
  const peopleUp = people.reduce((sum, day) => sum + day.up, 0);
  const peopleDown = people.reduce((sum, day) => sum + day.down, 0);
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
  const run = async (compare = false) => {
    setBusy(compare ? "compare" : "run");
    try {
      await agentsApi.runEvaluation(csrfToken, agent.id, compare);
      setNotice(compare ? "The comparison is running: each question is asked on the local model and on Claude, as you." : "The evaluation is running: each question is asked in turn, as you.");
      setError(null);
      await read(agent.id);
    } catch (requestError) { setError(errorText(requestError, "The evaluation could not start")); } finally { setBusy(null); }
  };

  const resultColumns: Array<TableColumn<EvalResult>> = [
    { id: "question", header: "Question", cell: (result) => <span className="agents-name"><span>{result.question}</span><span className="agents-name__purpose">{result.expected.fact ? `${factLabel(result.expected.fact)}: ${valueWords(result.expected.value)}` : `contains ${(result.expected.includes ?? []).join(", ")}`}</span></span> },
    { id: "found", header: "Found", hideOnPhone: true, cell: (result) => <span className="agents-dim">{result.found ?? "—"}</span> },
    { id: "passed", header: "Right?", label: "Verdict", cell: (result) => (result.skipped ? <StatusChip status="neutral">not graded</StatusChip> : result.passed === null ? <StatusChip status="neutral">waiting</StatusChip> : <StatusChip status={result.passed ? "good" : "danger"}>{result.passed ? "right" : "wrong"}</StatusChip>) },
    { id: "open", header: <span className="ui-visually-hidden">Open</span>, label: "Actions", className: "agents-actions-cell", cell: (result) => (result.runId ? <Button variant="ghost" onClick={() => onOpenRun(agent.id, result.runId!)} aria-label="Open this answer">Open</Button> : null) },
  ];
  const score = (entry: EvalRun) => (entry.score === null ? "—" : percent(entry.score));
  const passed = latest ? latest.results.filter((result) => result.passed).length : 0;
  // A nightly question never asked - the night's model time could not pay for it (sweep 3), it
  // waited too long or its agent was paused (sweep 4) - is not graded, nor counted; its row says why.
  const graded = latest ? latest.results.filter((result) => !result.skipped).length : 0;
  const skipped = latest ? latest.results.length - graded : 0;
  const quiet = state.nightly?.quietHours;

  return (
    <div className="agents-tab agents-evaluation">
      {error && <Notice tone="danger" live onDismiss={() => setError(null)}>{error}</Notice>}
      {notice && <Notice tone="success" live onDismiss={() => setNotice(null)}>{notice}</Notice>}
      {drop && (
        <Notice tone="warning" title={`Accuracy dropped to ${percent(drop.to)}`}>
          The evaluation {relativeTime(drop.at, now) ?? "just now"} scored {percent(drop.to)}, against {percent(drop.from)} before.
          {drop.version !== drop.previousVersion ? ` Its instructions changed in between (v${drop.previousVersion} to v${drop.version}): compare them on the Build tab.` : ""}
          {drop.model !== drop.previousModel ? ` The model changed in between (${(drop.previousModel ?? "—").replace(/^unsloth\//, "")} to ${(drop.model ?? "—").replace(/^unsloth\//, "")}).` : ""}
          {drop.version === drop.previousVersion && drop.model === drop.previousModel ? " Nothing about the agent changed: open the wrong answers below to see what the server said." : ""}
        </Notice>
      )}

      {(state.comparisons?.length ?? 0) > 0 && <Comparisons comparisons={state.comparisons!} now={now} nightly={state.nightly?.compare === true} />}

      {(state.successCriteria?.length ?? 0) > 0 && (
        <Panel className="agents-criteria" title="It did its job when" count={state.successCriteria!.length} padded meta="from the Build tab: write a question for each">
          <ul className="agents-criteria__list">{state.successCriteria!.map((line, index) => <li key={index}>{line}</li>)}</ul>
        </Panel>
      )}

      <Panel className="agents-builtin" title="Built-in questions" count={builtIn.length} padded
        meta={quiet ? <>asked every night, {quiet.start} to {quiet.end}, with yours</> : undefined}>
        {builtIn.length === 0
          ? <p className="agents-quiet">None: this agent uses none of the tools they ask about (drives, where something runs, apps, the server's facts). Your own questions below are its evaluation.</p>
          : <ul className="agents-builtin__list">
              {builtIn.map((question) => (
                <li key={question.id} className="agents-builtin__item">
                  <span className="agents-name"><span>{question.question}</span><span className="agents-name__purpose">Right means: {factLabel(question.expect.fact).toLowerCase()}, as BoxPilot reads it then{question.tool ? ` · answered with ${question.tool}` : ""}</span></span>
                </li>
              ))}
            </ul>}
        <p className="agents-quiet">BoxPilot asks every question once a night in quiet hours, as the person who made the agent, when today's model time has room for them and still keeps half of it for people. The answers count toward the day's budget like any run.</p>
      </Panel>

      <Panel className="agents-questions" title="Your questions" count={drafts.length}
        actions={<Select aria-label="Which agent" value={agent.id} onValueChange={onSelectAgent} options={usable.map((entry) => ({ value: entry.id, label: entry.name }))} />}
        footer={state.canEdit ? (
          <div className="agents-editor__foot">
            <Button variant="ghost" disabled={drafts.length >= 10} onClick={() => setDrafts([...drafts, { id: freshId(drafts), question: "", kind: "includes", fact: "drives", includes: "" }])}>Add a question</Button>
            <Button busy={busy === "save"} onClick={() => void save()}>Save the questions</Button>
            <Button variant="primary" busy={busy === "run"} disabled={!enabled || !(state.questions.length + builtIn.length) || latest?.state === "running"} onClick={() => void run()}>Run the evaluation now</Button>
            {state.canCompare && <Button busy={busy === "compare"} disabled={!enabled || !(state.questions.length + builtIn.length) || latest?.state === "running"} onClick={() => void run(true)}>Compare with Claude</Button>}
          </div>
        ) : undefined} padded>
        {drafts.length === 0 ? <EmptyState title="None of your own yet">Add up to ten, each with the answer you expect: a fact BoxPilot reads, or words a right answer holds. Saying "Wrong" on an answer in the Test tab can add one too.</EmptyState> : (
          <ol className="agents-questions__list">
            {drafts.map((draft, index) => (
              <li key={`${draft.id}-${index}`} className="agents-question">
                <Field label={`Question ${index + 1}`}><TextInput value={draft.question} maxLength={300} disabled={!state.canEdit} onValueChange={(value) => update(index, { question: value })} /></Field>
                <Field label="Right means">
                  <Select value={draft.kind === "fact" ? draft.fact : "includes"} disabled={!state.canEdit} onValueChange={(value) => update(index, value === "includes" ? { kind: "includes" } : { kind: "fact", fact: value })}
                    options={[{ value: "includes", label: "The answer holds these words" }, ...facts.map((fact) => ({ value: fact.value, label: `The answer says ${fact.label.toLowerCase()}` }))]} />
                </Field>
                {draft.kind === "includes" && <Field label="Expected answer" hint="Words a right answer holds, separated by commas"><TextInput value={draft.includes} disabled={!state.canEdit} onValueChange={(value) => update(index, { includes: value })} /></Field>}
                {state.canEdit && <Button variant="ghost" className="agents-question__remove" onClick={() => setDrafts(drafts.filter((_, at) => at !== index))} aria-label={`Remove question ${index + 1}`}>Remove</Button>}
              </li>
            ))}
          </ol>
        )}
      </Panel>

      <Panel className="agents-result" title="Latest result" count={latest ? { status: latest.state === "running" ? "neutral" : (latest.score ?? 0) >= 0.8 ? "good" : "warning", label: latest.state === "running" ? "running" : score(latest) } : undefined}
        meta={latest ? <>v{latest.version} · <b>{passed}</b> of {graded} right{skipped ? ` · ${skipped} not graded` : ""} · {latest.createdBy === null ? "nightly" : "asked by a person"} · {relativeTime(latest.finishedAt ?? latest.createdAt, now) ?? ""}</> : undefined}>
        <Table caption="The latest evaluation's answers" columns={resultColumns} rows={latest?.results ?? []} rowKey={(result) => result.questionId}
          rowStatus={(result) => (result.passed === false ? "danger" : undefined)}
          empty={<EmptyState title="Not run yet">It runs tonight in quiet hours, or now with "Run the evaluation now".</EmptyState>} />
      </Panel>

      {history.length > 0 && (
        <Panel className="agents-accuracy" title="Accuracy over time" count={history.length}
          meta={<>each evaluation, oldest first{people.length ? <> · people said <b>{peopleUp}</b> right and <b>{peopleDown}</b> wrong this month</> : null}</>}>
          <div className="agents-accuracy__chart">
            <AccuracyChart history={history} />
            <span className="agents-dim">{history.length === 1 ? `One evaluation: ${percent(history[0].score)}.` : `From ${percent(history[0].score)} to ${percent(history.at(-1)!.score)} over ${history.length} evaluations.`}</span>
          </div>
          <Table caption="Each evaluation's score" rows={[...history].reverse().slice(0, 14)} rowKey={(entry) => entry.id}
            rowStatus={(entry) => (drop?.evalId === entry.id ? "warning" : undefined)}
            columns={[
              { id: "when", header: "When", cell: (entry) => <span className="agents-dim">{relativeTime(entry.at, now) ?? entry.at.slice(0, 10)}</span> },
              { id: "score", header: "Score", cell: (entry) => <span className="agents-accuracy__score"><Progress label={`${entry.at.slice(0, 10)}: score`} hideLabel value={Math.round(entry.score * 100)} max={100} status={entry.score >= 0.8 ? "good" : "warning"} /><span className="agents-mono">{percent(entry.score)} · {entry.right}/{entry.questions}{entry.skipped ? ` · ${entry.skipped} not graded` : ""}</span></span> },
              { id: "version", header: "Version", hideOnPhone: true, cell: (entry) => <span className="agents-mono">v{entry.version}{entry.nightly ? " · nightly" : ""}</span> },
              { id: "model", header: "Model", hideOnPhone: true, cell: (entry) => <span className="agents-mono">{(entry.model ?? "—").replace(/^unsloth\//, "")}</span> },
            ]} />
        </Panel>
      )}

      {(state.accuracy?.length ?? 0) > 0 && (
        <Panel className="agents-accuracy-versions" title="By version and model" count={state.accuracy!.length} meta="the evaluations' average and people's verdicts">
          <Table caption="Accuracy by version and model" rows={state.accuracy!} rowKey={(entry) => `${entry.version}|${entry.model ?? ""}`}
            rowStatus={(entry) => (entry.score !== null && entry.score < 0.6 ? "warning" : undefined)}
            columns={[
              { id: "version", header: "Version", cell: (entry) => <span className="agents-mono">v{entry.version}</span> },
              { id: "model", header: "Model", hideOnPhone: true, cell: (entry) => <span className="agents-mono">{(entry.model ?? "—").replace(/^unsloth\//, "")}</span> },
              { id: "score", header: "Questions", cell: (entry) => (entry.score === null ? <span className="agents-dim">not run</span> : <span className="agents-mono">{percent(entry.score)} · {entry.evaluations} {entry.evaluations === 1 ? "run" : "runs"}</span>) },
              { id: "people", header: "People said", cell: (entry) => <span className="agents-mono">{entry.up} right · {entry.down} wrong</span> },
            ]} />
        </Panel>
      )}
    </div>
  );
}

/** One side of a comparison as a cell: right of asked, seconds a question, and what it cost. */
function Side({ side, dollars }: { side: ComparisonSide | null; dollars: boolean }) {
  if (!side) return <span className="agents-dim">—</span>;
  if (side.state === "running") return <StatusChip status="neutral">asking</StatusChip>;
  return (
    <span className="agents-name">
      <span>{side.right} of {side.questions} right{side.score !== null ? ` (${Math.round(side.score * 100)}%)` : ""}</span>
      <span className="agents-name__purpose">
        {side.seconds !== null ? `${side.seconds} s a question` : "—"}{dollars ? ` · ${usd(side.dollars)}` : ""}{side.ranLocally ? ` · ${side.ranLocally} ran locally: Claude could not take them` : ""}
      </span>
    </span>
  );
}

/**
 * The routes side by side (M45.7): the same questions on this server's model and on Claude, each
 * graded the same way, with how long a question took and what Claude cost. Started with "Compare
 * with Claude", or each night when the owner turned that on with the other agent settings.
 */
export function Comparisons({ comparisons, now, nightly }: { comparisons: Comparison[]; now: number; nightly: boolean }) {
  const columns: Array<TableColumn<Comparison>> = [
    { id: "when", header: "When", cell: (entry) => <span className="agents-dim">{relativeTime(entry.at, now) ?? entry.at.slice(0, 10)}{entry.nightly ? " · nightly" : ""}</span> },
    { id: "local", header: "This server's model", cell: (entry) => <Side side={entry.local} dollars={false} /> },
    { id: "claude", header: "Claude", cell: (entry) => <Side side={entry.claude} dollars /> },
  ];
  return (
    <Panel className="agents-comparisons" title="Local and Claude, side by side" count={comparisons.length} meta={nightly ? "compared every night" : "compared when you ask"}>
      <Table caption="Each comparison: the same questions on both models" columns={columns} rows={comparisons} rowKey={(entry) => entry.pairId} />
    </Panel>
  );
}
