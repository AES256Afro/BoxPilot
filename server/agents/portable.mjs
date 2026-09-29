/**
 * Agent definitions as files (M37): export an agent as JSON to review it, keep it, or bring it to
 * another BoxPilot; import one back as a new agent. What travels is the spec and the golden
 * questions - never runs, notes, memory, webhooks or anything about this server - and an import
 * goes through the same gate as the Builder (normalizeSpec), so a file can say nothing a person
 * could not.
 */
import { normalizeSpec } from "./spec.mjs";

export const definitionFormat = "boxpilot-agent";
export const definitionVersion = 1;

export function exportDefinition(agent, { questions = [], productVersion = null, now = new Date() } = {}) {
  return {
    format: definitionFormat,
    version: definitionVersion,
    exportedAt: now.toISOString(),
    ...(productVersion ? { boxpilot: productVersion } : {}),
    template: agent.template ?? null,
    // Agent ids mean nothing on another server: a supervisor's list of delegates travels as "*".
    spec: { ...agent.spec, orchestration: { ...agent.spec.orchestration, delegates: "*" } },
    questions,
  };
}

export class DefinitionError extends Error {
  constructor(message) { super(message); this.status = 400; this.code = "invalid_definition"; this.expose = true; }
}

/** A file's definition, checked: `{ spec, template, questions }`. Throws with a sentence otherwise. */
export function readDefinition(input) {
  let value = input;
  if (typeof input === "string") {
    if (input.length > 256 * 1024) throw new DefinitionError("That file is too large to be an agent");
    try { value = JSON.parse(input); } catch { throw new DefinitionError("That file is not JSON"); }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new DefinitionError("That is not an agent definition");
  if (value.format !== definitionFormat) throw new DefinitionError(`That is not a BoxPilot agent (format "${String(value.format ?? "").slice(0, 40)}")`);
  if (value.version !== definitionVersion) throw new DefinitionError(`This BoxPilot reads agent definitions of version ${definitionVersion}, not ${String(value.version).slice(0, 10)}`);
  let spec;
  try { spec = normalizeSpec({ ...value.spec, orchestration: { ...(value.spec?.orchestration ?? {}), delegates: "*" } }); } catch (error) { throw new DefinitionError(`The agent in that file is not valid: ${error.message}`); }
  const template = typeof value.template === "string" && /^[a-z0-9-]{1,40}$/.test(value.template) ? value.template : null;
  return { spec, template, questions: Array.isArray(value.questions) ? value.questions.slice(0, 20) : [] };
}
