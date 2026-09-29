import { useEffect, useId, useRef, type ComponentProps, type ReactNode } from "react";
import { riskCopy, RiskTag } from "./Button";
import { cx, type RiskTier } from "./types";

export interface SwitchProps {
  /** On or off, as it is now on the server (not as the owner wishes it to be). */
  checked: boolean;
  /** Called with the new state. A switch that changes the server starts its operation here. */
  onChange: (checked: boolean) => void;
  /** What is switched: "Automatic security updates". The switch's name. */
  label: ReactNode;
  /** One line under the label: what on means. Read after the name. */
  description?: ReactNode;
  /**
   * The tier of the operation flipping it starts (ADR-001): shown as a tag beside the label and
   * read as the switch's description, as Button does. Leave it out for a switch that only changes
   * this page (a filter, "follow").
   */
  risk?: RiskTier;
  disabled?: boolean;
  /** Working: the switch is disabled and says so. */
  busy?: boolean;
  id?: string;
  className?: string;
}

/**
 * On or off (M33.8): a button with role="switch", so Space and Enter flip it and a screen reader
 * says "on" or "off". The state is drawn three ways, never by colour alone: the thumb's side, the
 * track's fill, and the word On or Off.
 */
export function Switch({ checked, onChange, label, description, risk, disabled = false, busy = false, id: givenId, className }: SwitchProps) {
  const madeId = useId();
  const id = givenId ?? `switch${madeId}`;
  const descriptionId = `${id}-description`;
  const riskId = `${id}-risk`;
  return (
    <div className={cx("ui-switch", className)} data-checked={checked || undefined}>
      <button
        id={id}
        type="button"
        role="switch"
        aria-checked={checked}
        aria-busy={busy || undefined}
        aria-describedby={cx(description ? descriptionId : null, risk ? riskId : null) || undefined}
        disabled={disabled || busy}
        className="ui-switch__control"
        onClick={() => onChange(!checked)}
      >
        <span className="ui-switch__track" aria-hidden="true"><span className="ui-switch__thumb" /></span>
        <span className="ui-switch__state" aria-hidden="true">{checked ? "On" : "Off"}</span>
      </button>
      <span className="ui-switch__text">
        <label className="ui-switch__label" htmlFor={id}>{label}</label>
        {risk && <RiskTag risk={risk} short className="ui-switch__tier" />}
        {description && <span className="ui-switch__description" id={descriptionId}>{description}</span>}
        {risk && <span id={riskId} hidden>{riskCopy[risk].description}</span>}
      </span>
    </div>
  );
}

export interface CheckboxProps extends Omit<ComponentProps<"input">, "type" | "onChange" | "ref"> {
  label: ReactNode;
  /** One line under the label. Read after the name. */
  description?: ReactNode;
  /** Some but not all: drawn as a dash, read as "mixed". */
  indeterminate?: boolean;
  onChange?: (checked: boolean) => void;
}

/**
 * A choice that is on or off inside a form, or one row of a selection (M33.8). The browser's own
 * checkbox, so the keyboard and screen readers get it right, with the console's box drawn over it.
 */
export function Checkbox({ label, description, indeterminate = false, onChange, className, id: givenId, disabled, ...rest }: CheckboxProps) {
  const madeId = useId();
  const id = givenId ?? `check${madeId}`;
  const descriptionId = `${id}-description`;
  const ref = useRef<HTMLInputElement | null>(null);
  useEffect(() => { if (ref.current) ref.current.indeterminate = indeterminate; }, [indeterminate]);
  return (
    <span className={cx("ui-check", disabled && "ui-check--disabled", className)}>
      <span className="ui-check__box">
        <input
          {...rest}
          ref={ref}
          id={id}
          type="checkbox"
          disabled={disabled}
          aria-describedby={cx(rest["aria-describedby"], description ? descriptionId : null) || undefined}
          className="ui-control ui-check__input"
          onChange={(event) => onChange?.(event.target.checked)}
        />
        <span className="ui-check__mark" aria-hidden="true" />
      </span>
      <span className="ui-check__text">
        <label className="ui-check__label" htmlFor={id}>{label}</label>
        {description && <span className="ui-check__description" id={descriptionId}>{description}</span>}
      </span>
    </span>
  );
}
