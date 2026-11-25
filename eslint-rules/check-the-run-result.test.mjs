import { RuleTester } from "eslint";
import { describe, it } from "vitest";
import rule from "./check-the-run-result.mjs";

/**
 * The run-result rule failing on the shape M73 fixed 17 times by hand, and staying quiet on the
 * `.catch` calls that are meaningful (M84).
 *
 * The quiet half matters as much: five modules hand-copy a runner that DOES throw, `flows.run` and
 * the agents' `tools.run` reject on purpose, and forty-odd sites keep a runner's result behind a
 * defensive `.catch(() => null)` and then read `.ok`. A rule that reported any of those would be
 * switched off within a week.
 */
RuleTester.describe = describe;
RuleTester.it = it;

const tester = new RuleTester({ languageOptions: { ecmaVersion: 2025, sourceType: "module" } });
const imports = 'import { fixedRun, streamRun } from "./exec.mjs";\n';
const cannotFire = (callee) => ({ messageId: "cannotFire", data: { callee } });
const tryCannotCatch = (callee) => ({ messageId: "tryCannotCatch", data: { callee } });

tester.run("check-the-run-result", rule, {
  valid: [
    // The throwing runners: declared in their own module, so `.catch` on them catches something.
    `async function defaultRunner(binary, args) { const result = await execFile(binary, args); return { stdout: result.stdout, stderr: result.stderr }; }
     export async function snapshot({ run = defaultRunner } = {}) { await run("virsh", ["destroy", "vm"]).catch(() => {}); }`,
    `${imports}async function defaultRunner(binary, args) {
       const result = await streamRun(binary, args);
       if (!result.ok) throw new Error("failed");
       return { stdout: result.stdout, stderr: result.stderr };
     }
     export async function protect({ run = defaultRunner } = {}) { await run("restic", ["unlock"]).catch(() => {}); }`,
    // A function called run that is not a runner at all, which rejects on purpose (flows.mjs).
    "async function run(id) { throw new Error(id); }\nexport function fire(id) { run(id).catch((error) => console.error(error)); }",
    // A member run that is something else's: flows, agent tools, prepared statements.
    "export async function f(flows, id) { await flows.run(id).catch(() => {}); }",
    "export function f(statements) { statements.step.run(1).catch(() => {}); }",
    // `.catch` on a promise that is not a runner's.
    'import { unlink } from "node:fs/promises";\nexport async function f(file) { await unlink(file).catch(() => {}); }',
    "export async function f(helper) { await helper.request(\"x\", {}).catch(() => null); }",
    // The result is kept and read: the catch is belt and braces against an injected runner that throws.
    `${imports}export async function f({ run = fixedRun } = {}) { const result = await run("ss", ["-l"]).catch(() => null); if (!result?.ok) return null; return result.stdout; }`,
    `${imports}export async function f({ run = fixedRun } = {}) { return run("ss", ["-l"]).catch(() => ({ ok: false, stdout: "" })); }`,
    `${imports}export async function f({ run = fixedRun } = {}) { return (await run("ss", ["-l"]).catch(() => ({ stdout: "" }))).stdout; }`,
    // What the rule asks for: keep the result and read `.ok`.
    `${imports}export async function f({ run = fixedRun, log } = {}) { const stopped = await run("systemctl", ["stop", "x"]); if (!stopped.ok) log(stopped.stderr); }`,
    // A runner whose result is thrown away without a catch is a different question, not this rule's.
    `${imports}export async function f() { await fixedRun("true"); }`,
    // A null default with a name that is not a runner's.
    "export async function f({ request = null } = {}) { await request(\"x\").catch(() => {}); }",
    // The `.then` wrapper with its result kept and read (name-lookups, ops/apps).
    `${imports}export async function f({ run = fixedRun } = {}) { const result = await Promise.resolve().then(() => run("getent", ["ahosts", "x"])).catch((error) => ({ ok: false, stderr: error.message })); return result.ok; }`,
    // A `.then` whose callback is not a runner's call.
    `${imports}export async function f({ run = fixedRun, log } = {}) { await Promise.resolve().then(() => log("x")).catch(() => {}); await run("a").then((r) => r.stdout).catch(() => {}); }`,
    // Promise.all, `.map` and `&&` whose value is kept and read.
    `${imports}export async function f({ run = fixedRun } = {}) { const results = await Promise.all(["a", "b"].map((u) => run("systemctl", ["stop", u]).catch(() => null))); return results.every((r) => r?.ok); }`,
    `${imports}export function f({ run = fixedRun } = {}) { const pending = ["a"].map((u) => run(u).catch(() => null)); return pending; }`,
    `${imports}export async function f(cond, { run = fixedRun } = {}) { const stopped = cond && await run("a").catch(() => null); return stopped?.ok; }`,
    // A runner's call inside a `.map` whose array goes somewhere other than away.
    `${imports}export async function f({ run = fixedRun } = {}) { return Promise.all(["a"].map((u) => run(u).catch(() => null))); }`,
    // A member run on a parameter or a field: deliberately not recognised (lanes.run, tools.run reject on purpose).
    "export async function f(context) { await context.run(\"systemctl\", [\"stop\", \"x\"]).catch(() => {}); }",
    "export class Lanes { async go() { await this.run(\"x\").catch(() => {}); } }",
    // try/catch: a handler that does something is for the block's other lines; a kept result is read.
    `${imports}export async function f({ run = fixedRun, log } = {}) { try { await run("a"); mustThrow(); } catch (error) { log(error); } }`,
    `${imports}export async function f({ run = fixedRun } = {}) { try { const r = await run("a"); return r.ok; } catch {} }`,
    `${imports}export async function f({ run = fixedRun } = {}) { try { await run("a"); } finally { done(); } }`,
    // try/catch around a throwing runner: the empty catch catches something.
    "async function defaultRunner(binary) { throw new Error(binary); }\nexport async function f({ run = defaultRunner } = {}) { try { await run(\"virsh\"); } catch {} }",
    // A runner called in a function nested in the try block is that function's business.
    `${imports}export function f({ run = fixedRun } = {}) { try { return () => run("a"); } catch {} }`,
  ],
  invalid: [
    {
      name: "the shape M73 found 17 times: an injected runner, awaited, with an empty catch",
      code: `${imports}export async function setPassword({ run = fixedRun } = {}) { await run("smbpasswd", ["-e", "alice"]).catch(() => {}); return { set: true }; }`,
      errors: [cannotFire("run")],
    },
    {
      name: "a catch that returns null, its value thrown away",
      code: `${imports}export async function f({ run = fixedRun } = {}) { await run("systemctl", ["stop", "x.timer"]).catch(() => null); }`,
      errors: [cannotFire("run")],
    },
    {
      name: "not awaited, and voided",
      code: `${imports}export function f({ run = fixedRun } = {}) { run("a").catch(() => {}); void run("b").catch(() => undefined); }`,
      errors: [cannotFire("run"), cannotFire("run")],
    },
    {
      name: "fixedRun and streamRun called directly, and under another name",
      code: 'import { fixedRun, streamRun as stream } from "./exec.mjs";\nexport async function f() { await fixedRun("a").catch(() => {}); await stream("b", [], { onLine() {} }).catch(() => {}); }',
      errors: [cannotFire("fixedRun"), cannotFire("stream")],
    },
    {
      name: "off a namespace import",
      code: 'import * as exec from "./exec.mjs";\nexport async function f() { await exec.fixedRun("a").catch(() => {}); }',
      errors: [cannotFire("exec.fixedRun")],
    },
    {
      name: "a member run on a local object holding a runner",
      code: `${imports}const deps = { run: fixedRun };\nexport async function f() { await deps.run("a").catch(() => {}); }`,
      errors: [cannotFire("deps.run")],
    },
    {
      name: "a parameter called run with no default, handed down from a task",
      code: "export async function hostMountsAt(run, mountpoint) { await run(\"findmnt\", [mountpoint]).catch(() => {}); }",
      errors: [cannotFire("run")],
    },
    {
      name: "a runner given as null and passed in later (local-dns)",
      code: "export function create({ runDocker = null } = {}) { return { async clear() { if (runDocker) await runDocker(\"docker\", [\"exec\"]).catch(() => {}); } }; }",
      errors: [cannotFire("runDocker")],
    },
    {
      name: "renamed in a destructuring default, then wrapped (tasks/apt.mjs)",
      code: `${imports}function withLog(run, log) { return (binary, args, options = {}) => { log(binary); return run(binary, args, options); }; }
             export async function f({ run: baseRun = fixedRun, log } = {}) { const run = withLog(baseRun, log); await run("apt-get", ["clean"]).catch(() => {}); }`,
      errors: [cannotFire("run")],
    },
    {
      name: "through the wrappers app-helper builds: a concise arrow and a function that returns a runner call",
      code: `${imports}async function defaultDockerRunner(binary, args, options) { return fixedRun(binary, args, options); }
             export function create({ runDocker = defaultDockerRunner } = {}) {
               const docker = (args, options) => runDocker("/usr/bin/docker", args, options);
               async function compose(id, args) { return docker(["compose", "-p", id, ...args]); }
               return {
                 async rollBack(id) { await compose(id, ["down"]).catch(() => {}); },
                 async pull(reference) { await docker(["pull", reference]).catch(() => null); },
               };
             }`,
      errors: [cannotFire("compose"), cannotFire("docker")],
    },
    {
      name: "a fallback to fixedRun",
      code: `${imports}export async function f(options) { const run = options.run ?? fixedRun; for (const unit of ["a", "b"]) await run("systemctl", ["stop", unit]).catch(() => {}); }`,
      errors: [cannotFire("run")],
    },
    {
      name: "inside the .then wrapper name-lookups and ops/apps use, its value thrown away",
      code: `${imports}export async function f(u, { run = fixedRun } = {}) {
               await Promise.resolve().then(() => run("systemctl", ["stop", u])).catch(() => {});
               await Promise.resolve().then(async () => { return run("systemctl", ["start", u]); }).catch(() => null);
             }`,
      errors: [cannotFire("run"), cannotFire("run")],
    },
    {
      name: "inside Promise.all, through a .map callback and as array elements",
      code: `${imports}export async function f(units, { run = fixedRun } = {}) {
               await Promise.all(units.map((u) => run("systemctl", ["stop", u]).catch(() => {})));
               await Promise.allSettled(units.map(async (u) => { return run("systemctl", ["start", u]).catch(() => {}); }));
               await Promise.all([run("a").catch(() => {}), ...units.map((u) => run(u).catch(() => {}))]);
             }`,
      errors: [cannotFire("run"), cannotFire("run"), cannotFire("run"), cannotFire("run")],
    },
    {
      name: "one side of a discarded && / || or a branch of ?:",
      code: `${imports}export async function f(cond, { run = fixedRun } = {}) {
               cond && await run("systemctl", ["stop", "x"]).catch(() => {});
               (await run("a").catch(() => null)) || cond;
               cond ? run("b").catch(() => {}) : null;
             }`,
      errors: [cannotFire("run"), cannotFire("run"), cannotFire("run")],
    },
    {
      name: "try { await run(...) } catch {} : an empty handler round a runner that never throws",
      code: `${imports}export async function f({ run = fixedRun } = {}) {
               try { await run("udevadm", ["control", "--reload"]); } catch {}
               try { if (x) void fixedRun("b"); } catch (error) { /* best effort */ }
             }`,
      errors: [tryCannotCatch("run"), tryCannotCatch("fixedRun")],
    },
  ],
});
