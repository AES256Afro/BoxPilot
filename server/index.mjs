import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { requireVmActionAuthorization, vmActionsConfiguration } from "./auth.mjs";
import { createAuditLog } from "./audit.mjs";
import { createLibvirtService, getSetupPlan, validateAction, validateDomainName } from "./libvirt.mjs";
import { createVmPlanner, validateVmPlanInput } from "./vm-plan.mjs";

const app = express();
const host = process.env.BOXPILOT_HOST ?? "127.0.0.1";
const port = Number.parseInt(process.env.BOXPILOT_PORT ?? "8787", 10);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(root, "dist");
const libvirt = createLibvirtService();
const vmPlanner = createVmPlanner();
const audit = createAuditLog();
const vmActions = vmActionsConfiguration();

app.disable("x-powered-by");
app.use(express.json({ limit: "16kb", strict: true }));
app.use((request, response, next) => {
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "DENY");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  response.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; base-uri 'none'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; img-src 'self' data:; object-src 'none'; script-src 'self'; style-src 'self'",
  );
  if (request.path.startsWith("/api/")) response.setHeader("Cache-Control", "no-store");
  next();
});

app.get("/api/v1/health", (_request, response) => {
  response.json({
    status: "ok",
    product: "BoxPilot",
    version: "0.3.0",
    mode: "host-aware",
    safeMode: !vmActions.enabled,
    hostMutationsEnabled: vmActions.enabled,
    timestamp: new Date().toISOString(),
  });
});

app.get("/api/v1/capabilities", (_request, response) => {
  response.json({
    inventory: "mixed-live-and-demo",
    composeInspection: "browser-only",
    supportBundle: "browser-only",
    backups: "planned",
    migrations: "planned",
    privilegedHelper: "not-installed",
    virtualization: "live-libvirt",
    vmCreationPlanning: "validated-read-only",
    audit: "redacted-jsonl-foundation",
    vmActions: {
      enabled: vmActions.enabled,
      reason: vmActions.reason,
    },
  });
});

app.get("/api/v1/virtualization/status", async (_request, response) => {
  response.json({
    ...(await libvirt.getStatus()),
    actions: { enabled: vmActions.enabled, reason: vmActions.reason },
  });
});

app.get("/api/v1/virtualization/domains", async (_request, response) => {
  const result = await libvirt.listDomains();
  response.status(result.connected ? 200 : 503).json(result);
});

app.get("/api/v1/virtualization/setup-plan", (_request, response) => {
  response.json(getSetupPlan());
});

app.get("/api/v1/virtualization/resources", async (_request, response) => {
  const resources = await libvirt.listResources();
  response.status(resources.connected ? 200 : 503).json(resources);
});

app.get("/api/v1/virtualization/planning-options", async (_request, response) => {
  response.json(await vmPlanner.getOptions());
});

app.get("/api/v1/audit", async (request, response) => {
  const result = await audit.list(request.query.limit);
  response.status(result.available ? 200 : 503).json(result);
});

app.post("/api/v1/virtualization/plans", async (request, response) => {
  const inputErrors = validateVmPlanInput(request.body);
  if (inputErrors.length) {
    response.status(400).json({ ok: false, errors: inputErrors });
    return;
  }
  const domain = validateDomainName(request.body?.name) ? await libvirt.getDomain(request.body.name) : null;
  const resources = await libvirt.listResources();
  const defaultPool = resources.pools.find((pool) => pool.name === "default");
  const result = await vmPlanner.createPlan(request.body, {
    existingDomainNames: domain ? [domain.name] : [],
    poolAvailableBytes: defaultPool?.availableBytes ?? null,
  });
  if (result.ok) {
    try {
      await audit.record("vm.plan.created", {
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

app.post(
  "/api/v1/virtualization/domains/:name/actions",
  requireVmActionAuthorization(vmActions),
  async (request, response) => {
    const { name } = request.params;
    const { action } = request.body ?? {};
    if (!validateDomainName(name) || !validateAction(action)) {
      response.status(400).json({ error: "Invalid domain name or unsupported action", code: "invalid_action" });
      return;
    }
    try {
      await audit.record("vm.action.requested", { domain: name, action });
    } catch {
      response.status(503).json({ error: "Audit log is unavailable; no VM action was sent", code: "audit_unavailable" });
      return;
    }
    try {
      const result = await libvirt.runDomainAction(name, action);
      try {
        await audit.record("vm.action.completed", { domain: name, action, state: result.current?.state ?? null });
      } catch {
        console.warn(JSON.stringify({ timestamp: new Date().toISOString(), event: "audit_write", result: "failed", type: "vm.action.completed" }));
      }
      console.info(JSON.stringify({ timestamp: new Date().toISOString(), event: "vm_action", domain: name, action, result: "accepted" }));
      response.json(result);
    } catch (error) {
      try {
        await audit.record("vm.action.failed", { domain: name, action });
      } catch {
        console.warn(JSON.stringify({ timestamp: new Date().toISOString(), event: "audit_write", result: "failed", type: "vm.action.failed" }));
      }
      console.warn(JSON.stringify({ timestamp: new Date().toISOString(), event: "vm_action", domain: name, action, result: "failed" }));
      response.status(409).json({ error: error.message, code: "libvirt_action_failed" });
    }
  },
);

app.use(express.static(dist, { index: false }));
app.use((request, response, next) => {
  if (request.method !== "GET" || request.path.startsWith("/api/")) {
    next();
    return;
  }

  response.sendFile(path.join(dist, "index.html"));
});

app.use((_request, response) => {
  response.status(404).json({ error: "Not found" });
});

app.listen(port, host, () => {
  console.log(`BoxPilot 0.3.0 listening on http://${host}:${port}`);
  console.log(vmActions.enabled ? "Authenticated VM lifecycle actions are enabled." : `Safe mode: ${vmActions.reason}.`);
});
