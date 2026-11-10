/**
 * Fail on a function that is given a clock and reads the wall clock anyway (M53.5).
 *
 * `AGENTS.md` has asked for injected clocks for a long time, and M52.1 and M53.1 were both written
 * anyway, a month apart: `scanRemediations` took a `now` and then aged every app's backup against
 * `Date.now()`, and `createAuthService` took one and honoured it in one place out of six — the
 * elevation window behind every high-risk approval among the five that did not. Neither was wrong
 * in production, where the two clocks are the same number; both meant the behaviour could not be
 * tested against a fixed clock, which is how they survived.
 *
 * A text search cannot find this. `Date.now()` is right far more often than it is wrong, because
 * measuring a duration is not stamping a date: a bare scan returns 86 sites of which about four
 * matter, and a check that cries wolf twenty times out of twenty-one teaches people to ignore it.
 * So this rule asks a narrower question, with ESLint's scope analysis doing the work:
 *
 *   inside a function that has `now` in scope as a parameter, is there a `Date.now()` or a
 *   `new Date()` whose value is used for anything other than subtraction?
 *
 * Subtraction is how elapsed time is measured (`Date.now() - started`, `started - Date.now()`), and
 * that is not what an injected clock is for. Everything else — stored, compared, formatted, passed
 * on — is a date, and a date inside a function holding a clock should come from the clock.
 *
 * The clock's own default is the correct way to write one, so `now = () => Date.now()` and
 * `{ now = Date.now() }` are not reports.
 */

/** Whether these parameters bring a clock called `now` into scope. */
function declaresClock(parameters = []) {
  const named = (node) => {
    if (!node) return false;
    if (node.type === "Identifier") return node.name === "now";
    if (node.type === "AssignmentPattern") return named(node.left);
    if (node.type === "RestElement") return named(node.argument);
    if (node.type === "ObjectPattern") return node.properties.some((property) => (property.type === "RestElement" ? named(property.argument) : named(property.value) || (property.key?.type === "Identifier" && property.key.name === "now")));
    if (node.type === "ArrayPattern") return node.elements.some((element) => named(element));
    return false;
  };
  return parameters.some((parameter) => named(parameter));
}

const isFunction = (node) => node?.type === "FunctionDeclaration" || node?.type === "FunctionExpression" || node?.type === "ArrowFunctionExpression";

/**
 * Elapsed time and deadlines, which are the wall clock's job: either side of a `-` (how long since)
 * or a `+` (how long until). A step's time budget and a scan's deadline are real seconds, and a
 * fixed test clock would make them expire instantly or never.
 */
const measuresElapsedTime = (node) => node.parent?.type === "BinaryExpression" && ["-", "+"].includes(node.parent.operator);

/**
 * A fallback for a clock that was not passed (`now ?? Date.now()`, `limits.now ?? (() => Date.now())`).
 * Writing the default next to the thing it defaults is the same correct pattern as a parameter's.
 */
const isFallback = (node) => node.parent?.type === "LogicalExpression" && ["??", "||"].includes(node.parent.operator) && node.parent.right === node
  || (node.parent?.type === "ArrowFunctionExpression" && node.parent.body === node && node.parent.parent?.type === "LogicalExpression" && ["??", "||"].includes(node.parent.parent.operator) && node.parent.parent.right === node.parent);

/**
 * Inside the initialiser of a parameter — where `now = () => Date.now()` is exactly right.
 *
 * Done by source range against the enclosing function's parameter list, not by walking up looking
 * for an AssignmentPattern: `now = () => Date.now()` puts the read in a concise arrow body, and the
 * first version of this bailed out at that arrow before it ever reached the parameter. It passed
 * every test written for it and reported 151 parameter defaults across the tree.
 */
function isParameterDefault(node) {
  // Every enclosing function, not the innermost: in `now = () => Date.now()` the innermost function
  // IS the arrow holding the read, and its own parameter list is empty.
  for (let current = node.parent; current; current = current.parent) {
    if (!isFunction(current)) continue;
    if ((current.params ?? []).some((parameter) => parameter.range[0] <= node.range[0] && node.range[1] <= parameter.range[1])) return true;
  }
  return false;
}

/**
 * `const started = Date.now()` whose variable is only ever added to or subtracted from: the reading
 * is a stopwatch mark, not a date, and the arithmetic happens a few lines later where
 * `measuresElapsedTime` cannot see it. Checked through the variable's own references, so a mark that
 * is stored, returned or formatted instead is still reported.
 */
function isStopwatchMark(node, context) {
  const declarator = node.parent;
  if (declarator?.type !== "VariableDeclarator" || declarator.init !== node || declarator.id.type !== "Identifier") return false;
  const [variable] = context.sourceCode.getDeclaredVariables(declarator);
  if (!variable || variable.references.length === 0) return false;
  return variable.references.every((reference) => {
    if (reference.init) return true;
    const used = reference.identifier;
    return used.parent?.type === "BinaryExpression" && ["-", "+"].includes(used.parent.operator);
  });
}

export default {
  meta: {
    type: "problem",
    docs: { description: "Read the clock a function was given, not the wall clock" },
    schema: [],
    messages: {
      wallClock: "This function was given a clock (`now`), so use it: `{{read}}` here is a date the wall clock decides, which no test can pin. Add or subtract two readings to measure elapsed time; otherwise call `now()`.",
    },
  },
  create(context) {
    /** The nesting of functions, each saying whether a clock is in scope at that depth. */
    const scopes = [false];
    const inScope = () => scopes[scopes.length - 1];

    const enter = (node) => { scopes.push(inScope() || declaresClock(node.params)); };
    const leave = () => { scopes.pop(); };

    function report(node, read) {
      if (!inScope() || measuresElapsedTime(node) || isFallback(node) || isParameterDefault(node) || isStopwatchMark(node, context)) return;
      context.report({ node, messageId: "wallClock", data: { read } });
    }

    return {
      FunctionDeclaration: enter,
      "FunctionDeclaration:exit": leave,
      FunctionExpression: enter,
      "FunctionExpression:exit": leave,
      ArrowFunctionExpression: enter,
      "ArrowFunctionExpression:exit": leave,
      CallExpression(node) {
        if (node.callee.type !== "MemberExpression") return;
        if (node.callee.object?.name !== "Date" || node.callee.property?.name !== "now") return;
        if (node.arguments.length !== 0) return;
        report(node, "Date.now()");
      },
      NewExpression(node) {
        if (node.callee?.name !== "Date" || node.arguments.length !== 0) return;
        report(node, "new Date()");
      },
    };
  },
};
