import { useEffect, type ReactNode } from "react";
import { useOptionalFacts, type Facts } from "../home/facts";
import { uptime } from "../home/format";
import { useHostVerdict } from "../home/hostVerdict";
import { verdictSources } from "../home/needs";
import { ShellHostProvider } from "./TopBarSlot";

/**
 * Names the server for every console page's bar (M33.8). The name is the inventory's, from the
 * facts provider Home and Ops read: when a page is opened first, by a deep link, the inventory is
 * read once for it (one request, not the provider's polling, which only runs while Home or Ops is
 * open). Until it answers the bar says "boxpilot".
 *
 * The sources Home's verdict rests on are read once too (M41): the sidebar and the bar's mark say
 * Home's "3 to look at" on every page, and the areas' counts are there on a page opened first.
 */
export function ShellHost({ children, ask }: { children: ReactNode; /** Read the inventory if nothing has yet. */ ask: boolean }) {
  const context = useOptionalFacts();
  const facts = context?.facts;
  const refresh = context?.refresh;
  const unread = facts ? (["inventory", ...verdictSources.map(([key]) => key)] as Array<keyof Facts>).filter((key) => facts[key].state === "idle") : [];
  const unreadKey = unread.join(",");
  useEffect(() => {
    if (ask && unreadKey) refresh?.(unreadKey.split(",") as Array<keyof Facts>);
  }, [ask, unreadKey, refresh]);
  return <ShellHostProvider value={context?.facts.inventory.value?.hostname ?? null}>{children}</ShellHostProvider>;
}

/**
 * The server as the Launcher's bar names it on every page (M41), as Home's bar does: its name, its
 * system and uptime, and a mark for whether anything needs a look, from Home's own verdict. No mark
 * until every source that verdict rests on has answered.
 */
export function useShellHostLine(): { name: string | null; facts: string | null; status: "good" | "warning" | null } {
  const facts = useOptionalFacts()?.facts;
  const inventory = facts?.inventory.value ?? null;
  const verdict = useHostVerdict(null);
  return {
    name: inventory?.hostname ?? null,
    facts: inventory ? `${inventory.operatingSystem} · up ${uptime(inventory.uptimeSeconds)}` : null,
    status: verdict.status === null ? null : verdict.status === "good" ? "good" : "warning",
  };
}
