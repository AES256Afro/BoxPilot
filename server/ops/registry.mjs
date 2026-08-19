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
    for (const key of keys) if (!(key in fields)) return `${title} does not accept parameter "${key}"`;
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

export function defineOperation(definition) {
  const { id, title, risk, readOnly = false, elevatedOnly = false, timeoutMs = defaultTimeoutMs, parameters = { fields: {} }, run, description = "" } = definition ?? {};
  if (typeof id !== "string" || !idPattern.test(id)) throw new Error(`Operation id "${id}" must be lower-case dotted segments`);
  if (typeof title !== "string" || !title.trim()) throw new Error(`Operation ${id} needs a title`);
  if (!riskTiers.includes(risk)) throw new Error(`Operation ${id} risk must be one of ${riskTiers.join(", ")}`);
  if (typeof run !== "function") throw new Error(`Operation ${id} needs a run(parameters, dependencies) function`);
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) throw new Error(`Operation ${id} timeoutMs must be a positive integer`);
  if (readOnly && risk !== "low") throw new Error(`Operation ${id} is read-only and must be low risk`);
  return Object.freeze({ id, title, description, risk, readOnly: Boolean(readOnly), elevatedOnly: Boolean(elevatedOnly), timeoutMs, parameters, run });
}

export class OperationRegistry {
  #operations = new Map();

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
