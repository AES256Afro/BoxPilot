import { useState, type ReactNode } from "react";
import { readJson } from "../http";
import "../shell/look.css";
import { Button, Field, Notice, RiskTag, Sheet, Textarea } from "../ui";
import { riskOf } from "../ui/operationRisk";
import type { Finding, RepairFix } from "./types";
import "./dialogs.css";

/*
 * The confirmations Repair adds around its fixes (M35). Each one says, before the click, what will
 * happen and at which tier; none of them approves a job - a job's approval is still the approval
 * dialog's, or, for the batch, the server's own one click for a low-risk job.
 *
 * M33.14 draws them on the kit's Sheet, as a centred dialog in the console's look (look-console),
 * so they are the same from Repair, Home and Ops.
 */

function Dialog({ title, kicker, onClose, busy = false, children, footer }: { title: string; kicker: string; onClose: () => void; busy?: boolean; children: ReactNode; footer: ReactNode }) {
  // While a request is in flight, Escape, the backdrop and the close button leave it open.
  return (
    <Sheet side="center" title={title} kicker={kicker} onClose={() => { if (!busy) onClose(); }} footer={footer} className="look-console rp-dialog">
      {children}
    </Sheet>
  );
}

const time = (hour: number | undefined, minute: number) => `${String(hour ?? 0).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;

/** "Back up nightly": the schedules it will create, each one a normal job when it runs. */
export function ScheduleDialog({ fix, onClose, onConfirm }: { fix: RepairFix; onClose: () => void; onConfirm: () => void }) {
  const specs = fix.schedules ?? [];
  const risk = fix.risk ?? riskOf(fix.operationId);
  return (
    <Dialog title={fix.label} kicker="Schedule" onClose={onClose}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" risk={risk} onClick={onConfirm}>{specs.length === 1 ? "Create the schedule" : `Create ${specs.length} schedules`}</Button></>}>
      <p className="rp-dialog__tier"><RiskTag risk={risk} /> <span>Each run is this tier's job, approved as you, like any schedule.</span></p>
      <p className="rp-dialog__text">{fix.preview}</p>
      <ul className="rp-dialog__list">
        {specs.map((spec) => <li key={JSON.stringify(spec.parameters)}><code>{String(spec.parameters.id ?? spec.parameters.subject ?? "")}</code> every night at {time(spec.hour, spec.minute)}</li>)}
      </ul>
    </Dialog>
  );
}

/**
 * "Fix the safe ones": every low-risk fix, listed, run one after another after this one click. The
 * click is what the server asks of each of them; the batch stops at any job that wants more.
 */
export function BatchDialog({ entries, onClose, onConfirm }: { entries: Array<{ finding: Finding; fix: RepairFix }>; onClose: () => void; onConfirm: () => void }) {
  return (
    <Dialog title="Fix the safe ones" kicker="Approval · low risk" onClose={onClose}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" risk="low" onClick={onConfirm}>{entries.length === 1 ? "Run it" : `Run all ${entries.length}`}</Button></>}>
      <p className="rp-dialog__tier"><RiskTag risk="low" /> <span>Each is a low-risk job: one click, audited on its own. They run one after another, and this page checks each finding again when they are done.</span></p>
      <ol className="rp-dialog__list">
        {entries.map(({ finding, fix }) => (
          <li key={finding.id}><strong>{fix.label}</strong><span className="rp-dialog__dim"> for “{finding.title}”</span><br /><span>{fix.preview}</span></li>
        ))}
      </ol>
    </Dialog>
  );
}

export type FindingTarget = { kind: "finding"; finding: Finding };
/** What Dismiss acts on: a finding, set aside here with a reason, or a failed job, let go on the job itself (M36). */
export type DismissTarget = FindingTarget | { kind: "job"; jobId: string; title: string };

/** "Not now", with the reason in the owner's words. A finding comes back by itself when it changes. */
export function DismissDialog({ target, csrfToken, onClose, onDone }: { target: FindingTarget; csrfToken: string; onClose: () => void; onDone: () => void }) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const title = target.finding.title;
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const body = { id: target.finding.id, fingerprint: target.finding.fingerprint, severity: target.finding.severity, reason: reason.trim() };
      await readJson(await fetch("/api/v1/remediations/dismissals", { method: "POST", headers: { "Content-Type": "application/json", "X-BoxPilot-CSRF": csrfToken }, body: JSON.stringify(body) }));
      onDone();
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "Could not dismiss it");
      setBusy(false);
    }
  };
  return (
    <Dialog title="Dismiss this finding" kicker="Not now" onClose={onClose} busy={busy}
      footer={<><Button onClick={onClose} disabled={busy}>Cancel</Button><Button variant="primary" busy={busy} disabled={reason.trim().length === 0} onClick={() => void submit()}>Dismiss</Button></>}>
      <p className="rp-dialog__text"><strong>{title}</strong></p>
      <p className="rp-dialog__dim">It moves to Dismissed at the bottom of Repair, with your reason, and leaves Home. If what it says changes, it comes back by itself.</p>
      <Field label="Why? Whoever reads this later will see it.">
        <Textarea value={reason} maxLength={200} rows={3} onValueChange={setReason} placeholder="It is deliberate: the downloads drive is separate on purpose" />
      </Field>
      {error && <Notice tone="danger" live>{error}</Notice>}
    </Dialog>
  );
}
