import { randomUUID } from "node:crypto";
import { json, parseJson } from "./shared.mjs";

/** @param {import("./shared.mjs").StateContext} context */
export function createAuditStore({ database, timestamp }) {
  function recordAudit(type, { actorId = null, subjectId = null, details = {} } = {}) {
    const event = { id: randomUUID(), type, actorId, subjectId, details, createdAt: timestamp() };
    database.prepare("INSERT INTO audit_events (id, type, actor_id, subject_id, details_json, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(event.id, event.type, event.actorId, event.subjectId, json(event.details), event.createdAt);
    return event;
  }

  /** Newest first. `actorId` limits it to what one account did (an operator's support bundle). */
  function listAudit(limit = 100, { actorId = null } = {}) {
    const safeLimit = Math.min(Math.max(Number.parseInt(String(limit), 10) || 100, 1), 200);
    const rows = actorId
      ? database.prepare("SELECT * FROM audit_events WHERE actor_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?").all(actorId, safeLimit)
      : database.prepare("SELECT * FROM audit_events ORDER BY created_at DESC, rowid DESC LIMIT ?").all(safeLimit);
    return rows.map((row) => ({
      id: row.id,
      type: row.type,
      actorId: row.actor_id,
      subjectId: row.subject_id,
      details: parseJson(row.details_json),
      createdAt: row.created_at,
    }));
  }

  return { recordAudit, listAudit };
}
