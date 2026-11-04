import { RuleTester } from "eslint";
import { describe, it } from "vitest";
import rule from "./use-the-injected-clock.mjs";

/**
 * The clock rule proving it fails on what it is for, and — the part that nearly sank it — proving it
 * stays quiet on everything legitimate (M54).
 *
 * Its first two versions reported 151 problems across the tree, every one a parameter default:
 * `now = () => Date.now()` puts the read inside a concise arrow body, and the check for "is this a
 * parameter's own default?" walked up only as far as the innermost function, which is that arrow,
 * whose parameter list is empty. A rule that is wrong twenty times out of twenty-one teaches people
 * to ignore it, so the invalid cases below are the smaller half of this file.
 */
RuleTester.describe = describe;
RuleTester.it = it;

const tester = new RuleTester({ languageOptions: { ecmaVersion: 2025, sourceType: "module" } });

tester.run("use-the-injected-clock", rule, {
  valid: [
    // The clock's own default, in every shape the tree writes it.
    "export function f({ now = () => Date.now() } = {}) { return now(); }",
    "export function f({ now = () => new Date() } = {}) { return now(); }",
    "export function f(now = Date.now()) { return now; }",
    "export function f({ store, now = () => Date.now(), other = 1 } = {}) { return [now(), store, other]; }",
    "const f = ({ now = () => Date.now() } = {}) => now();",
    // A factory whose options object names the clock, with the default spread over several lines.
    `export function createThing({
       binary = "/usr/bin/thing",
       now = () => Date.now(),
       timeout = 1000,
     } = {}) { return { at: now(), binary, timeout }; }`,

    // Elapsed time and deadlines: real seconds, which a fixed clock would make expire instantly or never.
    "export function f({ now = () => Date.now() }) { const started = Date.now(); return { at: now(), took: Date.now() - started }; }",
    "export function f({ now = () => Date.now() }) { const deadline = Date.now() + 5000; return { at: now(), deadline }; }",
    "export function f({ now = () => Date.now() }) { const until = 5000 + Date.now(); return { at: now(), until }; }",
    // A stopwatch mark whose every use is that arithmetic, a few lines from the reading.
    `export function f({ now = () => Date.now() }) {
       const started = Date.now();
       const stamp = now();
       const elapsed = Date.now() - started;
       return { stamp, elapsed, again: started - 1 };
     }`,
    // A fallback for a clock that was not passed.
    "export function f({ now = () => Date.now(), limits = {} }) { const clock = limits.now ?? (() => Date.now()); return [now(), clock]; }",
    "export function f({ now }) { return Number(now ?? Date.now()); }",
    "export function f({ now }) { return now || Date.now(); }",

    // No clock in scope at all: this rule has nothing to say about these.
    "export function f() { return new Date().toISOString(); }",
    "export function f() { return { at: Date.now() }; }",
    "export const f = () => new Date();",
  ],
  invalid: [
    {
      name: "a date stamped from the wall clock in a function holding a clock",
      code: "export function f({ now = () => Date.now() }) { return { at: new Date().toISOString(), used: now() }; }",
      errors: [{ messageId: "wallClock", data: { read: "new Date()" } }],
    },
    {
      name: "a reading stored rather than subtracted",
      code: "export function f({ now = () => Date.now() }) { const kept = Date.now(); return { kept, used: now() }; }",
      errors: [{ messageId: "wallClock" }],
    },
    {
      name: "a comparison against the wall clock",
      code: "export function f({ now = () => Date.now() }, until) { if (Date.now() > until) return null; return now(); }",
      errors: [{ messageId: "wallClock" }],
    },
    {
      name: "a reading passed on as a date",
      code: "export function f({ now = () => Date.now() }) { return age({ now: Date.now() }) + now(); }",
      errors: [{ messageId: "wallClock" }],
    },
    {
      name: "both kinds of read in one function",
      code: "export function f({ now = () => Date.now() }) { return { a: Date.now(), b: new Date(), c: now() }; }",
      errors: [{ messageId: "wallClock" }, { messageId: "wallClock" }],
    },
    {
      name: "a nested closure inherits the clock from the function around it",
      code: "export function f({ now = () => Date.now() }) { return () => ({ at: new Date().toISOString(), used: now() }); }",
      errors: [{ messageId: "wallClock" }],
    },
    {
      name: "a clock named by a plain parameter, not a destructured one",
      code: "export function f(now) { return { at: Date.now(), used: now() }; }",
      errors: [{ messageId: "wallClock" }],
    },
    {
      name: "a local that shadows the injected clock — the Storage forecast bug",
      code: "export function f({ now = () => Date.now() }) { const now2 = Date.now(); return days({ now: now2 }); }",
      errors: [{ messageId: "wallClock" }],
    },
    {
      name: "a stopwatch mark that is not only arithmetic is still a date",
      code: "export function f({ now = () => Date.now() }) { const mark = Date.now(); return { mark, elapsed: Date.now() - mark, used: now() }; }",
      // The first read is kept (stored in the answer), the second is the subtraction.
      errors: [{ messageId: "wallClock" }],
    },
  ],
});
