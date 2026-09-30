import { Suspense, lazy, type ComponentType, type LazyExoticComponent } from "react";
import type { ViewName } from "../data";
import type { LookId } from "./looks";

/*
 * What a look adds to the shell's bar on every page (M41): the Glass Cockpit's annunciator lamps
 * and clock (docs/design-directions/05-looks: cockpit-home), lit from the same facts as Home. It is
 * drawn first in the bar, so the keyboard reaches it in the order it is seen, and the look's
 * stylesheet places it among the bar's own controls; a look with nothing to add draws nothing.
 */

export interface LookBarProps {
  role: string;
  onNavigate: (view: ViewName) => void;
  now?: () => number;
}

const bars: Partial<Record<LookId, LazyExoticComponent<ComponentType<LookBarProps>>>> = {
  cockpit: lazy(() => import("./cockpit/Annunciators")),
};

export function LookBar({ look, ...props }: LookBarProps & { look: LookId }) {
  const Bar = bars[look];
  if (!Bar) return null;
  return <Suspense fallback={null}><Bar {...props} /></Suspense>;
}
