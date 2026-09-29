import { createContext, useContext, useId, type ReactNode } from "react";
import { cx } from "./types";

interface FieldContextValue {
  id: string;
  describedBy: string | undefined;
  invalid: boolean;
  required: boolean;
}

const FieldContext = createContext<FieldContextValue | null>(null);

export interface FieldProps {
  /** What the control asks for, in a few words: "Hostname", "Keep for". Always shown. */
  label: ReactNode;
  /** One line under the control: the format, the limit, what happens. Read after the label. */
  hint?: ReactNode;
  /** What is wrong with the value, in words. Marks the control invalid and is read with it. */
  error?: ReactNode;
  /** Says "required" beside the label and on the control. */
  required?: boolean;
  /** Says "optional" beside the label: use it on the few optional fields of a mostly required form. */
  optional?: boolean;
  /** The control's id, when the page needs to know it; one is made otherwise. */
  id?: string;
  /** One control: TextInput, Textarea, Select or SecretInput, which take the label, hint and error. */
  children: ReactNode;
  className?: string;
}

/**
 * A labelled control (M33.8): the label above, the control, then its hint or its error. The
 * control inside picks up its id, its description and whether it is invalid from the field, so a
 * page writes <Field label="Hostname" error={problem}><TextInput value={name} ... /></Field> and
 * the label, hint and error are all read with the control.
 */
export function Field({ label, hint, error, required = false, optional = false, id: givenId, children, className }: FieldProps) {
  const madeId = useId();
  const id = givenId ?? `field${madeId}`;
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const describedBy = cx(error ? errorId : null, hint ? hintId : null) || undefined;
  return (
    <div className={cx("ui-field", Boolean(error) && "ui-field--invalid", className)}>
      <label className="ui-field__label" htmlFor={id}>
        {label}
        {required && <span className="ui-field__flag">required</span>}
        {optional && !required && <span className="ui-field__flag">optional</span>}
      </label>
      <FieldContext.Provider value={{ id, describedBy, invalid: Boolean(error), required }}>{children}</FieldContext.Provider>
      {error && <p className="ui-field__error ui-marked" data-status="danger" id={errorId}><span className="ui-mark" aria-hidden="true" />{error}</p>}
      {hint && <p className="ui-field__hint" id={hintId}>{hint}</p>}
    </div>
  );
}

/**
 * What a control takes from the Field around it: its id, its description and its invalid and
 * required state, merged with whatever the page passed itself (the page's own values win for the
 * id; descriptions are joined).
 */
export function useFieldControl(props: { id?: string; "aria-describedby"?: string; "aria-invalid"?: boolean | "true" | "false" | "grammar" | "spelling"; required?: boolean }) {
  const field = useContext(FieldContext);
  return {
    id: props.id ?? field?.id,
    "aria-describedby": cx(props["aria-describedby"], field?.describedBy) || undefined,
    "aria-invalid": props["aria-invalid"] ?? (field?.invalid ? true : undefined),
    required: props.required ?? (field?.required || undefined),
  };
}
