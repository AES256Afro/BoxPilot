import { useCallback, useEffect, useMemo, useState } from "react";

interface Prerequisite {
  id: string;
  group: string;
  name: string;
  status: "ready" | "missing" | "conflict" | "repairable";
  summary: string;
  repair: { kind: string; description: string } | null;
}

interface JobStep {
  name: string;
  state: string;
  detail: string;
  createdAt: string;
}

interface Job {
  id: string;
  title: string;
  type: string;
  state: string;
  risk: string;
  error: string | null;
  steps: JobStep[];
  recovery: { reason?: string; manual?: string };
}

async function readJson<T>(response: Response): Promise<T> {
  const body = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(body.error ?? `Request failed with status ${response.status}`);
  return body;
}

export default function RepairCenter({ csrfToken }: { csrfToken: string }) {
  const [checks, setChecks] = useState<Prerequisite[]>([]);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [password, setPassword] = useState("");
  const [pending, setPending] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [prerequisites, jobList] = await Promise.all([
        readJson<{ checks: Prerequisite[] }>(await fetch("/api/v1/operations/prerequisites")),
        readJson<{ jobs: Job[] }>(await fetch("/api/v1/jobs?limit=25")),
      ]);
      setChecks(prerequisites.checks);
      setJobs(jobList.jobs);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Unable to inspect prerequisites");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const awaitingApproval = useMemo(() => jobs.find((job) => job.state === "awaiting_approval"), [jobs]);

  const createCanary = async () => {
    setPending(true);
    setError(null);
    try {
      await readJson(await fetch("/api/v1/operations/canary", { method: "POST", headers: { "X-BoxPilot-CSRF": csrfToken } }));
      await refresh();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Unable to create canary job");
    } finally {
      setPending(false);
    }
  };

  const approve = async () => {
    if (!awaitingApproval) return;
    setPending(true);
    setError(null);
    try {
      await readJson(await fetch(`/api/v1/jobs/${awaitingApproval.id}/approve`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-BoxPilot-CSRF": csrfToken },
        body: JSON.stringify({ password }),
      }));
      setPassword("");
      await refresh();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Job approval failed");
    } finally {
      setPending(false);
    }
  };

  const ready = checks.filter((item) => item.status === "ready").length;

  return (
    <div className="repair-page">
      <section className="repair-readiness">
        <div><span className="eyebrow">Live prerequisite inventory</span><strong>{loading ? "Inspecting Bigbox..." : `${ready} of ${checks.length} checks ready`}</strong><p>Missing and conflicting requirements are reported independently, so one failed collector does not hide the others.</p></div>
        <button className="secondary-button" type="button" onClick={() => void refresh()} disabled={loading}>{loading ? "Inspecting..." : "Run inspection"}</button>
      </section>

      {error && <div className="auth-error" role="alert">{error}</div>}

      <div className="repair-layout">
        <section className="panel repair-checks">
          <header className="panel-header"><div><strong>Prerequisites</strong><span>Read-only live checks</span></div></header>
          {checks.map((item) => (
            <article className="repair-check" key={item.id}>
              <span className={`repair-state repair-${item.status}`}>{item.status}</span>
              <div><small>{item.group}</small><strong>{item.name}</strong><p>{item.summary}</p>{item.repair && <em>{item.repair.description}</em>}</div>
            </article>
          ))}
        </section>

        <aside className="panel helper-canary">
          <span className="eyebrow">{awaitingApproval ? "Approval desk" : "Operations Core canary"}</span>
          <h3>{awaitingApproval ? awaitingApproval.title : "Prove the restricted helper"}</h3>
          <p>{awaitingApproval ? "Review the recorded preflight and recovery steps below, then reauthenticate to execute this exact typed job." : "This job uses the real durable workflow and local Unix socket. Its allowlisted operation cannot mutate the host."}</p>
          {!awaitingApproval ? (
            <button className="primary-button" type="button" onClick={() => void createCanary()} disabled={pending}>Create verification job</button>
          ) : (
            <div className="approval-box">
              <strong>Approval required</strong>
              <span>Re-enter your owner password. It is verified in memory and never stored in the job.</span>
              <input aria-label="Approval password" type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} />
              <button className="primary-button" type="button" onClick={() => void approve()} disabled={pending || password.length < 12}>{pending ? "Running..." : "Approve and verify"}</button>
            </div>
          )}
        </aside>
      </div>

      <section className="panel job-history">
        <header className="panel-header"><div><strong>Durable jobs</strong><span>Plans, approvals, execution, and verification survive service restarts</span></div></header>
        {jobs.length === 0 ? <div className="log-empty">No Operations Core jobs have been created.</div> : jobs.map((job) => (
          <details className="job-row" key={job.id} open={job === jobs[0]}>
            <summary><div><strong>{job.title}</strong><span>{job.risk} risk | {job.steps.length} recorded steps</span></div><span className={`status-pill status-${job.state === "completed" ? "good" : job.state === "failed" ? "warning" : "neutral"}`}>{job.state.replaceAll("_", " ")}</span></summary>
            <div className="job-steps">{job.steps.map((step, index) => <div key={`${step.createdAt}-${index}`}><span>{step.state}</span><strong>{step.name}</strong><p>{step.detail}</p></div>)}</div>
            {job.error && <p className="job-error">{job.error}</p>}
            {job.recovery.manual && <p className="job-recovery"><strong>Recovery:</strong> {job.recovery.manual}</p>}
          </details>
        ))}
      </section>
    </div>
  );
}
