import type { Status } from "../ui";
import { useOptionalFacts, valuesOf } from "./facts";
import { buildNeeds, needsLabel, verdictFor, verdictSources } from "./needs";

/**
 * Home's verdict, for the shell (M41): the sidebar's line under the server's name and the mark
 * before it in the bar say the same "3 to look at" as Home's chip, from the same list of needs.
 * Nothing until every source the verdict rests on has answered: a count read from half the facts
 * would be wrong, and "All clear" before anything was read would be a lie (M28.5).
 */
export interface HostVerdict {
  /** "3 to look at", "2 can wait", "All clear"; null until the facts are read. */
  label: string | null;
  status: Status | null;
}

export function useHostVerdict(role: string | null | undefined, now: () => number = Date.now): HostVerdict {
  const facts = useOptionalFacts()?.facts;
  if (!facts) return { label: null, status: null };
  const answered = verdictSources.every(([key]) => facts[key].state === "ready" || facts[key].state === "failed");
  if (!answered) return { label: null, status: null };
  const unread = verdictSources.filter(([key]) => facts[key].state === "failed").map(([, words]) => words);
  const needs = buildNeeds(valuesOf(facts), { now: now(), role });
  const verdict = verdictFor(needs, { hostname: facts.inventory.value?.hostname ?? "This server", checking: false, unread });
  if (needs.length === 0) return { label: unread.length ? "Not fully read" : "All clear", status: unread.length ? "unknown" : "good" };
  return { label: needsLabel(needs, verdict), status: verdict.status };
}
