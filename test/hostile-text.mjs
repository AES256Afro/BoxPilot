/**
 * Text written to be slow to read, and a timer to hold code to reading it in linear time (sweep 5).
 *
 * Redaction, the agents' guard and the chat formatter run synchronously on the web process's event
 * loop over text anyone can write: a log line, a container's output, a model's answer, a chat
 * message. A regular expression that backtracks over a run of characters it can split more than one
 * way - `token_token_...` before a name rule, a long run of spaces before `\n` - is quadratic or
 * worse there, and one crafted line stalled BoxPilot for seconds.
 *
 * `slowness` times a function on a shape of text at 4, 16 and 64 KiB and says what was wrong, if
 * anything: slower than the budget at any size (scaled down for the smaller ones, with a floor), or
 * growing faster than the text does from 16 to 64 KiB. Each time is the fastest of three runs, so a
 * pause for garbage collection or another test's work does not count, and a size is not tried once
 * a smaller one was over budget, so code that backtracks fails in a second instead of hanging.
 *
 * A machine short of CPU for a whole sweep (a CI runner with every test file at once) can still make
 * linear code look slow: 7 ms at 16 KiB for a read that takes 0.1. So a sweep that looks wrong is
 * taken again, up to three in all, and only one that is wrong every time counts. Code that really
 * grows too fast is wrong every time; code far over its budget is not given a second sweep.
 */
export const fill = (unit, length) => unit.repeat(Math.ceil(length / unit.length)).slice(0, length);

export const hostileSizes = [4 * 1024, 16 * 1024, 64 * 1024];

/** The fastest of three runs, in milliseconds; one, when it was far over `budget` (there is no hiccup that large). */
function fastest(run, budget, now) {
  let best = Infinity;
  for (let round = 0; round < 3 && (round === 0 || best <= budget * 4); round += 1) {
    const started = now();
    run();
    best = Math.min(best, now() - started);
  }
  return best;
}

/** One sweep over `sizes`: what went wrong, and whether it was too far out to be the machine's fault. */
function sweep(apply, make, { budgetMs, floorMs, sizes, now }) {
  const times = [];
  for (const size of sizes) {
    const text = make(size);
    const budget = Math.max(floorMs, (budgetMs * size) / sizes.at(-1));
    const took = fastest(() => apply(text), budget, now);
    times.push(took);
    if (took > budget) return { problem: `${took.toFixed(1)} ms at ${size / 1024} KiB (budget ${budget.toFixed(0)} ms)`, far: took > budget * 4 };
  }
  if (sizes.length < 2) return null;
  const [middle, largest] = times.slice(-2);
  const growth = sizes.at(-1) / sizes.at(-2);
  if (largest > middle * growth * 2 + 10) return { problem: `${middle.toFixed(1)} ms at ${sizes.at(-2) / 1024} KiB but ${largest.toFixed(1)} ms at ${sizes.at(-1) / 1024} KiB: faster growth than the text's`, far: false };
  return null;
}

/**
 * Null when `apply` reads `make(size)` in time that grows with the text and stays under `budgetMs`
 * at the largest size; else what went wrong. Linear time is four times as long for four times the
 * text; quadratic is sixteen. Eight, with a few milliseconds' slack for times too small to measure
 * well, tells them apart. `sizes` is for code whose input is bounded below 64 KiB; one size alone is
 * a time budget at that bound, for code known to grow faster than its input but never given more.
 * `now` is the clock, for a test of this timer.
 */
export function slowness(apply, make, { budgetMs = 100, floorMs = 20, sizes = hostileSizes, now = () => performance.now() } = {}) {
  let wrong = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    wrong = sweep(apply, make, { budgetMs, floorMs, sizes, now });
    if (!wrong || wrong.far) break;
  }
  return wrong?.problem ?? null;
}
