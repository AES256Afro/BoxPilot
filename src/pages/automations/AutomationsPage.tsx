import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { JobLogView } from "../../JobLogView";
import { countOf } from "../../data";
import { mountpointFor } from "../../mountpoints";
import { inspectOperation } from "../../operations";
import { Button, CodeBlock, EmptyState, KeyValue, Notice, PageHeader, Panel, Sheet, StatusChip, Tabs, Tag, type KeyValueItem, type Status } from "../../ui";
import type { RiskTier } from "../../ui/types";
import { FlowBuilder } from "./FlowBuilder";
import SchedulesPanel, { lastRunOf, useSchedules } from "./SchedulesPanel";
import { cadenceLabel, flowFailed, flowTierWords, humanize, settingText, type Flow, type OwnerStepToKeep, type PaletteStep, type ShelfItem } from "./flows";
import "./automations.css";

/*
 * Automations (M13.2, ADR-002; rebuilt on the kit in M33.11): ordered lists of registered
 * operations, run as ordinary jobs, and the schedules that run single operations on a cadence.
 * Facts first: whether anything failed or fell behind, then the three jobs the page does, a tab
 * each: your automations, the schedules, and the shelf of ready-made flows that already know what
 * a home server gets wrong, added with one click and then editable like anything built by hand.
 * Building one is a long form, so it opens in a sheet; so does what a run did, step by step.
 */

type Tab = "flows" | "schedules" | "shelf";
const tiers: readonly RiskTier[] = ["low", "medium", "high"];
const rank = (risk: string) => Math.max(0, tiers.indexOf(risk as RiskTier));

export interface AutomationsPageProps {
  csrfToken: string;
  /** Who is signed in: a viewer reads the automations and runs or changes none. */
  role?: string;
}

export default function AutomationsPage({ csrfToken, role = "owner" }: AutomationsPageProps) {
  const [flows, setFlows] = useState<Flow[] | null>(null);
  const [palette, setPalette] = useState<PaletteStep[]>([]);
  const [shelf, setShelf] = useState<ShelfItem[]>([]);
  const [suggestions, setSuggestions] = useState<Record<string, string>>({}); // slug -> why this server wants it
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // Removing a flow and regenerating its webhook cannot be undone: each asks once, inline.
  const [confirming, setConfirming] = useState<{ flowId: string; action: "remove" | "regenerate" } | null>(null);
  // A new webhook URL exists only here, so it stays on screen until the owner dismisses it.
  const [webhook, setWebhook] = useState<{ flowId: string; name: string; url: string } | null>(null);
  // Which automation the latest message is about. It is said in that automation's card, beside the
  // button that caused it: said at the top of the page, a Run now, a schedule change and the webhook
  // URL that is shown only once all landed out of sight of a card further down.
  const [about, setAbout] = useState<string | null>(null);
  const [building, setBuilding] = useState(false);
  const [runOf, setRunOf] = useState<string | null>(null);
  const [timezone, setTimezone] = useState<string | null>(null);
  const pollTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const schedules = useSchedules();
  const viewer = role === "viewer";

  const refresh = useCallback(async () => {
    try {
      const response = await fetch("/api/v1/flows");
      if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error ?? "Could not read automations");
      const body = (await response.json()) as { flows: Flow[]; palette: PaletteStep[]; shelf?: ShelfItem[] };
      setFlows(body.flows ?? []);
      setPalette(body.palette ?? []);
      setShelf(body.shelf ?? []);
      setLoadError(null);
      return body.flows;
    } catch (requestError) {
      setLoadError(requestError instanceof Error ? requestError.message : "Could not read automations");
      return null;
    }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);

  // The server's time zone, which schedules' times are in. Nice to have: a failure hides it.
  useEffect(() => {
    inspectOperation<{ timezone?: string | null }>("system.settings.inspect").then(({ result }) => setTimezone(result.timezone ?? null)).catch(() => setTimezone(null));
  }, []);

  // Suggestions are read once, and again when a run finishes, not inside refresh(): refresh() is
  // polled every three seconds while anything runs, and this asks the helper what is reclaimable
  // and what needs updating. Allowed to fail: the page is usable without an argument for anything.
  const anyRunning = (flows ?? []).some((flow) => flow.running);
  useEffect(() => {
    if (anyRunning) return;
    let cancelled = false;
    fetch("/api/v1/flows/suggestions")
      .then((suggested) => (suggested.ok ? suggested.json() : { suggestions: [] }))
      .then((suggestedBody: { suggestions?: Array<{ slug: string; because: string }> }) => {
        if (!cancelled) setSuggestions(Object.fromEntries((suggestedBody.suggestions ?? []).map((entry) => [entry.slug, entry.because])));
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [anyRunning]);

  // A run can outlive its own HTTP response (a proxy may give up on a long request long before apt
  // does), so the list is the source of truth while anything is running.
  useEffect(() => {
    if (anyRunning && !pollTimer.current) pollTimer.current = setInterval(() => void refresh(), 3000);
    if (!anyRunning && pollTimer.current) { clearInterval(pollTimer.current); pollTimer.current = null; }
    return () => { if (pollTimer.current) { clearInterval(pollTimer.current); pollTimer.current = null; } };
  }, [anyRunning, refresh]);

  const titleFor = (operationId: string) => palette.find((step) => step.operationId === operationId)?.title ?? operationId;
  const stepsOf = (steps: Array<{ operationId: string }>) => steps.map((step) => titleFor(step.operationId)).join(" → ");

  const post = async (url: string, body?: unknown, method = "POST") => {
    const response = await fetch(url, {
      method,
      headers: { ...(body === undefined ? {} : { "Content-Type": "application/json" }), "X-BoxPilot-CSRF": csrfToken },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!response.ok && response.status !== 204) {
      throw new Error(((await response.json().catch(() => ({}))) as { error?: string }).error ?? "The request was refused");
    }
  };

  const installFromShelf = async (item: ShelfItem) => {
    setError(null); setNotice(null); setAbout(null);
    try {
      await post("/api/v1/flows", { name: item.name, steps: item.steps });
      // A ready-made flow has no schedule: added, it runs only when someone runs it.
      setNotice(`${item.name} is on your list of automations. It does not run until you run it or give it a schedule; it is yours to edit.`);
      await refresh();
    } catch (requestError) { setError(requestError instanceof Error ? requestError.message : "Could not add the automation"); }
  };

  const runFlow = (flow: Flow) => {
    setAbout(flow.id); setError(null); setNotice(`${flow.name} is running; each step appears in Activity as its own job.`);
    setFlows((current) => (current ?? []).map((entry) => (entry.id === flow.id ? { ...entry, running: true } : entry)));
    post(`/api/v1/flows/${encodeURIComponent(flow.id)}/run`)
      .catch((requestError) => setError(requestError instanceof Error ? requestError.message : "The run was refused"))
      .finally(() => void refresh());
  };

  const change = async (flow: Flow, body: Record<string, unknown>, failure: string) => {
    setAbout(flow.id); setError(null); setNotice(null);
    try { await post(`/api/v1/flows/${encodeURIComponent(flow.id)}`, body, "PUT"); await refresh(); }
    catch (requestError) { setError(requestError instanceof Error ? requestError.message : failure); }
  };

  // The owner keeps a step only they may run that someone else put in the flow: that one step, by its
  // number, as it is stored. Sending every step back used to keep every owner-only step in it, shown
  // or not (sweep 4). The page cannot edit an existing flow's steps, so this is the way to do what the
  // run's refusal asks.
  const keepStep = async (flow: Flow, unkept: OwnerStepToKeep) => {
    setAbout(flow.id); setError(null); setNotice(null);
    try {
      await post(`/api/v1/flows/${encodeURIComponent(flow.id)}`, { keepStep: unkept.step }, "PUT");
      setNotice(`Step ${unkept.step} is kept: ${flow.name} runs it as it is.`);
      await refresh();
    } catch (requestError) { setError(requestError instanceof Error ? requestError.message : "Could not keep the step"); }
  };

  const mintWebhook = async (flow: Flow) => {
    setAbout(flow.id); setError(null); setNotice(null);
    try {
      const response = await fetch(`/api/v1/flows/${encodeURIComponent(flow.id)}/webhook`, { method: "POST", headers: { "X-BoxPilot-CSRF": csrfToken } });
      const body = (await response.json()) as { token?: string; path?: string; error?: string };
      if (!response.ok || !body.path) throw new Error(body.error ?? "Could not create the webhook");
      // The one time the URL exists outside the caller's hands: shown here, stored nowhere.
      setWebhook({ flowId: flow.id, name: flow.name, url: `${window.location.origin}${body.path}` });
      await refresh();
    } catch (requestError) { setError(requestError instanceof Error ? requestError.message : "Could not create the webhook"); }
  };

  const removeWebhook = async (flow: Flow) => {
    setAbout(flow.id); setError(null); setNotice(null);
    try { await post(`/api/v1/flows/${encodeURIComponent(flow.id)}/webhook`, undefined, "DELETE"); setWebhook((current) => (current?.flowId === flow.id ? null : current)); setNotice(`${flow.name}'s webhook no longer works.`); await refresh(); }
    catch (requestError) { setError(requestError instanceof Error ? requestError.message : "Could not remove the webhook"); }
  };

  const removeFlow = async (flow: Flow) => {
    setAbout(flow.id); setError(null); setNotice(null);
    // Gone from the list once removed, so what is said about it is said at the top.
    try { await post(`/api/v1/flows/${encodeURIComponent(flow.id)}`, undefined, "DELETE"); setWebhook((current) => (current?.flowId === flow.id ? null : current)); setAbout(null); setNotice(`${flow.name} is removed.`); await refresh(); }
    catch (requestError) { setError(requestError instanceof Error ? requestError.message : "Could not remove it"); }
  };

  const saveDraft = async (draft: { name: string; steps: Array<Record<string, unknown>>; triggerFlowId?: string }) => {
    setAbout(null); setError(null); setNotice(null);
    await post("/api/v1/flows", draft);
    setBuilding(false);
    setNotice(`${draft.name} is saved. Run it now, or give it a schedule.`);
    await refresh();
  };

  // ── The verdict: anything that failed, then anything behind. Unread is never "fine". ──
  const list = flows ?? [];
  const scheduleList = schedules.schedules ?? [];
  const failedFlows = list.filter(flowFailed).length;
  const failedSchedules = scheduleList.filter((schedule) => lastRunOf(schedule).failed).length;
  const behind = scheduleList.filter((schedule) => schedule.enabled && schedule.overdue).length;
  const failed = failedFlows + failedSchedules;
  const running = list.filter((flow) => flow.running).length;
  const scheduled = list.filter((flow) => flow.frequency).length;
  const webhooks = list.filter((flow) => flow.webhookEnabled).length;
  const verdict: { status: Status; label: string } = flows === null
    ? { status: "unknown", label: loadError ? "Not read" : "Reading…" }
    : failed ? { status: "danger", label: `${failed} failed` }
      : behind ? { status: "warning", label: `${behind} behind` }
        : list.length + scheduleList.length === 0 ? { status: "neutral", label: "None set up" }
          : { status: "good", label: "None failed" };
  const installed = useMemo(() => new Set(list.map((flow) => flow.name)), [list]);
  const suggestedShelf = shelf.filter((item) => suggestions[item.slug ?? item.name] && !installed.has(item.name)).length;
  // Suggested ones first: a shelf that lists everything equally reads as a catalogue, with no
  // reason to pick one, so nobody picks any.
  const sortedShelf = [...shelf].sort((left, right) => Number(Boolean(suggestions[right.slug ?? right.name])) - Number(Boolean(suggestions[left.slug ?? left.name])));
  const shelfTier = (item: ShelfItem): RiskTier | undefined => {
    const known = item.steps.map((step) => palette.find((entry) => entry.operationId === step.operationId)?.risk).filter((risk): risk is string => Boolean(risk));
    return known.length ? tiers[Math.max(...known.map(rank))] : undefined;
  };
  const runFlowOf = runOf ? list.find((flow) => flow.id === runOf) ?? null : null;

  const flowFacts = (flow: Flow): KeyValueItem[] => {
    const facts: KeyValueItem[] = [];
    const failedRun = flowFailed(flow);
    const when = flow.lastRunAt ? new Date(flow.lastRunAt).toLocaleString() : null;
    facts.push({
      id: "last", label: "Last run",
      status: flow.running ? "neutral" : !flow.lastResult ? undefined : failedRun ? "danger" : "good",
      value: flow.lastResult ?? "never run",
      hint: [when, flow.lastRunElsewhere ? `${flow.running ? "Someone else is running this now." : "Someone else ran this last."} Its steps are in their Activity.` : null].filter(Boolean).join(" · ") || undefined,
    });
    if (flow.frequency) facts.push({ id: "schedule", label: "Schedule", value: `${cadenceLabel(flow)}${flow.enabled ? "" : ", paused"}`, hint: `${flow.enabled && flow.nextDueAt ? `next ${new Date(flow.nextDueAt).toLocaleString()} · ` : ""}runs as you, the same as pressing Run` });
    if (flow.triggerFlowId) facts.push({ id: "after", label: "Runs after", value: `${list.find((other) => other.id === flow.triggerFlowId)?.name ?? "another flow"} completes${flow.enabled ? "" : " (paused)"}`, hint: "Under its own creator's account." });
    if (flow.triggerDrive) facts.push({ id: "drive", label: "Runs when", value: <><code>{mountpointFor(flow.triggerDrive)}</code> drops or goes read-only{flow.enabled ? "" : " (paused)"}</>, hint: "Under its creator's account, within the limits shown beside the drive on Storage." });
    if (flow.webhookEnabled) facts.push({ id: "webhook", label: "Webhook", value: "on", mono: true, hint: "The URL was shown once when it was made; regenerate it to get a new one." });
    return facts;
  };

  const flowPanel = (
    <Panel
      className="automations-flows"
      title="Your automations"
      count={flows ? list.length : undefined}
      meta={flows ? <><b>{running}</b> running · <b>{scheduled}</b> scheduled · <b>{failedFlows}</b> failed</> : undefined}
      actions={!viewer && flows ? <Button onClick={() => setBuilding(true)}>Build your own</Button> : undefined}
    >
      {flows === null ? <p className="automations-quiet">{loadError ? "The automations could not be read." : "Reading…"}</p>
        : list.length === 0 ? (
          <EmptyState title="No automations yet" action={!viewer ? <Button onClick={() => setBuilding(true)}>Build your own</Button> : undefined}>
            {shelf.length ? "Add one from Ready to use, or build your own from the operations you already trust." : "Build one from the operations you already trust."}
          </EmptyState>
        ) : (
          <ul className="automations-list">
            {list.map((flow) => {
              const failedRun = flowFailed(flow);
              // An operator may run anyone's flow, but change only their own (M29.4); a viewer neither.
              const mayManage = !viewer && (role === "owner" || flow.createdBy !== null);
              const mayRun = !viewer && !(role === "operator" && flow.risk === "high");
              return (
                <li key={flow.id} className="automations-flow ui-marked" data-status={flow.running ? "neutral" : failedRun ? "danger" : undefined}>
                  <div className="automations-flow__head">
                    <h3 className="automations-flow__name">{flow.name}</h3>
                    <Tag tier={flow.risk} />
                    {flow.running && <StatusChip status="neutral">running</StatusChip>}
                    {!flow.running && failedRun && <StatusChip status="danger">last run failed</StatusChip>}
                    {!flow.enabled && (flow.frequency || flow.triggerFlowId || flow.triggerDrive) && <StatusChip status="neutral">paused</StatusChip>}
                  </div>
                  <p className="automations-flow__steps"><span>{stepsOf(flow.steps)}</span><span className="automations-flow__tier"> · {flowTierWords[flow.risk]}</span></p>
                  <KeyValue layout="columns" className="automations-flow__facts" items={flowFacts(flow)} />
                  <div className="automations-flow__actions">
                    {mayRun && <Button variant="primary" busy={flow.running} onClick={() => runFlow(flow)}>{flow.running ? "Running…" : "Run now"}</Button>}
                    {!flow.lastRunElsewhere && (flow.running || flow.lastJobIds.length > 0) && <Button onClick={() => setRunOf(flow.id)}>{flow.running ? "Watch this run" : "What the last run did"}</Button>}
                    {mayManage && flow.triggerDrive && <Button disabled={flow.running} onClick={() => void change(flow, { enabled: !flow.enabled }, "Could not change the schedule")}>{flow.enabled ? "Pause reconnecting" : "Resume reconnecting"}</Button>}
                    {mayManage && !flow.frequency && !flow.triggerDrive && <Button disabled={flow.running} onClick={() => void change(flow, { cadence: { frequency: "weekly", minute: 0, hour: 3, weekday: 0 } }, "Could not change the schedule")}>Run it every Sunday at 03:00</Button>}
                    {mayManage && flow.frequency && <Button disabled={flow.running} onClick={() => void change(flow, { enabled: !flow.enabled }, "Could not change the schedule")}>{flow.enabled ? "Pause the schedule" : "Resume the schedule"}</Button>}
                    {mayManage && flow.frequency && <Button variant="ghost" disabled={flow.running} onClick={() => void change(flow, { cadence: null }, "Could not change the schedule")}>Stop scheduling it</Button>}
                    {mayManage && <Button variant="ghost" onClick={() => (flow.webhookEnabled ? setConfirming({ flowId: flow.id, action: "regenerate" }) : void mintWebhook(flow))}>{flow.webhookEnabled ? "Regenerate the webhook" : "Create a webhook"}</Button>}
                    {mayManage && flow.webhookEnabled && <Button variant="ghost" onClick={() => void removeWebhook(flow)}>Remove the webhook</Button>}
                    {mayManage && <Button variant="ghost" disabled={flow.running} onClick={() => setConfirming({ flowId: flow.id, action: "remove" })}>Remove</Button>}
                  </div>
                  {role === "owner" && (flow.ownerToKeep ?? []).map((unkept) => {
                    // What keeping it agrees to: the step's own settings (secrets masked, as everywhere
                    // on this page), when it runs, and whose results it uses.
                    const step = flow.steps[unkept.step - 1];
                    const settings: KeyValueItem[] = Object.entries(step?.parameters ?? {}).map(([name, value]) => ({ id: name, label: humanize(name), value: settingText(value), mono: true }));
                    if (step?.when) settings.push({ id: "when", label: "Runs only when", value: `${step.when.value}${step.when.equals !== undefined ? ` is ${settingText(step.when.equals)}` : ""}`, mono: true });
                    return (
                      <div key={unkept.step} role="group" aria-label={`Step ${unkept.step}, waiting for you to keep it`}>
                        <Notice tone="warning" title="Not run until you keep a step" action={<Button variant="primary" disabled={flow.running} onClick={() => void keepStep(flow, unkept)}>Keep step {unkept.step}</Button>}>
                          <p>Step {unkept.step} ({unkept.title}) is one only you may run, and someone else put it in this automation. It runs as whoever starts the automation, so it waits for you to keep it as it is:</p>
                          {settings.length ? <KeyValue items={settings} /> : <p>It has no settings.</p>}
                          {unkept.reads?.length ? <p>It uses what {unkept.reads.join(", ")} found.</p> : null}
                        </Notice>
                      </div>
                    );
                  })}
                  {about === flow.id && error && <Notice tone="danger" live title="That did not work" onDismiss={() => setError(null)}>{error}</Notice>}
                  {about === flow.id && notice && !error && <Notice tone="success" live onDismiss={() => setNotice(null)}>{notice}</Notice>}
                  {webhook?.flowId === flow.id && (
                    <Notice tone="info" live title={`New webhook for ${webhook.name}`} onDismiss={() => setWebhook(null)} className="automations-webhook">
                      <p>A POST to this URL runs the flow. Copy it now: only its fingerprint is kept, so it cannot be shown again.</p>
                      <CodeBlock label="Webhook URL">{webhook.url}</CodeBlock>
                    </Notice>
                  )}
                  {confirming?.flowId === flow.id && (
                    <div role="group" aria-label={confirming.action === "remove" ? `Confirm removing ${flow.name}` : `Confirm regenerating the webhook for ${flow.name}`}>
                      <Notice
                        tone="warning"
                        title={confirming.action === "remove" ? `Remove ${flow.name}?` : `Regenerate the webhook for ${flow.name}?`}
                        action={<>
                          <Button onClick={() => setConfirming(null)}>Cancel</Button>
                          <Button variant="primary" disabled={confirming.action === "remove" && flow.running} onClick={() => { setConfirming(null); void (confirming.action === "remove" ? removeFlow(flow) : mintWebhook(flow)); }}>{confirming.action === "remove" ? "Remove it" : "Regenerate it"}</Button>
                        </>}
                      >
                        {confirming.action === "remove" ? "Its schedule, triggers and webhook stop with it. This cannot be undone." : "The current URL stops working at once; whatever calls it needs the new one."}
                      </Notice>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
    </Panel>
  );

  const shelfPanel = (
    <Panel className="automations-shelf" title="Ready to use" count={shelf.length} meta={suggestedShelf ? <><b>{suggestedShelf}</b> suggested for this server</> : undefined}>
      {shelf.length === 0 ? <EmptyState title="Nothing on the shelf">This BoxPilot offers no ready-made automations.</EmptyState> : (
        <ul className="automations-shelf__grid">
          {sortedShelf.map((item) => {
            const because = suggestions[item.slug ?? item.name] ?? null;
            const tier = shelfTier(item);
            const added = installed.has(item.name);
            return (
              <li key={item.name} className="automations-card" data-suggested={because && !added ? true : undefined}>
                <div className="automations-card__head">
                  <h3 className="automations-card__name">{item.name}</h3>
                  {tier && <Tag tier={tier} />}
                </div>
                {/* Why this server in particular wants it, in facts read from this server. */}
                {because && !added && <p className="automations-card__because ui-marked" data-status="warning"><span className="ui-mark" aria-hidden="true" />{because}</p>}
                <p className="automations-card__description">{item.description}</p>
                <p className="automations-card__steps">{stepsOf(item.steps)}</p>
                <div className="automations-card__foot">
                  {added
                    ? <StatusChip status="good">on your list</StatusChip>
                    : !viewer && <Button variant={because ? "primary" : "secondary"} aria-label={`Add ${item.name}`} onClick={() => void installFromShelf(item)}>Add</Button>}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </Panel>
  );

  return (
    <div className="automations-page">
      <PageHeader
        title="Automations"
        status={verdict}
        meta={flows ? <><b>{list.length}</b> {list.length === 1 ? "automation" : "automations"} · <b>{running}</b> running · <b>{scheduleList.length}</b> {scheduleList.length === 1 ? "schedule" : "schedules"}{webhooks ? <> · <b>{webhooks}</b> {webhooks === 1 ? "webhook" : "webhooks"}</> : null}</> : undefined}
        actions={<Button variant="ghost" onClick={() => { void refresh(); void schedules.refresh(); }}>Read again</Button>}
        about={<>
          <p>Chains of the operations you already trust, run in order as ordinary jobs under your account, with every step recorded. A step that fails stops the run; what already ran stands.</p>
          <p>Ready to use holds flows that already know what a home server gets wrong: add one and it is yours to edit. Schedules run a single operation hourly, daily or weekly, each run a job in Activity.</p>
        </>}
      />

      {loadError && <Notice tone="danger" live title="The automations could not be read" action={<Button onClick={() => void refresh()}>Try again</Button>}>{loadError}</Notice>}
      {error && (about === null || !list.some((flow) => flow.id === about)) && <Notice tone="danger" live title="That did not work" onDismiss={() => setError(null)}>{error}</Notice>}
      {notice && !error && (about === null || !list.some((flow) => flow.id === about)) && <Notice tone="success" live onDismiss={() => setNotice(null)}>{notice}</Notice>}

      <Tabs<Tab>
        label="Automations"
        urlParam="tab"
        className="automations-tabs"
        tabs={[
          { id: "flows", label: "Automations", count: flows ? list.length : undefined, status: failedFlows ? "danger" : undefined, statusLabel: failedFlows ? `${failedFlows} failed` : undefined },
          { id: "schedules", label: "Schedules", count: schedules.schedules ? scheduleList.length : undefined, status: failedSchedules ? "danger" : behind ? "warning" : undefined, statusLabel: failedSchedules ? `${failedSchedules} failed` : behind ? `${behind} behind` : undefined },
          { id: "shelf", label: "Ready to use", count: shelf.length || undefined, status: suggestedShelf ? "neutral" : undefined, statusLabel: suggestedShelf ? `${countOf(suggestedShelf, "suggestion")}` : undefined },
        ]}
      >
        {(current) => (current === "flows" ? flowPanel : current === "schedules" ? <SchedulesPanel csrfToken={csrfToken} role={role} serverTimezone={timezone} source={schedules} /> : shelfPanel)}
      </Tabs>

      {building && <FlowBuilder palette={palette} flows={list} onClose={() => setBuilding(false)} onSave={saveDraft} />}

      {runFlowOf && (
        <Sheet kicker={runFlowOf.running ? "This run" : "Last run"} title={runFlowOf.name} size="lg" onClose={() => setRunOf(null)}>
          <KeyValue layout="rows" items={[flowFacts(runFlowOf)[0]]} />
          {runFlowOf.lastJobIds.length === 0
            ? <p className="automations-quiet">The first step is being staged…</p>
            : (
              <ol className="automations-run">
                {runFlowOf.lastJobIds.map((jobId, index) => {
                  const step = runFlowOf.steps[index];
                  const title = step ? titleFor(step.operationId) : `step ${index + 1}`;
                  return (
                    <li key={jobId ?? `skipped-${index}`} className="automations-run__step">
                      <p className="automations-run__label">Step {index + 1}{step ? ` · ${title}${step.name ? ` (${step.name})` : ""}` : ""}{jobId === null ? " · did not run; the last-run line above says why" : ""}</p>
                      {jobId !== null && <JobLogView jobId={jobId} title={title} />}
                    </li>
                  );
                })}
              </ol>
            )}
        </Sheet>
      )}
    </div>
  );
}
