import { useId } from "react";
import { Button, RiskTag } from "../ui";
import type { Need, NeedSeverity } from "./needs";

const severityWords: Record<NeedSeverity, string> = { danger: "Problem", warning: "Needs a look", neutral: "Suggestion" };

/**
 * One thing that needs the owner. Its title opens the page with the detail; its button, when it
 * has one, starts the fix through the approval dialog and shows the fix's tier before the click.
 * A job already staged shows the tier it will be approved at. The mark's meaning is also said in
 * words, so it never rests on colour or shape alone.
 */
export function NeedRow({ need, onOpen, onAct }: { need: Need; onOpen: (need: Need) => void; onAct: (need: Need) => void }) {
  const detailId = useId();
  return (
    <li className="need" data-severity={need.severity}>
      <span className="ui-mark need__mark" aria-hidden="true" />
      <div className="need__body">
        <button type="button" className="need__title" onClick={() => onOpen(need)} aria-describedby={need.detail ? detailId : undefined}>
          <span className="ui-visually-hidden">{severityWords[need.severity]}: </span>{need.title}
        </button>
        {need.detail && <span className="need__detail" id={detailId}>{need.detail}</span>}
      </div>
      {need.risk && !need.action && <RiskTag risk={need.risk} className="need__tier" />}
      {need.action && <Button className="need__act" risk={need.action.risk} aria-label={`${need.action.label}: ${need.title}`} onClick={() => onAct(need)}>{need.action.label}</Button>}
    </li>
  );
}
