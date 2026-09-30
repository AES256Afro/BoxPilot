import { useId, type ReactNode } from "react";
import type { FixRun } from "../repair/useRepairFixes";
import { Button, RiskTag } from "../ui";
import { cx } from "../ui/types";
import { actionsOf, runs, type Need, type NeedAction, type NeedSeverity } from "./needs";
import { runWords } from "./useNeedActions";

const severityWords: Record<NeedSeverity, string> = { danger: "Problem", warning: "Needs a look", neutral: "Suggestion" };

export interface NeedRowProps {
  need: Need;
  onOpen: (need: Need) => void;
  onAct: (need: Need, action?: NeedAction | null) => void;
  /**
   * Drawn in place of the bare mark, with the mark on its corner: the app's square, or the icon of
   * the page the need opens (Home, M33.7). Decoration: the words say what it is.
   */
  icon?: ReactNode;
  /**
   * The fix's tier said once more beside the words, as the study drew it: after the title on Home
   * ("inline"), leading the row in Ops' inbox ("lead"). The button still carries the tier itself
   * and is what assistive technology reads it from, so this copy is hidden from it.
   */
  tier?: "inline" | "lead";
  /** A Repair fix started from this row, while it runs and once it has ended (M35). */
  run?: FixRun;
}

/**
 * One thing that needs the owner. Its title opens the page with the detail; its buttons, when it
 * has them, start each fix through the approval dialog and show the fix's tier before the click
 * (a finding may offer more than one, and a failed job can be dismissed). A job already staged
 * shows the tier it will be approved at. The mark's meaning is also said in words, so it never
 * rests on colour or shape alone.
 */
export function NeedRow({ need, onOpen, onAct, icon, tier, run }: NeedRowProps) {
  const detailId = useId();
  const runnable = runs(need);
  const tag = tier && runnable ? <span className="need__tier-tag" aria-hidden="true"><RiskTag risk={runnable.risk} short={tier === "lead"} /></span> : null;
  const actions = actionsOf(need);
  const busy = run && ["queued", "running", "checking"].includes(run.phase);
  return (
    <li className={cx("need", icon !== undefined && "need--icon", tier === "lead" && "need--lead")} data-severity={need.severity}>
      {tier === "lead" && tag}
      {icon !== undefined
        ? <span className="need__icon" aria-hidden="true">{icon}<span className="ui-mark need__mark" /></span>
        : <span className="ui-mark need__mark" aria-hidden="true" />}
      <div className="need__body">
        <span className="need__head">
          <button type="button" className="need__title" onClick={() => onOpen(need)} aria-describedby={need.detail ? detailId : undefined}>
            {/* The space stays outside the hidden words: a name is built from trimmed pieces. */}
            <span className="ui-visually-hidden">{`${severityWords[need.severity]}:`}</span>{` ${need.title}`}
          </button>
          {tier === "inline" && tag}
        </span>
        {need.detail && <span className="need__detail" id={detailId}>{need.detail}</span>}
        {run && <span className="need__run" role="status" data-phase={run.phase}>{runWords(run)}</span>}
      </div>
      {need.risk && !need.action && <RiskTag risk={need.risk} className="need__tier" />}
      {actions.length > 0 && (
        <span className="need__acts">
          {actions.map((action) => (action.kind === "dismiss"
            ? <Button key="dismiss" variant="ghost" className="need__act need__dismiss" aria-label={`Dismiss: ${need.title}`} onClick={() => onAct(need, action)}>Dismiss</Button>
            // Opens the page where the fix is: it runs nothing, so it carries no tier.
            : action.kind === "open"
              ? <Button key={`open:${action.label}`} className="need__act" aria-label={`${action.label}: ${need.title}`} onClick={() => onAct(need, action)}>{action.label}</Button>
            : <Button key={`${action.operationId}:${action.label}`} className="need__act" risk={action.risk} disabled={Boolean(busy)} aria-label={`${action.label}: ${need.title}`} onClick={() => onAct(need, action)}>{action.label}</Button>))}
        </span>
      )}
    </li>
  );
}
