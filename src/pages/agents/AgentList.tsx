import { relativeTime } from "../../home/format";
import type { PendingOperation } from "../../shell/ApproveDialog";
import { Button, EmptyState, Notice, Panel, StatusChip, Table, type TableColumn } from "../../ui";
import type { AgentSummary, Glance, Overview, Proposal } from "./api";
import { agentState, runState, triggerWords } from "./format";
import { ProposalCard } from "./ProposalCard";
import { AnswerText } from "./Trace";

/*
 * The Agents tab (M37): every agent with what it is doing, how it starts, how its last run went and
 * how much of today's budget it has used; its own pause and resume; and the cards agents left,
 * each step staged at its own tier by a person. The latest digest leads when there is one.
 */

export interface AgentListProps {
  overview: Overview;
  proposals: Proposal[] | null;
  glance: Glance | null;
  csrfToken: string;
  role: string;
  now: number;
  onOpen: (agentId: string, tab: "build" | "test", runId?: string) => void;
  onNew: () => void;
  onPause: (agent: AgentSummary, until: string | null) => void;
  onResume: (agent: AgentSummary) => void;
  onStage: (operation: PendingOperation) => void;
  onProposalDecided: (proposal: Proposal) => void;
  onTurnOn: (() => void) | null;
}

export function AgentList({ overview, proposals, glance, csrfToken, role, now, onOpen, onNew, onPause, onResume, onStage, onProposalDecided, onTurnOn }: AgentListProps) {
  const { agents, module, can } = overview;
  const staff = role === "owner" || role === "operator";
  const paused = agents.filter((agent) => agent.paused).length;
  const scheduled = agents.filter((agent) => agent.triggers.schedule).length;
  const open = (proposals ?? []).filter((proposal) => proposal.state === "open");

  const columns: Array<TableColumn<AgentSummary>> = [
    {
      id: "agent", header: "Agent", sortValue: (agent) => agent.name, cell: (agent) => (
        <span className="agents-name">
          <button type="button" className="agents-link" onClick={() => onOpen(agent.id, agent.canEdit ? "build" : "test")}>{agent.name}</button>
          <span className="agents-name__purpose">{agent.purpose}</span>
        </span>
      ),
    },
    { id: "status", header: "Status", sortValue: (agent) => agent.status, cell: (agent) => { const state = agentState(agent.status); return <StatusChip status={state.status}>{agent.paused && agent.pausedUntil ? `paused until ${new Date(agent.pausedUntil).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false })}` : state.label}</StatusChip>; } },
    { id: "starts", header: "Starts", hideOnPhone: true, cell: (agent) => <span className="agents-dim">{triggerWords(agent)}{agent.waitsForQuietHours ? " · quiet hours" : ""}</span> },
    {
      id: "last", header: "Last run", sortValue: (agent) => agent.lastRun?.finishedAt ?? "", cell: (agent) => (agent.lastRun
        ? <span className="agents-last"><StatusChip status={runState(agent.lastRun.state).status}>{runState(agent.lastRun.state).label}</StatusChip><span className="agents-dim">{relativeTime(agent.lastRun.finishedAt, now) ?? ""}</span></span>
        : <span className="agents-dim">never</span>),
    },
    {
      id: "today", header: "Today", hideOnPhone: true, cell: (agent) => (
        <span className="agents-mono">{agent.budgetToday.runsUsed}/{agent.budgetToday.runsPerDay} runs · {agent.budgetToday.modelSecondsUsed}/{agent.budgetToday.modelSecondsPerDay} s</span>
      ),
    },
    {
      id: "actions", header: <span className="ui-visually-hidden">Actions</span>, label: "Actions", className: "agents-actions-cell", cell: (agent) => (
        <span className="agents-actions">
          {(agent.canAsk || agent.canEdit) && <Button variant="ghost" onClick={() => onOpen(agent.id, "test")} aria-label={`Test ${agent.name}`}>Test</Button>}
          {agent.canEdit && <Button variant="ghost" onClick={() => onOpen(agent.id, "build")} aria-label={`Edit ${agent.name}`}>Edit</Button>}
          {can.pause && (agent.paused
            ? <Button onClick={() => onResume(agent)} aria-label={`Resume ${agent.name}`}>Resume</Button>
            : <>
                <Button onClick={() => onPause(agent, null)} aria-label={`Pause ${agent.name}`}>Pause</Button>
                <Button variant="ghost" onClick={() => onPause(agent, "tomorrow")} aria-label={`Pause ${agent.name} until tomorrow`}>Until tomorrow</Button>
              </>)}
        </span>
      ),
    },
  ];

  return (
    <div className="agents-tab">
      {!module.enabled && (
        <Notice tone="info" title="Agents are off" action={onTurnOn ? <Button variant="primary" onClick={onTurnOn}>Turn Agents on</Button> : undefined}>
          Nothing runs and no model is loaded. Agents can be built and tested once they are on; each change stays a version you can roll back.
        </Notice>
      )}

      {glance?.digest && (
        <Panel className="agents-digest" title="Latest digest" meta={<>{glance.digest.agentName} · {relativeTime(glance.digest.at, now) ?? ""}</>} padded
          actions={<Button variant="ghost" onClick={() => onOpen(glance.digest!.agentId, "test", glance.digest!.runId)}>Open the run</Button>}>
          <AnswerText text={glance.digest.excerpt} />
        </Panel>
      )}

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

      {staff && (
        <Panel className="agents-cards" title="Cards waiting" count={proposals ? { status: open.length ? "warning" : "good", label: String(open.length) } : undefined}
          meta={open.length ? "each step is staged at its own tier" : undefined} padded={open.length === 0}>
          {proposals === null
            ? <p className="agents-quiet">Reading…</p>
            : open.length === 0
              ? <p className="agents-quiet">No cards. When an agent finds something a registered operation fixes, it leaves a card here; nothing runs until you stage and approve it.</p>
              : <div className="agents-cards__list">{open.map((proposal) => <ProposalCard key={proposal.id} proposal={proposal} csrfToken={csrfToken} role={role} onStage={onStage} onDecided={onProposalDecided} onOpenRun={(agentId, runId) => onOpen(agentId, "test", runId)} />)}</div>}
        </Panel>
      )}
    </div>
  );
}
