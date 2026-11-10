/**
 * What a background loop does with a round that failed: says it, once.
 *
 * The loops (the scheduler's tick, the health check, the samplers) must outlive a bad round, so each
 * caught its own rejection, and caught it into nothing: a loop that failed every round looked the
 * same in the journal as one that worked. `tick().catch(logged("scheduler"))` keeps the loop alive
 * and writes `[boxpilot] scheduler: <message>` to the journal.
 *
 * Said once per message and loop, and again only after an hour of it: a loop that fails every thirty
 * seconds would otherwise write the journal full of one line. The memory is bounded (the oldest
 * message is forgotten first), since a message can carry a time or a count and so never repeat.
 */
export const loopLogLimits = Object.freeze({ remembered: 200, repeatAfterMs: 60 * 60_000, messageChars: 500 });

/** @param {{ warn?: (line: string) => void, now?: () => number, remembered?: number, repeatAfterMs?: number }} [options] */
export function createLoopLog({ warn = (line) => console.warn(line), now = () => Date.now(), remembered = loopLogLimits.remembered, repeatAfterMs = loopLogLimits.repeatAfterMs } = {}) {
  /** @type {Map<string, number>} */
  const said = new Map();
  /** A `.catch` handler for the loop called `name`. It never throws: a logger that failed would be the unhandled rejection it is there to prevent. */
  return function logged(name) {
    return (error) => {
      try {
        const message = String(error?.message ?? error).replace(/\s+/g, " ").trim().slice(0, loopLogLimits.messageChars) || "failed with no message";
        const line = `${name}: ${message}`;
        const at = now();
        const before = said.get(line);
        if (before !== undefined && at - before < repeatAfterMs) return;
        said.delete(line);
        while (said.size >= Math.max(1, remembered)) said.delete(said.keys().next().value);
        said.set(line, at);
        warn(`[boxpilot] ${line}`);
      } catch { /* the loop goes on */ }
    };
  };
}

/** The process's own: every loop shares one memory, and one journal. */
export const logged = createLoopLog();
