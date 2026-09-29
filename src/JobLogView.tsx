import { useEffect, useState } from "react";
import { followJobOutput, terminalJobStates, type Job, type JobStep } from "./operations";
import { readJson } from "./http";
import { jobOutputText } from "./jobOutputText";
import { JobWarnings } from "./JobWarnings";
import { JobTimeoutNotice, errorIsTheTimeout } from "./JobTimeout";
import { ranAgain } from "./jobStatus";
import { Button } from "./ui/Button";
import { CodeBlock } from "./ui/CodeBlock";
import { Notice } from "./ui/Notice";
import type { Status } from "./ui/types";
import "./shell/jobs.css";

/** How a step ended, as a mark: done, failed, needs the owner, or still going. */
function stepStatus(step: JobStep): Status {
  if (step.state === "completed") return "good";
  if (step.state === "failed") return "danger";
  if (step.state === "required" || step.state === "staged") return "warning";
  return "neutral";
}

/**
 * The terminal view of one job, usable from anywhere an action is shown (M33.13 in the console's
 * look: the steps as rows with their marks, the job's error and notices as the kit's notices, the
 * output in a CodeBlock).
 *
 * Every operation already writes its output to the same place; what was missing was the option to
 * look at it from wherever the action lives — an automation's step, a schedule's last run, an app
 * card's update — rather than only the Activity drawer. This is that option, as one component:
 * give it a job, or just a job id and it fetches the rest. Running jobs stream; finished ones show
 * what was recorded; a job that has aged out of the history says so instead of showing nothing.
 */
export function JobLogView({ job: given, jobId, title, onMoreTime }: { job?: Job; jobId?: string; title?: string; onMoreTime?: (job: Job) => void }) {
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
  const finished = job ? terminalJobStates.has(job.state) : false;
  const logUnreadable = Boolean(job?.steps.some((step) => step.name === "log" && step.state === "failed"));

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

  const retryButton = <Button onClick={() => setRetry((value) => value + 1)}>Try reading again</Button>;
  if (id && goneId === id) return <p className="jobs-quiet">{title ?? "This job"} is no longer in the history, which keeps the last 500 jobs for 90 days.</p>;
  if (!job) return jobError ? <Notice tone="danger" live action={retryButton}>{jobError}</Notice> : <p className="jobs-quiet">Reading…</p>;

  const name = title ?? job.title;
  const waiting = job.state === "awaiting_approval";
  return (
    <div className="jobs-log">
      {jobError && <Notice tone="danger" live action={retryButton}>{jobError}</Notice>}
      {job.steps.length > 0 && (
        <ol className="jobs-steps" aria-label={`Steps of ${name}`}>
          {job.steps.map((step, index) => (
            <li key={`${step.name}-${index}`} className="jobs-step ui-marked" data-status={stepStatus(step)}>
              <span className="ui-mark jobs-step__mark" aria-hidden="true" />
              <span className="jobs-step__name">{step.name}</span>
              <span className="jobs-step__state">{step.state}</span>
              <span className="jobs-step__detail">{step.detail}</span>
            </li>
          ))}
        </ol>
      )}
      {/* A restart cut this run off and BoxPilot already ran it again (M30.2): "check what it changed
          before retrying" is the wrong advice then, and red is the wrong colour. */}
      {ranAgain(job)
        ? <Notice tone="info" live>A BoxPilot restart cut this run off, so BoxPilot ran it again by itself. The newer entry for it in Activity says how that went.</Notice>
        : job.error && !errorIsTheTimeout(job) && <Notice tone="danger" live>{job.error}</Notice>}
      {job.recovery?.rerunOf && <p className="jobs-quiet">BoxPilot ran this again by itself after a restart cut the first run off.</p>}
      <JobTimeoutNotice job={job} onMoreTime={onMoreTime ? () => onMoreTime(job) : undefined} />
      <JobWarnings result={job.result} />
      {outputError && <Notice tone="danger" live action={retryButton}>{outputError}</Notice>}
      {readingOutput && <p className="jobs-quiet">Reading saved output...</p>}
      {/* A staged job has run nothing yet (M36): an empty "Live output" read as if it were stuck. */}
      {waiting && !output && <p className="jobs-quiet">Nothing has run yet: it waits for someone to approve it.</p>}
      {(output || (!finished && !waiting)) && (
        <CodeBlock
          label={`Output for ${name}`}
          meta={finished ? "saved" : "live"}
          follow={!finished}
          empty="Waiting for output..."
          className="jobs-output"
        >
          {output}
        </CodeBlock>
      )}
      {/* M30.1: an empty log is not "no output" when BoxPilot could not open the file the helper wrote. */}
      {finished && !output && !outputError && !readingOutput && logUnreadable && <Notice tone="danger" live>BoxPilot could not open this job's output, so none is shown. The log step above says why.</Notice>}
      {finished && !output && !job.error && !outputError && !readingOutput && !logUnreadable && <p className="jobs-quiet">This job recorded no output.</p>}
    </div>
  );
}
