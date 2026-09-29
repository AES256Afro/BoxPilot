import { useCallback, useEffect, useState } from "react";
import { useOperation } from "../../shell/ApproveDialog";
import { Button, Notice, PageHeader, Tabs, useUrlParam, type TabItem } from "../../ui";
import { AgentList } from "./AgentList";
import { agentsApi, type AgentSummary, type Catalog, type Glance, type Overview, type Proposal } from "./api";
import { Builder } from "./Builder";
import { Console } from "./Console";
import { Evaluation } from "./Evaluation";
import { errorText, moduleVerdict } from "./format";
import { Knowledge } from "./Knowledge";
import { Memory } from "./Memory";
import { PasswordSheet } from "./PasswordSheet";
import { Usage } from "./Usage";
import "./agents.css";

/*
 * Agents (M37): the section for building and running the server's own agents. The verdict first -
 * off, paused, stopped, or running cool - with the counts and the processor the runner uses against
 * its cap, and the switch for all of them: pause, pause until tomorrow, resume, the kill switch.
 * Then the tabs: the agents and the cards they left; the builder; the test console with its live
 * trace; the learning library; usage and the runtime; and the evaluation. Agents propose and never
 * act: every step on a card is staged by a person through the ordinary approval dialog.
 */

type Tab = "agents" | "build" | "test" | "memory" | "knowledge" | "usage" | "evaluation";
const allTabs: readonly Tab[] = ["agents", "build", "test", "memory", "knowledge", "usage", "evaluation"];

export interface AgentsPageProps {
  csrfToken: string;
  role?: string;
  now?: () => number;
}

/** The agent the page is on, kept in the address like the tab (?agent=<id>). */
function readAgentParam(): string | null {
  if (typeof window === "undefined") return null;
  const value = new URLSearchParams(window.location.search).get("agent");
  return value && /^[0-9a-f-]{36}$/i.test(value) ? value : null;
}
function writeAgentParam(id: string | null) {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  if (id) url.searchParams.set("agent", id); else url.searchParams.delete("agent");
  window.history.replaceState(window.history.state, "", url);
}

export default function AgentsPage({ csrfToken, role = "owner", now = Date.now }: AgentsPageProps) {
  const staff = role === "owner" || role === "operator";
  const [overview, setOverview] = useState<Overview | null>(null);
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [proposals, setProposals] = useState<Proposal[] | null>(null);
  const [glance, setGlance] = useState<Glance | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [tab, setTab] = useUrlParam<Tab>("tab", allTabs, "agents");
  const [agentId, setAgentIdState] = useState<string | null>(readAgentParam);
  const [runId, setRunId] = useState<string | null>(null);
  const [turningOn, setTurningOn] = useState(false);
  const [busy, setBusy] = useState(false);
  const [jobsFinished, setJobsFinished] = useState(0);

  const setAgentId = useCallback((id: string | null) => { setAgentIdState(id); writeAgentParam(id); }, []);

  const refresh = useCallback(async () => {
    try {
      const next = await agentsApi.overview();
      setOverview(next);
      setError(null);
      if (staff) {
        agentsApi.proposals().then((value) => setProposals(value.proposals), () => setProposals(null));
        agentsApi.glance().then(setGlance, () => setGlance(null));
      }
    } catch (requestError) {
      setError(errorText(requestError, "Agents could not be read"));
    }
  }, [staff]);
  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => { agentsApi.catalog().then(setCatalog, () => undefined); }, []);
  // While something runs or waits, the list reads again every five seconds; otherwise every half minute.
  const active = (overview?.queue.running ?? 0) + (overview?.queue.queued ?? 0) > 0;
  useEffect(() => {
    const timer = setInterval(() => void refresh(), active ? 5_000 : 30_000);
    return () => clearInterval(timer);
  }, [active, refresh]);

  const { start, dialog } = useOperation(csrfToken, () => { setJobsFinished((count) => count + 1); void refresh(); });

  const moduleAction = async (work: () => Promise<unknown>, done: string) => {
    setBusy(true);
    try { await work(); setNotice(done); await refresh(); } catch (requestError) { setError(errorText(requestError, "That did not work")); } finally { setBusy(false); }
  };
  const agentAction = async (work: () => Promise<AgentSummary>, done: string) => {
    try { await work(); setNotice(done); await refresh(); } catch (requestError) { setError(errorText(requestError, "That did not work")); }
  };

  const open = (id: string, next: "build" | "test", run?: string) => { setAgentId(id); setRunId(run ?? null); setTab(next); };

  if (!overview) {
    return (
      <div className="agents-page">
        <PageHeader title="Agents" status={error ? { status: "unknown", label: "Not read" } : { status: "unknown", label: "Reading…" }} />
        {error && <Notice tone="danger" live title="Agents could not be read" action={<Button onClick={() => void refresh()}>Try again</Button>}>{error}</Notice>}
      </div>
    );
  }

  const { module, runner, agents, queue, can } = overview;
  const owner = role === "owner";
  const verdict = moduleVerdict(module, runner.online, queue.running);
  const cpu = runner.usage?.cpuPercent;
  const cap = runner.usage?.cpuQuotaPercent ?? 100;
  const cards = (proposals ?? []).filter((proposal) => proposal.state === "open").length;
  const selected = agents.find((agent) => agent.id === agentId)?.id ?? null;

  const tabs: Array<TabItem<Tab>> = [
    { id: "agents", label: "Agents", count: agents.length, ...(cards ? { status: "warning" as const, statusLabel: `${cards} cards waiting` } : {}) },
    ...(can.create ? [{ id: "build" as const, label: "Build" }] : []),
    { id: "test", label: staff ? "Test" : "Ask" },
    ...(staff ? [{ id: "memory" as const, label: "Memory" }, { id: "knowledge" as const, label: "Knowledge" }] : []),
    { id: "usage", label: "Usage", ...(module.enabled && !runner.online ? { status: "warning" as const, statusLabel: "the runner is not answering" } : {}) },
    ...(staff ? [{ id: "evaluation" as const, label: "Evaluation" }] : []),
  ];
  const shown = tabs.some((entry) => entry.id === tab) ? tab : "agents";

  const headerActions = (
    <>
      {owner && !module.enabled && <Button variant="primary" onClick={() => setTurningOn(true)}>Turn Agents on</Button>}
      {can.pause && module.enabled && !module.paused && <>
        <Button busy={busy} onClick={() => void moduleAction(() => agentsApi.pauseAll(csrfToken, null), "Every agent is paused. Nothing new starts until you resume them.")}>Pause all</Button>
        <Button variant="ghost" busy={busy} onClick={() => void moduleAction(() => agentsApi.pauseAll(csrfToken, "tomorrow"), "Every agent is paused until 07:00 tomorrow.")}>Until tomorrow</Button>
      </>}
      {can.pause && module.enabled && !module.killedAt && (
        <Button variant="ghost" busy={busy} onClick={() => void moduleAction(() => agentsApi.kill(csrfToken), "Stopped: runs cancelled, the model told to stop. Only the owner starts agents again.")}>Kill switch</Button>
      )}
      {can.pause && module.enabled && module.paused && (owner || !module.killedAt) && (
        <Button variant="primary" busy={busy} onClick={() => void moduleAction(() => agentsApi.resumeAll(csrfToken), "Agents are running again.")}>Resume all</Button>
      )}
    </>
  );

  return (
    <div className="agents-page">
      {dialog}
      <PageHeader
        title="Agents"
        status={{ status: verdict.status, label: verdict.label }}
        summary={verdict.sentence ?? undefined}
        meta={<>
          <b>{agents.length}</b> {agents.length === 1 ? "agent" : "agents"} · <b>{queue.running}</b> running · <b>{queue.queued}</b> waiting
          {staff ? <> · <b>{cards}</b> {cards === 1 ? "card" : "cards"}</> : null}
          {runner.online && cpu !== undefined ? <> · CPU <b>{cpu}%</b> of {cap}%</> : null}
          {module.inQuietHours ? " · quiet hours" : null}
        </>}
        actions={headerActions}
        about={<>
          <p>Agents are small assistants that run on this server's own model: they learn what is here, answer questions about it, watch Pi-hole or the backups, write a digest each morning and suggest fixes.</p>
          <p>They only read. A fix they suggest is a card of registered operations, and each step is staged and approved by a person at its own tier, as on any other page. They run in their own capped service (one processor, idle priority, 8 GiB, this machine only), one run at a time, and everything pauses with one switch.</p>
        </>}
      />

      {error && <Notice tone="danger" live onDismiss={() => setError(null)}>{error}</Notice>}
      {notice && <Notice tone="success" live onDismiss={() => setNotice(null)}>{notice}</Notice>}

      <Tabs<Tab> label="Agents" tabs={tabs} value={shown} onChange={(next) => { setTab(next); if (next !== "test") setRunId(null); }}>
        {(current) => {
          if (current === "build") {
            return <Builder agentId={selected} agents={agents} catalog={catalog} canCreate={can.create} csrfToken={csrfToken} now={now()}
              onCreated={(id) => { setAgentId(id); setNotice("Made. Change anything below; each save is a version you can roll back."); void refresh(); }}
              onChanged={() => void refresh()} onDeleted={() => { setAgentId(null); setTab("agents"); setNotice("Deleted."); void refresh(); }}
              onTest={(id) => open(id, "test")} />;
          }
          if (current === "test") {
            return <Console agents={agents} agentId={selected} runId={runId} csrfToken={csrfToken} role={role} now={now()} enabled={module.enabled && !module.paused}
              onSelectAgent={(id) => { setAgentId(id); setRunId(null); }} onStage={start} onRunFinished={() => void refresh()} />;
          }
          if (current === "memory") return <Memory agents={agents} agentId={selected} csrfToken={csrfToken} role={role} now={now()} onSelectAgent={setAgentId} />;
          if (current === "knowledge") return <Knowledge csrfToken={csrfToken} role={role} now={now()} onStart={start} />;
          if (current === "usage") return <Usage module={module} csrfToken={csrfToken} role={role} now={now()} onStart={start} onModuleChanged={() => void refresh()} refreshKey={jobsFinished} />;
          if (current === "evaluation") {
            return <Evaluation agents={agents} agentId={selected} csrfToken={csrfToken} now={now()} enabled={module.enabled && !module.paused} onSelectAgent={setAgentId} onOpenRun={(id, run) => open(id, "test", run)} />;
          }
          return <AgentList overview={overview} proposals={proposals} glance={glance} csrfToken={csrfToken} role={role} now={now()}
            onOpen={open} onNew={() => { setAgentId(null); setTab("build"); }}
            onPause={(agent, until) => void agentAction(() => agentsApi.pause(csrfToken, agent.id, until), until ? `${agent.name} is paused until 07:00 tomorrow.` : `${agent.name} is paused.`)}
            onResume={(agent) => void agentAction(() => agentsApi.resume(csrfToken, agent.id), `${agent.name} is running again.`)}
            onStage={start} onProposalDecided={() => void refresh()} onTurnOn={owner ? () => setTurningOn(true) : null} />;
        }}
      </Tabs>

      {turningOn && (
        <PasswordSheet title="Turn Agents on" confirmLabel="Turn on" onClose={() => setTurningOn(false)}
          onConfirm={async (password) => { await agentsApi.saveSettings(csrfToken, { password, enabled: true }); setNotice("Agents are on. Install Unsloth and start the runner on the Usage tab if they are not there yet."); await refresh(); }}>
          <p>Agents read this server's facts and send them to the model on this machine, nowhere else. The runner is capped at one processor and 8 GiB; each agent has a budget. You can pause everything at any time.</p>
        </PasswordSheet>
      )}
    </div>
  );
}
