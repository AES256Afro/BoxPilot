import { useCallback, useEffect, useRef, useState } from "react";
import AutoinstallGenerator from "./AutoinstallGenerator";

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
  const [mode, setMode] = useState<"this" | "new">("this");
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
    let unreadable = 0;
    for (;;) {
      const poll = await fetch(`/api/v1/jobs/${stagedBody.job.id}`);
      const body = (await poll.json().catch(() => ({}))) as { job?: { state: string; error: string | null }; error?: string };
      if (body.job?.state === "completed") return "done";
      if (body.job?.state === "failed") { mark(step.id, { state: "failed", error: body.job.error ?? "The job failed" }); return "failed"; }
      if (body.job?.state === "cancelled") { mark(step.id, { state: "failed", error: "The job was cancelled" }); return "failed"; }
      // A job that has gone (or a session that has ended) will never report a state: stop asking.
      if (!poll.ok || !body.job) {
        unreadable += 1;
        if (unreadable >= 5) { mark(step.id, { state: "failed", error: body.error ?? "BoxPilot stopped reporting on this job" }); return "failed"; }
      } else unreadable = 0;
      if (Date.now() - started > 45 * 60 * 1000) { mark(step.id, { state: "failed", error: "Timed out waiting for the job" }); return "failed"; }
      await sleep(2000);
    }
  }

  /** The profile as the server sees it right now, so a later step is judged on the state the
   * earlier ones left behind — not on the snapshot taken when the page opened. Installing KVM makes
   * the libvirt step go from blocked to ready, and the wizard used to skip it and say "All done". */
  async function currentProfile(id: string): Promise<Profile | null> {
    try {
      const response = await fetch("/api/v1/setup");
      if (!response.ok) return null;
      const fresh = (await response.json()) as SetupState;
      setSetup(fresh);
      return fresh.profiles.find((entry) => entry.id === id) ?? null;
    } catch { return null; }
  }

  async function run(from: Profile) {
    setPhase("running");
    setNeedPassword(false);
    let plan = from;
    for (let index = 0; index < plan.steps.length; index += 1) {
      const step = plan.steps[index];
      if (skipped.current.has(step.id) || progress[step.id]?.state === "done") continue;
      if (step.status === "done") continue;
      if (step.status !== "ready") {
        // Blocked or unknown: ask the server again before writing it off, since the step before
        // this one may have just unblocked it.
        const refreshed = await currentProfile(plan.id);
        const now = refreshed?.steps.find((entry) => entry.id === step.id) ?? null;
        if (refreshed) plan = refreshed;
        if (!now || now.status !== "ready") { mark(step.id, { state: "skipped" }); continue; }
        plan.steps[index] = now;
      }
      mark(step.id, { state: "running" });
      const outcome = await runStep(plan.steps[index]);
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

  const modeSwitch = (
    <div className="log-source-tabs setup-mode" role="tablist">
      <button type="button" role="tab" aria-selected={mode === "this"} className={mode === "this" ? "active" : ""} onClick={() => setMode("this")}>Set up this server</button>
      <button type="button" role="tab" aria-selected={mode === "new"} className={mode === "new" ? "active" : ""} onClick={() => setMode("new")}>Prepare a new server</button>
    </div>
  );
  if (mode === "new") return <div className="setup-wizard">{modeSwitch}<AutoinstallGenerator csrfToken={csrfToken} /></div>;

  if (!profile) {
    return (
      <div className="setup-wizard">
        {modeSwitch}
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
