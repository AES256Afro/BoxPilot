import { useEffect, useRef, useState } from "react";
import { followJobOutput, terminalJobStates, type Job } from "./operations";
import { readJson } from "./http";
import { jobOutputText } from "./jobOutputText";

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
  const [goneId, setGoneId] = useState<string | null>(null);
  const [jobError, setJobError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const job = given ?? (fetched?.id === jobId ? fetched : null);
  const id = given?.id ?? jobId ?? null;

  // Only the id-based form fetches; a caller holding the job already keeps it fresh itself.
  useEffect(() => {
    if (given || !jobId) return undefined;
    let cancelled = false;
    const controller = new AbortController();
    setJobError(null); setGoneId(null);
    let timer: ReturnType<typeof setTimeout> | null = null;
    let deadline: ReturnType<typeof setTimeout> | null = null;
    const read = async () => {
      deadline = setTimeout(() => controller.abort(), 15_000);
      try {
        const response = await fetch(`/api/v1/jobs/${encodeURIComponent(jobId)}`, { signal: controller.signal });
        if (response.status === 404) { if (!cancelled) setGoneId(jobId); return; }
        const body = await readJson<{ job: Job }>(response);
        if (!body.job || body.job.id !== jobId || !Array.isArray(body.job.steps)) throw new Error("The job response is incomplete. Try again.");
        if (cancelled) return;
        setFetched(body.job);
        if (!terminalJobStates.has(body.job.state)) timer = setTimeout(() => void read(), 2000);
      } catch { if (!cancelled) setJobError("This job could not be refreshed. Try again to read its current state."); }
      finally { if (deadline) clearTimeout(deadline); }
    };
    void read();
    return () => { cancelled = true; controller.abort(); if (timer) clearTimeout(timer); if (deadline) clearTimeout(deadline); };
  }, [given, jobId, retry]);

  const [output, setOutput] = useState("");
  const [outputError, setOutputError] = useState<string | null>(null);
  const [readingOutput, setReadingOutput] = useState(true);
  const outputRef = useRef<HTMLPreElement | null>(null);
  const finished = job ? terminalJobStates.has(job.state) : false;

  useEffect(() => {
    if (!id || !job) return undefined;
    setOutput(""); setOutputError(null); setReadingOutput(finished);
    if (finished) {
      let cancelled = false;
      const controller = new AbortController();
      const deadline = setTimeout(() => controller.abort(), 15_000);
      fetch(`/api/v1/jobs/${encodeURIComponent(id)}/output`, { signal: controller.signal })
        .then((response) => readJson<{ output: string }>(response))
        .then((body) => { if (typeof body.output !== "string") throw new Error("incomplete output"); if (!cancelled) setOutput(jobOutputText("", body.output)); })
        .catch(() => { if (!cancelled) setOutputError("Saved output could not be read. Try again; this does not mean the job recorded no output."); })
        .finally(() => { clearTimeout(deadline); if (!cancelled) setReadingOutput(false); });
      return () => { cancelled = true; clearTimeout(deadline); controller.abort(); };
    }
    setOutput("");
    // The stream appends fragments; asking returns the whole log, which replaces. Appending both
    // duplicated every line whenever the stream could not get through a buffering proxy.
    return followJobOutput(id, { onOutput: (text, append) => setOutput((current) => jobOutputText(current, text, append)), onState: () => {} });
    // Re-follow only when the job or its finished-ness changes, not on every step update.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, job !== null, finished, retry]);

  useEffect(() => { if (outputRef.current) outputRef.current.scrollTop = outputRef.current.scrollHeight; }, [output]);

  const retryButton = <button className="secondary-button" type="button" onClick={() => setRetry((value) => value + 1)}>Try reading again</button>;
  if (id && goneId === id) return <p className="muted">{title ?? "This job"} is no longer in the history, which keeps the last 500 jobs for 90 days.</p>;
  if (!job) return jobError ? <div role="alert"><p>{jobError}</p>{retryButton}</div> : <p className="muted">Reading…</p>;

  return (
    <div className="activity-detail">
      {jobError && <div role="alert"><p>{jobError}</p>{retryButton}</div>}
      {job.steps.length > 0 && (
        <ul className="activity-steps">
          {job.steps.map((step, index) => (
            <li key={`${step.name}-${index}`}><strong>{step.name}</strong> · {step.state} · {step.detail}</li>
          ))}
        </ul>
      )}
      {job.error && <div className="auth-error" role="alert">{job.error}</div>}
      {outputError && <div role="alert"><p>{outputError}</p>{retryButton}</div>}
      {readingOutput && <p className="muted">Reading saved output...</p>}
      {(output || !finished) && (
        <div className="job-terminal">
          <div className="job-terminal-bar"><span>{finished ? "Output" : "Live output"}</span></div>
          <pre ref={outputRef} aria-label={`Output for ${title ?? job.title}`}>{output || "Waiting for output..."}</pre>
        </div>
      )}
      {finished && !output && !job.error && !outputError && !readingOutput && <p className="muted">This job recorded no output.</p>}
    </div>
  );
}
