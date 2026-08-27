/**
 * Values between flow steps (M13.3): a later step's parameters may read an earlier step's result.
 *
 * A step with a name leaves its job's recorded result behind under that name, and a later step
 * writes `{{ steps.name.field }}` (dots to go deeper) in a parameter value to read a piece of it.
 * This file is the whole expression language, and it is deliberately not a language: no eval, no
 * functions, no arithmetic, no reach outside the map of named results handed in. A parameter that
 * is exactly one placeholder keeps the value's own type; a placeholder inside a longer string must
 * name a primitive, because splicing an object into a string never means anything.
 */

export const stepNamePattern = /^[a-z][a-z0-9-]{0,23}$/;

// Path segments are plain identifier characters, which keeps every prototype-chain spelling that
// matters out by shape alone except __proto__ and constructor, refused by name below.
// Built fresh per use: a shared global regex carries lastIndex between calls (test() advances it,
// and matchAll clones it lastIndex and all), which silently skipped references.
const placeholderSource = String.raw`\{\{\s*steps\.([a-z][a-z0-9-]{0,23})((?:\.[A-Za-z0-9_-]+)+)\s*\}\}`;
const placeholderPattern = () => new RegExp(placeholderSource, "g");
const forbiddenSegments = new Set(["__proto__", "constructor", "prototype"]);

/** Every `{{ steps.name.path }}` reference in a step's parameters, for validation ahead of a run. */
export function referencesIn(parameters) {
  const references = [];
  const walk = (value) => {
    if (typeof value === "string") {
      for (const match of value.matchAll(placeholderPattern())) {
        references.push({ step: match[1], path: match[2].slice(1).split(".") });
      }
    } else if (Array.isArray(value)) {
      value.forEach(walk);
    } else if (value && typeof value === "object") {
      Object.values(value).forEach(walk);
    }
  };
  walk(parameters ?? {});
  return references;
}

/** True when any parameter value carries a placeholder, so save-time validation can defer it. */
export function holdsPlaceholder(value) {
  return typeof value === "string"
    ? placeholderPattern().test(value)
    : Array.isArray(value) ? value.some(holdsPlaceholder)
    : value && typeof value === "object" ? Object.values(value).some(holdsPlaceholder)
    : false;
}

function lookUp(results, stepName, path) {
  if (!Object.hasOwn(results, stepName)) {
    throw new Error(`it reads steps.${stepName}, and no earlier step with that name has finished`);
  }
  let current = results[stepName];
  for (const segment of path) {
    if (forbiddenSegments.has(segment)) throw new Error(`steps.${stepName}.${path.join(".")} is not a readable path`);
    const readable = current !== null && typeof current === "object" && Object.hasOwn(current, segment);
    if (!readable) {
      throw new Error(`it reads steps.${stepName}.${path.join(".")}, which that step's recorded result does not contain`);
    }
    current = current[segment];
  }
  return current;
}

/**
 * The step's parameters with every placeholder replaced by the value it names, or an error that
 * says which reference failed. `results` maps a named earlier step to its job's recorded result.
 */
export function resolveValues(parameters, results) {
  const resolve = (value) => {
    if (typeof value === "string") {
      // Exactly one placeholder and nothing else keeps the value's own type: a step that
      // recorded a number hands a number on.
      const whole = new RegExp(`^${placeholderSource}$`).exec(value.trim());
      if (whole) return lookUp(results, whole[1], whole[2].slice(1).split("."));
      return value.replace(placeholderPattern(), (_, stepName, dottedPath) => {
        const found = lookUp(results, stepName, dottedPath.slice(1).split("."));
        if (found !== null && typeof found === "object") {
          throw new Error(`steps.${stepName}${dottedPath} is a whole object; inside a longer string only a single value can be spliced`);
        }
        return String(found ?? "");
      });
    }
    if (Array.isArray(value)) return value.map(resolve);
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, resolve(entry)]));
    return value;
  };
  return resolve(parameters ?? {});
}
