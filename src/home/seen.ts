/*
 * "Got it" while it is being sent, and what went wrong when it was not taken. Kept beside the hook
 * rather than in it because the row that draws the button is rendered by many pages and looks, each
 * with its own useNeedActions: the row reads its own need's state from here, so the button is busy
 * and the failure is said in the row whichever page drew it. Keyed by the need's id.
 */

export interface SeenState { busy: boolean; problem: string | null }

const states = new Map<string, SeenState>();
const listeners = new Set<() => void>();
const rows = new Map<string, number>();

export const seenState = (needId: string): SeenState | undefined => states.get(needId);

export function setSeen(needId: string, state: SeenState | null): void {
  if (state) states.set(needId, state); else states.delete(needId);
  for (const listener of [...listeners]) listener();
}

export function subscribeSeen(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** A row is drawing this need, so a failure is said there; a look with its own list has none, and the page says it. */
export function claimRow(needId: string): () => void {
  rows.set(needId, (rows.get(needId) ?? 0) + 1);
  return () => {
    const left = (rows.get(needId) ?? 1) - 1;
    if (left > 0) rows.set(needId, left); else rows.delete(needId);
  };
}

export const rowDrawn = (needId: string): boolean => rows.has(needId);
