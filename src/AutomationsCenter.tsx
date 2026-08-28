import { useCallback, useEffect, useRef, useState } from "react";
import { JobLogView } from "./JobLogView";

/**
 * Automations (M13.2, ADR-002): ordered lists of registered operations, run as ordinary jobs.
 *
 * Two tiers on purpose. The shelf offers flows that already know what a home server gets wrong,
 * installed with one click and then editable like anything built by hand — a template that goes
 * read-only the moment it is touched teaches nothing. The builder underneath composes from the
 * step palette: every operation that needs no form, which is what keeps a v1 builder honest
 * instead of half a parameter editor.
 */
interface FlowStep { operationId: string; parameters?: Record<string, unknown>; name?: string; onFailure?: "stop" | "continue"; when?: { value: string; equals?: unknown }; retry?: number }
interface Flow {
  id: string; name: string; steps: FlowStep[]; createdBy: string;
  risk: "low" | "medium" | "high"; running: boolean;
  lastRunAt: string | null; lastResult: string | null; lastJobIds: Array<string | null>;
  frequency: "hourly" | "daily" | "weekly" | null; minute: number | null; hour: number | null; weekday: number | null;
  enabled: boolean; nextDueAt: string | null; triggerFlowId: string | null; webhookEnabled: boolean;
}

const weekdays = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const two = (value: number) => String(value).padStart(2, "0");
const cadenceLabel = (flow: Flow): string | null => {
  if (!flow.frequency) return null;
  if (flow.frequency === "hourly") return `every hour at :${two(flow.minute ?? 0)}`;
  if (flow.frequency === "daily") return `every day at ${two(flow.hour ?? 3)}:${two(flow.minute ?? 0)}`;
  return `every ${weekdays[flow.weekday ?? 0]} at ${two(flow.hour ?? 3)}:${two(flow.minute ?? 0)}`;
};
interface PaletteField { name: string; type: "string" | "number" | "boolean"; optional: boolean; enum: string[] | null; default: string | number | boolean | null }
interface PaletteStep { operationId: string; title: string; risk: string; description: string; fields: PaletteField[] }
interface DraftStep { operationId: string; onFailure: "stop" | "continue"; retry: number; parameters: Record<string, string> }
const humanize = (name: string) => name.replace(/([A-Z])/g, " $1").replace(/[._]/g, " ").replace(/^./, (c) => c.toUpperCase()).trim();

interface ShelfItem { slug: string; name: string; description: string; steps: FlowStep[] }

const riskCopy: Record<string, string> = {
  low: "runs with one click",
  medium: "each step runs as its own recorded job",
  high: "high",
};

export default function AutomationsCenter({ csrfToken }: { csrfToken: string }) {
  const [flows, setFlows] = useState<Flow[] | null>(null);
  const [palette, setPalette] = useState<PaletteStep[]>([]);
  const [shelf, setShelf] = useState<ShelfItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [draftName, setDraftName] = useState("");
  const [draftAfter, setDraftAfter] = useState("");
  const [draftSteps, setDraftSteps] = useState<DraftStep[]>([]);
  const [building, setBuilding] = useState(false);
  const pollTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  const refresh = useCallback(async () => {
    try {
      const response = await fetch("/api/v1/flows");
      if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error ?? "Could not read automations");
      const body = (await response.json()) as { flows: Flow[]; palette: PaletteStep[]; shelf?: ShelfItem[] };
      setFlows(body.flows);
      setPalette(body.palette);
      setShelf(body.shelf ?? []);
      setError(null);
      return body.flows;
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Could not read automations");
      return null;
    }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);

  // A run can outlive its own HTTP response (a proxy may give up on a long request long before
  // apt does), so the list is the source of truth while anything is running.
  useEffect(() => {
    const anyRunning = (flows ?? []).some((flow) => flow.running);
    if (anyRunning && !pollTimer.current) pollTimer.current = setInterval(() => void refresh(), 3000);
    if (!anyRunning && pollTimer.current) { clearInterval(pollTimer.current); pollTimer.current = null; }
    return () => { if (pollTimer.current) { clearInterval(pollTimer.current); pollTimer.current = null; } };
  }, [flows, refresh]);

  const titleFor = (operationId: string) => palette.find((step) => step.operationId === operationId)?.title ?? operationId;

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
    setError(null); setNotice(null);
    try {
      await post("/api/v1/flows", { name: item.name, steps: item.steps });
      setNotice(`${item.name} is on your list below. Open it any time; it is yours to edit.`);
      await refresh();
    } catch (requestError) { setError(requestError instanceof Error ? requestError.message : "Could not add the automation"); }
  };

  const runFlow = async (flow: Flow) => {
    setError(null); setNotice(`${flow.name} is running; each step appears in the Activity drawer as its own job.`);
    setFlows((current) => (current ?? []).map((entry) => (entry.id === flow.id ? { ...entry, running: true } : entry)));
    post(`/api/v1/flows/${encodeURIComponent(flow.id)}/run`)
      .catch((requestError) => setError(requestError instanceof Error ? requestError.message : "The run was refused"))
      .finally(() => void refresh());
  };

  const reschedule = async (flow: Flow, cadence: { frequency: string; minute: number; hour?: number; weekday?: number } | null) => {
    setError(null); setNotice(null);
    try { await post(`/api/v1/flows/${encodeURIComponent(flow.id)}`, { cadence }, "PUT"); await refresh(); }
    catch (requestError) { setError(requestError instanceof Error ? requestError.message : "Could not change the schedule"); }
  };

  const setEnabled = async (flow: Flow, enabled: boolean) => {
    setError(null); setNotice(null);
    try { await post(`/api/v1/flows/${encodeURIComponent(flow.id)}`, { enabled }, "PUT"); await refresh(); }
    catch (requestError) { setError(requestError instanceof Error ? requestError.message : "Could not change the schedule"); }
  };

  const mintWebhook = async (flow: Flow) => {
    setError(null); setNotice(null);
    try {
      const response = await fetch(`/api/v1/flows/${encodeURIComponent(flow.id)}/webhook`, { method: "POST", headers: { "X-BoxPilot-CSRF": csrfToken } });
      const body = (await response.json()) as { token?: string; path?: string; error?: string };
      if (!response.ok || !body.path) throw new Error(body.error ?? "Could not create the webhook");
      // The one time the URL exists outside the caller's hands: shown here, stored nowhere.
      setNotice(`POST ${window.location.origin}${body.path} fires ${flow.name}. Copy it now; only its fingerprint is kept, so it cannot be shown again.`);
      await refresh();
    } catch (requestError) { setError(requestError instanceof Error ? requestError.message : "Could not create the webhook"); }
  };

  const removeWebhook = async (flow: Flow) => {
    setError(null); setNotice(null);
    try { await post(`/api/v1/flows/${encodeURIComponent(flow.id)}/webhook`, undefined, "DELETE"); setNotice(`${flow.name}'s webhook no longer works.`); await refresh(); }
    catch (requestError) { setError(requestError instanceof Error ? requestError.message : "Could not remove the webhook"); }
  };

  const removeFlow = async (flow: Flow) => {
    setError(null); setNotice(null);
    try { await post(`/api/v1/flows/${encodeURIComponent(flow.id)}`, undefined, "DELETE"); await refresh(); }
    catch (requestError) { setError(requestError instanceof Error ? requestError.message : "Could not remove it"); }
  };

  const saveDraft = async () => {
    setError(null); setNotice(null);
    try {
      const steps = draftSteps.map((step) => {
        const fields = palette.find((entry) => entry.operationId === step.operationId)?.fields ?? [];
        const parameters: Record<string, unknown> = {};
        for (const field of fields) {
          const raw = step.parameters[field.name];
          if (raw === undefined || raw === "") continue;                 // an unset optional field is simply absent
          parameters[field.name] = field.type === "number" ? Number(raw) : field.type === "boolean" ? raw === "true" : raw;
        }
        return { operationId: step.operationId, parameters, ...(step.onFailure === "continue" ? { onFailure: "continue" as const } : {}), ...(step.retry > 0 ? { retry: step.retry } : {}) };
      });
      await post("/api/v1/flows", { name: draftName, steps, ...(draftAfter ? { triggerFlowId: draftAfter } : {}) });
      setDraftName(""); setDraftSteps([]); setDraftAfter(""); setBuilding(false);
      await refresh();
    } catch (requestError) { setError(requestError instanceof Error ? requestError.message : "Could not save the automation"); }
  };

  const installed = new Set((flows ?? []).map((flow) => flow.name));

  return (
    <div className="automations">
      {error && <div className="auth-error" role="alert">{error}</div>}
      {notice && !error && <p className="muted">{notice}</p>}

      {shelf.length > 0 && (
      <section className="panel">
        <header className="panel-header">
          <div>
            <strong>Ready to use</strong>
            <span>Automations that already know what a home server gets wrong. Add one and it is yours: same editor, same steps, nothing locked.</span>
          </div>
        </header>
        <div className="shelf-grid">
          {shelf.map((item) => (
            <article key={item.name} className="shelf-item">
              <strong>{item.name}</strong>
              <p className="muted">{item.description}</p>
              <p className="muted shelf-steps">{item.steps.map((step) => titleFor(step.operationId)).join(" → ")}</p>
              {installed.has(item.name)
                ? <span className="status-pill status-good">on your list</span>
                : <button className="secondary-button" type="button" onClick={() => void installFromShelf(item)}>Add</button>}
            </article>
          ))}
        </div>
      </section>
      )}

      <section className="panel">
        <header className="panel-header">
          <div>
            <strong>Your automations</strong>
            <span>Each one runs its steps in order as ordinary jobs, under your account, with every step recorded. A step that fails stops the run; what already ran stands.</span>
          </div>
          <button className="secondary-button" type="button" onClick={() => setBuilding((current) => !current)}>{building ? "Close the builder" : "Build your own"}</button>
        </header>

        {building && (
          <form className="flow-builder" onSubmit={(event) => { event.preventDefault(); void saveDraft(); }}>
            <label>Name<input aria-label="Automation name" maxLength={80} value={draftName} onChange={(event) => setDraftName(event.target.value)} placeholder="What it does, in your words" /></label>
            {(flows ?? []).length > 0 && (
              <label>Runs after (optional)
                <select aria-label="Runs after" value={draftAfter} onChange={(event) => setDraftAfter(event.target.value)}>
                  <option value="">Only when scheduled or run by hand</option>
                  {(flows ?? []).map((other) => <option key={other.id} value={other.id}>after {other.name} completes</option>)}
                </select>
              </label>
            )}
            <label>Add a step
              <select aria-label="Add a step" value="" onChange={(event) => { const chosen = event.target.value; if (chosen) setDraftSteps((current) => [...current, { operationId: chosen, onFailure: "stop", retry: 0, parameters: {} }]); }}>
                <option value="">Pick an operation…</option>
                {palette.map((step) => <option key={step.operationId} value={step.operationId}>{step.title} ({step.risk})</option>)}
              </select>
            </label>
            {draftSteps.length > 0 && (
              <ol className="flow-draft-steps">
                {draftSteps.map((step, index) => {
                  const fields = palette.find((entry) => entry.operationId === step.operationId)?.fields ?? [];
                  const setParam = (name: string, value: string) => setDraftSteps((current) => current.map((entry, at) => (at === index ? { ...entry, parameters: { ...entry.parameters, [name]: value } } : entry)));
                  return (
                    <li key={`${step.operationId}-${index}`}>
                      <div className="flow-draft-head">
                        <strong>{titleFor(step.operationId)}</strong>
                        <span>
                          <button className="text-button" type="button" disabled={index === 0} onClick={() => setDraftSteps((current) => { const next = [...current]; [next[index - 1], next[index]] = [next[index], next[index - 1]]; return next; })}>Up</button>
                          <button className="text-button" type="button" onClick={() => setDraftSteps((current) => current.filter((_, at) => at !== index))}>Remove</button>
                        </span>
                      </div>
                      {fields.length > 0 && (
                        <div className="flow-draft-fields">
                          {fields.map((field) => {
                            // A field with a fixed set of choices (declared enum, or yes/no for a
                            // boolean) renders as one select; everything else is a text or number box.
                            const choices = field.enum ?? (field.type === "boolean" ? ["true", "false"] : null);
                            const label = `${humanize(field.name)} for step ${index + 1}`;
                            return (
                              <label key={field.name}>{humanize(field.name)}{field.optional ? "" : " *"}
                                {choices
                                  ? <select aria-label={label} value={step.parameters[field.name] ?? ""} onChange={(event) => setParam(field.name, event.target.value)}>
                                      <option value="">choose…</option>
                                      {choices.map((option) => <option key={option} value={option}>{field.type === "boolean" ? (option === "true" ? "Yes" : "No") : option}</option>)}
                                    </select>
                                  : <input aria-label={label} type={field.type === "number" ? "number" : "text"} value={step.parameters[field.name] ?? ""} onChange={(event) => setParam(field.name, event.target.value)} />}
                              </label>
                            );
                          })}
                        </div>
                      )}
                      <div className="flow-draft-policy">
                        <select aria-label={`If step ${index + 1} fails`} value={step.onFailure} onChange={(event) => setDraftSteps((current) => current.map((entry, at) => (at === index ? { ...entry, onFailure: event.target.value as "stop" | "continue" } : entry)))}>
                          <option value="stop">if it fails: stop the run</option>
                          <option value="continue">if it fails: keep going</option>
                        </select>
                        <label className="flow-draft-retry">retry
                          <select aria-label={`Retries for step ${index + 1}`} value={String(step.retry)} onChange={(event) => setDraftSteps((current) => current.map((entry, at) => (at === index ? { ...entry, retry: Number(event.target.value) } : entry)))}>
                            {[0, 1, 2, 3].map((count) => <option key={count} value={count}>{count === 0 ? "no retry" : `${count}\u00d7`}</option>)}
                          </select>
                        </label>
                      </div>
                    </li>
                  );
                })}
              </ol>
            )}
            <div className="recovery-actions">
              <button className="primary-button" type="submit" disabled={!draftName.trim() || draftSteps.length === 0}>Save</button>
              <span className="muted">A field marked * is required. Whatever you set is checked when you save.</span>
            </div>
          </form>
        )}

        {flows === null ? <p className="muted">Reading…</p> : flows.length === 0 ? <p className="muted">Nothing yet. Add one from the shelf above, or build your own.</p> : (
          <div className="flow-list">
            {flows.map((flow) => (
              <article key={flow.id} className="flow-row">
                <div className="flow-row-main">
                  <strong>{flow.name}</strong>
                  <span className={`status-pill ${flow.risk === "low" ? "status-good" : "status-warning"}`}>{flow.risk} risk</span>
                  {flow.running && <span className="status-pill status-neutral">running</span>}
                </div>
                <p className="muted">{flow.steps.map((step) => titleFor(step.operationId)).join(" → ")} · {riskCopy[flow.risk]}</p>
                {flow.lastResult && (
                  <p className={flow.lastResult === "completed" || flow.lastResult.startsWith("completed (") || flow.lastResult.startsWith("running step") ? "muted" : "auth-error"}>
                    Last run{flow.lastRunAt ? ` ${new Date(flow.lastRunAt).toLocaleString()}` : ""}: {flow.lastResult}
                  </p>
                )}
                {(flow.running || flow.lastJobIds.length > 0) && (
                  <details className="flow-run-detail">
                    <summary>{flow.running ? "Watch this run" : "What the last run did"}</summary>
                    {flow.lastJobIds.length === 0
                      ? <p className="muted">The first step is being staged…</p>
                      : flow.lastJobIds.map((jobId, index) => (
                        <div key={jobId ?? `skipped-${index}`} className="flow-run-step">
                          <span className="eyebrow">Step {index + 1}{flow.steps[index] ? ` · ${titleFor(flow.steps[index].operationId)}${flow.steps[index].name ? ` (${flow.steps[index].name})` : ""}` : ""}{jobId === null ? " · did not run; the last-run line above says why" : ""}</span>
                          {jobId !== null && <JobLogView jobId={jobId} title={flow.steps[index] ? titleFor(flow.steps[index].operationId) : `step ${index + 1}`} />}
                        </div>
                      ))}
                  </details>
                )}
                {flow.frequency && (
                  <p className="muted">
                    Runs {cadenceLabel(flow)}{flow.enabled && flow.nextDueAt ? `; next ${new Date(flow.nextDueAt).toLocaleString()}` : ""}{flow.enabled ? "" : "; paused"}. Runs under your account, the same as pressing Run.
                  </p>
                )}
                {flow.webhookEnabled && (
                  <p className="muted">A webhook can fire this flow. The URL was shown once when it was created; regenerate it to get a new one.</p>
                )}
                {flow.triggerFlowId && (
                  <p className="muted">Runs after {flows?.find((other) => other.id === flow.triggerFlowId)?.name ?? "another flow"} completes, under its own creator's account.{flow.enabled ? "" : " Paused."}</p>
                )}
                <div className="recovery-actions">
                  <button className="primary-button" type="button" disabled={flow.running} onClick={() => void runFlow(flow)}>{flow.running ? "Running…" : "Run now"}</button>
                  {!flow.frequency && (
                    <button className="secondary-button" type="button" disabled={flow.running} onClick={() => void reschedule(flow, { frequency: "weekly", minute: 0, hour: 3, weekday: 0 })}>Run it every Sunday at 03:00</button>
                  )}
                  {flow.frequency && (
                    <button className="secondary-button" type="button" disabled={flow.running} onClick={() => void setEnabled(flow, !flow.enabled)}>{flow.enabled ? "Pause the schedule" : "Resume the schedule"}</button>
                  )}
                  {flow.frequency && (
                    <button className="text-button" type="button" disabled={flow.running} onClick={() => void reschedule(flow, null)}>Stop scheduling it</button>
                  )}
                  <button className="text-button" type="button" onClick={() => void mintWebhook(flow)}>{flow.webhookEnabled ? "Regenerate the webhook" : "Create a webhook"}</button>
                  {flow.webhookEnabled && <button className="text-button" type="button" onClick={() => void removeWebhook(flow)}>Remove the webhook</button>}
                  <button className="text-button" type="button" disabled={flow.running} onClick={() => void removeFlow(flow)}>Remove</button>
                </div>
              </article>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
