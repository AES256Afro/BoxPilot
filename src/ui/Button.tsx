import { useId, type ButtonHTMLAttributes, type ReactNode } from "react";
import { LockIcon } from "./icons";
import { cx, type RiskTier } from "./types";

/**
 * What each risk tier (ADR-001) asks of the owner, said before the click rather than inside the
 * dialog. `description` is what assistive technology reads after the button's name. On screen the
 * tier never rests on colour alone: low is plain, medium carries a bar on its leading edge, and
 * high a bar, a lock and `tag`.
 */
export const riskCopy: Record<RiskTier, { label: string; tag: string | null; description: string }> = {
  low: { label: "Low", tag: null, description: "Low risk." },
  medium: { label: "Medium", tag: null, description: "Medium risk: shows a preview and asks you to confirm." },
  high: { label: "High", tag: "Password", description: "High risk: asks for your password before it runs." },
};

export type ButtonVariant = "primary" | "secondary" | "ghost";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /**
   * The risk tier of the operation this button starts. Leave it out for buttons that change
   * nothing on the server (Cancel, Refresh this view). Low is drawn plain; medium carries an
   * amber bar; high a red bar, a lock and "Password".
   */
  risk?: RiskTier;
  /** Primary is the one main action in a place; secondary is the default; ghost reads as a link. */
  variant?: ButtonVariant;
  /** Work is under way: the button is disabled and says so to assistive technology. */
  busy?: boolean;
  /** Drawn before the label; decorative, so give it aria-hidden. */
  icon?: ReactNode;
}

export function Button({ risk, variant = "secondary", busy = false, icon, children, className, type = "button", disabled, "aria-describedby": describedBy, ...rest }: ButtonProps) {
  const descriptionId = useId();
  const copy = risk ? riskCopy[risk] : null;
  return (
    <button
      {...rest}
      type={type}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
      aria-describedby={cx(describedBy, copy && descriptionId) || undefined}
      data-risk={risk}
      className={cx("ui-button", `ui-button--${variant}`, risk && `ui-button--risk-${risk}`, className)}
    >
      {risk === "high" && <LockIcon className="ui-button__lock" />}
      {icon}
      <span className="ui-button__label">{children}</span>
      {copy?.tag && <span className="ui-button__tier" aria-hidden="true">{copy.tag}</span>}
      {/* Hidden, so it stays out of the button's name, and read as its description. */}
      {copy && <span id={descriptionId} hidden>{copy.description}</span>}
    </button>
  );
}

/** A risk tier on its own, for lists of pending changes (an inbox, a plan's steps). */
export function RiskTag({ risk, className }: { risk: RiskTier; className?: string }) {
  return (
    <span className={cx("ui-risk", `ui-risk--${risk}`, className)} data-risk={risk}>
      {risk === "high" && <LockIcon className="ui-risk__lock" />}
      {riskCopy[risk].label}
      <span className="ui-visually-hidden"> risk</span>
    </span>
  );
}
