/**
 * Fail on a `.catch` that stands in for checking a command's result (M84, after M73).
 *
 * `fixedRun` and `streamRun` (`server/exec.mjs`) never reject. A command that exits non-zero, never
 * starts or runs out of time resolves with `{ ok: false, stderr }`, so `.catch` on one catches
 * nothing. The last two audits found 17 calls written as `await run(...).catch(() => {})` anyway,
 * and every one dropped a failure while the job carried on as if it had worked: `smbpasswd -e`
 * failed and the result still said "Samba password set". M73 fixed those calls; this rule is what
 * stops an 18th, because a reviewer reads `.catch` as "failure handled" and moves on.
 *
 * Two things have to be true for a report, and both are narrower than a text search on purpose.
 *
 * 1. The callee is a result-returning runner, decided by what the binding is, not what it is called:
 *    - `fixedRun` / `streamRun` imported (under any local name, or `exec.fixedRun` off a namespace);
 *    - a parameter or variable whose default or initialiser is one of those (`{ run = fixedRun }`,
 *      `{ run: baseRun = fixedRun }`, `const run = options.run ?? fixedRun`), or a wrapper made from
 *      one (`const run = withLog(baseRun, log)`);
 *    - a function that returns a runner's own call: `const docker = (args) => runDocker(...)` and
 *      `async function compose(...) { return docker([...]) }` in app-helper, `systemctl(run, ...)` and `startAt`
 *      in backup-mount-move. Seven of the ten sites this rule first found hid behind such a wrapper;
 *    - a parameter called `run`, `runCommand` or `runDocker` with no default, or `null` for one,
 *      which in this tree is always the injected runner handed down (`hostMountsAt(run, mountpoint)`,
 *      local-dns's `runDocker = null` that the helper fills with `fixedRun`);
 *    - a member `x.run(...)` / `x.runCommand(...)` whose object is a local object literal holding
 *      one of the above.
 *    The five hand-copied runners that DO throw (`defaultRunner` in vm-helper,
 *    controller-protection-helper, vm-protection-helper and vm-restore-drill-helper, `resticRunner`
 *    in restic-retention) are functions declared in their own module, so `run = defaultRunner` is a
 *    binding to something that is not a result runner and its `.catch` is left alone. So are
 *    `flows.run`, the agents' `tools.run` and every other `run` that is a function of its own.
 *
 *    A member `context.run(...)` / `this.run(...)` on a parameter or a field is NOT recognised. Every
 *    `x.run(...)` in this tree is something else's (`lanes.run`, `tools.run`, `operation.run`,
 *    `pending.run`, a prepared statement), several of which reject on purpose, and nothing in the
 *    file says what a parameter holds; operations take their runner destructured (`{ run }`), which
 *    is covered above. Recognising it would mean guessing from the name, which is the false positive
 *    this rule is built to avoid.
 *
 *    The runner call may also sit inside `.then`: `Promise.resolve().then(() => run(...)).catch(...)`
 *    is the wrapper name-lookups and ops/apps use so a runner that throws synchronously still lands
 *    in the catch, and its `.catch` is reported the same way when its value is thrown away.
 *
 * 2. The value of `.catch(...)` is thrown away: the call is a statement, bare, awaited or voided, or
 *    it only passes through something that is: one side of `&&` / `||` / `??` or a branch of `?:`,
 *    an element of an array or of `Promise.all([...])`, or what a `.map` callback hands to an array
 *    nobody keeps (`await Promise.all(units.map((u) => run(...).catch(() => {})))`). That is the
 *    shape that dropped all 17. `const listed = await run(...).catch(() => null)` followed by
 *    `if (!listed?.ok)` reads the result, which is the thing being asked for; its catch is belt and
 *    braces against an injected test runner that throws, and reporting it would be forty reports of
 *    code that is not wrong.
 *
 * The same mistake spelled `try { await run(...) } catch {}` is reported too: a `try` whose handler
 * is empty (comments only) and whose block calls a result runner as a statement. A `try` whose
 * handler does something is left alone, because there the handler is for the other lines of the
 * block that throw (watchdog's `daemon-reexec`, wake-on-lan's put-back), not a stand-in for `.ok`.
 *
 * What this rule does NOT police: a bare `await run(...)` statement with no catch at all, inside a
 * `try` with a real handler or outside one. It drops a failure just as silently (wake-on-lan's
 * `udevadm control --reload`, its result unread, is one live case), but plenty of those are
 * followed by a read that checks the effect instead (`daemon-reexec`, then `systemctl show`), and
 * telling the two apart is a reviewer's call, not a lint rule's. Green lint here means no `.catch`
 * or empty `catch` pretends to handle a runner's failure; it does not mean every result is read.
 *
 * The fix is never to delete the `.catch` and leave the statement: read `.ok` and decide by
 * consequence, as M73 did — fail the job, put a sentence in its result, or log it.
 */

const resultRunners = new Set(["fixedRun", "streamRun"]);
const injectedRunnerNames = new Set(["run", "runCommand", "runDocker"]);
const isFunction = (node) => node?.type === "FunctionDeclaration" || node?.type === "FunctionExpression" || node?.type === "ArrowFunctionExpression";

/** The variable this identifier resolves to, walking out from the scope it appears in. */
function resolve(identifier, context) {
  for (let scope = context.sourceCode.getScope(identifier); scope; scope = scope.upper) {
    const variable = scope.set.get(identifier.name);
    if (variable) return variable;
  }
  return null;
}

/** Whether this expression evaluates to a runner that resolves `{ ok }` instead of throwing. */
function isResultRunner(node, context, seen = new Set()) {
  if (!node || seen.has(node)) return false;
  seen.add(node);
  switch (node.type) {
    case "Identifier": return isResultRunnerBinding(resolve(node, context), context, seen);
    case "LogicalExpression": return isResultRunner(node.left, context, seen) || isResultRunner(node.right, context, seen);
    case "ConditionalExpression": return isResultRunner(node.consequent, context, seen) || isResultRunner(node.alternate, context, seen);
    case "AwaitExpression": return false;
    case "MemberExpression": return isResultRunnerMember(node, context, seen);
    // A wrapper built from a runner (`withLog(baseRun, log)`) answers with the runner's result.
    case "CallExpression": return node.arguments.some((argument) => isResultRunner(argument, context, seen));
    case "ArrowFunctionExpression":
    case "FunctionExpression":
    case "FunctionDeclaration": return returnsRunnerResult(node, context, seen);
    default: return false;
  }
}

/**
 * A function that hands back a runner's answer: `(args, options) => runDocker(dockerBinary, args, options)`,
 * or an `async function compose(...)` whose `return docker([...])` is one. The throwing runners
 * return an object they built (`{ stdout, stderr }`), never a runner's own call, so they are not.
 */
function returnsRunnerResult(fn, context, seen) {
  return returnedCalls(fn, context).some((call) => isResultRunner(call.callee, context, seen));
}

function isResultRunnerBinding(variable, context, seen) {
  if (!variable) return false;
  return variable.defs.some((definition) => {
    const name = definition.name;
    if (definition.type === "ImportBinding") {
      const specifier = definition.node;
      return specifier.type === "ImportSpecifier" && resultRunners.has(specifier.imported.name ?? specifier.imported.value);
    }
    // A default written beside the name, as a parameter or in a destructuring declaration.
    // `null` as a default is "not given", the same as none: `runDocker = null` is handed `fixedRun`.
    if (name.parent?.type === "AssignmentPattern" && name.parent.left === name) {
      const fallback = name.parent.right;
      if (definition.type === "Parameter" && fallback.type === "Literal" && fallback.value === null) return injectedRunnerNames.has(name.name);
      return isResultRunner(fallback, context, seen);
    }
    if (definition.type === "Parameter") return injectedRunnerNames.has(name.name);
    if (definition.type === "FunctionName") return returnsRunnerResult(definition.node, context, seen);
    if (definition.type === "Variable" && definition.node.id === name) return isResultRunner(definition.node.init, context, seen);
    return false;
  });
}

/** `exec.fixedRun`, or `x.run` where `x` is a local object literal whose `run` is a result runner. */
function isResultRunnerMember(node, context, seen) {
  if (node.computed || node.property.type !== "Identifier" || node.object.type !== "Identifier") return false;
  const variable = resolve(node.object, context);
  if (!variable) return false;
  return variable.defs.some((definition) => {
    if (definition.type === "ImportBinding" && definition.node.type === "ImportNamespaceSpecifier") return resultRunners.has(node.property.name);
    if (definition.type !== "Variable" || definition.node.id !== definition.name || definition.node.init?.type !== "ObjectExpression") return false;
    return definition.node.init.properties.some((property) => property.type === "Property" && !property.computed
      && (property.key.name ?? property.key.value) === node.property.name && isResultRunner(property.value, context, seen));
  });
}

const promiseCombinators = new Set(["all", "allSettled", "race", "any"]);
const isPromiseCombinator = (callee) => callee?.type === "MemberExpression" && !callee.computed
  && callee.object.type === "Identifier" && callee.object.name === "Promise" && promiseCombinators.has(callee.property.name);
const isMapCall = (call) => call?.type === "CallExpression" && call.callee.type === "MemberExpression" && !call.callee.computed
  && (call.callee.property.name === "map" || call.callee.property.name === "flatMap");

/**
 * Whether the value of this expression goes nowhere. A statement, bare, awaited or voided; or a part
 * of something that goes nowhere and passes the value through unread: one side of `&&` / `||` /
 * `??` or a branch of `?:`, an element of an array or of `Promise.all([...])`, or what a `.map`
 * callback hands to an array that is itself thrown away
 * (`await Promise.all(units.map((u) => run(...).catch(() => {})))`).
 */
function isDiscarded(node) {
  let current = node;
  for (;;) {
    const parent = current.parent;
    if (!parent) return false;
    if (parent.type === "ExpressionStatement") return true;
    if (parent.type === "AwaitExpression" || (parent.type === "UnaryExpression" && parent.operator === "void")
      || parent.type === "LogicalExpression" || parent.type === "ArrayExpression"
      || (parent.type === "SpreadElement" && parent.parent?.type === "ArrayExpression")
      || (parent.type === "ConditionalExpression" && parent.test !== current)
      || (parent.type === "CallExpression" && parent.arguments.includes(current) && isPromiseCombinator(parent.callee))) {
      current = parent;
      continue;
    }
    // The concise body of a `.map` callback, or what its block body returns.
    const callback = isFunction(parent) && parent.body === current ? parent
      : parent.type === "ReturnStatement" ? enclosingFunction(parent) : null;
    if (callback && isMapCall(callback.parent) && callback.parent.arguments[0] === callback) {
      current = callback.parent;
      continue;
    }
    return false;
  }
}

function enclosingFunction(node) {
  for (let current = node.parent; current; current = current.parent) if (isFunction(current)) return current;
  return null;
}

/**
 * The runner call whose failure this `.catch` stands in for checking: `run(...)` in
 * `run(...).catch(...)`, or the call a `.then` callback returns in
 * `Promise.resolve().then(() => run(...)).catch(...)` — the wrapper name-lookups and ops/apps use so
 * an injected runner that throws synchronously still lands in the catch.
 */
function runnerCallBefore(call, context) {
  if (call.type !== "CallExpression") return null;
  const { callee } = call;
  if (callee.type === "MemberExpression" && !callee.computed && callee.property.name === "then" && call.arguments.length === 1 && isFunction(call.arguments[0])) {
    const returned = returnedCalls(call.arguments[0], context).find((inner) => isResultRunner(inner.callee, context));
    return returned ?? null;
  }
  return call;
}

/** The calls a function hands back, `await`ed or not; not those of a function nested inside it. */
function returnedCalls(fn, context) {
  const returned = [];
  if (fn.body.type !== "BlockStatement") returned.push(fn.body);
  else {
    const keys = context.sourceCode.visitorKeys;
    const visit = (node) => {
      if (!node || typeof node.type !== "string") return;
      if (node !== fn.body && isFunction(node)) return;
      if (node.type === "ReturnStatement" && node.argument) returned.push(node.argument);
      for (const key of keys[node.type] ?? []) {
        const child = node[key];
        if (Array.isArray(child)) child.forEach(visit); else visit(child);
      }
    };
    visit(fn.body);
  }
  return returned.map((value) => value.type === "AwaitExpression" ? value.argument : value).filter((value) => value.type === "CallExpression");
}

/** Calls made as statements in this block, bare, awaited or voided; not inside a function nested in it. */
function discardedCallsIn(block, context) {
  const calls = [];
  const keys = context.sourceCode.visitorKeys;
  const visit = (node) => {
    if (!node || typeof node.type !== "string" || isFunction(node)) return;
    if (node.type === "ExpressionStatement") {
      let value = node.expression;
      while (value.type === "AwaitExpression" || (value.type === "UnaryExpression" && value.operator === "void")) value = value.argument;
      if (value.type === "CallExpression") calls.push(value);
    }
    for (const key of keys[node.type] ?? []) {
      const child = node[key];
      if (Array.isArray(child)) child.forEach(visit); else visit(child);
    }
  };
  visit(block);
  return calls;
}

const calleeName = (runner, context) => runner.type === "Identifier" ? runner.name
  : runner.type === "MemberExpression" && !runner.computed ? context.sourceCode.getText(runner) : null;

export default {
  meta: {
    type: "problem",
    docs: { description: "Check a command runner's `.ok` instead of chaining a `.catch` that cannot fire" },
    schema: [],
    messages: {
      tryCannotCatch: "`{{callee}}(...)` resolves with `{ ok: false }` when the command fails and never throws, so the empty `catch` around it catches nothing and the failure is dropped. Keep the result and read `.ok`: fail, add a sentence to the result, or log it.",
      cannotFire: "`{{callee}}(...)` resolves with `{ ok: false }` when the command fails and never rejects, so this `.catch` catches nothing and the failure is dropped. Keep the result and read `.ok`: fail, add a sentence to the result, or log it.",
    },
  },
  create(context) {
    return {
      CallExpression(node) {
        const { callee } = node;
        if (callee.type !== "MemberExpression" || callee.computed || callee.property.name !== "catch") return;
        if (!isDiscarded(node)) return;
        const call = runnerCallBefore(callee.object, context);
        if (!call) return;
        const runner = call.callee;
        const named = calleeName(runner, context);
        if (!named || isFunction(runner) || !isResultRunner(runner, context)) return;
        context.report({ node: callee.property, messageId: "cannotFire", data: { callee: named } });
      },
      TryStatement(node) {
        if (!node.handler || node.handler.body.body.length > 0) return;
        for (const call of discardedCallsIn(node.block, context)) {
          const named = calleeName(call.callee, context);
          if (!named || isFunction(call.callee) || !isResultRunner(call.callee, context)) continue;
          context.report({ node: call.callee, messageId: "tryCannotCatch", data: { callee: named } });
        }
      },
    };
  },
};
