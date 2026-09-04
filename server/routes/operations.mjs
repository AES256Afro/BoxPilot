/**
 * Operation-registry routes: describe operations, run read-only ones directly, stage
 * mutating ones as jobs, plus the read-only evidence views built on the registry
 * (prerequisites, recovery kit, action center). Mounted at /api/v1 behind the session.
 */
import { Router } from "express";
import { registry, riskTiers } from "../ops/index.mjs";

export function createOperationsRouter({ state, helper, jobs, prerequisites, recoveryKit, actionCenter, auth }) {
  const router = Router();

  router.get("/operations", (_request, response) => {
    response.json({ operations: registry.describe(), riskTiers });
  });

  // Read-only registered operations run immediately (no job, no approval); parameter-free only for now.
  /** Read-only operations may still be limited to a role (the journal) or to an elevated session (secrets). */
  function refuseRead(request, response, operation) {
    const role = request.boxpilotSession?.owner?.role ?? "owner";
    if (operation.minimumRole === "owner" && role !== "owner") { response.status(403).json({ error: "Only the owner can read this", code: "forbidden" }); return true; }
    // Name what was refused. This used to say "not read raw system logs" for every operator-gated
    // read, which is baffling when what you asked for was the contents of a backup.
    if (operation.minimumRole === "operator" && !["owner", "operator"].includes(role)) { response.status(403).json({ error: `Viewers can look at the pages, but "${operation.title}" reads through the system's own permissions, so it needs an operator`, code: "forbidden" }); return true; }
    if (!operation.elevatedOnly) return false;
    if (role === "viewer") { response.status(403).json({ error: "Viewers can look but not reveal secrets", code: "forbidden" }); return true; }
    const elevatedUntil = request.boxpilotSession.elevatedUntil ? Date.parse(request.boxpilotSession.elevatedUntil) : Number.NaN;
    if (!(Number.isFinite(elevatedUntil) && elevatedUntil > Date.now())) { response.status(401).json({ error: "Enter your password to unlock this for 10 minutes", code: "elevation_required" }); return true; }
    // The names, not the values, and this runs before the registry has validated either. The whole
    // body used to go in — up to the JSON limit, unfiltered, on the one route that reveals secrets.
    const submitted = request.body?.parameters;
    const parameterNames = submitted && typeof submitted === "object" && !Array.isArray(submitted) ? Object.keys(submitted).slice(0, 20) : [];
    state.recordAudit("operation.elevated-read", { actorId: request.boxpilotSession.owner.id, subjectId: operation.id, details: { parameterNames } });
    return false;
  }

  router.get("/operations/:id/inspect", async (request, response) => {
    const operation = registry.get(request.params.id);
    if (!operation) return response.status(404).json({ error: "Operation not found", code: "operation_not_found" });
    if (!operation.readOnly) return response.status(405).json({ error: "This operation changes the host; stage it as a job", code: "operation_not_read_only" });
    if (refuseRead(request, response, operation)) return undefined;
    const problem = registry.validate(operation.id, {});
    if (problem) return response.status(400).json({ error: problem, code: "invalid_parameters" });
    try {
      return response.json({ operation: operation.id, result: await helper.request(operation.id, {}, { timeoutMs: operation.timeoutMs }) });
    } catch (error) {
      return response.status(503).json({ error: error.message, code: "operation_failed" });
    }
  });

  // Read-only registered operations that take parameters (e.g. logs) run immediately via POST.
  router.post("/operations/:id/run", auth.requireCsrf, async (request, response) => {
    const operation = registry.get(request.params.id);
    if (!operation) return response.status(404).json({ error: "Operation not found", code: "operation_not_found" });
    // Say "stage it as a job" before "you may not read this": the caller's mistake is the method, not the role.
    if (!operation.readOnly) return response.status(405).json({ error: "This operation changes the host; stage it as a job", code: "operation_not_read_only" });
    if (refuseRead(request, response, operation)) return undefined;
    const parameters = request.body?.parameters ?? {};
    const problem = registry.validate(operation.id, parameters);
    if (problem) return response.status(400).json({ error: problem, code: "invalid_parameters" });
    try {
      return response.json({ operation: operation.id, result: await helper.request(operation.id, parameters, { timeoutMs: operation.timeoutMs }) });
    } catch (error) {
      return response.status(503).json({ error: error.message, code: "operation_failed" });
    }
  });

  // Mutating registered operations are staged as jobs and approved through /api/v1/jobs/:id/approve (risk-tiered).
  router.post("/operations/:id/jobs", auth.requireCsrf, async (request, response) => {
    try {
      const job = await jobs.createOperationJob(request.params.id, request.body?.parameters ?? {}, request.boxpilotSession.owner.id, { role: request.boxpilotSession.owner.role });
      return response.status(201).json({ job, approval: jobs.describeApproval(job.id, request.boxpilotSession) });
    } catch (error) {
      const status = error.message === "Operation not found" ? 404 : error.message.includes("Read-only") ? 405 : error.message.includes("Only the owner") || error.message.includes("Viewers cannot") ? 403 : 400;
      return response.status(status).json({ error: error.message, code: "operation_job_rejected" });
    }
  });

  router.get("/operations/prerequisites", async (_request, response) => {
    response.json(await prerequisites.inspect());
  });

  router.get("/operations/recovery-kit", async (_request, response) => {
    try {
      response.json(await recoveryKit.inspect());
    } catch {
      response.status(503).json({ error: "Recovery evidence is temporarily unavailable", code: "recovery_kit_unavailable" });
    }
  });

  router.get("/operations/action-center", async (_request, response) => {
    response.json(await actionCenter.inspect());
  });

  return router;
}
