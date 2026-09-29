import { useState, type FormEvent, type ReactNode } from "react";
import { Button, Field, Notice, SecretInput, Sheet } from "../../ui";
import { errorText } from "./format";

/*
 * The owner's password, asked again before a change to how agents run (M37): turning them on or
 * off, the runtime, quiet hours, the knowledge sources. The same rule as the assistant's model
 * address: this decides where the server's facts go. The server checks the password; this only
 * asks for it and says what failed.
 */

export interface PasswordSheetProps {
  title: string;
  /** What will change, in a sentence or two. */
  children?: ReactNode;
  confirmLabel: string;
  onConfirm: (password: string) => Promise<void>;
  onClose: () => void;
}

export function PasswordSheet({ title, children, confirmLabel, onConfirm, onClose }: PasswordSheetProps) {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (event?: FormEvent) => {
    event?.preventDefault();
    if (!password) { setError("Type your password"); return; }
    setBusy(true);
    try {
      await onConfirm(password);
      onClose();
    } catch (requestError) {
      setError(errorText(requestError, "That did not work"));
      setBusy(false);
    }
  };
  return (
    <Sheet side="center" size="sm" kicker="Agents" title={title} onClose={onClose}
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" busy={busy} onClick={() => void submit()}>{confirmLabel}</Button></>}>
      <form className="agents-password" onSubmit={(event) => void submit(event)}>
        {children}
        <Field label="Your password" error={error ?? undefined}>
          <SecretInput autoComplete="current-password" value={password} onValueChange={setPassword} />
        </Field>
        {error && <Notice tone="danger" live>{error}</Notice>}
      </form>
    </Sheet>
  );
}
