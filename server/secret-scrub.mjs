/**
 * Secrets stored before they were refused (M29.3).
 *
 * M29.1 closed the doors: a job stages its secrets in memory, and a schedule or flow refuses one.
 * Rows written before that can still hold a secret in clear: an app's token in values.env from
 * before v1.112.0, a numeric one from before M29.1, a password a schedule kept from before
 * schedules refused them. They were masked when served and refused at run time, but never
 * rewritten, so every controller backup copied them. This pass rewrites them, at startup.
 *
 * Where a secret sits is secretPaths' answer, as it is everywhere else, and maskSecrets puts the
 * placeholder there. The placeholder is still a value at that path, so a masked schedule is still
 * paused by the scheduler and a masked flow still refuses to run, each telling the owner why,
 * exactly as they did while the secret was there. A job whose secrets are staged in memory is left
 * alone: its record already holds placeholders, and a different answer from the catalog now must
 * not mask a setting the staged copy will not put back.
 *
 * Safe to run at every start. A value that is already the placeholder is not a change, so a second
 * pass rewrites nothing and records nothing.
 */
import { registry as defaultRegistry } from "./ops/index.mjs";
import { maskSecrets, secretPaths, secretPlaceholder } from "./ops/registry.mjs";

const isPlainObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const readPath = (object, path) => path.reduce((node, key) => (isPlainObject(node) && Object.hasOwn(node, key) ? node[key] : undefined), object);

function parse(text) {
  try { return JSON.parse(text); } catch { return undefined; }
}

/**
 * Mask every secret still held in clear in the jobs, schedules and flows tables. Returns the counts
 * the audit entry records - rows rewritten per table and secrets masked - plus `unchecked`: rows
 * left as they were because the catalog could not be read, for the next start to try again.
 */
export async function scrubStoredSecrets({ store, registry = defaultRegistry, secretEnvNamesFor = null, holdsStagedSecrets = () => false }) {
  // One catalog answer per app for the whole pass: a history of nightly reconfigures asks once.
  const answers = new Map();
  const lookup = typeof secretEnvNamesFor === "function"
    ? (appId) => {
      if (!answers.has(appId)) answers.set(appId, (async () => secretEnvNamesFor(appId))());
      return answers.get(appId);
    }
    : null;
  let unchecked = 0;

  /** The parameters with each secret still in clear masked, and how many there were; null when none. */
  async function masked(operationId, parameters) {
    const operation = typeof operationId === "string" ? registry.get(operationId) : null;
    if (!operation || !isPlainObject(parameters)) return null;
    let paths;
    try {
      paths = await secretPaths(operation, parameters, { secretEnvNamesFor: lookup });
    } catch {
      // The catalog could not be read: leave the row for the next start rather than guess.
      unchecked += 1;
      return null;
    }
    const clear = paths.filter((path) => readPath(parameters, path) !== secretPlaceholder);
    return clear.length ? { parameters: maskSecrets(parameters, clear), secrets: clear.length } : null;
  }

  const stored = store.listStoredParameters();
  const changes = { jobs: [], schedules: [], flows: [] };
  for (const job of stored.jobs) {
    if (typeof job.type !== "string" || !job.type.startsWith("op:")) continue;
    const result = await masked(job.type.slice(3), parse(job.stored));
    if (result) changes.jobs.push({ id: job.id, from: job.stored, to: JSON.stringify(result.parameters), secrets: result.secrets });
  }
  for (const schedule of stored.schedules) {
    const result = await masked(schedule.operationId, parse(schedule.stored));
    if (result) changes.schedules.push({ id: schedule.id, from: schedule.stored, to: JSON.stringify(result.parameters), secrets: result.secrets });
  }
  for (const flow of stored.flows) {
    const steps = parse(flow.stored);
    if (!Array.isArray(steps)) continue;
    let secrets = 0;
    const next = [];
    for (const step of steps) {
      const result = isPlainObject(step) ? await masked(step.operationId, step.parameters) : null;
      next.push(result ? { ...step, parameters: result.parameters } : step);
      secrets += result?.secrets ?? 0;
    }
    if (secrets) changes.flows.push({ id: flow.id, from: flow.stored, to: JSON.stringify(next), secrets });
  }
  // Nothing from here to the write waits on anything, so no job can be staged in between.
  changes.jobs = changes.jobs.filter((change) => !holdsStagedSecrets(change.id));
  return { ...store.maskStoredSecrets(changes), unchecked };
}
