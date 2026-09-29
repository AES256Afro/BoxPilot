import { useEffect, type ReactNode } from "react";
import { useOptionalFacts } from "../home/facts";
import { ShellHostProvider } from "./TopBarSlot";

/**
 * Names the server for every console page's bar (M33.8). The name is the inventory's, from the
 * facts provider Home and Ops read: when a page is opened first, by a deep link, the inventory is
 * read once for it (one request, not the provider's polling, which only runs while Home or Ops is
 * open). Until it answers the bar says "boxpilot".
 */
export function ShellHost({ children, ask }: { children: ReactNode; /** Read the inventory if nothing has yet. */ ask: boolean }) {
  const context = useOptionalFacts();
  const state = context?.facts.inventory.state;
  const refresh = context?.refresh;
  useEffect(() => {
    if (ask && state === "idle") refresh?.(["inventory"]);
  }, [ask, state, refresh]);
  return <ShellHostProvider value={context?.facts.inventory.value?.hostname ?? null}>{children}</ShellHostProvider>;
}
