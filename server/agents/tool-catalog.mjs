/**
 * What an agent can reach (M37): a catalog of read-only tools. Every one of them only reads, except
 * that an agent may keep notes of its own and may propose a plan - a card of registered operations
 * a person approves at each step's own tier. None of them stages, approves or runs an operation,
 * and none of them talks to the root helper except through a read-only registered operation.
 *
 * Each tool declares:
 * - `role`: the least a run must read as to use it. A run reads as the person who asked (or, for a
 *   schedule or an event, as the person who made the agent), so a viewer's question never reaches
 *   an operator read (ADR-003).
 * - `cost`: cheap (answered from memory or the database), moderate (a read-only helper operation)
 *   or heavy. The Builder shows it; heavy tools wait for quiet hours on unattended runs.
 * - `params`: what it accepts, checked here before it runs. The model sees them as JSON schema.
 *
 * The model calls tools by `fn` (underscores): OpenAI-style function names allow no dots.
 */

export const toolCatalog = Object.freeze([
  {
    id: "server.facts", title: "Server facts", role: "viewer", cost: "cheap",
    description: "This server's name, operating system, kernel, processor, memory, uptime, network addresses and whether it is on the tailnet.",
    params: {},
  },
  {
    id: "apps.list", title: "Apps and containers", role: "viewer", cost: "moderate",
    description: "Every installed BoxPilot app with its container state, health, restarts and web ports, and other Docker containers on the server.",
    params: {},
  },
  {
    id: "services.status", title: "Service status", role: "viewer", cost: "moderate",
    description: "Failed systemd services, the state of BoxPilot's key services, or the state of one named unit.",
    params: { unit: { type: "string", pattern: /^[A-Za-z0-9:._@\\-]{1,200}\.(service|timer|socket|mount)$/, description: "One unit to look up, such as docker.service. Leave out for the summary." } },
  },
  {
    id: "logs.query", title: "Logs (bounded)", role: "operator", cost: "moderate",
    description: "The last lines of a journal group, one systemd unit or one container, optionally since a time and containing some text. At most 200 lines; secrets are redacted.",
    params: {
      kind: { type: "string", enum: ["group", "unit", "container"], required: true, description: "group (boxpilot, docker, tailscale, ssh, kernel), a unit, or a container." },
      target: { type: "string", maxLength: 200, required: true, description: "The group's name, the unit or the container." },
      lines: { type: "integer", min: 10, max: 200, description: "How many lines, 10 to 200. Default 60." },
      since: { type: "string", pattern: /^\d{1,3}[mhd]$/, description: "How far back, like 30m, 6h or 2d. At most 7d." },
      filter: { type: "string", maxLength: 80, pattern: /^[^\0\r\n]{1,80}$/, description: "Only lines containing this text." },
    },
  },
  {
    id: "storage.health", title: "Storage and SMART", role: "viewer", cost: "cheap",
    description: "Disk use of each mounted filesystem, drives that went read-only or dropped, and each drive's SMART health.",
    params: {},
  },
  {
    id: "docs.search", title: "Search docs and knowledge", role: "viewer", cost: "cheap",
    description: "Search BoxPilot's documents, its registered operations, the app catalog and the owner's own documents.",
    params: {
      query: { type: "string", maxLength: 300, required: true, description: "What to look for." },
      limit: { type: "integer", min: 1, max: 6, description: "How many results, 1 to 6. Default 4." },
    },
  },
  {
    id: "notes.read", title: "Read own notes", role: "viewer", cost: "cheap",
    description: "This agent's own notes from earlier runs, newest first, each with where it came from and whether it is still fresh.",
    params: { query: { type: "string", maxLength: 200, description: "Only notes about this." } },
  },
  {
    id: "notes.write", title: "Write own notes", role: "viewer", cost: "cheap", writes: "notes",
    description: "Keep a short note for later runs: something learned about this server. Notes are this agent's memory; they change nothing on the server.",
    params: {
      title: { type: "string", maxLength: 120, required: true, description: "A short title." },
      body: { type: "string", maxLength: 2000, required: true, description: "What to remember, in plain sentences." },
      freshDays: { type: "integer", min: 1, max: 90, description: "How many days it stays true. Default 14." },
    },
  },
  {
    id: "jobs.recent", title: "BoxPilot jobs", role: "viewer", cost: "cheap",
    description: "Recent BoxPilot jobs the run may see: what ran, whether it failed and its error.",
    params: {
      state: { type: "string", enum: ["failed", "all"], description: "failed (default) or all." },
      limit: { type: "integer", min: 1, max: 10, description: "How many, 1 to 10. Default 5." },
    },
  },
  {
    id: "alerts.active", title: "Health alerts", role: "viewer", cost: "cheap",
    description: "BoxPilot's live health alerts and the news no one was told about yet.",
    params: {},
  },
  {
    id: "backups.status", title: "Backups", role: "viewer", cost: "cheap",
    description: "The most recent app backups, their restore checks, the off-box and cloud copies, and restore rehearsals.",
    params: {},
  },
  {
    id: "pihole.stats", title: "Pi-hole (aggregates)", role: "operator", cost: "moderate",
    description: "Pi-hole's blocking status, queries and blocked queries in the last 24 hours, the blocklist's age and size, each upstream's share and answer time, and the most blocked domains. Counts for the whole network only: never which device asked for what.",
    params: {},
  },
  {
    id: "where.runs", title: "Where does it run?", role: "viewer", cost: "moderate",
    description: "Whether something - Pi-hole, a database, any app - runs as a BoxPilot app, as another Docker container, or natively on the host as a systemd service.",
    params: { name: { type: "string", maxLength: 64, pattern: /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/, required: true, description: "What to look for, such as pihole or postgres." } },
  },
  {
    id: "plan.propose", title: "Propose a plan", role: "viewer", cost: "cheap", writes: "proposal",
    description: "Suggest a fix as registered BoxPilot operations. It becomes an approval card; nothing runs until a person approves each step at its own risk tier.",
    params: {
      title: { type: "string", maxLength: 120, required: true, description: "What the plan does, in a few words." },
      reason: { type: "string", maxLength: 600, required: true, description: "Why, citing the tool output it is based on." },
      steps: { type: "array", maxItems: 8, required: true, items: "step", description: "Each step: { operationId, parameters, why }. Only operations docs.search shows as 'Operation id: ...'." },
    },
  },
  {
    id: "notify.owner", title: "Tell the owner (important only)", role: "viewer", cost: "cheap", writes: "notification",
    description: "Send the owner a short notification. Only for something important that needs a person soon; at most one every few hours.",
    params: {
      title: { type: "string", maxLength: 80, required: true, description: "One line." },
      message: { type: "string", maxLength: 400, required: true, description: "What is wrong and what to look at." },
    },
  },
].map((tool) => Object.freeze({ ...tool, fn: tool.id.replace(/\./g, "_") })));

export const toolIds = toolCatalog.map((tool) => tool.id);
export const toolById = (id) => toolCatalog.find((tool) => tool.id === id || tool.fn === id) ?? null;

/** Permissions an agent can give a tool: use it freely, only when a person asked, or not at all. */
export const toolPermissions = Object.freeze(["auto", "ask", "off"]);

const roleRank = { viewer: 0, operator: 1, owner: 2 };
export const roleAtLeast = (role, least) => (roleRank[role] ?? -1) >= (roleRank[least] ?? 99);
/** The lesser of two roles: what a run reads as when two people's permissions both apply. */
export const lesserRole = (a, b) => ((roleRank[a] ?? -1) <= (roleRank[b] ?? -1) ? a : b);

/** Whether a run of this kind, reading as this role, may call the tool under this permission. */
export function toolAllowed(tool, permission, { kind, readRole }) {
  if (!tool || permission === "off" || !toolPermissions.includes(permission)) return false;
  if (!roleAtLeast(readRole, tool.role)) return false;
  // "ask": only when a person is waiting on the answer, never on a schedule or an event.
  if (permission === "ask" && !["ask", "manual", "eval"].includes(kind)) return false;
  return true;
}

/** The tool as the model sees it: OpenAI's function-tool shape. */
export function toModelTool(tool) {
  const properties = {};
  const required = [];
  for (const [name, spec] of Object.entries(tool.params ?? {})) {
    const property = { description: spec.description ?? name };
    if (spec.type === "integer") Object.assign(property, { type: "integer", ...(spec.min !== undefined ? { minimum: spec.min } : {}), ...(spec.max !== undefined ? { maximum: spec.max } : {}) });
    else if (spec.type === "array") Object.assign(property, { type: "array", maxItems: spec.maxItems, items: spec.items === "step" ? { type: "object", properties: { operationId: { type: "string" }, parameters: { type: "object" }, why: { type: "string" } }, required: ["operationId"] } : {} });
    else Object.assign(property, { type: "string", ...(spec.enum ? { enum: spec.enum } : {}), ...(spec.maxLength ? { maxLength: spec.maxLength } : {}) });
    properties[name] = property;
    if (spec.required) required.push(name);
  }
  return { type: "function", function: { name: tool.fn, description: `${tool.title}: ${tool.description}`, parameters: { type: "object", properties, required, additionalProperties: false } } };
}

/**
 * The input as the tool will use it, or the reason it is refused. A model's arguments arrive as
 * text; anything that is not a JSON object with only the declared names, of the declared types
 * and within their bounds, is refused rather than guessed at.
 */
export function readToolInput(tool, raw) {
  let input = raw;
  if (typeof raw === "string") {
    if (raw.length > 32 * 1024) return { problem: "The arguments are too long" };
    try { input = raw.trim() ? JSON.parse(raw) : {}; } catch { return { problem: "The arguments are not JSON" }; }
  }
  if (input === null || input === undefined) input = {};
  if (typeof input !== "object" || Array.isArray(input)) return { problem: "The arguments must be an object" };
  const params = tool.params ?? {};
  const value = {};
  for (const key of Object.keys(input)) if (!Object.hasOwn(params, key)) return { problem: `${tool.title} takes no "${key}"` };
  for (const [name, spec] of Object.entries(params)) {
    const given = input[name];
    if (given === undefined || given === null || given === "") {
      if (spec.required) return { problem: `${tool.title} needs "${name}"` };
      continue;
    }
    if (spec.type === "integer") {
      const number = typeof given === "string" && /^-?\d+$/.test(given) ? Number(given) : given;
      if (!Number.isInteger(number)) return { problem: `"${name}" must be a whole number` };
      if ((spec.min !== undefined && number < spec.min) || (spec.max !== undefined && number > spec.max)) return { problem: `"${name}" must be ${spec.min} to ${spec.max}` };
      value[name] = number;
    } else if (spec.type === "array") {
      if (!Array.isArray(given)) return { problem: `"${name}" must be a list` };
      if (spec.maxItems && given.length > spec.maxItems) return { problem: `"${name}" holds at most ${spec.maxItems}` };
      value[name] = given;
    } else {
      if (typeof given !== "string") return { problem: `"${name}" must be text` };
      const text = given.trim();
      if (spec.maxLength && text.length > spec.maxLength) return { problem: `"${name}" is too long` };
      if (spec.enum && !spec.enum.includes(text)) return { problem: `"${name}" must be one of ${spec.enum.join(", ")}` };
      if (spec.pattern && !spec.pattern.test(text)) return { problem: `"${name}" has a value it does not accept` };
      value[name] = text;
    }
  }
  return { value };
}

/** The catalog as the Builder shows it: no patterns, no functions. */
export function describeTools() {
  return toolCatalog.map(({ id, fn, title, description, role, cost, writes = null, params }) => ({
    id, fn, title, description, role, cost, writes,
    params: Object.entries(params ?? {}).map(([name, spec]) => ({ name, type: spec.type ?? "string", required: Boolean(spec.required), description: spec.description ?? "" })),
  }));
}
