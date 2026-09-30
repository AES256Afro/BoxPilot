import { useCallback, useEffect, useRef, useState } from "react";
import type { PendingOperation } from "../../shell/ApproveDialog";
import { relativeTime } from "../../home/format";
import { Button, EmptyState, Field, Notice, Panel, Select, StatusChip, Table, TextInput, Textarea, type TableColumn } from "../../ui";
import { agentsApi, followRun, type AgentSummary, type Proposal, type Run } from "./api";
import { errorText, finishedRunStates, kindWords, runState, seconds, waitingWords } from "./format";
import type { RunnerWait } from "./setup";
import { ProposalCard } from "./ProposalCard";
import { RunView } from "./Trace";

/*
 * The test console (M37): ask an agent something, or run its routine once, and watch it work - the
 * trace arrives step by step as it happens - then read its answer and the cards it proposed, whose
 * steps are staged like any other. A viewer asks the agents that take their questions; the owner
 * and operators run any agent they may, as themselves. Earlier runs open here too.
 */

export interface ConsoleProps {
  agents: AgentSummary[];
  agentId: string | null;
  runId: string | null;
  csrfToken: string;
  role: string;
  now: number;
  enabled: boolean;
  /** Set while Agents are on and the runner is not answering. */
  runnerWait?: RunnerWait | null;
  onSelectAgent: (agentId: string) => void;
  onStage: (operation: PendingOperation) => void;
  onRunFinished: () => void;
}

/** "Was this right?": one person's verdict on an answer, which the evaluation counts. */
function Feedback({ run, csrfToken, onGiven }: { run: Run; csrfToken: string; onGiven: (feedback: NonNullable<Run["feedback"]>) => void }) {
  const [note, setNote] = useState("");
  const [wrong, setWrong] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const give = async (verdict: "up" | "down") => {
    try { onGiven(await agentsApi.feedback(csrfToken, run.id, verdict, verdict === "down" ? note : undefined)); setError(null); setWrong(false); } catch (requestError) { setError(errorText(requestError, "That was not saved")); }
  };
  return (
    <div className="agents-feedback" role="group" aria-label="Was this right?">
      <span className="agents-feedback__ask">Was this right?</span>
      {run.feedback?.mine && <StatusChip status={run.feedback.verdict === "up" ? "good" : "warning"}>{run.feedback.verdict === "up" ? "you said right" : "you said wrong"}</StatusChip>}
      <Button variant={run.feedback?.mine && run.feedback.verdict === "up" ? "secondary" : "ghost"} onClick={() => void give("up")} aria-pressed={run.feedback?.mine && run.feedback.verdict === "up"}>Right</Button>
      <Button variant={run.feedback?.mine && run.feedback.verdict === "down" ? "secondary" : "ghost"} onClick={() => setWrong(true)} aria-pressed={run.feedback?.mine && run.feedback.verdict === "down"}>Wrong</Button>
      {wrong && (
        <span className="agents-feedback__note">
          <TextInput aria-label="What was wrong" value={note} maxLength={300} placeholder="What was wrong (optional)" onValueChange={setNote} />
          <Button onClick={() => void give("down")}>Send</Button>
        </span>
      )}
      {error && <Notice tone="danger" live>{error}</Notice>}
    </div>
  );
}

export function Console({ agents, agentId, runId, csrfToken, role, now, enabled, runnerWait = null, onSelectAgent, onStage, onRunFinished }: ConsoleProps) {
  const staff = role === "owner" || role === "operator";
  const usable = agents.filter((agent) => agent.canAsk || (staff && agent.canEdit) || (staff && role === "owner"));
  const agent = usable.find((entry) => entry.id === agentId) ?? usable[0] ?? null;
  const [question, setQuestion] = useState("");
  const [run, setRun] = useState<Run | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [history, setHistory] = useState<Run[] | null>(null);
  const stopFollowing = useRef<(() => void) | null>(null);
  // The page hands a new callback on every render; following a run must not restart because of it,
  // or the page's chosen run snaps back over the one opened from Earlier runs.
  const finishedCallback = useRef(onRunFinished);
  useEffect(() => { finishedCallback.current = onRunFinished; }, [onRunFinished]);

  // Which agent's runs the list is for: an answer for the agent chosen before is dropped, or it would
  // list that agent's runs under this one's name, and open its latest run here.
  const historyFor = useRef<string | null>(null);
  const readHistory = useCallback(async (id: string) => {
    historyFor.current = id;
    if (!staff) { setHistory([]); return; }
    try {
      const { runs } = await agentsApi.runs(id);
      if (historyFor.current === id) setHistory(runs);
    } catch { if (historyFor.current === id) setHistory(null); }
  }, [staff]);

  const follow = useCallback((id: string) => {
    stopFollowing.current?.();
    stopFollowing.current = followRun(id, (event) => {
      if (event.event === "snapshot") {
        setRun(event.data);
        if (finishedRunStates.has(event.data.state)) finishedCallback.current();
      } else if (event.event === "step") {
        setRun((current) => (current ? { ...current, steps: [...(current.steps ?? []).filter((step) => step.seq !== event.data.seq), event.data] } : current));
      } else if (event.event === "state") {
        setRun((current) => (current ? { ...current, state: event.data.state } : current));
      }
    });
  }, []);
  useEffect(() => () => stopFollowing.current?.(), []);

  const currentId = agent?.id ?? null;
  useEffect(() => { if (currentId) { setHistory(null); void readHistory(currentId); } }, [currentId, readHistory]);
  useEffect(() => { if (runId) follow(runId); }, [runId, follow]);
  // With nothing chosen, the agent's latest run opens, so the console never starts blank: once for
  // each agent chosen. It used to follow the latest again whenever the run on show was another
  // agent's, so opening a delegate's run from "One request, N runs" snapped straight back.
  const latest = history?.[0] && history[0].agentId === currentId ? history[0].id : null;
  const showing = run?.agentId ?? null;
  const openedLatestFor = useRef<string | null>(null);
  useEffect(() => {
    if (runId || !latest || !currentId || openedLatestFor.current === currentId) return;
    openedLatestFor.current = currentId;
    if (showing !== currentId) follow(latest);
  }, [runId, latest, showing, currentId, follow]);

  const start = async (kind: "ask" | "test") => {
    if (!agent) return;
    setBusy(true);
    try {
      const text = question.trim() || null;
      const started = kind === "ask" ? await agentsApi.ask(csrfToken, agent.id, text ?? "") : await agentsApi.test(csrfToken, agent.id, text);
      setRun(started);
      setError(null);
      follow(started.id);
      void readHistory(agent.id);
    } catch (requestError) {
      setError(errorText(requestError, "The run could not start"));
    } finally {
      setBusy(false);
    }
  };
  const cancel = async () => {
    if (!run) return;
    try { setRun(await agentsApi.cancel(csrfToken, run.id)); } catch (requestError) { setError(errorText(requestError, "The run could not be stopped")); }
  };
  // Opening an earlier run shows it in the Run panel above, which is out of sight from the list.
  const open = (id: string) => {
    follow(id);
    const reduced = typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    document.getElementById("agents-run")?.scrollIntoView?.({ behavior: reduced ? "auto" : "smooth", block: "start" });
  };
  const decided = (proposal: Proposal) => setRun((current) => (current ? { ...current, proposals: current.proposals.map((entry) => (entry.id === proposal.id ? proposal : entry)) } : current));

  if (!agent) {
    return <Panel title="Test" padded><EmptyState title={staff ? "No agent to test yet" : "No agent takes your questions yet"}>{staff ? "Make one from a template on the Build tab." : "The owner decides which agents viewers may ask."}</EmptyState></Panel>;
  }
  const running = run !== null && !finishedRunStates.has(run.state);
  const mayTest = staff && (agent.canEdit || role === "owner");

  const columns: Array<TableColumn<Run>> = [
    { id: "state", header: "Outcome", cell: (entry) => <StatusChip status={runState(entry.state).status}>{runState(entry.state).label}</StatusChip> },
    { id: "what", header: "Asked or started by", cell: (entry) => <span className="agents-name"><span>{entry.question ?? entry.trigger?.title ?? kindWords[entry.kind]}</span><span className="agents-name__purpose">{kindWords[entry.kind]} · read as {entry.readRole}</span></span> },
    { id: "when", header: "When", hideOnPhone: true, cell: (entry) => <span className="agents-dim">{relativeTime(entry.finishedAt ?? entry.queuedAt, now) ?? ""}</span> },
    { id: "took", header: "Model", hideOnPhone: true, cell: (entry) => <span className="agents-mono">{seconds(entry.usage?.modelMs ?? null)}</span> },
    { id: "open", header: <span className="ui-visually-hidden">Open</span>, label: "Actions", className: "agents-actions-cell", cell: (entry) => (entry.id === run?.id
      ? <Button variant="secondary" onClick={() => open(entry.id)} aria-current="true" aria-label="Showing this run above">Showing</Button>
      : <Button variant="ghost" onClick={() => open(entry.id)} aria-label="Open this run">Open</Button>) },
  ];

  return (
    <div className="agents-console">
      <Panel className="agents-ask" title={staff ? "Ask or run" : "Ask"} padded meta={agent.purpose}>
        <div className="agents-ask__form">
          <Field label="Agent">
            <Select value={agent.id} onValueChange={onSelectAgent} options={usable.map((entry) => ({ value: entry.id, label: entry.name }))} />
          </Field>
          <Field label="Question" hint={mayTest ? "Leave it empty to run its routine once: the digest, the check, whatever it does on its schedule." : undefined}>
            <Textarea rows={3} maxLength={2000} value={question} placeholder={agent.name === "Pi-hole Watcher" ? "Is Pi-hole blocking, and are its lists fresh?" : "What runs on this server, and is anything failing?"} onValueChange={setQuestion} />
          </Field>
          <div className="agents-ask__actions">
            {agent.canAsk && <Button variant="primary" busy={busy} disabled={!enabled || !question.trim() || running} onClick={() => void start("ask")}>Ask</Button>}
            {mayTest && <Button variant={agent.canAsk ? "secondary" : "primary"} busy={busy} disabled={!enabled || running} onClick={() => void start("test")}>{question.trim() ? "Run with this question" : "Run once"}</Button>}
            {running && <Button variant="ghost" onClick={() => void cancel()}>Stop</Button>}
          </div>
          {!enabled && <Notice tone="info">Agents are off, so nothing runs. The owner turns them on at the top of this page.</Notice>}
          {error && <Notice tone="danger" live>{error}</Notice>}
        </div>
      </Panel>

      <Panel id="agents-run" className="agents-live" title="Run" count={run ? { status: runState(run.state).status, label: runState(run.state).label } : undefined}
        meta={run ? <>{run.agentName} · {relativeTime(run.startedAt ?? run.queuedAt, now) ?? "just now"}{running ? " · live" : ""}</> : undefined} padded>
        {!run
          ? <p className="agents-quiet">Ask something or run the agent once, and each step shows here as it happens.</p>
          : <>
              {run.state === "queued" && (runnerWait
                ? <Notice tone="warning" title={runnerWait.words} action={runnerWait.action ?? undefined}>It starts as soon as the runner does.</Notice>
                : <p className="agents-quiet" role="status">{waitingWords(true)}</p>)}
              {run.tree && run.tree.length > 1 && (
                <nav className="agents-tree" aria-label="This request's runs">
                  <span className="agents-step__label">One request, {run.tree.length} runs</span>
                  <ol>
                    {run.tree.map((entry) => (
                      <li key={entry.id} className="agents-tree__item" data-depth={Math.min(entry.depth, 3)} data-current={entry.id === run.id}>
                        <button type="button" className="agents-link" aria-current={entry.id === run.id ? "true" : undefined} onClick={() => follow(entry.id)}>{entry.agentName}</button>
                        <span className="agents-dim"> {kindWords[entry.kind]}</span>
                        <StatusChip status={runState(entry.state).status}>{runState(entry.state).label}</StatusChip>
                      </li>
                    ))}
                  </ol>
                </nav>
              )}
              <RunView run={run} />
              {finishedRunStates.has(run.state) && run.kind !== "index" && <Feedback run={run} csrfToken={csrfToken} onGiven={(feedback) => setRun((current) => (current ? { ...current, feedback } : current))} />}
              {run.proposals.length > 0 && (
                <div className="agents-cards__list">
                  {run.proposals.map((proposal) => <ProposalCard key={proposal.id} proposal={proposal} csrfToken={csrfToken} role={role} onStage={onStage} onDecided={decided} />)}
                </div>
              )}
            </>}
      </Panel>

      {staff && (
        <Panel className="agents-history" title="Earlier runs" count={history?.length}>
          <Table caption={`Runs of ${agent.name}`} columns={columns} rows={history ?? []} rowKey={(entry) => entry.id}
            rowStatus={(entry) => (["failed", "timeout", "killed"].includes(entry.state) ? "danger" : undefined)}
            empty={history === null ? "Reading the runs…" : "No runs yet."} />
        </Panel>
      )}
    </div>
  );
}
