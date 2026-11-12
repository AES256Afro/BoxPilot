import { useState } from "react";
import { relativeTime } from "../../home/format";
import type { PendingOperation } from "../../shell/ApproveDialog";
import { Button, EmptyState, Notice, Panel, Sheet, StatusChip, Table, Tag, type TableColumn } from "../../ui";
import type { AgentSummary, Glance, Overview, Proposal } from "./api";
import type { RunnerWait } from "./setup";
import { agentState, duration, runState, triggerWords } from "./format";
import { CardGroup, groupCards } from "./CardGroup";
import { ProposalCard } from "./ProposalCard";
import { AnswerText } from "./Trace";

/*
 * The Agents tab (M37): every agent with what it is doing, how it starts, how its last run went and
 * how much of today's budget it has used; two actions a row, Ask and Pause (which asks for how long;
 * Resume once it is paused), its name opening Build; and the cards agents left,
 * each step staged at its own tier by a person. The latest digest leads when there is one, and the
 * cards lead the table while any wait (M48.7): they are what a person comes here to act on.
 */

export interface AgentListProps {
  overview: Overview;
  proposals: Proposal[] | null;
  glance: Glance | null;
  csrfToken: string;
  role: string;
  now: number;
  onOpen: (agentId: string, tab: "build" | "test" | "evaluation", runId?: string) => void;
  onNew: () => void;
  onPause: (agent: AgentSummary, until: string | null) => void;
  onResume: (agent: AgentSummary) => void;
  onStage: (operation: PendingOperation) => void;
  onProposalDecided: (proposal: Proposal) => void;
  onTurnOn: (() => void) | null;
  /** Set while Agents are on and the runner is not answering: why runs wait, and the owner's step. */
  runnerWait?: RunnerWait | null;
}

export function AgentList({ overview, proposals, glance, csrfToken, role, now, onOpen, onNew, onPause, onResume, onStage, onProposalDecided, onTurnOn, runnerWait = null }: AgentListProps) {
  const { agents, module, can } = overview;
  const waiting = overview.queue.queued;
  /** An agent's status, said as the runner being down when that is why it waits. */
  const stateOf = (agent: AgentSummary) => (agent.status === "queued" && runnerWait ? { status: "warning" as const, label: "waiting for the runner" } : agentState(agent.status));
  const staff = role === "owner" || role === "operator";
  const paused = agents.filter((agent) => agent.paused).length;
  const scheduled = agents.filter((agent) => agent.triggers.schedule).length;
  const open = (proposals ?? []).filter((proposal) => proposal.state === "open");
  // The agent whose Pause was pressed: its sheet asks for how long.
  const [pausing, setPausing] = useState<AgentSummary | null>(null);
  const pause = (until: string | null) => { if (pausing) onPause(pausing, until); setPausing(null); };

  const columns: Array<TableColumn<AgentSummary>> = [
    {
      id: "agent", header: "Agent", className: "agents-agent-cell", sortValue: (agent) => agent.name, cell: (agent) => (
        <span className="agents-name">
          <button type="button" className="agents-link" onClick={() => onOpen(agent.id, agent.canEdit ? "build" : "test")}>{agent.name}</button>
          <span className="agents-name__purpose">{agent.purpose}</span>
        </span>
      ),
    },
    {
      id: "status", header: "Status", sortValue: (agent) => agent.status, cell: (agent) => {
        const state = stateOf(agent);
        return (
          <span className="agents-last">
            <StatusChip status={state.status}>{agent.paused && agent.pausedUntil ? `paused until ${new Date(agent.pausedUntil).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false })}` : state.label}</StatusChip>
            {/* M40: its evaluation's latest score, flagged when it dropped; M48.7: a press opens the evaluation. */}
            {agent.accuracy?.dropped && (
              <button type="button" className="agents-chip-link" onClick={() => onOpen(agent.id, "evaluation")} aria-label={`Open the evaluation of ${agent.name}: accuracy down to ${Math.round(agent.accuracy.score * 100)}%`}>
                <StatusChip status="warning">accuracy down to {Math.round(agent.accuracy.score * 100)}%</StatusChip>
              </button>
            )}
          </span>
        );
      },
    },
    { id: "starts", header: "Starts", hideOnPhone: true, className: "agents-starts-cell", cell: (agent) => <span className="agents-dim">{triggerWords(agent)}{agent.waitsForQuietHours ? " · quiet hours" : ""}</span> },
    {
      id: "last", header: "Last run", sortValue: (agent) => agent.lastRun?.finishedAt ?? "", cell: (agent) => (agent.lastRun
        ? <span className="agents-last"><StatusChip status={runState(agent.lastRun.state).status}>{runState(agent.lastRun.state).label}</StatusChip><span className="agents-dim">{relativeTime(agent.lastRun.finishedAt, now) ?? ""}</span></span>
        : <span className="agents-dim">never</span>),
    },
    {
      id: "today", header: "Today", hideOnPhone: true, cell: (agent) => (
        // Two lines: on one, the column was a fifth of the table and pushed the row's buttons out of sight at 1280 px.
        <span className="agents-mono agents-today-cell"><span>{agent.budgetToday.runsUsed} of {agent.budgetToday.runsPerDay} runs</span><span>{duration(agent.budgetToday.modelSecondsUsed)} of {duration(agent.budgetToday.modelSecondsPerDay)}</span></span>
      ),
    },
    {
      id: "actions", header: <span className="ui-visually-hidden">Actions</span>, label: "Actions", className: "agents-actions-cell", cell: (agent) => (
        <span className="agents-actions">
          {(agent.canAsk || agent.canEdit) && <Button variant="ghost" onClick={() => onOpen(agent.id, "test")} aria-label={`Ask ${agent.name}`}>Ask</Button>}
          {can.pause && (agent.paused
            ? <Button onClick={() => onResume(agent)} aria-label={`Resume ${agent.name}`}>Resume</Button>
            : <Button onClick={() => setPausing(agent)} aria-haspopup="dialog" aria-label={`Pause ${agent.name}`}>Pause</Button>)}
        </span>
      ),
    },
  ];

  // Cards "Mark all done" could not change: said above the list, where they still are.
  const [cardsRefused, setCardsRefused] = useState(0);
  const openRun = (agentId: string, runId: string) => onOpen(agentId, "test", runId);

  const cardsPanel = staff && (
    <Panel className="agents-cards" title="Cards waiting" count={proposals ? { status: open.length ? "warning" : "good", label: String(open.length) } : undefined}
      meta={open.length ? "each step is staged at its own tier" : undefined} padded={open.length === 0}>
      {proposals === null
        ? <p className="agents-quiet">Reading…</p>
        : open.length === 0
          ? <p className="agents-quiet">No cards. When an agent finds something a registered operation fixes, it leaves a card here; nothing runs until you stage and approve it.</p>
          : (
            <div className="agents-cards__list">
              {cardsRefused > 0 && (
                <Notice tone="danger" live>
                  {cardsRefused === 1 ? "1 card could not be marked done. It is" : `${cardsRefused} cards could not be marked done. They are`} still here. Try again.
                </Notice>
              )}
              {/* Cards that say the same thing share one head; a plan is always its own card. */}
              {groupCards(open).map((group) => (group.cards.length > 1
                ? <CardGroup key={group.key} cards={group.cards} csrfToken={csrfToken} role={role} now={now} onStage={onStage} onDecided={onProposalDecided} onOpenRun={openRun} onAllDone={setCardsRefused} />
                : <ProposalCard key={group.key} proposal={group.cards[0]} csrfToken={csrfToken} role={role} now={now} onStage={onStage} onDecided={onProposalDecided} onOpenRun={openRun} />))}
            </div>
          )}
    </Panel>
  );

  return (
    <div className="agents-tab">
      {!module.enabled && (
        <Notice tone="info" title="Agents are off" action={onTurnOn ? <Button variant="primary" onClick={onTurnOn}>Turn Agents on</Button> : undefined}>
          Nothing runs and no model is loaded. Agents can be built and tested once they are on; each change stays a version you can roll back.
        </Notice>
      )}

      {runnerWait && waiting > 0 && (
        <Notice tone="warning" title={runnerWait.words} action={runnerWait.action ?? undefined}>
          <b>{waiting}</b> {waiting === 1 ? "run waits" : "runs wait"}, and {waiting === 1 ? "it starts" : "they start"} as soon as the runner does.
        </Notice>
      )}

      {glance?.digest && (
        <Panel className="agents-digest" title="Latest digest" padded
          meta={<>{glance.digest.agentName} · {relativeTime(glance.digest.at, now) ?? ""}{glance.digest.state === "degraded" && <>{" "}<Tag tone="warning">Facts only</Tag></>}</>}
          actions={<Button variant="ghost" onClick={() => onOpen(glance.digest!.agentId, "test", glance.digest!.runId)}>Open the run</Button>}>
          {/* A run without the model's words is not the digest it looks like: said here, with why on the run. */}
          {glance.digest.state === "degraded" && <p className="agents-quiet">The model's words are missing from this run, so this is what its tools found. Open the run to see why.</p>}
          <AnswerText text={glance.digest.excerpt} />
        </Panel>
      )}

      {open.length > 0 && cardsPanel}

      <Panel
        className="agents-list"
        title="Agents"
        count={agents.length}
        meta={agents.length ? <><b>{paused}</b> paused · <b>{scheduled}</b> on a schedule · <b>{overview.queue.running}</b> running · <b>{overview.queue.queued}</b> waiting</> : undefined}
        actions={can.create ? <Button variant="primary" onClick={onNew}>New agent</Button> : undefined}
      >
        <Table
          caption="Agents on this server"
          columns={columns}
          rows={agents}
          rowKey={(agent) => agent.id}
          rowStatus={(agent) => (agent.lastRun && ["failed", "timeout", "killed"].includes(agent.lastRun.state) ? "danger" : undefined)}
          empty={<EmptyState title="No agents yet" action={can.create ? <Button variant="primary" onClick={onNew}>Start from a template</Button> : undefined}>
            {can.create ? "Start from the Server Keeper, the Pi-hole Watcher, the Backup Auditor or the IT Support helper, or from a blank page." : "None take your questions yet."}
          </EmptyState>}
        />
      </Panel>

      {open.length === 0 && cardsPanel}

      {pausing && (
        <Sheet side="center" size="sm" kicker="Agents" title={`Pause ${pausing.name}`} onClose={() => setPausing(null)}
          footer={<><Button variant="ghost" onClick={() => setPausing(null)}>Cancel</Button><Button onClick={() => pause("tomorrow")}>Until tomorrow</Button><Button variant="primary" onClick={() => pause(null)}>Until I resume</Button></>}>
          <p>Nothing new starts while it is paused, and a run in progress is stopped. Until tomorrow means 07:00 in the morning.</p>
        </Sheet>
      )}
    </div>
  );
}
