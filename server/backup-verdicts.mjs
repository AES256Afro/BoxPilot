/**
 * Restore-rehearsal verdicts (M20.3), kept per app so "the backups restore" is a record rather
 * than a hope. Pure so the folding is testable without the job pipeline: the record hook in
 * server/index.mjs is the only caller, and it has nowhere to be tested from.
 */

/** How many rehearsals to keep per app. Enough to see a pattern, small enough to keep in a setting. */
export const verdictHistoryLimit = 12;

/** One verdict as it is stored: the result fields worth keeping, and who ran it. */
export function verdictFrom(result, by = null) {
  return {
    verified: Boolean(result?.verified),
    backup: result?.backup ?? null,
    reason: result?.reason ?? null,
    sizeBytes: result?.sizeBytes ?? null,
    durationMs: result?.durationMs ?? null,
    checkedAt: result?.checkedAt ?? null,
    by,
  };
}

/**
 * Fold a new verdict into what is already stored for that app: newest first, capped, with the
 * latest also spread at the top level so a reader that wants only the badge needs no history.
 * Entries written before there was a history are adopted as the first history item rather than
 * dropped, so turning this on does not erase the verdict already on the card.
 */
export function foldVerdict(entries, id, verdict) {
  const previous = entries?.[id] ?? null;
  const earlier = previous?.history ?? (previous ? [previous] : []);
  const history = [verdict, ...earlier]
    .slice(0, verdictHistoryLimit)
    .map(({ history: _nested, ...entry }) => entry);   // never nest a history inside a history
  return { ...(entries ?? {}), [id]: { ...verdict, history } };
}
