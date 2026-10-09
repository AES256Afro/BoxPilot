import { useEffect, useState } from "react";
import { getJob, type Job } from "../operations";
import { Button, Notice, Progress, Sheet } from "../ui";
import { ApproveDialog } from "./ApproveDialog";
import "./look.css";

/*
 * An approval opened from a push (M25.2): /?approve=<job id>. The link names a job and nothing else;
 * this reads the job as whoever is signed in (the server answers only to its owner or its creator)
 * and, while it still waits, hands it to the ordinary approval dialog - the same tier, the same
 * confirmation or password - exactly as Review on Today or in Activity does. A push approves nothing.
 */

const jobIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** An existing job's dialog is given no parameters of its own; one object, so it does not read the job again each render. */
const noParameters: Record<string, unknown> = {};
/** Said by the service worker when a push is tapped while the app is already open. */
export const openMessageType = "boxpilot:open";

/** The job an address asks to approve, or null. Only a job id is ever taken from it. */
export function approvalFromUrl(href: string): string | null {
  if (!URL.canParse(href)) return null;
  const id = new URL(href).searchParams.get("approve");
  return id && jobIdPattern.test(id) ? id.toLowerCase() : null;
}

/**
 * Take ?approve= out of the address (so a reload does not open it again) and leave Today under it,
 * where the approvals are listed. Returns the job id, or null.
 */
export function takeApprovalFromLocation(): string | null {
  const url = new URL(window.location.href);
  if (!url.searchParams.has("approve")) return null;
  const id = approvalFromUrl(url.href);
  url.searchParams.delete("approve");
  if (!url.searchParams.has("view")) url.searchParams.set("view", "today");
  window.history.replaceState(null, "", url);
  return id;
}

type State = { phase: "reading" } | { phase: "ready"; job: Job } | { phase: "gone"; message: string };

export function DeepLinkApproval({ jobId, csrfToken, onClose }: { jobId: string; csrfToken: string; onClose: () => void }) {
  const [state, setState] = useState<State>({ phase: "reading" });
  useEffect(() => {
    let live = true;
    setState({ phase: "reading" });
    getJob(jobId)
      .then(({ job }) => {
        if (!live) return;
        if (job.state !== "awaiting_approval") setState({ phase: "gone", message: `It is no longer waiting for approval: it is ${job.state.replaceAll("_", " ")}. Activity shows how it ended.` });
        else setState({ phase: "ready", job });
      })
      .catch((error: unknown) => {
        if (!live) return;
        const message = error instanceof Error && /not found/i.test(error.message)
          ? "There is no such job waiting for this account. It may have been approved or cancelled, or be someone else's to approve."
          : error instanceof Error ? error.message : "The job could not be read";
        setState({ phase: "gone", message });
      });
    return () => { live = false; };
  }, [jobId]);

  if (state.phase === "ready") {
    const { job } = state;
    return (
      <ApproveDialog operationId={job.type.replace(/^op:/, "")} title={job.title} parameters={noParameters} existingJobId={job.id} csrfToken={csrfToken}
        preview={job.recovery?.reason ? <span>{job.recovery.reason}</span> : undefined} onClose={onClose} />
    );
  }
  return (
    <Sheet title="Approval" kicker="From a push" side="center" size="sm" className="look-console" onClose={onClose}
      footer={<Button variant="primary" onClick={onClose}>Close</Button>}>
      {state.phase === "reading"
        ? <Progress label="Reading the job…" />
        : <Notice tone="warning" title="Nothing to approve">{state.message}</Notice>}
    </Sheet>
  );
}
