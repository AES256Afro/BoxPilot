/**
 * Operation registry — the single place an operation is declared (ADR-001).
 *
 * One entry per operation supplies everything the helper, the protocol validator,
 * the job engine, and the UI need: the id, a human title, a risk tier, whether it
 * is read-only (skips the mutation queue), a timeout, a parameter spec, and `run`.
 *
 * During the transition the helper protocol unions this registry with its legacy
 * hand-written allowlists; new operations must be declared here, not there.
 */

export const riskTiers = Object.freeze(["low", "medium", "high"]);
export const defaultTimeoutMs = 180_000;
/**
 * The most time any operation may be given by "Try again with more time" (M30.3). Twelve hours is
 * the longest budget registered today, and the root task runner's own ceiling sits just under it.
 */
export const moreTimeCeilingMs = 12 * 60 * 60_000;

/**
 * The budget a job of this operation runs with. A requested budget counts only when the operation
 * offers more time and the request falls between its normal budget and its maximum; anything else
 * is the normal budget, so a stored or forged value can never shorten or stretch an operation that
 * did not ask for it.
 */
export function budgetFor(operation, requestedMs = null) {
  const normal = operation?.timeoutMs ?? defaultTimeoutMs;
  if (!operation?.maxTimeoutMs || !Number.isInteger(requestedMs)) return normal;
  return requestedMs >= normal && requestedMs <= operation.maxTimeoutMs ? requestedMs : normal;
}

/**
 * What "Try again with more time" gives an operation whose budget ran out: twice the budget it
 * had, up to its declared maximum. Null when it offers no more time or already had the maximum.
 */
export function nextBudgetMs(operation, spentMs = null) {
  if (!operation?.maxTimeoutMs) return null;
  const spent = budgetFor(operation, spentMs);
  return spent >= operation.maxTimeoutMs ? null : Math.min(spent * 2, operation.maxTimeoutMs);
}

/**
 * Whether a job of this operation that a BoxPilot restart cut off is simply run again (M30.2):
 * reads always are, and anything else only when its entry says so (`rerunAfterInterrupt`).
 */
export const rerunsAfterInterrupt = (operation) => Boolean(operation && (operation.readOnly || operation.rerunAfterInterrupt));

const idPattern = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/;

/**
 * Parameter spec: `{ exact: true, fields: { name: { type, pattern?, nullable?, enum?, maxLength?, validate? } } }`.
 * `exact` (default true) rejects any key not listed. Every listed key is required unless `optional: true`.
 * Returns an error string or null. Deliberately tiny; swap for JSON Schema later without changing callers.
 */
export function validateParameters(spec, parameters, title = "Operation") {
  if (!parameters || typeof parameters !== "object" || Array.isArray(parameters)) return `${title} parameters must be an object`;
  const fields = spec?.fields ?? {};
  const exact = spec?.exact !== false;
  const names = Object.keys(fields);
  const keys = Object.keys(parameters);
  if (names.length === 0) return keys.length === 0 ? null : `${title} accepts no parameters`;
  if (exact) {
    for (const key of keys) if (!Object.hasOwn(fields, key)) return `${title} does not accept parameter "${key}"`;
  }
  for (const name of names) {
    const field = fields[name];
    const present = Object.prototype.hasOwnProperty.call(parameters, name);
    if (!present) {
      if (field.optional) continue;
      return `${title} requires parameter "${name}"`;
    }
    const value = parameters[name];
    if (value === null) {
      if (field.nullable) continue;
      return `${title} parameter "${name}" must not be null`;
    }
    const expectedType = field.type ?? "string";
    const actualType = Array.isArray(value) ? "array" : typeof value;
    if (expectedType !== "any" && actualType !== expectedType) return `${title} parameter "${name}" must be a ${expectedType}`;
    if (expectedType === "string") {
      if (field.maxLength && value.length > field.maxLength) return `${title} parameter "${name}" is too long`;
      if (field.pattern && !field.pattern.test(value)) return `${title} parameter "${name}" has an invalid value`;
      if (field.enum && !field.enum.includes(value)) return `${title} parameter "${name}" must be one of ${field.enum.join(", ")}`;
    }
    if (expectedType === "number" && !Number.isFinite(value)) return `${title} parameter "${name}" must be a finite number`;
    if (typeof field.validate === "function") {
      const problem = field.validate(value, parameters);
      if (problem) return `${title} parameter "${name}": ${problem}`;
    }
  }
  return null;
}

/** Why an internal operation is not staged, scheduled, put in a flow or run from the operations route. */
export const internalRefusal = (operation) => `${operation.title} is BoxPilot's own plumbing: BoxPilot runs it itself when it needs it`;

export function defineOperation(definition) {
  const { id, title, risk, readOnly = false, elevatedOnly = false, internal = false, timeoutMs = defaultTimeoutMs, maxTimeoutMs = null, rerunAfterInterrupt = false, parameters = { fields: {} }, run, description = "", minimumRole = null, confirm = null, restartsService = false, supersededWhen = null, oneTimeFields = [] } = definition ?? {};
  if (typeof id !== "string" || !idPattern.test(id)) throw new Error(`Operation id "${id}" must be lower-case dotted segments`);
  if (typeof title !== "string" || !title.trim()) throw new Error(`Operation ${id} needs a title`);
  if (!riskTiers.includes(risk)) throw new Error(`Operation ${id} risk must be one of ${riskTiers.join(", ")}`);
  if (typeof run !== "function") throw new Error(`Operation ${id} needs a run(parameters, dependencies) function`);
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) throw new Error(`Operation ${id} timeoutMs must be a positive integer`);
  if (readOnly && risk !== "low") throw new Error(`Operation ${id} is read-only and must be low risk`);
  if (minimumRole !== null && !["owner", "operator"].includes(minimumRole)) throw new Error(`Operation ${id} minimumRole must be owner or operator`);
  if (confirm !== null && typeof confirm !== "function") throw new Error(`Operation ${id} confirm must be a function of the parameters returning the text to type`);
  if (supersededWhen !== null && (typeof supersededWhen !== "function" || readOnly)) throw new Error(`Operation ${id} supersededWhen must be a function, and only a staged job can be superseded`);
  for (const [name, field] of Object.entries(parameters?.fields ?? {})) {
    if (field?.secretEnvOf === undefined) continue;
    if (field.type !== "object" || field.secret) throw new Error(`Operation ${id} parameter ${name}: secretEnvOf belongs on an object field that is not itself secret`);
    if (!Object.hasOwn(parameters.fields, field.secretEnvOf)) throw new Error(`Operation ${id} parameter ${name}: secretEnvOf names ${field.secretEnvOf}, which is not a parameter`);
  }
  // maxTimeoutMs: the most time "Try again with more time" may give it. Only a job can be retried,
  // and a budget that cannot grow past the normal one is not an offer.
  if (maxTimeoutMs !== null) {
    if (readOnly) throw new Error(`Operation ${id} is read-only; only a job can be given more time`);
    if (!Number.isInteger(maxTimeoutMs) || maxTimeoutMs <= timeoutMs || maxTimeoutMs > moreTimeCeilingMs) throw new Error(`Operation ${id} maxTimeoutMs must be an integer above timeoutMs and at most ${moreTimeCeilingMs} ms`);
  }
  // rerunAfterInterrupt: running it a second time, from the start, after a restart cut the first run
  // off leaves the server as one clean run would. Staged secrets are gone after a restart, a typed
  // confirmation is a promise nobody made twice, and a restart of BoxPilot itself would loop, so
  // none of those can be declared.
  if (rerunAfterInterrupt) {
    if (risk === "high") throw new Error(`Operation ${id} is high risk and cannot run again on its own`);
    if (confirm !== null || restartsService) throw new Error(`Operation ${id} asks for a typed confirmation or restarts BoxPilot, so it cannot run again on its own`);
    if (Object.values(parameters?.fields ?? {}).some((field) => field?.secret === true || field?.secretEnvOf !== undefined)) throw new Error(`Operation ${id} takes secrets, which do not survive a restart, so it cannot run again on its own`);
  }
  // oneTimeFields: fields of the result that are shown to the person who ran the job once, and never
  // stored with it (Zulip's single-use organization link). The job's record says which were given.
  if (!Array.isArray(oneTimeFields) || oneTimeFields.length > 4 || oneTimeFields.some((field) => typeof field !== "string" || !/^[a-z][A-Za-z0-9]{0,31}$/.test(field))) throw new Error(`Operation ${id} oneTimeFields must be up to 4 result field names`);
  if (oneTimeFields.length && readOnly) throw new Error(`Operation ${id} is read-only; its result is never stored, so nothing needs to be shown once`);
  // minimumRole: who may stage/approve regardless of tier (e.g. anything that sends data off the box is owner-only).
  // confirm(parameters): text the approver must type for destructive jobs; checked server-side at approval.
  // restartsService: the operation restarts (or reboots) the BoxPilot service, so approving it while
  // another job runs would interrupt that job. The job service refuses the approval when so.
  // supersededWhen(parameters, { version }): why a job of this operation, staged and still waiting,
  // no longer has anything to do (an update to a version already running), or null. The job service
  // cancels such a job with that reason rather than let it wait for an approval that would do harm
  // or nothing (M36).
  // internal: BoxPilot's own plumbing, run by BoxPilot itself (the agents' Zulip posts and reads):
  // never a step an agent or the assistant may propose (validatePlan drops it).
  return Object.freeze({ id, title, description, risk, readOnly: Boolean(readOnly), elevatedOnly: Boolean(elevatedOnly), internal: Boolean(internal), timeoutMs, maxTimeoutMs, rerunAfterInterrupt: Boolean(rerunAfterInterrupt), parameters, run, minimumRole, confirm, restartsService: Boolean(restartsService), supersededWhen, oneTimeFields: Object.freeze([...oneTimeFields]) });
}

export class OperationRegistry {
  #operations = new Map();
  #riskHooks = {};

  /**
   * What raises an operation's tier for what it acts on: installing an app its manifest calls high
   * risk. The web process gives these the same hooks it gives the job layer, so a card an agent or
   * the assistant builds says the tier the job will be staged at (sweep 3).
   */
  useRiskHooks(hooks = {}) {
    this.#riskHooks = { ...(hooks ?? {}) };
    return this;
  }

  /** The tier a job for this operation and these parameters is staged at; null for an unknown operation. */
  async effectiveRisk(id, parameters = {}) {
    const operation = this.#operations.get(id);
    if (!operation) return null;
    const hook = this.#riskHooks[id];
    if (typeof hook !== "function") return operation.risk;
    // It can raise the tier, never lower it; an answer that is not a tier counts for nothing.
    const raised = await hook(parameters ?? {});
    return riskTiers.indexOf(raised) > riskTiers.indexOf(operation.risk) ? raised : operation.risk;
  }

  register(definition) {
    const operation = Object.isFrozen(definition) && definition.run ? definition : defineOperation(definition);
    if (this.#operations.has(operation.id)) throw new Error(`Operation ${operation.id} is already registered`);
    this.#operations.set(operation.id, operation);
    return operation;
  }

  registerAll(definitions) {
    for (const definition of definitions) this.register(definition);
    return this;
  }

  has(id) { return this.#operations.has(id); }
  get(id) { return this.#operations.get(id) ?? null; }
  ids() { return [...this.#operations.keys()]; }
  list() { return [...this.#operations.values()]; }
  readOnlyIds() { return this.list().filter((operation) => operation.readOnly).map((operation) => operation.id); }
  timeoutFor(id) { return this.#operations.get(id)?.timeoutMs ?? null; }
  /** The budget one request runs under: its own if the operation accepts it (see budgetFor), else the normal one. */
  budgetFor(id, requestedMs = null) { const operation = this.#operations.get(id); return operation ? budgetFor(operation, requestedMs) : null; }

  /** Returns an error string or null. */
  validate(id, parameters) {
    const operation = this.#operations.get(id);
    if (!operation) return "Operation is not registered";
    return validateParameters(operation.parameters, parameters, operation.title);
  }

  async execute(id, parameters, dependencies = {}) {
    const operation = this.#operations.get(id);
    if (!operation) throw new Error("Operation is not registered");
    const error = this.validate(id, parameters);
    if (error) throw new Error(error);
    return operation.run(parameters, dependencies);
  }

  /** Public, serializable description for the API and UI (no run functions). */
  describe() {
    return this.list().map(({ id, title, description, risk, readOnly, elevatedOnly, timeoutMs, parameters }) => ({
      id, title, description, risk, readOnly, elevatedOnly, timeoutMs, parameterNames: Object.keys(parameters?.fields ?? {}),
    }));
  }
}

export function createRegistry(modules = []) {
  const registry = new OperationRegistry();
  for (const module of modules) registry.registerAll(typeof module === "function" ? module() : module);
  return registry;
}

/** What a secret looks like wherever parameters are stored or shown: the jobs table, the job API. */
export const secretPlaceholder = "[secret]";

const isPlainObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
// Absent, null and "" hold nothing to protect: a blank secret is asked for again at run time. Any
// other value does, whatever its type; values.env takes numbers, and the deployer stringifies them.
const holdsValue = (value) => value !== undefined && value !== null && value !== "";

/**
 * Where the secrets sit in one operation's parameters (M29.1): the key path of every value that
 * must never be stored or shown. A secret is a shape the parameter spec declares, not a flag each
 * caller remembers to look for, so the job service, the scheduler and flows all ask here and a new
 * nesting is declared once, in the spec, rather than taught to each of them.
 *
 * - `secret: true` on a field: the whole value is a secret.
 * - `secretEnvOf: "<field>"` on an object field: an app's install values. `<field>.env.<NAME>` is
 *   a secret when the manifest of the app named by parameter `<field>` calls NAME a password or a
 *   secret. `secretEnvNamesFor(appId)` asks the catalog, answering the names, or null when it does
 *   not know the app. Not knowing is not permission to store: with no answer, or no one to ask,
 *   every env value that holds something counts as a secret.
 *
 * Paths are arrays of keys, in the spec's order. The placeholder holds a value, so the paths of a
 * stored record are the paths it was staged with.
 */
export async function secretPaths(operation, parameters, { secretEnvNamesFor = null } = {}) {
  if (!isPlainObject(parameters)) return [];
  const paths = [];
  for (const [name, field] of Object.entries(operation?.parameters?.fields ?? {})) {
    if (!field || !Object.hasOwn(parameters, name)) continue;
    const value = parameters[name];
    if (field.secret === true) {
      if (holdsValue(value)) paths.push([name]);
      continue;
    }
    if (typeof field.secretEnvOf !== "string" || !isPlainObject(value) || !isPlainObject(value.env)) continue;
    const held = Object.keys(value.env).filter((key) => holdsValue(value.env[key]));
    if (!held.length) continue;
    const appId = parameters[field.secretEnvOf];
    const declared = typeof secretEnvNamesFor === "function" && typeof appId === "string" ? await secretEnvNamesFor(appId) : null;
    for (const key of Array.isArray(declared) ? held.filter((entry) => declared.includes(entry)) : held) paths.push([name, "env", key]);
  }
  return paths;
}

function readPath(object, path) {
  return path.reduce((node, key) => (isPlainObject(node) && Object.hasOwn(node, key) ? node[key] : undefined), object);
}

/** A copy with `value` at `path`: each object on the way is copied, everything else shared. */
function withValueAt(object, path, value) {
  const [key, ...rest] = path;
  const copy = { ...object };
  const child = isPlainObject(object) && Object.hasOwn(object, key) && isPlainObject(object[key]) ? object[key] : {};
  const next = rest.length ? withValueAt(child, rest, value) : value;
  // Defined, not assigned: a key spelled __proto__ (JSON.parse makes it an own key) stays a key.
  Object.defineProperty(copy, key, { value: next, enumerable: true, writable: true, configurable: true });
  return copy;
}

/** The parameters as they may be stored, shown or logged: each secret replaced by the placeholder. */
export function maskSecrets(parameters, paths) {
  return paths.reduce((masked, path) => withValueAt(masked, path, secretPlaceholder), parameters ?? {});
}

/** Split parameters into the record that may be stored and the secrets that stay in memory. */
export function splitSecrets(parameters, paths) {
  return { stored: maskSecrets(parameters, paths), secrets: paths.map((path) => ({ path, value: readPath(parameters, path) })) };
}

/** Put staged secrets back wherever the stored record holds the placeholder, at run time. */
export function restoreSecrets(stored, secrets = []) {
  return secrets.reduce((restored, { path, value }) => (readPath(restored, path) === secretPlaceholder ? withValueAt(restored, path, value) : restored), stored ?? {});
}

/** Paths still holding the placeholder: a secret whose staged copy is gone. Nothing may run with one. */
export function placeholderPaths(parameters) {
  const found = [];
  const walk = (value, path) => {
    if (value === secretPlaceholder) found.push(path);
    else if (Array.isArray(value)) value.forEach((item, index) => walk(item, [...path, index]));
    else if (isPlainObject(value)) for (const key of Object.keys(value)) walk(value[key], [...path, key]);
  };
  walk(parameters, []);
  return found;
}
