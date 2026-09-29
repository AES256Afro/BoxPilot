import { useEffect, useId, useRef, useState } from "react";
import { jobOutputText } from "../jobOutputText";
import { jobStatus } from "../jobStatus";
import { readJson } from "../http";
import { followJobOutput, terminalJobStates, type Job } from "../operations";
import { CodeBlock } from "./CodeBlock";
import { Progress } from "./Progress";
import { StatusChip } from "./StatusChip";
import { cx, type Status } from "./types";

export interface JobProgressProps {
  /** The job to follow, as staging or approving it returned. */
  jobId: string;
  /** What the job is doing, in the owner's words: "Restart docker.service". The job's own title otherwise. */
  title?: string;
  /** Called once when the job finishes, however it ended, with the finished job. */
  onDone?: (job: Job) => void;
  /** Show the output under the bar from the start, rather than behind "Show output". */
  showOutput?: boolean;
  /** How often the job's state is read, in milliseconds. */
  pollMs?: number;
  className?: string;
}

const toneOf = (tone: string): Status => (tone === "status-good" ? "good" : tone === "status-danger" ? "danger" : tone === "status-warning" ? "warning" : "neutral");

/** "41s", "1m 12s", "3h 01m" from milliseconds, as the job queue says it. */
function took(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

/**
 * One job, inline where its action was pressed (M33.8): its state in Activity's words, a bar that
 * moves while it runs, the newest line of its output, and the whole output behind a toggle. It
 * reads the job the way the job log does, over the same output stream (followJobOutput), so it
 * shows what Activity shows. Nothing here approves or cancels: that stays with the approval dialog
 * and Activity.
 */
export function JobProgress({ jobId, title, onDone, showOutput = false, pollMs = 2000, className }: JobProgressProps) {
  const [job, setJob] = useState<Job | null>(null);
  const [gone, setGone] = useState(false);
  const [output, setOutput] = useState("");
  const [open, setOpen] = useState(showOutput);
  const outputId = useId();
  const done = useRef(onDone);
  done.current = onDone;
  const finished = job ? terminalJobStates.has(job.state) : false;

  // The job's state, read until it finishes.
  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let reported = false;
    const read = async () => {
      try {
        const response = await fetch(`/api/v1/jobs/${encodeURIComponent(jobId)}`);
        if (response.status === 404) { if (live) setGone(true); return; }
        const { job: next } = await readJson<{ job: Job }>(response);
        if (!live) return;
        setJob(next);
        if (terminalJobStates.has(next.state)) {
          if (!reported) { reported = true; done.current?.(next); }
          return;
        }
      } catch {
        // A read that fails is tried again on the next tick: the job itself goes on regardless.
      }
      if (live) timer = setTimeout(() => void read(), pollMs);
    };
    void read();
    return () => { live = false; if (timer) clearTimeout(timer); };
  }, [jobId, pollMs]);

  // Its output: the live stream while it runs, the saved log once it has finished.
  useEffect(() => {
    if (!job) return undefined;
    if (finished) {
      let live = true;
      fetch(`/api/v1/jobs/${encodeURIComponent(jobId)}/output`)
        .then((response) => (response.ok ? response.json() as Promise<{ output?: string }> : null))
        .then((body) => { if (live && typeof body?.output === "string") setOutput(jobOutputText("", body.output)); })
        .catch(() => undefined);
      return () => { live = false; };
    }
    if (job.state === "awaiting_approval") return undefined;
    return followJobOutput(jobId, { onOutput: (text, append) => setOutput((current) => jobOutputText(current, text, append)), onState: () => undefined });
    // Follow again only when the job starts or finishes, not on every step it reports.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId, job !== null, job?.state === "awaiting_approval", finished]);

  const name = title ?? job?.title ?? "This job";
  if (gone) return <p className={cx("ui-job", className)}>{name} is no longer in the job history.</p>;
  const words = job ? jobStatus(job) : { label: "Reading…", tone: "status-neutral" };
  const status: Status = job ? toneOf(words.tone) : "unknown";
  const started = Date.parse(job?.createdAt ?? "");
  const ended = Date.parse(job?.updatedAt ?? "");
  const elapsed = Number.isFinite(started) ? took((finished && Number.isFinite(ended) ? ended : Date.now()) - started) : null;
  const lastLine = output.trimEnd().split("\n").at(-1) ?? "";
  const waiting = job?.state === "awaiting_approval";
  return (
    <div className={cx("ui-job", className)} data-state={job?.state}>
      <div className="ui-job__head">
        <StatusChip status={status}>{words.label}</StatusChip>
        <span className="ui-job__title">{name}</span>
        {elapsed && !waiting && <span className="ui-job__time">{elapsed}</span>}
      </div>
      <Progress
        label={`${name}: ${words.label}`}
        hideLabel
        value={finished ? 100 : undefined}
        status={finished ? status : undefined}
        className="ui-job__bar"
      />
      {job?.error && <p className="ui-job__error">{job.error}</p>}
      {!job?.error && lastLine && !open && <p className="ui-job__line">{lastLine}</p>}
      {(output || finished) && (
        <button type="button" className="ui-job__toggle" aria-expanded={open} aria-controls={outputId} onClick={() => setOpen((value) => !value)}>
          {open ? "Hide output" : "Show output"}
        </button>
      )}
      <div id={outputId} hidden={!open}>
        {open && <CodeBlock label={`Output for ${name}`} follow={!finished} empty={waiting ? "Nothing has run yet: it waits for approval." : finished ? "This job recorded no output." : "Waiting for output…"} maxHeight="18rem">{output}</CodeBlock>}
      </div>
    </div>
  );
}
