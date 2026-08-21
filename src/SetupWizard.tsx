import { useCallback, useEffect, useRef, useState } from "react";

/**
 * First-run setup (M4.2): pick a profile, see which steps are already done, run the rest in
 * order through ordinary jobs. Medium-risk steps need one confirmation for the batch; under
 * Always-ask mode the owner password is asked once and reused.
 */

interface Step { id: string; kind: string; title: string; status: "done" | "ready" | "blocked" | "unknown"; detail: string; job: { operationId: string; parameters: Record<string, unknown> } | null; schedule?: { operationId: string; parameters: Record<string, unknown>; frequency: string; minute: number; hour: number | null; weekday: number | null } }
interface Profile { id: string; name: string; icon: string; description: string; steps: Step[]; remaining: number; blocked: number }
interface SetupState { firstRun: boolean; installedApps: number; profiles: Profile[] }
type Progress = Record<string, { state: "pending" | "running" | "done" | "failed" | "skipped"; error?: string }>;

const sleep = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms));

export default function SetupWizard({ csrfToken, onDone }: { csrfToken: string; onDone: () => void }) {
  const [setup, setSetup] = useState<SetupState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [phase, setPhase] = useState<"choose" | "running" | "paused" | "finished">("choose");
  const [progress, setProgress] = useState<Progress>({});
  const [password, setPassword] = useState("");
  const [needPassword, setNeedPassword] = useState(false);
  const passwordRef = useRef("");
  const skipped = useRef<Set<string>>(new Set());

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/v1/setup");
      if (!response.ok) throw new Error("Setup state is unavailable");
      setSetup((await response.json()) as SetupState);
      setError(null);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Setup state is unavailable");
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const headers = { "Content-Type": "application/json", "X-BoxPilot-CSRF": csrfToken };
  const profile = setup?.profiles.find((entry) => entry.id === selected) ?? null;
  const mark = (id: string, state: Progress[string]) => setProgress((current) => ({ ...current, [id]: state }));

  async function runStep(step: Step): Promise<"done" | "password" | "failed"> {
    if (step.kind === "schedule" && step.schedule) {
      const response = await fetch("/api/v1/schedules", { method: "POST", headers, body: JSON.stringify(step.schedule) });
      if (!response.ok) { const body = (await response.json().catch(() => ({}))) as { error?: string }; mark(step.id, { state: "failed", error: body.error ?? `Schedule rejected (${response.status})` }); return "failed"; }
      return "done";
    }
    if (!step.job) return "done";
    const staged = await fetch(`/api/v1/operations/${encodeURIComponent(step.job.operationId)}/jobs`, { method: "POST", headers, body: JSON.stringify({ parameters: step.job.parameters }) });
    const stagedBody = (await staged.json().catch(() => ({}))) as { job?: { id: string }; error?: string };
    if (!staged.ok || !stagedBody.job) { mark(step.id, { state: "failed", error: stagedBody.error ?? `Could not stage (${staged.status})` }); return "failed"; }
    const approve = await fetch(`/api/v1/jobs/${stagedBody.job.id}/approve`, { method: "POST", headers, body: JSON.stringify(passwordRef.current ? { password: passwordRef.current } : {}) });
    if (approve.status === 401) return "password";
    if (!approve.ok) { const body = (await approve.json().catch(() => ({}))) as { error?: string }; mark(step.id, { state: "failed", error: body.error ?? `Approval failed (${approve.status})` }); return "failed"; }
    const started = Date.now();
    for (;;) {
      const poll = await fetch(`/api/v1/jobs/${stagedBody.job.id}`);
      const body = (await poll.json().catch(() => ({}))) as { job?: { state: string; error: string | null } };
      if (body.job?.state === "completed") return "done";
      if (body.job?.state === "failed") { mark(step.id, { state: "failed", error: body.job.error ?? "The job failed" }); return "failed"; }
      if (Date.now() - started > 45 * 60 * 1000) { mark(step.id, { state: "failed", error: "Timed out waiting for the job" }); return "failed"; }
      await sleep(2000);
    }
  }

  async function run(from: Profile) {
    setPhase("running");
    setNeedPassword(false);
    for (const step of from.steps) {
      if (step.status !== "ready" || skipped.current.has(step.id) || progress[step.id]?.state === "done") continue;
      mark(step.id, { state: "running" });
      const outcome = await runStep(step);
      if (outcome === "password") { mark(step.id, { state: "pending" }); setNeedPassword(true); setPhase("paused"); return; }
      if (outcome === "failed") { setPhase("paused"); return; }
      mark(step.id, { state: "done" });
    }
    setPhase("finished");
    void load();
  }

  const resume = () => { passwordRef.current = password; if (profile) void run(profile); };
  const skipFailed = () => { for (const [id, entry] of Object.entries(progress)) if (entry.state === "failed") { skipped.current.add(id); mark(id, { state: "skipped" }); } if (profile) void run(profile); };

  if (error) return <section className="panel"><div className="auth-error" role="alert">{error}</div></section>;
  if (!setup) return <section className="panel"><p style={{ padding: 16 }}>Checking what is already on this server…</p></section>;

  if (!profile) {
    return (
      <div className="setup-wizard">
        {!setup.firstRun && <p className="muted">This server already has {setup.installedApps} app{setup.installedApps === 1 ? "" : "s"} installed. Profiles only add what is missing.</p>}
        <div className="dashboard-apps">
          {setup.profiles.map((entry) => (
            <article key={entry.id} className="dashboard-app">
              <button type="button" className="dashboard-app-name" onClick={() => { setSelected(entry.id); setProgress({}); skipped.current = new Set(); setPhase("choose"); }}>
                <strong>{entry.icon} {entry.name}</strong>
              </button>
              <span className="muted">{entry.description}</span>
              <span className="muted">{entry.remaining === 0 ? "Everything in this profile is already in place." : `${entry.remaining} step${entry.remaining === 1 ? "" : "s"} to run`}{entry.blocked ? ` · ${entry.blocked} blocked` : ""}</span>
            </article>
          ))}
        </div>
      </div>
    );
  }

  const runnable = profile.steps.filter((step) => step.status === "ready");
  return (
    <div className="setup-wizard">
      <section className="panel">
        <header className="panel-header">
          <div><strong>{profile.icon} {profile.name}</strong><span>{profile.description}</span></div>
          {phase === "choose" && <div className="recovery-actions"><button className="text-button" type="button" onClick={() => setSelected(null)}>Back</button><button className="primary-button" type="button" disabled={runnable.length === 0} onClick={() => void run(profile)}>{runnable.length === 0 ? "Nothing to do" : `Install everything (${runnable.length})`}</button></div>}
          {phase === "finished" && <button className="primary-button" type="button" onClick={onDone}>Go to overview</button>}
        </header>
        <ol className="setup-steps">
          {profile.steps.map((step) => {
            const live = progress[step.id]?.state;
            const label: string = live ?? (step.status === "done" ? "done" : step.status === "blocked" ? "blocked" : step.status === "unknown" ? "unknown" : "pending");
            const tone = label === "done" ? "good" : label === "failed" || label === "blocked" ? "danger" : label === "running" ? "warning" : "neutral";
            return (
              <li key={step.id} className="setup-step">
                <span className={`status-pill status-${tone}`}>{label}</span>
                <div><strong>{step.title}</strong><span className="muted">{progress[step.id]?.error ?? step.detail}</span></div>
              </li>
            );
          })}
        </ol>
        {phase === "running" && <div className="surface-notice" role="status">Running… each step is a normal job; follow the details in the Activity drawer.</div>}
        {phase === "paused" && needPassword && (
          <form className="recovery-actions" onSubmit={(event) => { event.preventDefault(); resume(); }}>
            <span className="muted">Your approval mode asks for the owner password. Enter it once to approve the remaining steps.</span>
            <input aria-label="Owner password" type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} required />
            <button className="primary-button" type="submit">Continue</button>
          </form>
        )}
        {phase === "paused" && !needPassword && (
          <div className="recovery-actions">
            <span className="muted">A step failed. Fix the cause (its job log is in the Activity drawer), then retry, or skip it and continue.</span>
            <button className="primary-button" type="button" onClick={() => { for (const [id, entry] of Object.entries(progress)) if (entry.state === "failed") mark(id, { state: "pending" }); void run(profile); }}>Retry</button>
            <button className="secondary-button" type="button" onClick={skipFailed}>Skip and continue</button>
          </div>
        )}
        {phase === "finished" && <div className="surface-notice" role="status">All done. Anything skipped can be run later from its own page.</div>}
      </section>
    </div>
  );
}
