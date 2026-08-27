import { useEffect, useRef, useState } from "react";
import { followJobOutput, terminalJobStates, type Job } from "./operations";

/**
 * The terminal view of one job, usable from anywhere an action is shown.
 *
 * Every operation already writes its output to the same place; what was missing was the option to
 * look at it from wherever the action lives — an automation's step, a schedule's last run, an app
 * card's update — rather than only the Activity drawer. This is that option, as one component:
 * give it a job, or just a job id and it fetches the rest. Running jobs stream; finished ones show
 * what was recorded; a job that has aged out of the history says so instead of showing nothing.
 */
export function JobLogView({ job: given, jobId, title }: { job?: Job; jobId?: string; title?: string }) {
  const [fetched, setFetched] = useState<Job | null>(null);
  const [gone, setGone] = useState(false);
  const job = given ?? fetched;
  const id = given?.id ?? jobId ?? null;

  // Only the id-based form fetches; a caller holding the job already keeps it fresh itself.
  useEffect(() => {
    if (given || !jobId) return undefined;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const read = async () => {
      try {
        const response = await fetch(`/api/v1/jobs/${encodeURIComponent(jobId)}`);
        if (response.status === 404) { if (!cancelled) setGone(true); return; }
        if (!response.ok) return;
        const body = (await response.json()) as { job: Job };
        if (cancelled) return;
        setFetched(body.job);
        if (!terminalJobStates.has(body.job.state)) timer = setTimeout(() => void read(), 2000);
      } catch { /* the output fetch below reports its own trouble */ }
    };
    void read();
    return () => { cancelled = true; if (timer) clearTimeout(timer); };
  }, [given, jobId]);

  const [output, setOutput] = useState("");
  const outputRef = useRef<HTMLPreElement | null>(null);
  const finished = job ? terminalJobStates.has(job.state) : false;

  useEffect(() => {
    if (!id || !job) return undefined;
    if (finished) {
      let cancelled = false;
      fetch(`/api/v1/jobs/${encodeURIComponent(id)}/output`)
        .then((response) => (response.ok ? (response.json() as Promise<{ output: string }>) : Promise.reject(new Error("unavailable"))))
        .then((body) => { if (!cancelled) setOutput(body.output ?? ""); })
        .catch(() => { if (!cancelled) setOutput(""); });
      return () => { cancelled = true; };
    }
    setOutput("");
    // The stream appends fragments; asking returns the whole log, which replaces. Appending both
    // duplicated every line whenever the stream could not get through a buffering proxy.
    return followJobOutput(id, { onOutput: (text, append) => setOutput((current) => (append ? current + text : text)), onState: () => {} });
    // Re-follow only when the job or its finished-ness changes, not on every step update.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, job !== null, finished]);

  useEffect(() => { if (outputRef.current) outputRef.current.scrollTop = outputRef.current.scrollHeight; }, [output]);

  if (gone) return <p className="muted">{title ?? "This job"} is no longer in the history, which keeps the last 500 jobs for 90 days.</p>;
  if (!job) return <p className="muted">Reading…</p>;

  return (
    <div className="activity-detail">
      {job.steps.length > 0 && (
        <ul className="activity-steps">
          {job.steps.map((step, index) => (
            <li key={`${step.name}-${index}`}><strong>{step.name}</strong> · {step.state} · {step.detail}</li>
          ))}
        </ul>
      )}
      {job.error && <div className="auth-error" role="alert">{job.error}</div>}
      {(output || !finished) && (
        <div className="job-terminal">
          <div className="job-terminal-bar"><span>{finished ? "Output" : "Live output"}</span></div>
          <pre ref={outputRef} aria-label={`Output for ${title ?? job.title}`}>{output || "Waiting for output..."}</pre>
        </div>
      )}
      {finished && !output && !job.error && <p className="muted">This job recorded no output.</p>}
    </div>
  );
}
