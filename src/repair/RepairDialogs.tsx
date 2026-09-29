import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { readJson } from "../http";
import { Button, RiskTag } from "../ui";
import { riskOf } from "../ui/operationRisk";
import { useDialogFocus } from "../useDialogFocus";
import type { Finding, RepairFix } from "./types";

/*
 * The confirmations Repair adds around its fixes (M35). Each one says, before the click, what will
 * happen and at which tier; none of them approves a job - a job's approval is still the approval
 * dialog's, or, for the batch, the server's own one click for a low-risk job.
 */

function Modal({ title, eyebrow, onClose, busy = false, children, footer }: { title: string; eyebrow: string; onClose: () => void; busy?: boolean; children: ReactNode; footer: ReactNode }) {
  const ref = useRef<HTMLElement | null>(null);
  const headingId = useId();
  useDialogFocus(ref);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape" && !busy) onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onClose]);
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={busy ? undefined : onClose}>
      <section ref={ref} tabIndex={-1} className="modal rp-modal" role="dialog" aria-modal="true" aria-labelledby={headingId} onMouseDown={(event) => event.stopPropagation()}>
        <header className="modal-header">
          <div><span className="eyebrow">{eyebrow}</span><h2 id={headingId}>{title}</h2></div>
          <button className="icon-button" type="button" onClick={onClose} aria-label="Close dialog" disabled={busy}>X</button>
        </header>
        <div className="modal-copy">{children}</div>
        <footer className="recovery-actions">{footer}</footer>
      </section>
    </div>
  );
}

const time = (hour: number | undefined, minute: number) => `${String(hour ?? 0).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;

/** "Back up nightly": the schedules it will create, each one a normal job when it runs. */
export function ScheduleDialog({ fix, onClose, onConfirm }: { fix: RepairFix; onClose: () => void; onConfirm: () => void }) {
  const specs = fix.schedules ?? [];
  const risk = fix.risk ?? riskOf(fix.operationId);
  return (
    <Modal title={fix.label} eyebrow="Schedule" onClose={onClose}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" risk={risk} onClick={onConfirm}>{specs.length === 1 ? "Create the schedule" : `Create ${specs.length} schedules`}</Button></>}>
      <p><RiskTag risk={risk} /> <span className="muted">Each run is this tier's job, approved as you, like any schedule.</span></p>
      <div className="notice"><span>{fix.preview}</span></div>
      <ul className="rp-modal__list">
        {specs.map((spec) => <li key={JSON.stringify(spec.parameters)}><code>{String(spec.parameters.id ?? spec.parameters.subject ?? "")}</code> every night at {time(spec.hour, spec.minute)}</li>)}
      </ul>
    </Modal>
  );
}

/**
 * "Fix the safe ones": every low-risk fix, listed, run one after another after this one click. The
 * click is what the server asks of each of them; the batch stops at any job that wants more.
 */
export function BatchDialog({ entries, onClose, onConfirm }: { entries: Array<{ finding: Finding; fix: RepairFix }>; onClose: () => void; onConfirm: () => void }) {
  return (
    <Modal title="Fix the safe ones" eyebrow="Approval · low risk" onClose={onClose}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" risk="low" onClick={onConfirm}>{entries.length === 1 ? "Run it" : `Run all ${entries.length}`}</Button></>}>
      <p><RiskTag risk="low" /> <span className="muted">Each is a low-risk job: one click, audited on its own. They run one after another, and this page checks each finding again when they are done.</span></p>
      <ol className="rp-modal__list">
        {entries.map(({ finding, fix }) => (
          <li key={finding.id}><strong>{fix.label}</strong><span className="muted"> for “{finding.title}”</span><br /><span>{fix.preview}</span></li>
        ))}
      </ol>
    </Modal>
  );
}

export type DismissTarget = { kind: "finding"; finding: Finding } | { kind: "job"; jobId: string; title: string };

/** "Not now", with the reason in the owner's words. A finding comes back by itself when it changes. */
export function DismissDialog({ target, csrfToken, onClose, onDone }: { target: DismissTarget; csrfToken: string; onClose: () => void; onDone: () => void }) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const reasonId = useId();
  const title = target.kind === "finding" ? target.finding.title : target.title;
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const body = target.kind === "finding"
        ? { id: target.finding.id, fingerprint: target.finding.fingerprint, severity: target.finding.severity, reason: reason.trim() }
        : { jobId: target.jobId, reason: reason.trim() };
      await readJson(await fetch("/api/v1/remediations/dismissals", { method: "POST", headers: { "Content-Type": "application/json", "X-BoxPilot-CSRF": csrfToken }, body: JSON.stringify(body) }));
      onDone();
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "Could not dismiss it");
      setBusy(false);
    }
  };
  return (
    <Modal title={target.kind === "finding" ? "Dismiss this finding" : "Dismiss this failure"} eyebrow="Not now" onClose={onClose} busy={busy}
      footer={<><Button onClick={onClose} disabled={busy}>Cancel</Button><Button variant="primary" busy={busy} disabled={reason.trim().length === 0} onClick={() => void submit()}>Dismiss</Button></>}>
      <p><strong>{title}</strong></p>
      <p className="muted">{target.kind === "finding"
        ? "It moves to Dismissed at the bottom of Repair, with your reason, and leaves Home. If what it says changes, it comes back by itself."
        : "It stops being listed on Home and Ops. The job stays in Activity with its log."}</p>
      <label htmlFor={reasonId}>Why? Whoever reads this later will see it.</label>
      <textarea id={reasonId} className="rp-modal__reason" value={reason} maxLength={200} rows={3} onChange={(event) => setReason(event.target.value)} placeholder="It is deliberate: the downloads drive is separate on purpose" />
      {error && <div className="auth-error" role="alert">{error}</div>}
    </Modal>
  );
}
