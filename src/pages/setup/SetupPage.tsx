import { useCallback, useEffect, useRef, useState } from "react";
import { countOf } from "../../data";
import { useShellHost } from "../../shell/TopBarSlot";
import { Button, EmptyState, Field, Notice, PageHeader, Panel, Progress, SecretInput, StatusChip, Tabs, Tag, appHue, mayStart, riskOf, useUrlParam, type RiskTier, type Status } from "../../ui";
import { Autoinstall } from "./Autoinstall";
import "./setup.css";

/*
 * Setup (M4.2, rebuilt in M33.12): the welcoming start of the product. Like Home's Launcher it
 * greets the server by name and puts the choices on large colour squares: what should this server
 * become? Each profile says what is already in place; choosing one lists its steps with their
 * live state and tier, and runs the rest in order as ordinary jobs. Medium-risk steps need one
 * confirmation for the batch; when approvals ask for the owner password it is asked once and
 * reused. The second tab prepares a new server's unattended install instead.
 */

interface Step { id: string; kind: string; title: string; status: "done" | "ready" | "blocked" | "unknown"; detail: string; job: { operationId: string; parameters: Record<string, unknown> } | null; schedule?: { operationId: string; parameters: Record<string, unknown>; frequency: string; minute: number; hour: number | null; weekday: number | null } }
interface Profile { id: string; name: string; icon: string; description: string; steps: Step[]; remaining: number; blocked: number }
interface SetupState { firstRun: boolean; installedApps: number; profiles: Profile[] }
type StepProgress = Record<string, { state: "pending" | "running" | "done" | "failed" | "skipped"; error?: string }>;

const modes = ["this", "new"] as const;
type Mode = (typeof modes)[number];
const tierOrder: RiskTier[] = ["low", "medium", "high"];
const sleep = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms));

const stepWords: Record<string, { status: Status; label: string }> = {
  done: { status: "good", label: "done" },
  running: { status: "warning", label: "running" },
  failed: { status: "danger", label: "failed" },
  blocked: { status: "danger", label: "blocked" },
  skipped: { status: "neutral", label: "skipped" },
  unknown: { status: "unknown", label: "unknown" },
  pending: { status: "neutral", label: "to do" },
};

/** The tier a batch of steps needs: its highest. */
function batchTier(steps: Step[]): RiskTier | undefined {
  const tiers = steps.map((step) => (step.job ? riskOf(step.job.operationId) : null)).filter((tier): tier is RiskTier => tier !== null);
  return tiers.length ? tierOrder[Math.max(...tiers.map((tier) => tierOrder.indexOf(tier)))] : undefined;
}

export interface SetupPageProps {
  csrfToken: string;
  /** Who is signed in: a viewer sees the profiles and runs nothing. */
  role?: string;
  onDone: () => void;
}

export default function SetupPage({ csrfToken, role = "owner", onDone }: SetupPageProps) {
  const host = useShellHost();
  const [setup, setSetup] = useState<SetupState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useUrlParam<Mode>("mode", modes, "this");
  const [selected, setSelected] = useState<string | null>(null);
  const [phase, setPhase] = useState<"choose" | "running" | "paused" | "finished">("choose");
  const [progress, setProgress] = useState<StepProgress>({});
  const [password, setPassword] = useState("");
  const [needPassword, setNeedPassword] = useState(false);
  const passwordRef = useRef("");
  const skipped = useRef<Set<string>>(new Set());
  const canRun = mayStart(role, "app.install");
  // Whether the page is still open. The run is this page's loop, not the server's: leaving the page
  // used to leave it going unseen, staging and approving each later step with the password it held,
  // and coming back offered to start the same steps again beside it. The job already running goes
  // on, on the server; nothing after it is started.
  const open = useRef(true);
  useEffect(() => {
    open.current = true;
    return () => { open.current = false; passwordRef.current = ""; };
  }, []);

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/v1/setup");
      if (!response.ok) throw new Error("Setup state is unavailable");
      const body = (await response.json()) as SetupState;
      if (!Array.isArray(body?.profiles)) throw new Error("Setup state arrived in a shape this page cannot read");
      setSetup(body);
      setError(null);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Setup state is unavailable");
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const headers = { "Content-Type": "application/json", "X-BoxPilot-CSRF": csrfToken };
  const profile = setup?.profiles.find((entry) => entry.id === selected) ?? null;
  const mark = (id: string, state: StepProgress[string]) => setProgress((current) => ({ ...current, [id]: state }));

  async function runStep(step: Step): Promise<"done" | "password" | "failed" | "left"> {
    if (!open.current) return "left";
    if (step.kind === "schedule" && step.schedule) {
      const response = await fetch("/api/v1/schedules", { method: "POST", headers, body: JSON.stringify(step.schedule) });
      if (!response.ok) { const body = (await response.json().catch(() => ({}))) as { error?: string }; mark(step.id, { state: "failed", error: body.error ?? `Schedule rejected (${response.status})` }); return "failed"; }
      return "done";
    }
    if (!step.job) return "done";
    const staged = await fetch(`/api/v1/operations/${encodeURIComponent(step.job.operationId)}/jobs`, { method: "POST", headers, body: JSON.stringify({ parameters: step.job.parameters }) });
    const stagedBody = (await staged.json().catch(() => ({}))) as { job?: { id: string }; error?: string };
    if (!staged.ok || !stagedBody.job) { mark(step.id, { state: "failed", error: stagedBody.error ?? `Could not prepare this step (server error ${staged.status})` }); return "failed"; }
    // Staged but not approved: it waits in Activity for whoever comes back, rather than running unseen.
    if (!open.current) return "left";
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
      if (!open.current) return "left";
    }
  }

  /**
   * The profile as the server sees it now, so a later step is judged on the state the earlier ones
   * left behind: installing KVM takes the libvirt step from blocked to ready, and the wizard used to
   * skip it and say "All done".
   */
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
      if (!open.current) return;
      mark(step.id, { state: "running" });
      const outcome = await runStep(plan.steps[index]);
      if (outcome === "left") return;
      if (outcome === "password") { mark(step.id, { state: "pending" }); setNeedPassword(true); setPhase("paused"); return; }
      if (outcome === "failed") { setPhase("paused"); return; }
      mark(step.id, { state: "done" });
    }
    setPhase("finished");
    void load();
  }

  const choose = (id: string) => { setSelected(id); setProgress({}); skipped.current = new Set(); setPhase("choose"); };
  const resume = () => { passwordRef.current = password; if (profile) void run(profile); };
  const retry = () => { for (const [id, entry] of Object.entries(progress)) if (entry.state === "failed") mark(id, { state: "pending" }); if (profile) void run(profile); };
  const skipFailed = () => { for (const [id, entry] of Object.entries(progress)) if (entry.state === "failed") { skipped.current.add(id); mark(id, { state: "skipped" }); } if (profile) void run(profile); };

  const ready = setup ? setup.profiles.filter((entry) => entry.remaining === 0).length : 0;
  const verdict = !setup ? (error ? { status: "unknown" as const, label: "Not read" } : { status: "unknown" as const, label: "Reading…" })
    : setup.firstRun ? { status: "neutral" as const, label: "Nothing set up yet" }
      : { status: "good" as const, label: countOf(setup.installedApps, "app installed", "apps installed") };

  const runnable = profile?.steps.filter((step) => step.status === "ready") ?? [];
  const settled = profile ? profile.steps.filter((step) => step.status === "done" || progress[step.id]?.state === "done" || progress[step.id]?.state === "skipped").length : 0;
  const tier = batchTier(runnable);

  return (
    <div className="setup-page">
      <PageHeader
        title="Setup"
        status={verdict}
        meta={setup ? <><b>{setup.profiles.length}</b> profiles · <b>{ready}</b> already in place · <b>{setup.installedApps}</b> {setup.installedApps === 1 ? "app" : "apps"} installed</> : undefined}
        about={<>
          <p>Pick what this server is for. Each profile is a list of ordinary steps (Docker, apps, automatic updates, backups on a schedule); Setup shows which are already done and runs only the rest, in order, as jobs you can follow in Activity.</p>
          <p>Prepare a new server writes the files for an unattended Ubuntu install on another machine that installs BoxPilot on first boot.</p>
        </>}
      />

      {error && <Notice tone="danger" live title="Setup state is unavailable" action={<Button onClick={() => void load()}>Try again</Button>}>{error}</Notice>}

      <Tabs<Mode> label="Setup" value={mode} onChange={setMode} tabs={[{ id: "this", label: "Set up this server" }, { id: "new", label: "Prepare a new server" }]}>
        {(current) => current === "new" ? <Autoinstall csrfToken={csrfToken} canGenerate={role === "owner" || role === "operator"} /> : !profile ? (
          <section className="setup-welcome" aria-labelledby="setup-greeting">
            <div className="setup-hero">
              <h2 id="setup-greeting" className="setup-hero__greeting">{setup?.firstRun === false ? `Add more to ${host ?? "this server"}` : `What should ${host ?? "this server"} become?`}</h2>
              <p className="setup-hero__line">Pick a profile. BoxPilot checks what is already here and runs only the rest, one approved job at a time.</p>
            </div>
            {setup && !setup.firstRun && <Notice tone="info" title={`${countOf(setup.installedApps, "app is", "apps are")} already installed`}>Profiles only add what is missing.</Notice>}
            {!setup && !error && <p className="setup-note">Checking what is already on this server…</p>}
            {setup && (
              <ul className="setup-profiles">
                {setup.profiles.map((entry) => {
                  const done = entry.remaining === 0 && entry.blocked === 0;
                  const state = done ? "Everything is in place" : `${countOf(entry.remaining, "step")} to run${entry.blocked ? ` · ${entry.blocked} blocked` : ""}`;
                  return (
                    <li key={entry.id}>
                      {/* Named by the profile and its state, not its emoji; described by what it brings. */}
                      <button type="button" className="setup-profile" onClick={() => choose(entry.id)} aria-label={`${entry.name}, ${state.toLowerCase()}`} aria-describedby={`setup-profile-${entry.id}`}>
                        <span className="setup-profile__square" data-hue={appHue(entry.id)} aria-hidden="true">{entry.icon}</span>
                        <span className="setup-profile__text">
                          <span className="setup-profile__name">{entry.name}</span>
                          <span className="setup-profile__description" id={`setup-profile-${entry.id}`}>{entry.description}</span>
                          <span className="setup-profile__state ui-marked" data-status={done ? "good" : entry.blocked ? "warning" : "neutral"}>
                            <span className="ui-mark" aria-hidden="true" />
                            {state}
                          </span>
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        ) : (
          <>
            <div className="setup-back"><Button variant="ghost" disabled={phase === "running"} onClick={() => setSelected(null)}>← All profiles</Button></div>
            <Panel className="setup-plan" title={profile.name} count={phase === "finished" ? { status: "good", label: "done" } : `${runnable.length} to run`}
              meta={`${settled} of ${profile.steps.length} in place`}
              actions={phase === "choose" && canRun ? (
                <Button variant="primary" risk={tier} disabled={runnable.length === 0} onClick={() => void run(profile)}>{runnable.length === 0 ? "Nothing to do" : `Install everything (${runnable.length})`}</Button>
              ) : phase === "finished" ? <Button variant="primary" onClick={onDone}>Go to Home</Button> : undefined}>
              <div className="setup-plan__head">
                <span className="setup-profile__square setup-profile__square--small" data-hue={appHue(profile.id)} aria-hidden="true">{profile.icon}</span>
                <p className="setup-note">{profile.description}</p>
              </div>
              {phase !== "choose" && <div className="setup-plan__progress"><Progress label={`${profile.name}: ${settled} of ${profile.steps.length} steps`} value={settled} max={profile.steps.length} detail={`${settled} of ${profile.steps.length}`} status={phase === "finished" ? "good" : phase === "paused" && !needPassword ? "danger" : undefined} /></div>}
              <ol className="setup-steps">
                {profile.steps.map((step) => {
                  const live = progress[step.id]?.state;
                  const words = stepWords[live ?? (step.status === "ready" ? "pending" : step.status)] ?? stepWords.pending;
                  const stepTier = step.job ? riskOf(step.job.operationId) : null;
                  return (
                    <li key={step.id} className="setup-step" data-status={words.status}>
                      <StatusChip status={words.status}>{words.label}</StatusChip>
                      <span className="setup-step__text">
                        <strong>{step.title}</strong>
                        <span className={progress[step.id]?.error ? "setup-step__error" : "setup-step__detail"}>{progress[step.id]?.error ?? step.detail}</span>
                      </span>
                      <span className="setup-step__tags">
                        {step.kind === "schedule" ? <Tag title="Adds a schedule; what it runs is approved as usual each time">schedule</Tag> : stepTier && step.status !== "done" ? <Tag tier={stepTier} /> : null}
                      </span>
                    </li>
                  );
                })}
              </ol>
              {runnable.length === 0 && phase === "choose" && <EmptyState title="Nothing to run">Everything in this profile is already in place, or waits on something outside it.</EmptyState>}
            </Panel>
            {phase === "running" && <Notice live tone="info" title="Running">Each step is a normal job; follow the details in Activity.</Notice>}
            {phase === "paused" && needPassword && (
              <Panel padded title="Approval">
                <form className="setup-password" onSubmit={(event) => { event.preventDefault(); resume(); }}>
                  <Field label="Owner password" hint="Your approval mode asks for it. Enter it once to approve the remaining steps.">
                    <SecretInput value={password} onValueChange={setPassword} autoComplete="current-password" required />
                  </Field>
                  <Button type="submit" variant="primary">Continue</Button>
                </form>
              </Panel>
            )}
            {phase === "paused" && !needPassword && (
              <Notice live tone="danger" title="A step failed" action={<><Button variant="primary" onClick={retry}>Retry</Button><Button onClick={skipFailed}>Skip and continue</Button></>}>
                Fix the cause (its job log is in Activity), then retry, or skip it and go on.
              </Notice>
            )}
            {phase === "finished" && <Notice live tone="success" title="All done">Anything skipped can be run later from its own page.</Notice>}
          </>
        )}
      </Tabs>
    </div>
  );
}
