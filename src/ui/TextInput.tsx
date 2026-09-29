import { useId, useState, type ChangeEvent, type ComponentProps } from "react";
import { useFieldControl } from "./Field";
import { cx } from "./types";

export interface TextInputProps extends ComponentProps<"input"> {
  /** Monospace, for what is typed exactly: a path, a unit, an address, a key. */
  mono?: boolean;
  /** The new value, beside (not instead of) onChange. */
  onValueChange?: (value: string) => void;
}

/**
 * A one-line text input in the console's look (M33.8). Inside a Field it takes the field's label,
 * hint and error; on its own it needs an aria-label. Every native input attribute passes through.
 */
export function TextInput({ mono = false, onValueChange, onChange, className, type = "text", ...rest }: TextInputProps) {
  const field = useFieldControl(rest);
  return (
    <input
      {...rest}
      {...field}
      type={type}
      className={cx("ui-control", "ui-input", mono && "ui-input--mono", className)}
      onChange={(event: ChangeEvent<HTMLInputElement>) => { onChange?.(event); onValueChange?.(event.target.value); }}
    />
  );
}

export interface TextareaProps extends ComponentProps<"textarea"> {
  mono?: boolean;
  onValueChange?: (value: string) => void;
}

/** Several lines: a compose file, a note, a list of addresses. Resizes vertically only. */
export function Textarea({ mono = false, onValueChange, onChange, className, rows = 4, ...rest }: TextareaProps) {
  const field = useFieldControl(rest);
  return (
    <textarea
      {...rest}
      {...field}
      rows={rows}
      className={cx("ui-control", "ui-textarea", mono && "ui-input--mono", className)}
      onChange={(event: ChangeEvent<HTMLTextAreaElement>) => { onChange?.(event); onValueChange?.(event.target.value); }}
    />
  );
}

export interface SecretInputProps extends Omit<TextInputProps, "type" | "mono"> {
  /** What the reveal button says it shows: "Show the token". Defaults to "Show". */
  revealLabel?: string;
}

/**
 * A secret: a password, a token, an API key (M33.8). Masked until the owner asks to see it, never
 * spell-checked or offered to autofill, in mono so a pasted key can be checked character by
 * character. The reveal button says what pressing it does next.
 */
export function SecretInput({ revealLabel, className, autoComplete = "off", ...rest }: SecretInputProps) {
  const [shown, setShown] = useState(false);
  const ownId = useId();
  // The field's id when there is one, so the button can say which input it reveals.
  const id = useFieldControl(rest).id ?? `secret${ownId}`;
  const show = revealLabel ?? "Show";
  return (
    <span className={cx("ui-secret", className)}>
      <TextInput {...rest} id={id} type={shown ? "text" : "password"} mono autoComplete={autoComplete} spellCheck={false} autoCapitalize="off" autoCorrect="off" />
      <button type="button" className="ui-secret__toggle" aria-controls={id} onClick={() => setShown((value) => !value)} disabled={rest.disabled}>
        {shown ? "Hide" : show}
      </button>
    </span>
  );
}
