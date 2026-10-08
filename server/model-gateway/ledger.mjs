/**
 * What Claude has cost this month, counted by the gateway itself (M45.3, ADR-013). The web service
 * holds runs to the owner's monthly cap; the gateway holds them to it a second time, from its own
 * count, so a bug in the web service cannot spend past it.
 *
 * Before a call the gateway reserves what the call could cost at most and writes that down; after
 * it, the reservation is replaced by what the call did cost. A gateway that stops partway leaves
 * the reservation counted: the month reads high, never low.
 *
 * Months are UTC calendar months. The file holds `{ month: "2026-10", spentUsd, calls }` and starts
 * again at zero when the month changes.
 */
import { readFileWithoutFollowing, replaceFileWithoutFollowing } from "../durable-file.mjs";

const cents = (value) => Math.round(Number(value) * 1_000_000) / 1_000_000;

export function createLedger({ file, now = () => Date.now(), read = (target) => readFileWithoutFollowing(target), write = (target, text) => replaceFileWithoutFollowing(target, text, { mode: 0o600 }) }) {
  let state = null;
  let queue = Promise.resolve();
  const monthOf = () => new Date(now()).toISOString().slice(0, 7);

  async function load() {
    const month = monthOf();
    if (state?.month === month) return state;
    let saved = null;
    if (!state) {
      try { saved = JSON.parse(await read(file)); } catch (error) { if (error?.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error; }
    }
    const kept = saved && saved.month === month ? saved : state && state.month === month ? state : null;
    state = { month, spentUsd: cents(Math.max(0, Number(kept?.spentUsd) || 0)), calls: Math.max(0, Math.trunc(Number(kept?.calls) || 0)) };
    return state;
  }

  const save = () => write(file, `${JSON.stringify(state)}\n`);

  /** One change at a time, so two calls never both read the same total. */
  const serially = (work) => {
    const next = queue.then(work, work);
    queue = next.catch(() => {});
    return next;
  };

  return {
    /** The month so far: `{ month, spentUsd, calls }`. */
    current: () => serially(async () => ({ ...(await load()) })),

    /**
     * Reserve `atMostUsd` for one call under `capUsd`. Refused (`{ ok: false }`) when the month's
     * spend and this call together could pass the cap; otherwise the reservation is written down
     * before the call is made.
     */
    reserve: (atMostUsd, capUsd) => serially(async () => {
      const month = await load();
      const amount = cents(Math.max(0, Number(atMostUsd) || 0));
      if (!(Number(capUsd) > 0) || month.spentUsd + amount > Number(capUsd)) return { ok: false, month: month.month, spentUsd: month.spentUsd, capUsd: Number(capUsd) || 0 };
      month.spentUsd = cents(month.spentUsd + amount);
      month.calls += 1;
      await save();
      return { ok: true, month: month.month, reserved: amount, spentUsd: month.spentUsd, capUsd: Number(capUsd) };
    }),

    /**
     * Replace a reservation with what the call cost. A call that cost nothing it could know (it
     * failed before Claude answered) gives back its reservation; a cost that cannot be priced keeps
     * the reservation counted.
     */
    settle: (reservation, costUsd) => serially(async () => {
      const month = await load();
      if (!reservation?.ok || reservation.month !== month.month) return { ...month };
      const actual = costUsd === null || costUsd === undefined ? reservation.reserved : cents(Math.max(0, Number(costUsd) || 0));
      month.spentUsd = cents(Math.max(0, month.spentUsd - reservation.reserved + actual));
      await save();
      return { ...month };
    }),
  };
}
