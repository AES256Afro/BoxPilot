import { createHash } from "node:crypto";

/**
 * What every domain store is built from: the one database connection (its `prepare` is the
 * statement cache set up in server/state.mjs), the injected clock and token source, and the
 * clock as an ISO string.
 * @typedef {{
 *   database: import("node:sqlite").DatabaseSync,
 *   now: () => Date,
 *   timestamp: () => string,
 *   tokenBytes: typeof import("node:crypto").randomBytes,
 * }} StateContext
 */
/** @typedef {ReturnType<typeof import("./audit.mjs").createAuditStore>["recordAudit"]} RecordAudit */

export function iso(value) {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

export function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function json(value) {
  return JSON.stringify(value === undefined ? null : value);
}

export function parseJson(value, fallback = {}) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}
