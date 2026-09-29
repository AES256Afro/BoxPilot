import { useCallback, useEffect, useRef, useState } from "react";
import type { PendingOperation } from "../../ApproveDialog";
import { relativeTime } from "../../home/format";
import { Button, EmptyState, Field, Notice, Panel, Select, StatusChip, Table, Textarea, type TableColumn } from "../../ui";
import { agentsApi, followRun, type AgentSummary, type Proposal, type Run } from "./api";
import { errorText, finishedRunStates, kindWords, runState, seconds } from "./format";
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
  onSelectAgent: (agentId: string) => void;
  onStage: (operation: PendingOperation) => void;
  onRunFinished: () => void;
}

export function Console({ agents, agentId, runId, csrfToken, role, now, enabled, onSelectAgent, onStage, onRunFinished }: ConsoleProps) {
  const staff = role === "owner" || role === "operator";
  const usable = agents.filter((agent) => agent.canAsk || (staff && agent.canEdit) || (staff && role === "owner"));
  const agent = usable.find((entry) => entry.id === agentId) ?? usable[0] ?? null;
  const [question, setQuestion] = useState("");
  const [run, setRun] = useState<Run | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [history, setHistory] = useState<Run[] | null>(null);
  const stopFollowing = useRef<(() => void) | null>(null);

  const readHistory = useCallback(async (id: string) => {
    if (!staff) { setHistory([]); return; }
    try { setHistory((await agentsApi.runs(id)).runs); } catch { setHistory(null); }
  }, [staff]);

  const follow = useCallback((id: string) => {
    stopFollowing.current?.();
    stopFollowing.current = followRun(id, (event) => {
      if (event.event === "snapshot") {
        setRun(event.data);
        if (finishedRunStates.has(event.data.state)) onRunFinished();
      } else if (event.event === "step") {
        setRun((current) => (current ? { ...current, steps: [...(current.steps ?? []).filter((step) => step.seq !== event.data.seq), event.data] } : current));
      } else if (event.event === "state") {
        setRun((current) => (current ? { ...current, state: event.data.state } : current));
      }
    });
  }, [onRunFinished]);
  useEffect(() => () => stopFollowing.current?.(), []);

  const currentId = agent?.id ?? null;
  useEffect(() => { if (currentId) void readHistory(currentId); }, [currentId, readHistory]);
  useEffect(() => { if (runId) follow(runId); }, [runId, follow]);

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
    { id: "open", header: <span className="ui-visually-hidden">Open</span>, label: "Open", className: "agents-actions-cell", cell: (entry) => <Button variant="ghost" onClick={() => follow(entry.id)} aria-label="Open this run">Open</Button> },
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

      <Panel className="agents-live" title="Run" count={run ? { status: runState(run.state).status, label: runState(run.state).label } : undefined}
        meta={run ? <>{run.agentName} · {relativeTime(run.startedAt ?? run.queuedAt, now) ?? "just now"}{running ? " · live" : ""}</> : undefined} padded>
        {!run
          ? <p className="agents-quiet">Ask something or run the agent once, and each step shows here as it happens.</p>
          : <>
              {run.state === "queued" && <p className="agents-quiet" role="status">Waiting for the runner: one run goes at a time, and a question goes before scheduled work.</p>}
              <RunView run={run} />
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
            empty={history === null ? "The runs could not be read." : "No runs yet."} />
        </Panel>
      )}
    </div>
  );
}
