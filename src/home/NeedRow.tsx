import { useId, type ReactNode } from "react";
import { Button, RiskTag } from "../ui";
import { cx } from "../ui/types";
import type { Need, NeedSeverity } from "./needs";

const severityWords: Record<NeedSeverity, string> = { danger: "Problem", warning: "Needs a look", neutral: "Suggestion" };

export interface NeedRowProps {
  need: Need;
  onOpen: (need: Need) => void;
  onAct: (need: Need) => void;
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
}

/**
 * One thing that needs the owner. Its title opens the page with the detail; its button, when it
 * has one, starts the fix through the approval dialog and shows the fix's tier before the click.
 * A job already staged shows the tier it will be approved at. The mark's meaning is also said in
 * words, so it never rests on colour or shape alone.
 */
export function NeedRow({ need, onOpen, onAct, icon, tier }: NeedRowProps) {
  const detailId = useId();
  const tag = tier && need.action ? <span className="need__tier-tag" aria-hidden="true"><RiskTag risk={need.action.risk} /></span> : null;
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
      </div>
      {need.risk && !need.action && <RiskTag risk={need.risk} className="need__tier" />}
      {need.action && <Button className="need__act" risk={need.action.risk} aria-label={`${need.action.label}: ${need.title}`} onClick={() => onAct(need)}>{need.action.label}</Button>}
    </li>
  );
}
