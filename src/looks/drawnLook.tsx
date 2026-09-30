import { createContext, useContext } from "react";
import { DEFAULT_LOOK, type LookId } from "./looks";

/**
 * The look the page in front of you is drawn in (M41). It is the chosen look, except on Home when
 * the look is set for every page but Home: then Home keeps today's Launcher. App.tsx decides and
 * provides it; a page that draws something of its own per look (Storage's lead) reads it here.
 */
const DrawnLook = createContext<LookId>(DEFAULT_LOOK);

export const DrawnLookProvider = DrawnLook.Provider;

export function useDrawnLook(): LookId {
  return useContext(DrawnLook);
}
