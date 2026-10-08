/**
 * A host's own tools, run where the harness runs (M45.8): the CLI's, or any host's whose tools are
 * functions in the same process. BoxPilot's agents run theirs in the web service instead, with the
 * same rules (server/agents/service.mjs).
 *
 * A tool declares a name the model calls it by, a plain description, a parameter schema, its kind
 * and `run`:
 * - `read` runs when the model asks;
 * - `write` and `operation` change something, so each call waits for the host's `approve`, and
 *   none runs once the run has read something that looked like an instruction (taint).
 *
 * Every input is checked against the schema before anything runs. Every output is data, never
 * instructions: redacted, made safe (safety/guard.mjs), numbered T1, T2 ... and boxed, and text that
 * reads like an instruction marks the run. A tool that fails, times out or is refused answers the
 * model in a sentence, and the run goes on.
 */
import { sanitizeUntrusted, wrapToolOutput } from "../safety/guard.mjs";

export const toolKinds = Object.freeze(["read", "write", "operation"]);

const namePattern = /^[a-z][a-z0-9_]{0,63}$/;

/**
 * A tool, checked when it is made rather than on a run's first call.
 *
 * @param {{
 *   name: string, title?: string, description: string, kind: "read" | "write" | "operation",
 *   parameters?: object,
 *   run: (input: object, context: { signal: AbortSignal }) => Promise<string | { text: string, title?: string }> | string | { text: string, title?: string },
 *   describe?: (input: object) => string,
 * }} tool `describe` says what one call would do, for the person asked to approve it.
 */
export function defineTool(tool) {
  if (!namePattern.test(String(tool?.name ?? ""))) throw new TypeError(`A tool's name is lower case letters, digits and _: ${tool?.name}`);
  if (!toolKinds.includes(tool.kind)) throw new TypeError(`${tool.name}: its kind is one of ${toolKinds.join(", ")}`);
  if (typeof tool.description !== "string" || !tool.description.trim()) throw new TypeError(`${tool.name} needs a description`);
  if (typeof tool.run !== "function") throw new TypeError(`${tool.name} needs a run function`);
  const parameters = tool.parameters ?? { type: "object", properties: {}, additionalProperties: false };
  if (parameters.type !== "object") throw new TypeError(`${tool.name}: its parameters are an object schema`);
  return Object.freeze({ ...tool, title: tool.title ?? tool.name, parameters });
}

const typeOf = (value) => (value === null ? "null" : Array.isArray(value) ? "array" : Number.isInteger(value) ? "integer" : typeof value);

/**
 * Whether `value` fits `schema`: null when it does, else a sentence saying where it does not. The
 * JSON Schema a tool needs: object (properties, required, additionalProperties), array (items,
 * maxItems), string (enum, minLength, maxLength, pattern), integer and number (minimum, maximum),
 * boolean, a list of types, and anyOf.
 */
export function checkInput(schema, value, at = "input") {
  if (!schema || typeof schema !== "object") return null;
  if (Array.isArray(schema.anyOf)) return schema.anyOf.some((option) => checkInput(option, value, at) === null) ? null : `${at} does not fit any of its allowed shapes`;
  const types = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : [];
  const actual = typeOf(value);
  if (types.length && !types.some((type) => type === actual || (type === "number" && actual === "integer"))) return `${at} should be ${types.join(" or ")}, not ${actual}`;
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) return `${at} should be one of ${schema.enum.map((entry) => JSON.stringify(entry)).join(", ")}`;
  if (actual === "string") {
    if (Number.isInteger(schema.minLength) && value.length < schema.minLength) return `${at} is shorter than ${schema.minLength} characters`;
    if (Number.isInteger(schema.maxLength) && value.length > schema.maxLength) return `${at} is longer than ${schema.maxLength} characters`;
    if (typeof schema.pattern === "string" && !new RegExp(schema.pattern, "u").test(value)) return `${at} is not in the form it should be`;
  }
  if (actual === "integer" || actual === "number") {
    if (Number.isFinite(schema.minimum) && value < schema.minimum) return `${at} is below ${schema.minimum}`;
    if (Number.isFinite(schema.maximum) && value > schema.maximum) return `${at} is above ${schema.maximum}`;
  }
  if (actual === "array") {
    if (Number.isInteger(schema.maxItems) && value.length > schema.maxItems) return `${at} has more than ${schema.maxItems} items`;
    for (const [index, item] of value.entries()) {
      const problem = checkInput(schema.items, item, `${at}[${index}]`);
      if (problem) return problem;
    }
  }
  if (actual === "object") {
    const properties = schema.properties ?? {};
    const where = (name) => (at === "input" ? name : `${at}.${name}`);
    for (const name of schema.required ?? []) if (!(name in value)) return `${where(name)} is missing`;
    for (const [name, entry] of Object.entries(value)) {
      if (!(name in properties)) {
        if (schema.additionalProperties === false) return `${where(name)} is not a parameter of this tool`;
        continue;
      }
      const problem = checkInput(properties[name], entry, where(name));
      if (problem) return problem;
    }
  }
  return null;
}

/**
 * The tools of one run.
 *
 * @param {{
 *   tools: ReturnType<typeof defineTool>[],
 *   approve?: (request: { tool: string, title: string, kind: string, input: object, summary: string }) => Promise<boolean> | boolean,
 *   redact?: (text: string) => string,
 *   maxChars?: number,
 *   maxCalls?: number,
 *   timeoutMs?: number,
 *   signal?: AbortSignal | null,
 *   now?: () => number,
 *   onCall?: (entry: { name: string, input: object | null, state: "done" | "refused" | "failed", output: string, index: number | null, flags: object, durationMs: number }) => void,
 * }} options `approve` answers for the person; without one, nothing that changes anything runs.
 */
export function createToolbox({ tools, approve = async () => false, redact = (text) => text, maxChars = 6_000, maxCalls = 24, timeoutMs = 30_000, signal = null, now = () => Date.now(), onCall = () => {} }) {
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  if (byName.size !== tools.length) throw new TypeError("Two tools share a name");
  const outputs = [];
  let calls = 0;
  let taint = null;

  const answer = (entry) => { onCall(entry); return { ok: entry.state === "done", index: entry.index, title: entry.title ?? null, content: entry.content ?? entry.output, flags: entry.flags }; };

  /** One call the model made: `{ id, name, arguments }`, the arguments as JSON text or an object. */
  async function call({ name, arguments: raw }) {
    const started = now();
    const base = { name: String(name), input: null, index: null, flags: {}, durationMs: 0 };
    const tool = byName.get(String(name));
    if (!tool) return answer({ ...base, state: "failed", output: `There is no tool called ${String(name).slice(0, 64)}. The tools are: ${[...byName.keys()].join(", ")}.` });
    if (calls >= maxCalls) return answer({ ...base, state: "refused", output: `This run has used all ${maxCalls} of its tool calls. Answer with what you have.`, flags: { limit: true } });
    calls += 1;
    let input;
    try { input = typeof raw === "string" ? JSON.parse(raw || "{}") : raw ?? {}; } catch { return answer({ ...base, state: "failed", output: `The arguments for ${tool.name} were not JSON.` }); }
    const problem = checkInput(tool.parameters, input);
    if (problem) return answer({ ...base, input, state: "failed", output: `${tool.name} was not run: ${problem}.` });
    if (tool.kind !== "read") {
      // A run that read something that looked like an instruction changes nothing, whoever would approve.
      if (taint) return answer({ ...base, input, state: "refused", output: `${tool.name} was not run: this run read something that looked like an instruction (${taint.at}), so it changes nothing. Say what you would have done instead.`, flags: { tainted: true } });
      const summary = tool.describe ? String(tool.describe(input)) : `${tool.title} ${JSON.stringify(input)}`;
      let approved = false;
      try { approved = Boolean(await approve({ tool: tool.name, title: tool.title, kind: tool.kind, input, summary })); } catch { approved = false; }
      if (!approved) return answer({ ...base, input, state: "refused", output: `${tool.name} was not run: the person did not approve it (${summary.slice(0, 200)}).`, flags: { declined: true } });
    }
    const signals = [AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])];
    let produced;
    try {
      produced = await tool.run(input, { signal: AbortSignal.any(signals) });
    } catch (error) {
      if (signal?.aborted) throw error;
      const why = error?.name === "TimeoutError" ? `it took longer than ${Math.round(timeoutMs / 1000)} s` : String(error?.message ?? error).slice(0, 300);
      return answer({ ...base, input, state: "failed", output: `${tool.name} failed: ${why}`, durationMs: now() - started });
    }
    const text = typeof produced === "string" ? produced : String(produced?.text ?? "");
    const title = (typeof produced === "object" && produced?.title) || tool.title;
    const safe = sanitizeUntrusted(text, { maxChars, redact });
    const index = outputs.length + 1;
    const flags = { ...(safe.flags.injection ? { injection: true, matches: safe.flags.matches } : {}), ...(safe.flags.truncated ? { truncated: true } : {}) };
    if (safe.flags.injection && !taint) taint = { at: `T${index}`, matches: safe.flags.matches };
    outputs.push({ id: `T${index}`, title, text: safe.text });
    return answer({ ...base, input, state: "done", index, title, output: safe.text, content: wrapToolOutput({ index, tool: tool.name, text: safe.text, flags: safe.flags }), flags, durationMs: now() - started });
  }

  return {
    /** The tools as the model is offered them. */
    schemas: tools.map((tool) => ({ type: "function", function: { name: tool.name, description: tool.description, parameters: tool.parameters } })),
    call,
    /** What the tools returned, for the check and for an answer the model could not write. */
    outputs: () => outputs.map((output) => ({ ...output })),
    /** Where the run read something that looked like an instruction, or null. */
    taint: () => (taint ? { ...taint } : null),
    calls: () => calls,
  };
}
