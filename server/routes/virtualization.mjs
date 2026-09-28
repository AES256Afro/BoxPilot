/**
 * Virtualization routes: live libvirt inventory, the VM-creation preview, ISO media
 * uploads, and the recorded export/protection/retention/recovery evidence. All mutations
 * go through registry operations; these routes only read and preview.
 * Mounted at /api/v1 behind the session.
 */
import { Router } from "express";
import { getSetupPlan } from "../libvirt.mjs";
import { buildConsoleGuidanceResponse } from "../helper-libvirt.mjs";
import { validateVmPlanInput } from "../vm-plan.mjs";
import { withOwnActors } from "./access.mjs";

export function createVirtualizationRouter({ libvirt, libvirtFoundation, vmPlanner, vmMedia, vmCreation, vmExports, vmProtection, vmRetention, vmRecoveries, audit }) {
  const router = Router();

  router.get("/virtualization/status", async (_request, response) => {
    response.json({
      ...(await libvirt.getStatus()),
      actions: { enabled: true },
    });
  });

  router.get("/virtualization/domains", async (_request, response) => {
    const result = await libvirt.listDomains();
    response.status(result.connected ? 200 : 503).json(result);
  });

  router.get("/virtualization/setup-plan", (_request, response) => {
    response.json(getSetupPlan());
  });

  router.get("/virtualization/resources", async (_request, response) => {
    const resources = await libvirt.listResources();
    response.status(resources.connected ? 200 : 503).json(resources);
  });

  router.get("/virtualization/foundation", async (_request, response) => {
    const foundation = await libvirtFoundation.inspect();
    response.status(foundation.connectionReady ? 200 : 503).json(foundation);
  });

  router.get("/virtualization/console-guidance", async (_request, response) => {
    response.json(buildConsoleGuidanceResponse(await libvirt.getConsoleGuidance()));
  });

  router.get("/virtualization/planning-options", async (_request, response) => {
    response.json(await vmPlanner.getOptions());
  });

  router.get("/virtualization/media", async (_request, response) => {
    try {
      response.json(await vmMedia.inspect());
    } catch (error) {
      response.status(503).json({ error: error.message, code: "vm_media_inspection_failed" });
    }
  });

  router.post("/virtualization/media/uploads", async (request, response) => {
    try {
      request.setTimeout(12 * 60 * 60 * 1000);
      response.status(201).json({ upload: await vmMedia.upload(request) });
    } catch (error) {
      const status = error.message.includes("already exists") ? 409 : error.message.includes("space") ? 507 : 400;
      response.status(status).json({ error: error.message, code: "vm_media_upload_failed" });
    }
  });

  // Host-checked creation preview for the planner UI; nothing is stored. Approval revalidates.
  router.post("/virtualization/plans", async (request, response) => {
    const inputErrors = validateVmPlanInput(request.body);
    if (inputErrors.length) {
      response.status(400).json({ ok: false, errors: inputErrors });
      return;
    }
    let result;
    try {
      result = await vmCreation.preview(request.body);
    } catch (error) {
      response.status(503).json({ ok: false, errors: [error.message] });
      return;
    }
    if (result.ok) {
      try {
        await audit.record("vm.plan.created", {
          // Who planned it, so GET /audit can show each account its own plans (M29.4).
          actorId: request.boxpilotSession?.owner?.id ?? null,
          domain: result.plan.input.name,
          revision: result.plan.revision,
          osProfile: result.plan.input.osProfile,
          vcpus: result.plan.input.vcpus,
          memoryMiB: result.plan.input.memoryMiB,
          diskGiB: result.plan.input.diskGiB,
          media: result.plan.media.name,
          warningCount: result.plan.warnings.length,
        });
      } catch {
        console.warn(JSON.stringify({ timestamp: new Date().toISOString(), event: "audit_write", result: "failed", type: "vm.plan.created" }));
      }
    }
    response.status(result.ok ? 200 : 400).json(result);
  });

  // The recorded exports, backups, retention runs and recoveries are the server's, open to every
  // role; which account's job made each one is the owner's to see (M29.4).
  router.get("/virtualization/exports", (request, response) => {
    response.json(withOwnActors(request, vmExports.list()));
  });

  router.get("/virtualization/protection", async (request, response) => {
    response.json(withOwnActors(request, await vmProtection.list()));
  });

  router.get("/virtualization/retention", async (request, response) => {
    try {
      response.json(withOwnActors(request, await vmRetention.inspect()));
    } catch (error) {
      response.status(503).json({ error: error.message, code: "vm_retention_inspection_failed" });
    }
  });

  router.get("/virtualization/recoveries", (request, response) => {
    response.json({ recoveries: withOwnActors(request, vmRecoveries.list()) });
  });

  return router;
}
