import { useState, type ReactNode } from "react";
import { Button, Notice, Sheet } from "../../ui";
import { errorText } from "./format";

/*
 * A small dialog before something that cannot be undone (M48.7): forgetting a fact, a finding, a run
 * or the conversation; removing a document; the kill switch. Each used to go on one tap, with
 * "Forget" a finger's width from "Pin". The dialog says what goes and what stays, and does the work
 * when confirmed; an error stays in the dialog, so the person sees it where they pressed.
 */

export interface Confirmation {
  /** "Forget this fact?" */
  title: string;
  /** What happens, in a sentence or two. */
  body: ReactNode;
  /** The confirming button's words: "Forget", "Remove", "Stop every agent". */
  confirmLabel: string;
  /** The other button's words; "Keep it" unless said. */
  cancelLabel?: string;
  /** The work; its error is shown in the dialog. */
  onConfirm: () => Promise<unknown>;
  kicker?: string;
}

export function ConfirmSheet({ confirmation, onClose, failed = "That did not work" }: { confirmation: Confirmation; onClose: () => void; failed?: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const confirm = async () => {
    setBusy(true);
    try {
      await confirmation.onConfirm();
      onClose();
    } catch (requestError) {
      setError(errorText(requestError, failed));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Sheet side="center" size="sm" kicker={confirmation.kicker ?? "Agents"} title={confirmation.title} onClose={onClose}
      footer={<><Button variant="ghost" onClick={onClose}>{confirmation.cancelLabel ?? "Keep it"}</Button><Button variant="primary" busy={busy} onClick={() => void confirm()}>{confirmation.confirmLabel}</Button></>}>
      {typeof confirmation.body === "string" ? <p>{confirmation.body}</p> : confirmation.body}
      {error && <Notice tone="danger" live>{error}</Notice>}
    </Sheet>
  );
}
