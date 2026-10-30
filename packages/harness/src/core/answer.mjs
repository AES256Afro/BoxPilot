/**
 * An answer the host asked for as JSON (M45.8, from BoxPilot's prompt.mjs): the fields named, each a
 * string, and the answer read back against them.
 */

/**
 * The JSON a structured answer must be, for `response_format`: the fields the host named, each a
 * string. Used on the final call only, so tool calls stay free.
 */
export function answerFormat(fields) {
  return {
    type: "json_schema",
    json_schema: { name: "answer", strict: true, schema: { type: "object", additionalProperties: false, required: fields.map((field) => field.name), properties: Object.fromEntries(fields.map((field) => [field.name, { type: "string", description: field.description || field.name }])) } },
  };
}

/** A structured answer, checked against its fields: `{ value }` or `{ problem }`. */
export function readStructuredAnswer(text, fields) {
  let value;
  try { value = JSON.parse(String(text ?? "").trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "")); } catch { return { problem: "The answer was not JSON" }; }
  if (!value || typeof value !== "object" || Array.isArray(value)) return { problem: "The answer was not an object" };
  const out = {};
  for (const field of fields) {
    const entry = value[field.name];
    if (entry === undefined || entry === null) return { problem: `The answer had no ${field.name}` };
    out[field.name] = typeof entry === "string" ? entry.slice(0, 2_000) : JSON.stringify(entry).slice(0, 2_000);
  }
  return { value: out };
}
