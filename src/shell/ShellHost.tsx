import { useEffect, type ReactNode } from "react";
import { useOptionalFacts } from "../home/facts";
import { uptime } from "../home/format";
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

/**
 * The server as the Launcher's bar names it on every page (M41), as Home's bar does: its name, its
 * system and uptime, and a mark for whether anything is waiting (updates, Repair's findings), from
 * what has been read so far. No mark until one of those has been read.
 */
export function useShellHostLine(): { name: string | null; facts: string | null; status: "good" | "warning" | null } {
  const facts = useOptionalFacts()?.facts;
  const inventory = facts?.inventory.value ?? null;
  const updates = facts?.updates.value ?? null;
  const repairs = facts?.repairs.value ?? null;
  const waiting = (updates?.count ?? 0) + (repairs?.findings ?? []).filter((finding) => finding.severity !== "info").length;
  return {
    name: inventory?.hostname ?? null,
    facts: inventory ? `${inventory.operatingSystem} · up ${uptime(inventory.uptimeSeconds)}` : null,
    status: updates || repairs ? (waiting ? "warning" : "good") : null,
  };
}
