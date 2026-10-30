/**
 * A JSON schema as strict structured output takes it (M45.2). Strict decoding accepts a subset of
 * JSON Schema: every object closed with `additionalProperties: false`, no length or number limits,
 * no `type: [..., "null"]` lists. This rewrites what it can without changing what the schema allows
 * (a list of types becomes `anyOf`, an `enum` without a type gets one, a limit moves into the
 * description so the model still reads it) and answers null for what it cannot: an object left
 * open, which strict decoding would close, or a value with no type at all.
 */

const limits = ["minLength", "maxLength", "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf", "pattern", "maxItems", "uniqueItems", "minProperties", "maxProperties"];
const formats = new Set(["date-time", "time", "date", "duration", "email", "hostname", "uri", "ipv4", "ipv6", "uuid"]);

class NotStrict extends Error {}

const kindOf = (value) => (value === null ? "null" : typeof value === "number" ? "number" : typeof value);

function variants(node, types) {
  const { enum: values } = node;
  return {
    anyOf: types.map((one) => {
      if (one === "null") return { type: "null" };
      const kept = Array.isArray(values) ? values.filter((value) => kindOf(value) === (one === "integer" ? "number" : one)) : undefined;
      return strict({ ...node, type: one, ...(kept ? { enum: kept } : {}) });
    }),
  };
}

function strict(node) {
  if (!node || typeof node !== "object" || Array.isArray(node)) throw new NotStrict();
  const { type, enum: values, anyOf, allOf, oneOf, properties, items, additionalProperties, required, description, format, minItems, ...rest } = node;
  if (Array.isArray(type)) return variants(node, type);
  if (type === undefined && Array.isArray(values) && !anyOf && !allOf && !oneOf) {
    const types = [...new Set(values.map(kindOf))];
    return types.length === 1 ? strict({ ...node, type: types[0] }) : variants(node, types);
  }
  if (type === undefined && !anyOf && !allOf && !oneOf && !("const" in rest)) throw new NotStrict();

  const moved = {};
  for (const key of limits) if (key in rest) { moved[key] = rest[key]; delete rest[key]; }
  if (format !== undefined && !formats.has(format)) moved.format = format;
  if (minItems !== undefined && minItems > 1) moved.minItems = minItems;

  const out = { ...rest };
  if (anyOf || oneOf) out.anyOf = (anyOf ?? oneOf).map(strict);
  if (allOf) out.allOf = allOf.map(strict);
  if (type !== undefined) out.type = type;
  if (Array.isArray(values)) out.enum = values;
  if (type === "object") {
    if (additionalProperties !== false) throw new NotStrict();
    out.properties = Object.fromEntries(Object.entries(properties ?? {}).map(([key, value]) => [key, strict(value)]));
    out.additionalProperties = false;
    if (required !== undefined) out.required = required;
  }
  if (type === "array") {
    if (items !== undefined) out.items = strict(items);
    if (minItems === 0 || minItems === 1) out.minItems = minItems;
  }
  if (format !== undefined && formats.has(format)) out.format = format;
  const note = Object.entries(moved).map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join(", ");
  if (note) out.description = `${description ? `${description}\n\n` : ""}{${note}}`;
  else if (description !== undefined) out.description = description;
  return out;
}

/**
 * The schema rewritten for strict decoding, or null when strict decoding would change what it
 * allows. Never mutates what it is given.
 *
 * @param {Record<string, unknown>} schema
 * @returns {Record<string, unknown> | null}
 */
export function strictSchema(schema) {
  try {
    return strict(structuredClone(schema));
  } catch (error) {
    if (error instanceof NotStrict) return null;
    throw error;
  }
}
