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
  router.get("/operations/:id/inspect", async (request, response) => {
    const operation = registry.get(request.params.id);
    if (!operation) return response.status(404).json({ error: "Operation not found", code: "operation_not_found" });
    if (!operation.readOnly) return response.status(405).json({ error: "This operation changes the host; stage it as a job", code: "operation_not_read_only" });
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
    if (!operation.readOnly) return response.status(405).json({ error: "This operation changes the host; stage it as a job", code: "operation_not_read_only" });
    const parameters = request.body?.parameters ?? {};
    const problem = registry.validate(operation.id, parameters);
    if (problem) return response.status(400).json({ error: problem, code: "invalid_parameters" });
    if (operation.elevatedOnly) {
      const elevatedUntil = request.boxpilotSession.elevatedUntil ? Date.parse(request.boxpilotSession.elevatedUntil) : Number.NaN;
      if (!(Number.isFinite(elevatedUntil) && elevatedUntil > Date.now())) return response.status(401).json({ error: "Enter your password to unlock this for 10 minutes", code: "elevation_required" });
      state.recordAudit("operation.elevated-read", { actorId: request.boxpilotSession.owner.id, subjectId: operation.id, details: { parameters } });
    }
    try {
      return response.json({ operation: operation.id, result: await helper.request(operation.id, parameters, { timeoutMs: operation.timeoutMs }) });
    } catch (error) {
      return response.status(503).json({ error: error.message, code: "operation_failed" });
    }
  });

  // Mutating registered operations are staged as jobs and approved through /api/v1/jobs/:id/approve (risk-tiered).
  router.post("/operations/:id/jobs", auth.requireCsrf, async (request, response) => {
    try {
      const job = await jobs.createOperationJob(request.params.id, request.body?.parameters ?? {}, request.boxpilotSession.owner.id);
      return response.status(201).json({ job, approval: jobs.describeApproval(job.id, request.boxpilotSession) });
    } catch (error) {
      const status = error.message === "Operation not found" ? 404 : error.message.includes("Read-only") ? 405 : 400;
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
