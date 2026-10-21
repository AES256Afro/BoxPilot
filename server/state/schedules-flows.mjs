import { randomUUID } from "node:crypto";
import { json, parseJson } from "./shared.mjs";

/** @param {import("./shared.mjs").StateContext & { recordAudit: import("./shared.mjs").RecordAudit }} context */
export function createScheduleFlowStore({ database, timestamp, recordAudit }) {
  function normalizeSchedule(row) {
    if (!row) return null;
    return {
      id: row.id,
      operationId: row.operation_id,
      parameters: parseJson(row.parameters_json),
      frequency: row.frequency,
      minute: row.minute,
      hour: row.hour,
      weekday: row.weekday,
      enabled: Boolean(row.enabled),
      createdBy: row.created_by,
      createdAt: row.created_at,
      nextDueAt: row.next_due_at,
      lastRunAt: row.last_run_at,
      lastJobId: row.last_job_id,
      lastResult: row.last_result,
    };
  }

  function createSchedule({ operationId, parameters = {}, frequency, minute, hour = null, weekday = null, createdBy, nextDueAt }) {
    const schedule = { id: randomUUID(), operationId, parameters, frequency, minute, hour, weekday, enabled: true, createdBy, createdAt: timestamp(), nextDueAt };
    database.prepare("INSERT INTO schedules (id, operation_id, parameters_json, frequency, minute, hour, weekday, enabled, created_by, created_at, next_due_at) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)")
      .run(schedule.id, operationId, json(parameters), frequency, minute, hour, weekday, createdBy, schedule.createdAt, nextDueAt);
    recordAudit("schedule.created", { actorId: createdBy, subjectId: schedule.id, details: { operationId, frequency, minute, hour, weekday } });
    return getSchedule(schedule.id);
  }

  function getSchedule(id) {
    return normalizeSchedule(database.prepare("SELECT * FROM schedules WHERE id = ?").get(id));
  }

  function listSchedules() {
    return database.prepare("SELECT * FROM schedules ORDER BY created_at").all().map(normalizeSchedule);
  }

  function listDueSchedules(nowIso) {
    return database.prepare("SELECT * FROM schedules WHERE enabled = 1 AND next_due_at <= ? ORDER BY next_due_at").all(nowIso).map(normalizeSchedule);
  }

  function setScheduleEnabled(id, enabled, { actorId = null, nextDueAt = null } = {}) {
    const changes = nextDueAt
      ? database.prepare("UPDATE schedules SET enabled = ?, next_due_at = ? WHERE id = ?").run(enabled ? 1 : 0, nextDueAt, id).changes
      : database.prepare("UPDATE schedules SET enabled = ? WHERE id = ?").run(enabled ? 1 : 0, id).changes;
    if (!Number(changes)) throw new Error("Schedule not found");
    recordAudit(enabled ? "schedule.enabled" : "schedule.disabled", { actorId, subjectId: id });
    return getSchedule(id);
  }

  /** Record a run. `nextDueAt: null` leaves the due time alone (used when a schedule is paused). */
  function markScheduleRun(id, { jobId = null, result = null, nextDueAt }) {
    if (nextDueAt === null || nextDueAt === undefined) {
      database.prepare("UPDATE schedules SET last_job_id = ?, last_result = ?, last_run_at = ? WHERE id = ?").run(jobId, result, timestamp(), id);
      return getSchedule(id);
    }
    database.prepare("UPDATE schedules SET last_run_at = ?, last_job_id = ?, last_result = ?, next_due_at = ? WHERE id = ?")
      .run(timestamp(), jobId, result, nextDueAt, id);
    return getSchedule(id);
  }

  /** How a started run ended. Only that run's "started" is replaced; the time it ran is kept. */
  function settleScheduleRun(id, { jobId, result }) {
    database.prepare("UPDATE schedules SET last_result = ? WHERE id = ? AND last_job_id = ? AND last_result = 'started'").run(result, id, jobId);
    return getSchedule(id);
  }

  /** Flows: an ordered list of registered operations (ADR-002). Feature storage like schedules. */
  function normalizeFlow(row) {
    if (!row) return null;
    return {
      id: row.id, name: row.name, steps: JSON.parse(row.steps_json),
      createdBy: row.created_by, createdAt: row.created_at, updatedAt: row.updated_at,
      lastRunAt: row.last_run_at, lastResult: row.last_result,
      lastJobIds: row.last_job_ids_json ? JSON.parse(row.last_job_ids_json) : [],
      frequency: row.frequency, minute: row.minute, hour: row.hour, weekday: row.weekday,
      enabled: row.enabled === 1 || row.enabled === undefined, nextDueAt: row.next_due_at,
      triggerFlowId: row.trigger_flow_id ?? null,
      triggerDrive: row.trigger_drive ?? null,
      webhookEnabled: Boolean(row.webhook_hash),
      webhookHash: row.webhook_hash ?? null,
    };
  }

  function createFlow({ name, steps, createdBy, frequency = null, minute = null, hour = null, weekday = null, nextDueAt = null, triggerFlowId = null, triggerDrive = null }) {
    const id = randomUUID();
    const at = timestamp();
    database.prepare("INSERT INTO flows (id, name, steps_json, created_by, created_at, updated_at, frequency, minute, hour, weekday, next_due_at, trigger_flow_id, trigger_drive) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(id, name, json(steps), createdBy, at, at, frequency, minute, hour, weekday, nextDueAt, triggerFlowId, triggerDrive);
    recordAudit("flow.created", { actorId: createdBy, subjectId: id, details: { name, steps: steps.map((step) => step.operationId), ...(triggerDrive ? { triggerDrive } : {}) } });
    return getFlow(id);
  }

  function getFlow(id) {
    return normalizeFlow(database.prepare("SELECT * FROM flows WHERE id = ?").get(id));
  }

  function listFlows() {
    return database.prepare("SELECT * FROM flows ORDER BY created_at").all().map(normalizeFlow);
  }

  function updateFlow(id, { name, steps, frequency, minute, hour, weekday, enabled, nextDueAt, triggerFlowId }, { actorId = null } = {}) {
    const current = getFlow(id);
    if (!current) throw new Error("Flow not found");
    database.prepare("UPDATE flows SET name = ?, steps_json = ?, updated_at = ?, frequency = ?, minute = ?, hour = ?, weekday = ?, enabled = ?, next_due_at = ?, trigger_flow_id = ? WHERE id = ?")
      .run(
        name ?? current.name, json(steps ?? current.steps), timestamp(),
        frequency === undefined ? current.frequency : frequency,
        minute === undefined ? current.minute : minute,
        hour === undefined ? current.hour : hour,
        weekday === undefined ? current.weekday : weekday,
        (enabled === undefined ? current.enabled : enabled) ? 1 : 0,
        nextDueAt === undefined ? current.nextDueAt : nextDueAt,
        triggerFlowId === undefined ? current.triggerFlowId : triggerFlowId,
        id);
    recordAudit("flow.updated", { actorId, subjectId: id, details: { name: name ?? current.name } });
    return getFlow(id);
  }

  function markFlowRun(id, { result, jobIds = [], nextDueAt }) {
    if (nextDueAt === undefined) {
      database.prepare("UPDATE flows SET last_run_at = ?, last_result = ?, last_job_ids_json = ? WHERE id = ?")
        .run(timestamp(), result, json(jobIds), id);
    } else {
      database.prepare("UPDATE flows SET last_run_at = ?, last_result = ?, last_job_ids_json = ?, next_due_at = ? WHERE id = ?")
        .run(timestamp(), result, json(jobIds), nextDueAt, id);
    }
    return getFlow(id);
  }

  function listDueFlows(nowIso) {
    return database.prepare("SELECT * FROM flows WHERE enabled = 1 AND next_due_at IS NOT NULL AND next_due_at <= ? ORDER BY next_due_at").all(nowIso).map(normalizeFlow);
  }

  /** Arm or disarm a flow's webhook; only the hash of the token is ever stored. */
  function setFlowWebhook(id, hash, { actorId = null } = {}) {
    const current = getFlow(id);
    if (!current) throw new Error("Flow not found");
    database.prepare("UPDATE flows SET webhook_hash = ?, updated_at = ? WHERE id = ?").run(hash, timestamp(), id);
    recordAudit(hash ? "flow.webhook-armed" : "flow.webhook-removed", { actorId, subjectId: id });
    return getFlow(id);
  }

  /** Enabled flows wired to run after the given flow completes (ADR-002 addendum, v1.45.0). */
  function listFlowsTriggeredBy(flowId) {
    return database.prepare("SELECT * FROM flows WHERE enabled = 1 AND trigger_flow_id = ? ORDER BY created_at").all(flowId).map(normalizeFlow);
  }

  function deleteFlow(id, { actorId = null } = {}) {
    // Followers wired to run after this flow would otherwise dangle forever: never firing,
    // with a card still claiming they run after something, and blocking new chains through
    // them. Detaching them is the honest reading of deleting their trigger.
    const detached = Number(database.prepare("UPDATE flows SET trigger_flow_id = NULL WHERE trigger_flow_id = ?").run(id).changes);
    const changes = Number(database.prepare("DELETE FROM flows WHERE id = ?").run(id).changes);
    if (!changes) throw new Error("Flow not found");
    recordAudit("flow.deleted", { actorId, subjectId: id, details: detached ? { followersDetached: detached } : undefined });
  }

  function deleteSchedule(id, { actorId = null } = {}) {
    const changes = Number(database.prepare("DELETE FROM schedules WHERE id = ?").run(id).changes);
    if (!changes) throw new Error("Schedule not found");
    recordAudit("schedule.deleted", { actorId, subjectId: id });
    return true;
  }

  return {
    createFlow,
    getFlow,
    listFlows,
    updateFlow,
    markFlowRun,
    listDueFlows, listFlowsTriggeredBy, setFlowWebhook,
    deleteFlow,
    createSchedule,
    getSchedule,
    listSchedules,
    listDueSchedules,
    setScheduleEnabled,
    markScheduleRun,
    settleScheduleRun,
    deleteSchedule,
  };
}
